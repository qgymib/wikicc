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
}
