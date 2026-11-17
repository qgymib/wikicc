//! The three-source merge: command line over environment over configuration
//! file over built-in defaults.

use std::path::{Path, PathBuf};

use super::format::OutputFormat;
use super::guards::{normalize, validate_input, validate_paths};
use super::settings::{Request, Settings};
use super::{normalize_candidate, normalize_excludes, normalize_favicon};
use crate::error::{Error, Result};

/// Directory appended to the input directory when `--out` is omitted.
pub const DEFAULT_OUT_DIR: &str = "dist";

/// Fallback site title when the input path has no usable file name.
pub const FALLBACK_TITLE: &str = "wikicc";

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
    /// The global sealing password, exactly as the winning source wrote it;
    /// `None` when no source named one. Blank values are rejected: a password
    /// that is empty after trimming cannot be expressed through any source.
    pub password: Option<String>,
    /// Worker threads the parallel build stages may use, exactly as the
    /// winning source wrote it; `None` uses every available core.
    pub jobs: Option<u32>,
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
    /// input folder, a `favicon` that is empty after normalization or escapes
    /// the input folder, and a `password` that is empty after trimming are
    /// hard errors, whatever the source.
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

        let password = cli
            .password
            .clone()
            .or_else(|| env.password.clone())
            .or_else(|| file.password.clone());
        if let Some(raw) = &password
            && raw.trim().is_empty()
        {
            return Err(Error::InvalidInput(
                "'password' must be a non-empty string".to_string(),
            ));
        }

        // The count readers reject zero already, so only the command line can
        // carry one here: a build with no worker threads cannot run, whatever
        // the source.
        let jobs = cli.jobs.or(env.jobs).or(file.jobs);
        if jobs == Some(0) {
            return Err(Error::InvalidInput("'jobs' must be at least 1".to_string()));
        }

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
            password,
            jobs,
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
            password: Some("cli secret".to_string()),
            ..Settings::default()
        };

        let options = resolve_cli(dir.path(), settings).expect("valid settings");

        assert_eq!(options.out, PathBuf::from("build"));
        assert_eq!(options.title, "Handbook");
        assert_eq!(options.format, OutputFormat::HtmlDir);
        assert!(options.strict);
        assert_eq!(options.home.as_deref(), Some("intro"));
        assert_eq!(options.exclude, ["drafts"]);
        assert_eq!(options.favicon.as_deref(), Some("assets/icon.png"));
        assert_eq!(options.password.as_deref(), Some("cli secret"));
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
            password: Some("file secret".to_string()),
            ..Settings::default()
        };

        let options = resolve_file(dir.path(), file).expect("valid settings");

        assert_eq!(options.out, dir.path().join("site"));
        assert_eq!(options.format, OutputFormat::Pages);
        assert_eq!(options.title, "From Config");
        assert!(options.strict);
        assert_eq!(options.home.as_deref(), Some("intro.md"));
        assert_eq!(options.exclude, ["drafts"]);
        assert_eq!(options.favicon.as_deref(), Some("assets/file.png"));
        assert_eq!(options.password.as_deref(), Some("file secret"));
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
                password: Some("cli secret".to_string()),
                ..Settings::default()
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
            password: Some("file secret".to_string()),
            ..Settings::default()
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
        assert_eq!(options.password.as_deref(), Some("cli secret"));
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
    fn an_empty_password_is_a_hard_error_whatever_the_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cli = Settings {
            password: Some("   ".to_string()),
            ..Settings::default()
        };
        let file = Settings {
            password: Some(String::new()),
            ..Settings::default()
        };

        let cli_error = resolve_cli(dir.path(), cli).expect_err("an empty password is rejected");
        let file_error = resolve_file(dir.path(), file).expect_err("an empty password is rejected");

        assert_eq!(
            cli_error.to_string(),
            "'password' must be a non-empty string"
        );
        assert_eq!(
            file_error.to_string(),
            "'password' must be a non-empty string"
        );
    }

    #[test]
    fn jobs_merge_from_every_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let request = Request {
            input: dir.path().to_path_buf(),
            settings: Settings {
                jobs: Some(2),
                ..Settings::default()
            },
            force: false,
            quiet: false,
        };
        let env = Settings {
            jobs: Some(3),
            ..Settings::default()
        };
        let file = Settings {
            jobs: Some(4),
            ..Settings::default()
        };

        let options = Options::resolve(&request, &env, &file).expect("valid settings");
        assert_eq!(options.jobs, Some(2), "the command line wins");

        let options = Options::resolve(
            &Request {
                input: dir.path().to_path_buf(),
                settings: Settings::default(),
                force: false,
                quiet: false,
            },
            &env,
            &file,
        )
        .expect("valid settings");
        assert_eq!(options.jobs, Some(3), "the environment wins over the file");

        let options = resolve_file(dir.path(), file).expect("valid settings");
        assert_eq!(options.jobs, Some(4));

        let options = resolve_cli(dir.path(), Settings::default()).expect("valid settings");
        assert_eq!(
            options.jobs, None,
            "no source spoke, the default is automatic"
        );
    }

    #[test]
    fn a_zero_jobs_value_is_a_hard_error_whatever_the_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cli = Settings {
            jobs: Some(0),
            ..Settings::default()
        };
        let file = Settings {
            jobs: Some(0),
            ..Settings::default()
        };

        let cli_error = resolve_cli(dir.path(), cli).expect_err("zero threads cannot build");
        let file_error = resolve_file(dir.path(), file).expect_err("zero threads cannot build");

        assert_eq!(cli_error.to_string(), "'jobs' must be at least 1");
        assert_eq!(file_error.to_string(), "'jobs' must be at least 1");
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
            password: Some("env secret".to_string()),
            ..Settings::default()
        };

        let options = resolve_env(dir.path(), env, Settings::default()).expect("valid settings");

        assert_eq!(options.out, PathBuf::from("from-env"));
        assert_eq!(options.format, OutputFormat::HtmlDir);
        assert_eq!(options.title, "From Env");
        assert!(options.strict);
        assert_eq!(options.home.as_deref(), Some("env.md"));
        assert_eq!(options.exclude, ["env-drafts"]);
        assert_eq!(options.favicon.as_deref(), Some("env.png"));
        assert_eq!(options.password.as_deref(), Some("env secret"));
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
            password: Some("cli secret".to_string()),
            ..Settings::default()
        };
        let env = Settings {
            out: Some(PathBuf::from("from-env")),
            format: Some(OutputFormat::Pages),
            title: Some("From Env".to_string()),
            strict: Some(true),
            home: Some("env.md".to_string()),
            exclude: Some(vec!["env-drafts".to_string()]),
            favicon: Some("env.png".to_string()),
            password: Some("env secret".to_string()),
            ..Settings::default()
        };
        let file = Settings {
            out: Some(dir.path().join("from-file")),
            format: Some(OutputFormat::SingleHtml),
            title: Some("From Config".to_string()),
            strict: Some(true),
            home: Some("file.md".to_string()),
            exclude: Some(vec!["file-drafts".to_string()]),
            favicon: Some("file.png".to_string()),
            password: Some("file secret".to_string()),
            ..Settings::default()
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
        assert_eq!(options.password.as_deref(), Some("cli secret"));
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
    fn title_falls_back_when_no_file_name_is_available() {
        let root = normalize(Path::new("."));
        assert_eq!(
            default_title(&root),
            root.file_name().unwrap().to_string_lossy()
        );
    }
}
