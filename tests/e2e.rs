//! End-to-end assertions for the reader.
//!
//! Two layers live here:
//!
//! - the first half observes the page through the library pipeline
//!   (`scan` → `build_site` → `render_site`), which is where the markup, the
//!   payload and the bundled script are asserted;
//! - the second half drives the compiled binary, which is the only way to check
//!   the artifacts of the three formats, the reproducibility of a build, the
//!   `--strict` gate and the exit codes.
//!
//! Both halves use the committed fixtures under `tests/fixtures`, so the suite
//! needs no network access: `npm ci` has already staged the front-end
//! dependencies the bundle is built from.

use std::path::{Path, PathBuf};

use assert_cmd::Command;

use wikicc::options::OutputFormat;
use wikicc::scan::scan;
use wikicc::site::build_site;
use wikicc::writers::{ASSETS_DIR_NAME, HTML_FILE_NAME};
use wikicc::{APP_BUNDLE, RenderedSite, SHELL_CSS, SiteBundle, render_site, theme_css};

/// Prefix of the opaque asset placeholder the writers replace.
const ASSET_PREFIX: &str = "wikicc-asset:";

/// Start of the element that carries the payload.
const PAYLOAD_OPEN: &str = r#"<script id="wikicc-payload" type="application/json">"#;

/// The committed site fixture, which is `--strict` clean.
fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("site")
}

/// Scan `root` and assemble its payload, exactly as the binary does.
fn build(root: &Path, title: &str) -> SiteBundle {
    let report = scan(root, &root.join("dist")).expect("scan");
    build_site(title, root, &report.docs).bundle
}

fn render(bundle: &SiteBundle) -> RenderedSite {
    render_site(bundle).expect("the shell renders")
}

/// Payload text embedded in a rendered page.
fn payload_of(html: &str) -> &str {
    let start = html.find(PAYLOAD_OPEN).expect("payload element") + PAYLOAD_OPEN.len();
    let end = html[start..].find("</script>").expect("payload end") + start;

    &html[start..end]
}

#[test]
fn the_page_carries_every_required_marker() {
    let page = render(&build(&fixture_root(), "Fixture"));

    for marker in [
        r#"id="doc-list""#,
        r#"id="doc-content""#,
        r#"id="graph""#,
        r#"id="graph-fit""#,
        r#"id="toc""#,
        r#"id="theme-toggle""#,
        r#"id="search-toggle""#,
        r#"id="search-panel""#,
        r#"id="wikicc-payload""#,
    ] {
        assert!(page.html.contains(marker), "missing {marker}");
    }

    assert!(
        !page.html.contains(r#"id="doc-filter""#),
        "the sidebar carries no permanent search field: searching is the panel's job"
    );
}

#[test]
fn the_search_button_lives_in_the_top_toolbar() {
    let page = render(&build(&fixture_root(), "Fixture"));

    // Searching belongs to the whole reader, not to one panel: the button is
    // the top bar's own control, and the panel it opens is a child of the app
    // that follows the inspector instead of living inside the graph panel.
    let bar = page.html.find(r#"class="topbar""#).expect("top bar");
    let button = page
        .html
        .find(r#"id="search-toggle""#)
        .expect("search button");
    let panel = page
        .html
        .find(r#"id="search-panel""#)
        .expect("search panel");
    let graph = page
        .html
        .find(r#"<div class="graph" id="graph">"#)
        .expect("graph box");

    assert!(bar < button, "the button belongs to the top bar");
    assert!(button < panel, "the panel follows the button that opens it");
    assert!(
        graph < panel,
        "the panel is a sibling of the panels, not a child of the graph panel"
    );
    assert!(
        !page.html.contains("graph-toolbar"),
        "the graph panel no longer carries a search row"
    );
    assert!(
        page.html.contains(r#"aria-controls="search-panel""#),
        "the button names the panel it controls"
    );
    assert!(
        page.html.contains(r#"aria-expanded="false""#),
        "the button starts out describing a closed panel"
    );
}

#[test]
fn the_theme_switch_sits_beside_search_in_the_top_bar() {
    let page = render(&build(&fixture_root(), "Fixture"));

    // The theme is an app-level control like search, so it belongs at the far
    // end of the top bar, after the button it sits beside. The sidebar header
    // is left holding nothing but the site title.
    let bar = page.html.find(r#"class="topbar""#).expect("top bar");
    let search = page.html.find(r#"id="search-toggle""#).expect("search button");
    let theme = page.html.find(r#"id="theme-toggle""#).expect("theme button");
    let header = page.html.find(r#"class="sidebar-header""#).expect("sidebar header");
    let header_end = page.html[header..]
        .find("</header>")
        .expect("sidebar header end")
        + header;

    assert!(bar < search, "search belongs to the top bar");
    assert!(search < theme, "the theme switch is the bar's last control");
    assert!(
        !page.html[header..header_end].contains("theme-toggle"),
        "the sidebar header keeps nothing but the site title"
    );
}

#[test]
fn the_page_is_a_utf8_html_document() {
    let page = render(&build(&fixture_root(), "Fixture"));

    assert!(page.html.starts_with("<!DOCTYPE html>"));
    assert!(page.html.contains(r#"<meta charset="utf-8">"#));
    assert!(page.html.contains(r#"<html lang="en">"#));
}

#[test]
fn the_payload_is_embedded_and_parses() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);
    let value: serde_json::Value =
        serde_json::from_str(payload_of(&page.html)).expect("payload is valid JSON");

    assert_eq!(value["title"], "Fixture");
    assert_eq!(value["docs"].as_array().map(Vec::len), Some(3));
    assert_eq!(value["edges"].as_array().map(Vec::len), Some(3));
    assert_eq!(value["docs"][0]["id"], "README.md");
    assert_eq!(
        value["stats"]["documents"].as_u64(),
        Some(bundle.docs.len() as u64)
    );
}

#[test]
fn the_payload_is_escaped_for_the_script_element() {
    let page = render(&build(&fixture_root(), "Fixture"));
    let payload = payload_of(&page.html);

    assert!(!payload.contains('<'), "the payload must not carry raw '<'");
    assert!(!payload.contains("</script"));
    assert_eq!(
        page.html.matches("</script>").count(),
        2,
        "only the payload element and the script bundle may close"
    );
}

#[test]
fn assets_stay_as_placeholders_for_the_writers() {
    let page = render(&build(&fixture_root(), "Fixture"));

    assert!(
        page.html.contains(ASSET_PREFIX),
        "the writers address assets through {ASSET_PREFIX}<hash>"
    );
}

#[test]
fn tables_are_emitted_and_hooked_for_enhancement() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);
    let readme = bundle.doc("README.md").expect("README is compiled");

    // The document HTML lives inside the payload, where `<` is escaped as
    // `\u003c`, so the table is asserted on the bundle rather than the page.
    assert!(readme.html.contains("<table"), "html: {}", readme.html);
    assert!(readme.html.contains("<thead>"), "html: {}", readme.html);
    assert!(
        page.html.contains("data-wikicc-table"),
        "the table enhancement must be bundled into the page"
    );
    assert!(
        page.html.contains("No matching rows"),
        "the empty-filter placeholder must be bundled into the page"
    );
    assert!(
        page.html.contains("table-filter-toggle"),
        "the per-column filter button must be bundled into the page"
    );
    assert!(
        page.html.contains("Search values"),
        "the filter panel's value search must be bundled into the page"
    );
    assert!(
        page.html.contains("table-filter-confirm"),
        "the filter panel's commit button must be bundled into the page"
    );
    assert!(
        page.html.contains("Apply"),
        "the filter panel must expose the label of its commit button"
    );
}

#[test]
fn the_link_graph_is_rendered_by_the_page_instead_of_a_placeholder() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);

    assert!(
        !page
            .html
            .contains("The link graph is not available in this build."),
        "the placeholder hint must be gone once the graph is implemented"
    );

    // The graph is built at runtime from the payload, so the page only has to
    // carry the renderer and the hooks it looks for. The layout engine itself
    // is proven by `build.rs`, which cannot produce a bundle without it.
    for marker in [
        "graph-node",
        "graph-edge",
        "graph-label",
        "graph-viewport",
        "wikicc-graph-arrow",
    ] {
        assert!(
            page.html.contains(marker),
            "the graph module is missing {marker}"
        );
    }

    assert_eq!(
        bundle.edges.len(),
        3,
        "the fixture has three edges for the graph to draw"
    );
}

/// The declarations of one rule, `selector` included, without needing a real
/// CSS parser: the sheet is hand-written in one declaration per line, so the
/// block is the text between its opening brace and the next closing one.
fn rule_of<'a>(css: &'a str, selector: &str) -> &'a str {
    let start = css.find(selector).unwrap_or_else(|| panic!("no {selector}"));
    let open = css[start..].find('{').expect("rule body") + start;
    let close = css[open..].find('}').expect("rule end") + open;

    &css[start..close]
}

/// The last declaration of `property` in a block, which is the one a cascade
/// inside the block would apply.
fn declaration<'a>(block: &'a str, property: &str) -> Option<&'a str> {
    block
        .lines()
        .filter_map(|line| {
            let (name, value) = line.trim_end_matches(';').trim().split_once(':')?;
            (name == property).then(|| value.trim())
        })
        .next_back()
}

#[test]
fn the_toolbar_is_painted_as_the_head_of_the_panel_column() {
    // On a wide screen the top bar is not a strip laid across the panel column
    // but the head of it: same surface, same left rule, no rule across the join.
    // Asserted as a contract because the seam it removes is invisible once it
    // is wrong — only a hue step and a broken vertical line remain.
    let css = SHELL_CSS;

    assert!(
        css.contains("--shell-top:") && css.contains("--shell-bottom:"),
        "the column surface is defined by shared tokens"
    );
    assert!(
        css.contains("--shell-line:"),
        "the column's left rule has a token of its own"
    );
    assert_eq!(
        css.matches("--shell-top:").count(),
        3,
        "dark, explicit light and system light each declare the column surface"
    );

    let bar = rule_of(css, ".topbar {");
    assert_eq!(
        declaration(bar, "border-left").as_deref(),
        Some("1px solid var(--shell-line)"),
        "the column's left rule starts at the top of the bar, not under it"
    );
    assert_eq!(
        declaration(bar, "border-bottom"),
        None,
        "a rule across the column would draw the seam the shared surface removes"
    );
    assert!(
        declaration(bar, "background").is_some_and(|value| value.contains("--shell-top")),
        "the bar carries the column's own surface: {bar}"
    );
    assert_eq!(
        declaration(bar, "padding").as_deref(),
        Some("0 calc(16px + var(--panel-gutter, 8px)) 0 16px"),
        "the bar's right edge meets the panels' stable-gutter edge, scrollbar or not"
    );
}

#[test]
fn the_narrow_toolbar_goes_back_to_being_a_strip() {
    // Below the inspector's width the bar lies across content that scrolls
    // under it, so the strip, its bottom rule and its blur come back and the
    // column's left rule goes away with the column.
    let css = SHELL_CSS;
    let narrow = media_block(css, "max-width: 900px");
    let bar = rule_of(narrow, ".topbar {");

    assert_eq!(
        declaration(bar, "border-left").as_deref(),
        Some("0"),
        "nothing is that edge any more"
    );
    assert!(
        declaration(bar, "border-bottom").is_some(),
        "a strip over moving content needs a rule under it: {bar}"
    );
    assert_eq!(
        declaration(bar, "background").as_deref(),
        Some("var(--bg-panel)"),
        "the strip keeps its own translucent surface"
    );
    assert_eq!(
        declaration(bar, "backdrop-filter").as_deref(),
        Some("blur(16px)"),
        "and the blur that lets the page show through it"
    );
}

#[test]
fn the_bar_and_the_panels_share_one_right_axis() {
    // The inspector's scrollbar would steal 8px of the panels' right edge only
    // while the content overflows, drifting that edge away from the top bar's
    // buttons as documents change height. A stable gutter pins the edge, and
    // the bar pads by the same total, so the two right ends meet in every
    // scroll state.
    let css = SHELL_CSS;

    let inspector = main_inspector_rule(css);
    assert_eq!(
        declaration(inspector, "scrollbar-gutter").as_deref(),
        Some("stable"),
        "the panels' right edge holds still whether or not the scrollbar shows"
    );
    let bar = rule_of(css, ".topbar {");
    assert_eq!(
        declaration(bar, "padding").as_deref(),
        Some("0 calc(16px + var(--panel-gutter, 8px)) 0 16px"),
        "the bar's right padding is the panels' padding plus one gutter"
    );

    // Both concessions are wide-screen furniture: the collapsed inspector no
    // longer scrolls and the strip lies across the whole width again.
    let narrow = media_block(css, "max-width: 900px");
    let bar = rule_of(narrow, ".topbar {");
    assert_eq!(
        declaration(bar, "padding-right").as_deref(),
        Some("16px"),
        "the full-width strip returns to the plain 16px axis"
    );
    let inspector = rule_of(narrow, ".inspector {");
    assert_eq!(
        declaration(inspector, "scrollbar-gutter").as_deref(),
        Some("auto"),
        "the collapsed panel reserves no empty strip"
    );

    // The narrowest width narrows the panels' padding, and the bar follows it.
    let smallest = media_block(css, "max-width: 640px");
    let bar = rule_of(smallest, ".topbar {");
    assert_eq!(
        declaration(bar, "padding-right").as_deref(),
        Some("14px"),
        "the bar keeps meeting the panels at 14px here"
    );
}

#[test]
fn the_search_panel_opens_as_a_centered_dialog() {
    // The reader asked the whole reader to find something, so the panel is a
    // dialog that takes most of the page and sits in its middle — not the
    // corner drop-down it once was. `inset` plus `margin: auto` is what
    // centres a fixed box without transforms, which the opening animation
    // keeps for itself.
    let css = SHELL_CSS;
    let panel = rule_of(css, ".search-panel {");

    assert_eq!(declaration(panel, "position").as_deref(), Some("fixed"));
    assert_eq!(declaration(panel, "inset").as_deref(), Some("0"));
    assert_eq!(declaration(panel, "margin").as_deref(), Some("auto"));

    let width = declaration(panel, "width").expect("panel width");
    assert!(
        width.starts_with("min(") && width.contains("96vw"),
        "the dialog spans nearly the whole viewport: {width}"
    );
    let height = declaration(panel, "height").expect("panel height");
    assert!(
        height.starts_with("min(") && height.contains("92vh"),
        "the dialog fills nearly all of the viewport's height: {height}"
    );

    // While the dialog is up, one translucent layer sits between the reader
    // and the page: the app's own pseudo-element, keyed on the open panel, a
    // layer under the dialog itself.
    let dim = ".app:has(.search-panel:not([hidden]))::after";
    let backdrop = rule_of(css, &format!("{dim} {{"));
    assert_eq!(
        declaration(backdrop, "position").as_deref(),
        Some("fixed"),
        "the dim covers the viewport, not the app's box"
    );
    let layer: u32 = declaration(backdrop, "z-index")
        .expect("dim layer")
        .parse()
        .expect("numeric z-index");
    let panel_layer: u32 = declaration(panel, "z-index")
        .expect("panel layer")
        .parse()
        .expect("numeric z-index");
    assert!(layer < panel_layer, "the dialog stays above the dim");

    // Light themes dim with a lighter hand, in both the explicit and the
    // system-following variant; printing takes the dim away with the panel.
    assert_eq!(
        css.matches(dim).count(),
        4,
        "dark, explicit light, system light and the print opt-out declare the dim"
    );
    assert!(css.contains(&format!(":root[data-theme=\"light\"] {dim}")));
    assert!(css.contains(&format!(":root:not([data-theme=\"dark\"]) {dim}")));

    // Down the breakpoints the dialog keeps a fixed margin instead of a share
    // of the viewport, so the smaller the window the closer it is to filling
    // it.
    let narrow = media_block(css, "max-width: 900px");
    let panel = rule_of(narrow, ".search-panel {");
    assert_eq!(
        declaration(panel, "width").as_deref(),
        Some("calc(100vw - 16px)"),
        "the dialog fills the narrow screen but for one margin"
    );
    assert_eq!(declaration(panel, "height").as_deref(), Some("calc(100vh - 16px)"));

    let smallest = media_block(css, "max-width: 640px");
    let panel = rule_of(smallest, ".search-panel {");
    assert_eq!(
        declaration(panel, "width").as_deref(),
        Some("calc(100vw - 12px)"),
        "the smallest screens shrink the margin, not the dialog"
    );
    assert_eq!(declaration(panel, "height").as_deref(), Some("calc(100dvh - 12px)"));
    assert_eq!(declaration(panel, "border-radius").as_deref(), Some("12px"));
}

#[test]
fn the_search_panel_splits_itself_between_what_it_found() {
    // The list and the preview are one answer read twice — which documents,
    // and where in one of them — so the dialog gives them the same half of
    // itself instead of letting the list take almost all of it. Both grow from
    // a zero basis, and neither may state a cap of its own.
    let css = SHELL_CSS;
    let results = rule_of(css, ".search-results {");
    let preview = rule_of(css, ".search-preview {");

    assert_eq!(
        declaration(results, "flex").as_deref(),
        Some("1 1 0"),
        "the list takes an even share of the dialog"
    );
    assert_eq!(
        declaration(preview, "flex").as_deref(),
        Some("1 1 0"),
        "the preview takes the same share as the list"
    );
    assert_eq!(
        declaration(preview, "max-height"),
        None,
        "no share of the dialog is reserved for the list"
    );

    // An empty half names itself in its own middle, and that label leaves as
    // soon as the half holds something.
    let empty = rule_of(css, ".search-empty {");
    assert_eq!(declaration(empty, "display").as_deref(), Some("flex"));
    assert_eq!(declaration(empty, "align-items").as_deref(), Some("center"));
    assert_eq!(
        declaration(empty, "justify-content").as_deref(),
        Some("center"),
        "the label is centred across the half it describes"
    );
}

/// The main `.inspector` rule, found by its position: the sheet declares
/// `.inspector` four times — an early grid-placement rule, the main one that
/// carries the scroll behaviour, and the two breakpoint overrides. The main
/// rule is the second occurrence, so the search starts after the first.
fn main_inspector_rule(css: &str) -> &str {
    let first = css.find(".inspector {").expect("inspector rule");
    let main_rule = css[first + 1..]
        .find(".inspector {")
        .expect("main inspector rule")
        + first
        + 1;

    rule_of(&css[main_rule..], ".inspector {")
}

#[test]
fn the_toolbar_icons_stay_compact() {
    // The bar's round buttons are quiet furniture at the far end of the column:
    // a small box with a glyph one step inside it, so the controls read as part
    // of the strip instead of competing with the panels below.
    let css = SHELL_CSS;

    let button = rule_of(css, ".icon-button {");
    assert_eq!(
        declaration(button, "width").as_deref(),
        Some("28px"),
        "the round buttons are 28px boxes"
    );
    assert_eq!(
        declaration(button, "height").as_deref(),
        Some("28px"),
        "the round buttons are 28px boxes"
    );

    let glyph = rule_of(css, ".icon-button svg {");
    assert_eq!(
        declaration(glyph, "width").as_deref(),
        Some("14px"),
        "the glyph sits one step inside the box"
    );
    assert_eq!(
        declaration(glyph, "height").as_deref(),
        Some("14px"),
        "the glyph sits one step inside the box"
    );
}

#[test]
fn the_column_opens_with_the_panels_own_gap() {
    // The air under the bar's buttons is the same air the panels are held
    // apart by: the 52px bar centres its 28px buttons and leaves 12px under
    // them, so the column opens with the remaining 2px of the 14px gap.
    let css = SHELL_CSS;
    let inspector = main_inspector_rule(css);

    assert_eq!(
        declaration(inspector, "gap").as_deref(),
        Some("14px"),
        "the panels are held apart by the column's rhythm"
    );
    assert_eq!(
        declaration(inspector, "padding").as_deref(),
        Some("2px 16px 18px"),
        "the column carries only the gap's remainder below the bar's buttons"
    );
}

/// The body of the first `@media (...)` whose condition contains `query`.
fn media_block<'a>(css: &'a str, query: &str) -> &'a str {
    let start = css
        .find(query)
        .unwrap_or_else(|| panic!("no @media {query}"));
    let open = css[start..].find('{').expect("media body") + start;
    let mut depth = 0usize;

    for (offset, ch) in css[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;

                if depth == 0 {
                    return &css[open..offset + open];
                }
            }
            _ => {}
        }
    }

    panic!("@media {query} is never closed")
}

#[test]
fn the_highlighting_theme_is_injected_exactly_once() {
    let page = render(&build(&fixture_root(), "Fixture"));

    assert_eq!(page.html.matches(theme_css()).count(), 1);
    assert_eq!(page.html.matches("</style>").count(), 1);
}

#[test]
fn the_engines_and_the_reader_are_embedded_in_one_script() {
    let page = render(&build(&fixture_root(), "Fixture"));

    assert_eq!(
        page.html.matches("<script>").count(),
        1,
        "the reader must be inlined as a single classic script"
    );
    // The bundle is minified, so identifiers are not asserted; string literals
    // and attribute names are, because esbuild leaves both alone.
    for marker in [
        "wikicc-payload",      // the bootstrap reads the embedded payload
        "data-wikicc-table",   // the table enhancer is bundled
        "table-filter-toggle", // ... with its per-column filter buttons
        "graph-node",          // the link graph renderer is bundled
        "startOnLoad",         // the diagram engine is configured
        "data-processed",      // ... and mermaid itself is present
        "sequenceDiagram",     // ... including its diagram implementations
    ] {
        assert!(page.html.contains(marker), "the bundle is missing {marker}");
    }
    assert!(
        page.html.contains(APP_BUNDLE),
        "build.rs bundled the sources and the page embeds the bundle verbatim"
    );
}

#[test]
fn a_diagram_fence_is_rendered_instead_of_highlighted() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);
    let setup = bundle
        .doc("guide/setup.md")
        .expect("the fixture has a setup document");

    assert!(
        setup.html.contains(r#"<pre class="mermaid">"#),
        "the diagram fence must become a diagram block: {}",
        setup.html
    );
    assert!(
        !setup.html.contains("language-mermaid"),
        "a diagram must not be highlighted: {}",
        setup.html
    );
    assert!(
        page.html.contains("startOnLoad"),
        "the page must configure the diagram engine"
    );
}

#[test]
fn a_document_carries_its_blocks_for_the_hover_preview() {
    let bundle = build(&fixture_root(), "Fixture");
    let intro = bundle
        .doc("guide/intro.md")
        .expect("the fixture has an intro");

    assert_eq!(
        intro
            .blocks
            .iter()
            .map(|block| block.id.as_str())
            .collect::<Vec<_>>(),
        ["introduction", "getting-started", "details"],
        "one block per heading, in document order"
    );
    assert!(
        intro.blocks[2].html.contains("<h3 id=\"details\">"),
        "a block starts at its own heading: {}",
        intro.blocks[2].html
    );
    assert!(
        !intro.blocks[1].html.contains("<h3"),
        "a block holds its own content only, so no paragraph is repeated: {}",
        intro.blocks[1].html
    );

    // The outline is carried by the blocks themselves: `details` is nested
    // under `getting-started`, which is why previewing the latter shows both.
    assert_eq!(intro.blocks[2].parent, Some(1));
    assert_eq!(intro.blocks[1].subtree, [1, 2]);

    let readme = bundle.doc("README.md").expect("the fixture has a readme");
    assert!(
        readme
            .html
            .contains("href=\"#/doc/guide/intro.md#details\""),
        "the block reference must address the chapter: {}",
        readme.html
    );
}

#[test]
fn joining_a_root_subtree_reproduces_the_document_body() {
    let bundle = build(&fixture_root(), "Fixture");
    let intro = bundle
        .doc("guide/intro.md")
        .expect("the fixture has an intro");
    let root = intro.blocks.first().expect("the intro has headings");

    let joined: String = root
        .subtree
        .iter()
        .map(|&index| intro.blocks[index].html.as_str())
        .collect();

    assert_eq!(
        joined, intro.html,
        "the blocks and the body are the same markup, so previewing cannot drift"
    );
}

#[test]
fn blocks_never_duplicate_a_paragraph_however_deep_the_outline() {
    let bundle = build(&fixture_root(), "Fixture");

    for doc in &bundle.docs {
        let markup: usize = doc.blocks.iter().map(|block| block.html.len()).sum();

        assert_eq!(
            markup,
            doc.html.len(),
            "{}: block markup must cost exactly one body copy",
            doc.id
        );
        assert_eq!(
            doc.blocks
                .iter()
                .flat_map(|block| block.subtree.iter())
                .filter(|&&index| index == 0)
                .count(),
            usize::from(!doc.blocks.is_empty()),
            "{}: the first block must appear in exactly one subtree",
            doc.id
        );
    }
}

#[test]
fn the_page_carries_the_hover_preview() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);
    let payload: serde_json::Value =
        serde_json::from_str(payload_of(&page.html)).expect("payload JSON");

    assert_eq!(
        payload["docs"][1]["blocks"][0]
            .as_object()
            .map(|object| object.keys().map(String::as_str).collect::<Vec<_>>()),
        Some(vec!["html", "id", "level", "parent", "subtree"]),
        "the payload carries the blocks and their place in the outline"
    );

    // The popover is built at runtime, so the page only has to carry the module
    // and the class names it looks for. A broken reference reuses the same
    // panel as a notice, which is why its own markers are checked here rather
    // than in the banner test: hovering one must never raise the banner.
    for marker in [
        "preview-popover",
        "preview-scroll",
        "Chapter preview",
        "data-wikicc-doc-link",
        "data-missing",
        "Broken reference",
        "preview-missing",
        "Chapter not found",
    ] {
        assert!(
            page.html.contains(marker),
            "the preview module is missing {marker}"
        );
    }
}

#[test]
fn a_block_reference_addresses_the_anchor_its_document_emits() {
    let bundle = build(&fixture_root(), "Fixture");
    let readme = bundle
        .docs
        .iter()
        .find(|doc| doc.id == "README.md")
        .expect("the fixture has a README");

    // The reader follows a block reference with the browser, so the href has to
    // be the whole story: a route to the document *and* the chapter, naming the
    // anchor the document really emits. Anything less and a click lands at the
    // top of the page with nothing to scroll to.
    for chapter in ["getting-started", "details"] {
        let href = format!("#/doc/guide/intro.md#{chapter}");
        assert!(
            readme.html.contains(&format!(r#"href="{href}""#)),
            "the block reference must carry {href}, found: {}",
            readme.html
        );
    }

    assert!(
        !readme.html.contains(r#"data-wikicc-missing-anchor="#),
        "a chapter of an existing document is not a missing chapter: {}",
        readme.html
    );
}

#[test]
fn the_page_carries_the_missing_chapter_banner() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);

    // The banner explains a block reference whose chapter the target document
    // does not have: it is built at runtime, so the page only has to carry the
    // slot it fills and the module that fills it.
    assert!(
        page.html
            .contains(r#"<div class="doc-alert" id="doc-alert""#),
        "the banner slot must be part of the shell"
    );
    assert!(
        page.html.contains(r#"aria-live="polite""#),
        "the banner must be announced politely"
    );
    for marker in [
        "doc-alert-close",
        "doc-alert-code",
        "Chapter not found in ",
        "Dismiss",
    ] {
        assert!(
            page.html.contains(marker),
            "the banner module is missing {marker}"
        );
    }
    assert!(
        page.html.contains(r#"id="doc-article""#),
        "the article must sit beside the banner, so a message never reflows it"
    );

    // The reader can only report a broken reference if the page tells it which
    // chapter was asked for: the route cannot, because it carries no anchor.
    for marker in ["data-wikicc-missing-anchor", "doc-link-missing"] {
        assert!(
            page.html.contains(marker),
            "the reader contract is missing {marker}"
        );
    }
}

#[test]
fn a_route_anchor_is_an_anchor_the_page_emits() {
    let bundle = build(&fixture_root(), "Fixture");
    let page = render(&bundle);

    // Every route the payload carries must name an id the article emits; an
    // author's spelling of a heading (`#Getting Started`) would address nothing
    // and the reader would report a chapter that is really there as missing.
    for doc in &bundle.docs {
        for block in &doc.blocks {
            assert!(
                block.html.contains(&format!("id=\"{}\"", block.id)),
                "{}: a block must carry its own anchor: {}",
                doc.id,
                block.html
            );
        }
    }

    assert!(
        page.html.contains("data-wikicc-doc-link"),
        "the reader must be able to recognise its own links"
    );
}

#[test]
fn the_page_loads_no_external_resource() {
    let page = render(&build(&fixture_root(), "Fixture"));

    for marker in [
        "<script src=",
        "<link rel=\"stylesheet\"",
        "<link href=",
        "src=\"http",
        "src=\"//",
    ] {
        assert!(
            !page.html.contains(marker),
            "the page must be self-contained, found {marker}"
        );
    }
}

#[test]
fn rendering_the_same_bundle_twice_is_byte_identical() {
    let bundle = build(&fixture_root(), "Fixture");

    assert_eq!(render(&bundle).html, render(&bundle).html);
}

#[test]
fn a_document_with_a_script_terminator_cannot_break_the_page() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("a.md"),
        "# A\n\n</script><script>alert('x')</script>\n",
    )
    .expect("write fixture");

    let page = render(&build(dir.path(), "Broken"));
    let payload = payload_of(&page.html);

    assert_eq!(page.html.matches("</script>").count(), 2);
    assert!(!payload.contains("</script"));
    let value: serde_json::Value = serde_json::from_str(payload).expect("payload JSON");
    assert_eq!(value["docs"].as_array().map(Vec::len), Some(1));
}

#[test]
fn an_empty_site_still_renders_a_complete_page() {
    let dir = tempfile::tempdir().expect("temp dir");
    let page = render(&build(dir.path(), "Empty"));
    let value: serde_json::Value =
        serde_json::from_str(payload_of(&page.html)).expect("payload JSON");

    assert_eq!(value["docs"].as_array().map(Vec::len), Some(0));
    assert!(page.html.contains(r#"id="doc-list""#));
}

// ---------------------------------------------------------------------------
// Binary-level end-to-end checks: artifacts, reproducibility, gate, exit codes
// ---------------------------------------------------------------------------

/// The fixture with a broken link and an escaping asset; it has two warnings.
fn links_fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("links")
}

/// The compiled `wikicc` binary.
fn wikicc() -> Command {
    Command::cargo_bin("wikicc").expect("wikicc binary is built for integration tests")
}

/// Run one build of `input` into `out` with `extra` arguments.
fn build_with(input: &Path, out: &Path, extra: &[&str]) -> std::process::Output {
    wikicc()
        .arg(input)
        .arg("--out")
        .arg(out)
        .args(extra)
        .output()
        .expect("run wikicc")
}

fn stdout_of(output: &std::process::Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("stdout is utf-8")
}

fn stderr_of(output: &std::process::Output) -> String {
    String::from_utf8(output.stderr.clone()).expect("stderr is utf-8")
}

/// Every file under `dir`, as `(relative path with forward slashes, bytes)`.
///
/// Comparing whole trees is what "the build is reproducible" actually means for
/// a multi-file artifact, and it covers the page and the assets in one
/// assertion.
fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<(String, Vec<u8>)> = walkdir::WalkDir::new(dir)
        .into_iter()
        .map(|entry| entry.expect("walk the output directory"))
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            let relative = entry
                .path()
                .strip_prefix(dir)
                .expect("entry inside the output directory")
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = std::fs::read(entry.path()).expect("read an output file");

            (relative, bytes)
        })
        .collect();

    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

#[test]
fn the_default_format_writes_one_self_contained_page() {
    let out = tempfile::tempdir().expect("temp dir");
    let output = build_with(&fixture_root(), out.path(), &[]);

    assert!(output.status.success(), "{}", stderr_of(&output));
    let stdout = stdout_of(&output);
    assert!(
        stdout.contains("compiled 3 documents, 1 asset"),
        "unexpected summary: {stdout}"
    );
    assert!(
        stdout.contains("(single-html) in "),
        "the summary must name the format and the duration: {stdout}"
    );

    let files = tree(out.path());
    assert_eq!(files.len(), 1, "single-html writes exactly one file");
    let page = String::from_utf8(files[0].1.clone()).expect("the page is utf-8");

    assert!(page.starts_with("<!DOCTYPE html>"));
    for marker in [
        "<script src=",
        "<link rel=\"stylesheet\"",
        "<link href=",
        "src=\"http",
        "src=\"//",
        "href=\"http",
        "href=\"//",
        "wikicc-asset:",
    ] {
        assert!(
            !page.contains(marker),
            "the artifact must be self-contained, found {marker}"
        );
    }
    assert!(
        page.contains("data:image/svg+xml"),
        "the fixture logo must be inlined as a data URI"
    );
}

#[test]
fn every_format_writes_its_documented_artifacts() {
    let single = tempfile::tempdir().expect("temp dir");
    let output = build_with(&fixture_root(), single.path(), &["--format", "single-html"]);
    assert!(output.status.success(), "{}", stderr_of(&output));
    assert_eq!(
        tree(single.path())
            .into_iter()
            .map(|(path, _)| path)
            .collect::<Vec<_>>(),
        [HTML_FILE_NAME.to_string()]
    );

    let dir_format = tempfile::tempdir().expect("temp dir");
    let output = build_with(
        &fixture_root(),
        dir_format.path(),
        &["--format", "html-dir"],
    );
    assert!(output.status.success(), "{}", stderr_of(&output));
    let files = tree(dir_format.path());
    let names: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();

    assert!(names.contains(&HTML_FILE_NAME), "paths: {names:?}");
    assert_eq!(
        names.len(),
        2,
        "one page plus one deduplicated asset: {names:?}"
    );
    let asset = names
        .iter()
        .find(|name| name.starts_with(ASSETS_DIR_NAME))
        .expect("the asset folder holds the fixture logo");
    assert!(asset.ends_with(".svg"), "paths: {names:?}");
    let page = files
        .iter()
        .find(|(path, _)| path == HTML_FILE_NAME)
        .map(|(_, bytes)| String::from_utf8(bytes.clone()).expect("the page is utf-8"))
        .expect("the page exists");
    assert!(
        page.contains(asset),
        "the page must address {asset} by its relative path"
    );
}

#[test]
fn building_twice_produces_byte_identical_trees() {
    for format in OutputFormat::ALL {
        let first = tempfile::tempdir().expect("temp dir");
        let second = tempfile::tempdir().expect("temp dir");

        let one = build_with(
            &fixture_root(),
            first.path(),
            &["--format", format.as_str()],
        );
        let two = build_with(
            &fixture_root(),
            second.path(),
            &["--format", format.as_str()],
        );
        assert!(one.status.success(), "{}", stderr_of(&one));
        assert!(two.status.success(), "{}", stderr_of(&two));

        assert_eq!(
            tree(first.path()),
            tree(second.path()),
            "{format} output differs between two builds of the same input"
        );
    }
}

#[test]
fn warnings_are_reported_without_failing_the_build() {
    let out = tempfile::tempdir().expect("temp dir");
    let output = build_with(&links_fixture_root(), out.path(), &[]);

    assert!(output.status.success(), "{}", stderr_of(&output));
    let stderr = stderr_of(&output);
    assert!(
        stderr.contains("link target not found: 'missing.md'"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("link target section not found: 'guide/intro.md#no-such-chapter'"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("link target escapes the input directory: '../outside.png'"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("3 warnings (use --strict to fail)"),
        "stderr: {stderr}"
    );
    assert!(out.path().join(HTML_FILE_NAME).is_file());
}

#[test]
fn strict_mode_fails_on_the_link_fixture_and_writes_nothing() {
    let out = tempfile::tempdir().expect("temp dir");
    let target = out.path().join("dist");
    let output = build_with(&links_fixture_root(), &target, &["--strict"]);

    assert_eq!(output.status.code(), Some(1), "{}", stderr_of(&output));
    let stderr = stderr_of(&output);
    assert!(
        stderr.contains("link target not found: 'missing.md'"),
        "the offending link must be listed: {stderr}"
    );
    assert!(
        stderr.contains("link target section not found"),
        "a missing chapter must be listed too: {stderr}"
    );
    assert!(
        stderr.contains("3 warnings treated as errors (--strict)"),
        "stderr: {stderr}"
    );
    assert!(
        !target.exists(),
        "a build refused by --strict must not create an artifact"
    );
    assert!(
        stdout_of(&output).is_empty(),
        "no summary for a failed build"
    );
}

#[test]
fn usage_errors_exit_with_two_and_runtime_errors_with_one() {
    wikicc().assert().code(2);

    let out = tempfile::tempdir().expect("temp dir");
    wikicc()
        .arg(fixture_root())
        .args(["--format", "pdf"])
        .arg("--out")
        .arg(out.path())
        .assert()
        .code(2);

    wikicc().arg(out.path().join("missing")).assert().code(1);
}

#[test]
fn a_clean_build_prints_no_note() {
    for format in OutputFormat::ALL {
        let out = tempfile::tempdir().expect("temp dir");
        let output = build_with(&fixture_root(), out.path(), &["--format", format.as_str()]);
        let stderr = stderr_of(&output);

        assert!(output.status.success(), "{stderr}");
        assert!(
            !stderr.contains("warning"),
            "{format}: the fixture is --strict clean, so nothing may warn: {stderr}"
        );
        assert!(
            !stderr.to_lowercase().contains("mhtml"),
            "{format}: no format carries a special note any more: {stderr}"
        );
        assert!(
            stdout_of(&output).contains(&format!("({format}) in ")),
            "{format}: the summary names the format"
        );
    }
}
