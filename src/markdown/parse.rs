//! Parsing: one mdast tree per document, built once and shared by every pass.
//!
//! The rendering pipeline parses each document exactly once with
//! [`markdown::to_mdast`] and hands the tree to the own-layer transforms and
//! the serialiser. Every consumer — the render pass, the anchor pre-pass
//! ([`super::sections_of`]) and the title extraction in `crate::scan` — goes
//! through [`parse_document`], so a document is never parsed twice and all of
//! them see the same tree.
//!
//! The construct set is the product's syntax promise: the GFM subset
//! (tables, footnotes, strikethrough, task lists, literal autolinks) plus the
//! Typora constructs the parser itself carries — YAML front matter and inline
//! and block math. GFM single-tilde strikethrough stays **off** so
//! `~subscript~` remains available to the own-layer subscript transform;
//! `~~strikethrough~~` is unaffected. MDX stays off: wikicc renders
//! documents, not components.

use markdown::mdast::{Node, Paragraph, Root, Text};
use markdown::{Constructs, ParseOptions, to_mdast};

/// Parser configuration compiled in.
///
/// Shared by every parse of every document, so the render pass, the anchor
/// pre-pass and the title scan always agree on what the source means.
pub fn parse_options() -> ParseOptions {
    ParseOptions {
        constructs: Constructs {
            frontmatter: true,
            math_flow: true,
            math_text: true,
            ..Constructs::gfm()
        },
        gfm_strikethrough_single_tilde: false,
        ..ParseOptions::default()
    }
}

/// Parse `source` into the mdast tree every pass works on.
///
/// Never fails: `to_mdast` rejects only input that no rendering of it could
/// represent (an MDX construct reaching the parser despite the toggles), and
/// a document like that degrades to one paragraph of escaped text instead of
/// failing the build.
pub(crate) fn parse_document(source: &str) -> Node {
    to_mdast(source, &parse_options()).unwrap_or_else(|_| degrade_to_paragraph(source))
}

/// The never-fail fallback: the whole source as the text of one paragraph.
fn degrade_to_paragraph(source: &str) -> Node {
    Node::Root(Root {
        children: vec![Node::Paragraph(Paragraph {
            children: vec![Node::Text(Text {
                value: source.to_string(),
                position: None,
            })],
            position: None,
        })],
        position: None,
    })
}

#[cfg(test)]
mod tests {
    use markdown::mdast::Node;

    use super::*;

    #[test]
    fn the_construct_set_enables_the_promised_syntax() {
        let options = parse_options();

        // The GFM subset the product promises.
        assert!(options.constructs.gfm_table);
        assert!(options.constructs.gfm_footnote_definition);
        assert!(options.constructs.gfm_label_start_footnote);
        assert!(options.constructs.gfm_strikethrough);
        assert!(options.constructs.gfm_task_list_item);
        assert!(options.constructs.gfm_autolink_literal);

        // Typora constructs that arrive with the parser.
        assert!(options.constructs.frontmatter);
        assert!(options.constructs.math_flow);
        assert!(options.constructs.math_text);

        // Single tilde belongs to the own-layer subscript transform.
        assert!(!options.gfm_strikethrough_single_tilde);

        // MDX is a component format, not a document format.
        assert!(!options.constructs.mdx_esm);
        assert!(!options.constructs.mdx_expression_flow);
        assert!(!options.constructs.mdx_expression_text);
        assert!(!options.constructs.mdx_jsx_flow);
        assert!(!options.constructs.mdx_jsx_text);
    }

    #[test]
    fn tables_footnotes_tasks_strikethrough_and_math_parse() {
        let tree = parse_document(
            "| a |\n| - |\n| 1 |\n\n~~old~~ text[^note]\n\n- [x] done\n\n$$\nE=mc^2\n$$\n\n[^note]: the footnote\n",
        );
        let Node::Root(root) = &tree else {
            panic!("a document parses to a root");
        };

        assert!(
            root.children
                .iter()
                .any(|node| matches!(node, Node::Table(_)))
        );
        assert!(
            root.children
                .iter()
                .any(|node| matches!(node, Node::Math(_))),
            "block math is one node: {tree:?}"
        );
        assert!(
            root.children
                .iter()
                .any(|node| matches!(node, Node::FootnoteDefinition(_))),
            "the footnote definition is a node: {tree:?}"
        );
    }

    #[test]
    fn single_tilde_stays_text_but_double_tilde_strikes_through() {
        let tree = parse_document("H~2~O and ~~old~~\n");
        let debug = format!("{tree:?}");

        assert!(debug.contains("Delete"), "double tilde deletes: {debug}");
        assert!(
            !debug.contains("Delete(\"2\")"),
            "single tilde must stay literal text: {debug}"
        );
    }

    #[test]
    fn front_matter_parses_to_a_yaml_node() {
        let tree = parse_document("---\ntitle: t\n---\n\nbody\n");
        let Node::Root(root) = &tree else {
            panic!("a document parses to a root");
        };

        assert!(
            root.children
                .iter()
                .any(|node| matches!(node, Node::Yaml(_))),
            "front matter is one yaml node: {tree:?}"
        );
    }

    #[test]
    fn a_definition_keeps_its_position_and_fields() {
        let tree = parse_document("see [1]\n\n[1]: https://example.com \"Title\"\n");
        let Node::Root(root) = &tree else {
            panic!("a document parses to a root");
        };

        let Node::Definition(definition) = &root.children[1] else {
            panic!("the second block is the definition: {tree:?}");
        };
        assert_eq!(definition.identifier, "1");
        assert_eq!(definition.label.as_deref(), Some("1"));
        assert_eq!(definition.url, "https://example.com");
        assert_eq!(definition.title.as_deref(), Some("Title"));
        let position = definition.position.as_ref().expect("position");
        assert_eq!(position.start.line, 3);
        assert_eq!(position.start.offset, 9);
    }
}
