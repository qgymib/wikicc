//! `wikicc` command line entry point.
//!
//! The binary owns only three things: reading the arguments with `clap`,
//! handing the resolved [`wikicc::Options`] to [`wikicc::pipeline::run`], and
//! turning a failure into the documented exit code. Everything else — the
//! stage order, the `--strict` gate, the warnings, the MHTML note and the
//! summary line — lives in the library, where it is unit tested.

use std::io;

use clap::Parser;

use wikicc::cli::Cli;
use wikicc::pipeline;

fn main() {
    let cli = Cli::parse();
    let options = cli.into_options();

    let mut out = io::stdout();
    let mut err = io::stderr();

    if let Err(error) = pipeline::run(&options, &mut out, &mut err) {
        eprintln!("error: {error}");
        std::process::exit(error.exit_code());
    }
}
