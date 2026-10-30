//! Unicode-aware heading slugs.
//!
//! A slug is the `id` attached to a rendered heading, the key the chapter
//! outline points at, and the `#fragment` half of a deep link.
//!
//! All Unicode work is delegated to ICU4X (`icu`): NFKC compatibility
//! normalisation, full case mapping and the `Alnum` binary property come from
//! its compiled data, so behaviour follows the Unicode standard instead of a
//! hand-maintained table. Only the slug *policy* lives here — which characters
//! survive, how separators collapse, the fallback and the per-document
//! deduplication — because the product promises byte-identical rebuilds and
//! that promise must not depend on a library's opinion about spelling.
//!
//! Rules, applied in this order:
//!
//! 1. NFKC-normalise, so compatibility forms collapse to their canonical
//!    spelling (`Ａ` → `A`, `①` → `1`, `ﬁ` → `fi`, U+3000 → space);
//! 2. lowercase with the root locale, since anchors are never locale-sensitive;
//! 3. keep characters with the Unicode `Alnum` property (`Alphabetic` or
//!    `Decimal_Number`) plus `-` and `_`, drop everything else;
//! 4. turn whitespace into `-` and collapse runs of `-`;
//! 5. strip leading and trailing `-`;
//! 6. fall back to [`FALLBACK_SLUG`] when nothing survives.
//!
//! [`Slugger`] adds per-document uniqueness on top of that: the first `Notes`
//! becomes `notes`, the next ones `notes-1`, `notes-2`, …

use std::collections::BTreeSet;

use icu::casemap::CaseMapper;
use icu::locale::{LanguageIdentifier, langid};
use icu::normalizer::{ComposingNormalizer, ComposingNormalizerBorrowed};
use icu::properties::{CodePointSetData, CodePointSetDataBorrowed, props::Alnum};

/// Slug used when a heading contains no usable character.
pub const FALLBACK_SLUG: &str = "section";

/// NFKC normalisation, backed by ICU4X compiled data.
const NFKC: ComposingNormalizerBorrowed<'static> = ComposingNormalizer::new_nfkc();

/// Unicode `Alnum` property: `Alphabetic` or `Decimal_Number`.
const ALNUM: CodePointSetDataBorrowed<'static> = CodePointSetData::new::<Alnum>();

/// Root locale: heading anchors never depend on the document's language.
const ROOT_LOCALE: LanguageIdentifier = langid!("und");

/// Turn heading text into a slug, without any uniqueness handling.
///
/// The result is never empty; see the module documentation for the rules.
pub fn slugify(text: &str) -> String {
    let normalized = NFKC.normalize(text);
    let lowered = CaseMapper::new().lowercase_to_string(&normalized, &ROOT_LOCALE);
    let mut slug = String::with_capacity(lowered.len());
    let mut dash_pending = false;

    for character in lowered.chars() {
        if character.is_whitespace() {
            dash_pending = true;
        } else if ALNUM.contains(character) || character == '_' {
            if dash_pending && !slug.is_empty() {
                slug.push('-');
            }
            dash_pending = false;
            slug.push(character);
        } else if character == '-' {
            dash_pending = true;
        }
        // Other punctuation, symbols and combining marks are dropped.
    }

    if slug.is_empty() {
        FALLBACK_SLUG.to_string()
    } else {
        slug
    }
}

/// Per-document slug allocator.
///
/// One allocator is created per document, so the same heading text in two
/// documents yields the same anchor and deep links stay meaningful.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Slugger {
    used: BTreeSet<String>,
}

impl Slugger {
    /// Allocator with nothing handed out yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Slug for `text`, made unique within this document.
    ///
    /// The first occurrence keeps the plain slug; later collisions get `-1`,
    /// `-2`, … . Candidates are checked against every slug handed out so far,
    /// so a document that contains both `Notes` (twice) and `Notes 1` never
    /// produces two identical anchors.
    pub fn unique(&mut self, text: &str) -> String {
        let base = slugify(text);
        let mut candidate = base.clone();
        let mut suffix = 1usize;

        while self.used.contains(&candidate) {
            candidate = format!("{base}-{suffix}");
            suffix += 1;
        }

        self.used.insert(candidate.clone());
        candidate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowercases_and_joins_words() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("Getting Started"), "getting-started");
        assert_eq!(slugify("  padded  text  "), "padded-text");
    }

    #[test]
    fn keeps_unicode_alphanumerics() {
        assert_eq!(slugify("第一章"), "第一章");
        assert_eq!(slugify("第一章 概述"), "第一章-概述");
        assert_eq!(slugify("Übersicht"), "übersicht");
        assert_eq!(slugify("ÜBERSICHT"), "übersicht");
    }

    #[test]
    fn normalizes_fullwidth_characters() {
        assert_eq!(slugify("ＡＢＣ"), "abc");
        assert_eq!(slugify("１２３"), "123");
        assert_eq!(slugify("ＡＢＣ　１２３"), "abc-123");
    }

    #[test]
    fn normalizes_compatibility_characters() {
        assert_eq!(slugify("①"), "1", "circled digit");
        assert_eq!(slugify("ﬁle"), "file", "Latin ligature");
        assert_eq!(slugify("Ⅻ"), "xii", "Roman numeral");
        assert_eq!(slugify("½"), "12", "vulgar fraction");
        assert_eq!(slugify("™"), "tm", "trade mark sign");
        assert_eq!(slugify("㍿"), "株式会社", "squared CJK abbreviation");
    }

    #[test]
    fn drops_combining_marks_left_by_lowercasing() {
        assert_eq!(slugify("İstanbul"), "istanbul");
        assert_eq!(slugify("Café"), "café");
    }

    #[test]
    fn drops_punctuation_and_symbols() {
        assert_eq!(slugify("C++ / C# & Rust"), "c-c-rust");
        assert_eq!(slugify("Node.js in 2024"), "nodejs-in-2024");
        assert_eq!(slugify("a (b) [c] {d}"), "a-b-c-d");
    }

    #[test]
    fn collapses_repeated_separators() {
        assert_eq!(slugify("a  b"), "a-b");
        assert_eq!(slugify("a--b"), "a-b");
        assert_eq!(slugify("a - b"), "a-b");
        assert_eq!(slugify("a — b"), "a-b");
    }

    #[test]
    fn strips_leading_and_trailing_separators() {
        assert_eq!(slugify("-leading"), "leading");
        assert_eq!(slugify("trailing---"), "trailing");
        assert_eq!(slugify("!Heading?"), "heading");
        assert_eq!(slugify("...dotted..."), "dotted");
    }

    #[test]
    fn keeps_underscores_and_inner_dashes() {
        assert_eq!(slugify("snake_case_name"), "snake_case_name");
        assert_eq!(slugify("well-known"), "well-known");
        assert_eq!(slugify("step-2"), "step-2");
    }

    #[test]
    fn falls_back_to_section_when_nothing_survives() {
        assert_eq!(slugify(""), FALLBACK_SLUG);
        assert_eq!(slugify("   "), FALLBACK_SLUG);
        assert_eq!(slugify("!!!"), FALLBACK_SLUG);
        assert_eq!(slugify("—— … ——"), FALLBACK_SLUG);
    }

    #[test]
    fn duplicates_get_numbered_suffixes() {
        let mut slugger = Slugger::new();

        assert_eq!(slugger.unique("Notes"), "notes");
        assert_eq!(slugger.unique("Notes"), "notes-1");
        assert_eq!(slugger.unique("Notes"), "notes-2");
    }

    #[test]
    fn duplicate_suffixes_avoid_authored_slugs() {
        let mut slugger = Slugger::new();

        // `Notes 1` already claims `notes-1`, so the second `Notes` must skip it.
        assert_eq!(slugger.unique("Notes 1"), "notes-1");
        assert_eq!(slugger.unique("Notes"), "notes");
        assert_eq!(slugger.unique("Notes"), "notes-2");
    }

    #[test]
    fn empty_headings_still_get_unique_slugs() {
        let mut slugger = Slugger::new();

        assert_eq!(slugger.unique(""), "section");
        assert_eq!(slugger.unique(""), "section-1");
        assert_eq!(slugger.unique("!!!"), "section-2");
    }

    #[test]
    fn allocators_are_independent_per_document() {
        let mut first = Slugger::new();
        let mut second = Slugger::new();

        assert_eq!(first.unique("Notes"), "notes");
        assert_eq!(second.unique("Notes"), "notes");
    }
}
