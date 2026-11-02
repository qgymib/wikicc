//! Integration tests for the write stage: the artifact that lands on disk.
//!
//! The tests run the same pipeline as the binary (`scan` → `build_site` →
//! `render_site` → `write_site`) against the committed fixture site, so they
//! cover the contract the user cares about: one file, nothing fetched from
//! outside, and byte-identical output across builds.

use std::path::{Path, PathBuf};

use wikicc::options::OutputFormat;
use wikicc::render::{RenderedSite, render_site};
use wikicc::scan::scan;
use wikicc::site::{SiteBuild, build_site};
use wikicc::writers::{self, ASSETS_DIR_NAME, HTML_FILE_NAME, WriteReport};

/// Reference prefixes a `single-html` artifact may still contain.
///
/// `data:` is the inlined asset, `#` is a hash route or an author anchor, and the
/// rest are links the author wrote by hand, which the product must not touch.
const ALLOWED_REFERENCE_PREFIXES: [&str; 7] =
    ["data:", "#", "http://", "https://", "mailto:", "tel:", "//"];

/// Reference prefixes an `html-dir` artifact may contain.
///
/// Identical to the single-file list except that `data:` is replaced by the
/// sibling folder: this format addresses assets as files, never as payloads.
const HTML_DIR_REFERENCE_PREFIXES: [&str; 7] = [
    "assets/", "#", "http://", "https://", "mailto:", "tel:", "//",
];

/// The committed site fixture, which is `--strict` clean.
fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("site")
}

/// Scan the fixture and assemble its payload, exactly as the binary does.
fn fixture_build() -> SiteBuild {
    let root = fixture_root();
    let report = scan(&root, &root.join("dist")).expect("scan");
    build_site("Fixture", &root, &report.docs)
}

fn render(build: &SiteBuild) -> RenderedSite {
    render_site(&build.bundle).expect("the shell renders")
}

/// Write the fixture into `out` in `format`.
fn write_fixture_in(format: OutputFormat, out: &Path) -> WriteReport {
    let build = fixture_build();
    let rendered = render(&build);

    writers::write_site(format, &build, &rendered, out, false).expect("write")
}

/// Write the fixture into `out` in the default format.
fn write_fixture(out: &Path) -> WriteReport {
    write_fixture_in(OutputFormat::SingleHtml, out)
}

/// Every file under `dir`, as `(relative path with forward slashes, bytes)`.
///
/// Comparing whole trees covers both the page and the assets in one assertion,
/// which is what "the build is reproducible" and "no orphan file survived"
/// actually mean for a multi-file artifact.
fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<(String, Vec<u8>)> = walkdir::WalkDir::new(dir)
        .into_iter()
        .map(|entry| entry.expect("walk the output directory"))
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            let relative = entry
                .path()
                .strip_prefix(dir)
                .expect("entry inside the output directory")
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = std::fs::read(entry.path()).expect("read an output file");

            (relative, bytes)
        })
        .collect();

    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

/// Names of the entries directly inside `dir`, sorted.
fn entry_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("read the output directory")
        .map(|entry| {
            entry
                .expect("read a directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();

    names.sort();
    names
}

fn read_page(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(HTML_FILE_NAME)).expect("index.html is readable")
}

/// Payload text embedded in a rendered page.
fn payload_of(html: &str) -> &str {
    const OPEN: &str = r#"<script id="wikicc-payload" type="application/json">"#;

    let start = html.find(OPEN).expect("payload element") + OPEN.len();
    let end = html[start..].find("</script>").expect("payload end") + start;

    &html[start..end]
}

/// Values of every `name="…"` attribute in `html`, in document order.
fn attribute_values(html: &str, name: &str) -> Vec<String> {
    let needle = format!("{name}=\"");
    let mut values = Vec::new();
    let mut cursor = 0;

    while let Some(found) = html[cursor..].find(&needle) {
        let start = cursor + found + needle.len();
        let end = start + html[start..].find('"').expect("attribute end");
        values.push(html[start..end].to_string());
        cursor = end + 1;
    }

    values
}

#[test]
fn the_output_directory_holds_exactly_one_file() {
    let dir = tempfile::tempdir().expect("temp dir");
    let report = write_fixture(dir.path());
    let page = read_page(dir.path());

    assert_eq!(entry_names(dir.path()), [HTML_FILE_NAME]);
    assert_eq!(report.files, 1);
    assert_eq!(
        report.bytes,
        std::fs::metadata(dir.path().join(HTML_FILE_NAME))
            .expect("artifact metadata")
            .len()
    );
    assert_eq!(
        report.bytes,
        page.len() as u64,
        "the report counts the bytes it wrote"
    );
    // The reader bundle alone is several megabytes, so a truncated page is
    // obvious without pinning an exact size that every dependency bump changes.
    assert!(report.bytes > 1_000_000, "page is {} bytes", report.bytes);
    assert_eq!(
        report.assets,
        fixture_build().assets.len(),
        "the fixture references exactly one asset"
    );
    assert_eq!(report.assets, 1);
}

#[test]
fn no_placeholder_or_sibling_reference_survives() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture(dir.path());
    let page = read_page(dir.path());

    for marker in [
        "wikicc-asset:",
        "src=\"assets/",
        "src=\"cid:",
        "href=\"assets/",
        "href=\"cid:",
        "src=\"http",
        "src=\"//",
    ] {
        assert!(
            !page.contains(marker),
            "single-html must be self-contained, found {marker}"
        );
    }
}

#[test]
fn the_referenced_logo_is_inlined_with_its_mime_type() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture(dir.path());

    assert!(
        read_page(dir.path()).contains("data:image/svg+xml;base64,"),
        "the fixture logo must be inlined as an SVG data URI"
    );
}

#[test]
fn the_payload_survives_inlining_and_still_parses() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture(dir.path());
    let page = read_page(dir.path());
    let value: serde_json::Value =
        serde_json::from_str(payload_of(&page)).expect("the payload is still valid JSON");

    assert_eq!(value["title"], "Fixture");
    assert_eq!(value["docs"].as_array().map(Vec::len), Some(3));
    assert_eq!(value["edges"].as_array().map(Vec::len), Some(3));

    for doc in value["docs"].as_array().expect("docs") {
        let html = doc["html"].as_str().expect("doc html");
        assert!(
            !html.contains("wikicc-asset:"),
            "document {} still carries a placeholder",
            doc["id"]
        );
    }
}

#[test]
fn every_reference_is_inline_a_route_or_an_author_url() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture(dir.path());
    let page = read_page(dir.path());
    let value: serde_json::Value = serde_json::from_str(payload_of(&page)).expect("payload JSON");
    let mut checked = 0;

    for doc in value["docs"].as_array().expect("docs") {
        let html = doc["html"].as_str().expect("doc html");

        for attribute in ["src", "href"] {
            for target in attribute_values(html, attribute) {
                assert!(
                    ALLOWED_REFERENCE_PREFIXES
                        .iter()
                        .any(|prefix| target.starts_with(prefix)),
                    "{attribute}=\"{target}\" in {} is not inline, a route or an author URL",
                    doc["id"]
                );
                checked += 1;
            }
        }
    }

    assert!(
        checked >= 4,
        "the fixture has references to check, found {checked}"
    );
}

#[test]
fn two_builds_produce_byte_identical_artifacts() {
    let first = tempfile::tempdir().expect("temp dir");
    let second = tempfile::tempdir().expect("temp dir");

    write_fixture(first.path());
    write_fixture(second.path());

    assert_eq!(
        std::fs::read(first.path().join(HTML_FILE_NAME)).expect("first artifact"),
        std::fs::read(second.path().join(HTML_FILE_NAME)).expect("second artifact")
    );
}

#[test]
fn a_stale_file_from_a_previous_build_is_removed() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join(HTML_FILE_NAME), "<!DOCTYPE html>").expect("write marker");
    std::fs::write(dir.path().join("stale.txt"), "old").expect("write stale file");
    std::fs::create_dir(dir.path().join("assets")).expect("create assets");
    std::fs::write(dir.path().join("assets").join("old.svg"), "<svg/>").expect("write asset");

    write_fixture(dir.path());

    assert_eq!(entry_names(dir.path()), [HTML_FILE_NAME]);
}

#[test]
fn a_foreign_directory_is_refused_without_force() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("keep.txt"), "keep me").expect("write foreign file");
    let build = fixture_build();
    let rendered = render(&build);

    let error = writers::write_site(
        OutputFormat::SingleHtml,
        &build,
        &rendered,
        dir.path(),
        false,
    )
    .expect_err("a foreign directory must be refused");

    assert!(
        error.to_string().contains("use --force to overwrite"),
        "unexpected message: {error}"
    );
    assert!(dir.path().join("keep.txt").is_file());
}

#[test]
fn a_retired_archive_directory_is_refused_without_force() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("index.mhtml"), "MIME-Version: 1.0").expect("write marker");
    let build = fixture_build();
    let rendered = render(&build);

    let error = writers::write_site(
        OutputFormat::SingleHtml,
        &build,
        &rendered,
        dir.path(),
        false,
    )
    .expect_err("a directory holding only a retired artifact must be refused");

    assert!(
        error.to_string().contains("use --force to overwrite"),
        "unexpected message: {error}"
    );
    assert!(
        dir.path().join("index.mhtml").is_file(),
        "nothing may be removed"
    );
}

#[test]
fn html_dir_writes_the_page_next_to_a_deduplicated_asset_folder() {
    let dir = tempfile::tempdir().expect("temp dir");
    let report = write_fixture_in(OutputFormat::HtmlDir, dir.path());

    assert_eq!(entry_names(dir.path()), [ASSETS_DIR_NAME, HTML_FILE_NAME]);
    assert_eq!(
        report.assets,
        fixture_build().assets.len(),
        "the report counts unique assets"
    );
    assert_eq!(report.assets, 1);
    assert_eq!(report.files, 1 + report.assets);
    assert_eq!(
        report.bytes,
        tree(dir.path())
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum::<u64>(),
        "the report counts exactly the bytes on disk"
    );

    let assets = entry_names(&dir.path().join(ASSETS_DIR_NAME));
    assert_eq!(assets.len(), report.assets);
    assert!(
        assets[0].ends_with(".svg"),
        "the asset keeps its extension: {assets:?}"
    );
    assert_eq!(
        std::fs::read(dir.path().join(ASSETS_DIR_NAME).join(&assets[0])).expect("asset file"),
        std::fs::read(fixture_root().join("assets").join("logo.svg")).expect("fixture logo"),
        "the asset is the original file, byte for byte"
    );
}

#[test]
fn html_dir_references_resolve_on_disk() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture_in(OutputFormat::HtmlDir, dir.path());
    let value: serde_json::Value =
        serde_json::from_str(payload_of(&read_page(dir.path()))).expect("payload JSON");
    let mut checked = 0;

    for doc in value["docs"].as_array().expect("docs") {
        let html = doc["html"].as_str().expect("doc html");

        for attribute in ["src", "href"] {
            for target in attribute_values(html, attribute) {
                assert!(
                    HTML_DIR_REFERENCE_PREFIXES
                        .iter()
                        .any(|prefix| target.starts_with(prefix)),
                    "{attribute}=\"{target}\" in {} is not a sibling asset, a route or an author URL",
                    doc["id"]
                );

                if target.starts_with("assets/") {
                    assert!(
                        dir.path().join(&target).is_file(),
                        "{attribute}=\"{target}\" does not exist in the output directory"
                    );
                    checked += 1;
                }
            }
        }
    }

    assert!(checked >= 1, "the fixture references one asset");
}

#[test]
fn html_dir_never_inlines_an_asset_as_a_data_uri() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture_in(OutputFormat::HtmlDir, dir.path());
    let page = read_page(dir.path());
    let value: serde_json::Value = serde_json::from_str(payload_of(&page)).expect("payload JSON");

    assert!(
        !page.contains("wikicc-asset:"),
        "every placeholder must be replaced"
    );

    for doc in value["docs"].as_array().expect("docs") {
        let html = doc["html"].as_str().expect("doc html");
        for attribute in ["src", "href"] {
            for target in attribute_values(html, attribute) {
                assert!(
                    !target.starts_with("data:"),
                    "{attribute}=\"{target}\" in {} is inlined",
                    doc["id"]
                );
            }
        }
    }
}

#[test]
fn html_dir_rebuild_leaves_no_orphan_files() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture_in(OutputFormat::HtmlDir, dir.path());
    let first = tree(dir.path());

    // A previous build of a different site: an extra asset, an extra root file.
    std::fs::write(dir.path().join(ASSETS_DIR_NAME).join("stale.png"), b"old")
        .expect("write stale asset");
    std::fs::write(dir.path().join("stale.txt"), "old").expect("write stale file");

    write_fixture_in(OutputFormat::HtmlDir, dir.path());

    assert_eq!(
        tree(dir.path()),
        first,
        "rebuilding must leave exactly the files of the new build"
    );
}

#[test]
fn html_dir_builds_are_byte_identical() {
    let first = tempfile::tempdir().expect("temp dir");
    let second = tempfile::tempdir().expect("temp dir");

    write_fixture_in(OutputFormat::HtmlDir, first.path());
    write_fixture_in(OutputFormat::HtmlDir, second.path());

    assert_eq!(tree(first.path()), tree(second.path()));
}
