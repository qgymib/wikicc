//! Resolved build options: defaults, lexical path normalization and safety guards.
//!
//! [`Settings`] is the shared shape of everything the command line, the
//! `WIKICC_*` environment variables (see [`crate::env`]) and `.wikicc.json`
//! can all express; [`Options::resolve`] merges the three sources — command
//! line over environment over file over built-in defaults — into the
//! [`Options`] the pipeline consumes.

mod format;
mod guards;
mod resolve;
mod settings;
mod values;

pub use format::OutputFormat;
pub(crate) use guards::path_components;
pub use guards::{normalize, validate_input, validate_paths};
pub use resolve::{DEFAULT_OUT_DIR, FALLBACK_TITLE, Options};
pub use settings::{Request, Settings};
pub(crate) use values::{normalize_candidate, normalize_excludes, normalize_favicon};
