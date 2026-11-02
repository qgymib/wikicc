# wikicc — Design

This document describes the framework of `wikicc`: what the product is, the
contracts it keeps, how the stages fit together, and the limitations that shape
the design. It deliberately stays at that level — the code is the reference for
per-stage implementation details.

## 1. Purpose and scope

`wikicc` compiles a folder of Markdown documents into a **fully self-contained,
offline, double-clickable static HTML reader**.

In scope:

- recursive discovery and compilation of every Markdown document in the folder;
- local assets (images, audio, video, fonts, PDFs) embedded into the artifact;
- hash routing with deep links to documents and headings;
- block references: `[label](doc.md#chapter)` previews the named chapter (and
  the chapters nested under it) on hover and navigates to it on click;
- link graph derived from relative Markdown links;
- table sorting and filtering, full-text search, light/dark theme,
  build-time syntax highlighting and Mermaid diagrams;
- two output formats that differ only in how assets are addressed.

Out of scope (explicit non-goals):

- no watch mode, live reload or development server;
- no multi-page output (one HTML file per document);
- no server-side features, telemetry or network access at build or run time;
- no Markdown extensions beyond GFM, footnotes, task lists and strikethrough;
- no incremental build cache — a rebuild of a folder-scale site is cheap.

## 2. Product contract

### 2.1 CLI

```
wikicc <INPUT_DIR> [OPTIONS]

  -o, --out <DIR>        Output directory [default: <INPUT_DIR>/dist]
      --format <FMT>     single-html | html-dir [default: single-html]
      --title <TITLE>    Site title [default: input folder name]
      --strict           Treat warnings (broken links, missing assets) as errors
      --force            Overwrite the output directory without confirmation
  -q, --quiet            Suppress the summary line
  -h, --help             Print help
  -V, --version          Print version
```

Behavioural rules:

- diagnostics go to stderr, the summary line goes to stdout (unless `--quiet`);
- the summary names the document and asset counts, the output directory, the
  format and the elapsed time — never a value that ends up inside an artifact;
- warnings are summarized as `N warnings (use --strict to fail)` after the
  individual messages, so a non-fatal build still tells the user it was not
  clean;
- the output directory is excluded from scanning, so rebuilding never
  recompiles previous artifacts.

### 2.2 Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (possibly with warnings) |
| 1 | Runtime failure (missing input, I/O error, `--strict` with warnings) |
| 2 | Usage error (invalid arguments, reported by `clap`) |

### 2.3 Output directory governance

The output directory is created when missing and used as-is when empty. An
existing directory is only emptied when it holds a previous artifact
(`index.html`) or when `--force` is passed; any other non-empty directory is
refused, because `--out` can point anywhere and an unconditional recursive
delete is real data loss. Only the entries *inside* the directory are
removed, and symbolic links are removed as links, never followed.

Three combinations are always rejected before anything is written: the output
directory equal to the input root, an ancestor of the input root, and the
current working directory.

### 2.4 Determinism

Two builds of the same input produce **byte-identical** artifacts. This is a
hard requirement, not an aspiration, and it constrains every stage:

- documents are ordered by relative path in byte order;
- collections that reach the output are `BTreeMap`/`BTreeSet` or explicitly
  sorted;
- assets are named after their content hash, so duplicates collapse and names
  do not depend on discovery order;
- no artifact contains a timestamp, an absolute path, a host name or a random
  value. The elapsed time exists only in the stdout summary.

### 2.5 Language and encoding

- All user-visible strings, logs, documentation and code comments are English.
- Every file is written as UTF-8 without BOM; the page declares
  `<meta charset="utf-8">`.
- Non-ASCII content survives end to end: heading anchors are derived from
  Unicode alphanumerics (ICU4X) instead of being dropped, and the search
  tokenizer segments CJK text.

## 3. Architecture

### 3.1 Pipeline

```
scan ──▶ parse ──▶ resolve ──▶ assemble ──▶ render ──▶ write
 .md      HTML +     link/asset   SiteBundle   shell     2 formats
 files    TOC +      rewriting,   (JSON)       HTML      via
          highlight  asset bytes               string    SiteWriter
```

`pipeline::run` owns the order and the side effects:

| Stage | Input → output | Module |
| --- | --- | --- |
| validate | raw arguments → `Options` | `cli`, `options` |
| scan | directory → `ScanReport` | `scan` |
| parse | `SourceDoc` → HTML, TOC, plain text | `markdown` |
| resolve | destinations → final addressing, `AssetTable`, diagnostics | `markdown::links`, `assets` |
| assemble | everything → `SiteBundle` + `SiteBuild` | `site` |
| render | `SiteBundle` → one HTML string | `render` |
| write | `RenderedSite` + `SiteBuild` → files | `writers` |

Every stage except `write` is a pure transformation over immutable data, so it
is unit tested without a filesystem. The order of the side effects is part of
the contract: diagnostics are reported first, then the `--strict` gate runs, and
only then is the page rendered and written. A build that fails on warnings
therefore neither creates an artifact nor empties a previous one.

### 3.2 Module map

```
src/main.rs                 binary: parse arguments, run the pipeline, map errors to exit codes
src/lib.rs                  library root and re-exports
src/cli.rs                  clap definitions
src/options.rs              defaults, lexical path normalization, output-path guards
src/error.rs                error type and exit-code mapping
src/pipeline.rs             stage order, strict gate, summary lines
src/scan.rs                 discovery, ordering, ids, titles, diagnostics
src/markdown/               render orchestration, slugs, TOC, chapter blocks, highlighting, link resolution
src/assets.rs               read, MIME, hashing, dedupe
src/site.rs                 payload types and assembly
src/render.rs               shell assembly (template, CSS, script, payload)
src/writers/                one writer per format plus the shared placeholder expansion
src/web/                    page skeleton, styles and the reader's ES modules
build.rs                    bundles src/web/js/main.js with esbuild into OUT_DIR
```

Dependency direction is one-way: `cli` → `options` → `scan` → `markdown` →
`site` → `render` → `writers` → `pipeline`. `markdown::links` never depends on
`site`, so link resolution stays testable on its own.

### 3.3 Invariants

1. **Rewrite the event stream, not the HTML.** `pulldown-cmark` events are
   mapped before `push_html`, so link and image destinations are rewritten
   structurally. Regex post-processing of HTML is rejected because attribute
   quoting and nesting make it unsound.
2. **One page, two addressing schemes.** The document HTML is rendered once
   and carries an opaque placeholder (`wikicc-asset:<hash>`) wherever a local
   resource is referenced. Writers expand the placeholder into the addressing
   form of their format. The placeholder only ever appears inside the JSON
   payload, and every substitution value is quote-free, so the payload stays
   valid JSON.
3. **The payload is inlined, never fetched.** Products must work over
   `file://`, where `fetch()` of a local JSON file is blocked by CORS. Even
   `html-dir` inlines the site JSON into `index.html`.
4. **Assets are content-addressed.** The name is the first 16 hex characters of
   the SHA-256 digest plus the original extension, which gives free
   deduplication and stable names across builds and platforms.
5. **Fail soft by default.** Broken links and missing assets become warnings
   and the original destination is left untouched; `--strict` upgrades them to
   a non-zero exit.
6. **Raw HTML passes through unchanged.** The input is trusted (a local
   documentation folder); there is no sanitizer in this version, and this is
   documented rather than half-implemented.

## 4. Output formats

| Format | Artifact | Asset addressing | Trade-off |
| --- | --- | --- | --- |
| `single-html` (default) | one `index.html` | `data:<mime>;base64,…` | one file to move around; ~4/3 the asset bytes and no browser caching |
| `html-dir` | `index.html` + `assets/<hash>.<ext>` | relative path | smallest artifact, copyable directory, one file per unique resource |

The two writers share the page and the asset table; they never re-render
markup. `html-dir` writes the page last, so the artifact never references a file
that is not on disk, and a site without assets writes no empty `assets/` folder.

Both artifacts are opened directly from disk: the reader is one classic inline
script and the payload is embedded, so neither format depends on a server.

## 5. Front end

- **Build chain.** The reader is native ES modules under `src/web/js`, importing
  the engines by bare specifier. `build.rs` runs the npm-installed esbuild over
  `main.js` and stages one minified IIFE in `OUT_DIR`, which `render.rs` inlines
  with `include_str!`. The page therefore has exactly one classic `<script>`,
  needs no module loader and resolves nothing at runtime.
- **Dependencies.** Third-party JavaScript is ordinary npm: `minisearch` for
  search, `d3-force`/`d3-selection`/`d3-zoom`/`d3-drag` for the link graph and
  `mermaid` for diagrams, with exact versions in `package.json` and bytes pinned
  by `package-lock.json`. `npm ci` is a build prerequisite; a missing dependency
  fails the build with an actionable message instead of degrading silently.
- **Layering rule.** Pure logic and DOM access live in separate modules
  (`router.js`, `search.js`, `table.js`, `graph.js` versus `table-view.js`,
  `graph-view.js`, `diagram-view.js`), because the JS test suite runs under
  `node --test` with no DOM. Anything that touches `document` belongs to a view
  module; the table's Excel-style filter panel is a view over the pure candidate
  and selection functions in `table.js`.
- **No UI framework.** The reader stays on native DOM. One popover plus a few
  attribute toggles do not pay for a component runtime: Svelte/Vite would fight
  the single-inline-classic-script requirement, add an output layer to the
  byte-identical bundle and force a DOM test environment on logic that is
  otherwise covered by `node --test`. `esbuild` and plain ES modules stay the
  whole front-end build chain.
- **Block references.** `[label](other.md#chapter)` is a link to a chapter, and
  the reader treats it as one in two ways. Hovering shows a preview of that
  chapter *and everything nested under it*; clicking navigates to it. The
  preview needs no Markdown parser in the browser: the build cut every body into
  `DocModel.blocks`, one block per heading ending where the next heading starts,
  and each block records where it sits in the outline — `parent` names the
  enclosing block, `subtree` lists the block and every block nested under it in
  document order. A chapter is therefore read with a lookup rather than with a
  walk: join the blocks `subtree` names and the chapter is reproduced exactly as
  the source wrote it. `DocModel.toc` still exists, but only as a display
  projection for the outline column, which renders before the body exists.
- **A block is a representation, not a limitation.** Ending a block at the next
  heading *of any level* — rather than at the next heading of the same or a
  shallower level — is what keeps each paragraph in exactly one block. The
  alternative, one block per chapter including its descendants, would have
  serialised a paragraph nested three levels deep into four blocks, so the
  payload would grow with nesting depth instead of with the document. Because
  the outline lives on the blocks themselves, that compression costs nothing in
  expressiveness: the payload carries one body copy plus a few indices per
  block (`subtree` averages under six entries, bounded by the six heading levels
  Markdown allows), and `tests/e2e.rs` asserts both that joining a root subtree
  reproduces `doc.html` byte for byte and that block markup costs exactly one
  body copy however deep the outline goes.
- **Chapter anchors are checked at build time.** A block reference's anchor is
  matched against the target document's headings, which cannot be known while
  that document is still unrendered — so a lightweight pre-pass walks only the
  heading events of every document first, then links are resolved in one pass.
  Both routes build heading text through the same `HeadingText` accumulator and
  the same `Slugger`, so a chapter the build accepts is a chapter the reader can
  reach. Matching returns the anchor that hit — exactly, trimmed, or through its
  slug — and the route carries *that* anchor, because only the emitted slug is
  an element id: `#1.4 配色与字体` is rewritten to
  `#14-配色与字体`. An anchor that does not resolve is a warning, and the
  route is rewritten without it: the reader opens the correct document from the
  top and shows a banner naming the missing chapter.
- **A broken reference carries the chapter it asked for as data.** Dropping the
  anchor keeps the document reachable, but it also throws away the only thing
  the reader needs to explain the failure, so the authored spelling travels with
  the link instead: the build writes `class="doc-link-missing"
  data-wikicc-missing-anchor="<authored chapter>"` and every consumer picks it up
  from there. The attributes cannot go on the anchor itself — `pulldown-cmark`
  owns a link's attributes during serialisation — so they are written on an
  inline `<span hidden>` placed immediately before it, the one shape the
  serialiser emits without a trailing newline and which stays valid inside a
  paragraph, a list item or a table cell. The document therefore marks a broken
  reference statically (`.doc-link-missing`), and nothing about the route
  grammar changes. Reference definitions resolved through `refdefs` carry the
  same mark, so a link is treated identically wherever the author wrote it.
- **Hovering a broken reference shows a notice, not the banner.** There is no
  chapter to preview, and saying so where the pointer already is answers the
  question it is asking. The notice reuses the block-reference popover — same
  element, same positioning, same open/close delays — switched into a second
  role by `data-missing`: the preview body is emptied and a heading plus one
  sentence naming the document and the authored chapter take its place. Both
  roles are written as text into elements that exist from the first hover, so
  neither a path nor a heading can become markup, and switching between them
  leaves nothing of the other behind.
- **The missing-chapter banner is an overlay.** It lives in a slot beside the
  article inside `.content`, is positioned out of the flow and animated with
  opacity, so showing or hiding it never reflows the document — a navigation to
  a chapter that does not exist looks exactly like one that does. It dismisses
  itself on a timer, has a close button, and is announced politely
  (`role="status"`), since it explains the navigation the reader just made
  rather than interrupting them. Only a *click* raises it: the message is queued
  for the render the click triggers, because rendering a document starts by
  dismissing whatever the previous navigation had to say. The reader also
  resolves an anchor through the payload's outline, so an artifact built before
  the rewrite above still navigates.
- **Determinism of the graph.** The force layout is seeded from a hash of the
  document ids, the same generator feeds the initial jitter and
  `simulation.randomSource()`, and the simulation is stepped synchronously, so
  the same input always produces the same picture.
- **Outline scroll-spy.** The active chapter is decided by position, not by
  visibility: each heading's absolute top is measured once, `pickActive` finds
  the last heading above a reading line at 25% of the viewport, and scrolling
  only re-runs that binary search. An intersection-based spy cannot express
  "between two headings, still inside this section", which is why a long table
  used to knock the outline back to the first entry. A click or a deep link
  locks its entry until the jump settles (`scrollend`, or an idle window while
  the pointer is not mid-gesture), so a smooth scroll does not light up every
  section it passes.
- **Theme and diagrams.** Light and dark are one set of CSS custom properties
  on the root element; the toggle only swaps an attribute. Mermaid re-measures
  geometry, so the reduced-motion media query disables transitions outright
  inside diagram containers — a merely tiny duration still creates a transition
  and distorts the measurement.
- **Weight.** Minification is what keeps the page at ~5 MB (the diagram engine
  alone is ~12 MB unminified). A size guard in `render.rs` fails the build if
  the bundle regresses, and the tests assert string literals rather than
  identifiers, because minified names are not stable.

## 6. Testing

| Layer | Location | Tooling | Covers |
| --- | --- | --- | --- |
| Rust unit | `#[cfg(test)]` in each module | `cargo test --lib` | slugs, TOC, links, assets, highlighting, render, writers, options, pipeline |
| Rust integration | `tests/*.rs` | `assert_cmd`, `tempfile`, `predicates` | CLI, scan, markdown, writers, end to end |
| Front-end unit | `tests/js/*.test.js` | `node --test`, `node:assert` | router, search adapter, table sort/filter model, graph layout, outline scroll-spy, block-reference preview |
| Bridge | `tests/js_suite.rs` | `Command::new("node")` | runs the JS suite inside `cargo test` |

Fixtures under `tests/fixtures` are committed sites: `site/` (three documents,
one asset, table, diagram, clean under `--strict`), `links/` (every destination
shape including a broken link and an escaping asset) and `code/` (highlighting
cases). No test touches the network; the front-end dependencies are installed
once with `npm ci` and the tests only read `node_modules`.

Quality gates for any change: `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings` and `cargo test` must all pass.

## 7. Known limitations and risks

| Limitation | Impact | Mitigation |
| --- | --- | --- |
| Embedded diagram engine (~5 MB minified) | every format carries the engine | minify plus a size guard; the engine is only initialised when the current document has a diagram |
| Front-end dependencies are installed outside Cargo | `cargo build` needs `npm ci` first | `build.rs` fails with an actionable message; versions and bytes are pinned |
| `file://` restrictions (CORS, module scripts) | a naive SPA would break | payload inlined, no `fetch`, one classic script |
| Large media in memory | peak RAM during base64 encoding | single-pass placeholder expansion into one reused buffer, so peak memory is the page plus one asset |
| Raw HTML passthrough | XSS if untrusted Markdown is compiled | documented as trusted-input behaviour; no sanitizer |
| No incremental build | full rebuild on every run | acceptable at folder scale; the artifacts are deterministic |
| A block ends at the next heading of *any* level, so it holds its own content only | none for a consumer: the block carries the outline itself, and `subtree` names the block plus every block nested under it, so a whole chapter is a lookup rather than a walk | the alternative — one block per chapter including its descendants — would repeat every paragraph under every ancestor and grow the payload with nesting depth; the compressed form is one body copy plus a few indices per block, and `tests/e2e.rs` asserts the join reproduces `doc.html` exactly |
| `package-lock.json` resolves through an internal mirror | publishing outside that network needs a regenerated lockfile | regenerate against the public registry before release |
