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

use std::collections::{BTreeMap, BTreeSet};

use ast::{OwnKind, OwnNode};
use markdown::mdast::Node;
use sections::Block;
use serde_yaml::Value;
use toc::{Heading, collect_headings};

pub use links::{
    INVALID_LINK_ATTRIBUTE, INVALID_LINK_CLASS, LinkClass, LinkContext, LinkResolver, LinkRewriter,
    LinkTarget, MISSING_ANCHOR_ATTRIBUTE, MISSING_LINK_CLASS, NoRewrite, classify,
};
pub(crate) use links::{NEW_TAB_ATTRIBUTES, invalid_link_attributes, missing_link_attributes};
pub use sections::Block as ChapterBlock;
pub use slug::{FALLBACK_SLUG, Slugger, slugify};
pub use toc::{HeadingText, TocEntry, build_toc, collapse_whitespace};

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
    /// Tag names the body carries, deduplicated and sorted in byte order.
    ///
    /// The same inline sugar pass that renders `#tag` chips produces them, so
    /// the tags a document claims are exactly the chips its HTML shows. The
    /// site aggregation folds these per-document sets into the payload.
    pub tags: Vec<String>,
    /// Raw YAML text of the front matter, without the `---` fences, when the
    /// document opens with one.
    ///
    /// Build-side metadata only: the `encrypt` directive is read from here,
    /// and the text never reaches any output — the serialiser drops the node,
    /// a contract the front-matter test pins. It rides beside the rendered
    /// parts so one parse serves both.
    pub front_matter: Option<String>,
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
    // One parse serves the render and the front matter: the raw YAML text is
    // taken off the tree before the own-layer conversion drops it.
    let parsed = parse::parse_document(source);
    let front_matter = front_matter_text(&parsed);
    let tree = prepare_tree(&parsed);
    let mut slugger = Slugger::new();
    let mut headings: Vec<Heading> = Vec::new();
    collect_headings(&tree, &mut slugger, &mut headings);
    let footnotes = footnote_numbers(&tree);
    let mut definitions = refdefs::collect(&tree);

    let (html, text, blocks, tags) =
        html::serialize(&tree, &headings, &footnotes, &mut definitions, rewriter);
    let unique = tags.into_iter().collect::<BTreeSet<_>>();

    RenderedDoc {
        html,
        toc: build_toc(&headings),
        blocks,
        text: collapse_whitespace(&text),
        tags: unique.into_iter().collect(),
        front_matter,
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

    let (html, _, _, _) = html::serialize(
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

/// The title a document asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DocTitle {
    /// The title to use: the front matter `title` when it is usable text,
    /// else the first level-one heading. `None` leaves the scan to the file
    /// stem and `Untitled`.
    pub title: Option<String>,
    /// A `title` key existed but its value cannot become a title; the scan
    /// reports that and falls back.
    pub rejected: bool,
}

/// The title a document asks for: the front matter `title` when it is usable
/// text, else the first level-one heading.
///
/// Used by the scan for a document's title. The heading text is collected
/// from the parsed tree, so inline markup (`**bold**`, `` `code` ``, links)
/// is stripped for free and a `#` inside a fenced code block is never
/// mistaken for a heading. Raw HTML contributes nothing: a title is
/// metadata, and markup fragments have no business in it.
///
/// The front matter `title` wins when it turns into text: a non-empty string
/// (trimmed), a number or a boolean is read as written, and an explicit tag
/// (`!!str 123`) speaks through the value it labels. A key that is missing,
/// `null`, sits in a front matter that is not a mapping, or in YAML that
/// does not parse falls back to the heading silently — broken YAML is the
/// encrypt stage's error, and one diagnostic per problem is enough. A value
/// that exists but cannot become a title — an empty or whitespace string, a
/// sequence, a mapping — sets [`DocTitle::rejected`] so the scan can warn.
pub(crate) fn document_title(source: &str) -> DocTitle {
    // One parse serves the front matter and the heading scan: the raw YAML
    // text is taken off the engine tree before the own-layer conversion
    // drops it.
    let parsed = parse::parse_document(source);
    let mut rejected = false;
    if let Some(raw) = front_matter_text(&parsed) {
        match front_matter_title(&raw) {
            FrontMatterTitle::Text(text) => {
                return DocTitle {
                    title: Some(text),
                    rejected: false,
                };
            }
            FrontMatterTitle::Rejected => rejected = true,
            FrontMatterTitle::Absent => {}
        }
    }

    let tree = prepare_tree(&parsed);
    DocTitle {
        title: first_h1_in_tree(&tree),
        rejected,
    }
}

/// What a document's front matter `title` value comes to.
enum FrontMatterTitle {
    /// No usable value spoke: the heading decides, without a warning.
    Absent,
    /// The value became title text.
    Text(String),
    /// A `title` key existed but the value cannot become a title.
    Rejected,
}

/// The `title` value of the raw front matter text.
///
/// A front matter that is not a mapping — a bare scalar, a list, nothing at
/// all — names no `title` key: the front matter is not ours to judge.
fn front_matter_title(raw: &str) -> FrontMatterTitle {
    let Ok(value) = serde_yaml::from_str::<Value>(raw) else {
        return FrontMatterTitle::Absent;
    };
    let Value::Mapping(mapping) = value else {
        return FrontMatterTitle::Absent;
    };

    match mapping.get(Value::from("title")) {
        None | Some(Value::Null) => FrontMatterTitle::Absent,
        Some(value) => title_text(value),
    }
}

/// Turn one `title` value into text, or say why it cannot become a title.
fn title_text(value: &Value) -> FrontMatterTitle {
    match value {
        Value::String(text) => match text.trim() {
            "" => FrontMatterTitle::Rejected,
            trimmed => FrontMatterTitle::Text(trimmed.to_string()),
        },
        Value::Number(number) => FrontMatterTitle::Text(number.to_string()),
        Value::Bool(flag) => FrontMatterTitle::Text(flag.to_string()),
        Value::Tagged(tagged) => title_text(&tagged.value),
        _ => FrontMatterTitle::Rejected,
    }
}

/// The text of the first level-one heading in a prepared tree, if the
/// document has one.
fn first_h1_in_tree(tree: &OwnNode) -> Option<String> {
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
    let tree = parse::parse_document(source);
    prepare_tree(&tree)
}

/// Run every own-layer transform over an already-parsed tree.
fn prepare_tree(tree: &Node) -> OwnNode {
    let mut tree = ast::to_own(tree);
    let table = refdefs::collect(&tree);

    transform::fold::run(&mut tree, &table);
    transform::wikilink::run(&mut tree, &table);
    transform::inline::run(&mut tree);
    transform::lenient::run(&mut tree);
    transform::callout::run(&mut tree);

    tree
}

/// Raw YAML text of the front matter node of `tree`, without the fences.
///
/// The value is metadata the build reads; the serialiser drops the node, so
/// whatever is here never reaches an output. A document without front matter
/// — or one whose front matter sits anywhere but the top — carries none.
fn front_matter_text(tree: &Node) -> Option<String> {
    let Node::Root(root) = tree else {
        return None;
    };
    match root.children.first() {
        Some(Node::Yaml(yaml)) => Some(yaml.value.clone()),
        _ => None,
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
    fn rendering_is_deterministic() {
        let source = "# Title\n\n## Notes\n\n## Notes\n\ntext\n";

        assert_eq!(render_document(source), render_document(source));
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
    fn front_matter_text_is_extracted_with_its_fences_dropped() {
        let doc = render_document("---\nencrypt: true\ntitle: t\n---\n\n# Body\n");
        let raw = doc.front_matter.expect("front matter is carried");

        assert!(raw.contains("encrypt: true"), "raw: {raw}");
        assert!(raw.contains("title: t"), "raw: {raw}");
        assert!(!raw.contains("---"), "the fences are not the value: {raw}");
        assert!(
            doc.html.contains("<h1 id=\"body\">Body</h1>"),
            "the render is untouched: {}",
            doc.html
        );
    }

    #[test]
    fn a_document_without_front_matter_carries_none() {
        assert_eq!(render_document("# Body\n").front_matter, None);
        assert_eq!(render_document("").front_matter, None);
    }

    #[test]
    fn only_front_matter_at_the_top_counts() {
        // A horizontal rule in the body is not a front matter fence.
        let doc = render_document("# Body\n\n---\n\nafter the rule\n");

        assert_eq!(doc.front_matter, None);
        assert!(doc.html.contains("<hr />"), "html: {}", doc.html);
    }

    #[test]
    fn document_title_prefers_the_front_matter_title() {
        let found = document_title("---\ntitle: From the matter\n---\n\n# Heading\n");

        assert_eq!(found.title.as_deref(), Some("From the matter"));
        assert!(!found.rejected);
    }

    #[test]
    fn document_title_uses_the_front_matter_without_a_heading() {
        let found = document_title("---\ntitle: Named\n---\n\nno heading\n");

        assert_eq!(found.title.as_deref(), Some("Named"));
        assert!(!found.rejected);
    }

    #[test]
    fn document_title_trims_the_front_matter_value() {
        let quoted = document_title("---\ntitle: \"  Spaced  \"\n---\n\n# Heading\n");
        let block = document_title("---\ntitle: |\n  Block title\n---\n\n# Heading\n");

        assert_eq!(quoted.title.as_deref(), Some("Spaced"));
        assert_eq!(block.title.as_deref(), Some("Block title"));
    }

    #[test]
    fn document_title_reads_numbers_and_booleans_as_text() {
        for (raw, expected) in [
            ("title: 123", "123"),
            ("title: 1.5", "1.5"),
            ("title: -7", "-7"),
            ("title: true", "true"),
            ("title: false", "false"),
        ] {
            let found = document_title(&format!("---\n{raw}\n---\n\n# Heading\n"));

            assert_eq!(found.title.as_deref(), Some(expected), "raw: {raw}");
            assert!(!found.rejected, "raw: {raw}");
        }
    }

    #[test]
    fn document_title_unwraps_a_tagged_title() {
        let found = document_title("---\ntitle: !!str 42\n---\n\n# Heading\n");

        assert_eq!(found.title.as_deref(), Some("42"));
        assert!(!found.rejected);
    }

    #[test]
    fn document_title_rejects_values_that_cannot_become_text() {
        for raw in [
            "title: \"\"",
            "title: \"   \"",
            "title: [a, b]",
            "title: {a: b}",
        ] {
            let found = document_title(&format!("---\n{raw}\n---\n\n# Heading\n"));

            assert_eq!(found.title.as_deref(), Some("Heading"), "raw: {raw}");
            assert!(found.rejected, "raw: {raw}");
        }
    }

    #[test]
    fn document_title_falls_back_to_the_heading_silently() {
        for matter in [
            "encrypt: true",
            "other: value",
            "title: null",
            "title:",
            "- one\n- two",
            "title: [unclosed",
        ] {
            let found = document_title(&format!("---\n{matter}\n---\n\n# Heading\n"));

            assert_eq!(found.title.as_deref(), Some("Heading"), "matter: {matter}");
            assert!(!found.rejected, "matter: {matter}");
        }

        let no_front_matter = document_title("# Heading\n");
        assert_eq!(no_front_matter.title.as_deref(), Some("Heading"));
        assert!(!no_front_matter.rejected);
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
