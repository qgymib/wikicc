//! End-to-end regression for the block reference that stopped previewing.
//!
//! The reported document links to a numbered CJK chapter of another document:
//!
//! ```text
//! [测试](<./笔记/旅行清单.md#1.4 配色与字体>)
//! ```
//!
//! while that document carries `### 1.4 配色与字体`. The chapter exists,
//! so the reference has to become a route to the anchor the document really
//! emits (`14-配色与字体`), the payload has to carry a block with exactly
//! that id, and nothing may be marked as a broken reference — otherwise the
//! reader opens a notice instead of a preview.
//!
//! The hover itself was broken in the view layer, not here: `preview-view.js`
//! built its icon `<path>` elements through the parent `<svg>`, and a real
//! `SVGElement` has no `createElementNS`, so building the panel threw and the
//! preview never appeared. That defect is covered by
//! `tests/js/preview-view.test.js`; this file pins down the build side of the
//! same scenario, so a regression on either half is caught.

use std::path::Path;

use wikicc::scan::scan;
use wikicc::site::{SiteBuild, build_site};

/// Document the reference is written in.
const SOURCE_ID: &str = "书架.md";

/// Document the reference points at.
const TARGET_ID: &str = "笔记/旅行清单.md";

/// The chapter as the author spelled it.
const AUTHORED_CHAPTER: &str = "1.4 配色与字体";

/// The anchor the renderer emits for that chapter.
const EMITTED_ANCHOR: &str = "14-配色与字体";

/// Write one document into the temporary site.
fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent directory");
    }
    std::fs::write(path, contents).expect("write fixture file");
}

/// Build the site the report describes, then hand it back with its root.
fn reported_site() -> (tempfile::TempDir, SiteBuild) {
    let dir = tempfile::tempdir().expect("temp dir");

    write(
        dir.path(),
        SOURCE_ID,
        "# 随手记 书架\n\n\
         | 能力 | 说明 |\n\
         | --- | --- |\n\
         | 旅行清单 | 还没读完 |\n\n\
         [测试](<./笔记/旅行清单.md#1.4 配色与字体>)\n",
    );
    write(
        dir.path(),
        TARGET_ID,
        "# 旅行清单\n\n\
         ## 1. 出行准备\n\n\
         还没读完。\n\n\
         ### 1.4 配色与字体\n\n\
         出发前先看了天气。\n\n\
         #### 1.4.1 字体大小\n\n\
         第二天去了旧书店。\n",
    );

    let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");
    let build = build_site("随手记", dir.path(), &report.docs);

    (dir, build)
}

/// The one block reference in the source document, as rendered.
fn block_reference(build: &SiteBuild) -> String {
    let source = build.bundle.doc(SOURCE_ID).expect("the source is compiled");
    let start = source
        .html
        .find("<a href=\"#/doc/")
        .unwrap_or_else(|| panic!("no document link in: {}", source.html));
    let end = source.html[start..].find("</a>").expect("link end") + start;

    source.html[start..end].to_string()
}

#[test]
fn the_reported_reference_addresses_the_anchor_its_document_emits() {
    let (_dir, build) = reported_site();
    let reference = block_reference(&build);
    let href = href_of(&reference);

    // The route is percent-encoded on the wire; what matters is that decoding
    // it yields the document and the anchor the payload actually emits.
    let body = href.strip_prefix("#/doc/").expect("a document route");
    let mut parts = body.split('#');
    let id = wikicc::markdown::links::percent_decode(parts.next().expect("a document id"));
    let anchor = wikicc::markdown::links::percent_decode(parts.next().expect("a chapter anchor"));

    assert_eq!(
        id, TARGET_ID,
        "the reference must address the target document"
    );
    assert_eq!(
        anchor, EMITTED_ANCHOR,
        "the reference must route to the anchor the document emits, got: {reference}"
    );
    assert!(
        !anchor.contains(AUTHORED_CHAPTER),
        "the author's spelling is not an element id, got: {anchor}"
    );
}

#[test]
fn the_reported_reference_is_not_marked_as_broken() {
    let (_dir, build) = reported_site();
    let source = build.bundle.doc(SOURCE_ID).expect("the source is compiled");

    assert!(
        !source.html.contains("data-wikicc-missing-anchor"),
        "a chapter that exists must not be marked broken: {}",
        source.html
    );
    assert!(
        !source.html.contains("doc-link-missing"),
        "no broken-reference class either: {}",
        source.html
    );
    assert!(
        build.diagnostics.is_empty(),
        "the reported site is clean: {:?}",
        build.diagnostics
    );
}

#[test]
fn the_target_document_carries_the_block_the_preview_reads() {
    let (_dir, build) = reported_site();
    let target = build.bundle.doc(TARGET_ID).expect("the target is compiled");

    let block = target
        .blocks
        .iter()
        .find(|block| block.id == EMITTED_ANCHOR)
        .unwrap_or_else(|| {
            panic!(
                "no block anchored {EMITTED_ANCHOR}, blocks: {:?}",
                target
                    .blocks
                    .iter()
                    .map(|block| block.id.as_str())
                    .collect::<Vec<_>>()
            )
        });

    assert!(
        !block.subtree.is_empty(),
        "a previewable chapter has at least one block"
    );
    assert!(
        block.html.contains(&format!("id=\"{EMITTED_ANCHOR}\"")),
        "the block starts at its own heading: {}",
        block.html
    );
    assert!(
        block.html.contains("出发前先看了天气"),
        "the block carries the chapter's own text: {}",
        block.html
    );
}

#[test]
fn previewing_the_reported_chapter_shows_its_own_chapter_only() {
    let (_dir, build) = reported_site();
    let target = build.bundle.doc(TARGET_ID).expect("the target is compiled");

    let index = target
        .blocks
        .iter()
        .position(|block| block.id == EMITTED_ANCHOR)
        .expect("the chapter has a block");
    let chapter: String = target.blocks[index]
        .subtree
        .iter()
        .map(|&nested| target.blocks[nested].html.as_str())
        .collect();

    assert!(
        chapter.contains(&format!("id=\"{EMITTED_ANCHOR}\"")),
        "the preview opens with the chapter heading: {chapter}"
    );
    assert!(
        chapter.contains("第二天去了旧书店"),
        "a nested chapter belongs to the preview: {chapter}"
    );
    assert!(
        !chapter.contains("还没读完"),
        "the parent chapter is not part of the preview: {chapter}"
    );
    assert!(
        !chapter.contains("id=\"1-出行准备\""),
        "no ancestor heading leaks into the preview: {chapter}"
    );
}

/// The `href` of a rendered link element.
fn href_of(reference: &str) -> &str {
    reference
        .split("href=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("an href")
}

/// The route the reference emits, decoded the way the reader decodes it.
///
/// Kept as its own helper so the assertion quotes what a browser sees rather
/// than the percent-encoded string the build writes.
fn route_anchor(build: &SiteBuild) -> String {
    let reference = block_reference(build);
    let anchor = href_of(&reference)
        .split('#')
        .nth(2)
        .expect("a route anchor");

    wikicc::markdown::links::percent_decode(anchor)
}

#[test]
fn the_route_anchor_survives_percent_decoding_as_the_block_id() {
    let (_dir, build) = reported_site();

    assert_eq!(
        route_anchor(&build),
        EMITTED_ANCHOR,
        "the reader compares the decoded anchor with the block id"
    );
}

/// The rendered page for the reported site, for the checks that need the shell.
fn page_of(build: &SiteBuild) -> String {
    wikicc::render_site(&build.bundle)
        .expect("the shell renders")
        .html
}

#[test]
fn the_page_carries_the_preview_machinery_the_reader_needs() {
    let (_dir, build) = reported_site();
    let page = page_of(&build);

    for marker in [
        "preview-popover",
        "preview-scroll",
        "data-wikicc-doc-link",
        "http://www.w3.org/2000/svg",
    ] {
        assert!(page.contains(marker), "the page is missing {marker}");
    }
}
