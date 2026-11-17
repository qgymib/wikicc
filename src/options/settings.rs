//! The shapes the three setting sources share: what any of them says, and
//! what the command line collected before the merge.

use std::path::PathBuf;
use std::str::FromStr;

use clap::Parser;

use super::format::OutputFormat;

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

    /// Global password for documents whose front matter declares encryption;
    /// overrides `.wikicc.json`. Prefer the `WIKICC_PASSWORD` environment
    /// variable: a command line value stays in the shell history and the
    /// process list.
    #[arg(long, value_name = "PASSWORD")]
    pub password: Option<String>,

    /// Worker threads the parallel build stages may use; overrides `.wikicc.json`
    /// [default: all cores]
    #[arg(short = 'j', long, value_name = "N")]
    pub jobs: Option<u32>,
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
