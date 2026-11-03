# wikicc — Architecture

This document describes how `wikicc` is built: its layers, the direction of
their dependencies, the invariants the stages must keep, and the constraints
that shape them. It deliberately stays at that level — product behaviour is
described in `README.md`, and per-stage implementation details live in the code.

## 1. Shape of the system

`wikicc` is one Rust binary plus one embedded front-end bundle. The binary owns
everything that can be decided at build time; the bundle owns everything that
has to happen in the reader. They communicate through exactly one channel: a
JSON payload embedded in the page.

```
            build time                        │        run time
                                              │
  input dir ──▶ pipeline stages ──▶ artifact  │  artifact ──▶ reader modules
  (Rust: scan, parse, resolve,                 │  (ES modules bundled by
   assemble, render, write)                    │   esbuild, inlined as one
                                              │   classic script)
                              payload (JSON) ─┼─▶
```

Nothing is resolved at run time across the boundary: the bundle knows its
imports when it is built, and the payload is already on the page when the
script runs. There is no server in either half.

## 2. Pipeline

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

## 3. Module map

```
src/main.rs                 binary: parse arguments, run the pipeline, map errors to exit codes
src/lib.rs                  library root and re-exports
src/cli.rs                  clap definitions
src/options.rs              defaults, lexical path normalization, output-path guards
src/error.rs                error type and exit-code mapping
src/pipeline.rs             stage order, strict gate, summary lines
src/scan.rs                 discovery, ordering, ids, titles, diagnostics
src/markdown/               render orchestration, heading text, slugs, TOC, chapter blocks,
                            highlighting, link resolution, reference definitions
src/assets.rs               read, MIME, hashing, dedupe
src/site.rs                 payload types and assembly
src/render.rs               shell assembly (template, CSS, script, payload), size guard
src/writers/                one writer per format plus the shared placeholder expansion
src/web/                    page template, stylesheet and the reader's ES modules
build.rs                    bundles src/web/js/main.js with esbuild into OUT_DIR,
                            and embeds docs/logo.ico into the Windows executable
tools/make-icon.mjs         packs the rendered icon sizes into docs/logo.ico
```

Dependency direction is one-way: `cli` → `options` → `scan` → `markdown` →
`site` → `render` → `writers` → `pipeline`. `markdown::links` never depends on
`site`, so link resolution stays testable on its own.

## 4. Invariants

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
3. **The payload is inlined, never fetched.** The artifact must work over
   `file://`, where `fetch()` of a local JSON file is blocked by CORS, so even
   the multi-file format inlines the site JSON into the page.
4. **Assets are content-addressed.** The name is the first 16 hex characters of
   the SHA-256 digest plus the original extension, which gives free
   deduplication and stable names across builds and platforms.
5. **Fail soft by default.** Broken links and missing assets become warnings
   and the original destination is left untouched; `--strict` upgrades them to
   a non-zero exit.
6. **Raw HTML passes through unchanged.** The input is trusted (a local
   documentation folder); there is no sanitizer in this version, and this is
   documented rather than half-implemented.
7. **A block ends at the next heading of any level.** Each body is cut into
   blocks — one per heading, ending where the next heading of *any* level
   starts — so every paragraph is serialised exactly once. The outline is
   carried on the blocks themselves (`parent`, `subtree`), which keeps
   aggregation a lookup rather than a walk without repeating a paragraph under
   every ancestor. `tests/e2e.rs` asserts both halves: joining a root subtree
   reproduces `doc.html` exactly, and block markup costs one body copy however
   deep the outline goes.
8. **Heading text has one implementation.** Anchors are matched during
   resolution, before the target document is rendered, so the pre-pass and the
   renderer build heading text through the same `HeadingText` accumulator and
   the same `Slugger`. A chapter the build accepts is therefore a chapter the
   reader can reach, and the route carries the *emitted* slug, since only that
   is an element id.
9. **Static state travels in the markup.** Anything the reader must know about
   a link that the route grammar cannot express is written into the document as
   `data-*` attributes, and every consumer reads it from there. Because
   `pulldown-cmark` owns a link's attributes during serialisation, such
   attributes go on an inline `<span hidden>` immediately before the link —
   the one shape the serialiser emits without a trailing newline and which
   stays valid inside a paragraph, a list item or a table cell.

## 5. Determinism

Two builds of the same input produce **byte-identical** artifacts. This is a
hard requirement, not an aspiration, and it constrains every stage:

- documents are ordered by relative path in byte order;
- collections that reach the output are `BTreeMap`/`BTreeSet` or explicitly
  sorted;
- assets are named after their content hash, so duplicates collapse and names
  do not depend on discovery order;
- no artifact contains a timestamp, an absolute path, a host name or a random
  value. The elapsed time exists only in the stdout summary;
- on the front end, the force layout is seeded from a hash of the document ids,
  the same generator feeds the initial jitter and `simulation.randomSource()`,
  and the simulation is stepped synchronously.

## 6. Contracts at the edges

These are the boundaries where an internal change becomes observable, so each
one is stated as a contract rather than left to the implementation.

- **CLI surface.** `cli` defines the arguments; `options` turns them into
  `Options` and owns the output-directory guards (missing and empty are used,
  a previous artifact is emptied, anything else needs `--force`, and the output
  directory may not be the input root, its ancestor or the working directory).
  Three combinations are rejected before anything is written.
- **Exit codes.** `error` maps every failure to `0` (success, possibly with
  warnings), `1` (runtime failure, including `--strict` with warnings) or `2`
  (usage error, reported by `clap`). The mapping is centralised so a new stage
  cannot invent a code.
- **Streams.** Diagnostics go to stderr, the summary line to stdout (unless
  `--quiet`). The summary names counts, output directory, format and elapsed
  time — never a value that ends up inside an artifact.
- **Testability.** Everything the run prints goes through a `std::io::Write`
  sink rather than `println!`, so wording, gate and `--quiet` are unit tested
  without spawning a process.
- **Formats.** The two writers share the page and the asset table and never
  re-render markup; each differs only in asset addressing. The multi-file writer
  writes the page last, so the artifact never references a file that is not on
  disk, and an asset-free site writes no empty directory.
- **Weight.** `render.rs` holds a size guard that fails the build if the bundle
  regresses.
- **The Windows icon.** A Windows executable shows an icon in the file
  explorer, and that icon lives in the PE resource section. `docs/logo.svg` is
  the design source; `docs/logo.ico` is rendered from it and committed, so the
  build needs no image toolchain and stays reproducible. `build.rs` compiles
  the icon into the executable for Windows targets only, and every other target
  produces exactly the binary it produced before. The icon is the only thing
  the resource section carries, and the program keeps its console subsystem:
  the CLI writes to stdout and stderr as before.

## 7. Front end

- **Build chain.** The reader is native ES modules under `src/web/js`, importing
  the engines by bare specifier. `build.rs` runs the npm-installed esbuild over
  `main.js` and stages one minified IIFE in `OUT_DIR`, which `render.rs` inlines
  with `include_str!`. The page therefore has exactly one classic `<script>`,
  needs no module loader and resolves nothing at runtime.
- **Which esbuild.** `node_modules/esbuild/bin/esbuild` is not one kind of file:
  a Windows install keeps the JavaScript launcher there, while a POSIX install
  links the native executable of the `@esbuild/<os>-<cpu>` package over the same
  path. `build.rs` therefore resolves the executable the way esbuild's own
  install script does (an explicit `ESBUILD_BINARY_PATH`, then the platform
  package, then the installer's download, then the launcher) and executes a
  native binary directly, falling back to `node` only for a real script, so the
  ELF file a POSIX install leaves at the launcher path is never fed to `node`.
- **Dependencies.** Third-party JavaScript is ordinary npm, with exact versions
  in `package.json` and bytes pinned by `package-lock.json`. `npm ci` is a build
  prerequisite; a missing dependency fails the build with an actionable message
  instead of degrading silently.
- **Layering rule.** Pure logic and DOM access live in separate modules
  (`router.js`, `links.js`, `search.js`, `table.js`, `graph.js`, `preview.js`,
  `toc.js`, `anchor.js` versus `table-view.js`, `graph-view.js`,
  `diagram-view.js`, `preview-view.js`, `banner.js`, `doc-list.js`), because the
  JS test suite runs under `node --test` with no DOM. Anything that touches
  `document` belongs to a view module; a view is a projection of the pure
  functions beneath it, and the controller (`app.js`) is the only module that
  wires views to the payload and the router.
- **No UI framework.** The reader stays on native DOM. The interactive surface
  is one popover plus a few attribute toggles, which does not pay for a
  component runtime: a framework bundle would fight the single-inline-classic-
  script requirement, add an output layer to the byte-identical bundle and
  force a DOM test environment on logic that is otherwise covered by
  `node --test`. `esbuild` and plain ES modules stay the whole front-end build
  chain.
- **Gesture state belongs to the module that takes it.** A press is recorded by
  the module that saw it, because the browsers and the d3 behaviours cancel
  every press they take, so a cancellation says nothing about ownership. A
  press is only ended early by a window that no longer holds the focus.
- **One CSS custom-property set per theme.** Light and dark are one declaration
  block switched by a root attribute; the toggle changes no other state.

## 8. Testing

| Layer | Location | Tooling | Covers |
| --- | --- | --- | --- |
| Rust unit | `#[cfg(test)]` in each module | `cargo test --lib` | slugs, TOC, links, assets, highlighting, render, writers, options, pipeline |
| Rust integration | `tests/*.rs` | `assert_cmd`, `tempfile`, `predicates` | CLI, scan, markdown, writers, end to end, the esbuild launcher `build.rs` picks |
| Front-end unit | `tests/js/*.test.js` | `node --test`, `node:assert` | router, search, table model, graph layout, outline, preview, banner |
| Bridge | `tests/js_suite.rs` | `Command::new("node")` | runs the JS suite inside `cargo test` |

Fixtures under `tests/fixtures` are committed sites, each pinned to one class of
input; no test touches the network. The front-end dependencies are installed
once with `npm ci` and the tests only read `node_modules`.

Quality gates for any change: `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings` and `cargo test` must all pass.

## 9. Constraints and risks

| Constraint | Impact | Mitigation |
| --- | --- | --- |
| Embedded diagram engine dominates the bundle | every format carries it | minification plus a size guard; the engine is only initialised when the current document has a diagram |
| Front-end dependencies are installed outside Cargo | `cargo build` needs `npm ci` first | `build.rs` fails with an actionable message; versions and bytes are pinned |
| The npm esbuild launcher is a script on Windows and a native binary elsewhere | running the launcher path through `node` fails on POSIX | `build.rs` resolves the executable and starts a script with `node` only; a native binary runs directly |
| `file://` restrictions (CORS, module scripts) | a naive SPA would break | payload inlined, no `fetch`, one classic script |
| Large media in memory | peak RAM during base64 encoding | single-pass placeholder expansion into one reused buffer, so peak memory is the page plus one asset |
| Raw HTML passthrough | XSS if untrusted Markdown is compiled | documented as trusted-input behaviour; no sanitizer |
| No incremental build | full rebuild on every run | acceptable at folder scale; the artifacts are deterministic |
| The Windows icon is a derived asset | `docs/logo.svg` and `docs/logo.ico` can drift apart | the icon is rendered from the source and committed, and `tools/make-icon.mjs` packs it deterministically; regenerating it after a design change is a documented manual step |
