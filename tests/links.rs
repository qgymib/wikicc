//! Integration tests for the resolve stage: link classification and rewriting,
//! path safety and content-addressed assets, all observed through the public
//! library API (`scan` → `LinkContext` → `render_document_with`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use wikicc::scan::scan;
use wikicc::{ASSET_PLACEHOLDER_PREFIX, LinkContext, Severity, render_document_with};

/// The committed link-matrix site.
fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("links")
}

fn write(root: &Path, relative: &str, contents: impl AsRef<[u8]>) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent directory");
    }
    std::fs::write(path, contents).expect("write fixture file");
}

/// A compiled site: rendered HTML per document id plus the resolver state.
struct Site {
    html: BTreeMap<String, String>,
    context: LinkContext,
}

/// Run the scan and resolve stages over `root`.
fn build(root: &Path) -> Site {
    let report = scan(root, &root.join("dist")).expect("scan");
    let mut context = LinkContext::new(
        root.to_path_buf(),
        report.docs.iter().map(|doc| doc.id.clone()),
    );
    let mut html = BTreeMap::new();

    for doc in &report.docs {
        let mut resolver = context.for_doc(&doc.id);
        let rendered = render_document_with(&doc.text, &mut resolver);
        html.insert(doc.id.clone(), rendered.html);
    }

    Site { html, context }
}

fn warnings(context: &LinkContext) -> Vec<String> {
    context
        .diagnostics()
        .iter()
        .filter(|diagnostic| diagnostic.severity == Severity::Warning)
        .map(|diagnostic| diagnostic.message.clone())
        .collect()
}

/// 1-based line of the first line of `id` that contains `needle`.
fn line_containing(root: &Path, id: &str, needle: &str) -> usize {
    let text = std::fs::read_to_string(root.join(id)).expect("read fixture document");
    text.lines()
        .position(|line| line.contains(needle))
        .map(|index| index + 1)
        .unwrap_or_else(|| panic!("fixture '{id}' has no line containing '{needle}'"))
}

#[test]
fn the_link_matrix_rewrites_each_destination_kind() {
    let site = build(&fixture_root());
    let readme = &site.html["README.md"];

    for expected in [
        "href=\"#/doc/guide/intro.md\"",
        "href=\"#/doc/guide/intro.md#getting-started\"",
        "href=\"#link-matrix\"",
        "href=\"https://example.com/docs\"",
        "href=\"//cdn.example.com/app.js\"",
        "href=\"mailto:docs@example.com\"",
        "href=\"#/doc/guide/my%20notes.md\"",
    ] {
        assert!(
            readme.contains(expected),
            "missing {expected}\nhtml: {readme}"
        );
    }

    assert!(
        readme.contains(&format!("src=\"{ASSET_PLACEHOLDER_PREFIX}")),
        "the asset must be addressed by content hash\nhtml: {readme}"
    );
    assert!(
        !readme.contains("assets/logo.svg"),
        "the author path must not survive into the HTML\nhtml: {readme}"
    );
}

#[test]
fn unresolvable_targets_keep_their_destination() {
    let site = build(&fixture_root());
    let readme = &site.html["README.md"];

    assert!(
        readme.contains("href=\"missing.md\""),
        "an unknown document stays as written\nhtml: {readme}"
    );
    assert!(
        readme.contains("src=\"../outside.png\""),
        "an escaping asset stays as written\nhtml: {readme}"
    );
}

#[test]
fn duplicate_references_share_one_asset() {
    let site = build(&fixture_root());

    assert_eq!(site.context.assets().len(), 1, "one unique asset");
    let (_, asset) = site.context.assets().iter().next().expect("one asset");
    assert_eq!(asset.mime, "image/svg+xml");
    assert_eq!(asset.extension, "svg");

    let placeholder = format!("{ASSET_PLACEHOLDER_PREFIX}{}", asset.hash);
    assert_eq!(
        site.html["README.md"]
            .matches(&format!("src=\"{placeholder}\""))
            .count(),
        2,
        "both references point at the same asset"
    );
}

#[test]
fn missing_and_escaping_targets_are_reported_with_document_and_line() {
    let root = fixture_root();
    let site = build(&root);
    let missing_line = line_containing(&root, "README.md", "(missing.md)");
    let escape_line = line_containing(&root, "README.md", "(../outside.png)");

    assert_eq!(
        warnings(&site.context),
        [
            format!("README.md:{missing_line}: link target not found: 'missing.md'"),
            format!(
                "README.md:{escape_line}: link target escapes the input directory: '../outside.png'"
            ),
        ]
    );
}

#[test]
fn links_resolve_against_the_document_directory() {
    let site = build(&fixture_root());
    let intro = &site.html["guide/intro.md"];

    assert!(
        intro.contains("href=\"#/doc/README.md\""),
        "`../README.md` must resolve from `guide/`\nhtml: {intro}"
    );
    assert!(
        intro.contains("href=\"#/doc/guide/deep/detail.md\""),
        "`deep/detail.md` must resolve from `guide/`\nhtml: {intro}"
    );
}

#[test]
fn compiling_the_same_site_twice_is_identical() {
    let root = fixture_root();
    let first = build(&root);
    let second = build(&root);

    assert_eq!(first.html, second.html);
    assert_eq!(first.context.assets(), second.context.assets());
    assert_eq!(warnings(&first.context), warnings(&second.context));
}

#[test]
fn escaping_paths_produce_a_warning_and_no_asset() {
    let dir = tempfile::tempdir().expect("temp dir");
    write(dir.path(), "outside.png", b"\x89PNG\r\n\x1a\n");
    write(dir.path(), "guide/a.md", "![x](../../outside.png)\n");

    let site = build(dir.path());

    assert!(site.context.assets().is_empty(), "nothing may be read");
    assert_eq!(
        warnings(&site.context),
        [
            "guide/a.md:1: link target escapes the input directory: '../../outside.png'"
                .to_string()
        ]
    );
    assert!(site.html["guide/a.md"].contains("src=\"../../outside.png\""));
}

#[test]
fn binary_assets_keep_their_bytes_and_mime_type() {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let dir = tempfile::tempdir().expect("temp dir");
    write(dir.path(), "img/pixel.png", PNG);
    write(dir.path(), "a.md", "![pixel](img/pixel.png)\n");

    let site = build(dir.path());
    let (_, asset) = site.context.assets().iter().next().expect("one asset");

    assert_eq!(asset.bytes, PNG);
    assert_eq!(asset.mime, "image/png");
    assert_eq!(asset.extension, "png");
    assert!(site.html["a.md"].contains(&format!("src=\"{}\"", asset.placeholder())));
}

#[test]
fn cjk_documents_and_assets_are_addressed_correctly() {
    let dir = tempfile::tempdir().expect("temp dir");
    write(dir.path(), "中文/说明.md", "# 说明\n\n## 概述\n");
    write(dir.path(), "中文/图 片.svg", b"<svg/>");
    write(
        dir.path(),
        "index.md",
        "[说明](中文/说明.md#概述) ![图](<中文/图 片.svg>)\n",
    );

    let site = build(dir.path());
    let index = &site.html["index.md"];

    assert!(
        index
            .contains("href=\"#/doc/%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md#%E6%A6%82%E8%BF%B0\""),
        "html: {index}"
    );
    assert!(
        index.contains(&format!("src=\"{ASSET_PLACEHOLDER_PREFIX}")),
        "html: {index}"
    );
    assert_eq!(site.context.assets().len(), 1);
    assert!(
        warnings(&site.context).is_empty(),
        "{:?}",
        warnings(&site.context)
    );
}

#[test]
fn a_document_without_links_produces_no_diagnostics() {
    let dir = tempfile::tempdir().expect("temp dir");
    write(dir.path(), "plain.md", "# Plain\n\nNo links here.\n");

    let site = build(dir.path());

    assert!(site.context.assets().is_empty());
    assert!(site.context.diagnostics().is_empty());
    assert_eq!(
        site.html["plain.md"],
        "<h1 id=\"plain\">Plain</h1>\n<p>No links here.</p>\n"
    );
}
