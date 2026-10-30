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
}
