//! Command line surface: clap definitions and raw argument collection.
//!
//! This module only describes *what the user typed*. Deriving defaults and
//! validating paths happens in [`crate::options`], so the pipeline never has to
//! look at clap types.

use std::path::PathBuf;
use std::str::FromStr;

use clap::Parser;

use crate::options::{Options, OutputFormat};

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
    /// Folder that contains the Markdown documents to compile
    #[arg(value_name = "INPUT_DIR")]
    pub input: PathBuf,

    /// Output directory [default: <INPUT_DIR>/dist]
    #[arg(short, long, value_name = "DIR")]
    pub out: Option<PathBuf>,

    /// Output format
    #[arg(
        long,
        value_name = "FMT",
        default_value_t = OutputFormat::SingleHtml,
        value_parser = OutputFormat::from_str
    )]
    pub format: OutputFormat,

    /// Site title [default: input folder name]
    #[arg(long, value_name = "TITLE")]
    pub title: Option<String>,

    /// Treat warnings (broken links, missing assets) as errors
    #[arg(long)]
    pub strict: bool,

    /// Overwrite the output directory without confirmation
    #[arg(long)]
    pub force: bool,

    /// Suppress the summary line
    #[arg(short, long)]
    pub quiet: bool,
}

impl Cli {
    /// Resolve the raw arguments into build [`Options`] (defaults applied, no I/O).
    pub fn into_options(self) -> Options {
        Options::from_cli(self)
    }
}

#[cfg(test)]
mod tests {
    use clap::error::ErrorKind;

    use super::*;
    use crate::options::DEFAULT_OUT_DIR;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).expect("arguments should parse")
    }

    fn parse_error(args: &[&str]) -> clap::Error {
        Cli::try_parse_from(args).expect_err("arguments should be rejected")
    }

    #[test]
    fn parses_minimal_invocation_with_defaults() {
        let cli = parse(&["wikicc", "docs"]);

        assert_eq!(cli.input, PathBuf::from("docs"));
        assert_eq!(cli.out, None);
        assert_eq!(cli.format, OutputFormat::SingleHtml);
        assert_eq!(cli.title, None);
        assert!(!cli.strict);
        assert!(!cli.force);
        assert!(!cli.quiet);
    }

    #[test]
    fn parses_every_option() {
        let cli = parse(&[
            "wikicc", "docs", "--out", "build", "--format", "mhtml", "--title", "Handbook",
            "--strict", "--force", "--quiet",
        ]);

        assert_eq!(cli.input, PathBuf::from("docs"));
        assert_eq!(cli.out, Some(PathBuf::from("build")));
        assert_eq!(cli.format, OutputFormat::Mhtml);
        assert_eq!(cli.title.as_deref(), Some("Handbook"));
        assert!(cli.strict);
        assert!(cli.force);
        assert!(cli.quiet);
    }

    #[test]
    fn accepts_short_flags() {
        let cli = parse(&["wikicc", "docs", "-o", "build", "-q"]);

        assert_eq!(cli.out, Some(PathBuf::from("build")));
        assert!(cli.quiet);
    }

    #[test]
    fn accepts_every_format_spelling() {
        for (value, expected) in [
            ("single-html", OutputFormat::SingleHtml),
            ("html-dir", OutputFormat::HtmlDir),
            ("mhtml", OutputFormat::Mhtml),
        ] {
            let cli = parse(&["wikicc", "docs", "--format", value]);
            assert_eq!(cli.format, expected);
        }
    }

    #[test]
    fn rejects_unknown_format_as_usage_error() {
        let error = parse_error(&["wikicc", "docs", "--format", "pdf"]);

        assert_eq!(error.kind(), ErrorKind::ValueValidation);
        let rendered = error.to_string();
        assert!(
            rendered
                .contains("invalid format 'pdf', expected one of: single-html, html-dir, mhtml"),
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
            "--force",
            "--quiet",
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
    fn into_options_derives_out_and_title() {
        let dir = tempfile::tempdir().expect("temp dir");
        let input = dir.path().to_str().expect("utf-8 path").to_string();

        let options = parse(&["wikicc", &input]).into_options();

        assert_eq!(options.input, dir.path());
        assert_eq!(options.out, dir.path().join(DEFAULT_OUT_DIR));
        assert_eq!(
            options.title,
            dir.path()
                .file_name()
                .expect("temp dir name")
                .to_string_lossy()
        );
    }

    #[test]
    fn into_options_keeps_explicit_values() {
        let dir = tempfile::tempdir().expect("temp dir");
        let input = dir.path().to_str().expect("utf-8 path").to_string();

        let options = parse(&[
            "wikicc", &input, "--out", "custom", "--title", "My Site", "--format", "html-dir",
        ])
        .into_options();

        assert_eq!(options.out, PathBuf::from("custom"));
        assert_eq!(options.title, "My Site");
        assert_eq!(options.format, OutputFormat::HtmlDir);
    }
}
