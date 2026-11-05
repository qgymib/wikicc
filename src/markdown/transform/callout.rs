//! Callouts: Obsidian's `> [!kind] title` block quotes.
//!
//! An Obsidian callout is a block quote whose first paragraph opens with a
//! `[!kind]` marker, optionally followed by a title on the same line:
//!
//! ```markdown
//! > [!note] The title
//! > body
//! ```
//!
//! Nothing in the engine claims that shape — `[!note]` names no reference
//! definition, so it stays a literal text run — which makes this pass a
//! text-level match: a block quote whose first paragraph's first text run
//! opens with a well-formed marker is rewritten into a typed
//! [`OwnKind::Callout`] the serialiser renders as the callout markup. A
//! block quote that does not open with a marker stays a block quote, and
//! every other use of `[!something]` stays literal.
//!
//! The fold, the wikilink pass and the inline sugar have all run before:
//! the marker is never confused with a citation (it is one bracket pair,
//! not a `[[n]][n]` run) and the title line is already sugar-free. Callouts
//! nest — a callout inside a callout is claimed the same way.

use super::super::ast::{OwnKind, OwnNode};

/// Rewrite every callout-shaped block quote in the document.
pub(crate) fn run(root: &mut OwnNode) {
    transform(root);
}

/// Claim the callouts under `node`, depth first.
fn transform(node: &mut OwnNode) {
    if matches!(node.kind, OwnKind::Blockquote(_))
        && let Some(callout) = callout_of(node)
    {
        *node = callout;
    }
    if let Some(children) = node.children_mut() {
        for child in children.iter_mut() {
            transform(child);
        }
    }
}

/// The callout a block quote opens with, if it does.
fn callout_of(blockquote: &OwnNode) -> Option<OwnNode> {
    let OwnKind::Blockquote(children) = &blockquote.kind else {
        return None;
    };
    let OwnKind::Paragraph(first) = &children.first()?.kind else {
        return None;
    };
    let OwnKind::Text(opening) = &first.first()?.kind else {
        return None;
    };

    // The marker: `[!kind]`, optionally with a fold marker (`[!note]+`)
    // that wikicc accepts and ignores — it never folds callouts.
    let marker = opening.strip_prefix("[!")?;
    let marker_end = marker.find(']')?;
    let raw_kind = &marker[..marker_end];
    let raw_kind = match raw_kind.find(['+', '-']) {
        Some(end) => &raw_kind[..end],
        None => raw_kind,
    };
    let kind = raw_kind.to_ascii_lowercase();
    if kind.is_empty()
        || !kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return None;
    }

    // The title is everything on the marker's line after the marker; the
    // soft-wrapped lines that follow belong to the content. Inline nodes
    // travel with whichever side the first line break puts them on.
    let mut title: Vec<OwnNode> = Vec::new();
    let mut content: Vec<OwnNode> = Vec::new();
    let mut in_title = true;
    for (index, node) in first.iter().enumerate() {
        match &node.kind {
            OwnKind::Text(value) => {
                let segment = if index == 0 {
                    &value[marker_end + 3..]
                } else {
                    value.as_str()
                };
                let segment = if index == 0 && in_title {
                    segment.strip_prefix(' ').unwrap_or(segment)
                } else {
                    segment
                };
                match segment.find('\n') {
                    Some(break_at) => {
                        let head = &segment[..break_at];
                        let tail = &segment[break_at + 1..];
                        if in_title && !head.is_empty() {
                            title.push(OwnNode::new(node.line, OwnKind::Text(head.to_string())));
                        }
                        in_title = false;
                        if !tail.is_empty() {
                            content.push(OwnNode::new(node.line, OwnKind::Text(tail.to_string())));
                        }
                    }
                    None if in_title => {
                        if !segment.is_empty() {
                            title.push(OwnNode::new(node.line, OwnKind::Text(segment.to_string())));
                        }
                    }
                    None => {
                        if !segment.is_empty() {
                            content
                                .push(OwnNode::new(node.line, OwnKind::Text(segment.to_string())));
                        }
                    }
                }
            }
            _ if in_title => title.push(node.clone()),
            _ => content.push(node.clone()),
        }
    }

    let title = if title.is_empty() {
        vec![OwnNode::new(
            blockquote.line,
            OwnKind::Text(default_title(&kind)),
        )]
    } else {
        title
    };

    // The content opens with whatever the marker paragraph carried past its
    // first line, then continues with the quote's remaining blocks.
    let mut callout_children: Vec<OwnNode> = Vec::new();
    if !content.is_empty() {
        callout_children.push(OwnNode::new(blockquote.line, OwnKind::Paragraph(content)));
    }
    callout_children.extend(children[1..].iter().cloned());

    Some(OwnNode::new(
        blockquote.line,
        OwnKind::Callout {
            kind,
            title,
            children: callout_children,
        },
    ))
}

/// The title a markerless callout displays: its kind, capitalised.
fn default_title(kind: &str) -> String {
    let mut characters = kind.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::ast::to_own;
    use crate::markdown::parse::parse_document;
    use crate::markdown::refdefs;

    /// The root children after the full transform chain.
    fn shapes(source: &str) -> Vec<String> {
        let mut own = to_own(&parse_document(source));
        let table = refdefs::collect(&own);
        crate::markdown::transform::fold::run(&mut own, &table);
        crate::markdown::transform::wikilink::run(&mut own, &table);
        crate::markdown::transform::inline::run(&mut own);
        run(&mut own);

        let OwnKind::Root(children) = &own.kind else {
            panic!("a document is a root");
        };
        children
            .iter()
            .map(|node| format!("{:?}", node.kind))
            .collect()
    }

    #[test]
    fn a_marked_blockquote_becomes_a_callout() {
        let shapes = shapes("> [!note] Title\n> body\n");

        assert_eq!(shapes.len(), 1, "{shapes:?}");
        assert!(shapes[0].contains("Callout"), "{shapes:?}");
        assert!(shapes[0].contains("kind: \"note\""), "{shapes:?}");
    }

    #[test]
    fn a_marker_without_a_title_takes_the_default() {
        let shapes = shapes("> [!warning]\n> body\n");

        assert!(shapes[0].contains("Callout"), "{shapes:?}");
        assert!(shapes[0].contains("Text(\"Warning\")"), "{shapes:?}");
    }

    #[test]
    fn a_plain_blockquote_stays_a_blockquote() {
        let shapes = shapes("> just quoted\n");

        assert!(shapes[0].contains("Blockquote"), "{shapes:?}");
        assert!(!shapes[0].contains("Callout"), "{shapes:?}");
    }

    #[test]
    fn a_blockquote_that_merely_mentions_a_marker_stays_a_blockquote() {
        let shapes = shapes("> the [!note] marker is not the first thing\n");

        assert!(shapes[0].contains("Blockquote"), "{shapes:?}");
    }

    #[test]
    fn a_fold_marker_is_accepted_and_ignored() {
        let shapes = shapes("> [!tip]+ body\n");

        assert!(shapes[0].contains("kind: \"tip\""), "{shapes:?}");
    }

    #[test]
    fn callouts_nest() {
        let shapes = shapes("> [!note]\n> > [!tip] inner\n");

        assert_eq!(
            shapes.len(),
            1,
            "one root, holding the nested callout: {shapes:?}"
        );
        assert!(shapes[0].contains("kind: \"note\""), "{shapes:?}");
        assert!(shapes[0].contains("kind: \"tip\""), "{shapes:?}");
    }

    #[test]
    fn an_unknown_marker_shape_stays_a_reference() {
        let shapes = shapes("> [!Not A Kind]\n> body\n");

        assert!(
            shapes.iter().all(|shape| !shape.contains("Callout")),
            "spaces cannot be a kind: {shapes:?}"
        );
    }

    #[test]
    fn the_title_line_ends_at_the_first_break() {
        let shapes = shapes("> [!note] Title\n> body\n");

        assert!(shapes[0].contains("Text(\"Title\")"), "{shapes:?}");
        assert!(
            shapes[0].contains("Paragraph([OwnNode { line: 1, kind: Text(\"body\") }])"),
            "the body is the content, not the title: {shapes:?}"
        );
    }

    #[test]
    fn an_uppercase_kind_is_claimed_and_lowered() {
        let shapes = shapes("> [!NOTE] head\n");

        assert!(shapes[0].contains("kind: \"note\""), "{shapes:?}");
    }
}
