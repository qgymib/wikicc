//! The output artifact format.

use std::fmt;
use std::str::FromStr;

use crate::error::{Error, Result};

/// Output artifact format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum OutputFormat {
    /// One `.html` file with every non-text resource inlined as a data URI.
    #[default]
    SingleHtml,
    /// `index.html` plus a deduplicated `assets/` directory.
    HtmlDir,
    /// A shell `index.html` plus one lazily fetched JSON chunk per document,
    /// a search corpus file and the `assets/` directory; a static site whose
    /// natural home is GitHub Pages, served over HTTP.
    Pages,
}

impl OutputFormat {
    /// Every accepted format, in CLI order.
    pub const ALL: [OutputFormat; 3] = [Self::SingleHtml, Self::HtmlDir, Self::Pages];

    /// CLI spelling of the format.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SingleHtml => "single-html",
            Self::HtmlDir => "html-dir",
            Self::Pages => "pages",
        }
    }
}

impl fmt::Display for OutputFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for OutputFormat {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|format| format.as_str() == value)
            .ok_or_else(|| {
                Error::InvalidInput(format!(
                    "invalid format '{value}', expected one of: single-html, html-dir, pages"
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_format() {
        assert_eq!(
            "single-html".parse::<OutputFormat>().unwrap(),
            OutputFormat::SingleHtml
        );
        assert_eq!(
            "html-dir".parse::<OutputFormat>().unwrap(),
            OutputFormat::HtmlDir
        );
        assert_eq!(
            "pages".parse::<OutputFormat>().unwrap(),
            OutputFormat::Pages
        );
    }

    #[test]
    fn rejects_unknown_format_with_documented_message() {
        let error = "pdf".parse::<OutputFormat>().unwrap_err();

        assert_eq!(
            error.to_string(),
            "invalid format 'pdf', expected one of: single-html, html-dir, pages"
        );
        assert_eq!(error.exit_code(), crate::error::EXIT_FAILURE);
    }

    #[test]
    fn a_removed_format_is_an_unknown_format() {
        let error = "mhtml".parse::<OutputFormat>().unwrap_err();
        let retired_multi = "multi-html".parse::<OutputFormat>().unwrap_err();

        assert_eq!(
            error.to_string(),
            "invalid format 'mhtml', expected one of: single-html, html-dir, pages"
        );
        assert_eq!(
            retired_multi.to_string(),
            "invalid format 'multi-html', expected one of: single-html, html-dir, pages",
            "the pre-rename spelling is an unknown format, not an alias"
        );
    }

    #[test]
    fn format_parsing_is_case_sensitive() {
        assert!("Single-Html".parse::<OutputFormat>().is_err());
        assert!(" single-html".parse::<OutputFormat>().is_err());
    }

    #[test]
    fn display_matches_cli_spelling() {
        for format in OutputFormat::ALL {
            assert_eq!(format.to_string(), format.as_str());
        }
        assert_eq!(OutputFormat::default(), OutputFormat::SingleHtml);
    }
}
