//! The own-layer tree: wikicc's model of one parsed document.
//!
//! markdown-rs' mdast cannot be extended with new node types, and the
//! own-layer needs typed homes for the constructs the engine does not know
//! (`==highlight==`, wikilinks, callouts…), so the pipeline converts the
//! parsed tree into [`OwnNode`] once and every later stage — the transforms,
//! the serialiser, the anchor collection — works on that tree only.
//!
//! The model mirrors mdast one-to-one for everything the parser produced
//! (minus the MDX variants the construct set excludes, and minus positional
//! information beyond the one thing the pipeline needs: the 1-based source
//! line a diagnostic quotes, carried by every node). The sugar constructs
//! are the extra variants at the end. Nothing here is serialisable state:
//! the tree lives for one document's render and dies with it.
//!
//! Two traversals serve the transforms: [`for_each_inline_array`] visits
//! every run of phrasing content (a paragraph, a heading, a table cell, the
//! inside of emphasis…), and [`walk_blocks`] additionally descends through
//! block containers. Transforms compose by running one after another over
//! the same tree, in the order the engine decision fixed: citation fold,
//! wikilinks, inline sugar, callouts.

use markdown::mdast::{AlignKind, Node, ReferenceKind};

/// One node of the own-layer tree, with the source line it starts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OwnNode {
    /// 1-based source line, for the resolver's diagnostics.
    pub(crate) line: usize,
    /// What the node is.
    pub(crate) kind: OwnKind,
}

/// What one [`OwnNode`] is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OwnKind {
    // Document and block containers.
    /// The document.
    Root(Vec<OwnNode>),
    /// `> …`
    Blockquote(Vec<OwnNode>),
    /// A paragraph.
    Paragraph(Vec<OwnNode>),
    /// `# …`; `depth` is 1–6.
    Heading { depth: u8, children: Vec<OwnNode> },
    /// `---`
    ThematicBreak,
    /// A list; `start` is the first number of an ordered list.
    List {
        ordered: bool,
        start: Option<u32>,
        children: Vec<OwnNode>,
    },
    /// One list item; `checked` is the GFM task state, `spread` says the
    /// item's blocks are separated by blank lines (the loose-item form).
    ListItem {
        checked: Option<bool>,
        spread: bool,
        children: Vec<OwnNode>,
    },
    /// A GFM table; `align` holds one entry per column.
    Table {
        align: Vec<AlignKind>,
        children: Vec<OwnNode>,
    },
    /// One table row.
    TableRow(Vec<OwnNode>),
    /// One table cell.
    TableCell(Vec<OwnNode>),
    /// A fenced or indented code block.
    Code { lang: Option<String>, value: String },
    /// `$$…$$` block math.
    Math { value: String },
    /// YAML front matter: excluded from every output.
    Yaml,
    /// Raw HTML, flow or phrasing: passed through verbatim.
    Html { value: String },
    /// `[label]: url "title"`.
    Definition {
        identifier: String,
        label: Option<String>,
        url: String,
        title: Option<String>,
    },
    /// `[^label]: …`
    FootnoteDefinition {
        identifier: String,
        label: Option<String>,
        children: Vec<OwnNode>,
    },

    // Phrasing content.
    /// A run of text.
    Text(String),
    /// `` `code` ``
    InlineCode(String),
    /// `$…$` inline math.
    InlineMath(String),
    /// `*…*`
    Emphasis(Vec<OwnNode>),
    /// `**…**`
    Strong(Vec<OwnNode>),
    /// `~~…~~`
    Delete(Vec<OwnNode>),
    /// A soft or hard line break.
    Break,
    /// `[text](url "title")`
    Link {
        url: String,
        title: Option<String>,
        children: Vec<OwnNode>,
    },
    /// `![alt](url "title")`
    Image {
        url: String,
        title: Option<String>,
        alt: String,
    },
    /// `![alt][label]`
    ImageReference {
        identifier: String,
        label: Option<String>,
        alt: String,
    },
    /// `[^label]`
    FootnoteReference {
        identifier: String,
        label: Option<String>,
    },
    /// `[text][label]` / `[label]`, resolved at serialisation time.
    LinkReference {
        identifier: String,
        label: Option<String>,
        kind: ReferenceKind,
        children: Vec<OwnNode>,
    },

    // Own-layer sugar constructs.
    /// `==…==`, rendered as `<mark>`.
    Highlight(Vec<OwnNode>),
    /// `~…~`, rendered as `<sub>`.
    Sub(Vec<OwnNode>),
    /// `^…^`, rendered as `<sup>`.
    Sup(Vec<OwnNode>),
    /// `#tag`, rendered as a tagged span.
    Tag(String),
    /// `:name:`, rendered as the emoji.
    Shortcode { name: String, emoji: char },
    /// `[[target]]` / `[[target|alias]]`.
    Wikilink {
        target: String,
        alias: Option<String>,
    },
    /// `![[target]]`.
    Embed { target: String },
    /// `> [!kind] title`.
    Callout {
        kind: String,
        title: Vec<OwnNode>,
        children: Vec<OwnNode>,
    },
}

impl OwnNode {
    /// A node on `line` of the given kind.
    pub(crate) fn new(line: usize, kind: OwnKind) -> Self {
        Self { line, kind }
    }

    /// The node's children, if it has any.
    pub(crate) fn children(&self) -> Option<&Vec<OwnNode>> {
        match &self.kind {
            OwnKind::Root(children)
            | OwnKind::Blockquote(children)
            | OwnKind::Paragraph(children)
            | OwnKind::List { children, .. }
            | OwnKind::ListItem { children, .. }
            | OwnKind::Table { children, .. }
            | OwnKind::TableRow(children)
            | OwnKind::TableCell(children)
            | OwnKind::FootnoteDefinition { children, .. }
            | OwnKind::Emphasis(children)
            | OwnKind::Strong(children)
            | OwnKind::Delete(children)
            | OwnKind::Link { children, .. }
            | OwnKind::LinkReference { children, .. }
            | OwnKind::Highlight(children)
            | OwnKind::Sub(children)
            | OwnKind::Sup(children)
            | OwnKind::Callout { children, .. } => Some(children),
            OwnKind::Heading { children, .. } => Some(children),
            _ => None,
        }
    }

    /// The node's children, mutably, if it has any.
    pub(crate) fn children_mut(&mut self) -> Option<&mut Vec<OwnNode>> {
        match &mut self.kind {
            OwnKind::Root(children)
            | OwnKind::Blockquote(children)
            | OwnKind::Paragraph(children)
            | OwnKind::List { children, .. }
            | OwnKind::ListItem { children, .. }
            | OwnKind::Table { children, .. }
            | OwnKind::TableRow(children)
            | OwnKind::TableCell(children)
            | OwnKind::FootnoteDefinition { children, .. }
            | OwnKind::Emphasis(children)
            | OwnKind::Strong(children)
            | OwnKind::Delete(children)
            | OwnKind::Link { children, .. }
            | OwnKind::LinkReference { children, .. }
            | OwnKind::Highlight(children)
            | OwnKind::Sub(children)
            | OwnKind::Sup(children)
            | OwnKind::Callout { children, .. } => Some(children),
            OwnKind::Heading { children, .. } => Some(children),
            _ => None,
        }
    }
}

/// Convert the parsed mdast tree into the own-layer tree.
///
/// The conversion is total over the constructs the parser can produce: a
/// variant missing here would silently drop the node from every output, so
/// the match refuses to compile when mdast grows one the construct set
/// enables.
pub(crate) fn to_own(node: &Node) -> OwnNode {
    let line = node
        .position()
        .map(|position| position.start.line)
        .unwrap_or(1);

    let kind = match node {
        Node::Root(x) => OwnKind::Root(x.children.iter().map(to_own).collect()),
        Node::Blockquote(x) => OwnKind::Blockquote(x.children.iter().map(to_own).collect()),
        Node::Paragraph(x) => OwnKind::Paragraph(x.children.iter().map(to_own).collect()),
        Node::Heading(x) => OwnKind::Heading {
            depth: x.depth,
            children: x.children.iter().map(to_own).collect(),
        },
        Node::ThematicBreak(_) => OwnKind::ThematicBreak,
        Node::List(x) => OwnKind::List {
            ordered: x.ordered,
            start: x.start,
            children: x.children.iter().map(to_own).collect(),
        },
        Node::ListItem(x) => OwnKind::ListItem {
            checked: x.checked,
            spread: x.spread,
            children: x.children.iter().map(to_own).collect(),
        },
        Node::Table(x) => OwnKind::Table {
            align: x.align.clone(),
            children: x.children.iter().map(to_own).collect(),
        },
        Node::TableRow(x) => OwnKind::TableRow(x.children.iter().map(to_own).collect()),
        Node::TableCell(x) => OwnKind::TableCell(x.children.iter().map(to_own).collect()),
        Node::Code(x) => OwnKind::Code {
            lang: x.lang.clone(),
            value: x.value.clone(),
        },
        Node::Math(x) => OwnKind::Math {
            value: x.value.clone(),
        },
        Node::Yaml(_) | Node::Toml(_) => OwnKind::Yaml,
        Node::Html(x) => OwnKind::Html {
            value: x.value.clone(),
        },
        Node::Definition(x) => OwnKind::Definition {
            identifier: x.identifier.clone(),
            label: x.label.clone(),
            url: x.url.clone(),
            title: x.title.clone(),
        },
        Node::FootnoteDefinition(x) => OwnKind::FootnoteDefinition {
            identifier: x.identifier.clone(),
            label: x.label.clone(),
            children: x.children.iter().map(to_own).collect(),
        },
        Node::Text(x) => OwnKind::Text(x.value.clone()),
        Node::InlineCode(x) => OwnKind::InlineCode(x.value.clone()),
        Node::InlineMath(x) => OwnKind::InlineMath(x.value.clone()),
        Node::Emphasis(x) => OwnKind::Emphasis(x.children.iter().map(to_own).collect()),
        Node::Strong(x) => OwnKind::Strong(x.children.iter().map(to_own).collect()),
        Node::Delete(x) => OwnKind::Delete(x.children.iter().map(to_own).collect()),
        Node::Break(_) => OwnKind::Break,
        Node::Link(x) => OwnKind::Link {
            url: x.url.clone(),
            title: x.title.clone(),
            children: x.children.iter().map(to_own).collect(),
        },
        Node::Image(x) => OwnKind::Image {
            url: x.url.clone(),
            title: x.title.clone(),
            alt: x.alt.clone(),
        },
        Node::ImageReference(x) => OwnKind::ImageReference {
            identifier: x.identifier.clone(),
            label: x.label.clone(),
            alt: x.alt.clone(),
        },
        Node::FootnoteReference(x) => OwnKind::FootnoteReference {
            identifier: x.identifier.clone(),
            label: x.label.clone(),
        },
        Node::LinkReference(x) => OwnKind::LinkReference {
            identifier: x.identifier.clone(),
            label: x.label.clone(),
            kind: x.reference_kind,
            children: x.children.iter().map(to_own).collect(),
        },
        // MDX constructs are off, so the parser cannot produce these.
        Node::MdxjsEsm(_)
        | Node::MdxFlowExpression(_)
        | Node::MdxTextExpression(_)
        | Node::MdxJsxFlowElement(_)
        | Node::MdxJsxTextElement(_) => return degrade_to_text(node),
    };

    OwnNode::new(line, kind)
}

/// An MDX node that somehow arrived anyway becomes its source text, so the
/// document still renders instead of silently losing a block.
fn degrade_to_text(node: &Node) -> OwnNode {
    OwnNode::new(1, OwnKind::Text(node.to_string()))
}

/// Walk the tree, handing every run of phrasing content to `visit`.
///
/// The walk visits a node's own phrasing run first, then descends: a
/// paragraph's array is visited before the arrays of the emphasis runs
/// inside it, and after the visit the walk continues into whatever the visit
/// left behind, so a transform that rewrites a run into wrapped children
/// does not hide those children from the same visit. A `[[n]][n]` run is
/// always matched within one array — the fold never crosses an inline
/// boundary, exactly as the event-stream fold it replaces did.
pub(crate) fn walk_inline(node: &mut OwnNode, visit: &mut dyn FnMut(&mut Vec<OwnNode>)) {
    if is_inline_parent(&node.kind)
        && let Some(children) = node.children_mut()
    {
        visit(children);
    }
    if let Some(children) = node.children_mut() {
        for child in children.iter_mut() {
            walk_inline(child, visit);
        }
    }
}

/// Whether `kind` holds phrasing content directly.
fn is_inline_parent(kind: &OwnKind) -> bool {
    matches!(
        kind,
        OwnKind::Paragraph(_)
            | OwnKind::Heading { .. }
            | OwnKind::TableCell(_)
            | OwnKind::Emphasis(_)
            | OwnKind::Strong(_)
            | OwnKind::Delete(_)
            | OwnKind::Link { .. }
            | OwnKind::LinkReference { .. }
            | OwnKind::Highlight(_)
            | OwnKind::Sub(_)
            | OwnKind::Sup(_)
    )
}

/// Walk every block container under `node`, descending into phrasing
/// content through [`walk_inline`].
pub(crate) fn walk_blocks(node: &mut OwnNode, visit: &mut dyn FnMut(&mut Vec<OwnNode>)) {
    walk_inline(node, visit);
    if let Some(children) = node.children_mut() {
        for child in children.iter_mut() {
            walk_blocks(child, visit);
        }
    }
}
