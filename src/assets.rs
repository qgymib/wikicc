//! Content-addressed registry for local resources referenced from documents.
//!
//! This is the asset half of the `resolve` stage in `docs/design.md`. Every
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
//! with a `data:` URI or an `assets/<hash>.<ext>` path.
//!
//! MIME and the on-disk extension follow the same determinism rule as the
//! name: the file name decides when it identifies a type, and otherwise the
//! content does. When a path carries no extension, or one that neither the
//! explicit table nor `mime_guess` knows, the head of the file (at most
//! [`SNIFF_WINDOW_BYTES`]) is sniffed as UTF-8 text — so an extensionless
//! `LICENSE` becomes `text/plain` and opens inline instead of downloading as
//! `application/octet-stream`, and its disk name becomes `<hash>.txt`, the
//! extension static servers and `file://` map back to the sniffed MIME.

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

/// Window of the file head the content sniff inspects.
///
/// Only the first [`SNIFF_WINDOW_BYTES`] bytes of an asset the name cannot
/// type are ever read, so the sniff costs the same for a licence text and
/// for a multi-gigabyte extensionless blob. Text that matters — a licence,
/// a Makefile, a README — is far smaller than the window; the window is a
/// cost bound, not a correctness claim.
pub const SNIFF_WINDOW_BYTES: usize = 8 * 1024;

/// Explicit MIME overrides consulted before `mime_guess`.
///
/// `mime_guess` already knows most of these, but the table is what pins the
/// values that matter for a self-contained reader (fonts and vector images
/// must be served with an exact type for `data:` URIs to work in every
/// browser), and it keeps the mapping stable across `mime_guess` upgrades.
/// `bin` is pinned too, so the synthetic fallback extension and real `.bin`
/// files never reach the content sniff of [`asset_mime_and_extension`].
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
    ("bin", FALLBACK_MIME),
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
    /// `path` names the asset: when the name identifies a type it decides the
    /// MIME type and the disk extension, and when it does not the content is
    /// sniffed instead — see [`asset_mime_and_extension`]. The content alone
    /// decides the identity of the asset.
    pub fn insert_bytes(&mut self, path: &Path, bytes: Vec<u8>) -> String {
        let hash = asset_hash(&bytes);
        self.by_path.insert(path.to_path_buf(), hash.clone());

        let (mime, extension) = asset_mime_and_extension(path, &bytes);
        let asset = Asset {
            hash: hash.clone(),
            mime,
            extension,
            bytes,
        };
        self.by_hash.entry(hash.clone()).or_insert(asset);

        hash
    }

    /// Keep only the assets `keep` accepts, dropping the rest.
    ///
    /// The caller owns the reference policy — the sealing pass keeps what
    /// public documents and the favicon still address — and the table never
    /// decides. A path cache entry that pointed at a dropped hash is removed
    /// with it, so both indexes keep describing the same set of assets and a
    /// re-registered path is read from disk instead of resurrecting a dropped
    /// asset.
    pub fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.by_hash.retain(|hash, _| keep(hash));
        self.by_path
            .retain(|_, hash| self.by_hash.contains_key(hash));
    }

    /// Fold the entries of `other` into this table, keeping what is here.
    ///
    /// The parallel assembly gives every document its own table; this runs
    /// after the collection, in document order, so the entries the first
    /// document registered win. A file two documents referenced is read
    /// twice in parallel and collapses here into one entry by content hash,
    /// and the first registration also wins when a file changed between the
    /// two reads, which keeps the build deterministic whatever the threads
    /// saw.
    pub fn merge(&mut self, other: AssetTable) {
        for (path, hash) in other.by_path {
            self.by_path.entry(path).or_insert(hash);
        }
        for (hash, asset) in other.by_hash {
            self.by_hash.entry(hash).or_insert(asset);
        }
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
///
/// This is a name-only lookup: it cannot see the bytes, so a file the name
/// cannot type stays [`FALLBACK_MIME`]. Registration goes through
/// [`asset_mime_and_extension`], which asks the content when the name says
/// nothing.
pub fn mime_for(path: &Path) -> String {
    named_mime(path).unwrap_or_else(|| FALLBACK_MIME.to_string())
}

/// MIME type and disk file name extension for a new asset, decided once per
/// registration.
///
/// A name that identifies a type wins unchanged: the MIME comes from
/// [`MIME_FALLBACKS`] or `mime_guess` and the extension is the sanitised
/// spelling of the file name. When the name says nothing — no extension, or
/// one nobody knows — the content decides ([`sniffed_mime`]) and the disk
/// extension follows the MIME ([`extension_for_mime`]), so an extensionless
/// text file is stored as `<hash>.txt` and served as `text/plain` instead of
/// downloading as an opaque `.bin`.
pub fn asset_mime_and_extension(path: &Path, bytes: &[u8]) -> (String, String) {
    match named_mime(path) {
        Some(mime) => (mime, asset_extension(path)),
        None => {
            let mime = sniffed_mime(bytes);
            let extension = extension_for_mime(&mime);
            (mime, extension)
        }
    }
}

/// The MIME type the file name itself identifies: the explicit
/// [`MIME_FALLBACKS`] entry first, then `mime_guess`. `None` when the path
/// has no extension, or one nobody knows — the case where the content is
/// asked instead.
fn named_mime(path: &Path) -> Option<String> {
    let extension = named_extension(path)?;

    if let Some((_, mime)) = MIME_FALLBACKS.iter().find(|(known, _)| *known == extension) {
        return Some((*mime).to_string());
    }

    mime_guess::from_ext(&extension)
        .first()
        .map(|mime| mime.to_string())
}

/// Content sniff for an asset the name cannot type: valid UTF-8 without a
/// NUL byte in the head window is `text/plain`, anything else stays
/// [`FALLBACK_MIME`].
///
/// Only the first [`SNIFF_WINDOW_BYTES`] bytes are inspected, so the cost
/// does not grow with the file. When the window cuts the stream short, its
/// end is pulled back to a UTF-8 character boundary first — a multi-byte
/// sequence split by the artificial cut is not evidence of binary data. A
/// file that ends mid-sequence on its own is invalid UTF-8 and is judged as
/// it is.
fn sniffed_mime(bytes: &[u8]) -> String {
    let mut end = bytes.len().min(SNIFF_WINDOW_BYTES);
    if end < bytes.len() {
        // A UTF-8 continuation byte (10xxxxxx) marks a position inside a
        // multi-byte sequence; walk back to the start of the sequence so the
        // artificial cut cannot split one.
        while end > 0 && bytes[end] & 0xC0 == 0x80 {
            end -= 1;
        }
    }
    let window = &bytes[..end];

    if !window.contains(&0) && std::str::from_utf8(window).is_ok() {
        "text/plain".to_string()
    } else {
        FALLBACK_MIME.to_string()
    }
}

/// Disk extension for an asset the name could not type: the spelling that
/// static servers and `file://` map back to the MIME, or
/// [`FALLBACK_EXTENSION`] when the MIME has no obvious one.
fn extension_for_mime(mime: &str) -> String {
    if mime == "text/plain" {
        "txt".to_string()
    } else {
        FALLBACK_EXTENSION.to_string()
    }
}

/// Extension used for asset names: lowercase, `[a-z0-9]+` only, or
/// [`FALLBACK_EXTENSION`] when nothing usable remains.
pub fn asset_extension(path: &Path) -> String {
    named_extension(path).unwrap_or_else(|| FALLBACK_EXTENSION.to_string())
}

/// The file name extension of `path` as the name itself spells it, or `None`
/// when there is nothing usable to spell.
///
/// Unlike [`asset_extension`] this never substitutes the synthetic `bin`
/// fallback: a path without an extension answers `None`, which is what lets
/// [`asset_mime_and_extension`] tell "the name names a type" apart from "the
/// name says nothing" — the synthetic `bin` must not silence the sniff.
fn named_extension(path: &Path) -> Option<String> {
    let raw = path.extension().and_then(|extension| extension.to_str())?;
    let cleaned: String = raw
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect();

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
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
    fn a_name_only_lookup_never_sniffs_the_content() {
        assert_eq!(mime_for(Path::new("LICENSE")), FALLBACK_MIME);
        assert_eq!(mime_for(Path::new(".gitignore")), FALLBACK_MIME);
        assert_eq!(mime_for(Path::new("data.qqq")), FALLBACK_MIME);
    }

    #[test]
    fn extensionless_text_content_sniffs_as_plain_text() {
        let mut table = AssetTable::new();

        let hash = table.insert_bytes(
            Path::new("LICENSE"),
            b"GPL-3.0-only <https://spdx.org/licenses/GPL-3.0-only>".to_vec(),
        );

        let asset = table.get(&hash).expect("asset is registered");
        assert_eq!(asset.mime, "text/plain");
        assert_eq!(asset.extension, "txt");
    }

    #[test]
    fn extensionless_binary_content_stays_octet_stream() {
        let mut table = AssetTable::new();

        let hash = table.insert_bytes(Path::new("payload"), [0u8, 159, 146, 150].to_vec());

        let asset = table.get(&hash).expect("asset is registered");
        assert_eq!(asset.mime, FALLBACK_MIME);
        assert_eq!(asset.extension, FALLBACK_EXTENSION);
    }

    #[test]
    fn unknown_extensions_sniff_the_content_too() {
        let mut table = AssetTable::new();

        let text = table.insert_bytes(Path::new("notes.qqq"), b"plain notes".to_vec());
        let binary = table.insert_bytes(Path::new("blob.qqq"), [0u8, 1, 2].to_vec());

        let text_asset = table.get(&text).expect("text asset");
        assert_eq!(text_asset.mime, "text/plain");
        assert_eq!(text_asset.extension, "txt");
        let binary_asset = table.get(&binary).expect("binary asset");
        assert_eq!(binary_asset.mime, FALLBACK_MIME);
        assert_eq!(binary_asset.extension, FALLBACK_EXTENSION);
    }

    #[test]
    fn known_extensions_are_never_overridden_by_the_content() {
        let mut table = AssetTable::new();

        let png = table.insert_bytes(Path::new("photo.png"), b"this is really text".to_vec());
        let bin = table.insert_bytes(Path::new("payload.bin"), b"also text".to_vec());

        let png_asset = table.get(&png).expect("png asset");
        assert_eq!(png_asset.mime, "image/png");
        assert_eq!(png_asset.extension, "png");
        let bin_asset = table.get(&bin).expect("bin asset");
        assert_eq!(bin_asset.mime, FALLBACK_MIME);
        assert_eq!(bin_asset.extension, FALLBACK_EXTENSION);
    }

    #[test]
    fn dotfiles_sniff_as_text() {
        let mut table = AssetTable::new();

        let hash = table.insert_bytes(Path::new(".gitignore"), b"target/\n".to_vec());

        let asset = table.get(&hash).expect("asset is registered");
        assert_eq!(asset.mime, "text/plain");
        assert_eq!(asset.extension, "txt");
    }

    #[test]
    fn the_sniff_window_bounds_the_inspection() {
        let mut text_head = vec![b'a'; SNIFF_WINDOW_BYTES];
        text_head.extend_from_slice(&[0, 1, 2, 3]);
        let mut binary_head = vec![0u8; SNIFF_WINDOW_BYTES];
        binary_head.extend_from_slice(b"the tail is text");

        assert_eq!(sniffed_mime(&text_head), "text/plain");
        assert_eq!(sniffed_mime(&binary_head), FALLBACK_MIME);
    }

    #[test]
    fn a_window_cut_through_a_multibyte_sequence_is_not_binary() {
        let mut head = vec![b'a'; SNIFF_WINDOW_BYTES - 1];
        // 3 bytes of a multi-byte character straddling the window cut.
        head.extend_from_slice("汉".as_bytes());

        assert_eq!(sniffed_mime(&head), "text/plain");
    }

    #[test]
    fn an_invalid_utf8_file_is_judged_as_it_is() {
        assert_eq!(sniffed_mime(b"abc\xE4"), FALLBACK_MIME);
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

    #[test]
    fn retain_keeps_the_accepted_assets_and_drops_the_rest() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();
        let first = table
            .insert_file(&write(dir.path(), "a.svg", b"<svg>a</svg>"))
            .expect("read a");
        let second = table
            .insert_file(&write(dir.path(), "b.svg", b"<svg>b</svg>"))
            .expect("read b");

        table.retain(|hash| hash == first.as_str());

        assert_eq!(table.len(), 1);
        assert_eq!(table.get(&second), None, "the unaccepted asset is gone");
        assert_eq!(table.get(&first).expect("kept").bytes, b"<svg>a</svg>");
        assert_eq!(table.total_bytes(), 12);
    }

    #[test]
    fn retain_drops_the_path_cache_entries_of_the_dropped_hashes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write(dir.path(), "b.svg", b"<svg>b</svg>");
        let mut table = AssetTable::new();
        let kept = table
            .insert_file(&write(dir.path(), "a.svg", b"<svg>a</svg>"))
            .expect("read a");
        let dropped = table.insert_file(&path).expect("read b");

        table.retain(|hash| hash == kept.as_str());

        // A stale path cache entry would resurrect the dropped asset without
        // ever reading the file again.
        let again = table.insert_file(&path).expect("re-read b");

        assert_eq!(again, dropped, "the same content is the same asset");
        assert_eq!(table.len(), 2, "the dropped asset was re-read from disk");
        assert_eq!(table.get(&dropped).expect("asset").bytes, b"<svg>b</svg>");
    }

    #[test]
    fn retain_keeping_everything_changes_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();
        table
            .insert_file(&write(dir.path(), "a.svg", b"<svg>a</svg>"))
            .expect("read a");
        table
            .insert_file(&write(dir.path(), "b/copy.svg", b"<svg>b</svg>"))
            .expect("read b");

        let bytes = table.total_bytes();
        table.retain(|_| true);

        assert_eq!(table.len(), 2);
        assert_eq!(table.total_bytes(), bytes);
    }

    #[test]
    fn merging_folds_in_the_entries_the_table_lacks() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();
        table
            .insert_file(&write(dir.path(), "a.svg", b"<svg>a</svg>"))
            .expect("read a");

        let mut other = AssetTable::new();
        other
            .insert_file(&write(dir.path(), "b.svg", b"<svg>b</svg>"))
            .expect("read b");

        table.merge(other);

        assert_eq!(table.len(), 2, "both entries survive");
    }

    #[test]
    fn merging_collapses_content_deduplicates_across_tables() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();
        table
            .insert_file(&write(dir.path(), "one/logo.svg", b"<svg/>"))
            .expect("read one");

        let mut other = AssetTable::new();
        other
            .insert_file(&write(dir.path(), "two/logo.svg", b"<svg/>"))
            .expect("read two");

        table.merge(other);

        assert_eq!(table.len(), 1, "identical content is one asset");
    }

    #[test]
    fn merging_keeps_the_first_registration_of_a_shared_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write(dir.path(), "logo.svg", b"<svg>first</svg>");
        let mut table = AssetTable::new();
        table.insert_file(&path).expect("read once");

        // The same path re-registered into a fresh table — the shape the
        // parallel assembly produces when two documents reference one file.
        let mut other = AssetTable::new();
        other.insert_file(&path).expect("read twice");

        table.merge(other);

        assert_eq!(table.len(), 1);
    }

    #[test]
    fn merging_an_empty_table_changes_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut table = AssetTable::new();
        table
            .insert_file(&write(dir.path(), "a.svg", b"<svg>a</svg>"))
            .expect("read a");
        let before = table.clone();

        table.merge(AssetTable::new());

        assert_eq!(table, before);
    }
}
