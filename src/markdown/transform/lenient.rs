//! Lenient destinations for inline images and links the engine declines.
//!
//! CommonMark does not let an inline destination carry a space: `![chart](my
//! charts/chart.png)` is not an image, and Obsidian's attachment-folder
//! idiom spelled with spaces (`论文 图集：第一课.assets/image.png`) is not
//! either. The parser falls back to literal text, so no image node is built,
//! the asset resolver never sees the destination, the build reports no
//! warning and the reader shows the raw `![...](...)` markup in the body.
//!
//! This pass claims exactly those shapes on the own-layer tree, the way
//! [`super::wikilink`] claims `[[...]]`: it scans phrasing-content text runs
//! for `![label](destination)` and `[label](destination)` whose destination
//! carries a space — the very reason the engine declined them — balances
//! parentheses inside the destination, and rewrites the run into a real
//! [`OwnKind::Image`] or [`OwnKind::Link`]. Everything downstream — the
//! [`crate::markdown::LinkRewriter`], asset registration, `data:` embedding
//! — already handles the rest, so the pass adds no addressing logic.
//!
//! What stays literal, deliberately:
//!
//! - destinations the engine already parsed (`plain.png`, `<wrapped>`,
//!   `%20` escapes, titles) never sit in a text run as a full `](...)`
//!   shape, so this pass cannot reach them;
//! - code (`OwnKind::Code`, `OwnKind::InlineCode`) is a different node kind,
//!   so documented examples of the syntax survive verbatim;
//! - a destination without a space, a destination that wraps to the next
//!   line, a label holding `[`, a `<`-prefixed destination or an empty
//!   destination stays as written;
//! - the label is taken as plain text (the engine's `alt` is plain text
//!   too), so `[**bold**](a b.md)` — whose label the engine splits across
//!   nodes — is not claimed.
//!
//! One boundary is accepted: the parser resolves `\!` and `\[` escapes while
//! building the tree, so `\![a](b c)` reaches this pass as the very text run
//! `![a](b c)` produces, and claims the same way. An escape can never make a
//! spaced destination literal again; authors who need the raw markup in
//! prose should use a code span instead. The scan still declines an opener
//! whose previous byte is a `\` whenever one survives into a text value.

use super::super::ast::{OwnKind, OwnNode, walk_blocks};

/// Claim every spaced destination the engine left as literal text.
pub(crate) fn run(root: &mut OwnNode) {
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

/// One claimable `![label](destination)` or `[label](destination)` run.
struct Found {
    /// Offset of the run's first byte (`!` for an image, `[` for a link).
    start: usize,
    /// Offset one past the run's closing `)`.
    end: usize,
    is_image: bool,
    label: String,
    destination: String,
}

/// Split a text run at its spaced destinations.
///
/// Runs that do not claim — a destination without a space, an unclosed or
/// line-wrapped destination, an escaped opener — stay literal text, and the
/// scan continues behind them.
fn claim_within(value: &str, line: usize) -> Option<Vec<OwnNode>> {
    let mut nodes: Vec<OwnNode> = Vec::new();
    let mut literal = String::new();
    let mut rest = value;
    let mut claimed = false;

    while let Some(found) = find_run(rest) {
        claimed = true;
        literal.push_str(&rest[..found.start]);
        push_literal(&mut nodes, &mut literal, line);
        nodes.push(match found.is_image {
            true => OwnNode::new(
                line,
                OwnKind::Image {
                    url: found.destination,
                    title: None,
                    alt: found.label,
                },
            ),
            false => {
                let children = if found.label.is_empty() {
                    Vec::new()
                } else {
                    vec![OwnNode::new(line, OwnKind::Text(found.label))]
                };
                OwnNode::new(
                    line,
                    OwnKind::Link {
                        url: found.destination,
                        title: None,
                        children,
                    },
                )
            }
        });
        rest = &rest[found.end..];
    }

    if !claimed {
        return None;
    }
    literal.push_str(rest);
    push_literal(&mut nodes, &mut literal, line);
    Some(nodes)
}

/// The first claimable run in `rest`, if any.
///
/// All matching happens on ASCII bytes; multi-byte UTF-8 characters never
/// collide with the ASCII delimiters, and every slice bound produced here is
/// an ASCII byte position, hence a character boundary.
fn find_run(rest: &str) -> Option<Found> {
    let bytes = rest.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        let is_image = bytes[index] == b'!' && bytes.get(index + 1) == Some(&b'[');
        let is_link = bytes[index] == b'[';

        if !(is_image || is_link) {
            index += 1;
            continue;
        }

        // An escaped opener stays literal: `\!` and `\[` render the bracket.
        if index > 0 && bytes[index - 1] == b'\\' {
            index += 1;
            continue;
        }

        let label_start = if is_image { index + 2 } else { index + 1 };
        match complete_run(rest, label_start, is_image) {
            Some(found) => return Some(found),
            None => {
                // Not claimable from this opener; the next `[` gets its own
                // chance (`[a[b]](c d)` declines the outer label outright).
                index += 1;
            }
        }
    }

    None
}

/// Complete one run whose opener starts at `label_start`'s preceding bracket.
fn complete_run(rest: &str, label_start: usize, is_image: bool) -> Option<Found> {
    let bytes = rest.as_bytes();
    let run_start = if is_image {
        label_start - 2
    } else {
        label_start - 1
    };

    // The label runs to the first `]`; a `[` inside declines the label
    // outright (balanced nested labels are the engine's business).
    let label_region = &rest[label_start..];
    let close = label_region.find(']').map(|offset| label_start + offset)?;
    if rest[label_start..close].contains('[') {
        return None;
    }
    // The `]` must be followed immediately by `(`.
    if bytes.get(close + 1) != Some(&b'(') {
        return None;
    }

    // A `<` destination is the engine's business even when it declined the
    // run for another reason (a newline inside the angle brackets).
    let destination_start = close + 2;
    if bytes.get(destination_start) == Some(&b'<') {
        return None;
    }

    // The destination runs to the first `)` at parenthesis depth zero.
    let mut depth = 0usize;
    let mut cursor = destination_start;
    let destination_end = loop {
        let byte = *bytes.get(cursor)?;
        match byte {
            // A destination never spans lines.
            b'\n' => return None,
            b'(' => depth += 1,
            b')' if depth == 0 => break cursor,
            b')' => depth -= 1,
            _ => {}
        }
        cursor += 1;
    };

    let destination = &rest[destination_start..destination_end];
    if destination.is_empty() || !destination.contains(' ') {
        return None;
    }

    Some(Found {
        start: run_start,
        end: destination_end + 1,
        is_image,
        label: rest[label_start..close].to_string(),
        destination: destination.to_string(),
    })
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

    /// The first paragraph's children after this pass alone.
    fn shapes(source: &str) -> Vec<String> {
        let mut own = to_own(&parse_document(source));
        run(&mut own);

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
    fn a_spaced_image_destination_is_claimed() {
        let shapes = shapes("![示例](家常菜谱 图解：红烧肉篇.assets/步骤图.png)\n");

        assert_eq!(shapes.len(), 1, "one image node, no literals: {shapes:?}");
        assert!(shapes[0].contains("Image"), "{shapes:?}");
        assert!(
            shapes[0].contains("url: \"家常菜谱 图解：红烧肉篇.assets/步骤图.png\""),
            "{shapes:?}"
        );
        assert!(shapes[0].contains("alt: \"示例\""), "{shapes:?}");
    }

    #[test]
    fn a_spaced_link_destination_is_claimed() {
        let shapes = shapes("see [说明](说明 文档.md) now\n");

        assert_eq!(shapes.len(), 3, "text, link, text: {shapes:?}");
        assert!(shapes[1].contains("Link"), "{shapes:?}");
        assert!(shapes[1].contains("url: \"说明 文档.md\""), "{shapes:?}");
    }

    #[test]
    fn an_empty_label_is_claimed_for_an_image() {
        let shapes = shapes("![](空白 文件.png)\n");

        assert_eq!(shapes.len(), 1, "{shapes:?}");
        assert!(shapes[0].contains("alt: \"\""), "{shapes:?}");
    }

    #[test]
    fn a_destination_without_a_space_is_never_claimed() {
        // The engine parses these; defensively the scan declines them too.
        assert!(claim_within("[a](b.png)", 1).is_none());
        assert!(claim_within("![a](b.png)", 1).is_none());
        assert!(claim_within("[a]()", 1).is_none());
    }

    #[test]
    fn an_angle_bracket_destination_is_never_claimed() {
        assert!(claim_within("[a](<b c.png>)", 1).is_none());
    }

    #[test]
    fn balanced_parentheses_stay_in_the_destination() {
        let nodes = claim_within("[a](图 (1).png)", 1).expect("claimed");
        let OwnKind::Link { url, .. } = &nodes[0].kind else {
            panic!("expected a link: {:?}", nodes[0].kind);
        };
        assert_eq!(url, "图 (1).png");

        // A nested closer does not end the destination.
        let nodes = claim_within("![x](图 (1) copy.png)", 1).expect("claimed");
        let OwnKind::Image { url, .. } = &nodes[0].kind else {
            panic!("expected an image: {:?}", nodes[0].kind);
        };
        assert_eq!(url, "图 (1) copy.png");
    }

    #[test]
    fn an_unbalanced_destination_stays_literal() {
        assert!(claim_within("[a](b (c.png)", 1).is_none());
        assert!(claim_within("[a](b c.png", 1).is_none());
    }

    #[test]
    fn a_nested_label_declines_and_stays_literal() {
        assert!(claim_within("[a[b]](c d)", 1).is_none());
    }

    #[test]
    fn an_escaped_bracket_is_never_claimed_when_it_survives() {
        // The scan declines a bracket whose previous byte is a backslash.
        // The parser usually resolves escapes before this pass sees them
        // (the edge is pinned below), so this only matters for values built
        // directly or kept by a future caller.
        assert!(claim_within("\\[a](b c)", 1).is_none());
    }

    #[test]
    fn an_escaped_exclamation_leaves_a_plain_link_claim() {
        let nodes = claim_within("\\![a](b c)", 1).expect("the link after the escape claims");

        // The escaped `!` stays a literal text run; the plain `[a](b c)`
        // behind it claims as any spaced link would.
        assert!(
            matches!(&nodes[0].kind, OwnKind::Text(value) if value == "\\!"),
            "{nodes:?}"
        );
        let OwnKind::Link { url, .. } = &nodes[1].kind else {
            panic!("expected a link, got {:?}", nodes[1].kind);
        };
        assert_eq!(url, "b c");
    }

    #[test]
    fn an_escape_that_parsing_resolved_cannot_be_told_apart() {
        // `\!` reaches this pass as a bare `!`, so the run claims like an
        // unescaped one. Accepted edge: a code span is the way to show the
        // literal markup in prose.
        let doc = crate::markdown::render_document("\\![a](b c)\n");

        assert!(
            doc.html.contains("<img src=\"b c\" alt=\"a\" />"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn a_destination_may_not_span_lines() {
        assert!(claim_within("[a](b\nc d)", 1).is_none());
    }

    #[test]
    fn several_runs_in_one_text_are_all_claimed() {
        let shapes = shapes("![一](一 图.png) and ![二](二 图.png)\n");

        assert_eq!(shapes.len(), 3, "image, text, image: {shapes:?}");
        assert!(shapes[0].contains("Image"), "{shapes:?}");
        assert!(shapes[1].contains("Text(\" and \")"), "{shapes:?}");
        assert!(shapes[2].contains("Image"), "{shapes:?}");
    }

    // End-to-end shapes through the full render pipeline.

    #[test]
    fn the_claimed_image_renders_and_searches_like_any_image() {
        let doc = crate::markdown::render_document(
            "![示例](家常菜谱 图解：红烧肉篇.assets/步骤图.png)\n",
        );

        assert!(
            doc.html
                .contains("<img src=\"家常菜谱 图解：红烧肉篇.assets/步骤图.png\" alt=\"示例\" />"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, "示例");
    }

    #[test]
    fn the_claimed_link_renders_like_any_link() {
        let doc = crate::markdown::render_document("[说明](说明 文档.md)\n");

        assert!(
            doc.html.contains("<a href=\"说明 文档.md\">说明</a>"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, "说明");
    }

    #[test]
    fn code_keeps_the_literal_syntax() {
        let doc =
            crate::markdown::render_document("`![a](b c.png)` and\n\n```\n![a](b c.png)\n```\n");

        assert!(
            doc.html.contains("<code>![a](b c.png)</code>"),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html
                .contains("<pre class=\"code\"><code>![a](b c.png)\n</code></pre>"),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains("<img"), "html: {}", doc.html);
        assert!(!doc.html.contains("<a "), "html: {}", doc.html);
    }

    #[test]
    fn an_angle_wrapped_destination_is_left_to_the_engine() {
        let doc = crate::markdown::render_document("![a](<b c.png>)\n");

        assert!(
            doc.html.contains("<img src=\"b c.png\" alt=\"a\" />"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn a_claim_inside_emphasis_still_claims() {
        let doc = crate::markdown::render_document("*see [说明](说明 文档.md) here*\n");

        assert!(
            doc.html
                .contains("<em>see <a href=\"说明 文档.md\">说明</a> here</em>"),
            "html: {}",
            doc.html
        );
    }
}
