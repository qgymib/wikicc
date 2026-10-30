//! Integration tests for the write stage: the artifact that lands on disk.
//!
//! The tests run the same pipeline as the binary (`scan` → `build_site` →
//! `render_site` → `write_site`) against the committed fixture site, so they
//! cover the contract the user cares about: one file, nothing fetched from
//! outside, and byte-identical output across builds.

use std::path::{Path, PathBuf};

use mailparse::MailHeaderMap;
use wikicc::options::OutputFormat;
use wikicc::render::{RenderedSite, render_site};
use wikicc::scan::scan;
use wikicc::site::{SiteBuild, build_site};
use wikicc::writers::mhtml::boundary_for;
use wikicc::writers::{self, ASSETS_DIR_NAME, HTML_FILE_NAME, MHTML_FILE_NAME, WriteReport};

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

/// Reference prefixes an `mhtml` artifact may contain.
///
/// Assets are MIME parts, so they are addressed by `cid:`; everything else is
/// the same set of routes and author URLs as the other two formats.
const MHTML_REFERENCE_PREFIXES: [&str; 7] =
    ["cid:", "#", "http://", "https://", "mailto:", "tel:", "//"];

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

/// Parse `bytes` as a MIME message.
///
/// The archive is checked by a third-party parser instead of by string
/// matching, so a header that only *looks* right does not pass the test.
fn parse_archive(bytes: &[u8]) -> mailparse::ParsedMail<'_> {
    mailparse::parse_mail(bytes).expect("the archive is a valid MIME message")
}

/// First value of header `name` on `part`, with folding removed.
fn header(part: &mailparse::ParsedMail<'_>, name: &str) -> Option<String> {
    part.get_headers().get_first_value(name)
}

/// The page the archive must carry: the rendered page with every placeholder
/// replaced by the `cid:` reference of its asset.
///
/// This is computed independently of the writer (one `str::replace` per asset,
/// where the writer does a single scan), so the comparison actually proves the
/// addressing rather than re-running the same code.
fn expected_mhtml_page() -> String {
    let build = fixture_build();
    let mut page = render(&build).html;

    for (hash, _) in build.assets.iter() {
        page = page.replace(&format!("wikicc-asset:{hash}"), &format!("cid:{hash}"));
    }

    page
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
fn mhtml_writes_one_archive_file() {
    let dir = tempfile::tempdir().expect("temp dir");
    let report = write_fixture_in(OutputFormat::Mhtml, dir.path());

    assert_eq!(entry_names(dir.path()), [MHTML_FILE_NAME]);
    assert_eq!(report.files, 1);
    assert_eq!(report.assets, fixture_build().assets.len());
    assert_eq!(report.assets, 1);
    assert_eq!(
        report.bytes,
        std::fs::metadata(dir.path().join(MHTML_FILE_NAME))
            .expect("artifact metadata")
            .len(),
        "the report counts the bytes it wrote"
    );
    assert!(
        report.bytes > 1_000_000,
        "archive is {} bytes",
        report.bytes
    );
}

#[test]
fn mhtml_archive_parses_into_one_part_per_resource() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture_in(OutputFormat::Mhtml, dir.path());
    let bytes = std::fs::read(dir.path().join(MHTML_FILE_NAME)).expect("archive");
    let archive = parse_archive(&bytes);
    let build = fixture_build();

    assert_eq!(archive.ctype.mimetype, "multipart/related");
    assert_eq!(
        archive.ctype.params.get("type").map(String::as_str),
        Some("text/html")
    );
    let boundary = archive
        .ctype
        .params
        .get("boundary")
        .expect("the root declares its boundary");
    assert_eq!(
        boundary,
        &boundary_for(&render(&build).html),
        "the boundary must be derived from the page, so builds stay reproducible"
    );
    assert_eq!(
        archive.subparts.len(),
        1 + build.assets.len(),
        "one HTML part plus one part per unique asset"
    );

    let root = &archive.subparts[0];
    assert_eq!(root.ctype.mimetype, "text/html");
    assert_eq!(root.ctype.charset, "utf-8");
    assert_eq!(
        header(root, "content-location").as_deref(),
        Some("index.html")
    );
    assert_eq!(
        header(root, "content-transfer-encoding").as_deref(),
        Some("base64")
    );

    for (part, (hash, asset)) in archive.subparts[1..].iter().zip(build.assets.iter()) {
        let location = writers::asset_relative_path(asset);
        assert_eq!(hash, asset.hash, "parts follow the hash order of the table");
        assert_eq!(
            header(part, "content-location").as_deref(),
            Some(&*location)
        );
        assert_eq!(header(part, "content-type").as_deref(), Some(&*asset.mime));
        assert_eq!(
            header(part, "content-id").as_deref(),
            Some(&*format!("<{hash}>")),
            "a `cid:` reference is only resolvable through Content-ID"
        );
        assert_eq!(
            part.get_body_raw().expect("the part body decodes"),
            asset.bytes,
            "the part carries the original resource, not an encoding of it"
        );
    }
}

#[test]
fn mhtml_html_part_is_the_rendered_page_with_cid_references() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture_in(OutputFormat::Mhtml, dir.path());
    let bytes = std::fs::read(dir.path().join(MHTML_FILE_NAME)).expect("archive");
    let archive = parse_archive(&bytes);
    let root = &archive.subparts[0];
    let page = String::from_utf8(root.get_body_raw().expect("the page decodes"))
        .expect("the page is UTF-8");

    assert_eq!(
        page,
        expected_mhtml_page(),
        "the HTML part is the single-html body with `cid:` instead of `data:`"
    );
    assert!(!page.contains("wikicc-asset:"));
    assert!(
        !page.contains("data:image"),
        "this format never inlines a payload into the markup"
    );

    let value: serde_json::Value =
        serde_json::from_str(payload_of(&page)).expect("the payload is still valid JSON");
    assert_eq!(value["title"], "Fixture");
    assert_eq!(value["docs"].as_array().map(Vec::len), Some(3));

    let mut checked = 0;
    for doc in value["docs"].as_array().expect("docs") {
        let html = doc["html"].as_str().expect("doc html");
        for attribute in ["src", "href"] {
            for target in attribute_values(html, attribute) {
                assert!(
                    MHTML_REFERENCE_PREFIXES
                        .iter()
                        .any(|prefix| target.starts_with(prefix)),
                    "{attribute}=\"{target}\" in {} is not a part, a route or an author URL",
                    doc["id"]
                );
                if target.starts_with("cid:") {
                    let hash = target.strip_prefix("cid:").expect("prefix");
                    assert!(
                        archive
                            .subparts
                            .iter()
                            .any(|part| header(part, "content-id").as_deref()
                                == Some(&*format!("<{hash}>"))),
                        "cid:{hash} has no MIME part"
                    );
                    checked += 1;
                }
            }
        }
    }

    assert!(checked >= 1, "the fixture references one asset");
}

#[test]
fn mhtml_envelope_is_crlf_only_and_folded() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture_in(OutputFormat::Mhtml, dir.path());
    let bytes = std::fs::read(dir.path().join(MHTML_FILE_NAME)).expect("archive");

    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            assert!(
                index > 0 && bytes[index - 1] == b'\r',
                "a bare LF at offset {index} would break the MIME envelope"
            );
        }
    }

    let text = String::from_utf8(bytes).expect("the envelope is ASCII");
    let mut folded_lines = 0;
    for line in text.split("\r\n") {
        let is_base64 = !line.is_empty()
            && line
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "+/=".contains(character));
        if is_base64 {
            assert!(
                line.len() <= 76,
                "a base64 line is {} characters: {line}",
                line.len()
            );
            folded_lines += 1;
        }
    }
    assert!(folded_lines > 100, "the page alone spans many lines");
}

#[test]
fn mhtml_builds_are_byte_identical() {
    let first = tempfile::tempdir().expect("temp dir");
    let second = tempfile::tempdir().expect("temp dir");

    write_fixture_in(OutputFormat::Mhtml, first.path());
    write_fixture_in(OutputFormat::Mhtml, second.path());

    assert_eq!(tree(first.path()), tree(second.path()));
}

#[test]
fn mhtml_rebuild_replaces_the_previous_archive() {
    let dir = tempfile::tempdir().expect("temp dir");
    write_fixture_in(OutputFormat::Mhtml, dir.path());
    let first = tree(dir.path());

    std::fs::write(dir.path().join("stale.txt"), "old").expect("write stale file");

    write_fixture_in(OutputFormat::Mhtml, dir.path());

    assert_eq!(
        tree(dir.path()),
        first,
        "rebuilding must leave exactly the files of the new build"
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
