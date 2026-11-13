//! Resolved build options: defaults, lexical path normalization and safety guards.
//!
//! [`Settings`] is the shared shape of everything the command line, the
//! `WIKICC_*` environment variables (see [`crate::env`]) and `.wikicc.json`
//! can all express; [`Options::resolve`] merges the three sources — command
//! line over environment over file over built-in defaults — into the
//! [`Options`] the pipeline consumes.

use std::ffi::OsString;
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use clap::Parser;

use crate::error::{Error, Result};

/// Directory appended to the input directory when `--out` is omitted.
pub const DEFAULT_OUT_DIR: &str = "dist";

/// Fallback site title when the input path has no usable file name.
pub const FALLBACK_TITLE: &str = "wikicc";

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

/// Settings the command line, the environment and the configuration file can
/// all express.
///
/// Every field is `None` until one of the three sources names it, so all
/// surfaces share one shape, one normalization and one validation. `None`
/// never means "off" — it means "this source did not speak".
#[derive(Debug, Clone, Default, PartialEq, Eq, Parser)]
pub struct Settings {
    /// Output directory [default: <INPUT_DIR>/dist]
    #[arg(short, long, value_name = "DIR")]
    pub out: Option<PathBuf>,

    /// Output format: single-html (one self-contained file), html-dir (page
    /// plus an assets folder) or pages (static site for GitHub Pages) [default: single-html]
    #[arg(long, value_name = "FMT", value_parser = OutputFormat::from_str)]
    pub format: Option<OutputFormat>,

    /// Site title [default: input folder name]
    #[arg(long, value_name = "TITLE")]
    pub title: Option<String>,

    /// Treat warnings (broken links, missing assets) as errors; `--strict=false` overrides the configuration
    //
    // `require_equals` keeps a following positional (`wikicc --strict docs`)
    // out of the optional value; a bare `--strict` means true and
    // `--strict=false` means false, so the command line can override a
    // configuration that turns the gate on.
    #[arg(
        long,
        value_name = "BOOL",
        num_args(0..=1),
        require_equals = true,
        default_missing_value = "true"
    )]
    pub strict: Option<bool>,

    /// Document the reader opens at an empty or unknown address; overrides `.wikicc.json`
    #[arg(long, value_name = "DOC")]
    pub home: Option<String>,

    /// Directory whose entire subtree stays out of the site; repeatable, overrides `.wikicc.json`
    #[arg(long, value_name = "DIR")]
    pub exclude: Option<Vec<String>>,

    /// Favicon file relative to the input folder; overrides `.wikicc.json` [default: the wikicc logo]
    #[arg(long, value_name = "FILE")]
    pub favicon: Option<String>,
}

/// The raw build intent: what the command line said, before any default.
///
/// The pipeline merges this over the configuration file, so the binary stays
/// thin and file-driven behaviour stays testable without spawning a process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// Input folder.
    pub input: PathBuf,
    /// Values the command line named explicitly.
    pub settings: Settings,
    /// Overwrite an existing output directory without confirmation (writers).
    pub force: bool,
    /// Suppress the summary line.
    pub quiet: bool,
}

/// Fully resolved options for one build.
///
/// Paths are kept exactly as the user wrote them (or as derived from the input
/// directory) so messages stay short; comparison happens on
/// [`Options::normalized_input`] / [`Options::normalized_out`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// Input folder.
    pub input: PathBuf,
    /// Output directory.
    pub out: PathBuf,
    /// Artifact format.
    pub format: OutputFormat,
    /// Site title.
    pub title: String,
    /// Upgrade warnings to a hard failure.
    pub strict: bool,
    /// Overwrite an existing output directory without confirmation (writers).
    pub force: bool,
    /// Suppress the summary line.
    pub quiet: bool,
    /// The `home` value exactly as written, before it is matched against the
    /// scanned document ids.
    pub home: Option<String>,
    /// The `exclude` entries, normalized (trimmed, `\` read as `/`, a leading
    /// `./` and a trailing `/` dropped) and deduplicated; empty when unset.
    pub exclude: Vec<String>,
    /// The `favicon` value, normalized (trimmed, `\` read as `/`, a leading
    /// `./` and a trailing `/` dropped) to a file path relative to the input
    /// folder; `None` uses the embedded default logo.
    pub favicon: Option<String>,
}

impl Options {
    /// Merge the command line over the environment over the configuration
    /// file over the built-in defaults, and normalize and validate what the
    /// winning source wrote.
    ///
    /// Pure: no I/O and no filesystem access. The environment settings were
    /// read before the call ([`crate::env::settings`]), and a configuration
    /// `out` was already resolved against the input folder when the file was
    /// read, so all sources carry the same kind of value here. A `home` that
    /// is empty after normalization, an `exclude` entry that escapes the
    /// input folder and a `favicon` that is empty after normalization or
    /// escapes the input folder are hard errors, whatever the source.
    pub fn resolve(request: &Request, env: &Settings, file: &Settings) -> Result<Self> {
        let cli = &request.settings;
        let input = &request.input;

        let home = cli
            .home
            .clone()
            .or_else(|| env.home.clone())
            .or_else(|| file.home.clone());
        if let Some(raw) = &home
            && normalize_candidate(raw).is_empty()
        {
            return Err(Error::InvalidInput(
                "'home' must be a non-empty string".to_string(),
            ));
        }

        let exclude = cli
            .exclude
            .clone()
            .or_else(|| env.exclude.clone())
            .or_else(|| file.exclude.clone())
            .unwrap_or_default();
        let favicon = match cli
            .favicon
            .clone()
            .or_else(|| env.favicon.clone())
            .or_else(|| file.favicon.clone())
        {
            Some(raw) => Some(normalize_favicon(&raw)?),
            None => None,
        };

        Ok(Self {
            input: input.clone(),
            out: cli
                .out
                .clone()
                .or_else(|| env.out.clone())
                .or_else(|| file.out.clone())
                .unwrap_or_else(|| input.join(DEFAULT_OUT_DIR)),
            format: cli
                .format
                .or(env.format)
                .or(file.format)
                .unwrap_or_default(),
            title: cli
                .title
                .clone()
                .or_else(|| env.title.clone())
                .or_else(|| file.title.clone())
                .unwrap_or_else(|| default_title(input)),
            strict: cli.strict.or(env.strict).or(file.strict).unwrap_or(false),
            force: request.force,
            quiet: request.quiet,
            home,
            exclude: normalize_excludes(&exclude)?,
            favicon,
        })
    }

    /// Absolute, lexically normalized input path.
    pub fn normalized_input(&self) -> PathBuf {
        normalize(&self.input)
    }

    /// Absolute, lexically normalized output path.
    pub fn normalized_out(&self) -> PathBuf {
        normalize(&self.out)
    }

    /// Both guards below, for a caller that holds a resolved [`Options`].
    pub fn validate(&self) -> Result<()> {
        validate_input(&self.input)?;
        validate_paths(&self.input, &self.out)
    }
}

/// Reject an unusable input folder.
pub fn validate_input(input: &Path) -> Result<()> {
    if !input.exists() {
        return Err(Error::InvalidInput(format!(
            "input directory not found: {}",
            input.display()
        )));
    }
    if !input.is_dir() {
        return Err(Error::InvalidInput(format!(
            "input path is not a directory: {}",
            input.display()
        )));
    }

    Ok(())
}

/// Reject unusable input/output combinations.
///
/// This is the only place that guards the output directory, so it must run
/// before anything is written or removed. It runs on the merged options, so
/// an output directory that arrived through the configuration file is
/// guarded exactly like one typed on the command line.
pub fn validate_paths(input: &Path, out: &Path) -> Result<()> {
    let input = normalize(input);
    let out = normalize(out);

    if same_path(&input, &out) {
        return Err(Error::InvalidInput(format!(
            "output directory must differ from the input directory: {}",
            out.display()
        )));
    }
    if is_ancestor(&out, &input) {
        return Err(Error::InvalidInput(format!(
            "output directory must not be an ancestor of the input directory: {}",
            out.display()
        )));
    }
    if same_path(&normalize(&std::env::current_dir()?), &out) {
        return Err(Error::InvalidInput(format!(
            "refusing to use the current working directory as the output directory: {}",
            out.display()
        )));
    }

    Ok(())
}

/// Make `path` absolute and collapse `.`/`..` segments without touching the
/// filesystem (the output directory usually does not exist yet).
pub fn normalize(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => path.to_path_buf(),
        }
    };

    let mut prefix: Option<OsString> = None;
    let mut root: Option<OsString> = None;
    let mut parts: Vec<OsString> = Vec::new();

    for component in absolute.components() {
        match component {
            Component::Prefix(value) => prefix = Some(value.as_os_str().to_os_string()),
            Component::RootDir => root = Some(component.as_os_str().to_os_string()),
            Component::CurDir => {}
            // A parent segment above the root has nowhere to go, so the root is
            // the floor: `..` only cancels a normal segment that is still there.
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(name) => parts.push(name.to_os_string()),
        }
    }

    let mut normalized = PathBuf::new();
    if let Some(prefix) = prefix {
        normalized.push(prefix);
    }
    if let Some(root) = root {
        normalized.push(root);
    }
    for part in parts {
        normalized.push(part);
    }
    normalized
}

/// Path components, lower-cased on Windows so comparisons ignore case.
///
/// Shared with [`crate::scan`] so every path comparison in the crate follows the
/// same platform rules.
pub(crate) fn path_components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let text = component.as_os_str().to_string_lossy();
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text.into_owned()
            }
        })
        .collect()
}

fn same_path(left: &Path, right: &Path) -> bool {
    path_components(left) == path_components(right)
}

/// Whether `ancestor` is a strict parent directory of `descendant`.
fn is_ancestor(ancestor: &Path, descendant: &Path) -> bool {
    let ancestor = path_components(ancestor);
    let descendant = path_components(descendant);

    ancestor.len() < descendant.len()
        && ancestor
            .iter()
            .zip(descendant.iter())
            .all(|(left, right)| left == right)
}

/// Site title derived from the input directory name.
fn default_title(input: &Path) -> String {
    for candidate in [input.to_path_buf(), normalize(input)] {
        if let Some(name) = candidate.file_name() {
            let name = name.to_string_lossy();
            if !name.is_empty() {
                return name.into_owned();
            }
        }
    }
    FALLBACK_TITLE.to_string()
}

/// Normalize a `home` value or an `exclude` entry for matching: trimmed,
/// `/`-separated, without a leading `./`.
pub(crate) fn normalize_candidate(raw: &str) -> String {
    let mut candidate = raw.trim().replace('\\', "/");
    while let Some(rest) = candidate.strip_prefix("./") {
        candidate = rest.to_string();
    }
    candidate
}

/// Normalize and validate the `exclude` entries of any source.
///
/// Each entry becomes a `/`-separated directory path relative to the input
/// folder: trimmed, `\` read as `/`, a leading `./` and any trailing `/`
/// dropped. An entry that normalizes to nothing, or that carries an empty,
/// `.` or `..` component, is a hard error — an exclusion that escapes the
/// input folder or cannot match any directory would silently do nothing, and
/// a broken instruction must not look like it worked. Duplicates keep their
/// first occurrence, so the order the author wrote is the order that counts.
pub(crate) fn normalize_excludes(entries: &[String]) -> Result<Vec<String>> {
    let mut excludes: Vec<String> = Vec::new();
    for raw in entries {
        let candidate = normalize_candidate(raw);
        let candidate = candidate.trim_end_matches('/');
        if candidate.is_empty() {
            return Err(Error::InvalidInput(
                "'exclude' entries must be non-empty directory paths".to_string(),
            ));
        }
        if candidate
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
        {
            return Err(Error::InvalidInput(format!(
                "'exclude' entry '{candidate}' is not a directory path inside the input folder"
            )));
        }
        if !excludes.iter().any(|known| known == candidate) {
            excludes.push(candidate.to_string());
        }
    }
    Ok(excludes)
}

/// Normalize a `favicon` value of any source.
///
/// The value becomes a `/`-separated file path relative to the input folder:
/// trimmed, `\` read as `/`, a leading `./` and a trailing `/` dropped. A
/// value that normalizes to nothing, or that carries an empty, `.` or `..`
/// component, is a hard error: the favicon is a file inside the input folder,
/// and a path that escapes it or cannot name one must not silently build a
/// site that carries the default icon instead.
pub(crate) fn normalize_favicon(raw: &str) -> Result<String> {
    let candidate = normalize_candidate(raw);
    let candidate = candidate.trim_end_matches('/');

    if candidate.is_empty() {
        return Err(Error::InvalidInput(
            "'favicon' must be a non-empty file path".to_string(),
        ));
    }
    if candidate
        .split('/')
        .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(Error::InvalidInput(format!(
            "'favicon' value '{candidate}' is not a file path inside the input folder"
        )));
    }

    Ok(candidate.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Options for one request whose command line carries only `out`.
    fn options_for(input: &Path, out: Option<&Path>) -> Options {
        let settings = Settings {
            out: out.map(Path::to_path_buf),
            ..Settings::default()
        };
        let request = Request {
            input: input.to_path_buf(),
            settings,
            force: false,
            quiet: false,
        };
        Options::resolve(&request, &Settings::default(), &Settings::default())
            .expect("the request resolves")
    }

    /// Resolve a request with explicit command line settings.
    fn resolve_cli(input: &Path, settings: Settings) -> Result<Options> {
        Options::resolve(
            &Request {
                input: input.to_path_buf(),
                settings,
                force: false,
                quiet: false,
            },
            &Settings::default(),
            &Settings::default(),
        )
    }

    /// Resolve a request with explicit environment settings and a silent
    /// command line.
    fn resolve_env(input: &Path, env: Settings, file: Settings) -> Result<Options> {
        Options::resolve(
            &Request {
                input: input.to_path_buf(),
                settings: Settings::default(),
                force: false,
                quiet: false,
            },
            &env,
            &file,
        )
    }

    /// Resolve a request with explicit file settings and a silent command line.
    fn resolve_file(input: &Path, file: Settings) -> Result<Options> {
        Options::resolve(
            &Request {
                input: input.to_path_buf(),
                settings: Settings::default(),
                force: false,
                quiet: false,
            },
            &Settings::default(),
            &file,
        )
    }

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

    #[test]
    fn resolve_derives_default_out_and_title() {
        let dir = tempfile::tempdir().expect("temp dir");
        let options = options_for(dir.path(), None);

        assert_eq!(options.out, dir.path().join(DEFAULT_OUT_DIR));
        assert_eq!(
            options.title,
            dir.path().file_name().unwrap().to_string_lossy()
        );
        assert_eq!(options.format, OutputFormat::SingleHtml);
        assert!(!options.strict);
        assert!(options.home.is_none());
        assert!(options.exclude.is_empty());
        assert!(options.favicon.is_none());
    }

    #[test]
    fn resolve_keeps_explicit_cli_values() {
        let dir = tempfile::tempdir().expect("temp dir");
        let settings = Settings {
            out: Some(PathBuf::from("build")),
            format: Some(OutputFormat::HtmlDir),
            title: Some("Handbook".to_string()),
            strict: Some(true),
            home: Some("intro".to_string()),
            exclude: Some(vec!["drafts".to_string()]),
            favicon: Some("assets/icon.png".to_string()),
        };

        let options = resolve_cli(dir.path(), settings).expect("valid settings");

        assert_eq!(options.out, PathBuf::from("build"));
        assert_eq!(options.title, "Handbook");
        assert_eq!(options.format, OutputFormat::HtmlDir);
        assert!(options.strict);
        assert_eq!(options.home.as_deref(), Some("intro"));
        assert_eq!(options.exclude, ["drafts"]);
        assert_eq!(options.favicon.as_deref(), Some("assets/icon.png"));
    }

    #[test]
    fn resolve_falls_back_to_the_file_settings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = Settings {
            out: Some(dir.path().join("site")),
            format: Some(OutputFormat::Pages),
            title: Some("From Config".to_string()),
            strict: Some(true),
            home: Some("intro.md".to_string()),
            exclude: Some(vec!["drafts".to_string()]),
            favicon: Some("assets/file.png".to_string()),
        };

        let options = resolve_file(dir.path(), file).expect("valid settings");

        assert_eq!(options.out, dir.path().join("site"));
        assert_eq!(options.format, OutputFormat::Pages);
        assert_eq!(options.title, "From Config");
        assert!(options.strict);
        assert_eq!(options.home.as_deref(), Some("intro.md"));
        assert_eq!(options.exclude, ["drafts"]);
        assert_eq!(options.favicon.as_deref(), Some("assets/file.png"));
    }

    #[test]
    fn resolve_prefers_the_command_line_over_the_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                out: Some(PathBuf::from("from-cli")),
                format: Some(OutputFormat::HtmlDir),
                title: Some("From CLI".to_string()),
                strict: Some(false),
                home: Some("cli.md".to_string()),
                exclude: Some(vec!["cli-drafts".to_string()]),
                favicon: Some("cli.png".to_string()),
            },
            force: false,
            quiet: false,
        };
        let file = Settings {
            out: Some(dir.path().join("from-file")),
            format: Some(OutputFormat::Pages),
            title: Some("From Config".to_string()),
            strict: Some(true),
            home: Some("file.md".to_string()),
            exclude: Some(vec!["file-drafts".to_string()]),
            favicon: Some("file.png".to_string()),
        };

        let options =
            Options::resolve(&request, &Settings::default(), &file).expect("valid settings");

        assert_eq!(options.out, PathBuf::from("from-cli"));
        assert_eq!(options.format, OutputFormat::HtmlDir);
        assert_eq!(options.title, "From CLI");
        assert!(!options.strict);
        assert_eq!(options.home.as_deref(), Some("cli.md"));
        assert_eq!(options.exclude, ["cli-drafts"]);
        assert_eq!(options.favicon.as_deref(), Some("cli.png"));
    }

    #[test]
    fn a_command_line_false_overrides_a_configured_strict() {
        let dir = tempfile::tempdir().expect("temp dir");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                strict: Some(false),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };
        let file = Settings {
            strict: Some(true),
            ..Settings::default()
        };

        let options =
            Options::resolve(&request, &Settings::default(), &file).expect("valid settings");

        assert!(
            !options.strict,
            "the command line wins even when it says no"
        );
    }

    #[test]
    fn the_command_line_exclusions_replace_the_configured_ones() {
        let dir = tempfile::tempdir().expect("temp dir");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                exclude: Some(vec!["archive".to_string()]),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };
        let file = Settings {
            exclude: Some(vec!["drafts".to_string()]),
            ..Settings::default()
        };

        let options =
            Options::resolve(&request, &Settings::default(), &file).expect("valid settings");

        assert_eq!(
            options.exclude,
            ["archive"],
            "the file list is not merged into the command line list"
        );
    }

    #[test]
    fn command_line_exclusions_are_normalized_like_configured_ones() {
        let dir = tempfile::tempdir().expect("temp dir");
        let settings = Settings {
            exclude: Some(vec![
                " guide\\drafts ".to_string(),
                "./scratch/".to_string(),
                "guide\\drafts".to_string(),
            ]),
            ..Settings::default()
        };

        let options = resolve_cli(dir.path(), settings).expect("valid settings");

        assert_eq!(options.exclude, ["guide/drafts", "scratch"]);
    }

    #[test]
    fn an_escaping_exclusion_is_a_hard_error_whatever_the_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cli = Settings {
            exclude: Some(vec!["../outside".to_string()]),
            ..Settings::default()
        };
        let file = Settings {
            exclude: Some(vec!["guide/../drafts".to_string()]),
            ..Settings::default()
        };

        let cli_error = resolve_cli(dir.path(), cli).expect_err("an escaping entry is rejected");
        let file_error = resolve_file(dir.path(), file).expect_err("an escaping entry is rejected");

        assert!(
            cli_error
                .to_string()
                .contains("is not a directory path inside the input folder"),
            "unexpected message: {cli_error}"
        );
        assert!(
            file_error
                .to_string()
                .contains("is not a directory path inside the input folder"),
            "unexpected message: {file_error}"
        );
    }

    #[test]
    fn an_empty_home_is_a_hard_error_whatever_the_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cli = Settings {
            home: Some("   ".to_string()),
            ..Settings::default()
        };
        let file = Settings {
            home: Some(String::new()),
            ..Settings::default()
        };

        let cli_error = resolve_cli(dir.path(), cli).expect_err("an empty home is rejected");
        let file_error = resolve_file(dir.path(), file).expect_err("an empty home is rejected");

        assert_eq!(cli_error.to_string(), "'home' must be a non-empty string");
        assert_eq!(file_error.to_string(), "'home' must be a non-empty string");
    }

    #[test]
    fn favicon_values_are_normalized_like_candidate_paths() {
        let dir = tempfile::tempdir().expect("temp dir");
        let settings = Settings {
            favicon: Some(r" assets\icons\icon.png/ ".to_string()),
            ..Settings::default()
        };

        let options = resolve_cli(dir.path(), settings).expect("valid settings");

        assert_eq!(options.favicon.as_deref(), Some("assets/icons/icon.png"));
    }

    #[test]
    fn an_empty_favicon_is_a_hard_error_whatever_the_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cli = Settings {
            favicon: Some("   ".to_string()),
            ..Settings::default()
        };
        let file = Settings {
            favicon: Some(String::new()),
            ..Settings::default()
        };

        let cli_error = resolve_cli(dir.path(), cli).expect_err("an empty favicon is rejected");
        let file_error = resolve_file(dir.path(), file).expect_err("an empty favicon is rejected");

        assert_eq!(
            cli_error.to_string(),
            "'favicon' must be a non-empty file path"
        );
        assert_eq!(
            file_error.to_string(),
            "'favicon' must be a non-empty file path"
        );
    }

    #[test]
    fn an_escaping_favicon_is_a_hard_error_whatever_the_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cli = Settings {
            favicon: Some("../outside.png".to_string()),
            ..Settings::default()
        };
        let file = Settings {
            favicon: Some("assets/../icon.png".to_string()),
            ..Settings::default()
        };

        let cli_error = resolve_cli(dir.path(), cli).expect_err("an escaping favicon is rejected");
        let file_error =
            resolve_file(dir.path(), file).expect_err("an escaping favicon is rejected");

        assert!(
            cli_error
                .to_string()
                .contains("is not a file path inside the input folder"),
            "unexpected message: {cli_error}"
        );
        assert!(
            file_error
                .to_string()
                .contains("is not a file path inside the input folder"),
            "unexpected message: {file_error}"
        );
    }

    #[test]
    fn the_environment_fills_in_where_the_command_line_is_silent() {
        let dir = tempfile::tempdir().expect("temp dir");
        let env = Settings {
            out: Some(PathBuf::from("from-env")),
            format: Some(OutputFormat::HtmlDir),
            title: Some("From Env".to_string()),
            strict: Some(true),
            home: Some("env.md".to_string()),
            exclude: Some(vec!["env-drafts".to_string()]),
            favicon: Some("env.png".to_string()),
        };

        let options = resolve_env(dir.path(), env, Settings::default()).expect("valid settings");

        assert_eq!(options.out, PathBuf::from("from-env"));
        assert_eq!(options.format, OutputFormat::HtmlDir);
        assert_eq!(options.title, "From Env");
        assert!(options.strict);
        assert_eq!(options.home.as_deref(), Some("env.md"));
        assert_eq!(options.exclude, ["env-drafts"]);
        assert_eq!(options.favicon.as_deref(), Some("env.png"));
    }

    #[test]
    fn the_environment_overrides_the_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let env = Settings {
            title: Some("From Env".to_string()),
            strict: Some(false),
            ..Settings::default()
        };
        let file = Settings {
            title: Some("From Config".to_string()),
            strict: Some(true),
            ..Settings::default()
        };

        let options = resolve_env(dir.path(), env, file).expect("valid settings");

        assert_eq!(options.title, "From Env");
        assert!(!options.strict, "the environment wins even when it says no");
    }

    #[test]
    fn the_command_line_overrides_the_environment_over_the_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cli = Settings {
            out: Some(PathBuf::from("from-cli")),
            format: Some(OutputFormat::HtmlDir),
            title: Some("From CLI".to_string()),
            strict: Some(false),
            home: Some("cli.md".to_string()),
            exclude: Some(vec!["cli-drafts".to_string()]),
            favicon: Some("cli.png".to_string()),
        };
        let env = Settings {
            out: Some(PathBuf::from("from-env")),
            format: Some(OutputFormat::Pages),
            title: Some("From Env".to_string()),
            strict: Some(true),
            home: Some("env.md".to_string()),
            exclude: Some(vec!["env-drafts".to_string()]),
            favicon: Some("env.png".to_string()),
        };
        let file = Settings {
            out: Some(dir.path().join("from-file")),
            format: Some(OutputFormat::SingleHtml),
            title: Some("From Config".to_string()),
            strict: Some(true),
            home: Some("file.md".to_string()),
            exclude: Some(vec!["file-drafts".to_string()]),
            favicon: Some("file.png".to_string()),
        };

        let options = Options::resolve(
            &Request {
                input: dir.path().to_path_buf(),
                settings: cli,
                force: false,
                quiet: false,
            },
            &env,
            &file,
        )
        .expect("valid settings");

        assert_eq!(options.out, PathBuf::from("from-cli"));
        assert_eq!(options.format, OutputFormat::HtmlDir);
        assert_eq!(options.title, "From CLI");
        assert!(
            !options.strict,
            "the command line wins even when it says no"
        );
        assert_eq!(options.home.as_deref(), Some("cli.md"));
        assert_eq!(options.exclude, ["cli-drafts"]);
        assert_eq!(options.favicon.as_deref(), Some("cli.png"));
    }

    #[test]
    fn the_sources_fill_in_field_by_field() {
        // The command line only names `title`, the environment names `out`
        // and `strict`, the file names `format`: every field falls back down
        // the chain on its own.
        let dir = tempfile::tempdir().expect("temp dir");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                title: Some("From CLI".to_string()),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };
        let env = Settings {
            out: Some(PathBuf::from("from-env")),
            strict: Some(true),
            ..Settings::default()
        };
        let file = Settings {
            format: Some(OutputFormat::Pages),
            ..Settings::default()
        };

        let options = Options::resolve(&request, &env, &file).expect("valid settings");

        assert_eq!(options.title, "From CLI");
        assert_eq!(options.out, PathBuf::from("from-env"));
        assert!(options.strict);
        assert_eq!(options.format, OutputFormat::Pages);
    }

    #[test]
    fn rejects_missing_input_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("nope");
        let error = options_for(&missing, None).validate().unwrap_err();

        assert!(
            error.to_string().contains("input directory not found"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn rejects_input_that_is_a_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "# Notes\n").expect("write fixture");
        let error = options_for(&file, None).validate().unwrap_err();

        assert!(
            error.to_string().contains("input path is not a directory"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn rejects_output_equal_to_input() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = options_for(dir.path(), Some(dir.path()))
            .validate()
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("output directory must differ from the input directory"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn rejects_output_that_is_an_ancestor_of_input() {
        let dir = tempfile::tempdir().expect("temp dir");
        let input = dir.path().join("site");
        std::fs::create_dir(&input).expect("create input");
        let error = options_for(&input, Some(dir.path()))
            .validate()
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("output directory must not be an ancestor of the input directory"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn rejects_current_working_directory_as_output() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cwd = std::env::current_dir().expect("cwd");
        let error = options_for(dir.path(), Some(&cwd)).validate().unwrap_err();

        assert!(
            error
                .to_string()
                .contains("refusing to use the current working directory"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn accepts_default_configuration() {
        let dir = tempfile::tempdir().expect("temp dir");
        let input = dir.path().join("site");
        std::fs::create_dir(&input).expect("create input");

        assert!(options_for(&input, None).validate().is_ok());
        assert!(
            options_for(&input, Some(&input.join("build")))
                .validate()
                .is_ok(),
            "a nested output directory is allowed"
        );
    }

    #[test]
    fn normalize_makes_paths_absolute_and_collapses_segments() {
        let cwd = normalize(Path::new("."));
        assert!(cwd.is_absolute());
        assert_eq!(normalize(Path::new("a/./b/../c")), cwd.join("a").join("c"));
        assert_eq!(normalize(&cwd), cwd);
    }

    /// Filesystem root of the current working directory, computed independently
    /// of [`normalize`] by walking the path's own ancestors.
    fn filesystem_root() -> PathBuf {
        std::env::current_dir()
            .expect("cwd")
            .ancestors()
            .last()
            .expect("filesystem root")
            .to_path_buf()
    }

    /// A relative path that walks from the working directory up past the root.
    ///
    /// The depth is derived from the working directory, never hard-coded: how
    /// many segments stand between the working directory and the root depends
    /// on where the tests run (`/home/runner/work/<repo>/<repo>` on Linux,
    /// `D:\a\<repo>\<repo>` on Windows), so a fixed `../..` reaches the root on
    /// one platform and a directory above it on another.
    fn parent_segments_to_root(extra: usize) -> PathBuf {
        let depth = std::env::current_dir()
            .expect("cwd")
            .ancestors()
            .filter(|ancestor| ancestor.file_name().is_some())
            .count();

        std::iter::repeat_n("..", depth + extra).collect()
    }

    #[test]
    fn normalize_ignores_parent_segments_above_the_root() {
        let root = filesystem_root();

        assert_eq!(
            normalize(&parent_segments_to_root(0)),
            root,
            "walking to the root lands on the root"
        );
        assert_eq!(
            normalize(&parent_segments_to_root(4)),
            root,
            "walking past the root stays on the root"
        );
        assert_eq!(
            normalize(&parent_segments_to_root(32)),
            root,
            "walking far past the root stays on the root"
        );
    }

    #[test]
    fn normalize_clamps_parent_segments_that_leave_the_root() {
        let root = filesystem_root();
        let absolute = normalize(Path::new("."));

        assert_eq!(
            normalize(&absolute.join(parent_segments_to_root(1))),
            root,
            "an absolute path cannot be walked above its root"
        );
        assert_eq!(
            normalize(&root.join("..").join("..").join("tmp")),
            root.join("tmp"),
            "the root survives and later segments still apply"
        );
        assert_eq!(
            normalize(&absolute.join("a").join("..")),
            absolute,
            "a parent segment inside the path still cancels"
        );
    }

    #[test]
    fn normalize_keeps_the_filesystem_root_stable() {
        let root = filesystem_root();

        assert_eq!(normalize(&root), root);
        assert_eq!(normalize(&root.join(".")), root);
        assert_eq!(normalize(&normalize(&root)), root);
    }

    #[test]
    fn normalize_is_idempotent() {
        let once = normalize(Path::new("a/../b"));
        assert_eq!(normalize(&once), once);
    }

    #[test]
    fn ancestor_detection_respects_component_boundaries() {
        let root = tempfile::tempdir().expect("temp dir");
        let site = root.path().join("site");
        let sibling = root.path().join("site2");

        assert!(is_ancestor(root.path(), &site));
        assert!(!is_ancestor(&site, root.path()));
        assert!(!is_ancestor(&sibling, &site));
        assert!(!is_ancestor(&site, &site), "equality is not ancestry");
    }

    #[test]
    fn title_falls_back_when_no_file_name_is_available() {
        let root = normalize(Path::new("."));
        assert_eq!(
            default_title(&root),
            root.file_name().unwrap().to_string_lossy()
        );
    }
}
