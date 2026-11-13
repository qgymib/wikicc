//! Command line surface: clap definitions and raw argument collection.
//!
//! This module only describes *what the user typed*. Merging it with the
//! environment and the configuration file, and deriving defaults, happens in
//! [`crate::options`], so the pipeline never has to look at clap types.

use std::path::PathBuf;

use clap::Parser;

use crate::options::{Request, Settings};

/// Compile a folder of Markdown documents into an offline HTML reader.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(
    name = "wikicc",
    bin_name = "wikicc",
    version,
    about = "Compile a folder of Markdown documents into a self-contained offline HTML reader",
    long_about = None
)]
pub struct Cli {
    /// Folder that contains the Markdown documents to compile (required unless `--init-config` was given)
    //
    // The value is an `Option` because clap's derive forces a plain
    // positional to be required, and its debug assertions reject that
    // alongside a `required_unless*` rule; a one-paragraph doc comment also
    // keeps the rendered help in its compact layout.
    #[arg(value_name = "INPUT_DIR", required_unless_present = "init_config")]
    pub input: Option<PathBuf>,

    /// Everything `.wikicc.json` and the WIKICC_* environment variables can
    /// also carry; an explicit flag wins.
    #[command(flatten)]
    pub settings: Settings,

    /// Overwrite the output directory without confirmation
    #[arg(long)]
    pub force: bool,

    /// Suppress the summary line
    #[arg(short, long)]
    pub quiet: bool,

    /// Write a default `.wikicc.json` into DIR [default: the current directory] and exit
    #[arg(
        long,
        value_name = "DIR",
        num_args(0..=1),
        default_missing_value = ".",
        conflicts_with = "input"
    )]
    pub init_config: Option<PathBuf>,
}

impl Cli {
    /// Collect the raw arguments into a [`Request`] (no defaults, no I/O).
    ///
    /// Only valid for a build invocation: `INPUT_DIR` is missing when
    /// `--init-config` replaces the build, and the binary dispatches that
    /// action before reaching here.
    pub fn into_request(self) -> Request {
        let input = self
            .input
            .expect("INPUT_DIR is set for every build invocation");
        Request {
            input,
            settings: self.settings,
            force: self.force,
            quiet: self.quiet,
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::error::ErrorKind;

    use super::*;
    use crate::options::OutputFormat;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).expect("arguments should parse")
    }

    fn parse_error(args: &[&str]) -> clap::Error {
        Cli::try_parse_from(args).expect_err("arguments should be rejected")
    }

    #[test]
    fn parses_minimal_invocation_with_defaults() {
        let cli = parse(&["wikicc", "docs"]);

        assert_eq!(cli.input, Some(PathBuf::from("docs")));
        assert_eq!(cli.settings, Settings::default());
        assert!(!cli.force);
        assert!(!cli.quiet);
        assert_eq!(cli.init_config, None);
    }

    #[test]
    fn parses_every_option() {
        let cli = parse(&[
            "wikicc",
            "docs",
            "--out",
            "build",
            "--format",
            "html-dir",
            "--title",
            "Handbook",
            "--strict",
            "--home",
            "intro",
            "--exclude",
            "drafts",
            "--favicon",
            "assets/icon.png",
            "--force",
            "--quiet",
        ]);

        assert_eq!(cli.input, Some(PathBuf::from("docs")));
        assert_eq!(cli.settings.out, Some(PathBuf::from("build")));
        assert_eq!(cli.settings.format, Some(OutputFormat::HtmlDir));
        assert_eq!(cli.settings.title.as_deref(), Some("Handbook"));
        assert_eq!(cli.settings.strict, Some(true));
        assert_eq!(cli.settings.home.as_deref(), Some("intro"));
        assert_eq!(cli.settings.exclude, Some(vec!["drafts".to_string()]));
        assert_eq!(cli.settings.favicon.as_deref(), Some("assets/icon.png"));
        assert!(cli.force);
        assert!(cli.quiet);
    }

    #[test]
    fn a_bare_strict_flag_means_true() {
        let cli = parse(&["wikicc", "docs", "--strict"]);

        assert_eq!(cli.settings.strict, Some(true));
    }

    #[test]
    fn strict_false_turns_the_gate_off() {
        let cli = parse(&["wikicc", "--strict=false", "docs"]);

        assert_eq!(cli.settings.strict, Some(false));
        assert_eq!(cli.input, Some(PathBuf::from("docs")));
    }

    #[test]
    fn strict_without_equals_takes_no_value() {
        let cli = parse(&["wikicc", "--strict", "--force", "docs"]);

        assert_eq!(cli.settings.strict, Some(true));
        assert!(cli.force);
        assert_eq!(cli.input, Some(PathBuf::from("docs")));
    }

    #[test]
    fn excludes_are_repeatable() {
        let cli = parse(&[
            "wikicc",
            "docs",
            "--exclude",
            "drafts",
            "--exclude",
            "archive/old",
        ]);

        assert_eq!(
            cli.settings.exclude,
            Some(vec!["drafts".to_string(), "archive/old".to_string()])
        );
    }

    #[test]
    fn accepts_short_flags() {
        let cli = parse(&["wikicc", "docs", "-o", "build", "-q"]);

        assert_eq!(cli.settings.out, Some(PathBuf::from("build")));
        assert!(cli.quiet);
    }

    #[test]
    fn accepts_every_format_spelling() {
        for (value, expected) in [
            ("single-html", OutputFormat::SingleHtml),
            ("html-dir", OutputFormat::HtmlDir),
            ("pages", OutputFormat::Pages),
        ] {
            let cli = parse(&["wikicc", "docs", "--format", value]);
            assert_eq!(cli.settings.format, Some(expected));
        }
    }

    #[test]
    fn rejects_unknown_format_as_usage_error() {
        let error = parse_error(&["wikicc", "docs", "--format", "pdf"]);

        assert_eq!(error.kind(), ErrorKind::ValueValidation);
        let rendered = error.to_string();
        assert!(
            rendered
                .contains("invalid format 'pdf', expected one of: single-html, html-dir, pages"),
            "unexpected error text: {rendered}"
        );
    }

    #[test]
    fn rejects_missing_input_directory() {
        let error = parse_error(&["wikicc"]);

        assert_eq!(error.kind(), ErrorKind::MissingRequiredArgument);
        assert!(error.to_string().contains("INPUT_DIR"));
    }

    #[test]
    fn init_config_defaults_to_the_current_directory() {
        let cli = parse(&["wikicc", "--init-config"]);

        assert_eq!(cli.init_config, Some(PathBuf::from(".")));
    }

    #[test]
    fn init_config_takes_an_explicit_directory() {
        let cli = parse(&["wikicc", "--init-config", "docs"]);

        assert_eq!(cli.init_config, Some(PathBuf::from("docs")));
    }

    #[test]
    fn init_config_and_input_are_mutually_exclusive() {
        let error = parse_error(&["wikicc", "docs", "--init-config"]);

        assert_eq!(error.kind(), ErrorKind::ArgumentConflict);
    }

    #[test]
    fn help_lists_documented_options() {
        let error = parse_error(&["wikicc", "--help"]);
        let help = error.to_string();

        assert_eq!(error.kind(), ErrorKind::DisplayHelp);
        for expected in [
            "INPUT_DIR",
            "--out",
            "--format",
            "--title",
            "--strict",
            "--home",
            "--exclude",
            "--favicon",
            "--force",
            "--quiet",
            "--init-config",
        ] {
            assert!(
                help.contains(expected),
                "help is missing {expected}: {help}"
            );
        }
    }

    #[test]
    fn version_uses_binary_name_and_package_version() {
        let error = parse_error(&["wikicc", "--version"]);

        assert_eq!(error.kind(), ErrorKind::DisplayVersion);
        assert_eq!(
            error.to_string().trim(),
            format!("wikicc {}", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn into_request_collects_the_raw_arguments() {
        let dir = tempfile::tempdir().expect("temp dir");
        let input = dir.path().to_str().expect("utf-8 path").to_string();

        let request = parse(&["wikicc", &input, "--out", "build", "--force", "-q"]).into_request();

        assert_eq!(request.input, dir.path());
        assert_eq!(request.settings.out, Some(PathBuf::from("build")));
        assert_eq!(
            request.settings,
            Settings {
                out: Some(PathBuf::from("build")),
                ..Settings::default()
            }
        );
        assert!(request.force);
        assert!(request.quiet);
    }
}
