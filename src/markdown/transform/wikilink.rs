//! Wikilinks and embeds: Obsidian's `[[target]]`, `[[target|alias]]` and
//! `![[embed]]`.
//!
//! Obsidian and Typora share the `[[` opening with the citation idiom, so
//! this pass runs **after the fold** and takes only the remainder. The
//! contract, from the engine decision:
//!
//! 1. **A run is only claimed when it names nothing.** The engine resolves
//!    references that sit in the reference table into `LinkReference`
//!    nodes, and those belong to the citation display — `text[[1]]` renders
//!    as `[<a>1</a>]`, exactly as Typora shows it. What stays in a text run
//!    is precisely what names nothing, which is what a wikilink is.
//! 2. **A run that does not close as `]]` stays literal.** The `[[1]][1]`
//!    shape the fold declined keeps its brackets: a closing `]]` that is
//!    followed by one more `[` (but not `[[`) is the head of a citation
//!    pair, not the end of a wikilink.
//! 3. The target is rewritten through the same
//!    [`crate::markdown::LinkRewriter`] as any destination at serialisation
//!    time; an extensionless target names a note and gains `.md`. An embed
//!    of a local asset becomes an image there, anything else falls back to
//!    a wikilink-style link.

use super::super::ast::{OwnKind, OwnNode, walk_blocks};
use super::super::refdefs::ReferenceTable;

/// Claim every `[[…]]` and `![[…]]` run the fold left behind.
pub(crate) fn run(root: &mut OwnNode, table: &ReferenceTable) {
    let _ = table;
    walk_blocks(root, &mut |children| claim_runs(children));
}

/// Scan one run of phrasing content for claimable bracket runs.
fn claim_runs(children: &mut Vec<OwnNode>) {
    let mut index = 0;
    while index < children.len() {
        let line = children[index].line;
        let claimed = match &children[index].kind {
            OwnKind::Text(value) => claim_within(value, line),
            _ => None,
        };
        match claimed {
            Some(replacement) => {
                let count = replacement.len();
                children.splice(index..index + 1, replacement);
                index += count;
            }
            None => index += 1,
        }
    }
}

/// Split a text run at its `[[…]]` and `![[…]]` runs.
///
/// Runs that do not claim — an unclosed `[[`, a citation-shaped `]][`,
/// an empty target — stay literal text, and the scan continues behind them.
fn claim_within(value: &str, line: usize) -> Option<Vec<OwnNode>> {
    let mut nodes: Vec<OwnNode> = Vec::new();
    let mut literal = String::new();
    let mut rest = value;
    let mut claimed = false;

    while !rest.is_empty() {
        let Some((open, is_embed)) = find_open(rest) else {
            literal.push_str(rest);
            break;
        };
        let open_len = if is_embed { 3 } else { 2 };
        let after_open = &rest[open + open_len..];
        let Some(close) = after_open.find("]]") else {
            // Unclosed: everything from the opening stays literal.
            literal.push_str(&rest[open..]);
            break;
        };

        let inner = &after_open[..close];
        let after_close = &after_open[close + 2..];

        // A `]]` followed by one more `[` — but not `[[` — is the head of a
        // citation pair the fold declined (`[[1]][1]`); leave it verbatim.
        if after_close.starts_with('[') && !after_close.starts_with("[[") {
            literal.push_str(&rest[..open + open_len + close + 2]);
            rest = after_close;
            continue;
        }

        let Some((target, alias)) = split_target(inner) else {
            // An empty or bracketed target is not a wikilink.
            literal.push_str(&rest[..open + open_len + close + 2]);
            rest = after_close;
            continue;
        };

        claimed = true;
        literal.push_str(&rest[..open]);
        push_literal(&mut nodes, &mut literal, line);
        nodes.push(OwnNode::new(
            line,
            if is_embed {
                OwnKind::Embed { target }
            } else {
                OwnKind::Wikilink { target, alias }
            },
        ));
        rest = after_close;
    }

    if !claimed {
        return None;
    }
    push_literal(&mut nodes, &mut literal, line);
    Some(nodes)
}

/// The next `![[` or `[[` in `rest`, as `(offset, is_embed)`.
///
/// The embed spelling wins: `![[` is matched before its `[[` is considered.
fn find_open(rest: &str) -> Option<(usize, bool)> {
    let embed = rest.find("![[");
    let plain = rest.find("[[");
    match (embed, plain) {
        (None, None) => None,
        (Some(embed_at), Some(plain_at)) => {
            if embed_at <= plain_at {
                Some((embed_at, true))
            } else {
                Some((plain_at, false))
            }
        }
        (Some(embed_at), None) => Some((embed_at, true)),
        (None, Some(plain_at)) => Some((plain_at, false)),
    }
}

/// The target and alias a claimed run carries.
///
/// `None` for an empty target, a target that holds bracket characters, or
/// an alias that does.
fn split_target(inner: &str) -> Option<(String, Option<String>)> {
    let (target, alias) = match inner.split_once('|') {
        Some((target, alias)) => (target, Some(alias)),
        None => (inner, None),
    };

    if target.is_empty()
        || target.contains(['[', ']'])
        || alias.is_some_and(|alias| alias.contains(['[', ']']))
    {
        return None;
    }

    Some((
        target.to_string(),
        alias.filter(|alias| !alias.is_empty()).map(String::from),
    ))
}

/// Push a pending literal run, if any.
fn push_literal(nodes: &mut Vec<OwnNode>, literal: &mut String, line: usize) {
    if !literal.is_empty() {
        nodes.push(OwnNode::new(line, OwnKind::Text(std::mem::take(literal))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::ast::to_own;
    use crate::markdown::parse::parse_document;

    /// The first paragraph's children after the fold and the wikilink pass.
    fn shapes(source: &str) -> Vec<String> {
        let mut own = to_own(&parse_document(source));
        let table = crate::markdown::refdefs::collect(&own);
        crate::markdown::transform::fold::run(&mut own, &table);
        run(&mut own, &table);

        let OwnKind::Root(children) = &own.kind else {
            panic!("a document is a root");
        };
        let Some(OwnKind::Paragraph(paragraph)) = children.first().map(|node| &node.kind) else {
            panic!("the document opens with a paragraph: {:?}", own.kind);
        };
        paragraph
            .iter()
            .map(|node| format!("{:?}", node.kind))
            .collect()
    }

    #[test]
    fn a_wikilink_without_a_definition_is_claimed() {
        let shapes = shapes("see [[My Page]] now\n");

        assert_eq!(shapes.len(), 3, "text, wikilink, text: {shapes:?}");
        assert!(shapes[1].contains("Wikilink"), "{shapes:?}");
        assert!(shapes[1].contains("target: \"My Page\""), "{shapes:?}");
    }

    #[test]
    fn an_alias_travels_with_the_wikilink() {
        let shapes = shapes("[[a.md|the alias]]\n");

        assert!(shapes[0].contains("Wikilink"), "{shapes:?}");
        assert!(shapes[0].contains("target: \"a.md\""), "{shapes:?}");
        assert!(
            shapes[0].contains("alias: Some(\"the alias\")"),
            "{shapes:?}"
        );
    }

    #[test]
    fn a_named_reference_is_a_citation_display_not_a_wikilink() {
        let source = "text[[1]] more\n\n[1]: https://example.com/1\n";
        let shapes = shapes(source);

        assert!(
            shapes.iter().all(|shape| !shape.contains("Wikilink")),
            "a target in the reference table belongs to the citation idiom: {shapes:?}"
        );
        assert!(
            shapes.iter().any(|shape| shape.contains("LinkReference")),
            "the engine resolved the reference into a display: {shapes:?}"
        );
    }

    #[test]
    fn the_citation_shape_the_fold_declined_stays_verbatim() {
        let shapes = shapes("text[[1]][1] more\n");

        assert_eq!(shapes.len(), 1, "no run is claimed: {shapes:?}");
        assert!(
            shapes[0].starts_with("Text(\"text[[1]][1] more\")"),
            "{shapes:?}"
        );
    }

    #[test]
    fn an_embed_of_an_unnamed_target_is_claimed() {
        let shapes = shapes("![[img.png]]\n");

        assert_eq!(shapes.len(), 1, "{shapes:?}");
        assert!(shapes[0].contains("Embed"), "{shapes:?}");
        assert!(shapes[0].contains("target: \"img.png\""), "{shapes:?}");
    }

    #[test]
    fn a_wikilink_with_brackets_in_the_target_stays_literal() {
        let shapes = shapes("[[a]b]]\n");

        assert!(
            shapes.iter().all(|shape| !shape.contains("Wikilink")),
            "bracket characters cannot be a target: {shapes:?}"
        );
    }

    #[test]
    fn an_empty_target_stays_literal() {
        let shapes = shapes("[[|alias]]\n");

        assert!(
            shapes.iter().all(|shape| !shape.contains("Wikilink")),
            "{shapes:?}"
        );
    }

    #[test]
    fn two_wikilinks_in_one_paragraph_each_get_claimed() {
        let shapes = shapes("[[a]] and [[b|B]]\n");

        let claimed = shapes
            .iter()
            .filter(|shape| shape.contains("Wikilink"))
            .count();
        assert_eq!(claimed, 2, "{shapes:?}");
    }

    #[test]
    fn an_unclosed_bracket_run_stays_literal() {
        let shapes = shapes("a [[open b\n");

        assert!(
            shapes.iter().all(|shape| !shape.contains("Wikilink")),
            "{shapes:?}"
        );
    }

    #[test]
    fn an_embed_and_a_wikilink_coexist() {
        let shapes = shapes("![[a.png]] then [[b]]\n");

        assert!(
            shapes.iter().any(|shape| shape.contains("Embed")),
            "{shapes:?}"
        );
        assert!(
            shapes.iter().any(|shape| shape.contains("Wikilink")),
            "{shapes:?}"
        );
    }
}
