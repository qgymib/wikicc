//! Link classification, path resolution and rewriting.
//!
//! This is the link half of the `resolve` stage in `docs/DESIGN.md`. Every
//! destination that appears in a document is classified syntactically by
//! [`classify`], then turned into its final addressing form by a
//! [`LinkResolver`]:
//!
//! | Class | Rewritten to | On failure |
//! | --- | --- | --- |
//! | [`LinkClass::External`] | unchanged | — |
//! | [`LinkClass::Anchor`] | unchanged | — |
//! | [`LinkClass::InternalDoc`] | `#/doc/<percent-encoded id>[#<anchor>]` | warning, unchanged |
//! | [`LinkClass::LocalAsset`] | `wikicc-asset:<hash>` | warning, unchanged |
//! | [`LinkClass::Missing`] | unchanged | warning |
//!
//! Rewriting happens on `pulldown-cmark` events (see
//! [`crate::markdown::render_document_with`]), never on serialised HTML, so
//! attribute quoting and nesting cannot be corrupted.
//!
//! Paths are resolved lexically: `%XX` escapes are decoded, `\` is accepted as
//! a separator, and `.`/`..` segments are collapsed without touching the
//! filesystem. A path that would leave the input root is reported and skipped,
//! which keeps a document from addressing files outside the compiled folder.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::assets::{ASSET_PLACEHOLDER_PREFIX, AssetTable};
use crate::markdown::LinkRewriter;
use crate::scan::Diagnostic;

/// Prefix of the hash route that addresses one document.
pub const ROUTE_PREFIX: &str = "#/doc/";

/// Why a destination cannot be resolved inside the site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MissingReason {
    /// The target is a root-absolute path, so it cannot be addressed relative
    /// to the input directory.
    NotRelative,
    /// The target leaves the input directory through `..` segments.
    EscapesRoot,
    /// The target names a Markdown document that was not scanned.
    UnknownDocument,
    /// The target names a file that does not exist.
    UnknownAsset,
    /// The target exists but could not be read.
    UnreadableAsset,
}

/// Syntactic class of one destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkClass {
    /// `http://`, `https://`, `mailto:`, `tel:`, `//host` and any other URI
    /// scheme; left exactly as the author wrote it.
    External,
    /// `#fragment`, including the empty destination; left unchanged.
    Anchor,
    /// Relative path to a Markdown document, with an optional anchor.
    InternalDoc {
        /// Decoded, `/`-separated path as written in the document.
        path: String,
        /// Decoded fragment without the leading `#`, when present.
        anchor: Option<String>,
    },
    /// Any other relative path: images, audio, video, fonts, PDFs, …
    LocalAsset {
        /// Decoded, `/`-separated path as written in the document.
        path: String,
    },
    /// A destination that can never resolve inside the site.
    Missing {
        /// Why the destination was rejected.
        reason: MissingReason,
    },
}

/// Classify one destination without touching the filesystem.
///
/// The document's own directory is not known here, so `..` escapes are
/// detected later by [`join_relative`]; everything else is decided purely from
/// the destination text.
pub fn classify(destination: &str) -> LinkClass {
    let destination = destination.trim();

    if destination.is_empty() || destination.starts_with('#') {
        return LinkClass::Anchor;
    }
    if destination.starts_with("//") {
        return LinkClass::External;
    }
    if let Some(colon) = scheme_end(destination) {
        // `C:\notes\x.png` is a Windows path, not a one-letter URI scheme.
        let rest = &destination[colon + 1..];
        if colon == 1 && (rest.starts_with('/') || rest.starts_with('\\')) {
            return LinkClass::Missing {
                reason: MissingReason::NotRelative,
            };
        }
        return LinkClass::External;
    }
    if destination.starts_with('/') || destination.starts_with('\\') {
        return LinkClass::Missing {
            reason: MissingReason::NotRelative,
        };
    }

    let (before_fragment, fragment) = split_once(destination, '#');
    let (path, _query) = split_once(before_fragment, '?');
    let path = percent_decode(path).replace('\\', "/");

    if path.is_empty() {
        // `?query` and `#fragment` are addressed in place, not as a file.
        return LinkClass::Anchor;
    }

    if crate::scan::is_markdown_path(Path::new(&path)) {
        return LinkClass::InternalDoc {
            path,
            anchor: fragment
                .filter(|fragment| !fragment.is_empty())
                .map(percent_decode),
        };
    }

    LinkClass::LocalAsset { path }
}

/// Decode `%XX` escapes; invalid escapes and non-UTF-8 results are kept
/// verbatim so a malformed target still names a file instead of vanishing.
pub fn percent_decode(input: &str) -> String {
    if !input.contains('%') {
        return input.to_string();
    }

    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            decoded.push(high << 4 | low);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).unwrap_or_else(|_| input.to_string())
}

/// Percent-encode a document id or anchor for the hash route.
///
/// The RFC 3986 `pchar` set is kept verbatim — including `/`, so folder
/// structure stays readable — and every other byte is escaped, with non-ASCII
/// characters encoded as UTF-8. The front end must therefore decode the route
/// with `decodeURIComponent` before looking the document up.
pub fn encode_route(value: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || ROUTE_SAFE.contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            // Writing into a `String` cannot fail.
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// Resolve `path` against `base_dir`, both `/`-separated and relative to the
/// input root.
///
/// Returns `None` when the result would leave the root (a `..` segment with no
/// directory left to pop) or when nothing remains.
pub fn join_relative(base_dir: &str, path: &str) -> Option<String> {
    let mut segments: Vec<&str> = base_dir
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();

    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            name => segments.push(name),
        }
    }

    if segments.is_empty() {
        None
    } else {
        Some(segments.join("/"))
    }
}

/// Directory part of a document id (`""` for documents at the root).
pub fn doc_dir(doc_id: &str) -> &str {
    match doc_id.rfind('/') {
        Some(index) => &doc_id[..index],
        None => "",
    }
}

/// Site-wide state shared by the per-document resolvers.
#[derive(Debug, Clone)]
pub struct LinkContext {
    root: PathBuf,
    docs: BTreeSet<String>,
    assets: AssetTable,
    diagnostics: Vec<Diagnostic>,
}

impl LinkContext {
    /// Context for a site rooted at `root` whose documents are `docs`.
    pub fn new(root: impl Into<PathBuf>, docs: impl IntoIterator<Item = String>) -> Self {
        Self {
            root: root.into(),
            docs: docs.into_iter().collect(),
            assets: AssetTable::new(),
            diagnostics: Vec::new(),
        }
    }

    /// Input directory every relative path is resolved against.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Document ids known to the site.
    pub fn docs(&self) -> &BTreeSet<String> {
        &self.docs
    }

    /// Assets registered so far.
    pub fn assets(&self) -> &AssetTable {
        &self.assets
    }

    /// Diagnostics collected so far, in document order.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// Consume the context, returning the assets and the diagnostics.
    pub fn into_parts(self) -> (AssetTable, Vec<Diagnostic>) {
        (self.assets, self.diagnostics)
    }

    /// Resolver for one document, to be handed to
    /// [`crate::markdown::render_document_with`].
    pub fn for_doc(&mut self, doc_id: &str) -> LinkResolver<'_> {
        LinkResolver {
            root: &self.root,
            docs: &self.docs,
            assets: &mut self.assets,
            diagnostics: &mut self.diagnostics,
            doc_id: doc_id.to_string(),
            targets: Vec::new(),
        }
    }
}

/// Rewrites the destinations of one document.
///
/// Borrows the shared [`LinkContext`] mutably, so one document is resolved at
/// a time; the borrow ends when the resolver is dropped.
#[derive(Debug)]
pub struct LinkResolver<'a> {
    root: &'a Path,
    docs: &'a BTreeSet<String>,
    assets: &'a mut AssetTable,
    diagnostics: &'a mut Vec<Diagnostic>,
    doc_id: String,
    /// Document ids this document links to successfully, in resolution order.
    ///
    /// This is the raw material of the site's link graph: the assembly stage
    /// deduplicates it, drops self-loops and sorts it, so no edge semantics
    /// live here.
    targets: Vec<String>,
}

impl LinkResolver<'_> {
    /// Final addressing form of `destination`, reporting anything that cannot
    /// be resolved as a warning while leaving the destination untouched.
    pub fn resolve(&mut self, destination: &str, line: usize) -> String {
        match classify(destination) {
            LinkClass::External | LinkClass::Anchor => destination.to_string(),
            LinkClass::InternalDoc { path, anchor } => {
                self.resolve_doc(destination, line, &path, anchor.as_deref())
            }
            LinkClass::LocalAsset { path } => self.resolve_asset(destination, line, &path),
            LinkClass::Missing { reason } => {
                self.report(line, missing_message(reason, destination));
                destination.to_string()
            }
        }
    }

    /// Document ids this resolver linked to successfully, in resolution order.
    ///
    /// Only targets that exist inside the site are recorded: external links,
    /// in-page anchors, escaping paths and unknown documents never appear, so
    /// the link graph cannot contain edges to nothing.
    pub fn targets(&self) -> &[String] {
        &self.targets
    }

    /// Take the recorded targets, leaving the resolver empty.
    pub fn take_targets(&mut self) -> Vec<String> {
        std::mem::take(&mut self.targets)
    }

    fn resolve_doc(
        &mut self,
        destination: &str,
        line: usize,
        path: &str,
        anchor: Option<&str>,
    ) -> String {
        let Some(id) = join_relative(doc_dir(&self.doc_id), path) else {
            self.report(
                line,
                missing_message(MissingReason::EscapesRoot, destination),
            );
            return destination.to_string();
        };

        if !self.docs.contains(&id) {
            self.report(
                line,
                missing_message(MissingReason::UnknownDocument, destination),
            );
            return destination.to_string();
        }

        self.targets.push(id.clone());
        let mut route = format!("{ROUTE_PREFIX}{}", encode_route(&id));
        if let Some(anchor) = anchor.filter(|anchor| !anchor.is_empty()) {
            route.push('#');
            route.push_str(&encode_route(anchor));
        }
        route
    }

    fn resolve_asset(&mut self, destination: &str, line: usize, path: &str) -> String {
        let Some(relative) = join_relative(doc_dir(&self.doc_id), path) else {
            self.report(
                line,
                missing_message(MissingReason::EscapesRoot, destination),
            );
            return destination.to_string();
        };

        // `relative` is root-relative and free of `..`, so the joined path
        // stays inside the input directory.
        let absolute = self.root.join(relative);

        match self.assets.insert_file(&absolute) {
            Ok(hash) => format!("{ASSET_PLACEHOLDER_PREFIX}{hash}"),
            Err(error) => {
                // A missing file is the author's mistake and needs no OS
                // wording; anything else (permissions, a directory in the way)
                // is worth quoting so the cause is obvious.
                let message = match error.kind() {
                    std::io::ErrorKind::NotFound => {
                        missing_message(MissingReason::UnknownAsset, destination)
                    }
                    _ => format!(
                        "{} ({error})",
                        missing_message(MissingReason::UnreadableAsset, destination)
                    ),
                };
                self.report(line, message);
                destination.to_string()
            }
        }
    }

    fn report(&mut self, line: usize, message: String) {
        self.diagnostics.push(Diagnostic::warning(format!(
            "{}:{line}: {message}",
            self.doc_id
        )));
    }
}

impl LinkRewriter for LinkResolver<'_> {
    fn rewrite(&mut self, destination: &str, line: usize) -> String {
        self.resolve(destination, line)
    }
}

/// Human-readable reason for a rejected destination.
fn missing_message(reason: MissingReason, destination: &str) -> String {
    match reason {
        MissingReason::NotRelative => {
            format!("link target is not relative to the input directory: '{destination}'")
        }
        MissingReason::EscapesRoot => {
            format!("link target escapes the input directory: '{destination}'")
        }
        MissingReason::UnknownDocument => {
            format!("link target not found: '{destination}'")
        }
        MissingReason::UnknownAsset => format!("asset not found: '{destination}'"),
        MissingReason::UnreadableAsset => format!("cannot read asset '{destination}'"),
    }
}

/// Bytes kept verbatim by [`encode_route`]: the RFC 3986 `pchar` set plus `/`.
const ROUTE_SAFE: &[u8] = b"-._~!$&'()*+,;=:@/";

/// Split at the first occurrence of `separator`, dropping the separator.
fn split_once(input: &str, separator: char) -> (&str, Option<&str>) {
    match input.find(separator) {
        Some(index) => (
            &input[..index],
            Some(&input[index + separator.len_utf8()..]),
        ),
        None => (input, None),
    }
}

/// End index of a `scheme:` prefix, if the destination starts with one.
fn scheme_end(destination: &str) -> Option<usize> {
    let mut characters = destination.char_indices();
    let (_, first) = characters.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }

    for (index, character) in characters {
        if character == ':' {
            return Some(index);
        }
        if !(character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')) {
            return None;
        }
    }

    None
}

/// Value of one hexadecimal digit.
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::scan::Severity;

    fn write(dir: &Path, name: &str, contents: &[u8]) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, contents).expect("write fixture file");
    }

    fn context(root: &Path, docs: &[&str]) -> LinkContext {
        LinkContext::new(root.to_path_buf(), docs.iter().map(|id| (*id).to_string()))
    }

    fn messages(context: &LinkContext) -> Vec<String> {
        context
            .diagnostics()
            .iter()
            .map(|diagnostic| diagnostic.to_string())
            .collect()
    }

    #[test]
    fn classifies_external_destinations() {
        for destination in [
            "http://example.com",
            "https://example.com/a?b=1",
            "mailto:someone@example.com",
            "tel:+123456",
            "//cdn.example.com/app.js",
            "data:image/png;base64,AAAA",
            "javascript:void(0)",
            "ftp://example.com/file",
        ] {
            assert_eq!(
                classify(destination),
                LinkClass::External,
                "destination: {destination}"
            );
        }
    }

    #[test]
    fn classifies_anchors() {
        for destination in ["#", "#top", "#section-1", "", "   ", "?query=1"] {
            assert_eq!(
                classify(destination),
                LinkClass::Anchor,
                "destination: {destination:?}"
            );
        }
    }

    #[test]
    fn classifies_internal_documents() {
        assert_eq!(
            classify("guide/intro.md"),
            LinkClass::InternalDoc {
                path: "guide/intro.md".to_string(),
                anchor: None,
            }
        );
        assert_eq!(
            classify("intro.MARKDOWN"),
            LinkClass::InternalDoc {
                path: "intro.MARKDOWN".to_string(),
                anchor: None,
            }
        );
        assert_eq!(
            classify("a.md#section"),
            LinkClass::InternalDoc {
                path: "a.md".to_string(),
                anchor: Some("section".to_string()),
            }
        );
        assert_eq!(
            classify("a.md?plain=1#section"),
            LinkClass::InternalDoc {
                path: "a.md".to_string(),
                anchor: Some("section".to_string()),
            },
            "the query is dropped, the anchor is kept"
        );
        assert_eq!(
            classify("./a.md"),
            LinkClass::InternalDoc {
                path: "./a.md".to_string(),
                anchor: None,
            }
        );
        assert_eq!(
            classify("a.md#"),
            LinkClass::InternalDoc {
                path: "a.md".to_string(),
                anchor: None,
            },
            "an empty anchor is dropped"
        );
    }

    #[test]
    fn classifies_local_assets() {
        assert_eq!(
            classify("img/logo.png"),
            LinkClass::LocalAsset {
                path: "img/logo.png".to_string()
            }
        );
        assert_eq!(
            classify("manual.pdf#page=3"),
            LinkClass::LocalAsset {
                path: "manual.pdf".to_string()
            },
            "asset fragments are dropped"
        );
        assert_eq!(
            classify("img/logo.png?raw=1"),
            LinkClass::LocalAsset {
                path: "img/logo.png".to_string()
            }
        );
        assert_eq!(
            classify("img\\logo.png"),
            LinkClass::LocalAsset {
                path: "img/logo.png".to_string()
            },
            "backslashes are accepted as separators"
        );
        assert_eq!(
            classify("img/my%20logo.png"),
            LinkClass::LocalAsset {
                path: "img/my logo.png".to_string()
            },
            "percent escapes are decoded before lookup"
        );
    }

    #[test]
    fn classifies_root_absolute_and_drive_paths_as_missing() {
        for destination in [
            "/etc/passwd",
            "/images/logo.png",
            r"C:\notes\x.png",
            "C:/notes/x.png",
        ] {
            assert_eq!(
                classify(destination),
                LinkClass::Missing {
                    reason: MissingReason::NotRelative
                },
                "destination: {destination}"
            );
        }
    }

    #[test]
    fn percent_decoding_handles_ascii_unicode_and_malformed_input() {
        assert_eq!(percent_decode("my%20file.png"), "my file.png");
        assert_eq!(percent_decode("%E4%B8%AD%E6%96%87.md"), "中文.md");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%4"), "%4");
        assert_eq!(percent_decode("%ff"), "%ff", "invalid UTF-8 stays verbatim");
        assert_eq!(percent_decode("plain.png"), "plain.png");
    }

    #[test]
    fn route_encoding_keeps_readable_paths_and_escapes_the_rest() {
        assert_eq!(encode_route("guide/intro.md"), "guide/intro.md");
        assert_eq!(encode_route("my file.md"), "my%20file.md");
        assert_eq!(encode_route("中文.md"), "%E4%B8%AD%E6%96%87.md");
        assert_eq!(encode_route("a#b.md"), "a%23b.md");
        assert_eq!(encode_route("a%b.md"), "a%25b.md");
    }

    #[test]
    fn route_encoding_round_trips_through_percent_decoding() {
        for id in ["guide/intro.md", "my file.md", "中文/说明.md", "a#b%c.md"] {
            assert_eq!(percent_decode(&encode_route(id)), id, "id: {id}");
        }
    }

    #[test]
    fn join_relative_collapses_segments() {
        assert_eq!(join_relative("", "a.md").as_deref(), Some("a.md"));
        assert_eq!(
            join_relative("guide", "a.md").as_deref(),
            Some("guide/a.md")
        );
        assert_eq!(
            join_relative("guide", "./a.md").as_deref(),
            Some("guide/a.md")
        );
        assert_eq!(
            join_relative("guide/deep", "../a.md").as_deref(),
            Some("guide/a.md")
        );
        assert_eq!(
            join_relative("guide/deep", "../../a.md").as_deref(),
            Some("a.md")
        );
        assert_eq!(
            join_relative("guide", "img//logo.png").as_deref(),
            Some("guide/img/logo.png")
        );
        assert_eq!(join_relative("", "./a.md").as_deref(), Some("a.md"));
    }

    #[test]
    fn join_relative_rejects_escapes() {
        assert_eq!(join_relative("", "../a.md"), None);
        assert_eq!(join_relative("guide", "../../a.md"), None);
        assert_eq!(join_relative("guide", ".."), None);
    }

    #[test]
    fn doc_dir_returns_the_parent_folder() {
        assert_eq!(doc_dir("intro.md"), "");
        assert_eq!(doc_dir("guide/intro.md"), "guide");
        assert_eq!(doc_dir("a/b/c.md"), "a/b");
    }

    #[test]
    fn internal_documents_become_hash_routes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["guide/intro.md", "other.md"]);
        let mut resolver = context.for_doc("guide/intro.md");

        assert_eq!(resolver.resolve("../other.md", 1), "#/doc/other.md");
        assert_eq!(
            resolver.resolve("../other.md#section", 2),
            "#/doc/other.md#section"
        );
        assert_eq!(resolver.resolve("intro.md", 3), "#/doc/guide/intro.md");
    }

    #[test]
    fn document_routes_encode_non_ascii_ids_and_anchors() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["中文/说明.md"]);
        let mut resolver = context.for_doc("中文/说明.md");

        assert_eq!(
            resolver.resolve("说明.md#第一节", 1),
            "#/doc/%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md#%E7%AC%AC%E4%B8%80%E8%8A%82"
        );
    }

    #[test]
    fn external_and_anchor_destinations_are_untouched() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["a.md"]);
        let mut resolver = context.for_doc("a.md");

        assert_eq!(
            resolver.resolve("https://example.com", 1),
            "https://example.com"
        );
        assert_eq!(resolver.resolve("#section", 2), "#section");
        assert!(context.diagnostics().is_empty());
    }

    #[test]
    fn unknown_documents_warn_and_keep_the_destination() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["guide/intro.md"]);
        let mut resolver = context.for_doc("guide/intro.md");

        assert_eq!(resolver.resolve("missing.md", 12), "missing.md");
        drop(resolver);

        assert_eq!(
            messages(&context),
            ["warning: guide/intro.md:12: link target not found: 'missing.md'".to_string()]
        );
        assert_eq!(context.diagnostics()[0].severity, Severity::Warning);
    }

    #[test]
    fn escaping_documents_warn_and_keep_the_destination() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["a.md"]);
        let mut resolver = context.for_doc("a.md");

        assert_eq!(resolver.resolve("../outside.md", 4), "../outside.md");
        drop(resolver);

        assert_eq!(
            messages(&context),
            [
                "warning: a.md:4: link target escapes the input directory: '../outside.md'"
                    .to_string()
            ]
        );
    }

    #[test]
    fn root_absolute_destinations_warn() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["a.md"]);
        let mut resolver = context.for_doc("a.md");

        assert_eq!(resolver.resolve("/etc/passwd", 1), "/etc/passwd");
        drop(resolver);

        assert_eq!(
            messages(&context),
            [
                "warning: a.md:1: link target is not relative to the input directory: '/etc/passwd'"
                    .to_string()
            ]
        );
    }

    #[test]
    fn local_assets_become_opaque_placeholders() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "img/logo.svg", b"<svg>logo</svg>");
        let mut context = context(dir.path(), &["a.md"]);
        let mut resolver = context.for_doc("a.md");

        let placeholder = resolver.resolve("img/logo.svg", 1);
        drop(resolver);

        assert!(
            placeholder.starts_with(ASSET_PLACEHOLDER_PREFIX),
            "placeholder: {placeholder}"
        );
        assert_eq!(placeholder.len(), ASSET_PLACEHOLDER_PREFIX.len() + 16);
        assert_eq!(context.assets().len(), 1);
        assert!(context.diagnostics().is_empty());

        let asset = context.assets().iter().next().expect("one asset").1;
        assert_eq!(asset.mime, "image/svg+xml");
        assert_eq!(asset.extension, "svg");
        assert_eq!(asset.bytes, b"<svg>logo</svg>");
    }

    #[test]
    fn assets_resolve_relative_to_the_document() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "guide/img/logo.svg", b"<svg/>");
        let mut context = context(dir.path(), &["guide/a.md"]);
        let mut resolver = context.for_doc("guide/a.md");

        let placeholder = resolver.resolve("img/logo.svg", 1);
        drop(resolver);

        assert!(placeholder.starts_with(ASSET_PLACEHOLDER_PREFIX));
        assert_eq!(context.assets().len(), 1);
    }

    #[test]
    fn duplicate_references_yield_one_asset() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "img/logo.svg", b"<svg/>");
        write(dir.path(), "img/copy.svg", b"<svg/>");
        let mut context = context(dir.path(), &["a.md", "b.md"]);

        let first = {
            let mut resolver = context.for_doc("a.md");
            resolver.resolve("img/logo.svg", 1)
        };
        let second = {
            let mut resolver = context.for_doc("b.md");
            resolver.resolve("img/copy.svg", 1)
        };

        assert_eq!(first, second);
        assert_eq!(context.assets().len(), 1);
    }

    #[test]
    fn missing_assets_warn_and_keep_the_destination() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["a.md"]);
        let mut resolver = context.for_doc("a.md");

        assert_eq!(resolver.resolve("img/missing.png", 7), "img/missing.png");
        drop(resolver);

        assert_eq!(
            messages(&context),
            ["warning: a.md:7: asset not found: 'img/missing.png'".to_string()]
        );
        assert!(context.assets().is_empty());
    }

    #[test]
    fn escaping_assets_produce_a_warning_and_no_asset() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "outside.png", b"png");
        let mut context = context(dir.path(), &["guide/a.md"]);
        let mut resolver = context.for_doc("guide/a.md");

        assert_eq!(
            resolver.resolve("../../outside.png", 3),
            "../../outside.png"
        );
        drop(resolver);

        assert_eq!(
            messages(&context),
            [
                "warning: guide/a.md:3: link target escapes the input directory: '../../outside.png'"
                    .to_string()
            ]
        );
        assert!(context.assets().is_empty());
    }

    #[test]
    fn unreadable_assets_warn_with_the_io_reason() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir(dir.path().join("folder.png")).expect("create directory");
        let mut context = context(dir.path(), &["a.md"]);
        let mut resolver = context.for_doc("a.md");

        assert_eq!(resolver.resolve("folder.png", 2), "folder.png");
        drop(resolver);

        let messages = messages(&context);
        assert_eq!(messages.len(), 1);
        assert!(
            messages[0].starts_with("warning: a.md:2: cannot read asset 'folder.png'"),
            "unexpected message: {}",
            messages[0]
        );
        assert!(context.assets().is_empty());
    }

    #[test]
    fn resolving_the_same_document_twice_is_deterministic() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "img/logo.svg", b"<svg/>");
        let docs = ["a.md", "guide/b.md"];

        let mut first = context(dir.path(), &docs);
        let first_links = {
            let mut resolver = first.for_doc("a.md");
            vec![
                resolver.resolve("img/logo.svg", 1),
                resolver.resolve("guide/b.md", 2),
                resolver.resolve("missing.md", 3),
                resolver.resolve("https://example.com", 4),
            ]
        };
        let mut second = context(dir.path(), &docs);
        let second_links = {
            let mut resolver = second.for_doc("a.md");
            vec![
                resolver.resolve("img/logo.svg", 1),
                resolver.resolve("guide/b.md", 2),
                resolver.resolve("missing.md", 3),
                resolver.resolve("https://example.com", 4),
            ]
        };

        assert_eq!(first_links, second_links);
        assert_eq!(messages(&first), messages(&second));
        assert_eq!(first.assets(), second.assets());
    }

    #[test]
    fn resolved_documents_are_recorded_as_targets() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["a.md", "guide/b.md"]);
        let mut resolver = context.for_doc("a.md");

        resolver.resolve("guide/b.md", 1);
        resolver.resolve("guide/b.md#section", 2);
        resolver.resolve("missing.md", 3);
        resolver.resolve("https://example.com", 4);
        resolver.resolve("#local-anchor", 5);
        resolver.resolve("/etc/passwd", 6);

        assert_eq!(
            resolver.targets(),
            ["guide/b.md".to_string(), "guide/b.md".to_string()],
            "repeats are kept here; deduplication is the assembly stage's job"
        );
        assert_eq!(resolver.take_targets().len(), 2);
        assert!(
            resolver.targets().is_empty(),
            "take_targets empties the list"
        );
    }

    #[test]
    fn unresolvable_targets_are_never_recorded() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut context = context(dir.path(), &["guide/a.md"]);
        let mut resolver = context.for_doc("guide/a.md");

        resolver.resolve("../outside.md", 1);
        resolver.resolve("missing.md", 2);
        resolver.resolve("/etc/passwd", 3);
        resolver.resolve("mailto:docs@example.com", 4);

        assert!(resolver.targets().is_empty());
        assert_eq!(context.diagnostics().len(), 3, "each failure is reported");
    }

    #[test]
    fn assets_and_self_links_are_not_targets() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "logo.svg", b"<svg/>");
        let mut context = context(dir.path(), &["a.md"]);
        let mut resolver = context.for_doc("a.md");

        resolver.resolve("logo.svg", 1);
        resolver.resolve("a.md#section", 2);

        assert_eq!(
            resolver.targets(),
            ["a.md".to_string()],
            "a self-link is recorded; the assembly stage drops the self-loop"
        );
    }

    #[test]
    fn into_parts_returns_assets_and_diagnostics() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "logo.svg", b"<svg/>");
        let mut context = context(dir.path(), &["a.md"]);
        {
            let mut resolver = context.for_doc("a.md");
            resolver.resolve("logo.svg", 1);
            resolver.resolve("missing.md", 2);
        }

        let (assets, diagnostics) = context.into_parts();

        assert_eq!(assets.len(), 1);
        assert_eq!(diagnostics.len(), 1);
    }
}
