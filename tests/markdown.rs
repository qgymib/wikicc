//! Integration tests for the Markdown stage: GFM rendering, heading anchors and
//! the nested chapter outline, all observed through the public library API.

use wikicc::markdown::{RenderedDoc, TocEntry, render_document};

/// Flatten an outline into `(level, text)` pairs, depth first.
fn levels_and_texts(entries: &[TocEntry]) -> Vec<(u32, String)> {
    let mut flat = Vec::new();
    for entry in entries {
        flat.push((entry.level, entry.text.clone()));
        flat.extend(levels_and_texts(&entry.children));
    }
    flat
}

/// Anchors in document order, depth first.
fn anchors(entries: &[TocEntry]) -> Vec<String> {
    let mut flat = Vec::new();
    for entry in entries {
        flat.push(entry.id.clone());
        flat.extend(anchors(&entry.children));
    }
    flat
}

/// Anchors of a rendered document.
fn doc_anchors(doc: &RenderedDoc) -> Vec<String> {
    anchors(&doc.toc)
}

#[test]
fn renders_the_supported_gfm_subset() {
    let source = "\
# Guide

| name | value |
| ---- | ----- |
| one  | 1     |

~~removed~~ and a footnote[^a]

- [x] finished
- [ ] outstanding

[^a]: footnote body
";
    let doc = render_document(source);

    assert!(doc.html.contains("<table>"), "html: {}", doc.html);
    assert!(doc.html.contains("<thead>"), "html: {}", doc.html);
    assert!(doc.html.contains("<th"), "html: {}", doc.html);
    assert!(
        doc.html.contains("<del>removed</del>"),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html.contains("class=\"footnote-reference\""),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html.contains("type=\"checkbox\" checked=\"\""),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html.contains("type=\"checkbox\"/"),
        "html: {}",
        doc.html
    );
}

#[test]
fn headings_get_stable_ascii_anchors() {
    let doc = render_document("# Getting Started\n\n## Hello, World!\n");

    assert!(
        doc.html.contains("<h1 id=\"getting-started\">"),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html.contains("<h2 id=\"hello-world\">"),
        "html: {}",
        doc.html
    );
    assert_eq!(doc_anchors(&doc), ["getting-started", "hello-world"]);
}

#[test]
fn cjk_headings_keep_their_characters_in_anchors() {
    let doc = render_document("## 第一章\n\n## 第一章 概述\n");

    assert!(
        doc.html.contains("<h2 id=\"第一章\">"),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html.contains("<h2 id=\"第一章-概述\">"),
        "html: {}",
        doc.html
    );
}

#[test]
fn repeated_headings_get_numbered_anchors() {
    let doc = render_document("## Notes\n\n## Notes\n\n## Notes\n");

    assert_eq!(doc_anchors(&doc), ["notes", "notes-1", "notes-2"]);
}

#[test]
fn outline_follows_document_order_and_nests_by_level() {
    let source = "\
# Top

## Section

### Detail

## Other

# Second
";
    let doc = render_document(source);

    assert_eq!(
        levels_and_texts(&doc.toc),
        [
            (1, "Top".to_string()),
            (2, "Section".to_string()),
            (3, "Detail".to_string()),
            (2, "Other".to_string()),
            (1, "Second".to_string()),
        ]
    );
    assert_eq!(doc.toc.len(), 2, "two roots");
    assert_eq!(doc.toc[0].children.len(), 2, "Section and Other");
    assert_eq!(doc.toc[0].children[0].children[0].text, "Detail");
}

#[test]
fn outline_nests_level_jumps_under_the_last_shallower_heading() {
    let doc = render_document("# Top\n\n### Deep\n");

    assert_eq!(doc.toc.len(), 1);
    assert_eq!(doc.toc[0].children[0].level, 3);
    assert_eq!(doc.toc[0].children[0].text, "Deep");
}

#[test]
fn outline_text_is_plain() {
    let doc = render_document("## **Bold**, `code` and [a link](other.md)\n");

    assert_eq!(doc.toc[0].text, "Bold, code and a link");
    assert_eq!(doc.toc[0].id, "bold-code-and-a-link");
}

#[test]
fn code_fences_never_produce_headings() {
    let doc = render_document("```markdown\n# Not a heading\n```\n");

    assert!(doc.toc.is_empty());
    assert!(!doc.html.contains("<h1"));
}

#[test]
fn document_without_headings_has_an_empty_outline() {
    let doc = render_document("just a paragraph\n");

    assert!(doc.toc.is_empty());
    assert!(doc.html.contains("<p>just a paragraph</p>"));
}

#[test]
fn rendering_the_same_source_twice_is_byte_identical() {
    let source = "# Title\n\n## Notes\n\n## Notes\n\n| a |\n| - |\n| 1 |\n";

    let first = render_document(source);
    let second = render_document(source);

    assert_eq!(first.html, second.html);
    assert_eq!(first.toc, second.toc);
}

#[test]
fn author_written_html_is_passed_through() {
    let doc = render_document("<figure><img src=\"a.png\"></figure>\n");

    assert!(
        doc.html.contains("<figure><img src=\"a.png\"></figure>"),
        "html: {}",
        doc.html
    );
}

/// The code fixture: every fence shape the highlighter has to handle.
const CODE_FIXTURE: &str = include_str!("fixtures/code/code.md");

#[test]
fn known_fences_are_highlighted_in_the_fixture() {
    let doc = render_document(CODE_FIXTURE);

    for language in ["rust", "rs", "js"] {
        let opening = format!("<pre class=\"code\"><code class=\"language-{language}\">");
        assert!(
            doc.html.contains(&opening),
            "missing {opening}\nhtml: {}",
            doc.html
        );
    }
    assert!(doc.html.contains("<span class=\""), "html: {}", doc.html);
    assert!(doc.html.contains("println!"), "html: {}", doc.html);
}

#[test]
fn unknown_and_unlabelled_fences_stay_plain_text() {
    let doc = render_document(CODE_FIXTURE);

    assert!(
        doc.html
            .contains("<code class=\"language-foo\">a &lt; b &amp;&amp; c &gt; d"),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html.contains("<pre class=\"code\"><code>plain text"),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html
            .contains("<pre class=\"code\"><code>indented &lt; code &gt;"),
        "html: {}",
        doc.html
    );
}

#[test]
fn the_mermaid_fence_is_a_diagram_not_a_code_block() {
    let doc = render_document(CODE_FIXTURE);

    assert!(
        doc.html
            .contains("<pre class=\"mermaid\">graph TD; A--&gt;B;\n</pre>"),
        "html: {}",
        doc.html
    );
    assert!(
        !doc.html.contains("language-mermaid"),
        "a diagram must not be highlighted: {}",
        doc.html
    );
}

#[test]
fn every_fixture_fence_survives_rendering() {
    let doc = render_document(CODE_FIXTURE);

    assert_eq!(
        doc.html.matches("<pre class=\"code\">").count(),
        6,
        "the fixture has seven fences, one of which is a diagram"
    );
    assert_eq!(doc.html.matches("<pre class=\"mermaid\">").count(), 1);
    assert!(!doc.html.contains("```"), "html: {}", doc.html);
}

#[test]
fn fixture_rendering_is_byte_identical_twice() {
    assert_eq!(
        render_document(CODE_FIXTURE).html,
        render_document(CODE_FIXTURE).html
    );
}

#[test]
fn highlight_css_is_available_to_the_shell() {
    let css = wikicc::theme_css();

    assert!(css.contains(".code {"), "css: {css}");
    assert_eq!(css, wikicc::theme_css(), "the CSS must come from the cache");
    assert_eq!(wikicc::THEME_NAME, "base16-ocean.dark");
}
