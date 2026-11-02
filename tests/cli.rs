//! Integration tests for the CLI surface: help and version text, exit codes and
//! the resolved output directory reported on stdout.

use std::path::Path;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

/// The compiled `wikicc` binary.
fn wikicc() -> Command {
    Command::cargo_bin("wikicc").expect("wikicc binary is built for integration tests")
}

/// A directory that exists and contains one Markdown document.
fn fixture() -> TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("intro.md"), "# Intro\n\nHello.\n").expect("write fixture");
    dir
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}

#[test]
fn help_lists_documented_options() {
    let output = wikicc().arg("--help").output().expect("run wikicc");
    assert!(output.status.success(), "--help should succeed");
    let stdout = String::from_utf8(output.stdout).expect("help output is utf-8");

    for expected in [
        "INPUT_DIR",
        "--out",
        "--format",
        "--title",
        "--strict",
        "--force",
        "--quiet",
    ] {
        assert!(
            stdout.contains(expected),
            "help output is missing `{expected}`:\n{stdout}"
        );
    }
    assert!(
        stdout.contains("single-html"),
        "help output should mention the default format:\n{stdout}"
    );
}

#[test]
fn version_prints_binary_name_and_version() {
    wikicc()
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::starts_with(format!(
            "wikicc {}",
            env!("CARGO_PKG_VERSION")
        )));
}

#[test]
fn missing_input_directory_exits_with_1() {
    wikicc()
        .arg("/no/such/dir")
        .assert()
        .code(1)
        .stderr(predicate::str::contains("input directory not found"));
}

#[test]
fn input_that_is_a_file_exits_with_1() {
    let dir = fixture();
    let file = dir.path().join("intro.md");

    wikicc()
        .arg(&file)
        .assert()
        .code(1)
        .stderr(predicate::str::contains("input path is not a directory"));
}

#[test]
fn unknown_format_exits_with_2() {
    let dir = fixture();

    wikicc()
        .arg(dir.path())
        .args(["--format", "pdf"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "invalid format 'pdf', expected one of: single-html, html-dir",
        ));
}

#[test]
fn missing_input_argument_exits_with_2() {
    wikicc()
        .assert()
        .code(2)
        .stderr(predicate::str::contains("INPUT_DIR"));
}

#[test]
fn default_output_directory_is_dist_next_to_input() {
    let dir = fixture();
    let expected_out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .assert()
        .success()
        .stdout(predicate::str::contains(path_string(&expected_out)));
}

#[test]
fn explicit_output_directory_is_reported() {
    let dir = fixture();
    let out = dir.path().join("build");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out), "--title", "Handbook"])
        .assert()
        .success()
        .stdout(predicate::str::contains(format!(
            "-> {} (single-html) in ",
            path_string(&out)
        )));

    assert!(
        out.join("index.html").is_file(),
        "the summary names the directory that received the artifact"
    );
}

#[test]
fn the_default_format_writes_one_self_contained_file() {
    let dir = fixture();
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .assert()
        .success()
        .stdout(predicate::str::contains("compiled 1 document, 0 assets"));

    let entries: Vec<_> = std::fs::read_dir(&out)
        .expect("the output directory exists")
        .collect();
    assert_eq!(entries.len(), 1, "single-html writes exactly one file");

    let html = std::fs::read_to_string(out.join("index.html")).expect("index.html is readable");
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(
        !html.contains("wikicc-asset:"),
        "every asset placeholder must be replaced"
    );
}

#[test]
fn rebuilding_over_a_previous_build_succeeds() {
    let dir = fixture();

    wikicc().arg(dir.path()).assert().success();
    wikicc()
        .arg(dir.path())
        .assert()
        .success()
        .stdout(predicate::str::contains("compiled 1 document,"));
}

#[test]
fn a_foreign_output_directory_needs_force() {
    let dir = fixture();
    let out = dir.path().join("out");
    std::fs::create_dir_all(&out).expect("create output directory");
    std::fs::write(out.join("keep.txt"), "keep me").expect("write foreign file");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("--force"));
    assert!(
        out.join("keep.txt").is_file(),
        "a refused build must not touch the directory"
    );

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out), "--force"])
        .assert()
        .success();
    assert!(
        !out.join("keep.txt").exists(),
        "`--force` empties the directory"
    );
    assert!(out.join("index.html").is_file());
}

#[test]
fn the_removed_mhtml_format_is_a_usage_error() {
    wikicc()
        .arg(fixture().path())
        .args(["--format", "mhtml"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "invalid format 'mhtml', expected one of: single-html, html-dir",
        ));
}

#[test]
fn html_dir_format_writes_a_page_and_an_asset_folder() {
    let dir = fixture();
    std::fs::create_dir(dir.path().join("assets")).expect("create the asset directory");
    std::fs::write(dir.path().join("assets").join("logo.svg"), "<svg/>").expect("write asset");
    std::fs::write(
        dir.path().join("intro.md"),
        "# Intro\n\n![Logo](assets/logo.svg)\n",
    )
    .expect("write fixture");

    wikicc()
        .arg(dir.path())
        .args(["--format", "html-dir"])
        .assert()
        .success()
        .stdout(predicate::str::contains("(html-dir) in "))
        .stdout(predicate::str::contains("compiled 1 document, 1 asset"));

    let out = dir.path().join("dist");
    let assets: Vec<_> = std::fs::read_dir(out.join("assets"))
        .expect("the asset directory exists")
        .collect();
    assert_eq!(assets.len(), 1, "one file per unique asset");

    let html = std::fs::read_to_string(out.join("index.html")).expect("index.html is readable");
    assert!(
        html.contains("assets/"),
        "the page addresses its asset as a sibling file"
    );
    assert!(
        !html.contains("wikicc-asset:"),
        "every asset placeholder must be replaced"
    );
}

#[test]
fn quiet_suppresses_the_summary_line() {
    let dir = fixture();

    wikicc()
        .arg(dir.path())
        .arg("--quiet")
        .assert()
        .success()
        .stdout(predicate::str::is_empty());
}

#[test]
fn output_equal_to_input_exits_with_1() {
    let dir = fixture();

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(dir.path())])
        .assert()
        .code(1)
        .stderr(predicate::str::contains(
            "output directory must differ from the input directory",
        ));
}

#[test]
fn summary_reports_compiled_documents_and_assets() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("a.md"), "# A\n\n![logo](logo.svg)\n").expect("write fixture");
    std::fs::write(dir.path().join("b.md"), "# B\n\n[to a](a.md)\n").expect("write fixture");
    std::fs::write(dir.path().join("logo.svg"), "<svg/>").expect("write fixture");

    wikicc()
        .arg(dir.path())
        .assert()
        .success()
        .stdout(predicate::str::contains("compiled 2 documents, 1 asset"));
}

#[test]
fn broken_links_warn_without_strict_and_fail_with_it() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("a.md"), "# A\n\n[gone](missing.md)\n").expect("write fixture");

    wikicc()
        .arg(dir.path())
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "a.md:3: link target not found: 'missing.md'",
        ))
        .stderr(predicate::str::contains("1 warning (use --strict to fail)"));

    wikicc()
        .arg(dir.path())
        .arg("--strict")
        .assert()
        .code(1)
        .stderr(predicate::str::contains(
            "1 warning treated as an error (--strict)",
        ));
}

#[test]
fn quiet_keeps_warnings_on_stderr() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("a.md"), "# A\n\n[gone](missing.md)\n").expect("write fixture");

    wikicc()
        .arg(dir.path())
        .arg("--quiet")
        .assert()
        .success()
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("link target not found"));
}

#[test]
fn output_that_contains_the_input_exits_with_1() {
    let dir = fixture();
    let input = dir.path().join("site");
    std::fs::create_dir(&input).expect("create input");

    wikicc()
        .arg(&input)
        .args(["--out", &path_string(dir.path())])
        .assert()
        .code(1)
        .stderr(predicate::str::contains(
            "output directory must not be an ancestor of the input directory",
        ));
}
