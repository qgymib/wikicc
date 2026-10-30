//! Integration tests for the assemble stage: the payload's shape, the link
//! graph and determinism, observed through the public library API
//! (`scan` → `build_site` → `SiteBundle`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use wikicc::scan::scan;
use wikicc::site::{Edge, Stats, build_site};
use wikicc::{SiteBuild, SourceDoc};

/// The committed site fixture, which is `--strict` clean.
fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("site")
}

fn write(root: &Path, relative: &str, contents: impl AsRef<[u8]>) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent directory");
    }
    std::fs::write(path, contents).expect("write fixture file");
}

/// Scan `root` and assemble its payload, exactly as the binary does.
fn build(root: &Path) -> SiteBuild {
    let report = scan(root, &root.join("dist")).expect("scan");
    build_site("Fixture", root, &report.docs)
}

/// Document ids of a payload, in payload order.
fn ids(build: &SiteBuild) -> Vec<&str> {
    build
        .bundle
        .docs
        .iter()
        .map(|doc| doc.id.as_str())
        .collect()
}

fn edge(from: &str, to: &str) -> Edge {
    Edge {
        from: from.to_string(),
        to: to.to_string(),
    }
}

#[test]
fn payload_lists_every_document_once_in_scan_order() {
    let root = fixture_root();
    let report = scan(&root, &root.join("dist")).expect("scan");
    let build = build_site("Fixture", &root, &report.docs);

    let scanned: Vec<&str> = report.docs.iter().map(|doc| doc.id.as_str()).collect();

    assert_eq!(ids(&build), scanned, "payload order is scan order");
    assert_eq!(
        build.bundle.stats.documents,
        scanned.len(),
        "the counter agrees with the list"
    );
    let unique: BTreeSet<&str> = ids(&build).into_iter().collect();
    assert_eq!(unique.len(), scanned.len(), "no document appears twice");
    assert_eq!(
        ids(&build),
        ["README.md", "guide/intro.md", "guide/setup.md"]
    );
}

#[test]
fn edges_collapse_repeats_and_skip_external_and_anchor_links() {
    let build = build(&fixture_root());

    assert_eq!(
        build.bundle.edges,
        [
            edge("README.md", "guide/intro.md"),
            edge("guide/intro.md", "README.md"),
            edge("guide/intro.md", "guide/setup.md"),
        ],
        "the two references to the introduction collapse into one edge"
    );
    assert!(
        build.bundle.edges.iter().all(|edge| edge.from != edge.to),
        "no self-loops"
    );
}

#[test]
fn a_document_without_links_has_no_outgoing_edges() {
    let build = build(&fixture_root());

    assert!(
        build
            .bundle
            .edges
            .iter()
            .all(|edge| edge.from != "guide/setup.md"),
        "edges: {:?}",
        build.bundle.edges
    );
    assert!(
        ids(&build).contains(&"guide/setup.md"),
        "an isolated document still appears in the payload"
    );
}

#[test]
fn payload_json_carries_the_documented_keys_and_counts() {
    let build = build(&fixture_root());
    let value: serde_json::Value =
        serde_json::from_str(&build.bundle.to_json()).expect("payload is valid JSON");

    assert_eq!(value["title"], "Fixture");
    assert_eq!(value["docs"].as_array().map(Vec::len), Some(3));
    assert_eq!(value["edges"].as_array().map(Vec::len), Some(3));
    assert_eq!(
        value["stats"],
        serde_json::json!({
            "documents": 3,
            "assets": 1,
            "asset_bytes": build.bundle.stats.asset_bytes,
        })
    );
    assert_eq!(
        value["stats"]["asset_bytes"].as_u64(),
        Some(build.assets.total_bytes())
    );
    assert_eq!(value["docs"][0]["id"], "README.md");
    assert_eq!(value["docs"][0]["path"], "README.md");
    assert_eq!(value["docs"][0]["title"], "Wikicc Fixture Site");
    assert!(
        value["docs"][0]["toc"].is_array(),
        "the outline is embedded, not referenced"
    );
}

#[test]
fn compiling_the_same_site_twice_is_byte_identical() {
    let root = fixture_root();
    let first = build(&root);
    let second = build(&root);

    assert_eq!(first.bundle.to_json(), second.bundle.to_json());
    assert_eq!(first.assets, second.assets);
    assert_eq!(first.diagnostics, second.diagnostics);
}

#[test]
fn assets_are_addressed_by_placeholder_and_counted() {
    let build = build(&fixture_root());

    assert_eq!(build.assets.len(), 1, "one unique asset");
    assert_eq!(build.bundle.stats.assets, 1);

    let (_, asset) = build.assets.iter().next().expect("one asset");
    assert_eq!(asset.mime, "image/svg+xml");
    assert_eq!(asset.extension, "svg");
    assert_eq!(build.bundle.stats.asset_bytes, asset.len() as u64);

    let readme = build.bundle.doc("README.md").expect("README is compiled");
    assert!(
        readme
            .html
            .contains(&format!("src=\"{}\"", asset.placeholder())),
        "html: {}",
        readme.html
    );
    assert!(
        !readme.html.contains("assets/logo.svg"),
        "the author path must not survive into the payload"
    );
}

#[test]
fn text_is_plain_searchable_content() {
    let build = build(&fixture_root());
    let readme = build.bundle.doc("README.md").expect("README is compiled");

    for expected in [
        "Wikicc Fixture Site",
        "Read the introduction first",
        "Inline code is searchable",
        "fn main() {}",
        "intro 2",
    ] {
        assert!(
            readme.text.contains(expected),
            "missing {expected:?} in text: {}",
            readme.text
        );
    }
    for marker in ["```", "##", "**", "| Document"] {
        assert!(
            !readme.text.contains(marker),
            "text still carries {marker:?}: {}",
            readme.text
        );
    }
}

#[test]
fn outlines_are_embedded_as_nested_trees() {
    let build = build(&fixture_root());
    let intro = build
        .bundle
        .doc("guide/intro.md")
        .expect("intro is compiled");

    assert_eq!(intro.toc.len(), 1);
    assert_eq!(intro.toc[0].text, "Introduction");
    assert_eq!(intro.toc[0].children[0].text, "Getting Started");
    assert_eq!(intro.toc[0].children[0].children[0].text, "Details");
    assert_eq!(intro.toc[0].children[0].children[0].level, 3);
}

#[test]
fn the_fixture_is_strict_clean() {
    let build = build(&fixture_root());

    assert!(
        build.diagnostics.is_empty(),
        "diagnostics: {:?}",
        build.diagnostics
    );
    assert_eq!(build.warning_count(), 0);
}

#[test]
fn unicode_documents_keep_their_ids_links_and_text() {
    let dir = tempfile::tempdir().expect("temp dir");
    write(
        dir.path(),
        "中文/说明.md",
        "# 说明\n\n[其他](其他.md)\n\n正文内容\n",
    );
    write(dir.path(), "中文/其他.md", "# 其他\n\n回[说明](说明.md)\n");

    let build = build(dir.path());

    assert_eq!(ids(&build), ["中文/其他.md", "中文/说明.md"]);
    assert_eq!(
        build.bundle.edges,
        [
            edge("中文/其他.md", "中文/说明.md"),
            edge("中文/说明.md", "中文/其他.md"),
        ],
        "edges are sorted by their UTF-8 bytes, not by locale"
    );
    let intro = build.bundle.doc("中文/说明.md").expect("compiled");
    assert_eq!(intro.text, "说明 其他 正文内容");
    assert!(
        intro
            .html
            .contains("href=\"#/doc/%E4%B8%AD%E6%96%87/%E5%85%B6%E4%BB%96.md\""),
        "html: {}",
        intro.html
    );
    assert!(
        build.bundle.to_json().contains("中文/说明.md"),
        "JSON keeps UTF-8 verbatim instead of escaping it"
    );
}

#[test]
fn unknown_targets_produce_warnings_but_no_edges() {
    let dir = tempfile::tempdir().expect("temp dir");
    write(dir.path(), "a.md", "# A\n\n[gone](missing.md)\n");
    write(dir.path(), "b.md", "# B\n");

    let build = build(dir.path());

    assert!(build.bundle.edges.is_empty());
    assert_eq!(build.warning_count(), 1);
    assert!(
        build.diagnostics[0].message.contains("missing.md"),
        "diagnostics: {:?}",
        build.diagnostics
    );
    assert_eq!(build.bundle.stats.documents, 2);
}

#[test]
fn an_empty_folder_yields_an_empty_payload() {
    let dir = tempfile::tempdir().expect("temp dir");

    let build = build(dir.path());

    assert_eq!(build.bundle.docs, Vec::new());
    assert_eq!(build.bundle.edges, Vec::new());
    assert_eq!(build.bundle.stats, Stats::default());
    assert_eq!(
        build.bundle.to_json(),
        r#"{"title":"Fixture","docs":[],"edges":[],"stats":{"documents":0,"assets":0,"asset_bytes":0}}"#
    );
}

#[test]
fn documents_can_be_looked_up_by_id() {
    let build = build(&fixture_root());

    assert_eq!(
        build
            .bundle
            .doc("guide/setup.md")
            .map(|doc| doc.title.as_str()),
        Some("Setup")
    );
    assert!(build.bundle.doc("guide/missing.md").is_none());
}

#[test]
fn payload_assembly_does_not_touch_the_source_tree() {
    let root = fixture_root();
    let before: Vec<SourceDoc> = scan(&root, &root.join("dist")).expect("scan").docs;

    build(&root);

    let after: Vec<SourceDoc> = scan(&root, &root.join("dist")).expect("scan").docs;
    assert_eq!(before, after);
}
