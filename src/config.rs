//! Site configuration file: `.wikicc.json` in the input folder root.
//!
//! The file is optional and carries seven keys, exactly the settings the
//! command line can also express ([`Settings`]):
//!
//! - `home`: the document the reader shows when it is opened at an empty or
//!   unknown address. The value is a document id — the path relative to the
//!   input folder, `/` separated, extension included — with one lenience: a
//!   missing `.md` (or `.markdown`) suffix is completed, so
//!   `"home": "intro"` addresses `intro.md`.
//! - `exclude`: a list of directories, relative to the input folder, whose
//!   entire subtrees stay out of the site — drafts, private notes, a scratch
//!   folder. Entries are `/`-separated directory paths (`\` is read as `/`,
//!   a leading `./` and a trailing `/` are dropped) and match exactly.
//! - `out`: the output directory. A relative value is resolved against the
//!   input folder, so the build lands in the same place no matter which
//!   working directory the build was started from.
//! - `format`: the output artifact format, spelled like the `--format` flag.
//! - `title`: the site title.
//! - `favicon`: the site favicon, a file path relative to the input folder
//!   (an absolute path is taken as it is). Without the key the reader carries
//!   the wikicc logo, embedded into the executable at build time; a file that
//!   cannot be read is a hard error.
//! - `strict`: whether warnings fail the build, spelled as a JSON boolean.
//!
//! Every value the file names is a default: an explicit command line flag
//! overrides it.
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
//! A starter file can be written with [`init`], which emits the default
//! content — every key unset — into an existing directory and never touches a
//! file that is already there.
//!
//! Pure: [`load`] touches only the configuration file itself, and both it and
//! the merge in [`crate::options`] are unit tested against plain data.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::options::{OutputFormat, Settings, normalize_candidate, normalize_excludes};
use crate::scan::Diagnostic;

/// Name of the configuration file, looked up at the input folder root.
///
/// A dotfile, so ordinary directory listings and most VCS ignore rules treat
/// it as metadata rather than content.
pub const CONFIG_FILE_NAME: &str = ".wikicc.json";

/// Prefix of every configuration [`Diagnostic`], so messages name their source.
pub(crate) const DIAGNOSTIC_PREFIX: &str = "config:";

/// The parsed configuration of one build.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SiteConfig {
    /// The settings the file names; every field is `None` when the file did
    /// not speak about it.
    pub settings: Settings,
    /// Messages collected while reading the file, in key order.
    pub diagnostics: Vec<Diagnostic>,
}

/// Resolve a configured `home` against the scanned document ids.
///
/// The value is normalized (surrounding whitespace dropped, `\` read as
/// `/`, a leading `./` dropped) and then matched against the ids: first
/// verbatim, then with a `.md` and finally a `.markdown` suffix completed.
/// The resolution returns the *matched* id, so the payload always carries a
/// spelling the reader knows.
///
/// A value that matches nothing yields a warning and `None`; the reader then
/// falls back to the first document, its behaviour without a configuration.
pub fn resolve_home(home: Option<&str>, ids: &[String]) -> (Option<String>, Vec<Diagnostic>) {
    let mut diagnostics = Vec::new();
    let Some(raw) = home else {
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

    parse(&bytes, &path, input)
}

/// The default configuration content: every key this version knows, unset.
///
/// [`init`] writes these exact bytes; a unit test feeds the template back
/// through [`parse`], so the default content can never drift away from what
/// the loader accepts.
pub fn template() -> &'static str {
    "{\n  \"home\": null,\n  \"exclude\": null,\n  \"out\": null,\n  \"format\": null,\n  \"title\": null,\n  \"favicon\": null,\n  \"strict\": null\n}\n"
}

/// Write the default configuration file into `dir` and report it.
///
/// The target directory must already exist (a missing directory is more
/// likely a misspelled path than a place to start a site) and must be a
/// directory. An existing [`CONFIG_FILE_NAME`] is never overwritten: the
/// default content would replace instructions the author wrote on purpose,
/// so the file has to be deleted first. One confirmation line naming the
/// written path goes to `out`.
pub fn init(dir: &Path, out: &mut dyn Write) -> Result<()> {
    if !dir.exists() {
        return Err(Error::InvalidInput(format!(
            "target directory not found: {}",
            dir.display()
        )));
    }
    if !dir.is_dir() {
        return Err(Error::InvalidInput(format!(
            "target path is not a directory: {}",
            dir.display()
        )));
    }

    let path = dir.join(CONFIG_FILE_NAME);
    // `create_new` is the whole overwrite guard: the open fails when the file
    // is already there, so the check and the write cannot race.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => {
                Error::InvalidInput(format!("'{}' already exists", path.display()))
            }
            _ => Error::Io(error),
        })?;
    file.write_all(template().as_bytes())?;

    writeln!(out, "initialized {}", path.display())?;
    Ok(())
}

/// Parse the configuration bytes, with a UTF-8 BOM tolerated.
///
/// `base` is the folder the file lives in: a relative `out` is resolved
/// against it right here, so the merge in [`crate::options`] sees the same
/// kind of value a command line `--out` carries.
fn parse(bytes: &[u8], path: &Path, base: &Path) -> Result<SiteConfig> {
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
                config.settings.home = Some(text);
            }
            ("home", _) => {
                return Err(Error::InvalidInput("'home' must be a string".to_string()));
            }
            ("exclude", Value::Null) => {}
            ("exclude", Value::Array(entries)) => {
                let mut list = Vec::new();
                for entry in entries {
                    let Value::String(raw) = entry else {
                        return Err(Error::InvalidInput(
                            "'exclude' entries must be strings".to_string(),
                        ));
                    };
                    list.push(raw);
                }
                config.settings.exclude = Some(normalize_excludes(&list)?);
            }
            ("exclude", _) => {
                return Err(Error::InvalidInput(
                    "'exclude' must be an array of strings".to_string(),
                ));
            }
            ("out", Value::Null) => {}
            ("out", Value::String(text)) => {
                if text.trim().is_empty() {
                    return Err(Error::InvalidInput(
                        "'out' must be a non-empty directory path".to_string(),
                    ));
                }
                config.settings.out = Some(base.join(text));
            }
            ("out", _) => {
                return Err(Error::InvalidInput("'out' must be a string".to_string()));
            }
            ("format", Value::Null) => {}
            ("format", Value::String(text)) => {
                config.settings.format = Some(text.parse::<OutputFormat>()?);
            }
            ("format", _) => {
                return Err(Error::InvalidInput("'format' must be a string".to_string()));
            }
            ("title", Value::Null) => {}
            ("title", Value::String(text)) => {
                config.settings.title = Some(text);
            }
            ("title", _) => {
                return Err(Error::InvalidInput("'title' must be a string".to_string()));
            }
            ("favicon", Value::Null) => {}
            ("favicon", Value::String(text)) => {
                if text.trim().is_empty() {
                    return Err(Error::InvalidInput(
                        "'favicon' must be a non-empty file path".to_string(),
                    ));
                }
                config.settings.favicon = Some(text);
            }
            ("favicon", _) => {
                return Err(Error::InvalidInput(
                    "'favicon' must be a string".to_string(),
                ));
            }
            ("strict", Value::Null) => {}
            ("strict", Value::Bool(flag)) => {
                config.settings.strict = Some(flag);
            }
            ("strict", _) => {
                return Err(Error::InvalidInput(
                    "'strict' must be a boolean".to_string(),
                ));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse a configuration whose relative `out` resolves against `input`.
    fn parse_text(text: &str) -> Result<SiteConfig> {
        parse(
            text.as_bytes(),
            Path::new(".wikicc.json"),
            Path::new("input"),
        )
    }

    fn warning_messages(config: &SiteConfig) -> Vec<String> {
        config
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.to_string())
            .collect()
    }

    #[test]
    fn a_missing_file_is_the_default_configuration() {
        let dir = tempfile::tempdir().expect("temp dir");

        let config = load(dir.path()).expect("a missing file is not an error");

        assert_eq!(config, SiteConfig::default());
        assert_eq!(config.settings.home, None);
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn home_is_read_verbatim() {
        let config = parse_text(r#"{"home": "guide/intro.md"}"#).expect("valid config");

        assert_eq!(config.settings.home.as_deref(), Some("guide/intro.md"));
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn a_bom_is_tolerated() {
        let with_bom = "\u{feff}{\"home\": \"intro.md\"}";
        let config = parse_text(with_bom).expect("BOM is stripped before parsing");

        assert_eq!(config.settings.home.as_deref(), Some("intro.md"));
    }

    #[test]
    fn a_null_home_is_unset() {
        let config = parse_text(r#"{"home": null}"#).expect("valid config");

        assert_eq!(config.settings.home, None);
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
    fn a_null_exclude_is_unset() {
        let config = parse_text(r#"{"exclude": null}"#).expect("valid config");

        assert_eq!(config.settings.exclude, None);
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn an_empty_exclude_list_is_accepted() {
        let config = parse_text(r#"{"exclude": []}"#).expect("valid config");

        assert_eq!(config.settings.exclude, Some(Vec::new()));
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn exclude_entries_are_normalized_and_deduplicated() {
        let config = parse_text(
            r#"{"exclude": [" guide\\drafts ", "./scratch/", "a/b.md", "guide\\drafts"]}"#,
        )
        .expect("valid config");

        assert_eq!(
            config.settings.exclude,
            Some(vec![
                "guide/drafts".to_string(),
                "scratch".to_string(),
                "a/b.md".to_string(),
            ])
        );
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn a_non_array_exclude_is_a_hard_error() {
        let error = parse_text(r#"{"exclude": "drafts"}"#).expect_err("a string is not a list");

        assert_eq!(error.to_string(), "'exclude' must be an array of strings");
    }

    #[test]
    fn a_non_string_exclude_entry_is_a_hard_error() {
        let error = parse_text(r#"{"exclude": [3]}"#).expect_err("a number is not a path");

        assert_eq!(error.to_string(), "'exclude' entries must be strings");
    }

    #[test]
    fn an_empty_exclude_entry_is_a_hard_error() {
        for text in [
            r#"{"exclude": [""]}"#,
            r#"{"exclude": ["   "]}"#,
            r#"{"exclude": ["./"]}"#,
            r#"{"exclude": ["/"]}"#,
        ] {
            let error = parse_text(text).expect_err("an empty entry cannot match anything");

            assert_eq!(
                error.to_string(),
                "'exclude' entries must be non-empty directory paths"
            );
        }
    }

    #[test]
    fn exclude_entries_may_not_escape_or_wander() {
        for text in [
            r#"{"exclude": [".."]}"#,
            r#"{"exclude": ["guide/../drafts"]}"#,
            r#"{"exclude": ["a//b"]}"#,
            r#"{"exclude": ["guide/./drafts"]}"#,
        ] {
            let error = parse_text(text).expect_err("escaping entries are rejected");

            assert!(
                error.to_string().starts_with("'exclude' entry '"),
                "unexpected message: {error}"
            );
        }
    }

    #[test]
    fn out_is_resolved_against_the_input_folder() {
        let config = parse_text(r#"{"out": "site/build"}"#).expect("valid config");

        assert_eq!(
            config.settings.out,
            Some(std::path::PathBuf::from("input/site/build"))
        );
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn a_null_out_is_unset() {
        let config = parse_text(r#"{"out": null}"#).expect("valid config");

        assert_eq!(config.settings.out, None);
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn an_empty_out_is_a_hard_error() {
        for text in [r#"{"out": ""}"#, r#"{"out": "   "}"#] {
            let error = parse_text(text).expect_err("an empty out is rejected");

            assert_eq!(
                error.to_string(),
                "'out' must be a non-empty directory path"
            );
        }
    }

    #[test]
    fn a_non_string_out_is_a_hard_error() {
        let error = parse_text(r#"{"out": 7}"#).expect_err("a number is not a path");

        assert_eq!(error.to_string(), "'out' must be a string");
    }

    #[test]
    fn format_is_parsed_like_the_flag_value() {
        let config = parse_text(r#"{"format": "pages"}"#).expect("valid config");

        assert_eq!(config.settings.format, Some(OutputFormat::Pages));
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn an_unknown_format_is_a_hard_error() {
        let error = parse_text(r#"{"format": "pdf"}"#).expect_err("pdf is not a format");

        assert_eq!(
            error.to_string(),
            "invalid format 'pdf', expected one of: single-html, html-dir, pages"
        );
    }

    #[test]
    fn a_non_string_format_is_a_hard_error() {
        let error = parse_text(r#"{"format": 3}"#).expect_err("a number is not a format");

        assert_eq!(error.to_string(), "'format' must be a string");
    }

    #[test]
    fn title_is_read_verbatim() {
        let config = parse_text(r#"{"title": "Handbook"}"#).expect("valid config");

        assert_eq!(config.settings.title.as_deref(), Some("Handbook"));
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn a_non_string_title_is_a_hard_error() {
        let error = parse_text(r#"{"title": 5}"#).expect_err("a number is not a title");

        assert_eq!(error.to_string(), "'title' must be a string");
    }

    #[test]
    fn favicon_is_read_verbatim() {
        let config = parse_text(r#"{"favicon": "assets/icon.png"}"#).expect("valid config");

        assert_eq!(config.settings.favicon.as_deref(), Some("assets/icon.png"));
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn a_null_favicon_is_unset() {
        let config = parse_text(r#"{"favicon": null}"#).expect("valid config");

        assert_eq!(config.settings.favicon, None);
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn an_empty_favicon_is_a_hard_error() {
        for text in [r#"{"favicon": ""}"#, r#"{"favicon": "   "}"#] {
            let error = parse_text(text).expect_err("an empty favicon is rejected");

            assert_eq!(error.to_string(), "'favicon' must be a non-empty file path");
        }
    }

    #[test]
    fn a_non_string_favicon_is_a_hard_error() {
        let error = parse_text(r#"{"favicon": 5}"#).expect_err("a number is not a favicon");

        assert_eq!(error.to_string(), "'favicon' must be a string");
    }

    #[test]
    fn strict_is_read_as_a_boolean() {
        for (text, expected) in [
            (r#"{"strict": true}"#, Some(true)),
            (r#"{"strict": false}"#, Some(false)),
        ] {
            let config = parse_text(text).expect("valid config");

            assert_eq!(config.settings.strict, expected, "{text}");
            assert!(config.diagnostics.is_empty());
        }
    }

    #[test]
    fn a_non_boolean_strict_is_a_hard_error() {
        let error = parse_text(r#"{"strict": "yes"}"#).expect_err("a string is not a flag");

        assert_eq!(error.to_string(), "'strict' must be a boolean");
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
    fn the_template_is_the_default_configuration() {
        let config = parse_text(template()).expect("the template is a valid configuration");

        assert_eq!(config, SiteConfig::default());
        assert!(config.diagnostics.is_empty());
    }

    #[test]
    fn init_writes_the_template_and_reports_the_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut report = Vec::new();

        init(dir.path(), &mut report).expect("init succeeds in an empty directory");

        let path = dir.path().join(CONFIG_FILE_NAME);
        let written = std::fs::read_to_string(&path).expect("the file exists");
        assert_eq!(written, template());
        assert_eq!(
            String::from_utf8(report).expect("stdout is utf-8"),
            format!("initialized {}\n", path.display())
        );
    }

    #[test]
    fn init_refuses_to_overwrite_an_existing_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(CONFIG_FILE_NAME);
        std::fs::write(&path, r#"{"home": "a.md"}"#).expect("write an existing config");
        let mut report = Vec::new();

        let error = init(dir.path(), &mut report).expect_err("an existing file is never replaced");

        assert_eq!(
            error.to_string(),
            format!("'{}' already exists", path.display())
        );
        let untouched = std::fs::read_to_string(&path).expect("read the existing file");
        assert_eq!(untouched, r#"{"home": "a.md"}"#);
        assert!(report.is_empty(), "a failed init prints nothing");
    }

    #[test]
    fn init_rejects_a_missing_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("nope");
        let mut report = Vec::new();

        let error = init(&missing, &mut report).expect_err("the directory must exist");

        assert!(
            error
                .to_string()
                .starts_with("target directory not found: "),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn init_rejects_a_file_as_the_target() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "# Notes\n").expect("write fixture");
        let mut report = Vec::new();

        let error = init(&file, &mut report).expect_err("a file is not a directory");

        assert!(
            error
                .to_string()
                .starts_with("target path is not a directory: "),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn unknown_keys_warn_but_do_not_stop_the_build() {
        let config = parse_text(r#"{"author": "x", "home": "b.md"}"#).expect("valid config");

        assert_eq!(config.settings.home.as_deref(), Some("b.md"));
        assert_eq!(
            warning_messages(&config),
            ["warning: config: unknown key 'author' ignored"]
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

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn messages(diagnostics: &[Diagnostic]) -> Vec<String> {
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.to_string())
            .collect()
    }

    #[test]
    fn home_resolves_to_the_exact_id_first() {
        let (home, diagnostics) =
            resolve_home(Some("guide/intro.md"), &ids(&["a.md", "guide/intro.md"]));

        assert_eq!(home.as_deref(), Some("guide/intro.md"));
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn home_completes_a_missing_extension() {
        for (value, expected) in [("intro", "intro.md"), ("intro.markdown", "intro.markdown")] {
            let (home, diagnostics) =
                resolve_home(Some(value), &ids(&["intro.md", "intro.markdown"]));

            assert_eq!(home.as_deref(), Some(expected), "home: {value}");
            assert!(diagnostics.is_empty());
        }
    }

    #[test]
    fn home_prefers_the_exact_id_over_a_completed_one() {
        // `intro` exists as a folder-less id only in exotic sites; the point
        // is that verbatim wins before any suffix is completed.
        let (home, _) = resolve_home(Some("intro"), &ids(&["intro", "intro.md"]));

        assert_eq!(home.as_deref(), Some("intro"));
    }

    #[test]
    fn home_normalizes_separators_and_local_prefixes() {
        for (value, expected) in [
            (r"guide\intro.md", "guide/intro.md"),
            ("./intro.md", "intro.md"),
            ("  intro.md  ", "intro.md"),
        ] {
            let (home, _) = resolve_home(Some(value), &ids(&["guide/intro.md", "intro.md"]));

            assert_eq!(home.as_deref(), Some(expected), "home: {value}");
        }
    }

    #[test]
    fn an_unknown_home_warns_and_falls_back_to_none() {
        let (home, diagnostics) = resolve_home(Some("gone.md"), &ids(&["a.md", "b.md"]));

        assert_eq!(home, None);
        assert_eq!(
            messages(&diagnostics),
            ["warning: config: home 'gone.md' does not match any document"]
        );
    }

    #[test]
    fn a_site_without_a_home_resolves_to_nothing_without_diagnostics() {
        let (home, diagnostics) = resolve_home(None, &ids(&["a.md"]));

        assert_eq!(home, None);
        assert!(diagnostics.is_empty());
    }
}
