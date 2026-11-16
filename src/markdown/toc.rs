//! Chapter outline built from the heading sequence of one document.
//!
//! Rendering collects [`Heading`] values in document order; [`build_toc`] turns
//! them into the nested [`TocEntry`] tree the reader's right column renders.
//!
//! Nesting is derived from level transitions alone, never from a fixed
//! H1/H2/H3 skeleton, so a document that starts at `###` or jumps from `#` to
//! `###` still produces one connected outline instead of losing entries or
//! inventing empty parents.

use serde::{Deserialize, Serialize};

use super::ast::{OwnKind, OwnNode};
use super::slug::Slugger;

/// One heading as collected while rendering a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    /// Heading level, 1–6.
    pub level: u32,
    /// Anchor emitted on the heading element.
    pub id: String,
    /// Heading text with inline markup removed and whitespace collapsed.
    pub text: String,
}

/// Plain text of a heading, built from the events between its tags.
///
/// The renderer feeds this while it walks the document; the anchor pre-pass
/// feeds it from a scan of the same events. Both routes must agree exactly,
/// because a heading's text decides its slug and therefore whether a link to
/// `#that-heading` resolves, so the folding lives here instead of in either
/// caller.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeadingText {
    text: String,
}

impl HeadingText {
    /// Empty accumulator.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an inline run of text or code.
    pub fn push(&mut self, value: &str) {
        self.text.push_str(value);
    }

    /// Add the single space a soft or hard break reads as.
    pub fn push_break(&mut self) {
        self.text.push(' ');
    }

    /// Add the replacement text of any other inline event (an image's alt
    /// text, a footnote marker, a raw HTML run).
    pub fn push_other(&mut self, value: &str) {
        self.text.push_str(value);
    }

    /// Drop everything after `len` bytes, used when a folded citation rewrites
    /// the heading text in place.
    pub fn truncate(&mut self, len: usize) {
        self.text.truncate(len.min(self.text.len()));
    }

    /// Current byte length of the collected text.
    pub fn len(&self) -> usize {
        self.text.len()
    }

    /// Whether nothing has been collected.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// Collapsed, finished heading text.
    pub fn finish(&self) -> String {
        collapse_whitespace(&self.text)
    }
}

/// Collapse runs of whitespace into single spaces and trim the ends.
pub fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One node of the nested chapter outline.
///
/// The tree is serialised verbatim into the site payload (see
/// [`crate::site::DocModel`]), so the front end walks exactly the structure the
/// renderer built and no second outline model exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TocEntry {
    /// Anchor of the heading this entry points at.
    pub id: String,
    /// Heading text, plain.
    pub text: String,
    /// Heading level, 1–6.
    pub level: u32,
    /// Deeper headings that belong to this one.
    pub children: Vec<TocEntry>,
}

impl TocEntry {
    /// Leaf entry for one collected heading.
    fn from_heading(heading: &Heading) -> Self {
        Self {
            id: heading.id.clone(),
            text: heading.text.clone(),
            level: heading.level,
            children: Vec::new(),
        }
    }
}

/// Build the nested outline for `headings`, which must be in document order.
///
/// The first heading always becomes a root; every later heading is attached to
/// the closest preceding heading with a smaller level, or becomes a root when
/// there is none. An empty document yields an empty outline.
pub fn build_toc(headings: &[Heading]) -> Vec<TocEntry> {
    let mut roots: Vec<TocEntry> = Vec::new();
    // Indices from a root down to the entry opened last, e.g. `[0, 2]`.
    let mut path: Vec<usize> = Vec::new();

    for heading in headings {
        // Close every open entry that is at the same level or deeper.
        while !path.is_empty() {
            if entry_at(&roots, &path).level < heading.level {
                break;
            }
            path.pop();
        }

        let entry = TocEntry::from_heading(heading);
        if path.is_empty() {
            roots.push(entry);
            path.push(roots.len() - 1);
        } else {
            let parent = entry_at_mut(&mut roots, &path);
            parent.children.push(entry);
            let index = parent.children.len() - 1;
            path.push(index);
        }
    }

    roots
}

/// Anchors of `headings`, in document order.
pub fn anchors(headings: &[Heading]) -> Vec<String> {
    headings.iter().map(|heading| heading.id.clone()).collect()
}

/// Collect every heading, assigning its anchor.
///
/// The slugger sees the headings in document order, so the anchors are the
/// same whatever pass collects them — the render pass serialises exactly
/// this list.
pub(crate) fn collect_headings(node: &OwnNode, slugger: &mut Slugger, out: &mut Vec<Heading>) {
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

/// Entry addressed by `path`, which must be non-empty and valid.
fn entry_at<'a>(entries: &'a [TocEntry], path: &[usize]) -> &'a TocEntry {
    let (first, rest) = path
        .split_first()
        .expect("a non-empty path addresses a TOC entry");
    let entry = &entries[*first];

    if rest.is_empty() {
        entry
    } else {
        entry_at(&entry.children, rest)
    }
}

/// Mutable counterpart of [`entry_at`].
fn entry_at_mut<'a>(entries: &'a mut [TocEntry], path: &[usize]) -> &'a mut TocEntry {
    let (first, rest) = path
        .split_first()
        .expect("a non-empty path addresses a TOC entry");
    let entry = &mut entries[*first];

    if rest.is_empty() {
        entry
    } else {
        entry_at_mut(&mut entry.children, rest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::{
        LinkRewriter, LinkTarget, RenderedDoc, render_document, render_document_with,
    };

    fn heading(level: u32, text: &str) -> Heading {
        Heading {
            level,
            id: text.to_lowercase().replace(' ', "-"),
            text: text.to_string(),
        }
    }

    /// Flatten the outline into `(level, text)` pairs for compact assertions.
    fn flattened(entries: &[TocEntry]) -> Vec<(u32, String)> {
        let mut flat = Vec::new();
        for entry in entries {
            flat.push((entry.level, entry.text.clone()));
            flat.extend(flattened(&entry.children));
        }
        flat
    }

    #[test]
    fn empty_document_has_no_outline() {
        assert!(build_toc(&[]).is_empty());
    }

    #[test]
    fn nests_headings_under_their_parent() {
        let headings = [
            heading(1, "Top"),
            heading(2, "Section"),
            heading(3, "Detail"),
            heading(2, "Other"),
        ];

        let toc = build_toc(&headings);

        assert_eq!(toc.len(), 1, "one root");
        assert_eq!(toc[0].text, "Top");
        assert_eq!(toc[0].children.len(), 2);
        assert_eq!(toc[0].children[0].text, "Section");
        assert_eq!(toc[0].children[0].children.len(), 1);
        assert_eq!(toc[0].children[0].children[0].text, "Detail");
        assert_eq!(toc[0].children[1].text, "Other");
    }

    #[test]
    fn level_jumps_nest_under_the_last_shallower_heading() {
        let headings = [heading(1, "Top"), heading(3, "Deep"), heading(4, "Deeper")];

        let toc = build_toc(&headings);

        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].children.len(), 1, "H3 attaches directly to H1");
        assert_eq!(toc[0].children[0].text, "Deep");
        assert_eq!(toc[0].children[0].children[0].text, "Deeper");
    }

    #[test]
    fn document_starting_below_level_one_still_has_a_root() {
        let toc = build_toc(&[heading(3, "Deep"), heading(4, "Deeper")]);

        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].level, 3);
        assert_eq!(toc[0].children[0].text, "Deeper");
    }

    #[test]
    fn same_level_headings_are_siblings() {
        let toc = build_toc(&[heading(2, "A"), heading(2, "B"), heading(2, "C")]);

        assert_eq!(toc.len(), 3);
        assert!(toc.iter().all(|entry| entry.children.is_empty()));
    }

    #[test]
    fn deeper_document_order_is_preserved() {
        let headings = [
            heading(1, "A"),
            heading(2, "A1"),
            heading(3, "A1a"),
            heading(2, "A2"),
            heading(1, "B"),
            heading(2, "B1"),
        ];

        let toc = build_toc(&headings);

        assert_eq!(
            flattened(&toc),
            [
                (1, "A".to_string()),
                (2, "A1".to_string()),
                (3, "A1a".to_string()),
                (2, "A2".to_string()),
                (1, "B".to_string()),
                (2, "B1".to_string()),
            ]
        );
    }

    #[test]
    fn six_levels_nest_without_losing_entries() {
        let headings: Vec<Heading> = (1..=6).map(|level| heading(level, "level")).collect();

        let toc = build_toc(&headings);

        assert_eq!(toc.len(), 1);
        assert_eq!(flattened(&toc).len(), 6);
        assert_eq!(toc[0].children[0].children[0].level, 3);
    }

    #[test]
    fn entries_carry_the_heading_anchor_and_level() {
        let toc = build_toc(&[Heading {
            level: 2,
            id: "hello-world".to_string(),
            text: "Hello, World!".to_string(),
        }]);

        assert_eq!(toc[0].id, "hello-world");
        assert_eq!(toc[0].text, "Hello, World!");
        assert_eq!(toc[0].level, 2);
    }

    // The outline as the full render produces it.

    fn heading_ids(doc: &RenderedDoc) -> Vec<&str> {
        doc.toc.iter().map(|entry| entry.id.as_str()).collect()
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
    fn heading_text_collapses_whitespace() {
        let doc = render_document("## Spaced   out\n");

        assert_eq!(doc.toc[0].text, "Spaced out");
    }

    #[test]
    fn code_block_followed_by_a_heading_keeps_the_outline() {
        let doc = render_document("```rust\nfn main() {}\n```\n\n## After\n");

        assert_eq!(doc.toc.len(), 1);
        assert_eq!(doc.toc[0].text, "After");
        assert!(doc.html.contains("<h2 id=\"after\">"), "html: {}", doc.html);
    }

    #[test]
    fn rewriting_does_not_change_heading_slugs() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("## [Guide](guide.md)\n", &mut recorder);

        assert_eq!(doc.toc[0].id, "guide");
        assert_eq!(doc.toc[0].text, "Guide");
        assert_eq!(recorder.seen, [("guide.md".to_string(), 1)]);
    }
}
