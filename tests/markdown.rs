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

/// Body plus the reference definitions a `[[n]][n]` citation points at.
fn cited(body: &str) -> String {
    format!("{body}\n\n[1]: https://example.com/1\n[2]: https://example.com/2\n")
}

#[test]
fn a_bracketed_citation_renders_as_one_link_like_typora() {
    let doc = render_document(&cited("散射机理[[1]][1]"));

    assert_eq!(
        doc.html,
        "<p>散射机理<a href=\"https://example.com/1\">[1]</a></p>\n\
         <p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
         <a href=\"https://example.com/1\">https://example.com/1</a></p>\n\
         <p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[2]:</span> \
         <a href=\"https://example.com/2\">https://example.com/2</a></p>\n",
        "html: {}",
        doc.html
    );
    assert_eq!(
        doc.text, "散射机理[1] [1]: https://example.com/1 [2]: https://example.com/2",
        "text: {}",
        doc.text
    );
}

#[test]
fn a_bracketed_citation_collapses_inside_a_table_cell() {
    let doc = render_document(&cited(
        "| 技术 | 引用 |\n| ---- | ---- |\n| 光纤 | 散射[[1]][1] |",
    ));

    assert!(
        doc.html
            .contains("<td>散射<a href=\"https://example.com/1\">[1]</a></td>"),
        "html: {}",
        doc.html
    );
    assert_eq!(
        doc.html.matches("<a ").count(),
        3,
        "one table link plus one per definition: {}",
        doc.html
    );
}

/// The "参考链接" section a Typora user writes: a heading followed by the
/// reference list, with the definitions ending the document.
const REFERENCE_LIST: &str = "\
### 参考链接

[1]: https://books.gw-project.org/distributed-fiber-optic-hydrogeophysics/chapter/strain-and-strain-rate-measurement-distributed-acoustic-sensing-das/ \"The Groundwater Project：Distributed Fiber-Optic Hydrogeophysics — 瑞利、布里渊、拉曼散射机理与 DAS 应变测量\"
[2]: https://opg.optica.org/abstract.cfm?&uri=oe-20-8-8584 \"Peled, Motil, Tur：Fast Brillouin optical time domain analysis for dynamic sensing，Optics Express 20(8), 2012\"
[3]: https://gdxt.semi.ac.cn/contents/308/3351.html \"中国科学院半导体研究所光电系统实验室：分布式光纤声传感系统（DAS）\"
";

#[test]
fn a_reference_list_renders_under_its_heading_like_typora() {
    let doc = render_document(REFERENCE_LIST);

    assert!(
        doc.html.starts_with("<h3 id=\"参考链接\">参考链接</h3>\n"),
        "html: {}",
        doc.html
    );
    assert_eq!(
        doc.html.matches("<p class=\"link-ref-def\">").count(),
        3,
        "every definition must be visible: {}",
        doc.html
    );
    for expected in [
        "[1]:</span> <a href=\"https://books.gw-project.org/distributed\
-fiber-optic-hydrogeophysics/chapter/strain-and-strain-rate-measurement\
-distributed-acoustic-sensing-das/\">https://books.gw-project.org/distributed\
-fiber-optic-hydrogeophysics/chapter/strain-and-strain-rate-measurement\
-distributed-acoustic-sensing-das/</a> \"The Groundwater Project：Distributed \
Fiber-Optic Hydrogeophysics — 瑞利、布里渊、拉曼散射机理与 DAS 应变测量\"",
        "[2]:</span> <a href=\"https://opg.optica.org/abstract.cfm?&amp;uri=oe-20-8-8584\">\
https://opg.optica.org/abstract.cfm?&amp;uri=oe-20-8-8584</a> \"Peled, Motil, Tur：\
Fast Brillouin optical time domain analysis for dynamic sensing，Optics Express 20(8), 2012\"",
        "[3]:</span> <a href=\"https://gdxt.semi.ac.cn/contents/308/3351.html\">\
https://gdxt.semi.ac.cn/contents/308/3351.html</a> \"中国科学院半导体研究所光电系统实验室：\
分布式光纤声传感系统（DAS）\"",
    ] {
        assert!(
            doc.html.contains(expected),
            "missing {expected:?}\nhtml: {}",
            doc.html
        );
    }
    assert!(
        doc.text.contains("中国科学院半导体研究所光电系统实验室"),
        "the entries must be searchable: {}",
        doc.text
    );
}

#[test]
fn a_reference_list_is_rendered_deterministically() {
    assert_eq!(
        render_document(REFERENCE_LIST).html,
        render_document(REFERENCE_LIST).html
    );
}

#[test]
fn a_bracketed_citation_in_a_heading_feeds_the_outline() {
    let doc = render_document(&cited("## 参考 [[1]][1]"));

    assert!(
        doc.html
            .contains("<h2 id=\"参考-1\">参考 <a href=\"https://example.com/1\">[1]</a>"),
        "html: {}",
        doc.html
    );
    assert_eq!(doc.toc[0].text, "参考 [1]");
}

#[test]
fn adjacent_identical_links_are_not_collapsed() {
    let doc = render_document("[1](https://example.com)[1](https://example.com)\n");

    assert_eq!(
        doc.html.matches("<a ").count(),
        2,
        "only the bracketed citation is normalised: {}",
        doc.html
    );
}

#[test]
fn an_undefined_citation_stays_verbatim() {
    let doc = render_document("散射[[1]][1]\n");

    assert!(doc.html.contains("散射[[1]][1]"), "html: {}", doc.html);
}

/// Back-to-back runs degrade the first run's duplicate into separator text
/// (`[[1]][1][[2]][2]` — CommonMark never makes a shortcut out of a `[n]`
/// followed by the next idiom's `[`), which used to leave the first citation
/// rendered twice. Every run must still fold to its one visible link.
#[test]
fn adjacent_bracketed_citations_each_render_as_one_link() {
    let doc = render_document(&cited("散射机理[[1]][1][[2]][2]"));

    assert_eq!(
        doc.html,
        "<p>散射机理<a href=\"https://example.com/1\">[1]</a>\
         <a href=\"https://example.com/2\">[2]</a></p>\n\
         <p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
         <a href=\"https://example.com/1\">https://example.com/1</a></p>\n\
         <p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[2]:</span> \
         <a href=\"https://example.com/2\">https://example.com/2</a></p>\n",
        "html: {}",
        doc.html
    );
}

#[test]
fn adjacent_bracketed_citations_collapse_inside_a_table_cell() {
    let doc = render_document(&cited(
        "| 技术 | 引用 |\n| ---- | ---- |\n| 光纤 | 散射[[1]][1][[2]][2] |",
    ));

    assert!(
        doc.html.contains(
            "<td>散射<a href=\"https://example.com/1\">[1]</a>\
             <a href=\"https://example.com/2\">[2]</a></td>"
        ),
        "html: {}",
        doc.html
    );
    assert_eq!(
        doc.html.matches("<a ").count(),
        4,
        "two folded citations plus one link per definition: {}",
        doc.html
    );
}

#[test]
fn an_adjacent_undefined_citation_run_stays_verbatim() {
    let doc = render_document("散射机理[[1]][1][[2]][2]\n");

    assert!(
        doc.html.contains("散射机理[[1]][1][[2]][2]"),
        "html: {}",
        doc.html
    );
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

// BUG-2026-11-04 acceptance construction: a citation-dense document whose
// reference links must all resolve. Some engines cap the total size of
// resolved reference links with an anti-DoS budget charged per successful
// resolution, so with long definition titles the budget runs out part way
// through and every further citation silently degrades to literal
// `[[n]][n]` text. The construction below is fully synthetic English
// filler; it must stay that way.

/// Number of link reference definitions; every id is cited exactly twice.
const DENSE_REFERENCES: usize = 300;

/// Byte length of each definition title (inside the quotes).
const DENSE_TITLE_BYTES: usize = 280;

/// Table rows; each row carries two citations, covering the first half of
/// the ids. The second half is cited by the paragraphs.
const DENSE_TABLE_ROWS: usize = DENSE_REFERENCES / 2;

/// The dense-citation document: 150 four-column table rows with two
/// citations per row, 300 one-line paragraphs with one citation each, and
/// 300 definitions with ~280-byte titles, in the reference-list layout a
/// citation-heavy author writes.
fn dense_citation_document() -> String {
    let mut source = String::new();
    source.push_str("| Reference | Source | Venue | Note |\n");
    source.push_str("| --- | --- | --- | --- |\n");
    for row in 1..=DENSE_TABLE_ROWS {
        let first = 2 * row - 1;
        let second = 2 * row;
        source.push_str(&format!(
            "| Row {row} cites [[{first}]][{first}] | then [[{second}]][{second}] | filler | filler |\n"
        ));
    }
    source.push('\n');
    for id in 1..=DENSE_REFERENCES {
        source.push_str(&format!("Paragraph {id} cites [[{id}]][{id}] once.\n\n"));
    }
    for id in 1..=DENSE_REFERENCES {
        let head = format!("Dense citation reference {id} for the regression corpus. ");
        let title = format!("{head}{}", "R".repeat(DENSE_TITLE_BYTES - head.len()));
        source.push_str(&format!(
            "[{id}]: https://example.com/ref/{id} \"{title}\"\n"
        ));
    }
    source
}

#[test]
fn the_dense_citation_construction_matches_the_incident_shape() {
    let source = dense_citation_document();

    // Two resolutions per citation, one link per resolution, plus nothing
    // else: the whole point of the construction is volume.
    assert_eq!(source.matches("[[").count(), 600, "600 citations");
    assert_eq!(
        source.matches("]: https://example.com/ref/").count(),
        300,
        "300 definitions"
    );
    assert!(
        (110_000..140_000).contains(&source.len()),
        "the document must stay in the budget-busting size class: {}",
        source.len()
    );
}

/// The engine-level acceptance bar: every `[[n]][n]` citation resolves both
/// of its reference links, nothing degrades to literal text, and a citation
/// inside a table cell carries the definition's title attribute — proving
/// resolution went through the reference map. The engine view renders the
/// reference definitions in place like the reader does, so the count is the
/// 1 200 citation links plus one link per rendered definition.
#[test]
fn dense_citations_resolve_every_reference_at_engine_level() {
    let html = wikicc::render_engine_html(&dense_citation_document());

    assert_eq!(
        html.matches("<a href").count(),
        1200 + 300,
        "two links per citation, every citation resolved, every definition in place"
    );
    assert!(
        !html.contains("[["),
        "no citation may degrade to literal bracketed text"
    );
    assert!(
        html.contains("<a href=\"https://example.com/ref/1\" title=\""),
        "a resolved citation must carry the definition's title"
    );
}

/// The reader-level acceptance bar: with the product's citation folding on,
/// every `[[n]][n]` collapses to its one visible link and every definition
/// renders in place, with no literal brackets surviving anywhere.
#[test]
fn dense_citations_resolve_every_reference_in_the_reader() {
    let doc = render_document(&dense_citation_document());

    assert_eq!(
        doc.html.matches("<a href").count(),
        600 + DENSE_REFERENCES,
        "one folded link per citation plus one per rendered definition"
    );
    assert_eq!(
        doc.html.matches("<p class=\"link-ref-def\">").count(),
        DENSE_REFERENCES,
        "every definition must render in place"
    );
    assert!(
        !doc.html.contains("[["),
        "no citation may degrade to literal bracketed text: {}",
        doc.html.matches("[[").count()
    );
}

/// Reader-reported defect, desensitised: a destination written with spaces
/// (`家常菜谱 图解：红烧肉篇.assets/步骤图.png` — an attachment-folder idiom
/// with spaces, CJK and a fullwidth colon) is not valid CommonMark, so the
/// engine used to keep the whole `![...](...)` run as literal text and the
/// reader showed the raw markup instead of the image, with no build warning.
/// The lenient transform claims those runs; this pins the rendered shape,
/// while `tests/links.rs` pins the resolve-stage side and the unit tests of
/// `src/markdown/transform/lenient.rs` pin the claim boundaries.
#[test]
fn a_destination_with_spaces_renders_as_its_element() {
    let doc = render_document(
        "# 示例\n\n\
         ![示例](家常菜谱 图解：红烧肉篇.assets/步骤图.png)\n\n\
         see [说明](说明 文档.md) and ![缺失](家常菜谱 图解：红烧肉篇.assets/不存在的图.png)\n",
    );

    assert!(
        doc.html
            .contains("<img src=\"家常菜谱 图解：红烧肉篇.assets/步骤图.png\" alt=\"示例\" />"),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html.contains("<a href=\"说明 文档.md\">说明</a>"),
        "html: {}",
        doc.html
    );
    assert!(
        doc.html
            .contains("<img src=\"家常菜谱 图解：红烧肉篇.assets/不存在的图.png\" alt=\"缺失\" />"),
        "an unresolvable destination still renders as an image element\nhtml: {}",
        doc.html
    );
    assert!(
        !doc.html.contains("!["),
        "no raw markup may survive into the body: {}",
        doc.html
    );
    assert_eq!(doc.text, "示例 示例 see 说明 and 缺失");
}
