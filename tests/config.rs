//! End-to-end coverage of the `.wikicc.json` configuration file.
//!
//! The unit tests of `src/config.rs` pin the parsing and the resolution; the
//! pipeline tests in `src/pipeline.rs` pin the diagnostics order and the
//! strict gate. This suite walks real builds: a configuration in the input
//! root must reach the artifact of every output format, and everything the
//! product promised about the file must hold from the command line's point
//! of view.

use std::path::Path;

use wikicc::config::{self, CONFIG_FILE_NAME, SiteConfig};
use wikicc::error::Result;
use wikicc::options::{Options, OutputFormat};
use wikicc::pipeline::{self, BuildOutcome};
use wikicc::writers::HTML_FILE_NAME;

/// Options for one run, built without going through clap.
fn options(input: &Path, out: &Path, format: OutputFormat) -> Options {
    Options {
        input: input.to_path_buf(),
        out: out.to_path_buf(),
        format,
        title: "Fixture".to_string(),
        strict: false,
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

/// Run `run` and return `(outcome, stdout, stderr)`.
fn execute(options: &Options) -> (Result<BuildOutcome>, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let outcome = pipeline::run(options, &mut out, &mut err);

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
        let options = options(dir.path(), &out, format);

        let (outcome, _, stderr) = execute(&options);
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
    let options = options(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, _) = execute(&options);
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
    let options = options(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, stderr) = execute(&options);

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
    let mut options = options(dir.path(), &out, OutputFormat::SingleHtml);
    options.strict = true;

    let (outcome, _, _) = execute(&options);

    assert!(outcome.is_err(), "--strict upgrades the warning");
    assert!(!out.exists(), "a refused build writes nothing");
}

#[test]
fn a_malformed_config_is_a_hard_error() {
    let dir = fixture();
    std::fs::write(dir.path().join(CONFIG_FILE_NAME), "{oops").expect("write config");
    let out = dir.path().join("dist");
    let options = options(dir.path(), &out, OutputFormat::SingleHtml);

    let (outcome, _, _) = execute(&options);

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
    let options = options(
        dir.path(),
        &dir.path().join("dist"),
        OutputFormat::SingleHtml,
    );

    let (outcome, _, stderr) = execute(&options);
    outcome.expect("the build succeeds");

    assert!(
        !stderr.contains("non-markdown"),
        "the configuration is an input, not an ignored file: {stderr}"
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
        let options = options(dir.path(), &out, format);

        let (outcome, _, stderr) = execute(&options);
        outcome.unwrap_or_else(|error| panic!("{format}: the build succeeds: {error}"));

        assert!(
            !stderr.contains("config:"),
            "{format}: the default template is silent: {stderr}"
        );
    }
}
