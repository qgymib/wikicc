//! Integration tests for the resolve stage: link classification and rewriting,
//! path safety and content-addressed assets, all observed through the public
//! library API (`scan` → `LinkContext` → `render_document_with`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use wikicc::markdown::sections_of;
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
///
/// Chapter anchors are collected before any link is resolved, exactly as
/// [`wikicc::site::build_site`] does: a link to a later document's chapter has
/// to be checked against headings that have not been rendered yet.
fn build(root: &Path) -> Site {
    let report = scan(root, &root.join("dist")).expect("scan");
    let mut context = LinkContext::new(
        root.to_path_buf(),
        report.docs.iter().map(|doc| doc.id.clone()),
    );
    for doc in &report.docs {
        context.register_anchors(&doc.id, sections_of(&doc.text));
    }

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
        "href=\"#/doc/guide/intro.md#getting-started\">chapter</a>",
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
    let chapter_line = line_containing(&root, "README.md", "(guide/intro.md#no-such-chapter)");
    let escape_line = line_containing(&root, "README.md", "(../outside.png)");

    assert_eq!(
        warnings(&site.context),
        [
            format!("README.md:{missing_line}: link target not found: 'missing.md'"),
            format!(
                "README.md:{chapter_line}: link target section not found: \
                 'guide/intro.md#no-such-chapter'"
            ),
            format!(
                "README.md:{escape_line}: link target escapes the input directory: '../outside.png'"
            ),
        ]
    );
}

#[test]
fn a_missing_chapter_still_opens_its_document() {
    let site = build(&fixture_root());
    let readme = &site.html["README.md"];

    assert!(
        readme.contains("href=\"#/doc/guide/intro.md\">no such chapter</a>"),
        "the document must stay reachable without the chapter\nhtml: {readme}"
    );
}

#[test]
fn a_missing_chapter_is_marked_so_the_reader_can_report_it() {
    let site = build(&fixture_root());
    let readme = &site.html["README.md"];

    // The route cannot carry the anchor — it addresses no element the document
    // emits — so the authored chapter travels as data instead. Without it the
    // reader sees a perfectly ordinary link and can never say what was asked
    // for, which is exactly the bug this test pins.
    assert!(
        readme.contains(
            "<span hidden class=\"doc-link-missing\" \
             data-wikicc-missing-anchor=\"no-such-chapter\"></span>\
             <a href=\"#/doc/guide/intro.md\">no such chapter</a>"
        ),
        "a broken block reference must be marked\nhtml: {readme}"
    );
    assert!(
        readme.contains(
            "<tr><td>block reference</td><td>\
             <a href=\"#/doc/guide/intro.md#getting-started\">chapter</a>"
        ),
        "a chapter that exists must stay unmarked\nhtml: {readme}"
    );
}

#[test]
fn a_broken_definition_chapter_is_marked_like_an_inline_reference() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path();
    write(root, "guide/intro.md", "# Intro\n");
    write(
        root,
        "source.md",
        "[1]: guide/intro.md#no-such \"A chapter\"\n\nsee [1]\n",
    );

    let site = build(root);
    let html = &site.html["source.md"];

    assert!(
        html.contains(
            "<a href=\"#/doc/guide/intro.md\" class=\"doc-link-missing\" \
             data-wikicc-missing-anchor=\"no-such\">guide/intro.md#no-such</a>"
        ),
        "a definition must be marked exactly like an inline link\nhtml: {html}"
    );
}

#[test]
fn the_authored_chapter_of_a_broken_reference_is_escaped() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path();
    write(root, "b.md", "# B\n");
    // `%22`/`%3C` decode to `"` and `<` before the chapter is checked, so the
    // value the reader is told about is the raw one.
    write(root, "a.md", "[x](b.md#a%22b%26c%3Cd%3E)\n");

    let site = build(root);
    let html = &site.html["a.md"];

    assert!(
        html.contains("data-wikicc-missing-anchor=\"a&quot;b&amp;c&lt;d&gt;\""),
        "the authored chapter cannot break out of the attribute\nhtml: {html}"
    );
    assert!(
        !html.contains("<d>"),
        "the markup must stay escaped\nhtml: {html}"
    );
}

#[test]
fn a_chapter_anchor_is_rewritten_to_the_anchor_the_reader_emits() {
    let site = build(&fixture_root());
    let readme = &site.html["README.md"];

    assert!(
        readme.contains("href=\"#/doc/guide/intro.md#getting-started\">chapter</a>"),
        "`#Getting Started` must address the heading id, not the author's spelling\nhtml: {readme}"
    );
}

#[test]
fn a_numbered_chapter_anchor_is_rewritten_to_its_slug() {
    let site = build(&fixture_root());
    let readme = &site.html["README.md"];

    // `## 2.3 带标点 的标题` renders as `<h2 id="23-带标点-的标题">`, so the
    // route has to name that anchor; the authored text would scroll nowhere.
    assert!(
        readme.contains(
            "href=\"#/doc/guide/outline.md#23-%E5%B8%A6%E6%A0%87%E7%82%B9-%E7%9A%84%E6%A0%87%E9%A2%98\">numbered</a>"
        ),
        "a numbered heading must be addressed by its slug\nhtml: {readme}"
    );
    assert!(
        !readme.contains("outline.md#2.3"),
        "the authored numbering must not survive into the route\nhtml: {readme}"
    );
    assert!(
        !warnings(&site.context)
            .iter()
            .any(|warning| warning.contains("guide/outline.md#2.3")),
        "a chapter that exists must not warn: {:?}",
        warnings(&site.context)
    );
}

#[test]
fn a_route_anchor_matches_an_emitted_heading_id() {
    let site = build(&fixture_root());
    let html = &site.html["guide/outline.md"];

    assert!(
        html.contains("id=\"23-带标点-的标题\""),
        "the fixture heading must keep its slug\nhtml: {html}"
    );
    assert!(
        site.html["README.md"]
            .contains("#23-%E5%B8%A6%E6%A0%87%E7%82%B9-%E7%9A%84%E6%A0%87%E9%A2%98"),
        "the route and the heading id must agree"
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
fn definition_destinations_are_resolved_like_inline_links() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path();
    write(root, "guide/intro.md", "# Intro\n");
    write(root, "img/logo.svg", b"<svg>logo</svg>");
    write(
        root,
        "source.md",
        "# Sources\n\n\
         [1]: guide/intro.md \"A chapter\"\n\
         [2]: img/logo.svg\n\
         [3]: https://example.com/docs\n\
         [4]: missing.md\n",
    );

    let site = build(root);
    let html = &site.html["source.md"];

    assert!(
        html.contains(
            "<span class=\"link-ref-def-label\">[1]:</span> \
             <a href=\"#/doc/guide/intro.md\">guide/intro.md</a> \"A chapter\""
        ),
        "an internal document becomes a route, the text stays as written\nhtml: {html}"
    );
    assert!(
        html.contains(&format!("<a href=\"{ASSET_PLACEHOLDER_PREFIX}"))
            && html.contains(">img/logo.svg</a>"),
        "a local asset becomes a placeholder, the text stays as written\nhtml: {html}"
    );
    assert!(
        html.contains("<a href=\"https://example.com/docs\">https://example.com/docs</a>"),
        "an external destination is untouched\nhtml: {html}"
    );
    assert!(
        html.contains("<a href=\"missing.md\">missing.md</a>"),
        "an unresolvable definition keeps its destination\nhtml: {html}"
    );

    let missing_line = line_containing(root, "source.md", "[4]:");
    assert!(
        warnings(&site.context).contains(&format!(
            "source.md:{missing_line}: link target not found: 'missing.md'"
        )),
        "the warning quotes the definition's own line: {:?}",
        warnings(&site.context)
    );
    assert_eq!(
        site.context.assets().len(),
        1,
        "the asset is registered once"
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
