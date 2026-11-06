//! `wikicc` command line entry point.
//!
//! The binary owns only four things: reading the arguments with `clap`,
//! dispatching the `--init-config` action, handing the resolved
//! [`wikicc::Options`] to [`wikicc::pipeline::run`], and turning a failure
//! into the documented exit code. Everything else — the stage order, the
//! `--strict` gate, the warnings and the summary line — lives in the library,
//! where it is unit tested.

use std::io;

use clap::Parser;

use wikicc::cli::Cli;
use wikicc::{config, pipeline};

fn main() {
    let mut cli = Cli::parse();

    // `--init-config` replaces the build: it writes a default configuration
    // file and exits before any build option is derived.
    if let Some(dir) = cli.init_config.take() {
        let mut out = io::stdout();
        if let Err(error) = config::init(&dir, &mut out) {
            eprintln!("error: {error}");
            std::process::exit(error.exit_code());
        }
        return;
    }

    let options = cli.into_options();

    let mut out = io::stdout();
    let mut err = io::stderr();

    if let Err(error) = pipeline::run(&options, &mut out, &mut err) {
        eprintln!("error: {error}");
        std::process::exit(error.exit_code());
    }
}
