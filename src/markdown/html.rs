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
