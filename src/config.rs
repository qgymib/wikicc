//! Site configuration file: `.wikicc.json` in the input folder root.
//!
//! The file is optional and currently carries one key, `home`: the document
//! the reader shows when it is opened at an empty or unknown address. The
//! value is a document id — the path relative to the input folder, `/`
//! separated, extension included — with one lenience: a missing `.md` (or
//! `.markdown`) suffix is completed, so `"home": "intro"` addresses
//! `intro.md`.
//!
//! Failure policy follows the file's role as an explicit build instruction:
//!
//! - a file that cannot be parsed or does not follow the shape is a hard
//!   [`Error::InvalidInput`] — silently ignoring a broken instruction would
//!   produce a site the author did not ask for;
//! - a `home` that matches no document is a [`Diagnostic::warning`] (the
//!   `--strict` gate upgrades it) and the reader falls back to the first
//!   document, exactly as it does without a configuration;
//! - unknown keys warn too, so a typo or a key this version does not
//!   understand never silently changes nothing.
//!
//! Pure: [`load`] touches only the configuration file itself, and resolving
//! [`SiteConfig::resolve_home`] compares strings, so both are unit tested
//! against plain data.

use std::path::Path;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::scan::Diagnostic;

/// Name of the configuration file, looked up at the input folder root.
///
/// A dotfile, so ordinary directory listings and most VCS ignore rules treat
/// it as metadata rather than content.
pub const CONFIG_FILE_NAME: &str = ".wikicc.json";

/// Prefix of every configuration [`Diagnostic`], so messages name their source.
const DIAGNOSTIC_PREFIX: &str = "config:";

/// The parsed configuration of one build.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SiteConfig {
    /// The `home` value exactly as written, before it is matched against the
    /// scanned document ids.
    pub home: Option<String>,
    /// Messages collected while reading the file, in key order.
    pub diagnostics: Vec<Diagnostic>,
}

impl SiteConfig {
    /// Resolve the configured `home` against the scanned document ids.
    ///
    /// The value is normalized (surrounding whitespace dropped, `\` read as
    /// `/`, a leading `./` dropped) and then matched against the ids: first
    /// verbatim, then with a `.md` and finally a `.markdown` suffix
    /// completed. The resolution returns the *matched* id, so the payload
    /// always carries a spelling the reader knows.
    ///
    /// A value that matches nothing yields a warning and `None`; the reader
    /// then falls back to the first document, its behaviour without a
    /// configuration.
    pub fn resolve_home(&self, ids: &[String]) -> (Option<String>, Vec<Diagnostic>) {
        let mut diagnostics = Vec::new();
        let Some(raw) = &self.home else {
            return (None, diagnostics);
        };

        let candidate = normalize_candidate(raw);
        let matched = ids
            .iter()
            .find(|id| id.as_str() == candidate)
            .or_else(|| ids.iter().find(|id| **id == format!("{candidate}.md")))
            .or_else(|| {
                ids.iter()
                    .find(|id| **id == format!("{candidate}.markdown"))
            })
            .cloned();

        match matched {
            Some(id) => (Some(id), diagnostics),
            None => {
                diagnostics.push(Diagnostic::warning(format!(
                    "{DIAGNOSTIC_PREFIX} home '{candidate}' does not match any document"
                )));
                (None, diagnostics)
            }
        }
    }
}

/// Read `.wikicc.json` from the input folder root.
///
/// A missing file is the default configuration; an existing file that cannot
/// be read, parsed or understood is a hard error.
pub fn load(input: &Path) -> Result<SiteConfig> {
    let path = input.join(CONFIG_FILE_NAME);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SiteConfig::default());
        }
        Err(error) => {
            return Err(Error::InvalidInput(format!(
                "cannot read '{}': {error}",
                path.display()
            )));
        }
    };

    parse(&bytes, &path)
}

/// Parse the configuration bytes, with a UTF-8 BOM tolerated.
fn parse(bytes: &[u8], path: &Path) -> Result<SiteConfig> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let value: Value = serde_json::from_str(text).map_err(|error| {
        Error::InvalidInput(format!("'{}' is not valid JSON: {error}", path.display()))
    })?;

    let Value::Object(entries) = value else {
        return Err(Error::InvalidInput(format!(
            "'{}' must contain a JSON object",
            path.display()
        )));
    };

    let mut config = SiteConfig::default();
    for (key, value) in entries {
        match (key.as_str(), value) {
            ("home", Value::Null) => {}
            ("home", Value::String(text)) => {
                if text.trim().is_empty() {
                    return Err(Error::InvalidInput(
                        "'home' must be a non-empty string".to_string(),
                    ));
                }
                config.home = Some(text);
            }
            ("home", _) => {
                return Err(Error::InvalidInput("'home' must be a string".to_string()));
            }
            (unknown, _) => {
                config.diagnostics.push(Diagnostic::warning(format!(
                    "{DIAGNOSTIC_PREFIX} unknown key '{unknown}' ignored"
                )));
            }
        }
    }

    Ok(config)
}

/// Normalize a `home` value for matching: trimmed, `/`-separated, without a
/// leading `./`.
fn normalize_candidate(raw: &str) -> String {
    let mut candidate = raw.trim().replace('\\', "/");
    while let Some(rest) = candidate.strip_prefix("./") {
        candidate = rest.to_string();
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_text(text: &str) -> Result<SiteConfig> {
        parse(text.as_bytes(), Path::new(".wikicc.json"))
    }

    fn warning_messages(config: &SiteConfig) -> Vec<String> {
        config
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.to_string())
            .collect()
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn a_missing_file_is_the_default_configuration() {
        let dir = tempfile::tempdir().expect("temp dir");

        let config = load(dir.path()).expect("a missing file is not an error");

        assert_eq!(config, SiteConfig::default());
        assert_eq!(config.home, None);
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn home_is_read_verbatim() {
        let config = parse_text(r#"{"home": "guide/intro.md"}"#).expect("valid config");

        assert_eq!(config.home.as_deref(), Some("guide/intro.md"));
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn a_bom_is_tolerated() {
        let with_bom = "\u{feff}{\"home\": \"intro.md\"}";
        let config = parse_text(with_bom).expect("BOM is stripped before parsing");

        assert_eq!(config.home.as_deref(), Some("intro.md"));
    }

    #[test]
    fn a_null_home_is_unset() {
        let config = parse_text(r#"{"home": null}"#).expect("valid config");

        assert_eq!(config.home, None);
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn an_empty_home_is_a_hard_error() {
        for text in [r#"{"home": ""}"#, r#"{"home": "   "}"#] {
            let error = parse_text(text).expect_err("empty home is rejected");
            assert_eq!(error.to_string(), "'home' must be a non-empty string");
        }
    }

    #[test]
    fn a_non_string_home_is_a_hard_error() {
        let error = parse_text(r#"{"home": 3}"#).expect_err("a number is not a home");

        assert_eq!(error.to_string(), "'home' must be a string");
    }

    #[test]
    fn a_non_object_root_is_a_hard_error() {
        let error = parse_text("[]").expect_err("an array is not a configuration");

        assert_eq!(
            error.to_string(),
            "'.wikicc.json' must contain a JSON object"
        );
    }

    #[test]
    fn malformed_json_is_a_hard_error_that_names_the_file() {
        let error = parse_text("{").expect_err("truncated JSON is rejected");

        assert!(
            error
                .to_string()
                .starts_with("'.wikicc.json' is not valid JSON:"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn an_unreadable_file_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        // A directory at the configuration path is the one portable way to
        // make the read fail with an error other than "not found".
        std::fs::create_dir(dir.path().join(CONFIG_FILE_NAME)).expect("create fixture");

        let error = load(dir.path()).expect_err("a directory cannot be read as a file");

        assert!(
            error.to_string().starts_with("cannot read '"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn unknown_keys_warn_but_do_not_stop_the_build() {
        let config = parse_text(r#"{"title": "x", "home": "b.md"}"#).expect("valid config");

        assert_eq!(config.home.as_deref(), Some("b.md"));
        assert_eq!(
            warning_messages(&config),
            ["warning: config: unknown key 'title' ignored"]
        );
    }

    #[test]
    fn unknown_key_messages_come_in_key_order() {
        let config = parse_text(r#"{"zebra": 1, "apple": 2}"#).expect("valid config");

        assert_eq!(
            warning_messages(&config),
            [
                "warning: config: unknown key 'apple' ignored",
                "warning: config: unknown key 'zebra' ignored",
            ]
        );
    }

    #[test]
    fn home_resolves_to_the_exact_id_first() {
        let config = SiteConfig {
            home: Some("guide/intro.md".to_string()),
            diagnostics: Vec::new(),
        };

        let (home, diagnostics) = config.resolve_home(&ids(&["a.md", "guide/intro.md"]));

        assert_eq!(home.as_deref(), Some("guide/intro.md"));
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn home_completes_a_missing_extension() {
        for (value, expected) in [("intro", "intro.md"), ("intro.markdown", "intro.markdown")] {
            let config = SiteConfig {
                home: Some(value.to_string()),
                diagnostics: Vec::new(),
            };

            let (home, diagnostics) = config.resolve_home(&ids(&["intro.md", "intro.markdown"]));

            assert_eq!(home.as_deref(), Some(expected), "home: {value}");
            assert!(diagnostics.is_empty());
        }
    }

    #[test]
    fn home_prefers_the_exact_id_over_a_completed_one() {
        let config = SiteConfig {
            home: Some("intro".to_string()),
            diagnostics: Vec::new(),
        };

        // `intro` exists as a folder-less id only in exotic sites; the point
        // is that verbatim wins before any suffix is completed.
        let (home, _) = config.resolve_home(&ids(&["intro", "intro.md"]));

        assert_eq!(home.as_deref(), Some("intro"));
    }

    #[test]
    fn home_normalizes_separators_and_local_prefixes() {
        for (value, expected) in [
            (r"guide\intro.md", "guide/intro.md"),
            ("./intro.md", "intro.md"),
            ("  intro.md  ", "intro.md"),
        ] {
            let config = SiteConfig {
                home: Some(value.to_string()),
                diagnostics: Vec::new(),
            };

            let (home, _) = config.resolve_home(&ids(&["guide/intro.md", "intro.md"]));

            assert_eq!(home.as_deref(), Some(expected), "home: {value}");
        }
    }

    #[test]
    fn an_unknown_home_warns_and_falls_back_to_none() {
        let config = SiteConfig {
            home: Some("gone.md".to_string()),
            diagnostics: Vec::new(),
        };

        let (home, diagnostics) = config.resolve_home(&ids(&["a.md", "b.md"]));

        assert_eq!(home, None);
        assert_eq!(
            diagnostics
                .iter()
                .map(|diagnostic| diagnostic.to_string())
                .collect::<Vec<_>>(),
            ["warning: config: home 'gone.md' does not match any document"]
        );
    }

    #[test]
    fn a_site_without_a_home_resolves_to_nothing_without_diagnostics() {
        let (home, diagnostics) = SiteConfig::default().resolve_home(&ids(&["a.md"]));

        assert_eq!(home, None);
        assert!(diagnostics.is_empty());
    }
}
