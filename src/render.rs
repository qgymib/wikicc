//! Shell assembly: the template, the styles, the scripts and the payload.
//!
//! This is the `render` stage described in `docs/design.md`. It turns a
//! [`SiteBundle`] into what the writers consume, so the output formats differ
//! only in how asset placeholders are addressed and never in the page itself.
//!
//! Everything the page needs is inlined, because the product has to work from
//! `file://`, where `fetch` of a sibling JSON file is blocked by CORS and a
//! classic script is the only reliable way to load code:
//!
//! The skeleton in `web/index.html.tmpl` is rendered with `minijinja`, so the
//! page markup stays in HTML and escaping is the engine's job:
//!
//! - `{{ css|safe }}` is `web/css/app.css`, followed by the theme CSS the
//!   build-time highlighter generates and the math renderer's sheet with its
//!   fonts embedded;
//! - `{{ js|safe }}` is the single IIFE bundle that `build.rs` produces with
//!   esbuild from `web/js/main.js` (the reader modules plus the npm-installed
//!   engine), so the page needs no module loader and resolves nothing at
//!   runtime;
//! - `{{ payload|safe }}` is the bundle JSON — the whole site for the two
//!   shell formats, and the document manifest for [`OutputFormat::Pages`] —
//!   escaped so a document that contains `</script>` cannot terminate the
//!   script element;
//! - `{{ title }}` is the site title, escaped by the engine's HTML auto-escaper.
//!
//! The pages format ([`render_pages`]) additionally projects the
//! bundle into one JSON chunk per document and the search corpus file. Those
//! are standalone `application/json` files fetched over HTTP, so they need no
//! script-element escaping — only what `serde_json` already guarantees — and
//! their chunk JSON still carries the opaque asset placeholders, which the
//! pages writer expands exactly like the shell writers do.
//!
//! Determinism: the template is compiled from a constant, the concatenation
//! order is fixed, nothing is sorted at render time, and no value depends on
//! the clock, the host or the file system order. Two builds of the same input
//! therefore produce byte-identical output.

use std::fmt::Write as _;
use std::sync::OnceLock;

use minijinja::{Environment, UndefinedBehavior, context};

use crate::assets::asset_hash;
use crate::error::{Error, Result};
use crate::markdown::highlight::theme_css;
use crate::markdown::sections::Block;
use crate::markdown::toc::TocEntry;
use crate::site::{Edge, SiteBundle, Stats, flatten_headings};

/// Page skeleton, with the four template variables below.
///
/// Staged by `build.rs` with LF line endings, so the embedded bytes are the
/// same on every platform no matter how Git checked the sources out.
pub const SHELL_TEMPLATE: &str = include_str!(concat!(env!("OUT_DIR"), "/vendor/index.html.tmpl"));

/// Name the skeleton is registered under.
///
/// `minijinja` derives the auto-escape mode from the template name, so the
/// `.html` suffix is what makes `{{ title }}` escape HTML while the `|safe`
/// values are injected verbatim.
const TEMPLATE_NAME: &str = "index.html";

/// Reader styles, without the highlighting theme.
///
/// Staged by `build.rs` with LF line endings: a CRLF checkout must not leak a
/// carriage return into the sheet, whose textual contracts the tests read
/// verbatim.
pub const SHELL_CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/vendor/app.css"));

/// Math renderer stylesheet, staged by `build.rs` with the fonts embedded.
///
/// KaTeX's sheet points at sibling font files, which a single-file page can
/// never load; the staging step rewrote every reference into an inline data
/// URL (woff2 only, the woff and ttf fallbacks dropped) and normalized the
/// line endings like the other staged text assets.
pub const KATEX_CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/vendor/katex.css"));

/// Reader bundle, produced by `build.rs`.
///
/// It is the IIFE output of esbuild over `web/js/main.js`, which imports the
/// reader modules and the npm-installed engine. The build fails when the npm
/// dependencies are missing or when esbuild rejects the sources, so this
/// constant is always a bundle of the sources in this commit.
pub const APP_BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/vendor/app.js"));

/// Result of the render stage: one self-contained HTML document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedSite {
    /// Complete page, ready to be written as `index.html`.
    ///
    /// Asset references still carry the opaque
    /// [`crate::ASSET_PLACEHOLDER_PREFIX`]`<hash>` placeholder: turning those
    /// into `data:` URIs or `assets/…` paths is the job of the writers, which
    /// is the only thing the two formats differ in.
    pub html: String,
}

impl RenderedSite {
    /// Size of the rendered page in bytes.
    pub fn len(&self) -> usize {
        self.html.len()
    }

    /// Whether the page is empty, which only happens for a broken template.
    pub fn is_empty(&self) -> bool {
        self.html.is_empty()
    }
}

/// Reader stylesheet: the hand-written rules, the highlighting theme and the
/// math renderer's sheet with its fonts embedded.
///
/// All three are static, so the concatenation is built once and shared.
pub fn shell_css() -> &'static str {
    static CSS: OnceLock<String> = OnceLock::new();

    CSS.get_or_init(|| {
        let mut css =
            String::with_capacity(SHELL_CSS.len() + theme_css().len() + KATEX_CSS.len() + 2);
        css.push_str(SHELL_CSS);
        css.push('\n');
        css.push_str(theme_css());
        css.push('\n');
        css.push_str(KATEX_CSS);
        css
    })
}

/// Inline script bundle: the single IIFE that `build.rs` staged.
pub fn shell_js() -> &'static str {
    APP_BUNDLE
}

/// Render `bundle` into the self-contained page.
///
/// Fails only on a broken build: a skeleton that does not compile or render, or
/// an embedded resource that could close its own element.
pub fn render_site(bundle: &SiteBundle) -> Result<RenderedSite> {
    let css = shell_css();
    let js = shell_js();

    if css.contains("</style") {
        return Err(Error::Render(
            "the stylesheet contains a '</style' sequence".to_string(),
        ));
    }
    if js.contains("</script") {
        return Err(Error::Render(
            "the script bundle contains a '</script' sequence".to_string(),
        ));
    }

    let payload = escape_json_for_script(&bundle.to_json());
    let html = render_template(&bundle.title, css, js, &payload)?;

    Ok(RenderedSite { html })
}

/// Directory the per-document chunks live in, relative to `index.html`.
pub const PAGES_DIR_NAME: &str = "pages";

/// File name of the search corpus, relative to `index.html`.
pub const SEARCH_FILE_NAME: &str = "search.json";

/// Value of the manifest's `mode` field, which tells the reader the documents
/// are separate files rather than embedded in the payload.
pub const MANIFEST_MODE: &str = "pages";

/// Suffix of every chunk file name.
const CHUNK_SUFFIX: &str = ".json";

/// What the render stage hands the writers for one output format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderedOutput {
    /// One self-contained shell page: what `single-html` and `html-dir` write.
    Page(RenderedSite),
    /// The shell page plus the per-document chunks and the search corpus: what
    /// `pages` writes.
    Pages(RenderedPages),
}

/// One per-document chunk of the pages format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkArtifact {
    /// File name relative to the output root: `pages/<encoded-id>.json`.
    ///
    /// The separators are literal `'/'` on purpose: this is a URL, not a file
    /// system path, and `Path::display` would emit `\` on Windows.
    pub name: String,
    /// Content hash of [`ChunkArtifact::json`] (the asset hash: the first 16
    /// hex characters of the SHA-256 digest). The reader appends it as a
    /// `?v=` query so a browser that holds a cached chunk under a static host
    /// still refetches after a redeploy.
    pub hash: String,
    /// Chunk JSON, with asset placeholders still unexpanded.
    pub json: String,
}

/// The pages projection of a site bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPages {
    /// The shell page. Its payload is the manifest: the site title, the mode
    /// marker, one `{id, title, hash}` reference per document, the link graph
    /// and the counters — everything the reader needs before any document is
    /// open, and nothing else.
    pub shell: RenderedSite,
    /// One chunk per document, in scan order.
    pub chunks: Vec<ChunkArtifact>,
    /// The search corpus JSON: `{docs: [{id, title, headings, text}]}`.
    pub search_json: String,
}

impl RenderedPages {
    /// Chunk of the document with the given id.
    pub fn chunk(&self, id: &str) -> Option<&ChunkArtifact> {
        self.chunks
            .iter()
            .find(|chunk| chunk.name == chunk_file_name(id))
    }
}

/// `{id, title, hash}` reference to one document chunk, as the manifest lists it.
#[derive(serde::Serialize)]
struct ManifestDoc<'a> {
    id: &'a str,
    title: &'a str,
    hash: &'a str,
}

/// The manifest: the payload the pages shell embeds.
#[derive(serde::Serialize)]
struct Manifest<'a> {
    title: &'a str,
    mode: &'static str,
    docs: Vec<ManifestDoc<'a>>,
    edges: &'a [Edge],
    stats: &'a Stats,
}

/// One document as the chunk file carries it.
#[derive(serde::Serialize)]
struct ChunkPayload<'a> {
    id: &'a str,
    title: &'a str,
    html: &'a str,
    toc: &'a [TocEntry],
    blocks: &'a [Block],
    text: &'a str,
}

/// One document's record in the search corpus file.
#[derive(serde::Serialize)]
struct SearchRecord<'a> {
    id: &'a str,
    title: &'a str,
    headings: String,
    text: &'a str,
}

/// The search corpus file: the text every document contributes to search.
#[derive(serde::Serialize)]
struct SearchCorpus<'a> {
    docs: Vec<SearchRecord<'a>>,
}

/// Percent-encode a document id for a chunk file name, keeping `/`.
///
/// This mirrors the reader's `router.encodeId` exactly (one
/// `encodeURIComponent` per `/`-separated segment), because the file the build
/// writes must be the URL the browser fetches. The unreserved set is the one
/// JavaScript's encoder keeps literal — `A-Z a-z 0-9 - _ . ! ~ * ' ( )` — and
/// everything else becomes an uppercase `%XX` over the UTF-8 bytes, so names
/// never carry a character a URL, a filesystem or a static host could mangle.
/// A real path component can never be `.` or `..`, so the encoding cannot
/// smuggle a traversal either.
pub fn encode_chunk_id(id: &str) -> String {
    let mut encoded = String::with_capacity(id.len());

    for (index, segment) in id.split('/').enumerate() {
        if index > 0 {
            encoded.push('/');
        }
        for byte in segment.bytes() {
            match byte {
                b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'_'
                | b'.'
                | b'!'
                | b'~'
                | b'*'
                | b'\''
                | b'('
                | b')' => encoded.push(byte as char),
                other => {
                    // Writing into a `String` cannot fail.
                    let _ = write!(encoded, "%{other:02X}");
                }
            }
        }
    }

    encoded
}

/// File name of the chunk of the document with the given id.
///
/// The name is stable across builds: it derives from the document id alone, so
/// a static host that still serves a cached shell never points at a chunk file
/// the redeploy removed. Freshness comes from the `?v=` query instead.
pub fn chunk_file_name(id: &str) -> String {
    format!("{PAGES_DIR_NAME}/{}{CHUNK_SUFFIX}", encode_chunk_id(id))
}

/// Render `bundle` into the pages projection: the shell page carrying the
/// manifest, one JSON chunk per document and the search corpus file.
///
/// Fails only on a broken build: a skeleton that does not compile or render,
/// or an embedded resource that could close its own element. Document chunks
/// follow scan order and the corpus follows the same order, so two builds of
/// the same input are byte-identical.
pub fn render_pages(bundle: &SiteBundle) -> Result<RenderedPages> {
    let css = shell_css();
    let js = shell_js();

    if css.contains("</style") {
        return Err(Error::Render(
            "the stylesheet contains a '</style' sequence".to_string(),
        ));
    }
    if js.contains("</script") {
        return Err(Error::Render(
            "the script bundle contains a '</script' sequence".to_string(),
        ));
    }

    let mut chunks = Vec::with_capacity(bundle.docs.len());
    for doc in &bundle.docs {
        let payload = ChunkPayload {
            id: &doc.id,
            title: &doc.title,
            html: &doc.html,
            toc: &doc.toc,
            blocks: &doc.blocks,
            text: &doc.text,
        };
        let json =
            serde_json::to_string(&payload).expect("a document chunk always serialises to JSON");

        chunks.push(ChunkArtifact {
            name: chunk_file_name(&doc.id),
            // The hash addresses the chunk content, so a redeploy that changed
            // a document changes the query the shell asks for.
            hash: asset_hash(json.as_bytes()),
            json,
        });
    }

    let manifest = Manifest {
        title: &bundle.title,
        mode: MANIFEST_MODE,
        docs: bundle
            .docs
            .iter()
            .zip(chunks.iter())
            .map(|(doc, chunk)| ManifestDoc {
                id: &doc.id,
                title: &doc.title,
                hash: &chunk.hash,
            })
            .collect(),
        edges: &bundle.edges,
        stats: &bundle.stats,
    };
    let payload = escape_json_for_script(
        &serde_json::to_string(&manifest).expect("a manifest always serialises to JSON"),
    );
    let html = render_template(&bundle.title, css, js, &payload)?;

    let corpus = SearchCorpus {
        docs: bundle
            .docs
            .iter()
            .map(|doc| SearchRecord {
                id: &doc.id,
                title: &doc.title,
                headings: flatten_headings(&doc.toc),
                text: &doc.text,
            })
            .collect(),
    };
    let search_json =
        serde_json::to_string(&corpus).expect("a search corpus always serialises to JSON");

    Ok(RenderedPages {
        shell: RenderedSite { html },
        chunks,
        search_json,
    })
}

/// Render the compiled-in skeleton with `minijinja`.
///
/// Undefined variables are an error rather than an empty string, so a typo in
/// the skeleton fails the build instead of silently dropping the stylesheet,
/// the script or the payload. The environment is built per call because the
/// render stage runs once per output and compiling the skeleton costs
/// microseconds next to the multi-megabyte bundle it carries.
fn render_template(title: &str, css: &str, js: &str, payload: &str) -> Result<String> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    env.add_template(TEMPLATE_NAME, SHELL_TEMPLATE)
        .map_err(|error| Error::Render(format!("the page skeleton does not compile: {error}")))?;

    let template = env
        .get_template(TEMPLATE_NAME)
        .map_err(|error| Error::Render(format!("the page skeleton is not registered: {error}")))?;

    template
        .render(context! {
            title => title,
            css => css,
            js => js,
            payload => payload,
        })
        .map_err(|error| Error::Render(format!("the page skeleton does not render: {error}")))
}

/// Escape JSON so it can sit inside a `<script type="application/json">`.
///
/// `<` is enough to neutralise `</script>`, `<!--` and `]]>`; `>`, `&` and the
/// two Unicode line separators are escaped as well so the payload stays inert
/// in every HTML and JavaScript context. The result is still valid JSON: these
/// are all `\uXXXX` escapes inside string literals, and JSON syntax never uses
/// those characters outside a string.
pub fn escape_json_for_script(json: &str) -> String {
    let mut escaped = String::with_capacity(json.len());

    for character in json.chars() {
        match character {
            '<' => escaped.push_str("\\u003c"),
            '>' => escaped.push_str("\\u003e"),
            '&' => escaped.push_str("\\u0026"),
            '\u{2028}' => escaped.push_str("\\u2028"),
            '\u{2029}' => escaped.push_str("\\u2029"),
            _ => escaped.push(character),
        }
    }

    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::SourceDoc;
    use crate::site::build_site;
    use std::path::PathBuf;

    fn source(id: &str, title: &str, text: &str) -> SourceDoc {
        SourceDoc {
            id: id.to_string(),
            path: PathBuf::from(id),
            title: title.to_string(),
            text: text.to_string(),
        }
    }

    /// Payload embedded in a rendered page.
    fn payload_of(html: &str) -> &str {
        let start = html
            .find(r#"<script id="wikicc-payload" type="application/json">"#)
            .expect("payload element")
            + r#"<script id="wikicc-payload" type="application/json">"#.len();
        let end = html[start..].find("</script>").expect("payload end") + start;
        &html[start..end]
    }

    #[test]
    fn json_escaping_neutralises_script_terminators() {
        let json = r#"{"html":"</script><script>alert(1)</script>"}"#;
        let escaped = escape_json_for_script(json);

        assert!(!escaped.contains("</script"));
        assert!(!escaped.contains('<'));
        assert!(!escaped.contains('>'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&escaped).expect("still valid JSON"),
            serde_json::from_str::<serde_json::Value>(json).expect("valid JSON")
        );
    }

    #[test]
    fn line_separators_are_escaped() {
        assert_eq!(
            escape_json_for_script("a\u{2028}b\u{2029}c"),
            "a\\u2028b\\u2029c"
        );
    }

    #[test]
    fn the_stylesheet_contains_the_reader_rules_and_the_theme() {
        let css = shell_css();

        assert!(css.contains("--sidebar-width"));
        assert!(css.contains(".doc-body"));
        assert!(css.contains(theme_css()));
        assert!(
            css.contains(".katex"),
            "the math renderer's sheet is appended"
        );
        assert!(
            css.contains("@font-face"),
            "its fonts travel inside the sheet"
        );
        assert!(
            !css.contains('\r'),
            "the math sheet carries a carriage return"
        );
        assert!(!css.contains("</style"));
    }

    #[test]
    fn the_staged_shell_resources_carry_unix_line_endings() {
        // The template and the sheet are embedded from the copies `build.rs`
        // stages, and those copies are written with LF endings whatever the
        // checkout carries: the page, and every textual contract read from
        // these constants, must not depend on the platform's line endings.
        for (name, text) in [("template", SHELL_TEMPLATE), ("styles", SHELL_CSS)] {
            assert!(!text.contains('\r'), "{name} carries a carriage return");
        }
    }

    #[test]
    fn the_script_bundle_is_one_iife_with_the_engines_and_the_bootstrap() {
        let js = shell_js();
        let trimmed = js.trim_end();

        assert!(js.starts_with("(()=>"), "the bundle must be an IIFE");
        assert!(
            trimmed.ends_with("})();") || trimmed.ends_with("*/"),
            "the bundle must end with the IIFE close or the licence trailer"
        );
        assert!(
            js.contains("wikicc-payload"),
            "the bootstrap must read the embedded payload"
        );
        assert!(
            js.contains("DOMContentLoaded"),
            "the entry point must boot the reader"
        );
        assert!(
            js.contains("startOnLoad"),
            "the diagram engine must be configured by the reader"
        );
        assert!(!js.contains("</script"));
        assert!(
            !js.contains("chunks/"),
            "no diagram chunk may be fetched at runtime"
        );
        assert!(
            !js.contains("import("),
            "the bundle must not import anything at runtime"
        );
    }

    #[test]
    fn the_bundle_is_the_staged_esbuild_output() {
        assert!(
            APP_BUNDLE.len() > 10_000,
            "the staged bundle looks truncated: {} bytes",
            APP_BUNDLE.len()
        );
        // Minified output is ~5.3 MB, almost all of it the diagram engine;
        // unminified it is ~12.3 MB. The bound catches a dropped `--minify`.
        assert!(
            APP_BUNDLE.len() < 8_000_000,
            "the staged bundle is {} bytes: is `--minify` still passed to esbuild?",
            APP_BUNDLE.len()
        );
        assert!(
            APP_BUNDLE.contains("src/web/js/main.js") || APP_BUNDLE.contains("DOMContentLoaded"),
            "the bundle must contain the reader entry point"
        );
        assert!(
            APP_BUNDLE.contains("katex"),
            "the bundle must contain the math engine"
        );
        assert!(!APP_BUNDLE.contains("</script"));
    }

    #[test]
    fn package_json_pins_exact_front_end_versions() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../package.json")).expect("package.json is JSON");

        assert_eq!(
            manifest["type"], "module",
            "the front-end sources are ES modules"
        );

        for (section, name) in [
            ("dependencies", "minisearch"),
            ("dependencies", "mermaid"),
            ("devDependencies", "esbuild"),
        ] {
            let version = manifest[section][name]
                .as_str()
                .unwrap_or_else(|| panic!("{section}.{name} must be declared"));
            let parts: Vec<&str> = version.split('.').collect();

            assert_eq!(
                parts.len(),
                3,
                "{name} must be pinned exactly, found {version}"
            );
            assert!(
                parts
                    .iter()
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())),
                "{name} must be pinned exactly, found {version}"
            );
        }
    }

    #[test]
    fn styles_are_cached_and_the_bundle_is_static() {
        assert!(std::ptr::eq(shell_css(), shell_css()));
        assert_eq!(shell_js(), APP_BUNDLE);
    }

    #[test]
    fn rendering_embeds_title_payload_and_scripts() {
        let dir = tempfile::tempdir().expect("temp dir");
        let build = build_site("Site <One>", dir.path(), &[source("a.md", "A", "# A\n")]);

        let rendered = render_site(&build.bundle).expect("render");

        assert!(rendered.html.contains("<title>Site &lt;One&gt;</title>"));
        assert!(
            rendered
                .html
                .contains(r#"<p class="site-title" title="Site &lt;One&gt;">"#)
        );
        assert!(rendered.html.contains(r#"id="doc-list""#));
        assert!(rendered.html.contains("wikicc-payload"));
        // The stylesheet and the script are injected verbatim, not escaped.
        assert!(rendered.html.contains(shell_css()));
        assert!(rendered.html.contains(APP_BUNDLE));
        assert!(!rendered.is_empty());

        let payload = payload_of(&rendered.html);
        let value: serde_json::Value = serde_json::from_str(payload).expect("payload JSON");
        assert_eq!(value["docs"][0]["id"], "a.md");
    }

    #[test]
    fn a_document_cannot_terminate_the_script_element() {
        let dir = tempfile::tempdir().expect("temp dir");
        let build = build_site(
            "Site",
            dir.path(),
            &[source(
                "a.md",
                "A",
                "# A\n\n</script><script>alert('x')</script>\n",
            )],
        );

        let rendered = render_site(&build.bundle).expect("render");

        assert_eq!(
            rendered.html.matches("</script>").count(),
            2,
            "only the payload element and the script bundle may close"
        );
        let payload = payload_of(&rendered.html);
        assert!(!payload.contains("</script"));
        let value: serde_json::Value = serde_json::from_str(payload).expect("payload JSON");
        assert!(
            value["docs"][0]["text"].is_string(),
            "the payload still parses after escaping"
        );
    }

    #[test]
    fn rendering_is_deterministic() {
        let dir = tempfile::tempdir().expect("temp dir");
        let build = build_site("Site", dir.path(), &[source("a.md", "A", "# A\n")]);

        assert_eq!(
            render_site(&build.bundle).expect("render"),
            render_site(&build.bundle).expect("render")
        );
    }

    #[test]
    fn chunk_ids_encode_like_the_reader_routes() {
        assert_eq!(encode_chunk_id("a.md"), "a.md");
        assert_eq!(encode_chunk_id("guide/intro.md"), "guide/intro.md");
        assert_eq!(encode_chunk_id("a b.md"), "a%20b.md");
        assert_eq!(encode_chunk_id("a#b.md"), "a%23b.md");
        assert_eq!(
            encode_chunk_id("中文/说明.md"),
            "%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md"
        );
        assert_eq!(chunk_file_name("a.md"), "pages/a.md.json");
        assert_eq!(
            chunk_file_name("guide/intro.md"),
            "pages/guide/intro.md.json"
        );
        assert_eq!(
            chunk_file_name("中文/说明.md"),
            "pages/%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md.json"
        );
    }

    #[test]
    fn the_pages_render_carries_manifest_chunks_and_corpus() {
        let dir = tempfile::tempdir().expect("temp dir");
        let build = build_site(
            "Site",
            dir.path(),
            &[
                source("a.md", "A", "# A\n\n[to b](b.md)\n"),
                source("b.md", "B", "# B\n"),
            ],
        );
        let rendered = render_pages(&build.bundle).expect("render");

        // The manifest is the shell's payload and names every document.
        let manifest: serde_json::Value =
            serde_json::from_str(payload_of(&rendered.shell.html)).expect("manifest JSON");
        assert_eq!(manifest["mode"], "pages");
        assert_eq!(manifest["title"], "Site");
        assert_eq!(manifest["docs"][0]["id"], "a.md");
        assert_eq!(manifest["docs"][0]["title"], "A");
        assert_eq!(
            manifest["docs"][0].as_object().map(|object| object.len()),
            Some(3),
            "a manifest entry carries id, title and hash only"
        );
        assert_eq!(
            manifest["edges"][0]["to"], "b.md",
            "the graph travels in the manifest"
        );
        assert_eq!(manifest["stats"]["documents"], 2);

        // One chunk per document, carrying everything the reader needs to open it.
        assert_eq!(rendered.chunks.len(), 2);
        let chunk = &rendered.chunks[0];
        assert_eq!(chunk.name, "pages/a.md.json");
        assert_eq!(chunk.hash.len(), 16, "the hash is the asset hash width");
        assert_eq!(chunk.hash, crate::assets::asset_hash(chunk.json.as_bytes()));
        let value: serde_json::Value = serde_json::from_str(&chunk.json).expect("chunk JSON");
        assert_eq!(
            value
                .as_object()
                .map(|object| object.keys().map(String::as_str).collect::<Vec<_>>()),
            Some(vec!["blocks", "html", "id", "text", "title", "toc"])
        );
        assert_eq!(value["id"], "a.md");
        assert_eq!(
            value["text"], "A to b",
            "the chunk carries the text for local search"
        );

        // The corpus lists the same document with the pre-flattened headings.
        let corpus: serde_json::Value =
            serde_json::from_str(&rendered.search_json).expect("corpus JSON");
        assert_eq!(
            corpus["docs"][0]
                .as_object()
                .map(|object| object.keys().map(String::as_str).collect::<Vec<_>>()),
            Some(vec!["headings", "id", "text", "title"])
        );
        assert_eq!(corpus["docs"][0]["headings"], "A");

        // The manifest hash addresses the chunk, so the reader can bust caches.
        assert_eq!(manifest["docs"][0]["hash"], chunk.hash.as_str());
    }

    #[test]
    fn the_pages_render_keeps_asset_placeholders_for_the_writer() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("logo.svg"), "<svg/>").expect("write fixture");
        std::fs::write(dir.path().join("a.md"), "![logo](logo.svg)\n").expect("write fixture");
        let report = crate::scan::scan(dir.path(), &dir.path().join("dist")).expect("scan");
        let build = build_site("Site", dir.path(), &report.docs);
        let rendered = render_pages(&build.bundle).expect("render");

        assert!(
            rendered.chunks[0]
                .json
                .contains(crate::ASSET_PLACEHOLDER_PREFIX),
            "the writer expands placeholders, not the render stage: {}",
            rendered.chunks[0].json
        );
    }

    #[test]
    fn a_document_cannot_terminate_the_shell_payload_element() {
        let dir = tempfile::tempdir().expect("temp dir");
        let build = build_site(
            "Site",
            dir.path(),
            &[source(
                "a.md",
                "A",
                "# A\n\n</script><script>alert('x')</script>\n",
            )],
        );
        let rendered = render_pages(&build.bundle).expect("render");

        let payload = payload_of(&rendered.shell.html);
        assert!(!payload.contains("</script"));
        assert_eq!(
            rendered.shell.html.matches("</script>").count(),
            2,
            "only the payload element and the script bundle may close"
        );
    }

    #[test]
    fn the_pages_render_is_deterministic_and_lookup_finds_chunks() {
        let dir = tempfile::tempdir().expect("temp dir");
        let build = build_site(
            "Site",
            dir.path(),
            &[source("a.md", "A", "# A\n"), source("b.md", "B", "# B\n")],
        );

        let first = render_pages(&build.bundle).expect("render");
        let second = render_pages(&build.bundle).expect("render");

        assert_eq!(first, second);
        assert_eq!(
            first.chunk("a.md").map(|chunk| chunk.name.as_str()),
            Some("pages/a.md.json")
        );
        assert!(first.chunk("missing.md").is_none());
    }

    #[test]
    fn an_empty_site_renders_an_empty_manifest_and_corpus() {
        let dir = tempfile::tempdir().expect("temp dir");
        let build = build_site("Empty", dir.path(), &[]);

        let rendered = render_pages(&build.bundle).expect("render");

        assert!(rendered.chunks.is_empty());
        let manifest: serde_json::Value =
            serde_json::from_str(payload_of(&rendered.shell.html)).expect("manifest JSON");
        assert_eq!(manifest["docs"], serde_json::json!([]));
        let corpus: serde_json::Value =
            serde_json::from_str(&rendered.search_json).expect("corpus JSON");
        assert_eq!(corpus["docs"], serde_json::json!([]));
    }

    #[test]
    fn a_site_title_is_escaped_in_the_manifest() {
        let dir = tempfile::tempdir().expect("temp dir");
        let build = build_site("Site <One>", dir.path(), &[source("a.md", "A", "# A\n")]);

        let rendered = render_pages(&build.bundle).expect("render");

        let payload = payload_of(&rendered.shell.html);
        assert!(
            !payload.contains('<'),
            "the manifest never carries a raw angle bracket: {payload}"
        );
        let manifest: serde_json::Value = serde_json::from_str(payload).expect("manifest JSON");
        assert_eq!(manifest["title"], "Site <One>");
    }
}
