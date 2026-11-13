//! Environment variable settings: the `WIKICC_*` variables.
//!
//! Environment variables are the second of the three setting sources: an
//! explicit command line flag overrides them, and they override
//! `.wikicc.json`. Seven variables name the settings both other surfaces
//! carry ([`crate::options::Settings`]), spelled with a `WIKICC_` prefix and
//! in upper case only:
//!
//! - `WIKICC_OUT`: the output directory. A relative value is resolved
//!   against the working directory, exactly like a command line `--out` —
//!   the variable speaks from the shell or CI job that exports it, not from
//!   the input folder the configuration file lives in.
//! - `WIKICC_FORMAT`: the output artifact format, spelled like the
//!   `--format` flag.
//! - `WIKICC_TITLE`: the site title.
//! - `WIKICC_STRICT`: whether warnings fail the build; `true`, `false`, `1`
//!   or `0`, in any letter case.
//! - `WIKICC_HOME`: the document the reader opens at an empty or unknown
//!   address, spelled like the `--home` flag.
//! - `WIKICC_EXCLUDE`: the directories kept out of the site, separated by
//!   commas, spelled like a comma-joined `--exclude` list. The variable
//!   replaces the configured list entirely, exactly as the flag does.
//! - `WIKICC_FAVICON`: the favicon file, spelled like the `--favicon` flag.
//!
//! The reading rules follow the variable's role as an export in someone
//! else's environment:
//!
//! - a variable that is not set, or whose value is blank, did not speak —
//!   the next source down decides;
//! - only the exact upper-case names above count; a lower-case spelling or
//!   an unknown `WIKICC_*` name is ignored. The environment is a shared
//!   namespace, so unlike the configuration file an unrecognized name
//!   cannot be called out as a typo without the risk of scolding variables
//!   this program never owned;
//! - a value that cannot be understood (an unknown format, an unparseable
//!   boolean, an empty exclusion entry) is a hard [`Error::InvalidInput`]
//!   naming the variable: silently dropping an explicit instruction would
//!   produce a site nobody asked for.
//!
//! `--force`, `--quiet`, `--init-config` and the input directory are not
//! settings: they exist only on the command line, never as variables.
//!
//! Pure: [`settings_from`] parses any stream of name/value pairs, so the
//! rules are unit tested against plain data without touching the process
//! environment; [`settings`] only reads [`std::env`] and delegates.

use std::path::PathBuf;

use crate::error::{Error, Result};
use crate::options::{OutputFormat, Settings};

/// Prefix of the environment variables this module reads.
///
/// Upper case only: a lower-case spelling is another program's variable and
/// is ignored, whatever it carries.
pub const VAR_PREFIX: &str = "WIKICC_";

/// Environment variable naming the output directory.
pub const OUT_VAR: &str = "WIKICC_OUT";

/// Environment variable naming the output artifact format.
pub const FORMAT_VAR: &str = "WIKICC_FORMAT";

/// Environment variable naming the site title.
pub const TITLE_VAR: &str = "WIKICC_TITLE";

/// Environment variable naming the `--strict` gate.
pub const STRICT_VAR: &str = "WIKICC_STRICT";

/// Environment variable naming the opening document.
pub const HOME_VAR: &str = "WIKICC_HOME";

/// Environment variable naming the comma-separated exclusion list.
pub const EXCLUDE_VAR: &str = "WIKICC_EXCLUDE";

/// Environment variable naming the favicon file.
pub const FAVICON_VAR: &str = "WIKICC_FAVICON";

/// Read the `WIKICC_*` settings from the process environment.
///
/// Names or values that are not valid unicode are read lossily, so an
/// exotic environment can never crash the build; anything the parser does
/// not recognize is ignored by the rules of [`settings_from`].
pub fn settings() -> Result<Settings> {
    settings_from(std::env::vars_os().map(|(name, value)| {
        (
            name.to_string_lossy().into_owned(),
            value.to_string_lossy().into_owned(),
        )
    }))
}

/// Parse the `WIKICC_*` settings out of any stream of name/value pairs.
///
/// The core of the module and the unit-test seam: everything the process
/// environment carries flows through here as plain data. Names without the
/// [`VAR_PREFIX`] and blank values change nothing; a recognized name with a
/// value that cannot be understood is a hard error naming the variable.
pub fn settings_from<I, K, V>(entries: I) -> Result<Settings>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    let mut settings = Settings::default();
    for (name, raw) in entries {
        let name = name.as_ref();
        let Some(key) = name.strip_prefix(VAR_PREFIX) else {
            continue;
        };
        let value = raw.as_ref().trim();
        if value.is_empty() {
            continue;
        }
        match key {
            "OUT" => settings.out = Some(PathBuf::from(value)),
            "FORMAT" => settings.format = Some(parse_format(name, value)?),
            "TITLE" => settings.title = Some(value.to_string()),
            "STRICT" => settings.strict = Some(parse_bool(name, value)?),
            "HOME" => settings.home = Some(value.to_string()),
            "EXCLUDE" => settings.exclude = Some(parse_excludes(name, value)?),
            "FAVICON" => settings.favicon = Some(value.to_string()),
            // The environment is a shared namespace: an upper-case name this
            // version does not know may belong to another program, so it is
            // ignored instead of being called a typo.
            _ => {}
        }
    }
    Ok(settings)
}

/// Parse a `WIKICC_FORMAT` value, naming the variable in the error.
fn parse_format(name: &str, value: &str) -> Result<OutputFormat> {
    value
        .parse::<OutputFormat>()
        .map_err(|error| invalid(name, &error.to_string()))
}

/// Parse a `WIKICC_STRICT` value: `true`, `false`, `1` or `0`.
///
/// Letter case does not matter; anything else is a hard error naming the
/// variable.
fn parse_bool(name: &str, value: &str) -> Result<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(invalid(name, "must be 'true', 'false', '1' or '0'")),
    }
}

/// Split a `WIKICC_EXCLUDE` value on commas; an empty entry is a hard error.
///
/// The entries are kept verbatim: the normalization and the escape guards
/// both other sources share run later, in
/// [`crate::options::Options::resolve`], on whichever list wins.
fn parse_excludes(name: &str, value: &str) -> Result<Vec<String>> {
    let mut list = Vec::new();
    for entry in value.split(',') {
        if entry.trim().is_empty() {
            return Err(invalid(
                name,
                "entries must be non-empty, comma-separated directory paths",
            ));
        }
        list.push(entry.to_string());
    }
    Ok(list)
}

/// An [`Error::InvalidInput`] that names the offending variable.
fn invalid(name: &str, reason: &str) -> Error {
    Error::InvalidInput(format!("environment variable '{name}': {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse a fixed set of name/value pairs, as the environment would hand
    /// them over.
    fn pairs(entries: &[(&str, &str)]) -> Result<Settings> {
        settings_from(entries.iter().copied())
    }

    #[test]
    fn every_variable_names_its_setting() {
        let settings = pairs(&[
            (OUT_VAR, "build"),
            (FORMAT_VAR, "pages"),
            (TITLE_VAR, "Handbook"),
            (STRICT_VAR, "true"),
            (HOME_VAR, "intro"),
            (EXCLUDE_VAR, "drafts,archive/old"),
            (FAVICON_VAR, "assets/icon.png"),
        ])
        .expect("the variables parse");

        assert_eq!(settings.out, Some(PathBuf::from("build")));
        assert_eq!(settings.format, Some(OutputFormat::Pages));
        assert_eq!(settings.title.as_deref(), Some("Handbook"));
        assert_eq!(settings.strict, Some(true));
        assert_eq!(settings.home.as_deref(), Some("intro"));
        assert_eq!(
            settings.exclude,
            Some(vec!["drafts".to_string(), "archive/old".to_string()])
        );
        assert_eq!(settings.favicon.as_deref(), Some("assets/icon.png"));
    }

    #[test]
    fn the_empty_environment_is_the_default_settings() {
        let settings = pairs(&[]).expect("nothing to parse");

        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn a_blank_value_did_not_speak() {
        for value in ["", "   "] {
            let settings = pairs(&[(TITLE_VAR, value), (STRICT_VAR, value)])
                .expect("a blank variable is unset");

            assert_eq!(settings.title, None, "TITLE={value}");
            assert_eq!(settings.strict, None, "STRICT={value}");
        }
    }

    #[test]
    fn values_are_trimmed() {
        let settings =
            pairs(&[(OUT_VAR, " build "), (TITLE_VAR, " Handbook ")]).expect("the variables parse");

        assert_eq!(settings.out, Some(PathBuf::from("build")));
        assert_eq!(settings.title.as_deref(), Some("Handbook"));
    }

    #[test]
    fn unrelated_variables_are_ignored() {
        let settings = pairs(&[
            ("HOME", "/home/user"),
            ("PATH", "anything"),
            ("WIKICC_OUT_EXTRA", "nope"),
        ])
        .expect("nothing to parse");

        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn an_unknown_wikicc_variable_is_ignored() {
        let settings = pairs(&[
            ("WIKICC_TITEL", "a typo"),
            ("WIKICC_out", "lower case"),
            ("WIKICC_FORCE", "yes"),
        ])
        .expect("unknown names cost nothing");

        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn strict_reads_every_documented_spelling() {
        for (value, expected) in [
            ("true", true),
            ("TRUE", true),
            ("1", true),
            ("false", false),
            ("False", false),
            ("0", false),
        ] {
            let settings = pairs(&[(STRICT_VAR, value)]).expect("a known spelling");

            assert_eq!(settings.strict, Some(expected), "STRICT={value}");
        }
    }

    #[test]
    fn an_unknown_strict_value_is_a_hard_error_naming_the_variable() {
        let error = pairs(&[(STRICT_VAR, "yes")]).expect_err("yes is not a boolean");

        assert_eq!(
            error.to_string(),
            "environment variable 'WIKICC_STRICT': must be 'true', 'false', '1' or '0'"
        );
    }

    #[test]
    fn an_unknown_format_is_a_hard_error_naming_the_variable() {
        let error = pairs(&[(FORMAT_VAR, "pdf")]).expect_err("pdf is not a format");

        assert_eq!(
            error.to_string(),
            "environment variable 'WIKICC_FORMAT': invalid format 'pdf', expected one of: single-html, html-dir, pages"
        );
    }

    #[test]
    fn exclude_splits_on_commas_and_keeps_the_entries_verbatim() {
        let settings = pairs(&[(EXCLUDE_VAR, "drafts, archive/old")]).expect("the variable parses");

        assert_eq!(
            settings.exclude,
            Some(vec!["drafts".to_string(), " archive/old".to_string()])
        );
    }

    #[test]
    fn a_single_exclude_entry_needs_no_comma() {
        let settings = pairs(&[(EXCLUDE_VAR, "drafts")]).expect("the variable parses");

        assert_eq!(settings.exclude, Some(vec!["drafts".to_string()]));
    }

    #[test]
    fn an_empty_exclude_entry_is_a_hard_error_naming_the_variable() {
        for value in [",drafts", "drafts,", "a,,b"] {
            let error =
                pairs(&[(EXCLUDE_VAR, value)]).expect_err("an empty entry cannot match anything");

            assert_eq!(
                error.to_string(),
                "environment variable 'WIKICC_EXCLUDE': entries must be non-empty, comma-separated directory paths",
                "EXCLUDE={value}"
            );
        }
    }
}
