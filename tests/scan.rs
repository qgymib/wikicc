//! Integration tests for the scan stage: recursive discovery, exclusions,
//! document model and the diagnostics surfaced on the command line.

use std::path::Path;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

use wikicc::scan::{Severity, scan};

/// The compiled `wikicc` binary.
fn wikicc() -> Command {
    Command::cargo_bin("wikicc").expect("wikicc binary is built for integration tests")
}

fn write_file(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent directory");
    }
    std::fs::write(&path, contents).expect("write fixture file");
}

fn site(files: &[(&str, &str)]) -> TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    for (relative, contents) in files {
        write_file(dir.path(), relative, contents);
    }
    dir
}

#[test]
fn nested_folders_yield_sorted_document_ids() {
    let dir = site(&[
        ("guide/advanced/tuning.md", "# Tuning\n"),
        ("guide/intro.md", "# Intro\n"),
        ("README.md", "# Home\n"),
        ("appendix.md", "# Appendix\n"),
    ]);

    let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

    let ids: Vec<&str> = report.docs.iter().map(|doc| doc.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "README.md",
            "appendix.md",
            "guide/advanced/tuning.md",
            "guide/intro.md",
        ]
    );
}

#[test]
fn output_directory_contents_never_appear_in_the_document_list() {
    let dir = site(&[
        ("intro.md", "# Intro\n"),
        // A previous build: the artifact marker lets the writer empty the
        // directory again without `--force`.
        ("dist/index.html", "<!DOCTYPE html>\n"),
        ("dist/index.md", "# Previous build\n"),
        ("dist/guide/old.md", "# Previous build\n"),
    ]);

    wikicc()
        .arg(dir.path())
        .arg("--out")
        .arg(dir.path().join("dist"))
        .assert()
        .success()
        .stdout(predicate::str::contains("compiled 1 document,"))
        .stdout(predicate::str::contains("dist/index.md").not());
}

#[test]
fn empty_folder_warns_and_still_exits_with_zero() {
    let dir = tempfile::tempdir().expect("temp dir");

    wikicc()
        .arg(dir.path())
        .assert()
        .code(0)
        .stderr(predicate::str::contains("warning: no markdown files found"))
        .stdout(predicate::str::contains("compiled 0 documents,"));
}

#[test]
fn strict_turns_scan_warnings_into_a_failure() {
    let dir = tempfile::tempdir().expect("temp dir");

    wikicc()
        .arg(dir.path())
        .arg("--strict")
        .assert()
        .code(1)
        .stderr(predicate::str::contains("warning: no markdown files found"))
        .stderr(predicate::str::contains(
            "1 warning treated as an error (--strict)",
        ));
}

#[test]
fn non_utf8_documents_are_skipped_with_a_warning() {
    let dir = site(&[("intro.md", "# Intro\n")]);
    std::fs::write(dir.path().join("latin1.md"), [0x23, 0x20, 0xff, 0xfe]).expect("write fixture");

    wikicc()
        .arg(dir.path())
        .assert()
        .code(0)
        .stderr(predicate::str::contains(
            "warning: skipped 'latin1.md': not valid UTF-8",
        ))
        .stdout(predicate::str::contains("compiled 1 document,"));
}

#[test]
fn markdown_extensions_are_matched_case_insensitively() {
    let dir = site(&[
        ("NOTES.MD", "# Notes\n"),
        ("readme.Markdown", "# Readme\n"),
        ("guide/Intro.Md", "# Intro\n"),
    ]);

    wikicc()
        .arg(dir.path())
        .assert()
        .success()
        .stdout(predicate::str::contains("compiled 3 documents,"));
}

#[test]
fn non_markdown_files_are_ignored_with_a_single_note() {
    let dir = site(&[("intro.md", "# Intro\n"), ("logo.png", "png")]);
    std::fs::write(dir.path().join("notes.txt"), "text").expect("write fixture");

    wikicc()
        .arg(dir.path())
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "note: ignored 2 non-markdown files",
        ))
        .stdout(predicate::str::contains("compiled 1 document,"));
}

#[test]
fn quiet_only_silences_the_summary_line() {
    let dir = tempfile::tempdir().expect("temp dir");

    wikicc()
        .arg(dir.path())
        .arg("--quiet")
        .assert()
        .success()
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("warning: no markdown files found"));
}

#[test]
fn dot_directories_and_node_modules_are_excluded() {
    let dir = site(&[
        ("intro.md", "# Intro\n"),
        (".git/config.md", "# Ignored\n"),
        (".obsidian/notes.md", "# Ignored\n"),
        ("node_modules/pkg/readme.md", "# Ignored\n"),
    ]);

    let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

    assert_eq!(report.docs.len(), 1);
    assert_eq!(report.docs[0].id, "intro.md");
}

#[test]
fn documents_carry_id_title_text_and_path() {
    let dir = site(&[("guide/intro.md", "# **Intro**\n\nBody text.\n")]);

    let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");
    let doc = &report.docs[0];

    assert_eq!(doc.id, "guide/intro.md");
    assert_eq!(doc.title, "Intro");
    assert_eq!(doc.text, "# **Intro**\n\nBody text.\n");
    assert_eq!(doc.path, dir.path().join("guide").join("intro.md"));
    assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
}

#[test]
fn the_front_matter_title_names_the_document() {
    let dir = site(&[(
        "guide/intro.md",
        "---\ntitle: From the matter\n---\n\n# Heading\n",
    )]);

    let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

    assert_eq!(report.docs[0].title, "From the matter");
    assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
}

#[test]
fn the_front_matter_title_travels_into_the_payload() {
    let dir = site(&[(
        "guide/intro.md",
        "---\ntitle: From the matter\n---\n\n# Heading\n",
    )]);
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .arg("--out")
        .arg(&out)
        .arg("--title")
        .arg("Site")
        .assert()
        .success();

    let artifact = std::fs::read_to_string(out.join("index.html")).expect("artifact");
    assert!(
        artifact.contains(r#""title":"From the matter""#),
        "the document title comes from the front matter"
    );
}

#[test]
fn an_unusable_front_matter_title_warns_and_the_artifact_keeps_the_heading() {
    let dir = site(&[("intro.md", "---\ntitle: [a, b]\n---\n\n# Heading\n")]);
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .arg("--out")
        .arg(&out)
        .arg("--title")
        .arg("Site")
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "warning: 'intro.md': front matter title cannot be turned into text; \
             the heading or the file name decides",
        ));

    let artifact = std::fs::read_to_string(out.join("index.html")).expect("artifact");
    assert!(
        artifact.contains(r#""title":"Heading""#),
        "the heading decides when the title cannot become text"
    );
}

#[test]
fn strict_treats_an_unusable_front_matter_title_as_an_error() {
    let dir = site(&[("intro.md", "---\ntitle: [a, b]\n---\n\n# Heading\n")]);

    wikicc()
        .arg(dir.path())
        .arg("--strict")
        .assert()
        .code(1)
        .stderr(predicate::str::contains(
            "warning: 'intro.md': front matter title cannot be turned into text",
        ))
        .stderr(predicate::str::contains(
            "1 warning treated as an error (--strict)",
        ));
}

#[test]
fn diagnostics_expose_their_severity() {
    let dir = site(&[("intro.md", "# Intro\n"), ("logo.png", "png")]);

    let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

    assert_eq!(report.diagnostics.len(), 1);
    assert_eq!(report.diagnostics[0].severity, Severity::Note);
    assert!(!report.has_warnings());
    assert_eq!(report.ignored_files, 1);
}
