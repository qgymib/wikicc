//! Build orchestration: the stage order, the `--strict` gate and the summary lines.
//!
//! This is the module that turns the individual stages described in
//! `docs/design.md` into one run. The order is a contract:
//!
//! 1. validate the options (input tree and output-directory guards),
//! 2. scan the input directory,
//! 3. read the optional `.wikicc.json` configuration from the input root,
//! 4. assemble the payload and resolve links and assets,
//! 5. report every diagnostic on stderr (scan, then config, then build),
//! 6. apply the `--strict` gate,
//! 7. summarise the warnings,
//! 8. render the page and write the artifact,
//! 9. print the summary line (unless `--quiet`).
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
use crate::error::{Error, Result};
use crate::options::{Options, OutputFormat};
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

/// Run the whole pipeline for `options`.
///
/// Diagnostics and the warning summary go to `err`; the summary line goes to
/// `out` unless `--quiet` was passed. Both sinks are
/// flushed by their owners, so a caller that owns a buffer sees everything
/// after the call returns.
pub fn run(options: &Options, out: &mut dyn Write, err: &mut dyn Write) -> Result<BuildOutcome> {
    let started = Instant::now();

    options.validate()?;

    let report = scan::scan(&options.input, &options.out)?;

    // The configuration is an explicit instruction, so a file that cannot be
    // read or understood aborts the build here, before anything is reported
    // or written; a `home` that matches no document only warns. The file is
    // read after the scan because resolving `home` needs the document ids.
    let site_config = config::load(&options.input)?;
    let ids: Vec<String> = report.docs.iter().map(|doc| doc.id.clone()).collect();
    let (home, resolved_diagnostics) = site_config.resolve_home(&ids);
    let mut config_diagnostics = site_config.diagnostics;
    config_diagnostics.extend(resolved_diagnostics);

    let mut build = site::build_site(&options.title, &options.input, &report.docs);
    build.bundle.home = home;

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
        RenderedOutput::Pages(render_pages(&build.bundle)?)
    } else {
        RenderedOutput::Page(render_site(&build.bundle)?)
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
        writeln!(out, "{}", outcome.summary(options))?;
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
    use crate::options::OutputFormat;

    /// Options for one run, built without going through clap.
    fn options(input: &Path, out: &Path, format: OutputFormat) -> Options {
        Options {
            input: input.to_path_buf(),
            out: out.to_path_buf(),
            format,
            title: "Fixture".to_string(),
            strict: false,
            force: false,
            quiet: false,
        }
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
    fn execute(options: &Options) -> (Result<BuildOutcome>, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let outcome = run(options, &mut out, &mut err);

        (
            outcome,
            String::from_utf8(out).expect("stdout is utf-8"),
            String::from_utf8(err).expect("stderr is utf-8"),
        )
    }

    #[test]
    fn summary_counts_documents_assets_output_and_format() {
        let dir = fixture();
        let options = options(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );
        let (outcome, stdout, _) = execute(&options);
        let outcome = outcome.expect("the build succeeds");

        assert_eq!(outcome.stats.documents, 1);
        assert_eq!(outcome.stats.assets, 1);
        assert_eq!(
            outcome.summary(&options),
            format!(
                "compiled 1 document, 1 asset -> {} (single-html) in {} ms",
                options.out.display(),
                outcome.elapsed.as_millis()
            )
        );
        assert_eq!(stdout.trim_end(), outcome.summary(&options));
    }

    #[test]
    fn summary_uses_plural_forms() {
        let dir = fixture();
        let options = options(
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
            outcome.summary(&options),
            format!(
                "compiled 3 documents, 2 assets -> {} (single-html) in 7 ms",
                options.out.display()
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
        let options = options(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, stdout, stderr) = execute(&options);
        let outcome = outcome.expect("the build succeeds");

        assert_eq!(outcome.written.files, 1);
        assert!(outcome.written.bytes > 0);
        assert_eq!(outcome.warnings, 0);
        assert!(out.join(writers::HTML_FILE_NAME).is_file());
        assert!(stdout.starts_with("compiled 1 document, 1 asset -> "));
        assert!(
            !stderr.contains("warning"),
            "a clean build reports no warning: {stderr}"
        );
    }

    #[test]
    fn quiet_suppresses_the_summary_but_not_the_diagnostics() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("a.md"), "# A\n\n[gone](missing.md)\n")
            .expect("write fixture");
        let mut options = options(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );
        options.quiet = true;

        let (outcome, stdout, stderr) = execute(&options);

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
        let options = options(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );

        let (outcome, _, stderr) = execute(&options);

        assert_eq!(outcome.expect("warnings do not fail").warnings, 2);
        assert!(
            stderr.contains("2 warnings (use --strict to fail)"),
            "{stderr}"
        );
        assert!(options.out.join(writers::HTML_FILE_NAME).is_file());
    }

    #[test]
    fn strict_mode_fails_before_writing_anything() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("a.md"), "# A\n\n[gone](missing.md)\n")
            .expect("write fixture");
        let mut options = options(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );
        options.strict = true;

        let (outcome, stdout, stderr) = execute(&options);

        let error = outcome.expect_err("--strict fails on warnings");
        assert_eq!(error.exit_code(), crate::error::EXIT_FAILURE);
        assert_eq!(
            error.to_string(),
            "1 warning treated as an error (--strict)"
        );
        assert!(
            !options.out.exists(),
            "a failed build must not create the output directory"
        );
        assert_eq!(stdout, "", "a failed build prints no summary");
        assert!(stderr.contains("link target not found"), "{stderr}");
    }

    #[test]
    fn strict_mode_leaves_a_previous_artifact_untouched() {
        let dir = fixture();
        let out = dir.path().join("dist");
        execute(&options(dir.path(), &out, OutputFormat::SingleHtml))
            .0
            .expect("the first build succeeds");
        let before = std::fs::read(out.join(writers::HTML_FILE_NAME)).expect("read artifact");

        std::fs::write(dir.path().join("b.md"), "# B\n\n[gone](missing.md)\n")
            .expect("write fixture");
        let mut options = options(dir.path(), &out, OutputFormat::SingleHtml);
        options.strict = true;
        execute(&options).0.expect_err("--strict fails on warnings");

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
            let mut options = options(dir.path(), &dir.path().join(format.as_str()), format);
            options.quiet = true;

            let (outcome, stdout, stderr) = execute(&options);
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
        let options = options(dir.path(), &out, OutputFormat::Pages);

        let (outcome, stdout, _) = execute(&options);
        let outcome = outcome.expect("the build succeeds");

        assert!(out.join(writers::HTML_FILE_NAME).is_file());
        assert!(out.join(SEARCH_FILE_NAME).is_file());
        assert!(out.join(PAGES_DIR_NAME).join("intro.md.json").is_file());
        assert!(out.join(writers::ASSETS_DIR_NAME).is_dir());
        assert_eq!(
            outcome.written.files, 4,
            "the shell, one chunk, the corpus and one asset"
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
        let options = options(&missing, &out, OutputFormat::SingleHtml);

        let (outcome, _, _) = execute(&options);

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
        let options = options(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, _, stderr) = execute(&options);
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
    fn an_unknown_home_warns_and_strict_fails_before_writing() {
        let dir = fixture();
        std::fs::write(
            dir.path().join(crate::config::CONFIG_FILE_NAME),
            r#"{"home": "gone.md"}"#,
        )
        .expect("write config");
        let out = dir.path().join("dist");
        let mut options = options(dir.path(), &out, OutputFormat::SingleHtml);
        options.strict = true;

        let (outcome, stdout, stderr) = execute(&options);

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
        let options = options(dir.path(), &out, OutputFormat::SingleHtml);

        let (outcome, stdout, stderr) = execute(&options);

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
        let options = options(
            dir.path(),
            &dir.path().join("dist"),
            OutputFormat::SingleHtml,
        );

        let (outcome, _, stderr) = execute(&options);
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
}
