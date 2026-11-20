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
//!    `~subscript~`, `^superscript^`, `%%comments%%`, `:shortcodes:`),
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
use markdown::mdast::Node;
use sections::Block;
use serde_yaml::{Mapping, Value};
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

    let (html, text, blocks) =
        html::serialize(&tree, &headings, &footnotes, &mut definitions, rewriter);

    RenderedDoc {
        html,
        toc: build_toc(&headings),
        blocks,
        text: collapse_whitespace(&text),
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

/// The front matter metadata and title a document asks for.
///
/// `title` falls back to the first level-one heading when the front matter
/// does not name one; every other field is carried as read. A field the
/// author named but that cannot become what it promises leaves `None` (or an
/// empty tag list) and raises its `*_rejected` flag, which the scan reports
/// as a warning — a broken instruction must not build into a silent
/// surprise.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DocFrontMatter {
    /// The title to use: the front matter `title` when it is usable text,
    /// else the first level-one heading. `None` leaves the scan to the file
    /// stem and `Untitled`.
    pub title: Option<String>,
    /// A `title` key existed but its value cannot become a title; the scan
    /// reports that and falls back.
    pub title_rejected: bool,
    /// Front matter `description` when it is usable text.
    pub description: Option<String>,
    /// A `description` key existed but its value cannot become text.
    pub description_rejected: bool,
    /// Front matter `date` when it carries an ISO 8601 date shape.
    pub date: Option<String>,
    /// A `date` key existed but its value does not spell an ISO 8601 date.
    pub date_rejected: bool,
    /// Front matter `author` when it is usable text.
    pub author: Option<String>,
    /// An `author` key existed but its value cannot become text.
    pub author_rejected: bool,
    /// Front matter `tags`, normalized: trimmed, a leading `#` stripped,
    /// empties dropped, first occurrences kept.
    pub tags: Vec<String>,
    /// A `tags` key existed but its value cannot become a list of names.
    pub tags_rejected: bool,
}

/// The front matter metadata and title a document asks for.
///
/// Used by the scan for every document-level field. One parse serves them
/// all: the raw YAML text is taken off the parsed tree and read once, and
/// the heading fallback reuses the same tree.
///
/// The heading text is collected from the parsed tree, so inline markup
/// (`**bold**`, `` `code` ``, links) is stripped for free and a `#` inside a
/// fenced code block is never mistaken for a heading. Raw HTML contributes
/// nothing: metadata is metadata, and markup fragments have no business in
/// it.
///
/// A front matter `title` wins when it turns into text: a non-empty string
/// (trimmed), a number or a boolean is read as written, and an explicit tag
/// (`!!str 123`) speaks through the value it labels. A key that is missing,
/// `null`, sits in a front matter that is not a mapping, or in YAML that
/// does not parse falls back to the heading silently — broken YAML is the
/// encrypt stage's error, and one diagnostic per problem is enough. A value
/// that exists but cannot become a title — an empty or whitespace string, a
/// sequence, a mapping — sets [`DocFrontMatter::title_rejected`] so the scan
/// can warn.
pub(crate) fn document_front_matter(source: &str) -> DocFrontMatter {
    // One parse serves the front matter and the heading scan: the raw YAML
    // text is taken off the engine tree before the own-layer conversion
    // drops it.
    let parsed = parse::parse_document(source);
    let mut found = DocFrontMatter::default();
    if let Some(raw) = front_matter_text(&parsed)
        && let Some(mapping) = front_matter_mapping(&raw)
    {
        found = front_matter_fields(&mapping);
    }
    if found.title.is_some() {
        return found;
    }

    let tree = prepare_tree(&parsed);
    found.title = first_h1_in_tree(&tree);
    found
}

/// What one front matter key that should become a single text comes to.
enum TextValue {
    /// The key is missing or explicitly null: no opinion.
    Absent,
    /// The value became text.
    Text(String),
    /// The key existed but the value cannot become text.
    Rejected,
}

/// What a front matter `tags` key comes to.
enum TagsValue {
    /// The key is missing or explicitly null: no opinion.
    Absent,
    /// The value became a list of tag names.
    Tags(Vec<String>),
    /// The key existed but the value cannot become a list of names.
    Rejected,
}

/// Every metadata field out of a front matter mapping, each with its own
/// verdict: a field the author named but that cannot become what it promises
/// is rejected, not guessed at.
fn front_matter_fields(mapping: &Mapping) -> DocFrontMatter {
    let mut found = DocFrontMatter::default();

    match text_value(mapping, "title") {
        TextValue::Text(text) => found.title = Some(text),
        TextValue::Rejected => found.title_rejected = true,
        TextValue::Absent => {}
    }
    match text_value(mapping, "description") {
        TextValue::Text(text) => found.description = Some(text),
        TextValue::Rejected => found.description_rejected = true,
        TextValue::Absent => {}
    }
    match date_value(mapping) {
        TextValue::Text(text) => found.date = Some(text),
        TextValue::Rejected => found.date_rejected = true,
        TextValue::Absent => {}
    }
    match text_value(mapping, "author") {
        TextValue::Text(text) => found.author = Some(text),
        TextValue::Rejected => found.author_rejected = true,
        TextValue::Absent => {}
    }
    match tags_value(mapping) {
        TagsValue::Tags(names) => found.tags = names,
        TagsValue::Rejected => found.tags_rejected = true,
        TagsValue::Absent => {}
    }

    found
}

/// The mapping of raw front matter text, `None` when it is not a mapping —
/// a bare scalar, a list, nothing at all names no keys: the front matter is
/// not ours to judge.
fn front_matter_mapping(raw: &str) -> Option<Mapping> {
    match serde_yaml::from_str::<Value>(raw) {
        Ok(Value::Mapping(mapping)) => Some(mapping),
        _ => None,
    }
}

/// The text value of one front matter key.
fn text_value(mapping: &Mapping, key: &str) -> TextValue {
    match mapping.get(Value::from(key)) {
        None | Some(Value::Null) => TextValue::Absent,
        Some(value) => scalar_text(value),
    }
}

/// The `date` value: text that must carry an ISO 8601 date shape.
fn date_value(mapping: &Mapping) -> TextValue {
    match text_value(mapping, "date") {
        TextValue::Text(text) if is_iso_8601_shape(&text) => TextValue::Text(text),
        TextValue::Text(_) => TextValue::Rejected,
        other => other,
    }
}

/// Turn one YAML value into text, or say it cannot become text.
fn scalar_text(value: &Value) -> TextValue {
    match scalar_string(value) {
        None => TextValue::Rejected,
        Some(text) => match text.trim() {
            "" => TextValue::Rejected,
            trimmed => TextValue::Text(trimmed.to_string()),
        },
    }
}

/// The display text of a scalar YAML value: strings as written, numbers and
/// booleans as the engine spells them, tagged values through what they
/// label. Composites name no text.
fn scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Tagged(tagged) => scalar_string(&tagged.value),
        _ => None,
    }
}

/// The `tags` value of a front matter mapping.
///
/// A sequence of scalars is the spelling the field promises; each name is
/// trimmed, one leading `#` is stripped and empties are dropped, so
/// `"#rust"` and `rust` spell the same tag and a document never claims one
/// twice. A bare scalar is tolerated as a one-tag list. A mapping, or a
/// composite element anywhere in the sequence, rejects the whole field: a
/// broken list must not silently become a shorter one.
fn tags_value(mapping: &Mapping) -> TagsValue {
    match mapping.get(Value::from("tags")) {
        None | Some(Value::Null) => TagsValue::Absent,
        Some(Value::Sequence(items)) => match tag_names(items) {
            Some(names) => TagsValue::Tags(names),
            None => TagsValue::Rejected,
        },
        Some(value) => match scalar_text(value) {
            TextValue::Text(text) => {
                TagsValue::Tags(normalized_tag_name(&text).into_iter().collect())
            }
            _ => TagsValue::Rejected,
        },
    }
}

/// The tag names of a sequence of scalar values, `None` when an element
/// cannot become a name.
fn tag_names(items: &[Value]) -> Option<Vec<String>> {
    let mut names = Vec::new();
    for item in items {
        let text = scalar_string(item)?;
        if let Some(name) = normalized_tag_name(&text)
            && !names.contains(&name)
        {
            names.push(name);
        }
    }
    Some(names)
}

/// One tag name out of written text: trimmed, one leading `#` stripped,
/// trimmed again; `None` when nothing is left.
fn normalized_tag_name(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let without_hash = trimmed.strip_prefix('#').unwrap_or(trimmed).trim();
    if without_hash.is_empty() {
        None
    } else {
        Some(without_hash.to_string())
    }
}

/// Whether `text` carries an ISO 8601 date shape: a `YYYY-MM-DD` calendar
/// date, optionally followed by a time (`T`, any case, or a space; `HH:MM`;
/// an optional `:SS`) and a zone (`Z` or `±HH:MM`).
///
/// The shape decides, not the calendar: `2026-13-99` is accepted, because a
/// hand-written `date` is displayed as written and only a shape check keeps
/// the field honest without dragging a date library into the build.
fn is_iso_8601_shape(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 10
        || !digits(&bytes[0..4])
        || bytes[4] != b'-'
        || !digits(&bytes[5..7])
        || bytes[7] != b'-'
        || !digits(&bytes[8..10])
    {
        return false;
    }
    if bytes.len() == 10 {
        return true;
    }

    // The time part: a separator, `HH:MM`, an optional `:SS`, an optional
    // zone.
    let rest = &bytes[10..];
    if !(rest[0] == b'T' || rest[0] == b't' || rest[0] == b' ') {
        return false;
    }
    let time = &rest[1..];
    if time.len() < 5 || !digits(&time[0..2]) || time[2] != b':' || !digits(&time[3..5]) {
        return false;
    }
    let time = &time[5..];
    let time = if time.len() >= 3 && time[0] == b':' && digits(&time[1..3]) {
        &time[3..]
    } else {
        time
    };
    match time {
        [] => true,
        [b'Z'] | [b'z'] => true,
        [sign, hour1, hour2, b':', minute1, minute2] => {
            (*sign == b'+' || *sign == b'-')
                && digits(&[*hour1, *hour2])
                && digits(&[*minute1, *minute2])
        }
        _ => false,
    }
}

/// Whether every byte of `slice` is an ASCII digit.
fn digits(slice: &[u8]) -> bool {
    slice.iter().all(u8::is_ascii_digit)
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
    fn document_front_matter_prefers_the_front_matter_title() {
        let found = document_front_matter("---\ntitle: From the matter\n---\n\n# Heading\n");

        assert_eq!(found.title.as_deref(), Some("From the matter"));
        assert!(!found.title_rejected);
    }

    #[test]
    fn document_front_matter_uses_the_front_matter_without_a_heading() {
        let found = document_front_matter("---\ntitle: Named\n---\n\nno heading\n");

        assert_eq!(found.title.as_deref(), Some("Named"));
        assert!(!found.title_rejected);
    }

    #[test]
    fn document_front_matter_trims_the_front_matter_value() {
        let quoted = document_front_matter("---\ntitle: \"  Spaced  \"\n---\n\n# Heading\n");
        let block = document_front_matter("---\ntitle: |\n  Block title\n---\n\n# Heading\n");

        assert_eq!(quoted.title.as_deref(), Some("Spaced"));
        assert_eq!(block.title.as_deref(), Some("Block title"));
    }

    #[test]
    fn document_front_matter_reads_numbers_and_booleans_as_text() {
        for (raw, expected) in [
            ("title: 123", "123"),
            ("title: 1.5", "1.5"),
            ("title: -7", "-7"),
            ("title: true", "true"),
            ("title: false", "false"),
        ] {
            let found = document_front_matter(&format!("---\n{raw}\n---\n\n# Heading\n"));

            assert_eq!(found.title.as_deref(), Some(expected), "raw: {raw}");
            assert!(!found.title_rejected, "raw: {raw}");
        }
    }

    #[test]
    fn document_front_matter_unwraps_a_tagged_title() {
        let found = document_front_matter("---\ntitle: !!str 42\n---\n\n# Heading\n");

        assert_eq!(found.title.as_deref(), Some("42"));
        assert!(!found.title_rejected);
    }

    #[test]
    fn document_front_matter_rejects_values_that_cannot_become_text() {
        for raw in [
            "title: \"\"",
            "title: \"   \"",
            "title: [a, b]",
            "title: {a: b}",
        ] {
            let found = document_front_matter(&format!("---\n{raw}\n---\n\n# Heading\n"));

            assert_eq!(found.title.as_deref(), Some("Heading"), "raw: {raw}");
            assert!(found.title_rejected, "raw: {raw}");
        }
    }

    #[test]
    fn document_front_matter_falls_back_to_the_heading_silently() {
        for matter in [
            "encrypt: true",
            "other: value",
            "title: null",
            "title:",
            "- one\n- two",
            "title: [unclosed",
        ] {
            let found = document_front_matter(&format!("---\n{matter}\n---\n\n# Heading\n"));

            assert_eq!(found.title.as_deref(), Some("Heading"), "matter: {matter}");
            assert!(!found.title_rejected, "matter: {matter}");
        }

        let no_front_matter = document_front_matter("# Heading\n");
        assert_eq!(no_front_matter.title.as_deref(), Some("Heading"));
        assert!(!no_front_matter.title_rejected);
    }

    #[test]
    fn front_matter_metadata_is_read_verbatim() {
        let found = document_front_matter(
            "---\ntitle: T\ndescription: A short guide\nauthor: 王五\ndate: 2026-01-02\n\
             tags: [rust, go]\n---\n\n# Heading\n",
        );

        assert_eq!(found.description.as_deref(), Some("A short guide"));
        assert_eq!(found.author.as_deref(), Some("王五"));
        assert_eq!(found.date.as_deref(), Some("2026-01-02"));
        assert_eq!(found.tags, ["rust", "go"]);
        assert!(
            !found.description_rejected
                && !found.date_rejected
                && !found.author_rejected
                && !found.tags_rejected
        );
    }

    #[test]
    fn metadata_strings_trim_and_numbers_and_booleans_become_text() {
        let found = document_front_matter(
            "---\ndescription: \"  Spaced  \"\nauthor: 42\ndate: true\n---\n\n# Heading\n",
        );

        assert_eq!(found.description.as_deref(), Some("Spaced"));
        assert_eq!(found.author.as_deref(), Some("42"));
        // A boolean date is text but not an ISO 8601 shape: rejected.
        assert!(found.date_rejected);
        assert_eq!(found.date, None);
        assert!(!found.description_rejected);
        assert!(!found.author_rejected);
    }

    #[test]
    fn metadata_tagged_values_speak_through_their_label() {
        let found = document_front_matter("---\ndescription: !!str 42\n---\n\n# Heading\n");

        assert_eq!(found.description.as_deref(), Some("42"));
        assert!(!found.description_rejected);
    }

    #[test]
    fn unusable_description_and_author_are_rejected() {
        let found =
            document_front_matter("---\ndescription: [a, b]\nauthor: {x: y}\n---\n\n# Heading\n");

        assert_eq!(found.description, None);
        assert!(found.description_rejected);
        assert_eq!(found.author, None);
        assert!(found.author_rejected);
    }

    #[test]
    fn a_missing_or_null_field_is_no_opinion() {
        let found = document_front_matter(
            "---\ndescription:\nauthor: null\ndate:\ntags:\n---\n\n# Heading\n",
        );

        assert_eq!(found.description, None);
        assert!(!found.description_rejected);
        assert_eq!(found.author, None);
        assert!(!found.author_rejected);
        assert_eq!(found.date, None);
        assert!(!found.date_rejected);
        assert!(found.tags.is_empty());
        assert!(!found.tags_rejected);
    }

    #[test]
    fn dates_accept_iso_8601_shapes() {
        for raw in [
            "2026-01-02",
            "2026-01-02T15:04",
            "2026-01-02 15:04:05",
            "2026-01-02T15:04:05+08:00",
            "2026-01-02t15:04z",
        ] {
            let found = document_front_matter(&format!("---\ndate: \"{raw}\"\n---\n\n# Heading\n"));

            assert_eq!(found.date.as_deref(), Some(raw), "raw: {raw}");
            assert!(!found.date_rejected, "raw: {raw}");
        }
    }

    #[test]
    fn dates_outside_the_iso_shape_are_rejected() {
        for raw in [
            "yesterday",
            "2026-1-2",
            "20260102",
            "2026/01/02",
            "2026-01-02 12",
            "2026-01-02T15:04Z07:00",
        ] {
            let found = document_front_matter(&format!("---\ndate: \"{raw}\"\n---\n\n# Heading\n"));

            assert_eq!(found.date, None, "raw: {raw}");
            assert!(found.date_rejected, "raw: {raw}");
        }
    }

    #[test]
    fn tags_normalize_strip_hash_and_dedupe() {
        let found = document_front_matter(
            "---\ntags: [rust, \"#rust\", Rust , \"\", \"#\", go]\n---\n\n# Heading\n",
        );

        assert_eq!(found.tags, ["rust", "Rust", "go"]);
        assert!(!found.tags_rejected);
    }

    #[test]
    fn tags_accept_block_style_a_bare_scalar_and_an_empty_list() {
        let block =
            document_front_matter("---\ntags:\n  - rust\n  - \"#guide\"\n---\n\n# Heading\n");
        assert_eq!(block.tags, ["rust", "guide"]);

        let one = document_front_matter("---\ntags: \"#solo\"\n---\n\n# Heading\n");
        assert_eq!(one.tags, ["solo"]);
        assert!(!one.tags_rejected);

        let none = document_front_matter("---\ntags: []\n---\n\n# Heading\n");
        assert!(none.tags.is_empty());
        assert!(!none.tags_rejected);
    }

    #[test]
    fn composite_tags_reject_the_whole_field() {
        let nested = document_front_matter("---\ntags: [rust, [inner]]\n---\n\n# Heading\n");
        assert!(nested.tags.is_empty());
        assert!(nested.tags_rejected);

        let mapped = document_front_matter("---\ntags: {a: b}\n---\n\n# Heading\n");
        assert!(mapped.tags.is_empty());
        assert!(mapped.tags_rejected);
    }

    #[test]
    fn metadata_never_reaches_a_tree_walk_when_the_title_names_itself() {
        // The heading fallback is the only reason for the tree walk; a
        // document whose front matter names its title skips it. The test
        // observes this indirectly: the front matter title wins even when
        // the body would name another one.
        let found = document_front_matter("---\ntitle: Matter\ndescription: D\n---\n\n# Heading\n");

        assert_eq!(found.title.as_deref(), Some("Matter"));
        assert_eq!(found.description.as_deref(), Some("D"));
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
