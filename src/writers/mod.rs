//! Write stage: turn the rendered page into the artifact of the selected format.
//!
//! This is the `write` stage described in `docs/DESIGN.md`. The render stage
//! hands over one HTML document in which every local resource is addressed by
//! the opaque placeholder [`crate::ASSET_PLACEHOLDER_PREFIX`]`<hash>`. A writer
//! replaces those placeholders with the addressing form of its own format and
//! puts the result on disk:
//!
//! - `single-html` → `data:<mime>;base64,…` inside one `index.html`;
//! - `html-dir` → `assets/<hash>.<ext>` next to `index.html`;
//! - `mhtml` → `cid:<hash>` inside a `multipart/related` file.
//!
//! The asset file name is a shared concern rather than a `html-dir` detail:
//! `mhtml` addresses the same bytes as `assets/<hash>.<ext>` in its
//! `Content-Location` headers, so [`asset_file_name`] and
//! [`asset_relative_path`] live here and both formats use them.
//!
//! Addressing is the only thing the three formats differ in, so the writers stay
//! thin and never duplicate rendering.
//!
//! The placeholders only ever appear inside the JSON payload that sits in the
//! `<script type="application/json">` element. Every substitution value is a
//! data URI, a relative path or a `cid:` reference, none of which contains a
//! quote, a backslash or a control character, so replacing them keeps the
//! payload valid JSON and the page inert.
//!
//! Determinism: the artifact is the rendered page with a deterministic
//! substitution applied, [`crate::assets::AssetTable`] iterates in hash order,
//! and nothing here reads the clock or the environment. Two builds of the same
//! input therefore produce byte-identical artifacts.

use std::path::{Path, PathBuf};

use crate::assets::{ASSET_PLACEHOLDER_PREFIX, Asset, AssetTable, HASH_HEX_LEN};
use crate::error::{Error, Result};
use crate::options::OutputFormat;
use crate::render::RenderedSite;
use crate::site::SiteBuild;

pub mod html_dir;
pub mod mhtml;
pub mod single_html;

pub use html_dir::HtmlDirWriter;
pub use mhtml::MhtmlWriter;
pub use single_html::{SingleHtmlWriter, data_uri};

/// Name of the HTML artifact, used by `single-html` and `html-dir`.
pub const HTML_FILE_NAME: &str = "index.html";

/// Name of the MHTML artifact.
pub const MHTML_FILE_NAME: &str = "index.mhtml";

/// Directory that holds the assets of the `html-dir` format.
///
/// The directory sits next to [`HTML_FILE_NAME`], so every asset is addressed
/// by a path that is relative to the page itself and survives moving or
/// copying the whole output directory.
pub const ASSETS_DIR_NAME: &str = "assets";

/// File name of `asset` inside [`ASSETS_DIR_NAME`]: `<hash>.<ext>`.
///
/// The hash is content-addressed (so identical bytes always produce the same
/// name and duplicates collapse) and the extension comes from
/// [`crate::assets::asset_extension`], which only ever emits `[a-z0-9]+`. Both
/// halves are therefore safe in a URL without percent-encoding.
pub fn asset_file_name(asset: &Asset) -> String {
    format!("{}.{}", asset.hash, asset.extension)
}

/// Address of `asset` as written into `index.html`: `assets/<hash>.<ext>`.
///
/// The separator is a literal `'/'` on purpose: this is a URL, not a file
/// system path, and `Path::display` would emit `\` on Windows. The on-disk
/// path is built separately with `out.join(ASSETS_DIR_NAME)`.
pub fn asset_relative_path(asset: &Asset) -> String {
    format!("{ASSETS_DIR_NAME}/{}", asset_file_name(asset))
}

/// File names that mark a directory as a previous `wikicc` build.
///
/// Used by [`prepare_output_dir`] to decide whether an existing directory may be
/// emptied without `--force`: the default `<input>/dist` always carries one of
/// these after the first build, so rebuilding stays frictionless, while an
/// unrelated directory the user pointed `--out` at is left untouched.
pub const BUILD_MARKERS: [&str; 2] = [HTML_FILE_NAME, MHTML_FILE_NAME];

/// What one write produced, for the summary line.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WriteReport {
    /// Number of files written into the output directory.
    pub files: usize,
    /// Total size of those files, in bytes.
    pub bytes: u64,
    /// Number of unique assets the artifact carries.
    ///
    /// `single-html` inlines them as data URIs and `html-dir` writes one file
    /// each; either way this is the number of distinct resources, not the
    /// number of placeholder occurrences: a logo used from three documents is
    /// one asset.
    pub assets: usize,
}

/// One output format's writer.
///
/// Implementations receive the whole [`SiteBuild`] rather than just the
/// [`crate::site::SiteBundle`], because the payload deliberately carries no
/// asset bytes and every writer has to address them somehow.
pub trait SiteWriter {
    /// Format this writer produces.
    fn format(&self) -> OutputFormat;

    /// Write the artifact into the already-prepared `out` directory.
    ///
    /// Directory creation and cleanup are [`write_site`]'s job, so an
    /// implementation may assume `out` exists and is empty.
    fn write(&self, build: &SiteBuild, rendered: &RenderedSite, out: &Path) -> Result<WriteReport>;
}

/// Writer for `format`.
///
/// Every [`OutputFormat`] has a writer, so this cannot fail; the signature is
/// infallible on purpose, because a `Result` here would only ever carry a
/// "not implemented yet" branch that no caller can act on.
pub fn writer_for(format: OutputFormat) -> &'static dyn SiteWriter {
    static SINGLE_HTML: SingleHtmlWriter = SingleHtmlWriter;
    static HTML_DIR: HtmlDirWriter = HtmlDirWriter;
    static MHTML: MhtmlWriter = MhtmlWriter;

    match format {
        OutputFormat::SingleHtml => &SINGLE_HTML,
        OutputFormat::HtmlDir => &HTML_DIR,
        OutputFormat::Mhtml => &MHTML,
    }
}

/// Write `rendered` into `out` in `format`.
///
/// `force` only relaxes the cleanup rule of [`prepare_output_dir`]; the guards
/// that keep the output directory away from the input tree live in
/// [`crate::options::Options::validate`].
pub fn write_site(
    format: OutputFormat,
    build: &SiteBuild,
    rendered: &RenderedSite,
    out: &Path,
    force: bool,
) -> Result<WriteReport> {
    let writer = writer_for(format);
    prepare_output_dir(out, force)?;
    writer.write(build, rendered, out)
}

/// Create `out` and make sure it is empty.
///
/// Rules, in order:
///
/// - a missing directory is created;
/// - an existing empty directory is used as it is;
/// - an existing directory that holds a [`BUILD_MARKERS`] entry is a previous
///   build and its contents are removed;
/// - any other non-empty directory is refused unless `force` is set, because
///   `--out` can point anywhere and wiping an unrelated directory is real data
///   loss;
/// - a path that exists but is not a directory is an error.
///
/// Only entries *inside* `out` are removed; the directory itself and everything
/// above it are left alone. Symbolic links are removed as links, never followed.
pub fn prepare_output_dir(out: &Path, force: bool) -> Result<()> {
    let metadata = match std::fs::metadata(out) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return std::fs::create_dir_all(out)
                .map_err(|error| io_error("create the output directory", out, error));
        }
        Err(error) => return Err(io_error("inspect the output directory", out, error)),
    };

    if !metadata.is_dir() {
        return Err(Error::InvalidInput(format!(
            "output path is not a directory: {}",
            out.display()
        )));
    }

    let entries = read_entries(out)?;
    if entries.is_empty() {
        return Ok(());
    }

    if !force && !entries.iter().any(|entry| is_build_marker(entry)) {
        return Err(Error::InvalidInput(format!(
            "output directory is not empty and does not look like a previous wikicc build: {} \
             (use --force to overwrite)",
            out.display()
        )));
    }

    for entry in entries {
        remove_entry(&entry)?;
    }

    Ok(())
}

/// Replace every asset placeholder in `html`.
///
/// `address` appends the format-specific address of one asset to the output
/// buffer, which is why it takes the destination `String` instead of returning
/// one: a single-page build can hand it a reusable encoding buffer.
///
/// The scan is a single left-to-right pass over `html`, so the cost is
/// O(page + inlined bytes) and only one output buffer is allocated. Calling
/// `String::replace` once per asset instead would copy the whole page once per
/// asset, which is the difference between ~5 MB and ~5 MB × N of peak memory.
///
/// A placeholder whose hash is truncated or absent from `assets` is an error:
/// the page then references a resource the build never registered, and shipping
/// it would publish a dead `wikicc-asset:` reference.
///
/// Returns the expanded page and the number of placeholders replaced.
pub fn expand_placeholders(
    html: &str,
    assets: &AssetTable,
    mut address: impl FnMut(&Asset, &mut String) -> Result<()>,
) -> Result<(String, usize)> {
    let mut expanded = String::with_capacity(html.len());
    let mut cursor = 0;
    let mut replacements = 0;

    for (start, _) in html.match_indices(ASSET_PLACEHOLDER_PREFIX) {
        // A previous hash can never swallow a later prefix, but slicing below
        // panics on a reversed range, so the guard keeps the invariant explicit.
        if start < cursor {
            continue;
        }

        let hash_start = start + ASSET_PLACEHOLDER_PREFIX.len();
        let hash = hash_at(html, hash_start)?;
        let asset = assets.get(hash).ok_or_else(|| {
            Error::Write(format!(
                "unknown asset placeholder '{ASSET_PLACEHOLDER_PREFIX}{hash}' in the rendered page"
            ))
        })?;

        expanded.push_str(&html[cursor..start]);
        address(asset, &mut expanded)?;
        cursor = hash_start + hash.len();
        replacements += 1;
    }

    expanded.push_str(&html[cursor..]);

    Ok((expanded, replacements))
}

/// Hash that follows a placeholder prefix, or an error when it is truncated.
///
/// The hash is exactly [`HASH_HEX_LEN`] hexadecimal characters, which is what
/// [`crate::assets::asset_hash`] produces. Anything shorter means the page was
/// assembled from a different asset naming scheme than the one in this build.
fn hash_at(html: &str, start: usize) -> Result<&str> {
    let rest = &html[start..];
    let available = rest
        .bytes()
        .take_while(u8::is_ascii_hexdigit)
        .count()
        .min(HASH_HEX_LEN);

    if available < HASH_HEX_LEN {
        let found: String = rest.chars().take(24).collect();
        return Err(Error::Write(format!(
            "malformed asset placeholder '{ASSET_PLACEHOLDER_PREFIX}{found}' in the rendered page"
        )));
    }

    Ok(&rest[..HASH_HEX_LEN])
}

/// Entries directly inside `dir`, sorted by path so removal is deterministic.
fn read_entries(dir: &Path) -> Result<Vec<PathBuf>> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| io_error("read the output directory", dir, error))?;
    let mut paths: Vec<PathBuf> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| io_error("read the output directory", dir, error))?;
        paths.push(entry.path());
    }

    paths.sort();
    Ok(paths)
}

/// Whether `path` is one of the [`BUILD_MARKERS`].
fn is_build_marker(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| BUILD_MARKERS.contains(&name))
}

/// Remove one directory entry, without following symbolic links.
fn remove_entry(path: &Path) -> Result<()> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| io_error("inspect", path, error))?;

    if metadata.is_dir() {
        std::fs::remove_dir_all(path).map_err(|error| io_error("remove", path, error))
    } else {
        std::fs::remove_file(path).map_err(|error| io_error("remove", path, error))
    }
}

/// I/O failure with the path that caused it, so the message is actionable.
fn io_error(action: &str, path: &Path, error: std::io::Error) -> Error {
    Error::Write(format!("{action} {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// Table holding `content` under the name `name`.
    fn table_with(name: &str, content: &[u8]) -> (AssetTable, String) {
        let mut table = AssetTable::new();
        let hash = table.insert_bytes(Path::new(name), content.to_vec());
        (table, hash)
    }

    /// Addresser that marks every substitution, so the pass can be observed
    /// without involving a real format.
    fn mark(asset: &Asset, out: &mut String) -> Result<()> {
        out.push_str(&format!("<{}>", asset.hash));
        Ok(())
    }

    #[test]
    fn every_placeholder_occurrence_is_replaced() {
        let (table, hash) = table_with("logo.svg", b"<svg/>");
        let html = format!("a wikicc-asset:{hash} b wikicc-asset:{hash} c", hash = hash);

        let (expanded, replacements) = expand_placeholders(&html, &table, mark).expect("expand");

        assert_eq!(expanded, format!("a <{hash}> b <{hash}> c"));
        assert_eq!(replacements, 2);
    }

    #[test]
    fn a_page_without_placeholders_is_returned_unchanged() {
        let (table, _) = table_with("logo.svg", b"<svg/>");
        let html = "<p>no assets here</p>";

        let (expanded, replacements) = expand_placeholders(html, &table, mark).expect("expand");

        assert_eq!(expanded, html);
        assert_eq!(replacements, 0);
    }

    #[test]
    fn a_placeholder_at_the_very_end_is_replaced() {
        let (table, hash) = table_with("a.png", b"png");
        let html = format!("wikicc-asset:{hash}");

        let (expanded, _) = expand_placeholders(&html, &table, mark).expect("expand");

        assert_eq!(expanded, format!("<{hash}>"));
    }

    #[test]
    fn an_unknown_hash_is_an_error() {
        let (table, _) = table_with("logo.svg", b"<svg/>");
        let html = "wikicc-asset:0000000000000000";

        let error = expand_placeholders(html, &table, mark).expect_err("unknown asset");

        assert!(
            error
                .to_string()
                .contains("unknown asset placeholder 'wikicc-asset:0000000000000000'"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn a_truncated_hash_is_an_error() {
        let (table, _) = table_with("logo.svg", b"<svg/>");

        for html in ["wikicc-asset:", "wikicc-asset:abc", "wikicc-asset:zzzz"] {
            let error = expand_placeholders(html, &table, mark).expect_err(html);
            assert!(
                error.to_string().contains("malformed asset placeholder"),
                "unexpected message for {html}: {error}"
            );
        }
    }

    #[test]
    fn a_failing_addresser_aborts_the_expansion() {
        let (table, hash) = table_with("logo.svg", b"<svg/>");
        let html = format!("wikicc-asset:{hash}");

        let error = expand_placeholders(&html, &table, |_, _| {
            Err(Error::Write("cannot encode".to_string()))
        })
        .expect_err("addresser failure");

        assert!(error.to_string().contains("cannot encode"));
    }

    #[test]
    fn the_addresser_receives_the_registered_asset() {
        let (table, hash) = table_with("logo.SVG", b"<svg/>");
        let html = format!("wikicc-asset:{hash}");

        let (_, replacements) = expand_placeholders(&html, &table, |asset, out| {
            out.push_str(&asset.mime);
            assert_eq!(asset.extension, "svg");
            Ok(())
        })
        .expect("expand");

        assert_eq!(replacements, 1);
    }

    #[test]
    fn a_missing_output_directory_is_created() {
        let dir = tempfile::tempdir().expect("temp dir");
        let out = dir.path().join("nested").join("dist");

        prepare_output_dir(&out, false).expect("prepare");

        assert!(out.is_dir());
    }

    #[test]
    fn an_empty_output_directory_is_kept() {
        let dir = tempfile::tempdir().expect("temp dir");

        prepare_output_dir(dir.path(), false).expect("prepare");

        assert_eq!(fs::read_dir(dir.path()).expect("read dir").count(), 0);
    }

    #[test]
    fn a_previous_build_is_emptied_without_force() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join(HTML_FILE_NAME), "<!DOCTYPE html>").expect("write marker");
        fs::create_dir(dir.path().join("assets")).expect("create assets");
        fs::write(dir.path().join("assets").join("a.svg"), "<svg/>").expect("write asset");

        prepare_output_dir(dir.path(), false).expect("prepare");

        assert_eq!(fs::read_dir(dir.path()).expect("read dir").count(), 0);
        assert!(dir.path().is_dir(), "the directory itself must survive");
    }

    #[test]
    fn an_mhtml_build_marker_is_recognised_too() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join(MHTML_FILE_NAME), "MIME-Version: 1.0").expect("write marker");

        prepare_output_dir(dir.path(), false).expect("prepare");

        assert_eq!(fs::read_dir(dir.path()).expect("read dir").count(), 0);
    }

    #[test]
    fn a_foreign_directory_is_refused_without_force() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("keep.txt"), "keep").expect("write file");

        let error = prepare_output_dir(dir.path(), false).expect_err("foreign directory");

        assert!(
            error.to_string().contains("use --force to overwrite"),
            "unexpected message: {error}"
        );
        assert!(
            error
                .to_string()
                .contains("does not look like a previous wikicc build"),
            "unexpected message: {error}"
        );
        assert!(
            dir.path().join("keep.txt").is_file(),
            "nothing may be removed"
        );
    }

    #[test]
    fn a_foreign_directory_is_emptied_with_force() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("keep.txt"), "keep").expect("write file");

        prepare_output_dir(dir.path(), true).expect("prepare");

        assert_eq!(fs::read_dir(dir.path()).expect("read dir").count(), 0);
    }

    #[test]
    fn an_output_path_that_is_a_file_is_rejected() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("out");
        fs::write(&file, "not a directory").expect("write file");

        let error = prepare_output_dir(&file, true).expect_err("file as output");

        assert!(
            error.to_string().contains("output path is not a directory"),
            "unexpected message: {error}"
        );
        assert!(file.is_file(), "the file must not be touched");
    }

    #[test]
    fn every_format_resolves_to_its_own_writer() {
        for format in OutputFormat::ALL {
            assert_eq!(
                writer_for(format).format(),
                format,
                "{} must resolve to the writer that declares it",
                format.as_str()
            );
        }
    }

    #[test]
    fn asset_file_names_are_the_hash_plus_the_extension() {
        let (table, hash) = table_with("Logo.SVG", b"<svg/>");
        let asset = table.get(&hash).expect("asset");

        assert_eq!(asset_file_name(asset), format!("{hash}.svg"));
    }

    #[test]
    fn asset_addresses_are_relative_to_the_page_and_use_forward_slashes() {
        let (table, hash) = table_with("logo.svg", b"<svg/>");
        let asset = table.get(&hash).expect("asset");

        let address = asset_relative_path(asset);

        assert_eq!(address, format!("assets/{hash}.svg"));
        assert!(
            !address.contains('\\'),
            "an HTML address must never carry a Windows separator: {address}"
        );
    }

    #[test]
    fn assets_without_a_usable_extension_still_get_a_name() {
        let (table, hash) = table_with("README", b"text");
        let asset = table.get(&hash).expect("asset");

        assert_eq!(asset_file_name(asset), format!("{hash}.bin"));
    }

    #[test]
    fn write_report_defaults_to_zero() {
        assert_eq!(
            WriteReport::default(),
            WriteReport {
                files: 0,
                bytes: 0,
                assets: 0
            }
        );
    }
}
