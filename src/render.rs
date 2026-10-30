//! Shell assembly: the template, the styles, the scripts and the payload.
//!
//! This is the `render` stage described in `docs/DESIGN.md`. It turns a
//! [`SiteBundle`] into the single HTML document every writer starts from, so the
//! three output formats differ only in how asset placeholders are addressed and
//! never in the page itself.
//!
//! Everything the page needs is inlined, because the product has to work from
//! `file://`, where `fetch` of a sibling JSON file is blocked by CORS and a
//! classic script is the only reliable way to load code:
//!
//! The skeleton in `web/index.html.tmpl` is rendered with `minijinja`, so the
//! page markup stays in HTML and escaping is the engine's job:
//!
//! - `{{ css|safe }}` is `web/css/app.css` followed by the theme CSS the
//!   build-time highlighter generates;
//! - `{{ js|safe }}` is the single IIFE bundle that `build.rs` produces with
//!   esbuild from `web/js/main.js` (the reader modules plus the npm-installed
//!   engine), so the page needs no module loader and resolves nothing at
//!   runtime;
//! - `{{ payload|safe }}` is the bundle JSON, escaped so a document that
//!   contains `</script>` cannot terminate the script element;
//! - `{{ title }}` is the site title, escaped by the engine's HTML auto-escaper.
//!
//! Determinism: the template is compiled from a constant, the concatenation
//! order is fixed, nothing is sorted at render time, and no value depends on
//! the clock, the host or the file system order. Two builds of the same input
//! therefore produce byte-identical HTML.

use std::sync::OnceLock;

use minijinja::{Environment, UndefinedBehavior, context};

use crate::error::{Error, Result};
use crate::markdown::highlight::theme_css;
use crate::site::SiteBundle;

/// Page skeleton, with the four template variables below.
pub const SHELL_TEMPLATE: &str = include_str!("web/index.html.tmpl");

/// Name the skeleton is registered under.
///
/// `minijinja` derives the auto-escape mode from the template name, so the
/// `.html` suffix is what makes `{{ title }}` escape HTML while the `|safe`
/// values are injected verbatim.
const TEMPLATE_NAME: &str = "index.html";

/// Reader styles, without the highlighting theme.
pub const SHELL_CSS: &str = include_str!("web/css/app.css");

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
    /// into `data:` URIs, `assets/…` paths or `cid:` references is the job of
    /// the writers, which is the only thing the three formats differ in.
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

/// Reader stylesheet: the hand-written rules plus the highlighting theme.
///
/// Both are static, so the concatenation is built once and shared.
pub fn shell_css() -> &'static str {
    static CSS: OnceLock<String> = OnceLock::new();

    CSS.get_or_init(|| {
        let mut css = String::with_capacity(SHELL_CSS.len() + theme_css().len() + 1);
        css.push_str(SHELL_CSS);
        css.push('\n');
        css.push_str(theme_css());
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
        assert!(!css.contains("</style"));
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
}
