//! Link reference definitions, rendered where the author wrote them.
//!
//! CommonMark consumes `[1]: https://example.com "title"` as link metadata and
//! emits no event for it, so a document that collects its sources under a
//! heading reads as an empty section in the reader. Typora shows the
//! definitions in place, and so does this module.
//!
//! The data comes from the parser that is already building the document: once
//! the first pass has run, [`pulldown_cmark::Parser::reference_definitions`]
//! holds every definition of the document together with its source span. The
//! span supplies both the document order — the table itself is a `HashMap` and
//! unordered — and the line a diagnostic quotes.
//!
//! Each definition is emitted as one self-contained `Event::Html` paragraph at
//! its source position, the same route [`super::highlight`] takes for code
//! blocks. The markup is built here, from escaped parts, so no HTML string is
//! ever post-processed and author input cannot break out of an attribute.
//!
//! The destination is resolved through the document's [`LinkRewriter`], so a
//! definition pointing at another chapter or a local file behaves exactly like
//! the same destination written inline: it becomes a route or an asset
//! placeholder, and a broken one is reported with its own line number. The
//! visible text stays as the author wrote it, which keeps the entry readable
//! even when the destination is a route or an opaque hash.

use pulldown_cmark::Parser;

use super::LinkRewriter;
use super::highlight::escape_into;

/// Class of the `<p>` wrapper around one rendered definition.
pub const DEFINITION_CLASS: &str = "link-ref-def";

/// Class of the `[label]:` prefix inside a rendered definition.
pub const DEFINITION_LABEL_CLASS: &str = "link-ref-def-label";

/// One link reference definition, as written in the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReferenceDefinition {
    /// Label as the author wrote it, without the brackets and the colon.
    pub label: String,
    /// Destination, without angle brackets and without percent decoding.
    pub dest: String,
    /// Optional title, without its surrounding quotes.
    pub title: Option<String>,
    /// Byte offset of the definition in the source, used for ordering.
    pub start: usize,
    /// Byte offset one past the end of the definition, used to place it.
    pub end: usize,
}

/// Every definition of `parser`, in source order.
///
/// The parser must be inspected before it is consumed by an iterator, because
/// [`pulldown_cmark::Parser::into_offset_iter`] takes it by value. Only the
/// first definition of a label survives: the parser keeps the first one, which
/// is CommonMark's rule (a repeated definition is ignored).
pub(crate) fn collect(parser: &Parser<'_>) -> Vec<ReferenceDefinition> {
    let definitions = parser.reference_definitions();
    let mut collected: Vec<ReferenceDefinition> = definitions
        .iter()
        // A label is only ever stored in folded form, so the key is exactly
        // what the author wrote in every realistic case; the spans carry the
        // rest of the information the display needs.
        .map(|(label, definition)| ReferenceDefinition {
            label: label.to_string(),
            dest: definition.dest.to_string(),
            title: definition.title.as_ref().map(|title| title.to_string()),
            start: definition.span.start,
            end: definition.span.end,
        })
        .collect();

    // The table is a `HashMap`, so the iteration order is arbitrary. Sorting
    // by the source offset makes the output depend on the document alone.
    collected.sort_by_key(|definition| definition.start);
    collected
}

/// Full `<p class="link-ref-def">…</p>` markup for one definition.
///
/// The entry reads `[label]: destination "title"`, with the destination as the
/// link text and the rewritten destination as its target. Every part is
/// escaped, and the title is wrapped in the ASCII quotes Markdown strips when
/// it parses the definition, so the line mirrors the source.
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
    use crate::markdown::{LinkTarget, NoRewrite, PARSER_OPTIONS};

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

    fn definitions(source: &str) -> Vec<ReferenceDefinition> {
        collect(&Parser::new_ext(source, PARSER_OPTIONS))
    }

    #[test]
    fn definitions_are_collected_with_destination_and_title() {
        let source = "[1]: https://example.com \"Title\"\n";
        let collected = definitions(source);

        assert_eq!(
            collected,
            [ReferenceDefinition {
                label: "1".to_string(),
                dest: "https://example.com".to_string(),
                title: Some("Title".to_string()),
                start: 0,
                end: source.trim_end().len(),
            }]
        );
    }

    #[test]
    fn a_definition_without_a_title_keeps_none() {
        let collected = definitions("[note]: guide/intro.md\n");

        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].label, "note");
        assert_eq!(collected[0].dest, "guide/intro.md");
        assert_eq!(collected[0].title, None);
    }

    #[test]
    fn definitions_are_ordered_by_source_position() {
        let source = "# T\n\n[b]: https://example.com/b\n\n[a]: https://example.com/a\n";
        let collected = definitions(source);

        assert_eq!(
            collected
                .iter()
                .map(|d| d.label.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"],
            "the table is unordered; the spans decide the order"
        );
    }

    #[test]
    fn a_repeated_label_keeps_the_first_definition() {
        let source = "[1]: https://example.com/first\n[1]: https://example.com/second\n";
        let collected = definitions(source);

        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].dest, "https://example.com/first");
    }

    #[test]
    fn definitions_inside_code_are_not_collected() {
        let collected = definitions("```\n[1]: https://example.com\n```\n");

        assert!(collected.is_empty());
    }

    #[test]
    fn the_markup_reads_as_the_source_line() {
        let definition = ReferenceDefinition {
            label: "1".to_string(),
            dest: "https://example.com/a".to_string(),
            title: Some("Title".to_string()),
            start: 0,
            end: 40,
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
            label: "note".to_string(),
            dest: "a.md".to_string(),
            title: None,
            start: 0,
            end: 12,
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
            label: "1".to_string(),
            dest: "a.md#x".to_string(),
            title: None,
            start: 0,
            end: 10,
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
            label: "1".to_string(),
            dest: "a.md#gone".to_string(),
            title: None,
            start: 0,
            end: 10,
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
            label: "a\"b".to_string(),
            dest: "https://example.com/?a=1&b=2<a>".to_string(),
            title: Some("it's \"quoted\" & <markup>".to_string()),
            start: 0,
            end: 60,
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
            label: "2".to_string(),
            dest: "b.md".to_string(),
            title: Some("B".to_string()),
            start: 0,
            end: 20,
        };

        assert_eq!(definition_text(&definition), "[2]: b.md \"B\"");
    }

    #[test]
    fn the_search_text_of_an_untitled_definition_stops_at_the_destination() {
        let definition = ReferenceDefinition {
            label: "2".to_string(),
            dest: "b.md".to_string(),
            title: None,
            start: 0,
            end: 20,
        };

        assert_eq!(definition_text(&definition), "[2]: b.md");
    }
}
