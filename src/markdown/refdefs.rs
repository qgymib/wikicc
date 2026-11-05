//! Link reference definitions, rendered where the author wrote them.
//!
//! CommonMark consumes `[1]: https://example.com "title"` as link metadata
//! and never renders it, so a document that collects its sources under a
//! heading reads as an empty section in the reader. Typora shows the
//! definitions in place, and so does this module.
//!
//! In the own-layer tree the definitions are ordinary block nodes
//! ([`OwnKind::Definition`]) that carry their source position, so the
//! serialiser renders them exactly where the tree has them. What this module
//! adds is the *table*: the first definition per label is the one CommonMark
//! resolves references against, the serialiser has to skip the repeats, and
//! the fold has to know whether a `[[n]][n]` run names something at all.
//!
//! Each definition is rendered as one self-contained paragraph by
//! [`definition_html`], from escaped parts, so no HTML string is ever
//! post-processed and author input cannot break out of an attribute. The
//! destination is resolved through the document's [`super::LinkRewriter`],
//! so a definition pointing at another chapter or a local file behaves
//! exactly like the same destination written inline. The visible text stays
//! as the author wrote it, which keeps the entry readable even when the
//! destination is a route or an opaque hash.

use std::collections::BTreeMap;

use super::LinkRewriter;
use super::ast::{OwnKind, OwnNode};
use super::highlight::escape_into;

/// Class of the `<p>` wrapper around one rendered definition.
pub const DEFINITION_CLASS: &str = "link-ref-def";

/// Class of the `[label]:` prefix inside a rendered definition.
pub const DEFINITION_LABEL_CLASS: &str = "link-ref-def-label";

/// One link reference definition, as written in the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReferenceDefinition {
    /// Normalised label the tree's `Definition` node carries.
    pub identifier: String,
    /// Label as the author wrote it, without the brackets and the colon.
    pub label: String,
    /// Destination, without angle brackets and without percent decoding.
    pub dest: String,
    /// Optional title, without its surrounding quotes.
    pub title: Option<String>,
}

/// What a label resolves to, shared by the serialiser and the fold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedDefinition {
    /// Destination the label resolves to.
    pub url: String,
    /// Title the label carries, if any.
    pub title: Option<String>,
}

/// The definitions of one document, in source order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ReferenceTable {
    /// First definition of each label, in document order. The serialiser
    /// walks this list alongside the tree: a `Definition` node is rendered
    /// when it is the next first-of-its-label, and skipped as a repeat
    /// otherwise.
    firsts: Vec<ReferenceDefinition>,
    /// Label → what it resolves to. A label missing here is named by no
    /// definition, which is what keeps an undefined `[[n]][n]` from folding
    /// and keeps `[[page]]` available to the wikilink transform.
    resolved: BTreeMap<String, ResolvedDefinition>,
}

impl ReferenceTable {
    /// What `identifier` resolves to, if anything.
    pub(crate) fn resolve(&self, identifier: &str) -> Option<&ResolvedDefinition> {
        self.resolved.get(identifier)
    }

    /// Advance past the first-of-its-label definition with `identifier`.
    ///
    /// The serialiser calls this when it rendered a `Definition` node, so the
    /// next one in the tree is matched against the next entry here.
    pub(crate) fn take_first(&mut self, identifier: &str) -> Option<ReferenceDefinition> {
        if self
            .firsts
            .first()
            .is_some_and(|first| first.identifier == identifier)
        {
            Some(self.firsts.remove(0))
        } else {
            None
        }
    }
}

/// Collect the definitions of the document, in source order.
///
/// Only the first definition of a label survives: that is CommonMark's rule
/// (a repeated definition is ignored), and the resolution table follows it.
pub(crate) fn collect(root: &OwnNode) -> ReferenceTable {
    let mut firsts: Vec<ReferenceDefinition> = Vec::new();
    let mut resolved: BTreeMap<String, ResolvedDefinition> = BTreeMap::new();
    collect_into(root, &mut firsts, &mut resolved);

    ReferenceTable { firsts, resolved }
}

/// Walk the tree, keeping the first definition of every label.
fn collect_into(
    node: &OwnNode,
    firsts: &mut Vec<ReferenceDefinition>,
    resolved: &mut BTreeMap<String, ResolvedDefinition>,
) {
    if let OwnKind::Definition {
        identifier,
        label,
        url,
        title,
    } = &node.kind
        && !resolved.contains_key(identifier)
    {
        resolved.insert(
            identifier.clone(),
            ResolvedDefinition {
                url: url.clone(),
                title: title.clone(),
            },
        );
        firsts.push(ReferenceDefinition {
            identifier: identifier.clone(),
            label: label.clone().unwrap_or_else(|| identifier.clone()),
            dest: url.clone(),
            title: title.clone(),
        });
    }

    if let Some(children) = node.children() {
        for child in children {
            collect_into(child, firsts, resolved);
        }
    }
}

/// Full `<p class="link-ref-def">…</p>` markup for one definition.
///
/// The entry reads `[label]: destination "title"`, with the destination as
/// the link text and the rewritten destination as its target. Every part is
/// escaped, and the title is wrapped in the ASCII quotes Markdown strips
/// when it parses the definition, so the line mirrors the source.
pub(crate) fn definition_html<R: LinkRewriter + ?Sized>(
    definition: &ReferenceDefinition,
    rewriter: &mut R,
    line: usize,
) -> String {
    let target = rewriter.rewrite(&definition.dest, line);
    let mut html = String::with_capacity(target.dest.len() + definition.label.len() + 64);

    html.push_str("<p class=\"");
    html.push_str(DEFINITION_CLASS);
    html.push_str("\"><span class=\"");
    html.push_str(DEFINITION_LABEL_CLASS);
    html.push_str("\">[");
    escape_into(&mut html, &definition.label);
    html.push_str("]:</span> <a href=\"");
    escape_into(&mut html, &target.dest);
    html.push('"');

    // A definition can name a chapter the way an inline reference can, so it
    // carries the same mark: an entry in the source list is as visible as a
    // reference in a sentence, and both have to warn identically.
    if let Some(anchor) = target.missing_anchor.as_deref() {
        html.push_str(" class=\"");
        html.push_str(super::MISSING_LINK_CLASS);
        html.push_str("\" ");
        html.push_str(super::MISSING_ANCHOR_ATTRIBUTE);
        html.push_str("=\"");
        escape_into(&mut html, anchor);
        html.push('"');
    }

    html.push('>');
    escape_into(&mut html, &definition.dest);
    html.push_str("</a>");

    if let Some(title) = definition.title.as_deref() {
        html.push_str(" \"");
        escape_into(&mut html, title);
        html.push('"');
    }

    html.push_str("</p>\n");
    html
}

/// Plain text of one definition, for the search index.
///
/// Mirrors the rendered entry — `[label]: destination "title"` — so a search
/// hit quotes what the reader can see.
pub(crate) fn definition_text(definition: &ReferenceDefinition) -> String {
    let mut text = String::with_capacity(definition.dest.len() + definition.label.len() + 16);
    text.push('[');
    text.push_str(&definition.label);
    text.push_str("]: ");
    text.push_str(&definition.dest);

    if let Some(title) = definition.title.as_deref() {
        text.push_str(" \"");
        text.push_str(title);
        text.push('"');
    }

    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::ast::to_own;
    use crate::markdown::parse::parse_document;
    use crate::markdown::{LinkTarget, NoRewrite};

    /// Rewriter that tags every destination, so a test can see the handover.
    struct Tagging;

    impl LinkRewriter for Tagging {
        fn rewrite(&mut self, destination: &str, line: usize) -> LinkTarget {
            LinkTarget::new(format!("href:{destination}@{line}"))
        }
    }

    /// Rewriter that reports the destination as a chapter that does not exist.
    struct Missing;

    impl LinkRewriter for Missing {
        fn rewrite(&mut self, destination: &str, _line: usize) -> LinkTarget {
            LinkTarget::missing_chapter(destination.to_string(), "gone")
        }
    }

    fn table(source: &str) -> ReferenceTable {
        collect(&to_own(&parse_document(source)))
    }

    fn definition(source: &str) -> ReferenceDefinition {
        table(source).firsts[0].clone()
    }

    #[test]
    fn definitions_are_collected_with_destination_and_title() {
        let collected = definition("[1]: https://example.com \"Title\"\n");

        assert_eq!(
            collected,
            ReferenceDefinition {
                identifier: "1".to_string(),
                label: "1".to_string(),
                dest: "https://example.com".to_string(),
                title: Some("Title".to_string()),
            }
        );
    }

    #[test]
    fn a_definition_without_a_title_keeps_none() {
        let collected = definition("[note]: guide/intro.md\n");

        assert_eq!(collected.label, "note");
        assert_eq!(collected.dest, "guide/intro.md");
        assert_eq!(collected.title, None);
    }

    #[test]
    fn definitions_are_ordered_by_source_position() {
        let source = "# T\n\n[b]: https://example.com/b\n\n[a]: https://example.com/a\n";
        let collected = table(source);

        assert_eq!(
            collected
                .firsts
                .iter()
                .map(|d| d.label.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"],
            "the tree is in document order"
        );
    }

    #[test]
    fn a_repeated_label_keeps_the_first_definition() {
        let collected = table("[1]: https://example.com/first\n[1]: https://example.com/second\n");

        assert_eq!(collected.firsts.len(), 1);
        assert_eq!(collected.firsts[0].dest, "https://example.com/first");
        assert_eq!(
            collected.resolve("1").map(|resolved| resolved.url.as_str()),
            Some("https://example.com/first")
        );
    }

    #[test]
    fn definitions_inside_code_are_not_collected() {
        let collected = table("```\n[1]: https://example.com\n```\n");

        assert!(collected.firsts.is_empty());
    }

    #[test]
    fn definitions_inside_a_blockquote_are_collected() {
        let collected = table("> [1]: https://example.com\n");

        assert_eq!(collected.firsts.len(), 1);
        assert_eq!(collected.firsts[0].dest, "https://example.com");
    }

    #[test]
    fn resolution_is_case_folding_and_whitespace_stripping() {
        let collected = table("[My Label]: https://example.com\n");

        assert!(
            collected.resolve("mylabel").is_some(),
            "identifiers are normalised, so lookups fold case and drop whitespace: {:?}",
            collected
        );
    }

    #[test]
    fn take_first_hands_out_the_firsts_in_order() {
        let mut collected = table("[b]: b.md\n\n[a]: a.md\n\n[b]: again.md\n");

        assert_eq!(
            collected.take_first("b").map(|first| first.dest),
            Some("b.md".to_string())
        );
        assert_eq!(
            collected.take_first("a").map(|first| first.dest),
            Some("a.md".to_string())
        );
        assert_eq!(
            collected.take_first("b"),
            None,
            "a repeated definition is a repeat in the tree, not a first"
        );
    }

    #[test]
    fn the_markup_reads_as_the_source_line() {
        let definition = ReferenceDefinition {
            identifier: "1".to_string(),
            label: "1".to_string(),
            dest: "https://example.com/a".to_string(),
            title: Some("Title".to_string()),
        };

        assert_eq!(
            definition_html(&definition, &mut NoRewrite, 1),
            "<p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
             <a href=\"https://example.com/a\">https://example.com/a</a> \"Title\"</p>\n"
        );
    }

    #[test]
    fn a_definition_without_a_title_omits_the_quotes() {
        let definition = ReferenceDefinition {
            identifier: "note".to_string(),
            label: "note".to_string(),
            dest: "a.md".to_string(),
            title: None,
        };

        assert_eq!(
            definition_html(&definition, &mut NoRewrite, 1),
            "<p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[note]:</span> \
             <a href=\"a.md\">a.md</a></p>\n"
        );
    }

    #[test]
    fn the_visible_text_keeps_the_destination_and_the_target_is_rewritten() {
        let definition = ReferenceDefinition {
            identifier: "1".to_string(),
            label: "1".to_string(),
            dest: "a.md#x".to_string(),
            title: None,
        };

        assert_eq!(
            definition_html(&definition, &mut Tagging, 7),
            "<p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
             <a href=\"href:a.md#x@7\">a.md#x</a></p>\n"
        );
    }

    #[test]
    fn a_definition_with_a_missing_chapter_carries_the_same_mark() {
        let definition = ReferenceDefinition {
            identifier: "1".to_string(),
            label: "1".to_string(),
            dest: "a.md#gone".to_string(),
            title: None,
        };

        assert_eq!(
            definition_html(&definition, &mut Missing, 1),
            "<p class=\"link-ref-def\"><span class=\"link-ref-def-label\">[1]:</span> \
             <a href=\"a.md#gone\" class=\"doc-link-missing\" \
             data-wikicc-missing-anchor=\"gone\">a.md#gone</a></p>\n"
        );
    }

    #[test]
    fn every_part_is_escaped() {
        let definition = ReferenceDefinition {
            identifier: "a&b".to_string(),
            label: "a\"b".to_string(),
            dest: "https://example.com/?a=1&b=2<a>".to_string(),
            title: Some("it's \"quoted\" & <markup>".to_string()),
        };

        let html = definition_html(&definition, &mut NoRewrite, 1);

        assert!(
            html.contains("<span class=\"link-ref-def-label\">[a&quot;b]:</span>"),
            "html: {html}"
        );
        assert!(
            html.contains("href=\"https://example.com/?a=1&amp;b=2&lt;a&gt;\""),
            "html: {html}"
        );
        assert!(
            html.contains("</a> \"it&#39;s &quot;quoted&quot; &amp; &lt;markup&gt;\"</p>"),
            "the title is escaped and quoted: {html}"
        );
        assert!(!html.contains("<markup>"), "html: {html}");
    }

    #[test]
    fn the_search_text_mirrors_the_rendered_entry() {
        let definition = ReferenceDefinition {
            identifier: "2".to_string(),
            label: "2".to_string(),
            dest: "b.md".to_string(),
            title: Some("B".to_string()),
        };

        assert_eq!(definition_text(&definition), "[2]: b.md \"B\"");
    }

    #[test]
    fn the_search_text_of_an_untitled_definition_stops_at_the_destination() {
        let definition = ReferenceDefinition {
            identifier: "2".to_string(),
            label: "2".to_string(),
            dest: "b.md".to_string(),
            title: None,
        };

        assert_eq!(definition_text(&definition), "[2]: b.md");
    }
}
