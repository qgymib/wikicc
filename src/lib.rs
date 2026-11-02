//! `wikicc` compiles a folder of Markdown documents into a fully self-contained,
//! offline, double-clickable static HTML reader.
//!
//! The architecture and its contracts are described in `docs/DESIGN.md`. The
//! crate is one pipeline, and each module owns one stage of it: the CLI surface
//! (argument parsing, option normalization, output-path guards, exit codes),
//! the directory scan that produces the ordered document model, the Markdown
//! renderer that emits GFM HTML with stable heading anchors plus a nested
//! chapter outline and the plain text used for search, the build-time syntax
//! highlighter for code blocks (and the diagram fence that bypasses it), the
//! link/asset resolver that classifies every destination, rewrites it to its
//! final addressing form and registers the referenced local resources by
//! content hash, the assembly stage that folds all of it into one
//! deterministic, serialisable [`SiteBundle`], the render stage that turns that
//! bundle into the self-contained reader page (template, styles, scripts and
//! payload), the two writers that address the referenced resources in their
//! own way (one page with `data:` URIs, one page next to an `assets/` folder),
//! and [`pipeline`], which runs the stages in order and owns the summary.

pub mod assets;
pub mod cli;
pub mod error;
pub mod markdown;
pub mod options;
pub mod pipeline;
pub mod render;
pub mod scan;
pub mod site;
pub mod writers;

pub use assets::{ASSET_PLACEHOLDER_PREFIX, Asset, AssetTable, asset_hash, mime_for};
pub use error::{Error, Result};
pub use markdown::highlight::{MERMAID_CLASS, MERMAID_FENCE, THEME_NAME, theme_css};
pub use markdown::links::{LinkClass, LinkContext, LinkResolver, MissingReason, classify};
pub use markdown::{
    LinkRewriter, NoRewrite, RenderedDoc, TocEntry, render_document, render_document_with,
};
pub use options::{Options, OutputFormat};
pub use pipeline::BuildOutcome;
pub use render::{
    APP_BUNDLE, RenderedSite, SHELL_CSS, SHELL_TEMPLATE, escape_json_for_script, render_site,
    shell_css, shell_js,
};
pub use scan::{Diagnostic, ScanReport, Severity, SourceDoc};
pub use site::{DocModel, Edge, SiteBuild, SiteBundle, Stats, build_edges, build_site};
pub use writers::html_dir::HtmlDirWriter;
pub use writers::single_html::{SingleHtmlWriter, data_uri};
pub use writers::{
    ASSETS_DIR_NAME, BUILD_MARKERS, HTML_FILE_NAME, SiteWriter, WriteReport, asset_file_name,
    asset_relative_path, expand_placeholders, prepare_output_dir, write_site, writer_for,
};
