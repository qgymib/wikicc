//! Markdown rendering: GFM HTML with stable anchors and a chapter outline.
//!
//! Parsing runs once per document with `markdown-rs` ([`parse`]), the tree
//! is converted into the own-layer model ([`ast`]), and the own-layer
//! transforms run in the order the engine decision fixed:
//!
//! 1. [`transform::fold`] collapses the Typora citation idiom `[[n]][n]`
//!    into the single link `[n]`,
//! 2. [`transform::wikilink`] claims the Obsidian `[[wikilink]]`,
//!    `[[wikilink|alias]]` and `![[embed]]` runs the fold left behind,
//! 3. [`transform::inline`] claims the Typora sugar (`==highlight==`,
//!    `~subscript~`, `^superscript^`, `%%comments%%`, `#tags`,
//!    `:shortcodes:`),
//! 4. [`transform::lenient`] claims the spaced inline destinations
//!    (`![alt](a b.png)`) CommonMark declines,
//! 5. [`transform::callout`] rewrites Obsidian callout block quotes.
//!
//! Everything after that is one serialisation pass ([`html`]): the body
//! HTML, the plain text the front end searches, the heading anchors and the
//! chapter blocks all come out of the same walk, so they always describe
//! exactly the same source. Link and image destinations are rewritten
//! structurally during that walk through [`LinkRewriter`], never on
//! serialised HTML, so attribute quoting and nesting cannot be corrupted.
//!
//! Reference definitions render where the author wrote them: the tree keeps
//! every [`OwnKind::Definition`] at its source position, and the serialiser
//! shows the first definition of every label as one paragraph, resolved
//! through the same rewriter as an inline link.
//!
//! One authoring idiom is normalised on the tree: Typora users wrap a
//! numbered citation in a second pair of brackets, writing `[[1]][1]` for a
//! citation whose definition block is `[1]: https://…`. The fold collapses
//! that into the single link Typora displays. The Obsidian wikilink shares
//! the `[[` opening, so the fold runs first and the wikilink pass takes
//! only the remainder — a target that sits in the reference table is a
//! citation display, never a wikilink.

pub mod highlight;
pub mod links;
pub mod sections;
pub mod slug;
pub mod toc;

pub(crate) mod ast;
pub(crate) mod html;
pub(crate) mod parse;
pub(crate) mod refdefs;
pub(crate) mod transform;

use std::collections::BTreeMap;

use ast::{OwnKind, OwnNode};
use sections::Block;
use toc::Heading;

pub use links::{LinkClass, LinkContext, LinkResolver, classify};
pub use sections::Block as ChapterBlock;
pub use slug::{FALLBACK_SLUG, Slugger, slugify};
pub use toc::{HeadingText, TocEntry, build_toc, collapse_whitespace};

/// Class of a link whose block-reference chapter the target document lacks.
///
/// The stylesheet uses it to mark the link in the document itself, so a
/// broken reference is visible before it is ever hovered or clicked.
pub const MISSING_LINK_CLASS: &str = "doc-link-missing";

/// Attribute carrying the chapter a broken block reference named.
///
/// The route cannot carry it, because no element of the target document
/// emits that anchor; the reader reads the attribute instead and reports
/// it. Must stay in step with `MISSING_ANCHOR_ATTRIBUTE` in
/// `src/web/js/links.js`.
pub const MISSING_ANCHOR_ATTRIBUTE: &str = "data-wikicc-missing-anchor";

/// Opening-tag attributes for a link whose chapter does not exist.
///
/// Built from escaped parts, so the authored chapter cannot terminate the
/// attribute it is written into.
pub(crate) fn missing_link_attributes(anchor: &str) -> String {
    let mut attributes = String::with_capacity(anchor.len() + 64);
    attributes.push_str(" class=\"");
    attributes.push_str(MISSING_LINK_CLASS);
    attributes.push_str("\" ");
    attributes.push_str(MISSING_ANCHOR_ATTRIBUTE);
    attributes.push_str("=\"");
    highlight::escape_into(&mut attributes, anchor);
    attributes.push('"');
    attributes
}

/// Result of rendering one document.
///
/// `html`, `toc` and `text` come from the same parse and the same
/// serialisation walk, so a document is never parsed twice: the HTML is
/// what the reader shows, the outline is what the right column lists and
/// `text` is what the search index matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedDoc {
    /// Body HTML, with an `id` attribute on every heading.
    pub html: String,
    /// Chapter outline in document order, nested by heading level.
    pub toc: Vec<TocEntry>,
    /// Body HTML split into one block per heading, in document order.
    ///
    /// A block holds its heading and its own content up to the next
    /// heading, plus its place in the outline, so a block reference can read
    /// a whole chapter — itself and everything nested under it — without a
    /// second parse and without repeating any markup.
    pub blocks: Vec<Block>,
    /// Plain text of the document: every text and code run, with block
    /// boundaries turned into single spaces and whitespace collapsed.
    pub text: String,
}

/// Final addressing form of one destination, as the build decides it.
///
/// Most destinations only need a string, but a block reference can name a
/// chapter its target document does not have: the route then cannot carry
/// the anchor — no element emits it — yet the reader is expected to say
/// *which* chapter was asked for. The authored spelling therefore travels
/// beside the route, and the serialiser turns it into the attributes the
/// reader looks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTarget {
    /// Destination written into the `href` or `src`.
    pub dest: String,
    /// Chapter the author named when the target document has no such
    /// chapter.
    ///
    /// `Some` is the authored spelling, kept verbatim so the message quotes
    /// the line the author has to fix. Only a chapter mismatch ever sets it.
    pub missing_anchor: Option<String>,
}

impl LinkTarget {
    /// A destination that addresses exactly what was asked for.
    pub fn new(dest: impl Into<String>) -> Self {
        Self {
            dest: dest.into(),
            missing_anchor: None,
        }
    }

    /// This destination, plus the chapter that could not be resolved.
    pub fn missing_chapter(dest: impl Into<String>, anchor: impl Into<String>) -> Self {
        Self {
            dest: dest.into(),
            missing_anchor: Some(anchor.into()),
        }
    }
}

/// Rewrites link and image destinations while a document is rendered.
///
/// The serialiser calls this for every link, image and reference
/// destination it meets, in document order and before any HTML exists, so a
/// destination can be replaced without touching attribute quoting. `line`
/// is the 1-based source line the element starts on, which is what
/// diagnostics quote.
pub trait LinkRewriter {
    /// Final target for `destination`.
    fn rewrite(&mut self, destination: &str, line: usize) -> LinkTarget;
}

/// Leaves every destination exactly as the author wrote it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NoRewrite;

impl LinkRewriter for NoRewrite {
    fn rewrite(&mut self, destination: &str, _line: usize) -> LinkTarget {
        LinkTarget::new(destination)
    }
}

/// Render one Markdown document into HTML, its chapter outline and its text.
///
/// Never fails: the parser degrades to plain text on input it cannot
/// represent, and unknown constructs degrade to escaped text. Link and
/// image destinations are left exactly as written; use
/// [`render_document_with`] to resolve them.
pub fn render_document(source: &str) -> RenderedDoc {
    render_document_with(source, &mut NoRewrite)
}

/// Render one Markdown document, rewriting every link and image destination
/// through `rewriter` before the HTML is produced.
pub fn render_document_with<R: LinkRewriter + ?Sized>(
    source: &str,
    rewriter: &mut R,
) -> RenderedDoc {
    let tree = prepare(source);
    let mut slugger = Slugger::new();
    let mut headings: Vec<Heading> = Vec::new();
    collect_headings(&tree, &mut slugger, &mut headings);
    let footnotes = footnote_numbers(&tree);
    let mut definitions = refdefs::collect(&tree);

    let (html, text, blocks) =
        html::serialize(&tree, &headings, &footnotes, &mut definitions, rewriter);

    RenderedDoc {
        html,
        toc: build_toc(&headings),
        blocks,
        text: collapse_whitespace(&text),
    }
}

/// The engine-level view: parse and serialise, no own-layer transforms.
///
/// This is what the markdown engine itself makes of a document: the same
/// parser configuration and the same serialiser, with every own-layer pass
/// skipped. It exists so the engine's behaviour can be observed directly —
/// the citation-budget acceptance test runs against it, because the fold it
/// must not hit lives above this line.
pub fn render_engine_html(source: &str) -> String {
    let tree = ast::to_own(&parse::parse_document(source));
    let mut slugger = Slugger::new();
    let mut headings: Vec<Heading> = Vec::new();
    collect_headings(&tree, &mut slugger, &mut headings);
    let footnotes = footnote_numbers(&tree);
    let mut definitions = refdefs::collect(&tree);

    let (html, _, _) = html::serialize(
        &tree,
        &headings,
        &footnotes,
        &mut definitions,
        &mut NoRewrite,
    );
    html
}

/// Anchors of every heading in `source`, in document order.
///
/// A link may point at a chapter of a document that has not been rendered
/// yet (or at any document at all, given that rendering order follows the
/// scan), so the anchor set has to be known *before* the link resolver
/// runs. The pre-pass runs the same parse, the same transforms and the same
/// heading collection the render pass runs, minus the serialisation, which
/// keeps the cost far below a second full render and the anchors exactly in
/// step with it: a mismatch would either report a chapter that cannot be
/// reached or accept one that does not exist.
pub fn sections_of(source: &str) -> Vec<String> {
    let tree = prepare(source);
    let mut slugger = Slugger::new();
    let mut headings: Vec<Heading> = Vec::new();
    collect_headings(&tree, &mut slugger, &mut headings);

    headings.into_iter().map(|heading| heading.id).collect()
}

/// The text of the first level-one heading, if the document has one.
///
/// Used by the scan for a document's title. Inline markup is stripped the
/// way the outline strips it, except that raw HTML contributes nothing: a
/// title is metadata, and markup fragments have no business in it. A `#`
/// inside a fenced code block is never mistaken for a heading.
pub(crate) fn first_h1(source: &str) -> Option<String> {
    let tree = prepare(source);
    let OwnKind::Root(children) = &tree.kind else {
        return None;
    };

    for node in children {
        if let OwnKind::Heading { depth: 1, children } = &node.kind {
            let mut text = HeadingText::new();
            collect_title_text(children, &mut text);
            let finished = text.finish();
            return if finished.is_empty() {
                None
            } else {
                Some(finished)
            };
        }
    }
    None
}

/// Plain text of a heading for the title scan: runs, code, images' alt text
/// and breaks, nothing else.
fn collect_title_text(children: &[OwnNode], into: &mut HeadingText) {
    for node in children {
        match &node.kind {
            OwnKind::Text(value) | OwnKind::InlineCode(value) | OwnKind::InlineMath(value) => {
                into.push(value)
            }
            OwnKind::Break => into.push_break(),
            OwnKind::Image { alt, .. } | OwnKind::ImageReference { alt, .. } => into.push(alt),
            OwnKind::Highlight(inner)
            | OwnKind::Sub(inner)
            | OwnKind::Sup(inner)
            | OwnKind::Emphasis(inner)
            | OwnKind::Strong(inner)
            | OwnKind::Delete(inner)
            | OwnKind::Link {
                children: inner, ..
            }
            | OwnKind::LinkReference {
                children: inner, ..
            } => {
                collect_title_text(inner, into);
            }
            _ => {}
        }
    }
}

/// Parse the document and run every own-layer transform over it.
fn prepare(source: &str) -> OwnNode {
    let mut tree = ast::to_own(&parse::parse_document(source));
    let table = refdefs::collect(&tree);

    transform::fold::run(&mut tree, &table);
    transform::wikilink::run(&mut tree, &table);
    transform::inline::run(&mut tree);
    transform::lenient::run(&mut tree);
    transform::callout::run(&mut tree);

    tree
}

/// Collect every heading, assigning its anchor.
///
/// The slugger sees the headings in document order, so the anchors are the
/// same whatever pass collects them — the render pass serialises exactly
/// this list.
fn collect_headings(node: &OwnNode, slugger: &mut Slugger, out: &mut Vec<Heading>) {
    if let OwnKind::Heading { depth, children } = &node.kind {
        let mut text = HeadingText::new();
        collect_heading_text(children, &mut text);
        let finished = text.finish();
        let id = slugger.unique(&finished);
        out.push(Heading {
            level: u32::from(*depth),
            id,
            text: finished,
        });
    }

    if let Some(children) = node.children() {
        for child in children {
            collect_headings(child, slugger, out);
        }
    }
}

/// Plain text of a heading's children: what the outline shows.
fn collect_heading_text(children: &[OwnNode], into: &mut HeadingText) {
    for node in children {
        match &node.kind {
            OwnKind::Text(value) | OwnKind::InlineCode(value) | OwnKind::InlineMath(value) => {
                into.push(value)
            }
            OwnKind::Break => into.push_break(),
            OwnKind::Image { alt, .. } | OwnKind::ImageReference { alt, .. } => into.push(alt),
            OwnKind::FootnoteReference { label, identifier } => {
                into.push(label.as_deref().unwrap_or(identifier));
            }
            OwnKind::Html { value } => into.push(value),
            OwnKind::Tag(name) => into.push(&format!("#{name}")),
            OwnKind::Shortcode { emoji, .. } => into.push(&emoji.to_string()),
            OwnKind::Wikilink { target, alias } => {
                into.push(alias.as_deref().unwrap_or(target));
            }
            OwnKind::Embed { target } => into.push(target),
            OwnKind::Highlight(inner)
            | OwnKind::Sub(inner)
            | OwnKind::Sup(inner)
            | OwnKind::Emphasis(inner)
            | OwnKind::Strong(inner)
            | OwnKind::Delete(inner)
            | OwnKind::Link {
                children: inner, ..
            }
            | OwnKind::LinkReference {
                children: inner, ..
            } => {
                collect_heading_text(inner, into);
            }
            _ => {}
        }
    }
}

/// The display number of every footnote definition, in definition order.
fn footnote_numbers(root: &OwnNode) -> BTreeMap<String, u32> {
    fn walk(node: &OwnNode, numbers: &mut BTreeMap<String, u32>) {
        if let OwnKind::FootnoteDefinition { identifier, .. } = &node.kind {
            let next = numbers.len() as u32 + 1;
            numbers.entry(identifier.clone()).or_insert(next);
        }
        if let Some(children) = node.children() {
            for child in children {
                walk(child, numbers);
            }
        }
    }

    let mut numbers = BTreeMap::new();
    walk(root, &mut numbers);
    numbers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heading_ids(doc: &RenderedDoc) -> Vec<&str> {
        doc.toc.iter().map(|entry| entry.id.as_str()).collect()
    }

    /// Every anchor in document order, including nested outline entries.
    fn doc_anchor_ids(doc: &RenderedDoc) -> Vec<String> {
        fn walk(entries: &[TocEntry], into: &mut Vec<String>) {
            for entry in entries {
                into.push(entry.id.clone());
                walk(&entry.children, into);
            }
        }

        let mut ids = Vec::new();
        walk(&doc.toc, &mut ids);
        ids
    }

    #[test]
    fn renders_gfm_tables_footnotes_tasks_and_strikethrough() {
        let source = "\
| a | b |
| - | - |
| 1 | 2 |

~~old~~ text[^note]

- [x] done
- [ ] pending

[^note]: the footnote
";
        let doc = render_document(source);

        assert!(doc.html.contains("<table>"), "html: {}", doc.html);
        assert!(doc.html.contains("<thead>"), "html: {}", doc.html);
        assert!(doc.html.contains("<del>old</del>"), "html: {}", doc.html);
        assert!(
            doc.html.contains("class=\"footnote-reference\""),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("class=\"footnote-definition\""),
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
    fn table_cells_align_by_the_delimiter_row() {
        let source = "| a | b | c |\n| :- | -: | :-: |\n| 1 | 2 | 3 |\n";
        let doc = render_document(source);

        assert!(
            doc.html.contains("<th style=\"text-align: left\">"),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("<td style=\"text-align: right\">"),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("<td style=\"text-align: center\">"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn an_ordered_list_keeps_its_start() {
        let doc = render_document("3. third\n4. fourth\n");

        assert!(doc.html.contains("<ol start=\"3\">"), "html: {}", doc.html);
    }

    #[test]
    fn injects_ids_on_headings() {
        let doc = render_document("## Hello, World!\n\ntext\n");

        assert!(doc.html.contains("<h2 id=\"hello-world\">"));
        assert!(doc.html.contains("Hello, World!"));
    }

    #[test]
    fn keeps_cjk_heading_ids() {
        let doc = render_document("## 第一章\n");

        assert!(
            doc.html.contains("<h2 id=\"第一章\">"),
            "html: {}",
            doc.html
        );
        assert_eq!(heading_ids(&doc), ["第一章"]);
    }

    #[test]
    fn duplicate_headings_get_unique_ids() {
        let doc = render_document("## Notes\n\n## Notes\n\n## Notes\n");

        assert!(doc.html.contains("<h2 id=\"notes\">"));
        assert!(doc.html.contains("<h2 id=\"notes-1\">"));
        assert!(doc.html.contains("<h2 id=\"notes-2\">"));
        assert_eq!(heading_ids(&doc), ["notes", "notes-1", "notes-2"]);
    }

    #[test]
    fn outline_mirrors_document_order_and_levels() {
        let doc = render_document("# A\n\n## A1\n\n### A1a\n\n# B\n");

        assert_eq!(doc.toc.len(), 2);
        assert_eq!(doc.toc[0].text, "A");
        assert_eq!(doc.toc[0].children[0].text, "A1");
        assert_eq!(doc.toc[0].children[0].children[0].text, "A1a");
        assert_eq!(doc.toc[1].text, "B");
    }

    #[test]
    fn outline_text_strips_inline_markup() {
        let doc = render_document("## **Bold** and `code` and [link](other.md)\n");

        assert_eq!(doc.toc[0].text, "Bold and code and link");
        assert_eq!(doc.toc[0].id, "bold-and-code-and-link");
    }

    #[test]
    fn headings_inside_code_blocks_are_not_collected() {
        let doc = render_document("```\n# Not a heading\n```\n");

        assert!(doc.toc.is_empty());
        assert!(!doc.html.contains("<h1"));
    }

    #[test]
    fn blocks_follow_the_heading_order_and_carry_their_level() {
        let doc = render_document("# A\n\none\n\n## A1\n\ntwo\n\n# B\n\nthree\n");

        assert_eq!(
            doc.blocks
                .iter()
                .map(|block| (block.id.as_str(), block.level, block.parent))
                .collect::<Vec<_>>(),
            [("a", 1, None), ("a1", 2, Some(0)), ("b", 1, None),],
            "the blocks mirror the outline the toc builds"
        );
        assert_eq!(doc.blocks[0].html, "<h1 id=\"a\">A</h1>\n<p>one</p>\n");
        assert_eq!(doc.blocks[1].html, "<h2 id=\"a1\">A1</h2>\n<p>two</p>\n");
        assert_eq!(doc.blocks[2].html, "<h1 id=\"b\">B</h1>\n<p>three</p>\n");
    }

    #[test]
    fn the_renderer_reports_a_whole_chapter_through_the_block_subtree() {
        let doc = render_document("# A\n\none\n\n## A1\n\ntwo\n\n## A2\n\nthree\n\n# B\n\nfour\n");
        let chapter: String = doc.blocks[0]
            .subtree
            .iter()
            .map(|&index| doc.blocks[index].html.as_str())
            .collect();

        assert_eq!(doc.blocks[0].subtree, [0, 1, 2]);
        assert_eq!(doc.blocks[3].subtree, [3], "B has no children");
        assert!(
            chapter.starts_with("<h1 id=\"a\">A</h1>"),
            "chapter: {chapter}"
        );
        assert!(
            chapter.ends_with("<p>three</p>\n"),
            "the chapter stops before the next root: {chapter}"
        );
        assert!(
            !chapter.contains("four"),
            "a sibling root is not part of the chapter"
        );
    }

    #[test]
    fn blocks_leave_the_body_html_untouched() {
        let source =
            "# Title\n\npara with `code` and [link](a.md)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
        let doc = render_document(source);

        assert_eq!(
            doc.html,
            "<h1 id=\"title\">Title</h1>\n\
             <p>para with <code>code</code> and <a href=\"a.md\">link</a></p>\n\
             <table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n\
             <tr><td>1</td><td>2</td></tr>\n\
             </tbody></table>\n",
            "the block slicing must not disturb the document body"
        );
        assert_eq!(
            doc.blocks[0].html, doc.html,
            "a document with a single heading is one block"
        );
    }

    #[test]
    fn a_document_without_headings_has_no_blocks_but_keeps_its_body() {
        let doc = render_document("just text\n");

        assert!(doc.blocks.is_empty());
        assert_eq!(doc.html, "<p>just text</p>\n");
    }

    #[test]
    fn blocks_carry_rewritten_links() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("# A\n\n[gone](missing.md)\n", &mut recorder);

        assert!(
            doc.blocks[0].html.contains("href=\"rewritten:missing.md\""),
            "block: {}",
            doc.blocks[0].html
        );
    }

    #[test]
    fn heading_anchors_are_collected_in_one_pre_pass() {
        let source = "# A\n\n## Notes\n\n## Notes\n\n### 第一章\n\n## ![Logo](i.png)\n";

        let anchors = sections_of(source);

        assert_eq!(
            anchors,
            ["a", "notes", "notes-1", "第一章", "logo"],
            "the pre-pass must agree with the renderer's slugs"
        );
        assert_eq!(
            anchors,
            doc_anchor_ids(&render_document(source)),
            "both paths must produce the same anchors"
        );
    }

    #[test]
    fn smart_punctuation_stays_off() {
        let doc = render_document("He said \"hi\" -- and left...\n");

        assert!(
            doc.html.contains("\"hi\" -- and left..."),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains('“'));
    }

    #[test]
    fn raw_html_passes_through_unchanged() {
        let doc = render_document("<div class=\"raw\">keep</div>\n");

        assert!(doc.html.contains("<div class=\"raw\">keep</div>"));
    }

    #[test]
    fn inline_html_passes_through_inside_a_paragraph() {
        let doc = render_document("a <b>bold</b> word\n");

        assert!(
            doc.html.contains("<p>a <b>bold</b> word</p>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn empty_document_renders_nothing() {
        let doc = render_document("");

        assert_eq!(doc.html, "");
        assert!(doc.toc.is_empty());
    }

    #[test]
    fn rendering_is_deterministic() {
        let source = "# Title\n\n## Notes\n\n## Notes\n\ntext\n";

        assert_eq!(render_document(source), render_document(source));
    }

    #[test]
    fn the_construct_set_matches_the_documented_syntax_promise() {
        let options = parse::parse_options();

        // The GFM subset the product promises.
        assert!(options.constructs.gfm_table);
        assert!(options.constructs.gfm_footnote_definition);
        assert!(options.constructs.gfm_strikethrough);
        assert!(options.constructs.gfm_task_list_item);
        assert!(options.constructs.gfm_autolink_literal);
        // The Typora constructs that arrive with the parser.
        assert!(options.constructs.frontmatter);
        assert!(options.constructs.math_flow);
        assert!(options.constructs.math_text);
        // Single tilde belongs to the own-layer subscript transform.
        assert!(!options.gfm_strikethrough_single_tilde);
        // MDX is a component format, not a document format.
        assert!(!options.constructs.mdx_esm);
    }

    #[test]
    fn heading_text_collapses_whitespace() {
        let doc = render_document("## Spaced   out\n");

        assert_eq!(doc.toc[0].text, "Spaced out");
    }

    #[test]
    fn fenced_code_block_is_highlighted() {
        let doc = render_document("```rust\nfn main() {}\n```\n");

        assert!(
            doc.html
                .contains("<pre class=\"code\"><code class=\"language-rust\">"),
            "html: {}",
            doc.html
        );
        assert!(doc.html.contains("<span class=\""), "html: {}", doc.html);
        assert!(doc.html.contains("</code></pre>"), "html: {}", doc.html);
        assert!(!doc.html.contains("```"), "html: {}", doc.html);
    }

    #[test]
    fn unknown_fence_is_escaped_without_spans() {
        let doc = render_document("```foo\na < b\n```\n");

        assert!(
            doc.html.contains(
                "<pre class=\"code\"><code class=\"language-foo\">a &lt; b\n</code></pre>"
            ),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains("<span"), "html: {}", doc.html);
    }

    #[test]
    fn indented_code_block_has_no_language_class() {
        let doc = render_document("    let x = 1;\n");

        assert!(
            doc.html
                .contains("<pre class=\"code\"><code>let x = 1;\n</code></pre>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn inline_code_stays_inline_and_unhighlighted() {
        let doc = render_document("use `let x = 1;` here\n");

        assert!(
            doc.html.contains("<code>let x = 1;</code>"),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains("<pre"), "html: {}", doc.html);
    }

    /// Rewriter that records every destination and tags it, so a test can see
    /// exactly what the serialiser handed over.
    struct Recorder {
        seen: Vec<(String, usize)>,
    }

    impl Recorder {
        fn new() -> Self {
            Self { seen: Vec::new() }
        }
    }

    impl LinkRewriter for Recorder {
        fn rewrite(&mut self, destination: &str, line: usize) -> LinkTarget {
            self.seen.push((destination.to_string(), line));
            LinkTarget::new(format!("rewritten:{destination}"))
        }
    }

    /// Rewriter that reports every destination as an unknown chapter, so the
    /// markup a broken block reference produces can be inspected directly.
    struct Missing {
        anchor: String,
    }

    impl LinkRewriter for Missing {
        fn rewrite(&mut self, destination: &str, _line: usize) -> LinkTarget {
            LinkTarget::missing_chapter(destination.to_string(), self.anchor.clone())
        }
    }

    #[test]
    fn link_rewriter_sees_every_destination_and_its_line() {
        let source = "# T\n\ntext [a](a.md) and ![i](i.png)\n\n[d](b.md#x)\n";
        let mut recorder = Recorder::new();

        let doc = render_document_with(source, &mut recorder);

        assert_eq!(
            recorder.seen,
            [
                ("a.md".to_string(), 3),
                ("i.png".to_string(), 3),
                ("b.md#x".to_string(), 5),
            ]
        );
        assert!(
            doc.html.contains("href=\"rewritten:a.md\""),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("src=\"rewritten:i.png\""),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("href=\"rewritten:b.md#x\""),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn a_marked_link_carries_the_authored_chapter_before_its_opening_tag() {
        let mut missing = Missing {
            anchor: "1.4 配色与字体".to_string(),
        };

        let doc = render_document_with("see [x](b.md)\n", &mut missing);

        assert_eq!(
            doc.html,
            "<p>see <span hidden class=\"doc-link-missing\" \
             data-wikicc-missing-anchor=\"1.4 配色与字体\"></span><a href=\"b.md\">x</a></p>\n",
            "the mark must sit inside the paragraph, right before the link"
        );
    }

    #[test]
    fn a_marked_link_composes_with_emphasis_and_tables() {
        let mut missing = Missing {
            anchor: "gone".to_string(),
        };

        let doc = render_document_with(
            "**bold [x](b.md)** and `code`\n\n| a |\n| - |\n| [x](b.md) |\n",
            &mut missing,
        );

        assert_eq!(
            doc.html.matches("data-wikicc-missing-anchor").count(),
            2,
            "inline markup and table cells both keep the mark: {}",
            doc.html
        );
        assert!(
            doc.html
                .contains("<td><span hidden class=\"doc-link-missing\""),
            "a cell keeps its inline shape: {}",
            doc.html
        );
    }

    #[test]
    fn the_authored_chapter_cannot_break_out_of_its_attribute() {
        let mut missing = Missing {
            anchor: "a\"b&c<d>".to_string(),
        };

        let doc = render_document_with("[x](b.md)\n", &mut missing);

        assert!(
            doc.html
                .contains("data-wikicc-missing-anchor=\"a&quot;b&amp;c&lt;d&gt;\""),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains("<d>"), "html: {}", doc.html);
    }

    #[test]
    fn an_unmarked_document_has_no_extra_markup() {
        let doc = render_document_with("[x](b.md)\n", &mut NoRewrite);

        assert!(
            !doc.html.contains("span"),
            "a plain destination writes no mark: {}",
            doc.html
        );
        assert_eq!(
            doc.html, "<p><a href=\"b.md\">x</a></p>\n",
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn the_default_rewriter_is_the_identity() {
        let source = "# T\n\n[a](a.md) ![i](i.png) [e](https://example.com)\n\n[r]: r.md \"R\"\n";

        assert_eq!(
            render_document(source),
            render_document_with(source, &mut NoRewrite)
        );
        assert_eq!(
            render_document(source).html,
            render_document_with(source, &mut NoRewrite).html,
            "destinations stay verbatim"
        );
    }

    #[test]
    fn destinations_inside_code_blocks_are_not_rewritten() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("```\n[a](a.md)\n```\n", &mut recorder);

        assert!(recorder.seen.is_empty(), "seen: {:?}", recorder.seen);
        assert!(doc.html.contains("[a](a.md)"), "html: {}", doc.html);
    }

    #[test]
    fn rewriting_does_not_change_heading_slugs() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("## [Guide](guide.md)\n", &mut recorder);

        assert_eq!(doc.toc[0].id, "guide");
        assert_eq!(doc.toc[0].text, "Guide");
        assert_eq!(recorder.seen, [("guide.md".to_string(), 1)]);
    }

    #[test]
    fn code_block_followed_by_a_heading_keeps_the_outline() {
        let doc = render_document("```rust\nfn main() {}\n```\n\n## After\n");

        assert_eq!(doc.toc.len(), 1);
        assert_eq!(doc.toc[0].text, "After");
        assert!(doc.html.contains("<h2 id=\"after\">"), "html: {}", doc.html);
    }

    #[test]
    fn text_covers_every_block_kind_without_markup() {
        let source = "\
# Title

A **bold** paragraph with `code` and a [link](other.md).

- one
- two

| name | value |
| ---- | ----- |
| a    | 1     |

```rust
fn main() {}
```
";
        let doc = render_document(source);

        for expected in [
            "Title",
            "A bold paragraph with code and a link.",
            "one two",
            "name value",
            "a 1",
            "fn main() {}",
        ] {
            assert!(
                doc.text.contains(expected),
                "missing {expected:?} in text: {}",
                doc.text
            );
        }
        for marker in ['#', '*', '`', '|'] {
            assert!(
                !doc.text.contains(marker),
                "text still carries {marker:?}: {}",
                doc.text
            );
        }
    }

    #[test]
    fn text_keeps_unicode_and_collapses_whitespace() {
        let doc = render_document("## 第一章\n\n中文   文本\n");

        assert_eq!(doc.text, "第一章 中文 文本");
    }

    #[test]
    fn text_of_an_empty_document_is_empty() {
        assert_eq!(render_document("").text, "");
    }

    #[test]
    fn text_separates_adjacent_blocks_but_not_inline_runs() {
        let doc = render_document("alpha\n\nbeta **gamma** delta\n");

        assert_eq!(doc.text, "alpha beta gamma delta");
    }

    #[test]
    fn a_bare_url_autolinks_like_typora() {
        let doc = render_document("see https://example.com/page now\n");

        assert!(
            doc.html
                .contains("<a href=\"https://example.com/page\">https://example.com/page</a>"),
            "html: {}",
            doc.html
        );
    }

    // The Typora citation idiom and the reference list under it.

    /// A document whose `[1]` and `[2]` are reference link definitions.
    fn citation_source(body: &str) -> String {
        format!("{body}\n\n[1]: https://example.com/1\n[2]: https://example.com/2\n")
    }

    /// The two definition paragraphs `citation_source` renders, in order.
    const CITATION_DEFINITIONS: &str = "\
<p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
<a href=\"https://example.com/1\">https://example.com/1</a></p>\n\
<p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[2]:</span> \
<a href=\"https://example.com/2\">https://example.com/2</a></p>\n";

    /// The definition text `citation_source` adds to the search index.
    const CITATION_DEFINITIONS_TEXT: &str = "[1]: https://example.com/1 [2]: https://example.com/2";

    #[test]
    fn bracketed_citation_collapses_to_one_link() {
        let doc = render_document(&citation_source("text[[1]][1] more"));

        assert_eq!(
            doc.html,
            format!(
                "<p>text<a href=\"https://example.com/1\">[1]</a> more</p>\n{CITATION_DEFINITIONS}"
            ),
            "html: {}",
            doc.html
        );
        assert_eq!(
            doc.html.matches("<a ").count(),
            3,
            "one link in the body plus one per definition: {}",
            doc.html
        );
    }

    #[test]
    fn bracketed_citation_reads_as_a_citation_in_the_text() {
        let doc = render_document(&citation_source("text[[1]][1] more"));

        assert_eq!(
            doc.text,
            format!("text[1] more {CITATION_DEFINITIONS_TEXT}")
        );
    }

    #[test]
    fn bracketed_citation_inside_a_table_cell_collapses() {
        let source = citation_source("| a | b |\n| - | - |\n| x[[1]][1] | y |");
        let doc = render_document(&source);

        assert!(
            doc.html
                .contains("<td>x<a href=\"https://example.com/1\">[1]</a></td>"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.html.matches("<a ").count(), 3, "html: {}", doc.html);
        assert_eq!(doc.text, format!("a b x[1] y {CITATION_DEFINITIONS_TEXT}"));
    }

    #[test]
    fn bracketed_citation_inside_a_heading_updates_text_and_anchor() {
        let doc = render_document(&citation_source("## Ref [[1]][1]"));

        assert!(
            doc.html
                .contains("<h2 id=\"ref-1\">Ref <a href=\"https://example.com/1\">[1]</a>"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.toc[0].text, "Ref [1]");
    }

    #[test]
    fn several_citations_in_one_paragraph_each_collapse() {
        let doc = render_document(&citation_source("a[[1]][1]b[[2]][2]c"));

        assert_eq!(
            doc.html,
            format!(
                "<p>a<a href=\"https://example.com/1\">[1]</a>b<a href=\"https://example.com/2\">[2]</a>c</p>\n{CITATION_DEFINITIONS}"
            ),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, format!("a[1]b[2]c {CITATION_DEFINITIONS_TEXT}"));
    }

    #[test]
    fn a_wrapped_link_without_its_duplicate_is_left_alone() {
        let doc = render_document(&citation_source("text[[1]] more"));

        assert!(
            doc.html
                .contains("text[<a href=\"https://example.com/1\">1</a>] more"),
            "html: {}",
            doc.html
        );
        assert_eq!(
            doc.text,
            format!("text[1] more {CITATION_DEFINITIONS_TEXT}")
        );
    }

    #[test]
    fn adjacent_inline_links_are_not_folded() {
        let source = "[1](https://example.com)[1](https://example.com)\n";
        let doc = render_document(source);

        assert_eq!(
            doc.html,
            "<p><a href=\"https://example.com\">1</a><a href=\"https://example.com\">1</a></p>\n",
            "inline brackets are author syntax, not a wrap: {}",
            doc.html
        );
    }

    #[test]
    fn adjacent_reference_links_without_a_wrap_are_not_folded() {
        let doc = render_document(&citation_source("[1] [1]"));

        assert_eq!(
            doc.html.matches("<a ").count(),
            4,
            "two body links plus one per definition: {}",
            doc.html
        );
    }

    #[test]
    fn an_undefined_reference_is_left_verbatim() {
        let doc = render_document("text[[1]][1] more\n");

        assert!(doc.html.contains("text[[1]][1] more"), "html: {}", doc.html);
    }

    #[test]
    fn citations_inside_code_are_never_folded() {
        let source = "`[[1]][1]`\n\n```\n[[1]][1]\n```\n\n[1]: https://example.com/1\n";
        let doc = render_document(source);

        assert!(
            doc.html.contains("<code>[[1]][1]</code>"),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html
                .contains("<pre class=\"code\"><code>[[1]][1]\n</code></pre>"),
            "code keeps the source verbatim: {}",
            doc.html
        );
        // Only the definition block renders a link; nothing inside code does.
        assert_eq!(doc.html.matches("<a ").count(), 1, "html: {}", doc.html);
    }

    #[test]
    fn the_folded_citation_resolves_to_one_destination() {
        let mut recorder = Recorder::new();

        let doc = render_document_with(&citation_source("x[[1]][1]y"), &mut recorder);

        assert_eq!(
            recorder.seen,
            [
                ("https://example.com/1".to_string(), 1),
                ("https://example.com/1".to_string(), 3),
                ("https://example.com/2".to_string(), 4),
            ],
            "the duplicate body link is dropped, each definition is resolved once"
        );
        assert_eq!(
            doc.html.matches("href=").count(),
            3,
            "one body link and two definitions: {}",
            doc.html
        );
        // `x[1]y`: the duplicate link is gone, so the surviving one sits
        // between the brackets instead of a `[1]1` run.
        assert!(
            doc.html
                .contains("<p>x<a href=\"rewritten:https://example.com/1\">[1]</a>y</p>"),
            "the duplicate citation must not survive: {}",
            doc.html
        );
        assert!(!doc.html.contains("]</a>1"), "html: {}", doc.html);
    }

    #[test]
    fn a_link_at_the_end_of_a_paragraph_is_still_rewritten() {
        let mut recorder = Recorder::new();

        let doc = render_document_with(&citation_source("see [[1]]"), &mut recorder);

        assert_eq!(
            recorder.seen,
            [
                ("https://example.com/1".to_string(), 1),
                ("https://example.com/1".to_string(), 3),
                ("https://example.com/2".to_string(), 4),
            ]
        );
        assert_eq!(
            doc.html,
            "<p>see [<a href=\"rewritten:https://example.com/1\">1</a>]</p>\n\
             <p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
             <a href=\"rewritten:https://example.com/1\">https://example.com/1</a></p>\n\
             <p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[2]:</span> \
             <a href=\"rewritten:https://example.com/2\">https://example.com/2</a></p>\n",
            "html: {}",
            doc.html
        );
    }

    // Reference definitions in place.

    /// A source whose definitions end the document, the way a reference list
    /// sits under its last heading.
    fn reference_list_source() -> String {
        "# 参考链接\n\n\
         [1]: https://example.com/one \"First source\"\n\
         [2]: https://example.com/two\n"
            .to_string()
    }

    #[test]
    fn definitions_are_rendered_where_the_author_wrote_them() {
        let doc = render_document(&reference_list_source());

        assert!(
            doc.html.starts_with("<h1 id=\"参考链接\">参考链接</h1>\n"),
            "html: {}",
            doc.html
        );
        assert_eq!(
            doc.html.matches("<p class=\"link-ref-def\">").count(),
            2,
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains(
                "<span class=\"link-ref-def-label\">[1]:</span> \
                 <a href=\"https://example.com/one\">https://example.com/one</a> \"First source\"</p>"
            ),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains(
                "<span class=\"link-ref-def-label\">[2]:</span> \
                 <a href=\"https://example.com/two\">https://example.com/two</a></p>"
            ),
            "a definition without a title gets no quotes: {}",
            doc.html
        );
    }

    #[test]
    fn definitions_are_searchable_and_feed_the_outline() {
        let doc = render_document(&reference_list_source());

        assert_eq!(
            doc.text,
            "参考链接 [1]: https://example.com/one \"First source\" [2]: https://example.com/two"
        );
        assert_eq!(doc.toc.len(), 1, "definitions are not headings");
        assert_eq!(doc.toc[0].text, "参考链接");
    }

    #[test]
    fn definitions_between_paragraphs_keep_their_position() {
        let source = "alpha\n\n[1]: https://example.com/1\n\nbeta\n";
        let doc = render_document(source);

        assert_eq!(
            doc.html,
            "<p>alpha</p>\n\
             <p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
             <a href=\"https://example.com/1\">https://example.com/1</a></p>\n\
             <p>beta</p>\n",
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn a_repeated_definition_renders_only_its_first_occurrence() {
        let source = "[1]: https://example.com/first\n[1]: https://example.com/second\n";
        let doc = render_document(source);

        assert_eq!(doc.html.matches("<p class=\"link-ref-def\">").count(), 1);
        assert!(
            doc.html.contains("https://example.com/first"),
            "html: {}",
            doc.html
        );
        assert!(
            !doc.html.contains("https://example.com/second"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn a_document_of_definitions_alone_renders_them() {
        let doc = render_document("[1]: https://example.com/1\n");

        assert_eq!(
            doc.html,
            "<p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
             <a href=\"https://example.com/1\">https://example.com/1</a></p>\n",
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, "[1]: https://example.com/1");
    }

    #[test]
    fn definition_parts_are_escaped() {
        let source = "[a&b]: https://example.com/?a=1&b=2 \"x < y & \\\"q\\\"\"\n";
        let doc = render_document(source);

        assert!(
            doc.html
                .contains("<span class=\"link-ref-def-label\">[a&amp;b]:</span>"),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html
                .contains("href=\"https://example.com/?a=1&amp;b=2\""),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("\"x &lt; y &amp; &quot;q&quot;\"</p>"),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains("x < y"), "html: {}", doc.html);
    }

    #[test]
    fn a_definition_destination_reaches_the_resolver_once() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("[1]: a.md\n\nsee [1]\n", &mut recorder);

        assert_eq!(
            recorder.seen,
            [("a.md".to_string(), 1), ("a.md".to_string(), 3),],
            "the definition is resolved on its own line, not through the citation"
        );
        assert_eq!(
            doc.html,
            "<p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
             <a href=\"rewritten:a.md\">a.md</a></p>\n\
             <p>see <a href=\"rewritten:a.md\">1</a></p>\n",
            "html: {}",
            doc.html
        );
    }

    // The own-layer syntax extension layer: Typora and Obsidian constructs.

    #[test]
    fn highlight_renders_as_a_mark_element() {
        let doc = render_document("a ==marked== word\n");

        assert!(
            doc.html.contains("<p>a <mark>marked</mark> word</p>"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, "a marked word");
    }

    #[test]
    fn subscript_and_superscript_render_as_their_elements() {
        let doc = render_document("H~2~O and X^2^\n");

        assert!(
            doc.html.contains("H<sub>2</sub>O and X<sup>2</sup>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn comments_render_nothing() {
        let doc = render_document("a %%secret%% b\n");

        assert_eq!(doc.html, "<p>a  b</p>\n", "html: {}", doc.html);
        assert_eq!(doc.text, "a b");
    }

    #[test]
    fn tags_render_as_tagged_spans() {
        let doc = render_document("tagged #v2 here\n");

        assert!(
            doc.html.contains("<span class=\"doc-tag\">#v2</span>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn shortcodes_render_their_emoji() {
        let doc = render_document("well done :tada:\n");

        assert!(doc.html.contains("🎉"), "html: {}", doc.html);
        assert!(doc.text.contains('🎉'), "text: {}", doc.text);
    }

    #[test]
    fn math_renders_as_stylable_elements() {
        let doc = render_document("inline $E=mc^2$ math\n\n$$\na+b\n$$\n");

        assert!(
            doc.html
                .contains("<code class=\"math-inline\">E=mc^2</code>"),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("<pre class=\"math\">a+b</pre>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn front_matter_stays_out_of_every_output() {
        let doc = render_document("---\ntitle: t\n---\n\n# Body\n");

        assert!(!doc.html.contains("title:"), "html: {}", doc.html);
        assert!(!doc.text.contains("title:"), "text: {}", doc.text);
        assert!(
            doc.html.contains("<h1 id=\"body\">Body</h1>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn a_wikilink_without_a_definition_becomes_a_link() {
        let doc = render_document("see [[My Page]] now\n");

        assert!(
            doc.html.contains("<a href=\"My Page.md\">My Page</a>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn a_wikilink_alias_becomes_the_link_text() {
        let doc = render_document("[[a.md|the alias]]\n");

        assert!(
            doc.html.contains("<a href=\"a.md\">the alias</a>"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, "the alias");
    }

    #[test]
    fn a_wikilink_target_that_resolves_is_a_route() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("[[b.md]]\n", &mut recorder);

        assert_eq!(
            recorder.seen,
            [("b.md".to_string(), 1)],
            "the wikilink target goes through the same resolver"
        );
        assert!(
            doc.html.contains("<a href=\"rewritten:b.md\">b.md</a>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn an_embed_of_a_local_file_renders_an_image() {
        let doc = render_document("![[img.png]]\n");

        assert!(
            doc.html.contains("<img src=\"img.png\" alt=\"img.png\" />"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, "img.png");
    }

    #[test]
    fn a_callout_renders_as_the_callout_markup() {
        let doc = render_document("> [!note] Remember\n> body text\n");

        assert!(
            doc.html.contains(
                "<div class=\"callout\" data-callout=\"note\">\n\
                 <p class=\"callout-title\">Remember</p>\n\
                 <div class=\"callout-content\">\n<p>body text</p>\n</div>\n</div>"
            ),
            "html: {}",
            doc.html
        );
        assert!(
            doc.text.contains("Remember body text"),
            "text: {}",
            doc.text
        );
    }

    #[test]
    fn a_markerless_callout_takes_its_kind_as_the_title() {
        let doc = render_document("> [!warning]\n> body\n");

        assert!(
            doc.html.contains("<p class=\"callout-title\">Warning</p>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn a_plain_blockquote_stays_a_blockquote() {
        let doc = render_document("> just quoted\n");

        assert!(
            doc.html
                .contains("<blockquote>\n<p>just quoted</p>\n</blockquote>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn the_engine_view_skips_every_own_layer_transform() {
        let source = "x[[1]][1] and [[page]] and ==mark==\n\n[1]: https://example.com/1\n";

        let engine = render_engine_html(source);
        let reader = render_document(source);

        // The engine resolves every reference but folds nothing and claims
        // no sugar: the shapes stay exactly as the parser produced them.
        assert!(
            engine.contains(
                "[<a href=\"https://example.com/1\">1</a>]<a href=\"https://example.com/1\">1</a>"
            ),
            "engine: {engine}"
        );
        assert!(!engine.contains("<mark>"), "engine: {engine}");
        assert!(
            reader
                .html
                .contains("<a href=\"https://example.com/1\">[1]</a>"),
            "reader: {}",
            reader.html
        );
        assert!(
            reader.html.contains("<mark>mark</mark>"),
            "reader: {}",
            reader.html
        );
    }
}
