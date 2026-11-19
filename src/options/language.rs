//! The reader interface language.
//!
//! The language is a build-time setting: whichever source speaks names one of
//! the codes below, and the reader renders its interface copy — the lock
//! page, the search panel, the panel headings, the status and empty lines —
//! in that language. The code travels into the payload and into the page's
//! `lang` attribute; the copy itself lives in the reader bundle's
//! dictionaries (`web/js/i18n.js`), so this type only fixes the vocabulary
//! the three setting surfaces accept.

use std::fmt;
use std::str::FromStr;

use crate::error::{Error, Result};

/// Language the reader's interface copy is rendered in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Language {
    /// English, the default.
    #[default]
    En,
    /// Simplified Chinese.
    Zh,
}

impl Language {
    /// Every accepted language, in CLI order.
    pub const ALL: [Language; 2] = [Self::En, Self::Zh];

    /// Code the payload and the page's `lang` attribute carry.
    ///
    /// Lower case: the dictionaries in the reader bundle are keyed by the
    /// same spelling, and `lang` attribute values are case-insensitive by
    /// the HTML standard but conventionally lower case.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Zh => "zh",
        }
    }
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Language {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        // Letter case is ignored, so `--language EN` addresses the same
        // dictionary; anything else is an unknown code and a hard error.
        let lowered = value.to_ascii_lowercase();
        Self::ALL
            .into_iter()
            .find(|language| language.as_str() == lowered)
            .ok_or_else(|| {
                Error::InvalidInput(format!(
                    "invalid language '{value}', expected one of: en, zh"
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_language() {
        assert_eq!("en".parse::<Language>().unwrap(), Language::En);
        assert_eq!("zh".parse::<Language>().unwrap(), Language::Zh);
    }

    #[test]
    fn parsing_ignores_letter_case() {
        assert_eq!("EN".parse::<Language>().unwrap(), Language::En);
        assert_eq!("Zh".parse::<Language>().unwrap(), Language::Zh);
    }

    #[test]
    fn rejects_unknown_languages_with_documented_message() {
        let error = "fr".parse::<Language>().unwrap_err();

        assert_eq!(
            error.to_string(),
            "invalid language 'fr', expected one of: en, zh"
        );
        assert_eq!(error.exit_code(), crate::error::EXIT_FAILURE);
    }

    #[test]
    fn a_code_carries_no_trimming() {
        assert!(" en".parse::<Language>().is_err());
        assert!("en ".parse::<Language>().is_err());
        assert!("".parse::<Language>().is_err());
    }

    #[test]
    fn display_matches_the_code() {
        for language in Language::ALL {
            assert_eq!(language.to_string(), language.as_str());
        }
        assert_eq!(Language::default(), Language::En);
    }
}
