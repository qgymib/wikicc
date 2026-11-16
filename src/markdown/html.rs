//! Own-layer HTML serialisation: the one place markup is decided.
//!
//! The serialiser walks the own-layer tree once and emits the body HTML,
//! the plain text for the search index, and the byte offset of every
//! heading — all three from the same walk, so `html`, `text` and `blocks`
//! always describe exactly the same source.
//!
//! Markup is built structurally, never by rewriting HTML strings: every
//! attribute value is escaped on the way in, every link destination is
//! resolved through the document's [`LinkRewriter`] at the moment its
//! element is written (so the resolver sees destinations in document
//! order, with the source line the element starts on), and reference
//! definitions are rendered where the tree has them.
//!
//! The heading offsets make the chapter blocks: a block starts where its
//! heading starts, and [`sections::slice`] cuts the body there — no
//! markers, no stripping, nothing the body HTML has to hide.

use std::collections::BTreeMap;

use markdown::mdast::{AlignKind, ReferenceKind};

use super::ast::{OwnKind, OwnNode};
use super::highlight::{code_block_html, escape_into};
use super::links::{LinkClass, classify};
use super::refdefs::{ReferenceTable, definition_html, definition_text};
use super::sections;
use super::toc::Heading;
use super::{LinkRewriter, missing_link_attributes};

/// Serialise the document root.
///
/// Returns the body HTML, the plain text (before whitespace collapsing) and
/// the chapter blocks. `headings` supplies each heading's anchor in document
/// order, exactly as the anchor collection produced them; `footnotes` holds
/// each footnote definition's 1-based display number, in definition order.
pub(crate) fn serialize<R: LinkRewriter + ?Sized>(
    root: &OwnNode,
    headings: &[Heading],
    footnotes: &BTreeMap<String, u32>,
    definitions: &mut ReferenceTable,
    rewriter: &mut R,
) -> (String, String, Vec<sections::Block>) {
    let mut serializer = Serializer {
        rewriter,
        definitions,
        headings,
        heading_index: 0,
        footnotes,
        html: String::new(),
        text: String::new(),
        starts: Vec::new(),
        ids: Vec::new(),
        levels: Vec::new(),
    };

    if let OwnKind::Root(children) = &root.kind {
        serializer.blocks(children);
    }

    let Serializer {
        html,
        text,
        starts,
        ids,
        levels,
        ..
    } = serializer;
    let blocks = sections::slice(&html, &starts, &ids, &levels);
    (html, text, blocks)
}

/// The serialiser state for one document.
struct Serializer<'a, R: LinkRewriter + ?Sized> {
    rewriter: &'a mut R,
    /// The definitions not yet rendered; the first of every label is
    /// rendered where its node sits in the tree, repeats are skipped.
    definitions: &'a mut ReferenceTable,
    /// Heading anchors in document order, consumed positionally.
    headings: &'a [Heading],
    heading_index: usize,
    /// Footnote definition display numbers.
    footnotes: &'a BTreeMap<String, u32>,
    /// Body HTML built so far.
    html: String,
    /// Plain text built so far.
    text: String,
    /// Byte offset of every heading start, in document order.
    starts: Vec<usize>,
    /// Anchor of every heading, in document order.
    ids: Vec<String>,
    /// Level of every heading, in document order.
    levels: Vec<u32>,
}

impl<R: LinkRewriter + ?Sized> Serializer<'_, R> {
    /// Render a run of block-level nodes.
    fn blocks(&mut self, children: &[OwnNode]) {
        for child in children {
            self.block(child);
        }
    }

    /// Render one block-level node, with its trailing newline.
    fn block(&mut self, node: &OwnNode) {
        match &node.kind {
            OwnKind::Paragraph(children) => {
                self.separate();
                self.html.push_str("<p>");
                self.inline(children);
                self.html.push_str("</p>\n");
            }
            OwnKind::Heading { depth, children } => {
                self.separate();
                // A chapter starts exactly where its heading starts.
                self.starts.push(self.html.len());
                let anchor = self
                    .headings
                    .get(self.heading_index)
                    .map(|heading| heading.id.clone())
                    .unwrap_or_default();
                self.heading_index += 1;
                self.ids.push(anchor.clone());
                self.levels.push(u32::from(*depth));
                self.html.push_str("<h");
                self.html.push_str(&depth.to_string());
                self.html.push_str(" id=\"");
                escape_into(&mut self.html, &anchor);
                self.html.push_str("\">");
                self.inline(children);
                self.html.push_str("</h");
                self.html.push_str(&depth.to_string());
                self.html.push_str(">\n");
            }
            OwnKind::Blockquote(children) => {
                self.separate();
                self.html.push_str("<blockquote>\n");
                self.blocks(children);
                self.html.push_str("</blockquote>\n");
            }
            OwnKind::Callout {
                kind,
                title,
                children,
            } => {
                self.separate();
                self.html.push_str("<div class=\"callout\" data-callout=\"");
                escape_into(&mut self.html, kind);
                self.html.push_str("\">\n<p class=\"callout-title\">");
                self.inline(title);
                self.html
                    .push_str("</p>\n<div class=\"callout-content\">\n");
                self.blocks(children);
                self.html.push_str("</div>\n</div>\n");
            }
            OwnKind::List {
                ordered,
                start,
                children,
            } => {
                self.separate();
                if *ordered {
                    match start {
                        Some(value) if *value != 1 => {
                            self.html.push_str("<ol start=\"");
                            self.html.push_str(&value.to_string());
                            self.html.push_str("\">\n");
                        }
                        _ => self.html.push_str("<ol>\n"),
                    }
                    self.blocks(children);
                    self.html.push_str("</ol>\n");
                } else {
                    self.html.push_str("<ul>\n");
                    self.blocks(children);
                    self.html.push_str("</ul>\n");
                }
            }
            OwnKind::ListItem {
                checked,
                spread,
                children,
            } => {
                self.separate();
                self.html.push_str("<li>");
                if let Some(done) = checked {
                    self.html.push_str(if *done {
                        "<input disabled=\"\" type=\"checkbox\" checked=\"\"/>"
                    } else {
                        "<input disabled=\"\" type=\"checkbox\"/>"
                    });
                }
                for (index, child) in children.iter().enumerate() {
                    match &child.kind {
                        // A tight item renders its paragraphs without the
                        // wrapper the block form would add.
                        OwnKind::Paragraph(paragraph) if !spread => {
                            if index > 0 {
                                self.html.push('\n');
                            }
                            self.inline(paragraph);
                        }
                        _ => self.block(child),
                    }
                }
                self.html.push_str("</li>\n");
            }
            OwnKind::Table { align, children } => {
                self.separate();
                self.html.push_str("<table><thead><tr>");
                let mut rows = children.iter();
                if let Some(row) = rows.next() {
                    self.table_row(row, "th", align);
                }
                self.html.push_str("</tr></thead><tbody>\n");
                for row in rows {
                    self.html.push_str("<tr>");
                    self.table_row(row, "td", align);
                    self.html.push_str("</tr>\n");
                }
                self.html.push_str("</tbody></table>\n");
            }
            OwnKind::TableRow(_) | OwnKind::TableCell(_) => {
                // Table rows and cells are rendered by their table; a stray
                // one has no markup of its own.
            }
            OwnKind::Code { lang, value } => {
                self.separate();
                self.text.push_str(value);
                // The highlighter walks lines with their endings, so the code
                // always ends with a newline — the parser leaves the last one
                // off, and the old event stream always carried it.
                let terminated = if value.ends_with('\n') {
                    value.clone()
                } else {
                    format!("{value}\n")
                };
                self.html
                    .push_str(&code_block_html(&terminated, lang.as_deref()));
            }
            OwnKind::Math { value } => {
                self.separate();
                self.text.push_str(value);
                self.html.push_str("<pre class=\"math\">");
                escape_text(&mut self.html, value);
                self.html.push_str("</pre>\n");
            }
            OwnKind::Html { value } => {
                self.separate();
                self.text.push_str(value);
                self.html.push_str(value);
                if !value.ends_with('\n') {
                    self.html.push('\n');
                }
            }
            OwnKind::Definition { identifier, .. } => {
                // Only the first definition of a label renders; the repeats
                // the tree still holds are the parser's record, not content.
                if let Some(definition) = self.definitions.take_first(identifier) {
                    self.separate();
                    self.text.push_str(&definition_text(&definition));
                    self.html
                        .push_str(&definition_html(&definition, self.rewriter, node.line));
                }
            }
            OwnKind::FootnoteDefinition {
                identifier,
                children,
                ..
            } => {
                self.separate();
                self.html
                    .push_str("<div class=\"footnote-definition\" id=\"");
                escape_into(&mut self.html, identifier);
                self.html
                    .push_str("\">\n<sup class=\"footnote-definition-label\">");
                let number = self.footnotes.get(identifier).copied().unwrap_or(0);
                self.html.push_str(&number.to_string());
                self.html.push_str("</sup>");
                self.blocks(children);
                self.html.push_str("</div>\n");
            }
            OwnKind::ThematicBreak => {
                self.separate();
                self.html.push_str("<hr />\n");
            }
            OwnKind::Yaml => {}
            // Phrasing nodes have no block markup; the walk reaches them
            // through the container branches above.
            OwnKind::Text(_)
            | OwnKind::InlineCode(_)
            | OwnKind::InlineMath(_)
            | OwnKind::Emphasis(_)
            | OwnKind::Strong(_)
            | OwnKind::Delete(_)
            | OwnKind::Break
            | OwnKind::Link { .. }
            | OwnKind::Image { .. }
            | OwnKind::ImageReference { .. }
            | OwnKind::FootnoteReference { .. }
            | OwnKind::LinkReference { .. }
            | OwnKind::Highlight(_)
            | OwnKind::Sub(_)
            | OwnKind::Sup(_)
            | OwnKind::Tag(_)
            | OwnKind::Shortcode { .. }
            | OwnKind::Wikilink { .. }
            | OwnKind::Embed { .. } => {
                self.inline(std::slice::from_ref(node));
            }
            OwnKind::Root(_) => {
                // A root inside a root is not a thing the parser produces;
                // render its children rather than dropping them.
                if let Some(children) = node.children() {
                    let children = children.clone();
                    self.blocks(&children);
                }
            }
        }
    }

    /// Render one table row as `<th>` (the header) or `<td>` cells.
    fn table_row(&mut self, row: &OwnNode, tag: &str, align: &[AlignKind]) {
        let OwnKind::TableRow(cells) = &row.kind else {
            return;
        };
        for (index, cell) in cells.iter().enumerate() {
            self.html.push('<');
            self.html.push_str(tag);
            if let Some(kind) = align.get(index) {
                match kind {
                    AlignKind::Left => self.html.push_str(" style=\"text-align: left\""),
                    AlignKind::Right => self.html.push_str(" style=\"text-align: right\""),
                    AlignKind::Center => self.html.push_str(" style=\"text-align: center\""),
                    AlignKind::None => {}
                }
            }
            self.html.push('>');
            if let OwnKind::TableCell(children) = &cell.kind {
                self.separate();
                self.inline(children);
            }
            self.html.push_str("</");
            self.html.push_str(tag);
            self.html.push('>');
        }
    }

    /// Render a run of phrasing content.
    fn inline(&mut self, children: &[OwnNode]) {
        for node in children {
            self.inline_node(node);
        }
    }

    /// Render one phrasing node.
    fn inline_node(&mut self, node: &OwnNode) {
        match &node.kind {
            OwnKind::Text(value) => {
                self.text.push_str(value);
                escape_text(&mut self.html, value);
            }
            OwnKind::InlineCode(value) => {
                self.text.push_str(value);
                self.html.push_str("<code>");
                escape_text(&mut self.html, value);
                self.html.push_str("</code>");
            }
            OwnKind::InlineMath(value) => {
                self.text.push_str(value);
                self.html.push_str("<code class=\"math-inline\">");
                escape_text(&mut self.html, value);
                self.html.push_str("</code>");
            }
            OwnKind::Emphasis(children) => self.wrapped("em", children),
            OwnKind::Strong(children) => self.wrapped("strong", children),
            OwnKind::Delete(children) => self.wrapped("del", children),
            OwnKind::Highlight(children) => self.wrapped("mark", children),
            OwnKind::Sub(children) => self.wrapped("sub", children),
            OwnKind::Sup(children) => self.wrapped("sup", children),
            OwnKind::Break => {
                self.text.push(' ');
                self.html.push_str("<br />\n");
            }
            OwnKind::Html { value } => {
                self.text.push_str(value);
                self.html.push_str(value);
            }
            OwnKind::Link {
                url,
                title,
                children,
            } => {
                let target = self.rewriter.rewrite(url, node.line);
                self.open_anchor(&target, title.as_deref());
                self.inline(children);
                self.html.push_str("</a>");
            }
            OwnKind::Image { url, title, alt } => {
                let target = self.rewriter.rewrite(url, node.line);
                self.text.push_str(alt);
                self.html.push_str("<img src=\"");
                escape_into(&mut self.html, &target.dest);
                self.html.push_str("\" alt=\"");
                escape_into(&mut self.html, alt);
                self.image_title(title.as_deref());
            }
            OwnKind::ImageReference {
                identifier,
                label,
                alt,
            } => match self.definitions.resolve(identifier) {
                Some(resolved) => {
                    let (url, title) = (resolved.url.clone(), resolved.title.clone());
                    let target = self.rewriter.rewrite(&url, node.line);
                    self.text.push_str(alt);
                    self.html.push_str("<img src=\"");
                    escape_into(&mut self.html, &target.dest);
                    self.html.push_str("\" alt=\"");
                    escape_into(&mut self.html, alt);
                    self.image_title(title.as_deref());
                }
                None => {
                    // An unresolved image reference is the author's text.
                    let shown = label.clone().unwrap_or_else(|| identifier.clone());
                    self.text.push_str(alt);
                    self.html.push_str("![");
                    escape_text(&mut self.html, &shown);
                    self.html.push(']');
                }
            },
            OwnKind::FootnoteReference { identifier, label } => {
                let shown = label.clone().unwrap_or_else(|| identifier.clone());
                self.text.push_str(&shown);
                self.html
                    .push_str("<sup class=\"footnote-reference\"><a href=\"#");
                escape_into(&mut self.html, identifier);
                self.html.push_str("\">");
                escape_text(&mut self.html, &shown);
                self.html.push_str("</a></sup>");
            }
            OwnKind::LinkReference {
                identifier,
                label,
                kind,
                children,
            } => match self.definitions.resolve(identifier) {
                Some(resolved) => {
                    let (url, title) = (resolved.url.clone(), resolved.title.clone());
                    let target = self.rewriter.rewrite(&url, node.line);
                    self.open_anchor(&target, title.as_deref());
                    self.inline(children);
                    self.html.push_str("</a>");
                }
                None => {
                    // An unresolved reference is the author's text: it renders
                    // exactly as written, so the mistake stays visible.
                    let shown = label.clone().unwrap_or_else(|| identifier.clone());
                    self.text.push_str(&shown);
                    self.html.push('[');
                    escape_text(&mut self.html, &shown);
                    self.html.push_str(&reference_suffix(*kind, identifier));
                }
            },
            OwnKind::Tag(name) => {
                self.text.push('#');
                self.text.push_str(name);
                self.html.push_str("<span class=\"doc-tag\">#");
                escape_text(&mut self.html, name);
                self.html.push_str("</span>");
            }
            OwnKind::Shortcode { emoji, .. } => {
                self.text.push(*emoji);
                self.html.push(*emoji);
            }
            OwnKind::Wikilink { target, alias } => {
                let destination = wikilink_destination(target);
                let rewritten = self.rewriter.rewrite(&destination, node.line);
                self.text.push_str(alias.as_deref().unwrap_or(target));
                self.open_anchor(&rewritten, None);
                escape_text(&mut self.html, alias.as_deref().unwrap_or(target));
                self.html.push_str("</a>");
            }
            OwnKind::Embed { target } => {
                let destination = wikilink_destination(target);
                let rewritten = self.rewriter.rewrite(&destination, node.line);
                self.text.push_str(target);
                match classify(&destination) {
                    // An embed of a local file shows the file itself.
                    LinkClass::LocalAsset { .. } => {
                        self.html.push_str("<img src=\"");
                        escape_into(&mut self.html, &rewritten.dest);
                        self.html.push_str("\" alt=\"");
                        escape_into(&mut self.html, target);
                        self.html.push_str("\" />");
                    }
                    // Anything else cannot be embedded; a link is what is
                    // still true about it.
                    _ => {
                        self.open_anchor(&rewritten, None);
                        escape_text(&mut self.html, target);
                        self.html.push_str("</a>");
                    }
                }
            }
            // Containers reached through their block branch.
            OwnKind::Paragraph(_)
            | OwnKind::Heading { .. }
            | OwnKind::Blockquote(_)
            | OwnKind::Callout { .. }
            | OwnKind::List { .. }
            | OwnKind::ListItem { .. }
            | OwnKind::Table { .. }
            | OwnKind::TableRow(_)
            | OwnKind::TableCell(_)
            | OwnKind::Code { .. }
            | OwnKind::Math { .. }
            | OwnKind::Definition { .. }
            | OwnKind::FootnoteDefinition { .. }
            | OwnKind::ThematicBreak
            | OwnKind::Yaml
            | OwnKind::Root(_) => {}
        }
    }

    /// Open an `<a>` with the rewritten destination and any extra attributes
    /// a missing chapter carries.
    fn open_anchor(&mut self, target: &super::LinkTarget, title: Option<&str>) {
        if let Some(anchor) = &target.missing_anchor {
            self.html.push_str("<span hidden");
            self.html.push_str(&missing_link_attributes(anchor));
            self.html.push_str("></span>");
        }
        self.html.push_str("<a href=\"");
        escape_into(&mut self.html, &target.dest);
        self.html.push('"');
        if target.new_tab {
            self.html.push_str(super::NEW_TAB_ATTRIBUTES);
        }
        if let Some(title) = title {
            self.html.push_str(" title=\"");
            escape_into(&mut self.html, title);
            self.html.push('"');
        }
        self.html.push('>');
    }

    /// Close an `<img>`: the title attribute or the self-closing slash.
    fn image_title(&mut self, title: Option<&str>) {
        match title {
            Some(title) => {
                self.html.push_str("\" title=\"");
                escape_into(&mut self.html, title);
                self.html.push_str("\" />");
            }
            None => self.html.push_str("\" />"),
        }
    }

    /// Render children inside one inline element.
    fn wrapped(&mut self, element: &str, children: &[OwnNode]) {
        self.html.push('<');
        self.html.push_str(element);
        self.html.push('>');
        self.inline(children);
        self.html.push_str("</");
        self.html.push_str(element);
        self.html.push('>');
    }

    /// Append one space unless the text is empty or already ends with
    /// whitespace: block boundaries must not glue words together, and must
    /// not produce runs of spaces either.
    fn separate(&mut self) {
        if !self.text.is_empty() && !self.text.ends_with(char::is_whitespace) {
            self.text.push(' ');
        }
    }
}

/// The literal suffix an unresolved reference renders with.
fn reference_suffix(kind: ReferenceKind, identifier: &str) -> String {
    match kind {
        ReferenceKind::Shortcut => "]".to_string(),
        ReferenceKind::Collapsed => "][]".to_string(),
        // The full form cannot recover the author's spelling of its second
        // label, so the normalised identifier stands in.
        ReferenceKind::Full => format!("][{identifier}]"),
    }
}

/// Where a wikilink's target points: an extensionless target is a note name
/// and names a document.
fn wikilink_destination(target: &str) -> String {
    if std::path::Path::new(target).extension().is_none() {
        format!("{target}.md")
    } else {
        target.to_string()
    }
}

/// Escape the characters HTML treats as markup in text and code content.
///
/// Quotes stay verbatim: the value is never written into an attribute, and
/// the rendered document keeps the author's quotation marks readable.
fn escape_text(html: &mut String, value: &str) {
    for character in value.chars() {
        match character {
            '&' => html.push_str("&amp;"),
            '<' => html.push_str("&lt;"),
            '>' => html.push_str("&gt;"),
            _ => html.push(character),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::markdown::{
        LinkRewriter, LinkTarget, NoRewrite, render_document, render_document_with,
    };

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
    fn destinations_inside_code_blocks_are_not_rewritten() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("```\n[a](a.md)\n```\n", &mut recorder);

        assert!(recorder.seen.is_empty(), "seen: {:?}", recorder.seen);
        assert!(doc.html.contains("[a](a.md)"), "html: {}", doc.html);
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
}
