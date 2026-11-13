//! Build orchestration: the stage order, the `--strict` gate and the summary lines.
//!
//! This is the module that turns the individual stages described in
//! `docs/design.md` into one run. The order is a contract:
//!
//! 1. validate the input directory,
//! 2. read the `WIKICC_*` environment variables and the optional
//!    `.wikicc.json` configuration from the input root,
//! 3. merge the command line over the environment over the configuration
//!    over the built-in defaults, guard the output directory and resolve the
//!    favicon (the configured file, else the default embedded in the
//!    executable),
//! 4. scan the input directory, pruning the directories the `exclude`
//!    entries name,
//! 5. assemble the payload and resolve links and assets,
//! 6. report every diagnostic on stderr (scan, then config, then build),
//! 7. apply the `--strict` gate,
//! 8. summarise the warnings,
//! 9. render the page and write the artifact,
//! 10. print the summary line (unless `--quiet`).
//!
//! The gate comes before rendering and writing on purpose: a build that fails
//! on warnings must neither create an artifact nor empty a previous one.
//!
//! Everything the run prints goes through a [`std::io::Write`] sink rather than
//! `println!`, so the wording, the gate and `--quiet` are unit tested without
//! spawning a process.
//!
//! Determinism: the only clock read is the elapsed time that goes into the
//! summary line on stdout. Nothing here reaches an artifact.

use std::io::Write;
use std::time::{Duration, Instant};

use crate::config;
use crate::encrypt;
use crate::env;
use crate::error::{Error, Result};
use crate::favicon;
use crate::options::{self, Options, OutputFormat, Request};
use crate::render::{RenderedOutput, render_pages, render_site};
use crate::scan::{self, Severity};
use crate::site::{self, Stats};
use crate::writers::{self, WriteReport};

/// Result of a successful run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildOutcome {
    /// Document and asset counters of the compiled site.
    pub stats: Stats,
    /// What the writer put on disk.
    pub written: WriteReport,
    /// Diagnostics that `--strict` upgrades to errors.
    pub warnings: usize,
    /// Wall-clock time of the whole run; only ever shown in the summary line.
    pub elapsed: Duration,
}

impl BuildOutcome {
    /// One-line summary for stdout.
    ///
    /// `compiled 3 documents, 1 asset -> docs/dist (single-html) in 412 ms`
    pub fn summary(&self, options: &Options) -> String {
        format!(
            "compiled {}, {} -> {} ({}) in {} ms",
            count(self.stats.documents, "document", "documents"),
            count(self.stats.assets, "asset", "assets"),
            options.out.display(),
            options.format,
            self.elapsed.as_millis()
        )
    }
}

/// Warning summary for stderr: `2 warnings (use --strict to fail)`.
pub fn warning_summary(warnings: usize) -> String {
    format!(
        "{} (use --strict to fail)",
        count(warnings, "warning", "warnings")
    )
}

/// Message of the [`Error::Warnings`] raised by the `--strict` gate.
///
/// `1 warning treated as an error (--strict)` /
/// `3 warnings treated as errors (--strict)`
pub fn strict_message(warnings: usize) -> String {
    if warnings == 1 {
        "1 warning treated as an error (--strict)".to_string()
    } else {
        format!("{warnings} warnings treated as errors (--strict)")
    }
}

/// Run the whole pipeline for `request`.
///
/// Diagnostics and the warning summary go to `err`; the summary line goes to
/// `out` unless `--quiet` was passed. Both sinks are
/// flushed by their owners, so a caller that owns a buffer sees everything
/// after the call returns.
pub fn run(request: &Request, out: &mut dyn Write, err: &mut dyn Write) -> Result<BuildOutcome> {
    let started = Instant::now();

    options::validate_input(&request.input)?;

    // The environment and the configuration are explicit instructions, so a
    // variable or a file that cannot be understood aborts the build here,
    // before anything is reported or written. The command line is merged
    // over the environment over the file right after the reads, and only
    // then are the output-directory guards applied, because an `out` that
    // arrived through either source must be guarded exactly like one typed
    // on the command line. The scan waits for the merge because the
    // `exclude` entries must be in effect while the tree is walked; resolving
    // `home` still waits for the scan, since it needs the document ids. A
    // `home` that matches no document only warns.
    let site_config = config::load(&request.input)?;
    let env_settings = env::settings()?;
    let options = Options::resolve(request, &env_settings, &site_config.settings)?;
    options::validate_paths(&options.input, &options.out)?;

    // The favicon is an explicit instruction like the configuration itself:
    // a file that cannot be read aborts the build here, before the scan, so
    // a broken path is reported on its own instead of behind scan notes. An
    // unset value resolves to the default embedded in the executable.
    let favicon = favicon::resolve(options.favicon.as_deref(), &options.input)?;

    let report = scan::scan_with(&options.input, &options.out, &options.exclude)?;

    let ids: Vec<String> = report.docs.iter().map(|doc| doc.id.clone()).collect();
    let (home, resolved_diagnostics) = config::resolve_home(options.home.as_deref(), &ids);
    let mut config_diagnostics = site_config.diagnostics;
    config_diagnostics.extend(resolved_diagnostics);

    let mut build = site::build_site(&options.title, &options.input, &report.docs);
    build.bundle.home = home;
    // The favicon joins the asset table like any document-referenced resource
    // (deduplicated by content); the rendered head addresses it by the
    // placeholder the registration returns.
    let favicon_href = build.register_favicon(&favicon.name, &favicon.bytes);

    // Documents whose front matter declares encryption are sealed here, after
    // assembly and before anything is reported or written: a missing password
    // or a broken directive is a hard error that leaves no output behind,
    // whatever `--strict` says.
    encrypt::seal_bundle(&mut build, options.password.as_deref())?;

    // Diagnostics always reach stderr; `--quiet` only silences the summary
    // line. Scan messages come first, then the configuration problems, then
    // the link and asset problems, each in the order they were found, so two
    // runs report identically.
    for diagnostic in &report.diagnostics {
        writeln!(err, "{diagnostic}")?;
    }
    for diagnostic in &config_diagnostics {
        writeln!(err, "{diagnostic}")?;
    }
    for diagnostic in &build.diagnostics {
        writeln!(err, "{diagnostic}")?;
    }

    let warnings = report.warning_count()
        + config_diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Warning)
            .count()
        + build.warning_count();
    if options.strict && warnings > 0 {
        return Err(Error::Warnings(strict_message(warnings)));
    }
    if warnings > 0 {
        writeln!(err, "{}", warning_summary(warnings))?;
    }

    // Rendering and writing happen only after the `--strict` gate, so a build
    // that fails on warnings never leaves a half-written output directory (and
    // never wipes a previous one). The pages format renders into its own
    // projection — shell, chunks, corpus — because the shell-only render would
    // embed every document body the artifact never carries.
    let rendered = if options.format == OutputFormat::Pages {
        RenderedOutput::Pages(render_pages(&build.bundle, &favicon_href)?)
    } else {
        RenderedOutput::Page(render_site(&build.bundle, &favicon_href)?)
    };
    let written = writers::write_site(
        options.format,
        &build,
        &rendered,
        &options.out,
        options.force,
    )?;

    let outcome = BuildOutcome {
        stats: build.bundle.stats,
        written,
        warnings,
        elapsed: started.elapsed(),
    };

    if !options.quiet {
        writeln!(out, "{}", outcome.summary(&options))?;
    }

    Ok(outcome)
}

/// `1 document` / `2 documents`.
fn count(value: usize, singular: &str, plural: &str) -> String {
    if value == 1 {
        format!("{value} {singular}")
    } else {
        format!("{value} {plural}")
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::options::{OutputFormat, Request, Settings};

    /// A request for one run, built without going through clap.
    fn request(input: &Path, out: &Path, format: OutputFormat) -> Request {
        Request {
            input: input.to_path_buf(),
            settings: Settings {
                out: Some(out.to_path_buf()),
                format: Some(format),
                title: Some("Fixture".to_string()),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        }
    }

    /// The resolved [`Options`] of a request, for assertions on the summary.
    fn resolved(request: &Request) -> Options {
        Options::resolve(request, &Settings::default(), &Settings::default())
            .expect("the request resolves")
    }

    /// A directory with one document and one referenced asset.
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join("intro.md"),
            "# Intro\n\n![Logo](assets/logo.svg)\n",
        )
        .expect("write fixture");
        std::fs::create_dir(dir.path().join("assets")).expect("create asset directory");
        std::fs::write(dir.path().join("assets").join("logo.svg"), "<svg/>").expect("write asset");

        dir
    }

    /// Run `run` and return `(outcome, stdout, stderr)`.
    fn execute(request: &Request) -> (Result<BuildOutcome>, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let outcome = run(request, &mut out, &mut err);

        (
            outcome,
            String::from_utf8(out).expect("stdout is utf-8"),
            String::from_utf8(err).expect("stderr is utf-8"),
        )
    }

    #[test]
    fn summary_counts_documents_assets_output_and_format() {
        let dir = fixture();
        let request = request(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );
        let (outcome, stdout, _) = execute(&request);
        let outcome = outcome.expect("the build succeeds");

        assert_eq!(outcome.stats.documents, 1);
        assert_eq!(
            outcome.stats.assets, 2,
            "the document asset plus the favicon"
        );
        assert_eq!(
            outcome.summary(&resolved(&request)),
            format!(
                "compiled 1 document, 2 assets -> {} (single-html) in {} ms",
                resolved(&request).out.display(),
                outcome.elapsed.as_millis()
            )
        );
        assert_eq!(stdout.trim_end(), outcome.summary(&resolved(&request)));
    }

    #[test]
    fn summary_uses_plural_forms() {
        let dir = fixture();
        let request = request(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );
        let outcome = BuildOutcome {
            stats: Stats {
                documents: 3,
                assets: 2,
                asset_bytes: 12,
            },
            written: WriteReport {
                files: 1,
                bytes: 10,
                assets: 2,
            },
            warnings: 0,
            elapsed: Duration::from_millis(7),
        };

        assert_eq!(
            outcome.summary(&resolved(&request)),
            format!(
                "compiled 3 documents, 2 assets -> {} (single-html) in 7 ms",
                resolved(&request).out.display()
            )
        );
    }

    #[test]
    fn warning_summary_is_singular_for_one_warning() {
        assert_eq!(warning_summary(1), "1 warning (use --strict to fail)");
        assert_eq!(warning_summary(2), "2 warnings (use --strict to fail)");
    }

    #[test]
    fn strict_message_is_singular_for_one_warning() {
        assert_eq!(
            strict_message(1),
            "1 warning treated as an error (--strict)"
        );
        assert_eq!(strict_message(3), "3 warnings treated as errors (--strict)");
    }

    #[test]
    fn a_successful_run_writes_the_artifact_and_reports_it() {
        let dir = fixture();
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, stdout, stderr) = execute(&request);
        let outcome = outcome.expect("the build succeeds");

        assert_eq!(outcome.written.files, 1);
        assert!(outcome.written.bytes > 0);
        assert_eq!(outcome.warnings, 0);
        assert!(out.join(writers::HTML_FILE_NAME).is_file());
        assert!(stdout.starts_with("compiled 1 document, 2 assets -> "));
        assert!(
            !stderr.contains("warning"),
            "a clean build reports no warning: {stderr}"
        );
    }

    #[test]
    fn every_artifact_carries_the_default_favicon() {
        let dir = fixture();
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, _, stderr) = execute(&request);
        outcome.expect("the build succeeds");

        assert!(
            !stderr.contains("warning"),
            "the default favicon needs no configuration: {stderr}"
        );
        let artifact =
            std::fs::read_to_string(out.join(writers::HTML_FILE_NAME)).expect("read artifact");
        assert!(
            artifact.contains(r#"<link rel="icon" href="data:image/svg+xml;base64,"#),
            "the head links the embedded logo as a data URI"
        );
        assert!(
            !artifact.contains("wikicc-asset:"),
            "the single-file artifact carries no placeholder"
        );
    }

    #[test]
    fn the_configured_favicon_replaces_the_default() {
        let dir = fixture();
        std::fs::write(dir.path().join("icon.png"), b"png").expect("write favicon");
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"favicon": "icon.png"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, _, stderr) = execute(&request);
        outcome.expect("the build succeeds");

        assert!(
            !stderr.contains("config:"),
            "a readable favicon is silent: {stderr}"
        );
        let artifact =
            std::fs::read_to_string(out.join(writers::HTML_FILE_NAME)).expect("read artifact");
        assert!(
            artifact.contains(r#"<link rel="icon" href="data:image/png;base64,cG5n">"#),
            "the head links the configured file"
        );
    }

    #[test]
    fn the_command_line_favicon_overrides_the_configuration() {
        let dir = fixture();
        std::fs::write(dir.path().join("configured.png"), b"png").expect("write favicon");
        std::fs::write(dir.path().join("cli.ico"), b"ico").expect("write favicon");
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"favicon": "configured.png"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let mut override_request = request(dir.path(), &out, OutputFormat::SingleHtml);
        override_request.settings.favicon = Some("cli.ico".to_string());

        let (outcome, _, _) = execute(&override_request);
        outcome.expect("the build succeeds");

        let artifact =
            std::fs::read_to_string(out.join(writers::HTML_FILE_NAME)).expect("read artifact");
        assert!(
            artifact.contains(r#"<link rel="icon" href="data:image/x-icon;base64,aWNv">"#),
            "the command line favicon wins over the configured one"
        );
        assert!(
            !artifact.contains("data:image/png"),
            "the configured favicon is gone"
        );
    }

    #[test]
    fn a_favicon_the_documents_also_reference_is_counted_once() {
        let dir = fixture();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"favicon": "assets/logo.svg"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, _, stderr) = execute(&request);
        let outcome = outcome.expect("the build succeeds");

        assert!(
            !stderr.contains("warning"),
            "the favicon path exists: {stderr}"
        );
        assert_eq!(
            outcome.stats.assets, 1,
            "the favicon collapses into the asset the document already carries"
        );
    }

    #[test]
    fn a_missing_configured_favicon_fails_before_anything_is_written() {
        let dir = fixture();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"favicon": "gone.png"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, stdout, stderr) = execute(&request);

        let error = outcome.expect_err("a missing favicon is a hard error");
        assert!(
            error.to_string().contains("cannot read the favicon"),
            "unexpected message: {error}"
        );
        assert!(!out.exists(), "a refused build writes nothing");
        assert_eq!(stdout, "");
        assert!(
            stderr.is_empty(),
            "the error goes to the process sink: {stderr}"
        );
    }

    #[test]
    fn html_dir_writes_the_favicon_next_to_the_page() {
        let dir = fixture();
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::HtmlDir);

        let (outcome, _, _) = execute(&request);
        let outcome = outcome.expect("the build succeeds");

        // The fixture's one document asset plus the default favicon.
        assert_eq!(outcome.written.assets, 2);
        let page = std::fs::read_to_string(out.join(writers::HTML_FILE_NAME)).expect("read page");
        let start = page
            .find(r#"<link rel="icon" href="assets/"#)
            .expect("the favicon link addresses the assets folder");
        let rest = &page[start + r#"<link rel="icon" href=""#.len()..];
        let end = rest.find('"').expect("the link closes");
        let favicon_name = &rest[..end];
        let favicon_path = favicon_name
            .split('/')
            .fold(out.to_path_buf(), |path, part| path.join(part));

        assert!(
            favicon_path.is_file(),
            "the linked favicon file exists: {favicon_name}"
        );
        assert!(
            favicon_name.ends_with(".svg"),
            "the default favicon keeps the vector extension: {favicon_name}"
        );
    }

    #[test]
    fn quiet_suppresses_the_summary_but_not_the_diagnostics() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("a.md"), "# A\n\n[gone](missing.md)\n")
            .expect("write fixture");
        let mut quiet_request = request(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );
        quiet_request.quiet = true;

        let (outcome, stdout, stderr) = execute(&quiet_request);

        assert!(outcome.is_ok());
        assert_eq!(stdout, "");
        assert!(
            stderr.contains("link target not found: 'missing.md'"),
            "{stderr}"
        );
        assert!(
            stderr.contains("1 warning (use --strict to fail)"),
            "{stderr}"
        );
    }

    #[test]
    fn warnings_are_reported_but_do_not_fail_the_build() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join("a.md"),
            "# A\n\n[gone](missing.md)\n\n![x](gone.png)\n",
        )
        .expect("write fixture");
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, _, stderr) = execute(&request);

        assert_eq!(outcome.expect("warnings do not fail").warnings, 2);
        assert!(
            stderr.contains("2 warnings (use --strict to fail)"),
            "{stderr}"
        );
        assert!(out.join(writers::HTML_FILE_NAME).is_file());
    }

    #[test]
    fn strict_mode_fails_before_writing_anything() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("a.md"), "# A\n\n[gone](missing.md)\n")
            .expect("write fixture");
        let out = dir.path().join("dist");
        let mut strict_request = request(dir.path(), &out, OutputFormat::SingleHtml);
        strict_request.settings.strict = Some(true);

        let (outcome, stdout, stderr) = execute(&strict_request);

        let error = outcome.expect_err("--strict fails on warnings");
        assert_eq!(error.exit_code(), crate::error::EXIT_FAILURE);
        assert_eq!(
            error.to_string(),
            "1 warning treated as an error (--strict)"
        );
        assert!(
            !out.exists(),
            "a failed build must not create the output directory"
        );
        assert_eq!(stdout, "", "a failed build prints no summary");
        assert!(stderr.contains("link target not found"), "{stderr}");
    }

    #[test]
    fn strict_mode_leaves_a_previous_artifact_untouched() {
        let dir = fixture();
        let out = dir.path().join("dist");
        execute(&request(dir.path(), &out, OutputFormat::SingleHtml))
            .0
            .expect("the first build succeeds");
        let before = std::fs::read(out.join(writers::HTML_FILE_NAME)).expect("read artifact");

        std::fs::write(dir.path().join("b.md"), "# B\n\n[gone](missing.md)\n")
            .expect("write fixture");
        let mut strict_request = request(dir.path(), &out, OutputFormat::SingleHtml);
        strict_request.settings.strict = Some(true);
        execute(&strict_request)
            .0
            .expect_err("--strict fails on warnings");

        assert_eq!(
            std::fs::read(out.join(writers::HTML_FILE_NAME)).expect("read artifact"),
            before,
            "a refused build must not empty the previous one"
        );
    }

    #[test]
    fn a_clean_build_prints_no_format_specific_note() {
        let dir = fixture();
        for format in OutputFormat::ALL {
            let mut format_request = request(dir.path(), &dir.path().join(format.as_str()), format);
            format_request.quiet = true;

            let (outcome, stdout, stderr) = execute(&format_request);
            let outcome = outcome.expect("the build succeeds");

            // `single-html` folds the asset into the page, `html-dir` writes it
            // as a sibling file, and `pages` adds a chunk per document and
            // the search corpus next to the shell.
            let expected_files = match format {
                OutputFormat::SingleHtml => 1,
                OutputFormat::HtmlDir => 1 + outcome.written.assets,
                OutputFormat::Pages => 2 + outcome.stats.documents + outcome.written.assets,
            };
            assert_eq!(outcome.written.files, expected_files, "{format}");
            assert!(
                outcome.written.assets > 0,
                "{format}: the fixture has one asset"
            );
            assert_eq!(stdout, "", "{format}: --quiet silences stdout");
            assert!(
                !stderr.to_lowercase().contains("note: chromium"),
                "{format}: no format implies a browser limitation any more: {stderr}"
            );
            assert!(
                !stderr.contains("warning"),
                "{format}: a clean build reports no warning: {stderr}"
            );
        }
    }

    #[test]
    fn a_pages_run_writes_the_shell_chunks_corpus_and_assets() {
        use crate::render::{PAGES_DIR_NAME, SEARCH_FILE_NAME};

        let dir = fixture();
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::Pages);

        let (outcome, stdout, _) = execute(&request);
        let outcome = outcome.expect("the build succeeds");

        assert!(out.join(writers::HTML_FILE_NAME).is_file());
        assert!(out.join(SEARCH_FILE_NAME).is_file());
        assert!(out.join(PAGES_DIR_NAME).join("intro.md.json").is_file());
        assert!(out.join(writers::ASSETS_DIR_NAME).is_dir());
        assert_eq!(
            outcome.written.files, 5,
            "the shell, one chunk, the corpus and two assets"
        );
        assert!(
            stdout.contains("(pages)"),
            "the summary names the format: {stdout}"
        );
    }

    #[test]
    fn an_invalid_input_fails_before_touching_the_output_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("nope");
        let out = dir.path().join("dist");
        let request = request(&missing, &out, OutputFormat::SingleHtml);

        let (outcome, _, _) = execute(&request);

        assert!(outcome.is_err());
        assert!(!out.exists());
    }

    #[test]
    fn the_configuration_sets_the_home_document() {
        let dir = fixture();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"home": "intro.md"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, _, stderr) = execute(&request);
        outcome.expect("the build succeeds");

        assert!(
            !stderr.contains("config:"),
            "a resolvable home is silent: {stderr}"
        );
        let artifact =
            std::fs::read_to_string(out.join(writers::HTML_FILE_NAME)).expect("read artifact");
        assert!(
            artifact.contains(r#""home":"intro.md""#),
            "the payload carries the configured home"
        );
    }

    #[test]
    fn the_configuration_excludes_directories_from_the_scan() {
        let dir = fixture();
        std::fs::create_dir(dir.path().join("drafts")).expect("create directory");
        std::fs::write(dir.path().join("drafts").join("wip.md"), "# Wip\n").expect("write draft");
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"exclude": ["drafts"]}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, _, stderr) = execute(&request);
        let outcome = outcome.expect("the build succeeds");

        assert_eq!(
            outcome.stats.documents, 1,
            "the excluded draft is not compiled"
        );
        assert!(stderr.contains("note: excluded 1 directory"), "{stderr}");
        assert!(
            !stderr.contains("config:"),
            "a usable exclude list is silent: {stderr}"
        );
    }

    #[test]
    fn an_unknown_home_warns_and_strict_fails_before_writing() {
        let dir = fixture();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"home": "gone.md"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let mut strict_request = request(dir.path(), &out, OutputFormat::SingleHtml);
        strict_request.settings.strict = Some(true);

        let (outcome, stdout, stderr) = execute(&strict_request);

        let error = outcome.expect_err("an unknown home is a warning, strict turns it fatal");
        assert_eq!(
            error.to_string(),
            "1 warning treated as an error (--strict)"
        );
        assert!(!out.exists(), "a refused build writes nothing");
        assert_eq!(stdout, "");
        assert!(
            stderr.contains("config: home 'gone.md' does not match any document"),
            "{stderr}"
        );
    }

    #[test]
    fn a_malformed_configuration_aborts_the_build() {
        let dir = fixture();
        std::fs::write(dir.path().join(crate::config::CONFIG_FILE_NAME), "{oops")
            .expect("write config");
        let out = dir.path().join("dist");
        let request = request(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, stdout, stderr) = execute(&request);

        let error = outcome.expect_err("broken JSON is a hard error");
        assert!(
            error.to_string().contains("is not valid JSON"),
            "unexpected message: {error}"
        );
        assert!(!out.exists());
        assert_eq!(stdout, "");
        assert!(
            stderr.is_empty(),
            "the error goes to the process sink: {stderr}"
        );
    }

    #[test]
    fn configuration_problems_are_reported_between_scan_and_build() {
        let dir = fixture();
        std::fs::write(dir.path().join("image.png"), "png").expect("write asset");
        std::fs::write(
            dir.path().join("intro.md"),
            "# Intro\n\n[gone](missing.md)\n",
        )
        .expect("rewrite doc");
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"typo": true}"#,
        )
        .expect("write config");
        let request = request(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );

        let (outcome, _, stderr) = execute(&request);
        outcome.expect("warnings do not fail the build");

        let scan_note = stderr
            .find("note: ignored 2 non-markdown files")
            .expect("scan note");
        let config_note = stderr
            .find("config: unknown key 'typo' ignored")
            .expect("config note");
        let build_note = stderr.find("link target not found").expect("build note");
        assert!(
            scan_note < config_note && config_note < build_note,
            "expected scan, then config, then build: {stderr}"
        );
        assert!(
            stderr.contains("2 warnings (use --strict to fail)"),
            "config warnings join the count: {stderr}"
        );
    }

    /// A fixture with a drafts and an archive directory, for override tests.
    fn fixture_with_drafts_and_archive() -> tempfile::TempDir {
        let dir = fixture();
        for (name, body) in [("drafts/wip.md", "# Wip\n"), ("archive/old.md", "# Old\n")] {
            let path = dir.path().join(name);
            std::fs::create_dir(path.parent().expect("parent")).expect("create directory");
            std::fs::write(path, body).expect("write fixture");
        }
        dir
    }

    #[test]
    fn the_command_line_home_overrides_the_configuration() {
        let dir = fixture();
        std::fs::write(dir.path().join("second.md"), "# Second\n").expect("write second doc");
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"home": "intro.md"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let mut override_request = request(dir.path(), &out, OutputFormat::SingleHtml);
        override_request.settings.home = Some("second".to_string());

        let (outcome, _, stderr) = execute(&override_request);
        outcome.expect("the build succeeds");

        assert!(
            !stderr.contains("config:"),
            "a resolvable home is silent: {stderr}"
        );
        let artifact =
            std::fs::read_to_string(out.join(writers::HTML_FILE_NAME)).expect("read artifact");
        assert!(
            artifact.contains(r#""home":"second.md""#),
            "the command line home wins over the configured one"
        );
    }

    #[test]
    fn the_command_line_exclusions_replace_the_configuration() {
        let dir = fixture_with_drafts_and_archive();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"exclude": ["drafts"]}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let mut override_request = request(dir.path(), &out, OutputFormat::SingleHtml);
        override_request.settings.exclude = Some(vec!["archive".to_string()]);

        let (outcome, _, stderr) = execute(&override_request);
        let outcome = outcome.expect("the build succeeds");

        assert_eq!(
            outcome.stats.documents, 2,
            "the configured draft is back, the archive is still out"
        );
        assert!(
            stderr.contains("note: excluded 1 directory"),
            "only the command line list is pruned: {stderr}"
        );
    }

    #[test]
    fn the_configuration_supplies_the_output_directory() {
        let dir = fixture();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"out": "site"}"#,
        )
        .expect("write config");
        let out = dir.path().join("site");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                title: Some("Fixture".to_string()),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };

        let (outcome, stdout, _) = execute(&request);
        let outcome = outcome.expect("the build succeeds");

        assert_eq!(outcome.written.files, 1);
        assert!(out.join(writers::HTML_FILE_NAME).is_file());
        assert!(
            stdout.contains(out.to_string_lossy().as_ref()),
            "the summary names the configured output directory: {stdout}"
        );
    }

    #[test]
    fn the_configuration_supplies_the_format() {
        use crate::render::PAGES_DIR_NAME;

        let dir = fixture();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"format": "pages"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                out: Some(out.clone()),
                title: Some("Fixture".to_string()),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };

        let (outcome, stdout, _) = execute(&request);
        outcome.expect("the build succeeds");

        assert!(out.join(PAGES_DIR_NAME).join("intro.md.json").is_file());
        assert!(
            stdout.contains("(pages)"),
            "the summary names the configured format: {stdout}"
        );
    }

    #[test]
    fn the_configuration_supplies_the_title() {
        let dir = fixture();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"title": "From Config"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                out: Some(out.clone()),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };

        let (outcome, _, _) = execute(&request);
        outcome.expect("the build succeeds");

        let artifact =
            std::fs::read_to_string(out.join(writers::HTML_FILE_NAME)).expect("read artifact");
        assert!(
            artifact.contains(r#""title":"From Config""#),
            "the payload carries the configured title"
        );
    }

    #[test]
    fn the_configuration_turns_the_strict_gate_on() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("a.md"), "# A\n\n[gone](missing.md)\n")
            .expect("write fixture");
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"strict": true}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                out: Some(out.clone()),
                title: Some("Fixture".to_string()),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };

        let (outcome, stdout, _) = execute(&request);

        let error = outcome.expect_err("a configured strict gate fails on warnings");
        assert_eq!(
            error.to_string(),
            "1 warning treated as an error (--strict)"
        );
        assert!(!out.exists(), "a refused build writes nothing");
        assert_eq!(stdout, "");
    }

    #[test]
    fn the_command_line_turns_the_configured_strict_gate_off() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("a.md"), "# A\n\n[gone](missing.md)\n")
            .expect("write fixture");
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"strict": true}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                out: Some(out.clone()),
                title: Some("Fixture".to_string()),
                strict: Some(false),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };

        let (outcome, _, stderr) = execute(&request);

        outcome.expect("--strict=false overrides the configured gate");
        assert!(
            stderr.contains("1 warning (use --strict to fail)"),
            "{stderr}"
        );
        assert!(out.join(writers::HTML_FILE_NAME).is_file());
    }
}
