//! End-to-end coverage of the `.wikicc.json` configuration file.
//!
//! The unit tests of `src/config.rs` pin the parsing and the resolution; the
//! pipeline tests in `src/pipeline.rs` pin the diagnostics order and the
//! strict gate. This suite walks real builds: a configuration in the input
//! root must reach the artifact of every output format, the command line
//! must override it value by value, and everything the product promised
//! about the file must hold from the command line's point of view.

use std::path::Path;

use wikicc::config::{self, CONFIG_FILE_NAME, SiteConfig};
use wikicc::error::Result;
use wikicc::options::{OutputFormat, Request, Settings};
use wikicc::pipeline::{self, BuildOutcome};
use wikicc::writers::HTML_FILE_NAME;

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
        quiet: true,
    }
}

/// A two-document site; `b.md` is deliberately not the byte-order first one.
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    for (name, contents) in [("a.md", "# A\n"), ("b.md", "# B\n")] {
        std::fs::write(dir.path().join(name), contents).expect("write fixture");
    }
    dir
}

/// A fixture that also carries a drafts and an archive directory.
fn fixture_with_side_folders() -> tempfile::TempDir {
    let dir = fixture();
    for (name, body) in [("drafts/wip.md", "# Wip\n"), ("archive/old.md", "# Old\n")] {
        let path = dir.path().join(name);
        std::fs::create_dir(path.parent().expect("parent")).expect("create directory");
        std::fs::write(path, body).expect("write fixture");
    }
    dir
}

/// Run `run` and return `(outcome, stdout, stderr)`.
fn execute(request: &Request) -> (Result<BuildOutcome>, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let outcome = pipeline::run(request, &mut out, &mut err);

    (
        outcome,
        String::from_utf8(out).expect("stdout is utf-8"),
        String::from_utf8(err).expect("stderr is utf-8"),
    )
}

/// The shell page of a build, whatever the format.
fn shell_of(out: &Path) -> String {
    std::fs::read_to_string(out.join(HTML_FILE_NAME)).expect("read the shell page")
}

#[test]
fn the_configured_home_reaches_every_format() {
    for format in OutputFormat::ALL {
        let dir = fixture();
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"home": "b"}"#)
            .expect("write config");
        let out = dir.path().join(format.as_str());
        let request = request(dir.path(), &out, format);

        let (outcome, _, stderr) = execute(&request);
        outcome.unwrap_or_else(|error| panic!("{format}: the build succeeds: {error}"));

        assert!(
            !stderr.contains("config:"),
            "{format}: a resolvable home is silent: {stderr}"
        );
        let shell = shell_of(&out);
        assert!(
            shell.contains(r#""home":"b.md""#),
            "{format}: the payload carries the resolved home"
        );
    }
}

#[test]
fn a_site_without_a_config_stays_without_a_home_key() {
    let dir = fixture();
    let out = dir.path().join("dist");
    let request = request(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, _) = execute(&request);
    outcome.expect("the build succeeds");

    assert!(
        !shell_of(&out).contains(r#""home""#),
        "no configuration means the payload keeps its old shape"
    );
}

#[test]
fn an_unknown_home_warns_but_still_builds() {
    let dir = fixture();
    std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"home": "gone.md"}"#)
        .expect("write config");
    let out = dir.path().join("dist");
    let request = request(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, stderr) = execute(&request);

    outcome.expect("a warning does not fail the build");
    assert!(
        stderr.contains("config: home 'gone.md' does not match any document"),
        "{stderr}"
    );
}

#[test]
fn strict_turns_an_unknown_home_into_a_refused_build() {
    let dir = fixture();
    std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"home": "gone.md"}"#)
        .expect("write config");
    let out = dir.path().join("dist");
    let mut strict_request = request(dir.path(), &out, OutputFormat::SingleHtml);
    strict_request.settings.strict = Some(true);

    let (outcome, _, _) = execute(&strict_request);

    assert!(outcome.is_err(), "--strict upgrades the warning");
    assert!(!out.exists(), "a refused build writes nothing");
}

#[test]
fn a_malformed_config_is_a_hard_error() {
    let dir = fixture();
    std::fs::write(dir.path().join(CONFIG_FILE_NAME), "{oops").expect("write config");
    let out = dir.path().join("dist");
    let request = request(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, _) = execute(&request);

    let error = outcome.expect_err("broken JSON aborts the build");
    assert!(
        error.to_string().contains("is not valid JSON"),
        "unexpected message: {error}"
    );
    assert!(!out.exists());
}

#[test]
fn the_config_file_is_not_reported_as_ignored() {
    let dir = fixture();
    std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"home": "b.md"}"#).expect("write config");
    let request = request(
        dir.path(),
        &dir.path().join("dist"),
        OutputFormat::SingleHtml,
    );

    let (outcome, _, stderr) = execute(&request);
    outcome.expect("the build succeeds");

    assert!(
        !stderr.contains("non-markdown"),
        "the configuration is an input, not an ignored file: {stderr}"
    );
}

#[test]
fn the_excluded_directory_stays_out_of_every_format() {
    for format in OutputFormat::ALL {
        let dir = fixture();
        std::fs::create_dir_all(dir.path().join("drafts").join("deep")).expect("create dirs");
        std::fs::write(dir.path().join("drafts").join("hidden.md"), "# Hidden\n")
            .expect("write hidden doc");
        std::fs::write(
            dir.path().join("drafts").join("deep").join("older.md"),
            "# Older\n",
        )
        .expect("write nested doc");
        std::fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            r#"{"exclude": ["drafts"]}"#,
        )
        .expect("write config");
        let out = dir.path().join(format.as_str());
        let request = request(dir.path(), &out, format);

        let (outcome, _, stderr) = execute(&request);
        let outcome =
            outcome.unwrap_or_else(|error| panic!("{format}: the build succeeds: {error}"));

        assert_eq!(
            outcome.stats.documents, 2,
            "{format}: only the two top-level documents compile"
        );
        assert!(
            stderr.contains("note: excluded 1 directory"),
            "{format}: the note counts pruned directories: {stderr}"
        );
        let shell = shell_of(&out);
        assert!(
            !shell.contains(r#""id":"drafts/hidden.md""#),
            "{format}: the payload carries no excluded document"
        );
        assert!(
            shell.contains(r#""id":"a.md""#),
            "{format}: the kept documents are still there"
        );
    }
}

#[test]
fn a_home_inside_an_excluded_directory_falls_back_with_a_warning() {
    let dir = fixture();
    std::fs::create_dir(dir.path().join("drafts")).expect("create dir");
    std::fs::write(dir.path().join("drafts").join("hidden.md"), "# Hidden\n")
        .expect("write hidden doc");
    std::fs::write(
        dir.path().join(CONFIG_FILE_NAME),
        r#"{"home": "drafts/hidden.md", "exclude": ["drafts"]}"#,
    )
    .expect("write config");
    let out = dir.path().join("dist");
    let request = request(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, stderr) = execute(&request);
    outcome.expect("a warning does not fail the build");

    assert!(
        stderr.contains("config: home 'drafts/hidden.md' does not match any document"),
        "{stderr}"
    );
    assert!(
        !shell_of(&out).contains(r#""home""#),
        "the fallback keeps the payload's old shape"
    );
}

#[test]
fn a_malformed_exclude_list_aborts_the_build() {
    let dir = fixture();
    std::fs::write(
        dir.path().join(CONFIG_FILE_NAME),
        r#"{"exclude": ["../outside"]}"#,
    )
    .expect("write config");
    let out = dir.path().join("dist");
    let request = request(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, _) = execute(&request);

    let error = outcome.expect_err("an escaping exclusion is a hard error");
    assert!(
        error.to_string().contains("'exclude' entry"),
        "unexpected message: {error}"
    );
    assert!(!out.exists(), "a refused build writes nothing");
}

#[test]
fn the_configured_out_reaches_the_artifact() {
    let dir = fixture();
    std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"out": "site"}"#).expect("write config");
    let out = dir.path().join("site");
    let request = Request {
        input: dir.path().to_path_buf(),
        settings: Settings {
            title: Some("Fixture".to_string()),
            ..Settings::default()
        },
        force: false,
        quiet: true,
    };

    let (outcome, _, _) = execute(&request);
    outcome.expect("the build succeeds");

    assert!(out.join(HTML_FILE_NAME).is_file());
}

#[test]
fn the_configured_format_reaches_the_artifact() {
    let dir = fixture();
    std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"format": "pages"}"#)
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
        quiet: true,
    };

    let (outcome, _, _) = execute(&request);
    outcome.expect("the build succeeds");

    assert!(out.join("pages").join("a.md.json").is_file());
    assert!(out.join("search.json").is_file());
}

#[test]
fn the_command_line_overrides_the_configured_home_and_exclusions() {
    let dir = fixture_with_side_folders();
    std::fs::write(
        dir.path().join(CONFIG_FILE_NAME),
        r#"{"home": "a.md", "exclude": ["drafts"]}"#,
    )
    .expect("write config");
    let out = dir.path().join("dist");
    let mut override_request = request(dir.path(), &out, OutputFormat::SingleHtml);
    override_request.settings.home = Some("b".to_string());
    override_request.settings.exclude = Some(vec!["archive".to_string()]);

    let (outcome, _, stderr) = execute(&override_request);
    let outcome = outcome.expect("the build succeeds");

    assert_eq!(
        outcome.stats.documents, 3,
        "the configured draft is back and the archive is out"
    );
    assert!(
        !stderr.contains("config:"),
        "the command line home resolves silently: {stderr}"
    );
    let shell = shell_of(&out);
    assert!(
        shell.contains(r#""home":"b.md""#),
        "the command line home wins over the configured one"
    );
    assert!(
        !shell.contains(r#""id":"archive/old.md""#),
        "the command line exclusions replace the configured ones"
    );
    assert!(
        shell.contains(r#""id":"drafts/wip.md""#),
        "the configured draft is no longer excluded"
    );
}

#[test]
fn an_initialized_configuration_builds_without_warnings() {
    for format in OutputFormat::ALL {
        let dir = fixture();
        let mut report = Vec::new();
        config::init(dir.path(), &mut report).expect("init succeeds in a fresh site");

        let loaded = config::load(dir.path()).expect("the written file loads");
        assert_eq!(loaded, SiteConfig::default(), "the template is all unset");

        let out = dir.path().join(format.as_str());
        let request = request(dir.path(), &out, format);

        let (outcome, _, stderr) = execute(&request);
        outcome.unwrap_or_else(|error| panic!("{format}: the build succeeds: {error}"));

        assert!(
            !stderr.contains("config:"),
            "{format}: the default template is silent: {stderr}"
        );
    }
}

#[test]
fn the_configured_favicon_reaches_every_format() {
    for format in OutputFormat::ALL {
        let dir = fixture();
        std::fs::write(dir.path().join("icon.png"), b"png").expect("write favicon");
        std::fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            r#"{"favicon": "icon.png"}"#,
        )
        .expect("write config");
        let out = dir.path().join(format.as_str());
        let request = request(dir.path(), &out, format);

        let (outcome, _, stderr) = execute(&request);
        outcome.unwrap_or_else(|error| panic!("{format}: the build succeeds: {error}"));

        assert!(
            !stderr.contains("config:"),
            "{format}: a readable favicon is silent: {stderr}"
        );
        let shell = shell_of(&out);
        assert!(
            shell.contains(r#"<link rel="icon""#),
            "{format}: the head carries the favicon link"
        );
    }
}

#[test]
fn a_favicon_that_cannot_be_read_aborts_the_build() {
    let dir = fixture();
    std::fs::write(
        dir.path().join(CONFIG_FILE_NAME),
        r#"{"favicon": "gone.png"}"#,
    )
    .expect("write config");
    let out = dir.path().join("dist");
    let request = request(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, _) = execute(&request);

    let error = outcome.expect_err("a missing favicon is a hard error");
    assert!(
        error.to_string().contains("cannot read the favicon"),
        "unexpected message: {error}"
    );
    assert!(!out.exists(), "a refused build writes nothing");
}
