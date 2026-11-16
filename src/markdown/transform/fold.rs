//! Citation folding: Typora's `[[n]][n]` idiom collapses to the one link.
//!
//! A Typora user wraps a numbered citation in a second pair of brackets,
//! writing `[[1]][1]` for a citation whose definition block is
//! `[1]: https://…`. CommonMark reads that as a literal `[`, the reference
//! link `[1]`, a literal `]` and a second reference link `[1]`, so the
//! reader would show `[1]1`. This pass collapses the sequence into the
//! single link `[1]` Typora displays, with the brackets inside the link:
//! `<a href="…">[1]</a>`.
//!
//! The mdast shape of the idiom is `Text("[")`, `LinkReference`, `Text("]")`,
//! `LinkReference` — the same shape the event-stream fold matched before the
//! engine switch, now matched within one run of phrasing content. The fold
//! never crosses an inline boundary (emphasis, a link, a block), which is
//! why matching inside one array is exact.
//!
//! Runs written back to back degrade the shape: in `[[1]][1][[2]][2]` the
//! first run's duplicate `[1]` is followed by the next idiom's `[`, and a
//! shortcut reference may not be followed by `[` — the parser tries the
//! full reference `[1][[2]]` instead, fails it, and keeps the duplicate as
//! literal text inside the separator `Text("][1][")`. The fold reads the
//! duplicate back out of that text, so a run folds whichever way the
//! duplicate appears: as the second reference node, or as the degraded
//! `[n]` in the separator.
//!
//! A run folds only when
//!
//! 1. both references are implicit (`[n]` or `[n][]`), not inline links,
//! 2. they share the identifier, so they resolve to the same destination
//!    and title through the reference table,
//! 3. the identifier resolves at all — an undefined `[[1]][1]` stays
//!    verbatim, because the author may be writing for a renderer that
//!    resolves it later, and claiming it here would hide the mistake, and
//! 4. both references show the same visible text.
//!
//! The duplicate reference is dropped before any destination is rewritten,
//! so it never reaches the resolver and cannot produce a second diagnostic
//! or a second link-graph edge — the surviving link keeps the source line it
//! starts on. A duplicate that survives only as degraded text was never a
//! reference to begin with, so dropping it changes no diagnostic either.

use markdown::mdast::ReferenceKind;

use super::super::ast::{OwnKind, OwnNode, walk_blocks};
use super::super::refdefs::ReferenceTable;

/// Fold every `[[n]][n]` run in the document.
pub(crate) fn run(root: &mut OwnNode, table: &ReferenceTable) {
    walk_blocks(root, &mut |children| fold_runs(children, table));
}

/// Fold the runs in one run of phrasing content.
///
/// A run needs three nodes when its duplicate degraded into the separator
/// text (`Text`, `LinkReference`, `Text("][1][…")`), four when it kept the
/// second reference node; [`fold_at`] tells the shapes apart.
fn fold_runs(children: &mut Vec<OwnNode>, table: &ReferenceTable) {
    let mut index = 0;
    while index + 2 < children.len() {
        match fold_at(children, index, table) {
            Some(survivor) => index = survivor + 1,
            None => index += 1,
        }
    }
}

/// The shape the duplicate of a foldable run takes.
enum Shape<'a> {
    /// The literal `[n]` the engine degraded into the separator text, with
    /// its label (`[[1]][1][[2]][2]`).
    Degraded(&'a str),
    /// The second reference node (`[[1]][1]` at the end of a run).
    Second,
}

/// Whether the run starting at `index` is a `[[n]][n]`, folded in place.
///
/// The duplicate is either the second reference node (`[[1]][1]` at the end
/// of a run) or the literal text the engine degraded it into
/// (`[[1]][1][[2]][2]` — see [`separator_duplicate`]).
///
/// Returns the new position of the surviving reference, so the scan
/// continues behind it — a folded citation can never open another one, and
/// the next run may start immediately after (`a[[1]][1][[2]][2]b`).
fn fold_at(children: &mut Vec<OwnNode>, index: usize, table: &ReferenceTable) -> Option<usize> {
    // The opening `[`: either a bare text node or glued to the text in
    // front of it (`text[[1]][1]`).
    let OwnKind::Text(opening) = &children[index].kind else {
        return None;
    };
    if !opening.ends_with('[') {
        return None;
    }
    let opening_is_bare = opening.len() == 1;

    // The first reference of the run, with the identifier and the visible
    // text the duplicate has to repeat.
    let (identifier, visible) = citation_of(&children[index + 1])?;

    // The `]` after the first reference, as its own text node. In
    // `a[[1]][1][[2]][2]b` it is `][1][`: CommonMark degrades the middle
    // `[1]` into it, and its trailing `[` opens the next run, so whatever
    // follows the bracket has to stay behind.
    let tail = match &children[index + 2].kind {
        OwnKind::Text(value) if value.starts_with(']') => value[1..].to_string(),
        _ => return None,
    };

    // Which shape the duplicate takes: the degraded `[n]` in the separator
    // when it repeats the first reference under a resolved identifier, the
    // second reference node otherwise — two implicit references sharing the
    // identifier and the visible text, both resolving through the table.
    // The fold is a display convention for a resolved citation, not a
    // rewrite of syntax, so an unresolved run never folds.
    let second = index + 3;
    let shape = match separator_duplicate(&tail) {
        Some(label)
            if normalised(label) == identifier
                && label == visible
                && table.resolve(&identifier).is_some() =>
        {
            Shape::Degraded(label)
        }
        _ => {
            let (second_identifier, second_visible) = citation_of(children.get(second)?)?;
            if second_identifier != identifier || second_visible != visible {
                return None;
            }
            table.resolve(&identifier)?;
            Shape::Second
        }
    };

    // The brackets move inside the surviving link, so the reader sees the
    // same `[n]` Typora shows instead of anonymous text around a link.
    fold_brackets_into(&mut children[index + 1]);

    match shape {
        Shape::Degraded(label) => {
            // Drop the text duplicate, and keep what follows it — the `[`
            // that opens the next run.
            let remainder = tail[label.len() + 2..].to_string();
            if remainder.is_empty() {
                children.remove(index + 2);
            } else {
                let line = children[index + 2].line;
                children[index + 2] = OwnNode::new(line, OwnKind::Text(remainder));
            }
        }
        Shape::Second => {
            // Drop the duplicate, and keep whatever followed the `]`.
            if tail.is_empty() {
                children.drain(index + 2..=second);
            } else {
                let line = children[index + 2].line;
                children[index + 2] = OwnNode::new(line, OwnKind::Text(tail));
                children.remove(second);
            }
        }
    }

    // The `[` that opened the wrap goes: either the whole text node when it
    // held nothing else, or just one bracket when it was glued to the text
    // in front of it (`text[[1]][1]`).
    if opening_is_bare {
        children.remove(index);
        Some(index)
    } else if let OwnKind::Text(opening) = &mut children[index].kind {
        if let Some(prefix) = opening.strip_suffix('[') {
            *opening = prefix.to_string();
        }
        Some(index + 1)
    } else {
        unreachable!("checked above that the node is a text run")
    }
}

/// The identifier and visible text of one implicit reference link.
///
/// `None` for anything that is not an implicit (`[n]` / `[n][]`) reference
/// with non-empty plain content — the shapes the idiom is written in.
fn citation_of(node: &OwnNode) -> Option<(String, String)> {
    let OwnKind::LinkReference {
        identifier,
        kind,
        children,
        ..
    } = &node.kind
    else {
        return None;
    };
    if !is_implicit(*kind) {
        return None;
    }

    let text = visible_text(children)?;
    (!text.is_empty()).then_some((identifier.clone(), text))
}

/// The duplicate label a separator text carries after its leading `]`.
///
/// `[[1]][1][[2]][2]` degrades the middle `[1]` into the separator `][1][`:
/// CommonMark reads a `[1]` followed by the next idiom's `[` as the full
/// reference `[1][[2]]`, fails it, and never falls back to the shortcut.
/// The label between the degraded brackets is the duplicate when it is
/// non-empty and bracket-free.
fn separator_duplicate(tail: &str) -> Option<&str> {
    let inner = tail.strip_prefix('[')?;
    let close = inner.find(']')?;
    let label = &inner[..close];
    (!label.is_empty() && !label.contains('[')).then_some(label)
}

/// Normalise a label the way the engine normalises identifiers: case
/// folded, whitespace dropped (`"My Label"` matches `mylabel`).
fn normalised(label: &str) -> String {
    label
        .to_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

/// Move the wrap's brackets inside the surviving reference, so the reader
/// sees the same `[n]` Typora shows instead of anonymous text around a
/// link.
fn fold_brackets_into(reference: &mut OwnNode) {
    if let OwnKind::LinkReference {
        children: inner, ..
    } = &mut reference.kind
    {
        let mut folded = vec![OwnNode::new(1, OwnKind::Text("[".to_string()))];
        folded.append(inner);
        folded.push(OwnNode::new(1, OwnKind::Text("]".to_string())));
        *inner = folded;
    }
}

/// Whether a reference is `[n]` / `[n][]` rather than `[n](url)` or
/// `[n][n]`-with-a-different-label — the shapes the idiom is written in.
fn is_implicit(kind: ReferenceKind) -> bool {
    matches!(kind, ReferenceKind::Shortcut | ReferenceKind::Collapsed)
}

/// Visible text of a reference's content, when it is plain text and code.
///
/// Anything else (emphasis, an image, a nested link) makes the reference
/// uninteresting to the fold, and `None` is returned so the comparison
/// fails.
fn visible_text(children: &[OwnNode]) -> Option<String> {
    let mut text = String::new();
    for child in children {
        match &child.kind {
            OwnKind::Text(value) | OwnKind::InlineCode(value) => text.push_str(value),
            _ => return None,
        }
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::ast::to_own;
    use crate::markdown::parse::parse_document;
    use crate::markdown::{LinkRewriter, LinkTarget, render_document, render_document_with};

    fn tree(source: &str) -> OwnNode {
        let mut own = to_own(&parse_document(source));
        let table = crate::markdown::refdefs::collect(&own);
        run(&mut own, &table);
        own
    }

    /// Debug rendering of the first paragraph's children, for assertions.
    fn paragraph_shapes(source: &str) -> Vec<String> {
        let tree = tree(source);
        let OwnKind::Root(children) = &tree.kind else {
            panic!("a document is a root");
        };
        let Some(OwnKind::Paragraph(paragraph)) = children.first().map(|node| &node.kind) else {
            panic!("the document opens with a paragraph: {:?}", tree.kind);
        };
        paragraph
            .iter()
            .map(|node| format!("{:?}", node.kind))
            .collect()
    }

    const DEFINED: &str = "text\n\n[1]: https://example.com/1\n";

    /// Two citations' worth of definitions, for back-to-back runs.
    const TWO_DEFINED: &str = "text\n\n[1]: https://example.com/1\n[2]: https://example.com/2\n";

    /// Top-level text runs of the first paragraph, for residual assertions.
    ///
    /// A fold that leaves bracket debris behind shows up here as a text run
    /// holding `][`-shaped leftovers; a clean fold only leaves the author's
    /// own words.
    fn paragraph_text_runs(source: &str) -> Vec<String> {
        let tree = tree(source);
        let OwnKind::Root(children) = &tree.kind else {
            panic!("a document is a root");
        };
        let Some(OwnKind::Paragraph(paragraph)) = children.first().map(|node| &node.kind) else {
            panic!("the document opens with a paragraph: {:?}", tree.kind);
        };
        paragraph
            .iter()
            .filter_map(|node| match &node.kind {
                OwnKind::Text(value) => Some(value.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_defined_citation_folds_into_one_reference() {
        let shapes = paragraph_shapes(&DEFINED.replacen("text", "text[[1]][1] more", 1));

        assert_eq!(shapes.len(), 3, "text, folded reference, more: {shapes:?}");
        assert!(shapes[0].starts_with("Text(\"text\")"), "{shapes:?}");
        assert!(
            shapes[1].contains("LinkReference"),
            "the fold leaves one reference: {shapes:?}"
        );
        assert!(
            shapes[1].contains("Text(\"[\")"),
            "the opening bracket moved inside: {shapes:?}"
        );
        assert!(
            shapes[1].contains("Text(\"]\")"),
            "the closing bracket moved inside: {shapes:?}"
        );
        assert!(shapes[2].starts_with("Text(\" more\")"), "{shapes:?}");
    }

    #[test]
    fn an_undefined_citation_is_left_verbatim() {
        // The engine keeps an unresolved citation as one literal text run:
        // there is nothing to fold, and nothing to claim either.
        let shapes = paragraph_shapes("text[[1]][1] more\n");

        assert_eq!(shapes.len(), 1, "{shapes:?}");
        assert!(
            shapes[0].starts_with("Text(\"text[[1]][1] more\")"),
            "{shapes:?}"
        );
    }

    #[test]
    fn a_citation_without_its_duplicate_is_left_alone() {
        let shapes = paragraph_shapes(&DEFINED.replacen("text", "text[[1]] more", 1));

        assert_eq!(
            shapes.len(),
            3,
            "the fold needs the second reference: {shapes:?}"
        );
    }

    #[test]
    fn two_citations_in_a_row_each_fold() {
        let source = &DEFINED.replacen("text", "a[[1]][1][[1]][1]b", 1);
        let shapes = paragraph_shapes(source);

        assert_eq!(
            paragraph_text_runs(source),
            ["a", "b"],
            "the degraded duplicate may not survive as bracketed text: {shapes:?}"
        );
        assert_eq!(
            shapes
                .iter()
                .filter(|shape| shape.contains("LinkReference"))
                .count(),
            2,
            "one per citation, both folded: {shapes:?}"
        );
    }

    #[test]
    fn back_to_back_idioms_with_different_ids_each_fold() {
        let source = &TWO_DEFINED.replacen("text", "a[[1]][1][[2]][2]b", 1);
        let shapes = paragraph_shapes(source);

        assert_eq!(
            paragraph_text_runs(source),
            ["a", "b"],
            "the engine degrades the first duplicate into the separator text \
             `][1][`; the fold must read it back out: {shapes:?}"
        );
        let references: Vec<&String> = shapes
            .iter()
            .filter(|shape| shape.contains("LinkReference"))
            .collect();
        assert_eq!(references.len(), 2, "one per citation: {shapes:?}");
        assert!(shapes[1].contains("identifier: \"1\""), "{shapes:?}");
        assert!(
            shapes[1].contains("Text(\"[\")"),
            "brackets inside: {shapes:?}"
        );
        assert!(shapes[2].contains("identifier: \"2\""), "{shapes:?}");
        assert!(
            shapes[2].contains("Text(\"[\")"),
            "brackets inside: {shapes:?}"
        );
    }

    #[test]
    fn a_degraded_duplicate_with_another_label_does_not_fold() {
        let source = &TWO_DEFINED.replacen("text", "a[[1]][x][[2]][2]b", 1);
        let shapes = paragraph_shapes(source);

        // `[x]` names nothing, so the first run keeps the author's brackets
        // verbatim and only the second run folds; nothing is claimed for x.
        assert_eq!(
            paragraph_text_runs(source),
            ["a[", "][x]", "b"],
            "{shapes:?}"
        );
        assert_eq!(
            shapes
                .iter()
                .filter(|shape| shape.contains("LinkReference"))
                .count(),
            2,
            "one unfolded run plus one folded run: {shapes:?}"
        );
        assert!(
            !shapes[1].contains("Text(\"[\")"),
            "the unmatched run stays verbatim: {shapes:?}"
        );
    }

    #[test]
    fn idioms_spaced_apart_each_fold() {
        let source = &TWO_DEFINED.replacen("text", "a[[1]][1] [[2]][2]b", 1);
        let shapes = paragraph_shapes(source);

        assert_eq!(
            paragraph_text_runs(source),
            ["a", " ", "b"],
            "the separator keeps the author's space: {shapes:?}"
        );
        assert_eq!(
            shapes
                .iter()
                .filter(|shape| shape.contains("LinkReference"))
                .count(),
            2,
            "one per citation: {shapes:?}"
        );
    }

    #[test]
    fn adjacent_inline_links_are_not_folded() {
        let shapes = paragraph_shapes("[1](https://example.com)[1](https://example.com)\n");

        assert_eq!(
            shapes.iter().filter(|shape| shape.contains("Link")).count(),
            2,
            "inline links carry their destination, not a wrap: {shapes:?}"
        );
    }

    #[test]
    fn the_fold_needs_plain_visible_text() {
        let source = "text\n\n[1]: https://example.com/1\n";
        let shapes = paragraph_shapes(&source.replacen("text", "a[[1]][1] *b*", 1));

        assert!(
            shapes.iter().any(|shape| shape.contains("Emphasis")),
            "the trailing emphasis is untouched: {shapes:?}"
        );
    }

    // The citation idiom rendered end to end, fold plus the reference list.

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
    fn adjacent_inline_links_are_not_folded_when_rendered() {
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
}
