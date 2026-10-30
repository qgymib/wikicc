//! Content-addressed registry for local resources referenced from documents.
//!
//! This is the asset half of the `resolve` stage in `docs/DESIGN.md`. Every
//! relative path that is not a Markdown document (images, audio, video, fonts,
//! PDFs, …) is read once, hashed with SHA-256 and stored in an [`AssetTable`].
//!
//! Naming rules that keep builds reproducible:
//!
//! - the asset name is the first 16 hexadecimal characters of the SHA-256
//!   digest, so identical content always gets the same name and duplicates
//!   collapse into a single entry;
//! - the table is a [`BTreeMap`] keyed by that hash, so iteration order is the
//!   hash order and never depends on discovery order;
//! - a second index caches `path -> hash`, so a file referenced from several
//!   documents is read from disk exactly once.
//!
//! The rendered HTML never carries the final address: it carries the opaque
//! placeholder [`ASSET_PLACEHOLDER_PREFIX`]`<hash>`, which the writers replace
//! with a `data:` URI, an `assets/<hash>.<ext>` path or a `cid:<hash>`
//! reference.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Prefix of the opaque placeholder left in the rendered HTML.
pub const ASSET_PLACEHOLDER_PREFIX: &str = "wikicc-asset:";

/// Number of hexadecimal characters kept from the SHA-256 digest.
pub const HASH_HEX_LEN: usize = 16;

/// Extension used when a path has no usable extension.
pub const FALLBACK_EXTENSION: &str = "bin";

/// MIME type used when neither the fallback table nor `mime_guess` knows the
/// extension.
pub const FALLBACK_MIME: &str = "application/octet-stream";

/// Explicit MIME overrides consulted before `mime_guess`.
///
/// `mime_guess` already knows most of these, but the table is what pins the
/// values that matter for a self-contained reader (fonts and vector images
/// must be served with an exact type for `data:` URIs to work in every
/// browser), and it keeps the mapping stable across `mime_guess` upgrades.
pub const MIME_FALLBACKS: &[(&str, &str)] = &[
    ("svg", "image/svg+xml"),
    ("svgz", "image/svg+xml"),
    ("woff2", "font/woff2"),
    ("woff", "font/woff"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("eot", "application/vnd.ms-fontobject"),
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("ogg", "audio/ogg"),
    ("wav", "audio/wav"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("ico", "image/x-icon"),
    ("pdf", "application/pdf"),
    ("md", "text/markdown"),
    ("markdown", "text/markdown"),
    ("txt", "text/plain"),
    ("csv", "text/csv"),
    ("json", "application/json"),
    ("wasm", "application/wasm"),
];

/// One resource read from disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    /// First [`HASH_HEX_LEN`] characters of the SHA-256 digest, lowercase hex.
    pub hash: String,
    /// MIME type reported to the writers.
    pub mime: String,
    /// Lowercase extension without the dot, sanitised to `[a-z0-9]+`.
    pub extension: String,
    /// Verbatim file content.
    pub bytes: Vec<u8>,
}

impl Asset {
    /// Placeholder left in the HTML for this asset.
    pub fn placeholder(&self) -> String {
        format!("{ASSET_PLACEHOLDER_PREFIX}{}", self.hash)
    }

    /// Size of the asset in bytes.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Whether the asset is empty.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// Assets collected for one site, deduplicated by content.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssetTable {
    /// Assets keyed by content hash, in hash order.
    by_hash: BTreeMap<String, Asset>,
    /// Cache from the resolved on-disk path to the content hash.
    by_path: BTreeMap<PathBuf, String>,
}

impl AssetTable {
    /// Empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of unique assets.
    pub fn len(&self) -> usize {
        self.by_hash.len()
    }

    /// Whether no asset has been registered yet.
    pub fn is_empty(&self) -> bool {
        self.by_hash.is_empty()
    }

    /// Asset with the given content hash.
    pub fn get(&self, hash: &str) -> Option<&Asset> {
        self.by_hash.get(hash)
    }

    /// Assets in hash order, which makes writer output deterministic.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Asset)> {
        self.by_hash
            .iter()
            .map(|(hash, asset)| (hash.as_str(), asset))
    }

    /// Total size of all unique assets, in bytes.
    pub fn total_bytes(&self) -> u64 {
        self.by_hash
            .values()
            .map(|asset| asset.bytes.len() as u64)
            .sum()
    }

    /// Read `path` and register it, returning its content hash.
    ///
    /// A path that was registered before is served from the cache, so a file
    /// referenced from several documents is read from disk only once.
    pub fn insert_file(&mut self, path: &Path) -> std::io::Result<String> {
        if let Some(hash) = self.by_path.get(path) {
            return Ok(hash.clone());
        }

        let bytes = std::fs::read(path)?;
        Ok(self.insert_bytes(path, bytes))
    }

    /// Register already-read content, returning its content hash.
    ///
    /// `path` only supplies the extension and MIME type; the content decides
    /// the identity of the asset.
    pub fn insert_bytes(&mut self, path: &Path, bytes: Vec<u8>) -> String {
        let hash = asset_hash(&bytes);
        self.by_path.insert(path.to_path_buf(), hash.clone());

        let asset = Asset {
            hash: hash.clone(),
            mime: mime_for(path),
            extension: asset_extension(path),
            bytes,
        };
        self.by_hash.entry(hash.clone()).or_insert(asset);

        hash
    }
}

/// Content address of `bytes`: the first [`HASH_HEX_LEN`] hex characters of the
/// SHA-256 digest.
pub fn asset_hash(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let digest = Sha256::digest(bytes);
    let mut hash = String::with_capacity(HASH_HEX_LEN);

    for byte in digest.iter().take(HASH_HEX_LEN / 2) {
        // Writing into a `String` cannot fail.
        let _ = write!(hash, "{byte:02x}");
    }

    hash
}

/// MIME type for `path`: the explicit [`MIME_FALLBACKS`] entry first, then
/// `mime_guess`, then [`FALLBACK_MIME`].
pub fn mime_for(path: &Path) -> String {
    let extension = asset_extension(path);

    if let Some((_, mime)) = MIME_FALLBACKS.iter().find(|(known, _)| *known == extension) {
        return (*mime).to_string();
    }

    mime_guess::from_ext(&extension)
        .first()
        .map(|mime| mime.to_string())
        .unwrap_or_else(|| FALLBACK_MIME.to_string())
}

/// Extension used for asset names: lowercase, `[a-z0-9]+` only, or
/// [`FALLBACK_EXTENSION`] when nothing usable remains.
pub fn asset_extension(path: &Path) -> String {
    let raw = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect();

    if cleaned.is_empty() {
        FALLBACK_EXTENSION.to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(&path, contents).expect("write fixture file");
        path
    }

    #[test]
    fn hash_is_sixteen_lowercase_hex_characters() {
        let hash = asset_hash(b"hello");

        assert_eq!(hash.len(), HASH_HEX_LEN);
        assert!(
            hash.chars()
                .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character)),
            "hash: {hash}"
        );
    }

    #[test]
    fn hash_is_stable_and_content_sensitive() {
        assert_eq!(asset_hash(b"hello"), asset_hash(b"hello"));
        assert_ne!(asset_hash(b"hello"), asset_hash(b"hello "));
        assert_eq!(
            asset_hash(b"hello"),
            // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e…
            "2cf24dba5fb0a30e"
        );
    }

    #[test]
    fn empty_content_still_hashes() {
        assert_eq!(asset_hash(b"").len(), HASH_HEX_LEN);
    }

    #[test]
    fn identical_content_is_stored_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        let first = write(dir.path(), "a/logo.svg", b"<svg/>");
        let second = write(dir.path(), "b/copy.svg", b"<svg/>");
        let mut table = AssetTable::new();

        let first_hash = table.insert_file(&first).expect("read first");
        let second_hash = table.insert_file(&second).expect("read second");

        assert_eq!(first_hash, second_hash);
        assert_eq!(table.len(), 1);
        assert_eq!(table.total_bytes(), 6);
    }

    #[test]
    fn different_content_is_stored_separately() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();

        table
            .insert_file(&write(dir.path(), "a.svg", b"<svg>a</svg>"))
            .expect("read first");
        table
            .insert_file(&write(dir.path(), "b.svg", b"<svg>b</svg>"))
            .expect("read second");

        assert_eq!(table.len(), 2);
    }

    #[test]
    fn a_path_is_read_from_disk_only_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write(dir.path(), "logo.svg", b"<svg/>");
        let mut table = AssetTable::new();

        let first = table.insert_file(&path).expect("read once");
        fs::remove_file(&path).expect("remove fixture");
        let second = table.insert_file(&path).expect("served from cache");

        assert_eq!(first, second);
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn missing_files_are_reported_as_io_errors() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();

        let error = table
            .insert_file(&dir.path().join("nope.png"))
            .expect_err("missing file");

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert!(table.is_empty());
    }

    #[test]
    fn directories_are_reported_as_io_errors() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();

        assert!(table.insert_file(dir.path()).is_err());
        assert!(table.is_empty());
    }

    #[test]
    fn known_extensions_use_the_explicit_fallback_table() {
        assert_eq!(mime_for(Path::new("logo.svg")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("font.woff2")), "font/woff2");
        assert_eq!(mime_for(Path::new("font.woff")), "font/woff");
        assert_eq!(mime_for(Path::new("sound.mp3")), "audio/mpeg");
        assert_eq!(mime_for(Path::new("movie.webm")), "video/webm");
        assert_eq!(mime_for(Path::new("notes.pdf")), "application/pdf");
    }

    #[test]
    fn fallback_table_lookup_is_case_insensitive() {
        assert_eq!(mime_for(Path::new("LOGO.SVG")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("font.WOFF2")), "font/woff2");
    }

    #[test]
    fn unknown_extensions_delegate_to_mime_guess_then_octet_stream() {
        assert_eq!(mime_for(Path::new("photo.png")), "image/png");
        assert_eq!(mime_for(Path::new("photo.jpeg")), "image/jpeg");
        assert_eq!(mime_for(Path::new("data.qqq")), FALLBACK_MIME);
        assert_eq!(mime_for(Path::new("README")), FALLBACK_MIME);
    }

    #[test]
    fn extension_is_lowercased_and_sanitised() {
        assert_eq!(asset_extension(Path::new("a.PNG")), "png");
        assert_eq!(asset_extension(Path::new("a.tar.gz")), "gz");
        assert_eq!(asset_extension(Path::new("a.p n g")), "png");
        assert_eq!(asset_extension(Path::new("a.")), FALLBACK_EXTENSION);
        assert_eq!(
            asset_extension(Path::new("no-extension")),
            FALLBACK_EXTENSION
        );
        assert_eq!(asset_extension(Path::new("a.数据")), FALLBACK_EXTENSION);
    }

    #[test]
    fn assets_keep_hash_mime_extension_and_bytes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write(dir.path(), "logo.SVG", b"<svg/>");
        let mut table = AssetTable::new();

        let hash = table.insert_file(&path).expect("read asset");
        let asset = table.get(&hash).expect("asset is registered");

        assert_eq!(asset.hash, hash);
        assert_eq!(asset.mime, "image/svg+xml");
        assert_eq!(asset.extension, "svg");
        assert_eq!(asset.bytes, b"<svg/>");
        assert_eq!(asset.len(), 6);
        assert!(!asset.is_empty());
        assert_eq!(asset.placeholder(), format!("wikicc-asset:{hash}"));
    }

    #[test]
    fn iteration_follows_hash_order() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();
        table
            .insert_file(&write(dir.path(), "a.svg", b"<svg>a</svg>"))
            .expect("read a");
        table
            .insert_file(&write(dir.path(), "b.svg", b"<svg>b</svg>"))
            .expect("read b");

        let hashes: Vec<&str> = table.iter().map(|(hash, _)| hash).collect();
        let mut sorted = hashes.clone();
        sorted.sort_unstable();

        assert_eq!(hashes, sorted);
    }

    #[test]
    fn registering_the_same_bytes_twice_keeps_the_first_asset() {
        let mut table = AssetTable::new();

        let first = table.insert_bytes(Path::new("logo.svg"), b"<svg/>".to_vec());
        let second = table.insert_bytes(Path::new("copy.png"), b"<svg/>".to_vec());

        assert_eq!(first, second);
        assert_eq!(table.len(), 1);
        assert_eq!(
            table.get(&first).expect("asset").mime,
            "image/svg+xml",
            "the first reference decides the MIME type"
        );
    }
}
