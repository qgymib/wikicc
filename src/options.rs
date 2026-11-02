//! Resolved build options: defaults, lexical path normalization and safety guards.

use std::ffi::OsString;
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use crate::cli::Cli;
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
}

impl OutputFormat {
    /// Every accepted format, in CLI order.
    pub const ALL: [OutputFormat; 2] = [Self::SingleHtml, Self::HtmlDir];

    /// CLI spelling of the format.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SingleHtml => "single-html",
            Self::HtmlDir => "html-dir",
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
                    "invalid format '{value}', expected one of: single-html, html-dir"
                ))
            })
    }
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
}

impl Options {
    /// Derive defaults from raw CLI arguments. Performs no I/O.
    pub fn from_cli(cli: Cli) -> Self {
        let input = cli.input;
        let out = cli.out.unwrap_or_else(|| input.join(DEFAULT_OUT_DIR));
        let title = cli.title.unwrap_or_else(|| default_title(&input));

        Self {
            input,
            out,
            format: cli.format,
            title,
            strict: cli.strict,
            force: cli.force,
            quiet: cli.quiet,
        }
    }

    /// Absolute, lexically normalized input path.
    pub fn normalized_input(&self) -> PathBuf {
        normalize(&self.input)
    }

    /// Absolute, lexically normalized output path.
    pub fn normalized_out(&self) -> PathBuf {
        normalize(&self.out)
    }

    /// Reject unusable input/output combinations.
    ///
    /// This is the only place that guards the output directory, so it must run
    /// before anything is written or removed.
    pub fn validate(&self) -> Result<()> {
        if !self.input.exists() {
            return Err(Error::InvalidInput(format!(
                "input directory not found: {}",
                self.input.display()
            )));
        }
        if !self.input.is_dir() {
            return Err(Error::InvalidInput(format!(
                "input path is not a directory: {}",
                self.input.display()
            )));
        }

        let input = self.normalized_input();
        let out = self.normalized_out();

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
    let mut rooted = false;
    let mut parts: Vec<OsString> = Vec::new();

    for component in absolute.components() {
        match component {
            Component::Prefix(value) => prefix = Some(value.as_os_str().to_os_string()),
            Component::RootDir => rooted = true,
            Component::CurDir => {}
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
    if rooted {
        normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cli_for(input: &Path) -> Cli {
        Cli {
            input: input.to_path_buf(),
            out: None,
            format: OutputFormat::SingleHtml,
            title: None,
            strict: false,
            force: false,
            quiet: false,
        }
    }

    fn options_for(input: &Path, out: Option<&Path>) -> Options {
        let mut cli = cli_for(input);
        cli.out = out.map(Path::to_path_buf);
        Options::from_cli(cli)
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
    }

    #[test]
    fn rejects_unknown_format_with_documented_message() {
        let error = "pdf".parse::<OutputFormat>().unwrap_err();

        assert_eq!(
            error.to_string(),
            "invalid format 'pdf', expected one of: single-html, html-dir"
        );
        assert_eq!(error.exit_code(), crate::error::EXIT_FAILURE);
    }

    #[test]
    fn a_removed_format_is_an_unknown_format() {
        let error = "mhtml".parse::<OutputFormat>().unwrap_err();

        assert_eq!(
            error.to_string(),
            "invalid format 'mhtml', expected one of: single-html, html-dir"
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
    fn derives_default_out_and_title() {
        let dir = tempfile::tempdir().expect("temp dir");
        let options = options_for(dir.path(), None);

        assert_eq!(options.out, dir.path().join(DEFAULT_OUT_DIR));
        assert_eq!(
            options.title,
            dir.path().file_name().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn keeps_explicit_out_and_title() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut cli = cli_for(dir.path());
        cli.out = Some(PathBuf::from("build"));
        cli.title = Some("Handbook".to_string());
        cli.format = OutputFormat::HtmlDir;
        cli.strict = true;
        cli.force = true;
        cli.quiet = true;

        let options = Options::from_cli(cli);

        assert_eq!(options.out, PathBuf::from("build"));
        assert_eq!(options.title, "Handbook");
        assert_eq!(options.format, OutputFormat::HtmlDir);
        assert!(options.strict);
        assert!(options.force);
        assert!(options.quiet);
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

    #[test]
    fn normalize_ignores_parent_segments_above_the_root() {
        let cwd = normalize(Path::new("."));
        let root = cwd
            .ancestors()
            .last()
            .expect("filesystem root")
            .to_path_buf();

        assert_eq!(normalize(Path::new("../..")), root);
        assert_eq!(normalize(Path::new("../../../../../../..")), root);
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
