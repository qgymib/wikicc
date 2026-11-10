//! Favicon resolution: the site icon the compiled reader carries.
//!
//! Every artifact carries a favicon — the `<link rel="icon">` a browser tab
//! shows. The value comes from one of two places:
//!
//! - the `favicon` setting of the command line or `.wikicc.json`, a file path
//!   relative to the input folder (an absolute path is taken as it is);
//! - the default: `docs/logo.svg`, embedded into the executable at build time.
//!
//! The default travels through the same staging pipeline as the page skeleton
//! and the shell stylesheet: `build.rs` writes an LF-normalized copy into
//! `OUT_DIR`, so the embedded bytes — and therefore the asset hash every build
//! derives from them — never depend on how Git checked the source out.
//!
//! The resolved bytes are registered into the site's [`AssetTable`] by the
//! pipeline (see [`crate::site::SiteBuild::register_favicon`]), so the writers
//! address the favicon exactly like every other resource: inlined as a data
//! URI by `single-html`, written to `assets/` by the other two formats.
//!
//! A configured favicon is an explicit instruction, so a file that cannot be
//! read is a hard error: silently falling back to the default would publish a
//! site the author did not ask for.

use std::path::Path;

use crate::error::{Error, Result};

/// Default favicon embedded at build time: the staged, LF-normalized copy of
/// `docs/logo.svg` that `build.rs` writes into `OUT_DIR`.
pub const DEFAULT_FAVICON: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/vendor/logo.svg"));

/// Name the default favicon is registered under.
///
/// [`crate::assets::AssetTable::insert_bytes`] uses the path only for the
/// extension and the MIME type, so a plain file name is enough: it yields the
/// `svg` extension and the `image/svg+xml` type of
/// [`crate::assets::MIME_FALLBACKS`].
pub const DEFAULT_FAVICON_NAME: &str = "logo.svg";

/// The favicon of one build: the bytes plus the name the asset table
/// registers them under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Favicon {
    /// Name the asset table uses for the extension and the MIME type.
    ///
    /// A `/`-separated path relative to the input folder, as the setting
    /// normalized it; `logo.svg` for the default.
    pub name: String,
    /// Favicon content.
    pub bytes: Vec<u8>,
}

/// Resolve the favicon of a build.
///
/// `configured` is the normalized `favicon` value of the merged options —
/// `None` when neither the command line nor the configuration file named one.
/// `None` resolves to the embedded default; `Some` reads the path relative to
/// the input folder, where an absolute value replaces the input folder the
/// way `Path::join` spells it.
///
/// The value is validated by [`crate::options::Options::resolve`] before it
/// reaches here, so a candidate that escapes the input folder can no longer
/// arrive. A configured file that cannot be read is a hard
/// [`Error::InvalidInput`]: the build aborts before anything is reported or
/// written.
pub fn resolve(configured: Option<&str>, input: &Path) -> Result<Favicon> {
    let Some(candidate) = configured else {
        return Ok(Favicon {
            name: DEFAULT_FAVICON_NAME.to_string(),
            bytes: DEFAULT_FAVICON.to_vec(),
        });
    };

    let path = input.join(candidate);
    let bytes = std::fs::read(&path).map_err(|error| {
        Error::InvalidInput(format!(
            "cannot read the favicon '{}': {error}",
            path.display()
        ))
    })?;

    Ok(Favicon {
        name: candidate.to_string(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::assets::mime_for;

    #[test]
    fn unset_resolves_to_the_embedded_default() {
        let favicon = resolve(None, Path::new("anywhere")).expect("the default always exists");

        assert_eq!(favicon.name, DEFAULT_FAVICON_NAME);
        assert_eq!(favicon.bytes, DEFAULT_FAVICON);
        assert!(!favicon.bytes.is_empty(), "the embedded logo is not empty");
    }

    #[test]
    fn the_embedded_default_carries_unix_line_endings() {
        assert!(
            !DEFAULT_FAVICON.contains(&b'\r'),
            "the staged copy must not leak a carriage return into the asset hash"
        );
    }

    #[test]
    fn the_default_name_resolves_to_the_svg_mime_type() {
        assert_eq!(
            mime_for(Path::new(DEFAULT_FAVICON_NAME)),
            "image/svg+xml",
            "the synthetic name must yield the vector-image type"
        );
    }

    #[test]
    fn a_configured_favicon_is_read_from_the_input_folder() {
        let dir = tempfile::tempdir().expect("temp dir");
        let nested = dir.path().join("assets");
        fs::create_dir(&nested).expect("create directory");
        fs::write(nested.join("icon.png"), b"png").expect("write fixture");

        let favicon = resolve(Some("assets/icon.png"), dir.path()).expect("the file is readable");

        assert_eq!(favicon.name, "assets/icon.png");
        assert_eq!(favicon.bytes, b"png");
    }

    #[test]
    fn an_absolute_configured_path_replaces_the_input_folder() {
        let input = tempfile::tempdir().expect("temp dir");
        let other = tempfile::tempdir().expect("temp dir");
        let icon = other.path().join("elsewhere.png");
        fs::write(&icon, b"png").expect("write fixture");
        let configured = icon.to_str().expect("utf-8 path").to_string();

        let favicon =
            resolve(Some(configured.as_str()), input.path()).expect("the file is readable");

        assert_eq!(favicon.name, configured, "the value itself is kept");
        assert_eq!(favicon.bytes, b"png");
    }

    #[test]
    fn a_missing_configured_favicon_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("temp dir");

        let error = resolve(Some("gone.png"), dir.path()).expect_err("the file does not exist");

        assert!(
            error.to_string().contains("cannot read the favicon"),
            "unexpected message: {error}"
        );
        assert_eq!(error.exit_code(), crate::error::EXIT_FAILURE);
    }

    #[test]
    fn a_directory_at_the_favicon_path_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir(dir.path().join("icon.png")).expect("create directory fixture");

        let error = resolve(Some("icon.png"), dir.path()).expect_err("a directory cannot be read");

        assert!(
            error.to_string().contains("cannot read the favicon"),
            "unexpected message: {error}"
        );
    }
}
