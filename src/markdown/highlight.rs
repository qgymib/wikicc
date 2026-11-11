//! Build-time syntax highlighting for code blocks.
//!
//! Highlighting runs once, while the site is compiled: the emitted HTML carries
//! `class` names only, and the matching stylesheet is generated once per site
//! from the same theme. The reader therefore ships no highlighter, no grammar
//! files and no runtime cost beyond the CSS rules it already downloads.
//!
//! Two themes, one per reader surface: `base16-ocean.dark` for the dark
//! reader and `base16-ocean.light` for the light one. The dark sheet is
//! global; the light sheet is scoped at build time to the two light paths the
//! reader's own stylesheet uses — the explicit `data-theme="light"` attribute
//! and the system-preference media query — so a reader who chose dark keeps
//! the dark palette even on a light system. Neither sheet paints a
//! background: the block surface stays with the reader's own tokens, and the
//! generated rules carry colours only.
//!
//! One fence is *not* code: ` ```mermaid ` is a diagram. It is routed before the
//! highlighter, so the block leaves the build as `<pre class="mermaid">` with
//! HTML-escaped source and the reader's bundled diagram engine turns it into
//! SVG in the browser. Highlighting it would only produce coloured nonsense.
//!
//! The syntax set and the theme are deserialised lazily from dumps compiled
//! into the binary, behind [`OnceLock`]. A site without code blocks never pays
//! for them, a site with thousands of blocks pays once, and a build never reads
//! a grammar file from disk or from the network. Both dumps are pinned by
//! `Cargo.lock`, so two builds of the same input stay byte-identical.

use std::borrow::Cow;
use std::sync::OnceLock;

use syntect::highlighting::{Theme, ThemeSet};
use syntect::html::{ClassStyle, ClassedHTMLGenerator, css_for_theme_with_class_style};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

/// Highlight theme of the dark reader.
pub const THEME_NAME: &str = "base16-ocean.dark";

/// Highlight theme of the light reader, scoped by [`light_theme_css`] to the
/// reader's two light paths.
pub const LIGHT_THEME_NAME: &str = "base16-ocean.light";

/// Class of the `<pre>` wrapper around every code block.
///
/// The value must stay `code`: `ClassStyle::Spaced` hard-codes `.code` as the
/// selector of the block-level rules that [`theme_css`] generates.
pub const CODE_CLASS: &str = "code";

/// Fence info string that marks a block as a diagram instead of code.
pub const MERMAID_FENCE: &str = "mermaid";

/// Class of the `<pre>` wrapper around a diagram block.
///
/// The reader looks for `pre.mermaid` and hands the element's `textContent` to
/// the diagram engine, which replaces the element's content with an SVG.
pub const MERMAID_CLASS: &str = "mermaid";

/// Lazily initialised highlighting resources, shared by the whole process.
struct HighlightAssets {
    syntaxes: SyntaxSet,
    theme: Theme,
    light_theme: Theme,
}

/// Load the syntax set and the theme on first use.
fn assets() -> &'static HighlightAssets {
    static ASSETS: OnceLock<HighlightAssets> = OnceLock::new();

    ASSETS.get_or_init(|| {
        let mut themes = ThemeSet::load_defaults();
        let theme = themes
            .themes
            .remove(THEME_NAME)
            .unwrap_or_else(|| panic!("the built-in syntect theme set has no `{THEME_NAME}`"));
        let light_theme = themes.themes.remove(LIGHT_THEME_NAME).unwrap_or_else(|| {
            panic!("the built-in syntect theme set has no `{LIGHT_THEME_NAME}`")
        });

        HighlightAssets {
            syntaxes: SyntaxSet::load_defaults_newlines(),
            theme,
            light_theme,
        }
    })
}

/// Canonical syntect syntax name for a fence info string, when it is known.
///
/// Returns e.g. `Rust` for `rust`/`rs` and `JavaScript` for `js`. `None` means
/// the fence is rendered as escaped plain text instead of being highlighted.
pub fn language_name(info: Option<&str>) -> Option<&'static str> {
    syntax_for(info).map(|syntax| syntax.name.as_str())
}

/// Resolve the syntax of a fence info string, matching a name or an extension.
fn syntax_for(info: Option<&str>) -> Option<&'static SyntaxReference> {
    let token = fence_token(info)?;
    assets().syntaxes.find_syntax_by_token(token)
}

/// Language token of a fence info string.
///
/// Only the first whitespace-delimited word is considered, and anything after a
/// comma is dropped, so ` ```rust `, ` ```rust title="a.rs" ` and the rustdoc
/// style ` ```rust,ignore ` all resolve to `rust`. An absent, empty or
/// whitespace-only info string yields `None`.
fn fence_token(info: Option<&str>) -> Option<&str> {
    let token = info?.split_whitespace().next()?;
    let token = token.split(',').next().unwrap_or(token);

    (!token.is_empty()).then_some(token)
}

/// The fence token restricted to characters that are safe in a class attribute.
///
/// Author input reaches this function verbatim, so everything outside
/// `[A-Za-z0-9_+.#-]` is dropped instead of escaped: a token like `"><script>`
/// becomes `script` and cannot terminate the attribute. `None` when nothing
/// survives, in which case no `language-*` class is emitted at all.
fn language_class(token: &str) -> Option<String> {
    let class: String = token
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '+' | '.' | '#'))
        .map(|ch| ch.to_ascii_lowercase())
        .collect();

    (!class.is_empty()).then_some(class)
}

/// Whether a fence info string asks for a diagram instead of code.
///
/// The comparison is ASCII case-insensitive and uses the same token rules as
/// the highlighter, so ` ```mermaid `, ` ```Mermaid ` and
/// ` ```mermaid title="flow" ` all match while ` ```mermaidx ` does not.
pub fn is_mermaid(info: Option<&str>) -> bool {
    fence_token(info).is_some_and(|token| token.eq_ignore_ascii_case(MERMAID_FENCE))
}

/// Full `<pre class="mermaid">…</pre>` markup for one diagram block.
///
/// The source is HTML-escaped like any other text content, so a diagram that
/// contains `-->` or `&&` cannot terminate the element; the browser decodes the
/// entities again, which means the engine receives exactly what the author
/// wrote. No `language-*` class is emitted: this block is not code.
///
/// The result always ends with a newline, like [`code_block_html`].
pub fn mermaid_block_html(code: &str) -> String {
    let mut html = String::with_capacity(code.len() + 32);
    html.push_str("<pre class=\"");
    html.push_str(MERMAID_CLASS);
    html.push_str("\">");
    escape_into(&mut html, code);
    html.push_str("</pre>\n");
    html
}

/// Full `<pre class="code"><code …>…</code></pre>` markup for one code block.
///
/// A recognised language is highlighted with [`ClassedHTMLGenerator`] and
/// `ClassStyle::Spaced`, so the stylesheet generated by [`theme_css`] applies.
/// An unknown or missing language, and any failure inside the highlighter,
/// degrade to HTML-escaped plain text: no spans, no diagnostics, no crash.
///
/// A [`MERMAID_FENCE`] block never reaches the highlighter: it is returned as
/// [`mermaid_block_html`] instead, so the diagram source survives verbatim.
///
/// The result always ends with a newline, which is what `push_html` expects
/// from a block-level `Event::Html`.
pub fn code_block_html(code: &str, info: Option<&str>) -> String {
    if is_mermaid(info) {
        return mermaid_block_html(code);
    }

    let token = fence_token(info);
    let class = token.and_then(language_class);
    let highlighted = token
        .and_then(|token| assets().syntaxes.find_syntax_by_token(token))
        .and_then(|syntax| highlight(code, syntax));

    let mut html = String::with_capacity(highlighted.as_ref().map_or(code.len(), String::len) + 64);
    html.push_str("<pre class=\"");
    html.push_str(CODE_CLASS);
    html.push_str("\"><code");
    if let Some(class) = class {
        html.push_str(" class=\"language-");
        html.push_str(&class);
        html.push('"');
    }
    html.push('>');

    match highlighted {
        Some(highlighted) => html.push_str(&highlighted),
        None => escape_into(&mut html, code),
    }

    html.push_str("</code></pre>\n");
    html
}

/// Class-based CSS for [`THEME_NAME`], generated once per process.
///
/// The shell injects this string exactly once per site; it is stable across
/// builds because it is derived from the theme dump alone.
pub fn theme_css() -> &'static str {
    static CSS: OnceLock<String> = OnceLock::new();

    CSS.get_or_init(|| {
        css_for_theme_with_class_style(&assets().theme, ClassStyle::Spaced)
            .expect("syntect must generate CSS for a built-in theme")
    })
}

/// Class-based CSS for [`LIGHT_THEME_NAME`], scoped to the reader's two light
/// paths, generated once per process.
///
/// The reader's stylesheet repeats its light tokens under both light paths —
/// the explicit `data-theme="light"` attribute and the system-preference
/// media query behind `:not([data-theme="dark"])` — and the generated rules
/// follow the same convention, one copy each. Both prefixes lift specificity
/// above the unscoped dark rules, and the media copy keeps the choice
/// honest: with `data-theme="dark"` set, `:not(...)` fails at the root and
/// the dark palette stays. Like [`theme_css`], the output is stable across
/// builds because it is derived from the theme dump alone.
pub fn light_theme_css() -> &'static str {
    static CSS: OnceLock<String> = OnceLock::new();

    CSS.get_or_init(|| {
        let raw = css_for_theme_with_class_style(&assets().light_theme, ClassStyle::Spaced)
            .expect("syntect must generate CSS for a built-in theme");

        let explicit = scoped_css(&raw, ":root[data-theme=\"light\"]");
        let system = scoped_css(&raw, ":root:not([data-theme=\"dark\"])");

        let mut css = String::with_capacity(explicit.len() + system.len() + 128);
        css.push_str("/* Code colours for the light reader, from `base16-ocean.light`.\n");
        css.push_str("   The block surface stays with the reader's own tokens, so the\n");
        css.push_str("   theme's background is not carried over. */\n\n");
        css.push_str(&explicit);
        css.push('\n');
        css.push_str("@media (prefers-color-scheme: light) {\n");
        css.push_str(&system);
        css.push_str("}\n");
        css
    })
}

/// Prefix every rule of a generated theme stylesheet with `scope`.
///
/// The generator's shape is pinned by `Cargo.lock`: a header comment, then one
/// rule per line — the base `.code` rule, then the scope rules whose selectors
/// are bare class lists, several of which share a line through a comma. Every
/// selector is prefixed on its own, so a comma can never carry a scoped colour
/// past its scope into the other reader. The base rule's `background-color` is
/// stripped on the way through: the reader's stylesheet controls the block
/// surface with its own tokens, in the dark reader as well as the light one.
/// Scope rules keep theirs — the theme pairs each with its own foreground, so
/// the pair reads on any surface.
fn scoped_css(raw: &str, scope: &str) -> String {
    let body = match raw.find("*/\n\n") {
        Some(end) => &raw[end + "*/\n\n".len()..],
        None => raw,
    };

    let mut out = String::with_capacity(body.len() + body.len() / 2);
    let mut in_base_rule = false;

    for line in body.lines() {
        if let Some(selectors) = line.strip_suffix(" {") {
            in_base_rule = selectors == ".code";

            let prefixed: Vec<String> = selectors
                .split(", ")
                .map(|selector| format!("{scope} {selector}"))
                .collect();
            out.push_str(&prefixed.join(", "));
            out.push_str(" {\n");
            continue;
        }

        if in_base_rule && line.trim_start().starts_with("background-color:") {
            continue;
        }

        out.push_str(line);
        out.push('\n');
    }

    out
}

/// Highlight one block, returning `None` if the highlighter rejects the input.
///
/// The caller falls back to escaped plain text, so a partial highlight is never
/// emitted: the generator writes into its own buffer and is discarded on error.
fn highlight(code: &str, syntax: &SyntaxReference) -> Option<String> {
    let code = normalize_newlines(code);
    let mut generator =
        ClassedHTMLGenerator::new_with_class_style(syntax, &assets().syntaxes, ClassStyle::Spaced);

    for line in LinesWithEndings::from(code.as_ref()) {
        generator
            .parse_html_for_line_which_includes_newline(line)
            .ok()?;
    }

    Some(generator.finalize())
}

/// Convert CRLF and lone CR to LF, the line ending the newline syntax set assumes.
fn normalize_newlines(code: &str) -> Cow<'_, str> {
    if code.contains('\r') {
        Cow::Owned(code.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(code)
    }
}

/// Escape text for HTML content, using the same set as the highlighter.
///
/// Besides code blocks, [`crate::markdown::refdefs`] reuses it for the
/// hand-built markup of a link reference definition, so author input can never
/// terminate an attribute or an element there either.
pub(crate) fn escape_into(out: &mut String, code: &str) {
    for ch in code.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    /// A Rust block whose highlighting is unambiguous.
    const RUST: &str = "fn main() {\n    let x = 1;\n}\n";

    #[test]
    fn maps_names_and_extensions_to_canonical_syntaxes() {
        assert_eq!(language_name(Some("rust")), Some("Rust"));
        assert_eq!(language_name(Some("rs")), Some("Rust"));
        assert_eq!(language_name(Some("Rust")), Some("Rust"));
        assert_eq!(language_name(Some("js")), Some("JavaScript"));
        assert_eq!(language_name(Some("javascript")), Some("JavaScript"));
    }

    #[test]
    fn accepts_info_strings_with_extra_tokens() {
        assert_eq!(language_name(Some("rust,ignore")), Some("Rust"));
        assert_eq!(
            language_name(Some("  rust   title=\"a.rs\" ")),
            Some("Rust")
        );
    }

    #[test]
    fn unknown_and_absent_languages_have_no_syntax() {
        assert_eq!(language_name(Some("foo")), None);
        assert_eq!(language_name(Some("")), None);
        assert_eq!(language_name(Some("   ")), None);
        assert_eq!(language_name(None), None);
    }

    #[test]
    fn known_fence_is_wrapped_and_highlighted() {
        let html = code_block_html(RUST, Some("rust"));

        assert!(
            html.starts_with("<pre class=\"code\"><code class=\"language-rust\">"),
            "html: {html}"
        );
        assert!(html.ends_with("</code></pre>\n"), "html: {html}");
        assert!(html.contains("<span class=\""), "html: {html}");
        assert!(html.contains("fn"), "html: {html}");
    }

    #[test]
    fn extension_fence_keeps_the_written_token_in_the_class() {
        let html = code_block_html("const x = 1;\n", Some("js"));

        assert!(
            html.contains("<code class=\"language-js\">"),
            "html: {html}"
        );
        assert!(html.contains("<span class=\""), "html: {html}");
    }

    #[test]
    fn unknown_fence_falls_back_to_escaped_text() {
        let html = code_block_html("a < b && c > d\n", Some("foo"));

        assert!(
            html.starts_with("<pre class=\"code\"><code class=\"language-foo\">"),
            "html: {html}"
        );
        assert!(!html.contains("<span"), "html: {html}");
        assert!(
            html.contains("a &lt; b &amp;&amp; c &gt; d"),
            "html: {html}"
        );
    }

    #[test]
    fn mermaid_fence_becomes_a_diagram_block() {
        let html = code_block_html("graph TD; A-->B;\n", Some("mermaid"));

        assert_eq!(
            html, "<pre class=\"mermaid\">graph TD; A--&gt;B;\n</pre>\n",
            "html: {html}"
        );
        assert!(!html.contains("<span"), "html: {html}");
        assert!(!html.contains("language-"), "html: {html}");
        assert!(!html.contains("class=\"code\""), "html: {html}");
    }

    #[test]
    fn mermaid_fence_token_ignores_case_and_extra_words() {
        for info in [
            "Mermaid",
            "MERMAID",
            "mermaid title=\"flow\"",
            "mermaid,ignore",
        ] {
            assert!(is_mermaid(Some(info)), "{info} must route to a diagram");
            assert!(
                code_block_html("graph TD;\n", Some(info)).starts_with("<pre class=\"mermaid\">"),
                "{info} must not be highlighted"
            );
        }
    }

    #[test]
    fn mermaid_lookalike_fences_stay_code() {
        for info in ["mermaidx", "mermaid-diagram", "flowchart"] {
            assert!(!is_mermaid(Some(info)), "{info} is not a diagram fence");
            assert!(
                code_block_html("x\n", Some(info)).starts_with("<pre class=\"code\">"),
                "{info} must stay a code block"
            );
        }
    }

    #[test]
    fn absent_or_empty_info_is_not_a_diagram() {
        assert!(!is_mermaid(None));
        assert!(!is_mermaid(Some("")));
        assert!(!is_mermaid(Some("   ")));
    }

    #[test]
    fn mermaid_source_is_escaped_but_otherwise_verbatim() {
        let html = mermaid_block_html("A --> B & C < D \"q\" 'r'\n");

        assert!(
            html.contains("A --&gt; B &amp; C &lt; D &quot;q&quot; &#39;r&#39;"),
            "html: {html}"
        );
        assert!(!html.contains("A -->"), "the arrow must be escaped: {html}");
        assert!(
            !html.contains("< D"),
            "the comparison must be escaped: {html}"
        );
    }

    #[test]
    fn empty_mermaid_block_still_produces_a_wrapper() {
        assert_eq!(mermaid_block_html(""), "<pre class=\"mermaid\"></pre>\n");
    }

    #[test]
    fn mermaid_routing_is_deterministic() {
        assert_eq!(
            code_block_html("graph TD;\n", Some("mermaid")),
            code_block_html("graph TD;\n", Some("mermaid"))
        );
    }

    #[test]
    fn the_mermaid_constants_match_the_reader_contract() {
        assert_eq!(MERMAID_FENCE, "mermaid");
        assert_eq!(MERMAID_CLASS, "mermaid");
        assert_eq!(
            mermaid_block_html("x"),
            "<pre class=\"mermaid\">x</pre>\n",
            "the reader selects `pre.mermaid`"
        );
    }

    #[test]
    fn fence_without_info_string_has_no_language_class() {
        let html = code_block_html("plain\n", None);

        assert!(
            html.starts_with("<pre class=\"code\"><code>"),
            "html: {html}"
        );
        assert!(!html.contains("language-"), "html: {html}");
    }

    #[test]
    fn info_string_cannot_escape_the_class_attribute() {
        let html = code_block_html("x\n", Some("\"><script>alert(1)</script>"));

        assert!(!html.contains("<script"), "html: {html}");
        assert!(!html.contains("\">\""), "html: {html}");
        assert!(
            html.contains("<code class=\"language-scriptalert1script\">"),
            "html: {html}"
        );
    }

    #[test]
    fn quotes_inside_code_are_escaped() {
        let html = code_block_html("let s = \"a & b\"; // it's\n", Some("foo"));

        assert!(html.contains("&quot;a &amp; b&quot;"), "html: {html}");
        assert!(html.contains("it&#39;s"), "html: {html}");
        assert!(!html.contains("\"a & b\""), "html: {html}");
    }

    #[test]
    fn empty_block_still_produces_a_wrapper() {
        let html = code_block_html("", Some("rust"));

        assert_eq!(
            html,
            "<pre class=\"code\"><code class=\"language-rust\"></code></pre>\n"
        );
    }

    #[test]
    fn crlf_input_is_highlighted_as_lf() {
        let html = code_block_html("fn main() {\r\n    let x = 1;\r\n}\r\n", Some("rust"));

        assert!(!html.contains('\r'), "html: {html}");
        assert!(html.contains("<span class=\""), "html: {html}");
    }

    #[test]
    fn highlighting_is_deterministic() {
        assert_eq!(
            code_block_html(RUST, Some("rust")),
            code_block_html(RUST, Some("rust"))
        );
    }

    #[test]
    fn theme_css_is_non_empty_and_scoped_to_the_code_class() {
        let css = theme_css();

        assert!(css.contains(".code {"), "css: {css}");
        assert!(css.contains("background-color:"), "css: {css}");
        assert!(css.contains("color: #"), "css: {css}");
        assert!(
            css.len() > 1_000,
            "css is suspiciously small: {}",
            css.len()
        );
        assert!(
            css.matches(" {\n").count() > 40,
            "expected many scope rules, got {}",
            css.matches(" {\n").count()
        );
    }

    #[test]
    fn theme_css_is_generated_once() {
        let first = theme_css();
        let second = theme_css();

        assert!(std::ptr::eq(first, second), "CSS must come from the cache");
    }

    #[test]
    fn light_theme_css_is_scoped_to_both_light_paths() {
        let css = light_theme_css();

        assert!(
            css.contains(":root[data-theme=\"light\"] .code {"),
            "css: {css}"
        );
        assert!(
            css.contains("@media (prefers-color-scheme: light) {"),
            "css: {css}"
        );
        assert!(
            css.contains(":root:not([data-theme=\"dark\"]) .code {"),
            "css: {css}"
        );

        // Every selector of every rule carries a scope — a bare selector line
        // would leak the light palette into the dark reader. The `@media` block
        // opens the one brace the check must let through.
        for line in css.lines() {
            if line.ends_with(" {") && !line.starts_with("@media") {
                assert!(
                    line.starts_with(":root[data-theme=\"light\"] ")
                        || line.starts_with(":root:not([data-theme=\"dark\"]) "),
                    "a selector escaped the light scope: {line}"
                );
            }
        }
    }

    #[test]
    fn both_light_paths_carry_the_same_rules() {
        let css = light_theme_css();

        // Every selector carries its scope prefix exactly once, so counting
        // the prefixes counts the rules each path ships.
        let explicit = css.matches(":root[data-theme=\"light\"] ").count();
        let system = css.matches(":root:not([data-theme=\"dark\"]) ").count();

        assert!(
            explicit > 40,
            "expected the full rule set in both paths, got {explicit}"
        );
        assert_eq!(explicit, system, "css: {css}");
    }

    #[test]
    fn light_theme_css_keeps_the_surface_with_the_tokens() {
        let css = light_theme_css();

        for marker in [
            ":root[data-theme=\"light\"] .code {",
            ":root:not([data-theme=\"dark\"]) .code {",
        ] {
            let start = css.find(marker).unwrap_or_else(|| panic!("css lacks {marker}"));
            let rule = css[start..].split('}').next().expect("a rule has a body");

            assert!(
                !rule.contains("background-color"),
                "the block surface belongs to the reader's tokens: {rule}"
            );
        }
    }

    #[test]
    fn light_and_dark_plain_text_colours_differ() {
        let dark = plain_text_color(theme_css()).expect("dark css has a base colour");
        let light = plain_text_color(light_theme_css()).expect("light css has a base colour");

        assert_ne!(dark, light, "the light reader needs its own palette");
    }

    #[test]
    fn light_theme_css_is_generated_once() {
        let first = light_theme_css();
        let second = light_theme_css();

        assert!(std::ptr::eq(first, second), "CSS must come from the cache");
    }

    /// The `color:` value of the first base `.code` rule, without the `#`.
    fn plain_text_color(css: &str) -> Option<&str> {
        let body = css.split(".code {").nth(1)?;
        let body = body.split('}').next()?;
        let value = body.split("color: #").nth(1)?;

        value.split(';').next()
    }

    #[test]
    fn assets_are_initialised_once() {
        assert!(std::ptr::eq(assets(), assets()));
        assert_eq!(language_name(Some("rust")), Some("Rust"));
        assert!(std::ptr::eq(assets(), assets()));
    }

    #[test]
    fn a_five_thousand_line_block_stays_fast() {
        let mut code = String::with_capacity(5000 * 24);
        for index in 0..5000 {
            code.push_str(&format!("let value_{index} = {index};\n"));
        }

        // Warm the lazily initialised assets so the measurement covers
        // highlighting alone, not the one-off dump deserialisation.
        code_block_html("fn main() {}\n", Some("rust"));

        let started = Instant::now();
        let html = code_block_html(&code, Some("rust"));
        let elapsed = started.elapsed();

        assert!(html.contains("<span class=\""), "html must be highlighted");
        assert!(
            elapsed < Duration::from_secs(2),
            "highlighting 5000 lines took {elapsed:?}"
        );
    }
}
