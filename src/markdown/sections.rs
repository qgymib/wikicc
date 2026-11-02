//! Chapter blocks: the body HTML of one document cut at its headings.
//!
//! A "block reference" — `[label](other.md#chapter)` — shows the target chapter
//! when the reader hovers the link. The reader needs that chapter's own HTML
//! *and* the HTML of everything nested under it, and it must be the same HTML
//! the document body already carries, so links, assets and highlighted code
//! keep working inside the preview. Slicing the finished document a second time
//! in the browser would mean re-parsing markup; slicing it here, while the
//! event stream is still known, is exact.
//!
//! The renderer therefore records where every heading starts in the serialised
//! body and hands those offsets to [`slice`], which returns one [`Block`] per
//! heading. A block runs from its heading to the next heading of *any* level,
//! so it holds exactly its own content and no subsection.
//!
//! That is a property of the *representation*, not a limitation on what a
//! chapter is. Each block also carries its place in the outline — [`Block::parent`]
//! and [`Block::subtree`] — so "the chapter and everything under it" is a
//! lookup ([`Block::subtree`]), not something each consumer has to rebuild. The
//! alternative — one block per chapter including its descendants — was rejected
//! because a paragraph nested three levels deep would then be serialised into
//! four blocks, and the payload would grow with nesting depth instead of with
//! the document. Stopping at the next heading of any level keeps every
//! paragraph in exactly one block: the payload costs one copy of the body plus
//! a few indices per block, however deep the outline goes.
//!
//! Content before the first heading belongs to no block and is dropped: a
//! block reference always names a heading.

use serde::{Deserialize, Serialize};

/// One chapter of the body HTML: its heading and its own content.
///
/// A block is self-contained in two senses. It holds the markup of its own
/// chapter only, so no paragraph of the document is serialised twice; and it
/// knows where it sits in the outline, so the chapter it opens — itself plus
/// every block nested under it — is addressable without consulting anything
/// else in the payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Block {
    /// Anchor of the heading that opens the block.
    pub id: String,
    /// Heading level, 1–6.
    pub level: u32,
    /// Index of the block this one is nested under, if any.
    ///
    /// The parent is the closest preceding block with a smaller level, which is
    /// the same rule [`super::toc::build_toc`] uses, so the two structures
    /// always agree.
    pub parent: Option<usize>,
    /// HTML of the heading and everything under it up to the next heading.
    pub html: String,
    /// Indices of this block and of every block nested under it, in document
    /// order; the first element is always this block's own index.
    ///
    /// This is what makes a whole chapter readable without walking a tree:
    /// joining `subtree` in order reproduces the chapter and its descendants
    /// exactly as the source wrote them.
    pub subtree: Vec<usize>,
}

/// Split the body `html` at the offsets in `starts` into one [`Block`] per
/// heading, and link the blocks into an outline.
///
/// `starts` must be ascending and inside `html`; `ids[i]` and `levels[i]` are
/// the anchor and the level of heading `i`. Every block runs to the start of
/// the next one, and the last runs to the end of the body — a block therefore
/// never contains a sibling or a subsection.
///
/// The outline is derived from the same level transitions
/// [`super::toc::build_toc`] uses: a block's parent is the closest preceding
/// block with a smaller level, or nothing when there is none. Building it here
/// rather than in a second pass is what lets `subtree` be filled in the same
/// walk, at the cost of one index push per open ancestor — bounded by the six
/// heading levels Markdown has.
///
/// A start beyond the body, or an id/level slot that is missing, drops that
/// block instead of guessing: a bug in the renderer can lose a chapter from the
/// payload but can never pair a chapter with another one's text. Dropping a
/// block also leaves any block that claimed it as a parent without one, which
/// is why parents are resolved against the blocks actually produced.
pub fn slice(html: &str, starts: &[usize], ids: &[String], levels: &[u32]) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::with_capacity(starts.len().min(ids.len()));

    // Stack of open ancestors, as indices into `blocks`. It only ever holds
    // blocks whose `subtree` is still being filled.
    let mut open: Vec<usize> = Vec::new();

    for (index, id) in ids.iter().enumerate() {
        let (Some(&start), Some(&level)) = (starts.get(index), levels.get(index)) else {
            break;
        };
        let end = starts.get(index + 1).copied().unwrap_or(html.len());

        let Some(text) = html.get(start..end) else {
            continue;
        };
        if start > end {
            continue;
        }

        // Close every open block at the same level or deeper: it cannot be the
        // parent of this one.
        let position = blocks.len();
        while let Some(&candidate) = open.last() {
            if blocks[candidate].level < level {
                break;
            }
            open.pop();
        }

        let parent = open.last().copied();

        blocks.push(Block {
            id: id.clone(),
            level,
            parent,
            html: text.to_string(),
            subtree: vec![position],
        });

        // Every open ancestor now contains this block.
        for &ancestor in &open {
            blocks[ancestor].subtree.push(position);
        }
        open.push(position);
    }

    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    /// Blocks of a body whose headings are given as `(level, id, html)`.
    fn blocks(specs: &[(u32, &str, &str)]) -> Vec<Block> {
        let mut html = String::new();
        let mut starts = Vec::new();
        let mut anchors = Vec::new();
        let mut levels = Vec::new();

        for (level, id, chunk) in specs {
            starts.push(html.len());
            anchors.push((*id).to_string());
            levels.push(*level);
            html.push_str(chunk);
        }

        slice(&html, &starts, &anchors, &levels)
    }

    #[test]
    fn a_block_runs_from_its_heading_to_the_next_one() {
        let built = blocks(&[
            (2, "a", "<h2 id=\"a\">A</h2>\n<p>one</p>\n"),
            (2, "b", "<h2 id=\"b\">B</h2>\n<p>two</p>\n"),
        ]);

        assert_eq!(
            built
                .iter()
                .map(|block| (block.id.as_str(), block.html.as_str()))
                .collect::<Vec<_>>(),
            [
                ("a", "<h2 id=\"a\">A</h2>\n<p>one</p>\n"),
                ("b", "<h2 id=\"b\">B</h2>\n<p>two</p>\n"),
            ]
        );
    }

    #[test]
    fn the_last_block_reaches_the_end_of_the_body() {
        let html = "<h1 id=\"only\">Only</h1>\n<p>text</p>\n";

        assert_eq!(
            slice(html, &[0], &ids(&["only"]), &[1]),
            [Block {
                id: "only".to_string(),
                level: 1,
                parent: None,
                html: html.to_string(),
                subtree: vec![0],
            }]
        );
    }

    #[test]
    fn a_document_without_headings_has_no_blocks() {
        assert!(slice("<p>text</p>", &[], &[], &[]).is_empty());
    }

    #[test]
    fn content_before_the_first_heading_is_not_a_block() {
        let html = "<p>preamble</p>\n<h2 id=\"a\">A</h2>\n";
        let start = html.find("<h2").expect("heading offset");

        assert_eq!(
            slice(html, &[start], &ids(&["a"]), &[2]),
            [Block {
                id: "a".to_string(),
                level: 2,
                parent: None,
                html: "<h2 id=\"a\">A</h2>\n".to_string(),
                subtree: vec![0],
            }]
        );
    }

    #[test]
    fn a_heading_without_an_id_is_dropped_instead_of_guessed() {
        let html = "<h2 id=\"a\">A</h2>\n";

        assert!(slice(html, &[0], &[], &[2]).is_empty());
    }

    #[test]
    fn offsets_beyond_the_body_drop_the_block() {
        let html = "<h2 id=\"a\">A</h2>\n";

        assert!(
            slice(html, &[html.len() + 5], &ids(&["a"]), &[2]).is_empty(),
            "a start beyond the body cannot address a block"
        );
    }

    #[test]
    fn non_ascii_content_is_sliced_on_byte_boundaries() {
        let html = "<h2 id=\"第一章\">第一章</h2>\n<p>正文</p>\n";

        assert_eq!(
            slice(html, &[0], &ids(&["第一章"]), &[2]),
            [Block {
                id: "第一章".to_string(),
                level: 2,
                parent: None,
                html: html.to_string(),
                subtree: vec![0],
            }]
        );
    }

    /// The outline is
    ///
    ///     0 A      (h1)
    ///     1 A1     (h2)
    ///     2 A1a    (h3)
    ///     3 A1b    (h3)
    ///     4 A2     (h2)
    ///     5 B      (h1)
    ///     6 B1     (h2)
    fn nested() -> Vec<Block> {
        blocks(&[
            (1, "a", "<p>a</p>"),
            (2, "a1", "<p>a1</p>"),
            (3, "a1a", "<p>a1a</p>"),
            (3, "a1b", "<p>a1b</p>"),
            (2, "a2", "<p>a2</p>"),
            (1, "b", "<p>b</p>"),
            (2, "b1", "<p>b1</p>"),
        ])
    }

    #[test]
    fn a_block_names_the_closest_shallower_block_as_its_parent() {
        let built = nested();

        assert_eq!(
            built
                .iter()
                .map(|block| (block.id.as_str(), block.parent))
                .collect::<Vec<_>>(),
            [
                ("a", None),
                ("a1", Some(0)),
                ("a1a", Some(1)),
                ("a1b", Some(1)),
                ("a2", Some(0)),
                ("b", None),
                ("b1", Some(5)),
            ]
        );
    }

    #[test]
    fn a_subtree_is_the_block_and_all_of_its_descendants_in_document_order() {
        let built = nested();

        assert_eq!(built[0].subtree, [0, 1, 2, 3, 4], "the whole of A");
        assert_eq!(built[1].subtree, [1, 2, 3], "A1 and its children");
        assert_eq!(built[2].subtree, [2], "a leaf is only itself");
        assert_eq!(built[4].subtree, [4], "a sibling subtree excludes a1");
        assert_eq!(built[5].subtree, [5, 6], "B carries B1");
    }

    #[test]
    fn every_subtree_opens_with_its_own_index_and_never_repeats_one() {
        for (index, block) in nested().iter().enumerate() {
            assert_eq!(
                block.subtree.first().copied(),
                Some(index),
                "{}: a subtree starts at its own block",
                block.id
            );

            let mut sorted = block.subtree.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(
                sorted, block.subtree,
                "{}: a subtree is a strictly ascending index list",
                block.id
            );
        }
    }

    #[test]
    fn parent_and_subtree_agree_with_each_other() {
        let built = nested();

        for (child, block) in built.iter().enumerate() {
            for (ancestor, candidate) in built.iter().enumerate() {
                if child == ancestor {
                    continue;
                }
                // `child` is in `ancestor`'s subtree exactly when walking up
                // from `child` reaches `ancestor`.
                let mut cursor = block.parent;
                let mut reached = false;
                while let Some(index) = cursor {
                    if index == ancestor {
                        reached = true;
                        break;
                    }
                    cursor = built[index].parent;
                }

                assert_eq!(
                    candidate.subtree.contains(&child),
                    reached,
                    "{} in {}'s subtree must mean {} is its ancestor",
                    built[child].id,
                    candidate.id,
                    candidate.id
                );
            }
        }
    }

    #[test]
    fn a_level_jump_nests_under_the_last_shallower_block() {
        let built = blocks(&[
            (1, "top", "<p>top</p>"),
            (3, "deep", "<p>deep</p>"),
            (4, "deeper", "<p>deeper</p>"),
        ]);

        assert_eq!(built[1].parent, Some(0), "h3 attaches directly to h1");
        assert_eq!(built[2].parent, Some(1));
        assert_eq!(built[0].subtree, [0, 1, 2]);
    }

    #[test]
    fn a_document_starting_below_level_one_still_has_a_root() {
        let built = blocks(&[(3, "deep", "<p>deep</p>"), (4, "deeper", "<p>deeper</p>")]);

        assert_eq!(built[0].parent, None);
        assert_eq!(built[0].subtree, [0, 1]);
    }

    #[test]
    fn joining_every_subtree_of_a_root_reproduces_the_body() {
        let built = nested();
        let joined: String = built[0]
            .subtree
            .iter()
            .map(|&index| built[index].html.as_str())
            .collect();

        assert_eq!(
            joined, "<p>a</p><p>a1</p><p>a1a</p><p>a1b</p><p>a2</p>",
            "a whole chapter is its subtree, with no paragraph repeated"
        );
    }

    #[test]
    fn the_payload_grows_with_the_document_not_with_the_nesting_depth() {
        // Four headings carrying the same markup, arranged once as a deep
        // chain and once flat. The markup each arrangement stores must be
        // identical: only the small per-block index lists may differ, so the
        // payload cannot grow with the nesting depth.
        let markup = "<p>x</p>";
        let deep = blocks(&[
            (1, "h1", markup),
            (2, "h2", markup),
            (3, "h3", markup),
            (4, "h4", markup),
        ]);
        let flat = blocks(&[
            (1, "h1", markup),
            (1, "h2", markup),
            (1, "h3", markup),
            (1, "h4", markup),
        ]);

        assert_eq!(
            deep.iter().map(|block| &block.html).collect::<Vec<_>>(),
            flat.iter().map(|block| &block.html).collect::<Vec<_>>(),
            "the deepest block holds the same markup as the shallowest"
        );
        assert_eq!(
            deep.iter().map(|block| block.html.len()).sum::<usize>(),
            markup.len() * 4,
            "the body is serialised once, however deep the outline goes"
        );

        // The only growth is one index per ancestor, bounded by the six levels
        // Markdown allows.
        let indices: usize = deep.iter().map(|block| block.subtree.len()).sum();
        assert_eq!(indices, 10, "1 + 2 + 3 + 4 for a chain of four");
    }
}
