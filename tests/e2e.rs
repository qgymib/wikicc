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
use wikicc::render::{PAGES_DIR_NAME, SEARCH_FILE_NAME};
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
fn the_search_panel_stays_outside_the_article_column() {
    let page = render(&build(&fixture_root(), "Fixture"));

    // The hover preview listens to the article column alone. The search panel
    // shows whole documents with their links, and a reader hovering one of
    // those links is reading the dialog, not asking for a chapter popover — so
    // the panel stays a sibling of the column, never a descendant of it, or
    // the column's listeners would open a popover inside the dialog.
    let column = page
        .html
        .find(r#"<main class="content" id="doc-content""#)
        .expect("article column");
    let column_end = column + page.html[column..].find("</main>").expect("column ends");
    let panel = page
        .html
        .find(r#"id="search-panel""#)
        .expect("search panel");

    assert!(
        panel > column_end,
        "the panel is written after the column closes, never inside it"
    );
}

#[test]
fn the_theme_switch_sits_beside_search_in_the_top_bar() {
    let page = render(&build(&fixture_root(), "Fixture"));

    // The theme is an app-level control like search, so it belongs at the far
    // end of the top bar, after the button it sits beside. The sidebar header
    // is left holding nothing but the site title.
    let bar = page.html.find(r#"class="topbar""#).expect("top bar");
    let search = page
        .html
        .find(r#"id="search-toggle""#)
        .expect("search button");
    let theme = page
        .html
        .find(r#"id="theme-toggle""#)
        .expect("theme button");
    let header = page
        .html
        .find(r#"class="sidebar-header""#)
        .expect("sidebar header");
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
        page.html.contains("data-wikicc-locked-widths"),
        "the column-width pin must be bundled into the page"
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
    let start = css
        .find(selector)
        .unwrap_or_else(|| panic!("no {selector}"));
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
        declaration(bar, "border-left"),
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
        declaration(bar, "padding"),
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
        declaration(bar, "border-left"),
        Some("0"),
        "nothing is that edge any more"
    );
    assert!(
        declaration(bar, "border-bottom").is_some(),
        "a strip over moving content needs a rule under it: {bar}"
    );
    assert_eq!(
        declaration(bar, "background"),
        Some("var(--bg-panel)"),
        "the strip keeps its own translucent surface"
    );
    assert_eq!(
        declaration(bar, "backdrop-filter"),
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
        declaration(inspector, "scrollbar-gutter"),
        Some("stable"),
        "the panels' right edge holds still whether or not the scrollbar shows"
    );
    let bar = rule_of(css, ".topbar {");
    assert_eq!(
        declaration(bar, "padding"),
        Some("0 calc(16px + var(--panel-gutter, 8px)) 0 16px"),
        "the bar's right padding is the panels' padding plus one gutter"
    );

    // Both concessions are wide-screen furniture: the collapsed inspector no
    // longer scrolls and the strip lies across the whole width again.
    let narrow = media_block(css, "max-width: 900px");
    let bar = rule_of(narrow, ".topbar {");
    assert_eq!(
        declaration(bar, "padding-right"),
        Some("16px"),
        "the full-width strip returns to the plain 16px axis"
    );
    let inspector = rule_of(narrow, ".inspector {");
    assert_eq!(
        declaration(inspector, "scrollbar-gutter"),
        Some("auto"),
        "the collapsed panel reserves no empty strip"
    );

    // The narrowest width narrows the panels' padding, and the bar follows it.
    let smallest = media_block(css, "max-width: 640px");
    let bar = rule_of(smallest, ".topbar {");
    assert_eq!(
        declaration(bar, "padding-right"),
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

    assert_eq!(declaration(panel, "position"), Some("fixed"));
    assert_eq!(declaration(panel, "inset"), Some("0"));
    assert_eq!(declaration(panel, "margin"), Some("auto"));

    // Two limits, whichever is smaller: the pixel ceiling is what a large
    // screen gets, the viewport share is what a mid-size screen gets. Both
    // are pinned here so growing the dialog cannot silently shrink again.
    let width = declaration(panel, "width").expect("panel width");
    assert!(
        width.starts_with("min(") && width.contains("1920px") && width.contains("98vw"),
        "the dialog spans nearly the whole viewport: {width}"
    );
    let height = declaration(panel, "height").expect("panel height");
    assert!(
        height.starts_with("min(") && height.contains("1155px") && height.contains("97vh"),
        "the dialog fills nearly all of the viewport's height: {height}"
    );

    // While the dialog is up, one translucent layer sits between the reader
    // and the page: the app's own pseudo-element, keyed on the open panel, a
    // layer under the dialog itself.
    let dim = ".app:has(.search-panel:not([hidden]))::after";
    let backdrop = rule_of(css, &format!("{dim} {{"));
    assert_eq!(
        declaration(backdrop, "position"),
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
        declaration(panel, "width"),
        Some("calc(100vw - 16px)"),
        "the dialog fills the narrow screen but for one margin"
    );
    assert_eq!(declaration(panel, "height"), Some("calc(100vh - 16px)"));

    let smallest = media_block(css, "max-width: 640px");
    let panel = rule_of(smallest, ".search-panel {");
    assert_eq!(
        declaration(panel, "width"),
        Some("calc(100vw - 12px)"),
        "the smallest screens shrink the margin, not the dialog"
    );
    assert_eq!(declaration(panel, "height"), Some("calc(100dvh - 12px)"));
    assert_eq!(declaration(panel, "border-radius"), Some("12px"));
}

#[test]
fn the_search_panel_stacks_the_list_over_the_document_it_opens() {
    // The list is how the reader navigates; the preview is what they came to
    // read, and it holds the whole document rather than a paragraph cut out
    // of one. They sit on one reading line — field, list, document, top to
    // bottom — and the two below the field keep the 1:2 proportion they held
    // side by side, now as a split of height instead of width.
    let css = SHELL_CSS;
    let panel = rule_of(css, ".search-panel {");
    let field = rule_of(css, ".search-field {");

    assert_eq!(declaration(panel, "display"), Some("grid"));
    assert_eq!(
        declaration(panel, "grid-template-columns"),
        Some("minmax(0, 1fr)"),
        "one column, so every part of the panel is on the same line of sight"
    );
    assert_eq!(
        declaration(panel, "grid-template-rows"),
        Some("auto minmax(0, 1fr) minmax(0, 2fr)"),
        "the field takes its own height, the list a third of the rest and the document two"
    );
    assert!(
        !panel.contains("grid-template-areas"),
        "the order is the markup's: field, then list, then document"
    );
    assert_eq!(
        declaration(field, "border-bottom"),
        Some("1px solid var(--border)"),
        "a rule under the field is where the query stops and the answers start"
    );

    // The two halves of the split are separated by a horizontal rule, because
    // they are now one above the other.
    let preview = rule_of(css, ".search-preview {");
    assert_eq!(
        declaration(preview, "border-top"),
        Some("1px solid var(--border)")
    );
    assert_eq!(declaration(preview, "border-left"), None);
    assert_eq!(
        declaration(preview, "max-height"),
        None,
        "no share of the dialog is reserved for the list"
    );

    // The list scrolls inside its own third: a hundred hits never squeeze the
    // document, and a scrollbar never shifts the rows sideways.
    let results = rule_of(css, ".search-results {");
    assert_eq!(declaration(results, "overflow-y"), Some("auto"));
    assert_eq!(declaration(results, "scrollbar-gutter"), Some("stable"));

    // An empty half names itself in its own middle, and that label leaves as
    // soon as the half holds something.
    let empty = rule_of(css, ".search-empty {");
    assert_eq!(declaration(empty, "display"), Some("flex"));
    assert_eq!(declaration(empty, "align-items"), Some("center"));
    assert_eq!(
        declaration(empty, "justify-content"),
        Some("center"),
        "the label is centred across the half it describes"
    );
}

#[test]
fn a_search_result_reads_as_a_row_of_a_table_of_findings() {
    // The passage leads every line and the file it came from closes it, so the
    // words the reader typed can be compared down one column and the files
    // line up in another.
    let css = SHELL_CSS;
    let row = rule_of(css, ".search-result {");

    assert_eq!(declaration(row, "display"), Some("grid"));
    assert_eq!(
        declaration(row, "grid-template-columns"),
        Some("minmax(0, 1fr) minmax(180px, 260px)"),
        "the passage takes the room left over, the file a fixed share of it"
    );
    assert_eq!(declaration(row, "align-items"), Some("start"));
    assert_eq!(
        declaration(rule_of(css, ".search-result:hover {"), "background"),
        Some("var(--bg-hover)"),
        "the row under the pointer answers before it is picked"
    );

    let context = rule_of(css, ".search-result-context {");
    assert_eq!(
        declaration(context, "grid-column"),
        Some("1"),
        "the passage is the leading column"
    );
    assert_eq!(
        declaration(context, "-webkit-line-clamp"),
        Some("1"),
        "one line on every screen: the window fills the widest line and the \
         cut never takes the highlighted word"
    );

    // The trailing cell is the file itself, one line and one value: it names
    // where the row leads rather than what the document calls itself, because
    // its path already ends in the file's name.
    let path = rule_of(css, ".search-result-path {");
    assert_eq!(
        declaration(path, "grid-column"),
        Some("2"),
        "the file is the trailing column"
    );
    // No rule divides the two columns: they are told apart by their own type
    // and spacing rather than by a drawn line.
    assert_eq!(
        declaration(path, "border-left"),
        None,
        "the row carries no divider between its columns"
    );
    assert_eq!(
        declaration(row, "border-bottom"),
        Some("1px solid var(--border)")
    );
    assert_eq!(declaration(path, "font-size"), Some("11.5px"));
    assert_eq!(
        declaration(path, "color"),
        Some("var(--text-dim)"),
        "the file is a caption, not a title"
    );
    assert_eq!(
        declaration(path, "white-space"),
        Some("nowrap"),
        "path and name stay on one line"
    );
    assert_eq!(declaration(path, "text-overflow"), Some("ellipsis"));

    // A long path gives up its directories, not its file name: truncation
    // follows the writing direction, so the box is right-to-left and the
    // ellipsis lands at the start of the path. No bidi override on top of it:
    // a first-strong-character resolution would turn the paragraph back into
    // a left-to-right one and put the dots at the wrong end.
    assert_eq!(
        declaration(path, "direction"),
        Some("rtl"),
        "the overflow is taken from the front of the path"
    );
    assert_eq!(
        declaration(path, "unicode-bidi"),
        None,
        "the paragraph direction is the box's own, not the text's first strong character"
    );
    assert_eq!(declaration(path, "text-align"), Some("left"));

    // The title of a document is not part of its row at all.
    assert!(
        !css.contains(".search-result-title"),
        "a row names the file, never the document's title"
    );

    // Narrow screens keep the two columns and give the document column up
    // first: the passage is what the row is for.
    let narrow = media_block(css, "max-width: 900px");
    let row = rule_of(narrow, ".search-result {");
    assert_eq!(
        declaration(row, "grid-template-columns"),
        Some("minmax(0, 1fr) minmax(120px, 160px)")
    );
}

#[test]
fn the_search_scope_button_sits_at_the_field_s_right_edge() {
    // The scope is a switch beside the words it scopes: the button sits at the
    // field's right edge — past the clear button, which steps aside — and
    // reads like the graph's own mode switch, because it answers the same kind
    // of question about how much the reader is looking at.
    let css = SHELL_CSS;
    let mode = rule_of(css, ".search-mode {");

    assert_eq!(declaration(mode, "position"), Some("absolute"));
    assert_eq!(declaration(mode, "right"), Some("8px"));

    let clear = rule_of(css, ".search-clear {");
    assert_eq!(
        declaration(clear, "right"),
        Some("72px"),
        "the clear button steps aside for the scope switch"
    );

    let input = rule_of(css, ".search-input {");
    assert_eq!(
        declaration(input, "padding"),
        Some("13px 104px 13px 40px"),
        "the typed words stop short of both buttons at the right edge"
    );

    let pressed = rule_of(css, ".search-mode[aria-pressed=\"true\"] {");
    assert_eq!(
        declaration(pressed, "border-color"),
        Some("var(--accent)"),
        "the scope in force is readable at a glance"
    );
}

#[test]
fn the_search_field_carries_one_clear_button_of_its_own() {
    // The field is a `type="search"` input, and the engine answers that with
    // search furniture of its own — a cancel cross that shows while the field
    // is focused and leaves on a blur. The panel already has a clear button,
    // the one that shows while the field holds text and hides when it does
    // not, so the engine's cross would stand beside it: two crosses for one
    // job, and a pair that comes and goes with the focus. The engine's
    // furniture is switched off, and the field's own button is the only one.
    let css = SHELL_CSS;
    let native = rule_of(css, ".search-input::-webkit-search-cancel-button,");

    assert_eq!(
        declaration(native, "-webkit-appearance"),
        Some("none"),
        "the engine's cancel cross is switched off"
    );
    assert_eq!(
        declaration(native, "appearance"),
        Some("none"),
        "the standard spelling is carried alongside the prefixed one"
    );

    // The results button and the decoration are the rest of what the search
    // type hangs on the field; one selector list carries all three, and the
    // sheet says so once.
    assert!(
        css.contains(".search-input::-webkit-search-results-button,"),
        "the results button is switched off with the cross"
    );
    assert!(
        css.contains(".search-input::-webkit-search-decoration {"),
        "the search decoration is switched off with the cross"
    );
}

#[test]
fn the_search_preview_scrolls_the_document_it_shows() {
    // The document is longer than the dialog, so the preview is what scrolls:
    // its own column, on its own, with a gutter held open so switching
    // documents does not shift the text sideways under the reader's eye.
    let css = SHELL_CSS;
    let preview = rule_of(css, ".search-preview {");

    assert_eq!(
        declaration(preview, "overflow-y"),
        Some("auto"),
        "the document scrolls inside the preview"
    );
    assert_eq!(
        declaration(preview, "min-height"),
        Some("0"),
        "the column may shrink, or the scroll would never engage"
    );
    assert_eq!(
        declaration(preview, "overscroll-behavior"),
        Some("contain"),
        "reaching the end of a document does not scroll the page behind it"
    );
    assert_eq!(
        declaration(preview, "scrollbar-gutter"),
        Some("stable"),
        "the reading column keeps its width when the bar comes and goes"
    );
}

#[test]
fn the_article_typography_reaches_the_preview_one_size_down() {
    // The preview inserts the document with the article's own classes, so the
    // typography is the article's; only the measure changes. A column this
    // narrow steps every size down and tightens the spacing to match, and
    // tables scroll sideways rather than pushing the dialog's edge out.
    let css = SHELL_CSS;
    let body = rule_of(css, ".search-preview .doc-body {");

    assert_eq!(
        declaration(body, "font-size"),
        Some("13.5px"),
        "the reading size of a narrow column"
    );
    assert_eq!(declaration(body, "line-height"), Some("1.7"));

    let heading = rule_of(css, ".search-preview .doc-body h2 {");
    assert_eq!(declaration(heading, "font-size"), Some("17px"));

    let table = rule_of(css, ".search-preview .doc-body table {");
    assert_eq!(
        declaration(table, "overflow-x"),
        Some("auto"),
        "a wide table scrolls inside the column"
    );
    assert_eq!(declaration(table, "max-width"), Some("100%"));
}

#[test]
fn a_chapter_arrow_is_quiet_until_the_chapter_is_under_the_pointer() {
    // A reading column full of arrows would be a table of contents, so the
    // arrow is only furniture while the pointer is on its heading — or the
    // keyboard is on the arrow, which is what keeps it reachable. Its
    // visibility follows the fade, or a hidden arrow would still be a click
    // target and a tab stop nobody asked for.
    let css = SHELL_CSS;
    let arrow = rule_of(
        css,
        ".doc-body.chapter-collapsible .chapter-toggle {\n  position: absolute;",
    );

    assert_eq!(declaration(arrow, "position"), Some("absolute"));
    assert_eq!(
        declaration(arrow, "left"),
        Some("-22px"),
        "the arrow hangs flush with the heading's left edge: the pointer \
         crosses from the heading onto the arrow without leaving hover \
         territory, which is what makes it reachable: {arrow}"
    );
    assert_eq!(
        declaration(arrow, "opacity"),
        Some("0"),
        "an arrow that is not being looked at is not there"
    );
    assert_eq!(
        declaration(arrow, "visibility"),
        Some("hidden"),
        "and it is not a click or a tab stop either"
    );

    let shown = css
        .find(".doc-body.chapter-collapsible .chapter-toggle:hover,")
        .expect("the arrow's own states");
    let shown = rule_of(&css[shown..], ".doc-body.chapter-collapsible");
    assert_eq!(declaration(shown, "opacity"), Some("1"));
    assert_eq!(declaration(shown, "visibility"), Some("visible"));

    for level in 1..=6 {
        let selector = format!(".doc-body.chapter-collapsible h{level}:hover .chapter-toggle,");
        assert!(
            css.contains(&selector),
            "the heading's own hover reveals its arrow, at every level: {selector}"
        );
    }
}

#[test]
fn folding_a_chapter_leaves_its_heading_exactly_as_it_was() {
    // The point of folding is the arrow and nothing else: the heading keeps its
    // size, its rule and its spacing, because the chapter's elements are hidden
    // rather than moved. Only the glyph turns, and the button stays put — the
    // pointer that folded a chapter is still on the arrow that unfolds it.
    let css = SHELL_CSS;
    let glyph = rule_of(css, ".chapter-toggle svg {");
    let folded = rule_of(css, ".chapter-toggle[aria-expanded=\"false\"] svg {");

    assert_eq!(
        declaration(glyph, "transform"),
        Some("rotate(90deg)"),
        "the chevron points down while the chapter is open"
    );
    assert_eq!(
        declaration(folded, "transform"),
        Some("none"),
        "and right once it is folded"
    );

    // The body is a grid so the headings hang into the margin the arrows are
    // drawn in, and every element gets a row of its own; the heading keeps a
    // column of its own so its text is not pushed aside for the arrow.
    let body = rule_of(css, ".doc-body.chapter-collapsible {");
    assert_eq!(declaration(body, "display"), Some("grid"));
    assert!(
        declaration(body, "grid-template-columns")
            .is_some_and(|value| value.starts_with("28px minmax(0, 1fr)")),
        "the gutter then the reading column: {body}"
    );

    // The list is one rule over every level; the h2 line inside it is the
    // proof that a heading — not only the narrowest one — is addressed.
    let heading = rule_of(css, ".doc-body.chapter-collapsible > h1,");
    assert_eq!(
        declaration(heading, "grid-column"),
        Some("1 / -1"),
        "the heading starts at the very left edge, where its text does"
    );
    assert!(
        heading.contains(".doc-body.chapter-collapsible > h2,"),
        "every level of heading spans the full width"
    );
    assert_eq!(
        declaration(heading, "position"),
        Some("relative"),
        "the heading is the positioned ancestor its arrow hangs from"
    );

    // Nothing in the sheet folds a chapter by hiding a heading: a folded
    // chapter shows its title.
    assert!(
        !css.contains(".doc-body.chapter-collapsible h2[data-collapsed]"),
        "a folded chapter keeps its heading on screen"
    );
}

#[test]
fn folding_is_the_article_s_own_furniture() {
    // The search dialog reads a click outside itself as a dismissal and the
    // hover preview is a window onto a chapter rather than a place to read one,
    // so neither can fold a document. Both are kept out by scope, not by a
    // runtime test: every rule of the feature hangs off the class only the
    // article asks for.
    let css = SHELL_CSS;

    // The arrow's own rules hang off the article's class, so a document body
    // that did not ask for the arrows has no rule to pick up. The glyph rules
    // are the one exception: they draw nothing until an arrow exists, and only
    // the article builds one.
    let scoped: Vec<&str> = css
        .lines()
        .filter(|line| line.contains(".chapter-toggle"))
        .filter(|line| !line.contains(".chapter-toggle svg"))
        .filter(|line| !line.contains(".chapter-toggle[aria-expanded"))
        .collect();

    assert!(!scoped.is_empty(), "the sheet has rules for the arrows");
    for line in scoped {
        // The print block speaks for the whole sheet — a printed page has no
        // arrows at all — so its plain selector is the documented exception.
        let indented = line.starts_with("  ");
        assert!(
            line.contains(".chapter-collapsible") || indented,
            "the arrow is the article's own furniture: {line}"
        );
    }

    // The body only becomes a grid under the article's class, so the two other
    // document bodies keep the typography's layout untouched.
    assert!(
        css.contains(".doc-body.chapter-collapsible {"),
        "the grid the arrows hang from is the article's alone"
    );

    // Printed paper cannot be folded, and the arrows are not content. The sheet
    // has more than one print block — the banner's early one takes itself off
    // the page too — so the last one is the sheet-wide block the arrows leave
    // with.
    let print_at = css.rfind("@media print").expect("a print block");
    let print = media_block(&css[print_at..], "print");
    assert!(
        print.contains(".chapter-toggle {"),
        "the print rules take the arrows off the page"
    );
    assert!(
        print[print.find(".chapter-toggle {").expect("arrow rule")..]
            .split('}')
            .next()
            .is_some_and(|rule| declaration(rule, "display") == Some("none")),
        "a printed page carries no fold arrows"
    );
}

#[test]
fn a_code_block_carries_a_copy_button_on_its_own_corner() {
    // The button is quiet furniture: it hangs off the block's corner, hidden
    // until the pointer is on the block or the keyboard is on the button, and
    // its reach does not travel with the code the `pre` scrolls sideways.
    let css = SHELL_CSS;

    // The wrapper takes over the block's own margin, so a document that
    // cannot copy is spaced exactly like one that can.
    let wrapper = rule_of(css, ".doc-body .code-block {");
    assert_eq!(declaration(wrapper, "position"), Some("relative"));
    assert_eq!(declaration(wrapper, "margin"), Some("1.3em 0"));

    let block = rule_of(css, ".doc-body .code-block pre {");
    assert_eq!(declaration(block, "margin"), Some("0"));

    let button = rule_of(css, ".doc-body .code-copy {");
    assert_eq!(declaration(button, "position"), Some("absolute"));
    assert_eq!(declaration(button, "top"), Some("8px"));
    assert_eq!(declaration(button, "right"), Some("8px"));
    assert_eq!(
        declaration(button, "user-select"),
        Some("none"),
        "a reader selecting the code by hand never picks up the button's label"
    );
    assert_eq!(
        declaration(button, "opacity"),
        Some("0"),
        "the button is not there until the block is looked at"
    );
    assert_eq!(
        declaration(button, "visibility"),
        Some("hidden"),
        "and an invisible button is not a click target either"
    );

    let shown = rule_of(css, ".doc-body .code-block:hover .code-copy,");
    assert_eq!(declaration(shown, "opacity"), Some("1"));
    assert_eq!(declaration(shown, "visibility"), Some("visible"));

    assert!(
        css.contains(".doc-body .code-copy:focus-visible"),
        "the keyboard reveals the button the way the pointer does"
    );

    let copied = rule_of(css, ".doc-body .code-copy[data-copied] {");
    assert_eq!(
        declaration(copied, "color"),
        Some("var(--accent)"),
        "the copied state speaks in the accent's colour"
    );

    // While the state lasts the glyph is a check, not the sheets: the shape
    // itself says what happened, in the same stroke and the same box.
    let check = rule_of(css, ".code-copy svg .code-copy-check {");
    assert_eq!(
        declaration(check, "display"),
        Some("none"),
        "the resting button draws no check"
    );
    let check_shown = rule_of(css, ".code-copy[data-copied] svg .code-copy-check {");
    assert_eq!(declaration(check_shown, "display"), Some("block"));
    let sheets_hidden = rule_of(css, ".code-copy[data-copied] svg .code-copy-sheets {");
    assert_eq!(declaration(sheets_hidden, "display"), Some("none"));

    // The check is the whole announcement: no word rides beside it.
    assert!(
        !css.contains(".code-copied-note"),
        "the copied state is the glyph and the accent, nothing more"
    );
}

#[test]
fn copying_is_the_article_s_own_furniture() {
    // The hover preview and the search preview are windows onto a document,
    // not places to work on one, so neither carries the buttons. They are kept
    // out by scope, not by a runtime test: every rule of the feature hangs off
    // the article's typography class.
    let css = SHELL_CSS;

    // The glyph rules are the one exception: they draw nothing until a button
    // exists, and only the article builds one.
    let scoped: Vec<&str> = css
        .lines()
        .filter(|line| line.contains(".code-copy") || line.contains(".code-block"))
        .filter(|line| !line.contains("svg"))
        .collect();

    assert!(!scoped.is_empty(), "the sheet has rules for the buttons");
    for line in scoped {
        // The print block speaks for the whole sheet — a printed page has no
        // buttons at all — so its plain selector is the documented exception.
        let indented = line.starts_with("  ");
        assert!(
            line.contains(".doc-body") || indented,
            "the copy button is the article's own furniture: {line}"
        );
    }

    // Printed paper cannot take a copy back, and the buttons are not content.
    // The sheet has more than one print block — the banner's early one takes
    // itself off the page too — so the last one is the sheet-wide block the
    // arrows leave with.
    let print_at = css.rfind("@media print").expect("a print block");
    let print = media_block(&css[print_at..], "print");
    assert!(
        print.contains(".code-copy {"),
        "the print rules take the buttons off the page"
    );
    assert!(
        print[print.find(".code-copy {").expect("button rule")..]
            .split('}')
            .next()
            .is_some_and(|rule| declaration(rule, "display") == Some("none")),
        "a printed page carries no copy buttons"
    );
}

#[test]
fn a_hit_is_marked_in_the_document_without_shouting() {
    // A document holds dozens of hits, and the reader is reading rather than
    // scanning markers: the wash is quiet, and only the one the reader picked
    // — the row the preview scrolled to, or the passage a result was opened
    // onto in the article — is allowed to stand out, in a colour of its own.
    // The old `:first-of-type` shade stood for "the first mark of every
    // paragraph" rather than the pick, so it has gone.
    let css = SHELL_CSS;
    let hit = rule_of(css, ".search-preview mark.search-hit,");
    let active = rule_of(css, ".search-preview mark.search-hit-active,");

    assert!(
        declaration(hit, "background").is_some(),
        "a hit is marked by a background, not by a badge"
    );
    assert_eq!(
        declaration(hit, "font-weight"),
        Some("inherit"),
        "marking a word does not make it bold as well"
    );
    assert_ne!(
        declaration(hit, "background"),
        declaration(active, "background"),
        "the picked hit is read by its own colour, not the wash"
    );
    assert!(
        !css.contains(".search-preview mark.search-hit:first-of-type"),
        "the standout belongs to the selection, not the first mark of each paragraph"
    );

    // The article a result is opened onto wears the same marks: `Enter` marks
    // the passage there, so the sheet must style the article's marks too.
    assert!(
        css.contains(".doc-body mark.search-hit")
            && css.contains(".doc-body mark.search-hit-active"),
        "the article a result opens onto wears the same marks"
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
        declaration(button, "width"),
        Some("28px"),
        "the round buttons are 28px boxes"
    );
    assert_eq!(
        declaration(button, "height"),
        Some("28px"),
        "the round buttons are 28px boxes"
    );

    let glyph = rule_of(css, ".icon-button svg {");
    assert_eq!(
        declaration(glyph, "width"),
        Some("14px"),
        "the glyph sits one step inside the box"
    );
    assert_eq!(
        declaration(glyph, "height"),
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
        declaration(inspector, "gap"),
        Some("14px"),
        "the panels are held apart by the column's rhythm"
    );
    assert_eq!(
        declaration(inspector, "padding"),
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
        "wikicc-payload",            // the bootstrap reads the embedded payload
        "data-wikicc-table",         // the table enhancer is bundled
        "data-wikicc-locked-widths", // ... with the column-width pin
        "table-filter-toggle",       // ... with its per-column filter buttons
        "code-block",                // the code copy enhancer is bundled
        "code-copy",                 // ... with a button on every code block
        "graph-node",                // the link graph renderer is bundled
        "startOnLoad",               // the diagram engine is configured
        "data-processed",            // ... and mermaid itself is present
        "sequenceDiagram",           // ... including its diagram implementations
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
fn the_hover_preview_panel_offers_resize_handles() {
    // The panel is a window onto a chapter, and a window is resizable: strips
    // over the right edge, the bottom edge and the corner carry the cursors a
    // reader recognises. Asserted as a contract because a cursor that never
    // shows is invisible once it is wrong — the handle is still there, and
    // still works, and nothing else tells.
    let css = SHELL_CSS;

    let shared = rule_of(css, ".preview-resize {");
    assert_eq!(declaration(shared, "position"), Some("absolute"));

    let east = rule_of(css, ".preview-resize[data-dir=\"e\"] {");
    assert_eq!(declaration(east, "cursor"), Some("ew-resize"));
    let south = rule_of(css, ".preview-resize[data-dir=\"s\"] {");
    assert_eq!(declaration(south, "cursor"), Some("ns-resize"));
    let corner = rule_of(css, ".preview-resize[data-dir=\"se\"] {");
    assert_eq!(declaration(corner, "cursor"), Some("nwse-resize"));

    // A resize moves a frame, not a selection, so the chapter's text must not
    // select under the hand — the same suppression a drag of the head gets.
    let resizing = rule_of(css, ".preview-popover[data-resizing] {");
    assert_eq!(declaration(resizing, "user-select"), Some("none"));

    // A notice, a loading panel and an error are hints about a link, not
    // windows onto a chapter: they keep the size their sentence gives them
    // and wear no handles.
    let notice = rule_of(css, ".preview-popover[data-missing] .preview-resize,");
    assert_eq!(declaration(notice, "display"), Some("none"));
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

    let multi_format = tempfile::tempdir().expect("temp dir");
    let output = build_with(&fixture_root(), multi_format.path(), &["--format", "pages"]);
    assert!(output.status.success(), "{}", stderr_of(&output));
    let files = tree(multi_format.path());
    let names: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();

    assert!(names.contains(&HTML_FILE_NAME), "paths: {names:?}");
    assert!(names.contains(&SEARCH_FILE_NAME), "paths: {names:?}");
    assert_eq!(
        names
            .iter()
            .filter(|name| name.starts_with(&format!("{PAGES_DIR_NAME}/")))
            .count(),
        3,
        "one chunk per document: {names:?}"
    );
    assert_eq!(
        names
            .iter()
            .filter(|name| name.starts_with(&format!("{ASSETS_DIR_NAME}/")))
            .count(),
        1,
        "one deduplicated asset: {names:?}"
    );

    let page = files
        .iter()
        .find(|(path, _)| path == HTML_FILE_NAME)
        .map(|(_, bytes)| String::from_utf8(bytes.clone()).expect("the page is utf-8"))
        .expect("the page exists");
    assert!(
        page.contains(r#""mode":"pages""#),
        "the shell payload names the pages mode"
    );
    assert!(
        !page.contains("wikicc-asset:"),
        "the manifest carries no asset placeholder"
    );

    let corpus = files
        .iter()
        .find(|(path, _)| path == SEARCH_FILE_NAME)
        .map(|(_, bytes)| String::from_utf8(bytes.clone()).expect("the corpus is utf-8"))
        .expect("the corpus exists");
    let value: serde_json::Value = serde_json::from_str(&corpus).expect("corpus JSON");
    assert_eq!(
        value["docs"].as_array().map(Vec::len),
        Some(3),
        "the corpus covers every document"
    );

    let chunk = files
        .iter()
        .find(|(path, _)| path == &format!("{PAGES_DIR_NAME}/guide/intro.md.json"))
        .map(|(_, bytes)| String::from_utf8(bytes.clone()).expect("the chunk is utf-8"))
        .expect("the chunk exists");
    assert!(
        !chunk.contains("wikicc-asset:"),
        "every chunk placeholder must be replaced"
    );
    assert!(
        chunk.contains(r#""blocks""#) && chunk.contains(r#""text""#),
        "the chunk carries the chapters and the search text"
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
