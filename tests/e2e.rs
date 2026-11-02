//! End-to-end assertions for the reader.
//!
//! Two layers live here:
//!
//! - the first half observes the page through the library pipeline
//!   (`scan` → `build_site` → `render_site`), which is where the markup, the
//!   payload and the bundled script are asserted;
//! - the second half drives the compiled binary, which is the only way to check
//!   the artifacts of the three formats, the reproducibility of a build, the
//!   `--strict` gate and the exit codes.
//!
//! Both halves use the committed fixtures under `tests/fixtures`, so the suite
//! needs no network access: `npm ci` has already staged the front-end
//! dependencies the bundle is built from.

use std::path::{Path, PathBuf};

use assert_cmd::Command;

use wikicc::options::OutputFormat;
use wikicc::scan::scan;
use wikicc::site::build_site;
use wikicc::writers::{ASSETS_DIR_NAME, HTML_FILE_NAME};
use wikicc::{APP_BUNDLE, RenderedSite, SiteBundle, render_site, theme_css};

/// Prefix of the opaque asset placeholder the writers replace.
const ASSET_PREFIX: &str = "wikicc-asset:";

/// Start of the element that carries the payload.
const PAYLOAD_OPEN: &str = r#"<script id="wikicc-payload" type="application/json">"#;

/// The committed site fixture, which is `--strict` clean.
fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("site")
}

/// Scan `root` and assemble its payload, exactly as the binary does.
fn build(root: &Path, title: &str) -> SiteBundle {
    let report = scan(root, &root.join("dist")).expect("scan");
    build_site(title, root, &report.docs).bundle
}

fn render(bundle: &SiteBundle) -> RenderedSite {
    render_site(bundle).expect("the shell renders")
}

/// Payload text embedded in a rendered page.
fn payload_of(html: &str) -> &str {
    let start = html.find(PAYLOAD_OPEN).expect("payload element") + PAYLOAD_OPEN.len();
    let end = html[start..].find("</script>").expect("payload end") + start;

    &html[start..end]
}

#[test]
fn the_page_carries_every_required_marker() {
    let page = render(&build(&fixture_root(), "Fixture"));

    for marker in [
        r#"id="doc-list""#,
        r#"id="doc-content""#,
        r#"id="graph""#,
        r#"id="graph-fit""#,
        r#"id="toc""#,
        r#"id="theme-toggle""#,
        r#"id="doc-filter""#,
        r#"id="wikicc-payload""#,
    ] {
        assert!(page.html.contains(marker), "missing {marker}");
    }
}

#[test]
fn the_page_is_a_utf8_html_document() {
    let page = render(&build(&fixture_root(), "Fixture"));

    assert!(page.html.starts_with("<!DOCTYPE html>"));
    assert!(page.html.contains(r#"<meta charset="utf-8">"#));
    assert!(page.html.contains(r#"<html lang="en">"#));
}

#[test]
fn the_payload_is_embedded_and_parses() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);
    let value: serde_json::Value =
        serde_json::from_str(payload_of(&page.html)).expect("payload is valid JSON");

    assert_eq!(value["title"], "Fixture");
    assert_eq!(value["docs"].as_array().map(Vec::len), Some(3));
    assert_eq!(value["edges"].as_array().map(Vec::len), Some(3));
    assert_eq!(value["docs"][0]["id"], "README.md");
    assert_eq!(
        value["stats"]["documents"].as_u64(),
        Some(bundle.docs.len() as u64)
    );
}

#[test]
fn the_payload_is_escaped_for_the_script_element() {
    let page = render(&build(&fixture_root(), "Fixture"));
    let payload = payload_of(&page.html);

    assert!(!payload.contains('<'), "the payload must not carry raw '<'");
    assert!(!payload.contains("</script"));
    assert_eq!(
        page.html.matches("</script>").count(),
        2,
        "only the payload element and the script bundle may close"
    );
}

#[test]
fn assets_stay_as_placeholders_for_the_writers() {
    let page = render(&build(&fixture_root(), "Fixture"));

    assert!(
        page.html.contains(ASSET_PREFIX),
        "the writers address assets through {ASSET_PREFIX}<hash>"
    );
}

#[test]
fn tables_are_emitted_and_hooked_for_enhancement() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);
    let readme = bundle.doc("README.md").expect("README is compiled");

    // The document HTML lives inside the payload, where `<` is escaped as
    // `\u003c`, so the table is asserted on the bundle rather than the page.
    assert!(readme.html.contains("<table"), "html: {}", readme.html);
    assert!(readme.html.contains("<thead>"), "html: {}", readme.html);
    assert!(
        page.html.contains("data-wikicc-table"),
        "the table enhancement must be bundled into the page"
    );
    assert!(
        page.html.contains("No matching rows"),
        "the empty-filter placeholder must be bundled into the page"
    );
    assert!(
        page.html.contains("table-filter-toggle"),
        "the per-column filter button must be bundled into the page"
    );
    assert!(
        page.html.contains("Search values"),
        "the filter panel's value search must be bundled into the page"
    );
}

#[test]
fn the_link_graph_is_rendered_by_the_page_instead_of_a_placeholder() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);

    assert!(
        !page
            .html
            .contains("The link graph is not available in this build."),
        "the placeholder hint must be gone once the graph is implemented"
    );

    // The graph is built at runtime from the payload, so the page only has to
    // carry the renderer and the hooks it looks for. The layout engine itself
    // is proven by `build.rs`, which cannot produce a bundle without it.
    for marker in [
        "graph-node",
        "graph-edge",
        "graph-label",
        "graph-viewport",
        "wikicc-graph-arrow",
    ] {
        assert!(
            page.html.contains(marker),
            "the graph module is missing {marker}"
        );
    }

    assert_eq!(
        bundle.edges.len(),
        3,
        "the fixture has three edges for the graph to draw"
    );
}

#[test]
fn the_highlighting_theme_is_injected_exactly_once() {
    let page = render(&build(&fixture_root(), "Fixture"));

    assert_eq!(page.html.matches(theme_css()).count(), 1);
    assert_eq!(page.html.matches("</style>").count(), 1);
}

#[test]
fn the_engines_and_the_reader_are_embedded_in_one_script() {
    let page = render(&build(&fixture_root(), "Fixture"));

    assert_eq!(
        page.html.matches("<script>").count(),
        1,
        "the reader must be inlined as a single classic script"
    );
    // The bundle is minified, so identifiers are not asserted; string literals
    // and attribute names are, because esbuild leaves both alone.
    for marker in [
        "wikicc-payload",      // the bootstrap reads the embedded payload
        "data-wikicc-table",   // the table enhancer is bundled
        "table-filter-toggle", // ... with its per-column filter buttons
        "graph-node",          // the link graph renderer is bundled
        "startOnLoad",         // the diagram engine is configured
        "data-processed",      // ... and mermaid itself is present
        "sequenceDiagram",     // ... including its diagram implementations
    ] {
        assert!(page.html.contains(marker), "the bundle is missing {marker}");
    }
    assert!(
        page.html.contains(APP_BUNDLE),
        "build.rs bundled the sources and the page embeds the bundle verbatim"
    );
}

#[test]
fn a_diagram_fence_is_rendered_instead_of_highlighted() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);
    let setup = bundle
        .doc("guide/setup.md")
        .expect("the fixture has a setup document");

    assert!(
        setup.html.contains(r#"<pre class="mermaid">"#),
        "the diagram fence must become a diagram block: {}",
        setup.html
    );
    assert!(
        !setup.html.contains("language-mermaid"),
        "a diagram must not be highlighted: {}",
        setup.html
    );
    assert!(
        page.html.contains("startOnLoad"),
        "the page must configure the diagram engine"
    );
}

#[test]
fn the_page_loads_no_external_resource() {
    let page = render(&build(&fixture_root(), "Fixture"));

    for marker in [
        "<script src=",
        "<link rel=\"stylesheet\"",
        "<link href=",
        "src=\"http",
        "src=\"//",
    ] {
        assert!(
            !page.html.contains(marker),
            "the page must be self-contained, found {marker}"
        );
    }
}

#[test]
fn rendering_the_same_bundle_twice_is_byte_identical() {
    let bundle = build(&fixture_root(), "Fixture");

    assert_eq!(render(&bundle).html, render(&bundle).html);
}

#[test]
fn a_document_with_a_script_terminator_cannot_break_the_page() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("a.md"),
        "# A\n\n</script><script>alert('x')</script>\n",
    )
    .expect("write fixture");

    let page = render(&build(dir.path(), "Broken"));
    let payload = payload_of(&page.html);

    assert_eq!(page.html.matches("</script>").count(), 2);
    assert!(!payload.contains("</script"));
    let value: serde_json::Value = serde_json::from_str(payload).expect("payload JSON");
    assert_eq!(value["docs"].as_array().map(Vec::len), Some(1));
}

#[test]
fn an_empty_site_still_renders_a_complete_page() {
    let dir = tempfile::tempdir().expect("temp dir");
    let page = render(&build(dir.path(), "Empty"));
    let value: serde_json::Value =
        serde_json::from_str(payload_of(&page.html)).expect("payload JSON");

    assert_eq!(value["docs"].as_array().map(Vec::len), Some(0));
    assert!(page.html.contains(r#"id="doc-list""#));
}

// ---------------------------------------------------------------------------
// Binary-level end-to-end checks: artifacts, reproducibility, gate, exit codes
// ---------------------------------------------------------------------------

/// The fixture with a broken link and an escaping asset; it has two warnings.
fn links_fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("links")
}

/// The compiled `wikicc` binary.
fn wikicc() -> Command {
    Command::cargo_bin("wikicc").expect("wikicc binary is built for integration tests")
}

/// Run one build of `input` into `out` with `extra` arguments.
fn build_with(input: &Path, out: &Path, extra: &[&str]) -> std::process::Output {
    wikicc()
        .arg(input)
        .arg("--out")
        .arg(out)
        .args(extra)
        .output()
        .expect("run wikicc")
}

fn stdout_of(output: &std::process::Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("stdout is utf-8")
}

fn stderr_of(output: &std::process::Output) -> String {
    String::from_utf8(output.stderr.clone()).expect("stderr is utf-8")
}

/// Every file under `dir`, as `(relative path with forward slashes, bytes)`.
///
/// Comparing whole trees is what "the build is reproducible" actually means for
/// a multi-file artifact, and it covers the page and the assets in one
/// assertion.
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

#[test]
fn the_default_format_writes_one_self_contained_page() {
    let out = tempfile::tempdir().expect("temp dir");
    let output = build_with(&fixture_root(), out.path(), &[]);

    assert!(output.status.success(), "{}", stderr_of(&output));
    let stdout = stdout_of(&output);
    assert!(
        stdout.contains("compiled 3 documents, 1 asset"),
        "unexpected summary: {stdout}"
    );
    assert!(
        stdout.contains("(single-html) in "),
        "the summary must name the format and the duration: {stdout}"
    );

    let files = tree(out.path());
    assert_eq!(files.len(), 1, "single-html writes exactly one file");
    let page = String::from_utf8(files[0].1.clone()).expect("the page is utf-8");

    assert!(page.starts_with("<!DOCTYPE html>"));
    for marker in [
        "<script src=",
        "<link rel=\"stylesheet\"",
        "<link href=",
        "src=\"http",
        "src=\"//",
        "href=\"http",
        "href=\"//",
        "wikicc-asset:",
    ] {
        assert!(
            !page.contains(marker),
            "the artifact must be self-contained, found {marker}"
        );
    }
    assert!(
        page.contains("data:image/svg+xml"),
        "the fixture logo must be inlined as a data URI"
    );
}

#[test]
fn every_format_writes_its_documented_artifacts() {
    let single = tempfile::tempdir().expect("temp dir");
    let output = build_with(&fixture_root(), single.path(), &["--format", "single-html"]);
    assert!(output.status.success(), "{}", stderr_of(&output));
    assert_eq!(
        tree(single.path())
            .into_iter()
            .map(|(path, _)| path)
            .collect::<Vec<_>>(),
        [HTML_FILE_NAME.to_string()]
    );

    let dir_format = tempfile::tempdir().expect("temp dir");
    let output = build_with(
        &fixture_root(),
        dir_format.path(),
        &["--format", "html-dir"],
    );
    assert!(output.status.success(), "{}", stderr_of(&output));
    let files = tree(dir_format.path());
    let names: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();

    assert!(names.contains(&HTML_FILE_NAME), "paths: {names:?}");
    assert_eq!(
        names.len(),
        2,
        "one page plus one deduplicated asset: {names:?}"
    );
    let asset = names
        .iter()
        .find(|name| name.starts_with(ASSETS_DIR_NAME))
        .expect("the asset folder holds the fixture logo");
    assert!(asset.ends_with(".svg"), "paths: {names:?}");
    let page = files
        .iter()
        .find(|(path, _)| path == HTML_FILE_NAME)
        .map(|(_, bytes)| String::from_utf8(bytes.clone()).expect("the page is utf-8"))
        .expect("the page exists");
    assert!(
        page.contains(asset),
        "the page must address {asset} by its relative path"
    );
}

#[test]
fn building_twice_produces_byte_identical_trees() {
    for format in OutputFormat::ALL {
        let first = tempfile::tempdir().expect("temp dir");
        let second = tempfile::tempdir().expect("temp dir");

        let one = build_with(
            &fixture_root(),
            first.path(),
            &["--format", format.as_str()],
        );
        let two = build_with(
            &fixture_root(),
            second.path(),
            &["--format", format.as_str()],
        );
        assert!(one.status.success(), "{}", stderr_of(&one));
        assert!(two.status.success(), "{}", stderr_of(&two));

        assert_eq!(
            tree(first.path()),
            tree(second.path()),
            "{format} output differs between two builds of the same input"
        );
    }
}

#[test]
fn warnings_are_reported_without_failing_the_build() {
    let out = tempfile::tempdir().expect("temp dir");
    let output = build_with(&links_fixture_root(), out.path(), &[]);

    assert!(output.status.success(), "{}", stderr_of(&output));
    let stderr = stderr_of(&output);
    assert!(
        stderr.contains("link target not found: 'missing.md'"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("link target escapes the input directory: '../outside.png'"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("2 warnings (use --strict to fail)"),
        "stderr: {stderr}"
    );
    assert!(out.path().join(HTML_FILE_NAME).is_file());
}

#[test]
fn strict_mode_fails_on_the_link_fixture_and_writes_nothing() {
    let out = tempfile::tempdir().expect("temp dir");
    let target = out.path().join("dist");
    let output = build_with(&links_fixture_root(), &target, &["--strict"]);

    assert_eq!(output.status.code(), Some(1), "{}", stderr_of(&output));
    let stderr = stderr_of(&output);
    assert!(
        stderr.contains("link target not found: 'missing.md'"),
        "the offending link must be listed: {stderr}"
    );
    assert!(
        stderr.contains("2 warnings treated as errors (--strict)"),
        "stderr: {stderr}"
    );
    assert!(
        !target.exists(),
        "a build refused by --strict must not create an artifact"
    );
    assert!(
        stdout_of(&output).is_empty(),
        "no summary for a failed build"
    );
}

#[test]
fn usage_errors_exit_with_two_and_runtime_errors_with_one() {
    wikicc().assert().code(2);

    let out = tempfile::tempdir().expect("temp dir");
    wikicc()
        .arg(fixture_root())
        .args(["--format", "pdf"])
        .arg("--out")
        .arg(out.path())
        .assert()
        .code(2);

    wikicc().arg(out.path().join("missing")).assert().code(1);
}

#[test]
fn a_clean_build_prints_no_note() {
    for format in OutputFormat::ALL {
        let out = tempfile::tempdir().expect("temp dir");
        let output = build_with(&fixture_root(), out.path(), &["--format", format.as_str()]);
        let stderr = stderr_of(&output);

        assert!(output.status.success(), "{stderr}");
        assert!(
            !stderr.contains("warning"),
            "{format}: the fixture is --strict clean, so nothing may warn: {stderr}"
        );
        assert!(
            !stderr.to_lowercase().contains("mhtml"),
            "{format}: no format carries a special note any more: {stderr}"
        );
        assert!(
            stdout_of(&output).contains(&format!("({format}) in ")),
            "{format}: the summary names the format"
        );
    }
}
