# wikicc — Tests

How the test suite is organised: where a test lives, what it drives, how to run
it, and the conventions a new test has to follow. The architecture the tests
protect is described in [`../docs/design.md`](../docs/design.md); the features and
usage they pin down are described in [`../README.md`](../README.md).

The suite runs entirely offline. Nothing here starts a browser, downloads a
fixture or reaches the network: the Rust stages are pure transformations, the
artifact is asserted as text, and the reader's view modules are driven through
small fake DOMs that follow the browser's semantics rather than inventing them.
A change that has to be seen in a real browser is confirmed manually with a
headless Chrome session before it is considered done.

## How to run

```sh
npm ci                                    # once, and whenever package-lock.json changes
cargo test                                # everything, including the front-end suite
cargo test --test links                   # one Rust integration file
cargo test --lib                          # the in-module unit tests only
node --test "tests/js/*.test.js"          # the front-end suite on its own
```

`npm ci` is a prerequisite for anything that builds or runs the reader: the
front-end modules import `minisearch`, `d3-*` and `mermaid` by bare specifier,
and `build.rs` bundles them with esbuild.

`npm ci` also decides which esbuild `build.rs` runs, and it does so differently
per platform: a Windows install leaves the JavaScript launcher at
`node_modules/esbuild/bin/esbuild`, while a POSIX install links the native
`@esbuild/<os>-<cpu>` executable over that same path. `build.rs` resolves the
executable itself and only starts it with `node` when it is really a script.

Three failure modes are worth knowing about, because they look alike and are not:

| Symptom | Meaning |
| --- | --- |
| `skipping the front-end suite: node was not found on PATH` | Node is missing. The bridge prints a notice and passes, so the Rust suite stays runnable on a machine without Node. |
| `the front-end dependencies are missing: run npm ci in … first` | Node is present but `node_modules` is not populated. This is an assertion failure, not a skip, because the front-end suite cannot produce a meaningful result. |
| `cannot bundle the front-end sources: no esbuild executable was found` | `node_modules` exists but the bundler does not: the `@esbuild/*` package and the launcher are both absent, usually because `npm ci` ran with `--omit=optional`. |

`node --test` does not expand a directory argument on every platform, so the
front-end suite is always given files rather than a folder: the glob above for
the `node` command, and the explicit sorted list of `*.test.js` files that
`tests/js_suite.rs` builds when it runs the suite from inside `cargo test`.

## The four layers

| Layer | Location | Tooling | Scope |
| --- | --- | --- | --- |
| Rust unit | `#[cfg(test)]` in each module | `cargo test --lib` | one module's own rules: slugs, TOC, links, assets, highlighting, render, writers, options, pipeline, error mapping |
| Rust integration | `tests/*.rs` | `assert_cmd`, `predicates`, `tempfile` | one stage or one contract each, plus the binary end to end |
| Front-end unit | `tests/js/*.test.js` | `node --test`, `node:assert/strict` | pure reader logic, and the view modules through a fake DOM |
| Bridge | `tests/js_suite.rs` | `Command::new("node")` | runs the front-end suite inside `cargo test` |

The layers exist because of where the logic lives. Every Rust stage except
`write` is a pure transformation over immutable data, so it is tested without a
filesystem. The reader is split the same way: pure functions in `router.js`,
`links.js`, `search.js`, `table.js`, `graph.js`, `preview.js`, `toc.js`,
`anchor.js`, `diagrams.js`, and DOM access confined to the `*-view.js` modules,
`banner.js` and `app.js`. That split is what keeps the front-end suite runnable
under Node, which has no DOM.

## Rust integration files

Each file owns one stage or one contract. Files run in parallel by default;
anything that asserts on a directory works in a `tempfile` of its own.

| File | SUT | What it asserts |
| --- | --- | --- |
| `cli.rs` | the compiled binary: `src/cli.rs`, `src/options.rs`, `src/pipeline.rs` | `--help` lists every documented option, `--version`, the default `dist` output directory, `--out`, rebuilding over a previous build, `--force` for a foreign directory, the retired format as a usage error, `--quiet`, the summary counts, warning and `--strict` behaviour |
| `scan.rs` | `src/scan.rs` | recursive discovery and the document order, the output directory never entering the document list, an empty folder warning without failing, non-UTF-8 files skipped with a warning, case-insensitive extensions, one note for non-Markdown files, dot directories and `node_modules` excluded, `SourceDoc` fields, diagnostic severities |
| `markdown.rs` | `src/markdown/` | the supported GFM subset, ASCII/CJK/repeated-heading anchors, outline order and nesting (including level jumps), fences never producing headings, `[[n]]` citations and their reference list, author HTML passed through, fence highlighting, the Mermaid fence becoming a diagram, the highlighting theme |
| `links.rs` | `src/markdown/links.rs`, `src/markdown/sections.rs`, `src/assets.rs` | every destination shape of the link matrix, unresolvable targets keeping their destination, duplicate references sharing one asset, warnings naming document and line, a missing chapter still opening its document and being marked for the reader, chapter anchors rewritten to the emitted slug, relative directories, definition links, binary assets, CJK paths |
| `site.rs` | `src/site.rs` | payload order and uniqueness, edges deduplicated and free of self-loops, external and anchor links never becoming edges, JSON keys and counts, assets addressed by placeholder, `text` as searchable content, the outline tree, lookup by id, assembly never touching the source tree |
| `e2e.rs` | `scan` → `build_site` → `render_site`, and the compiled binary | the page's required markers, the payload embedded and escaped, one `<script>` and one `<style>`, no external resource, the block model (one block per heading, subtrees that join back to the body without repeating a paragraph), the preview and banner machinery, the chapter fold arrows in the stylesheet (hidden until the heading is hovered, the glyph’s two directions, the article-only scope, no arrows on paper), both formats' artifacts, byte-identical rebuilds, the `--strict` gate writing nothing, exit codes |
| `writers.rs` | `src/writers/`, `src/render.rs` | a `single-html` build holding exactly one file, no placeholder or sibling reference surviving, the payload still parsing after inlining, stale files removed, foreign and retired directories refused, `html-dir` writing a deduplicated asset folder whose references resolve on disk and never inline as `data:` |
| `preview.rs` | `src/site.rs`, `src/markdown/links.rs`, `src/render.rs` | one reported scenario end to end: a reference to a numbered CJK chapter routes to the anchor the page really emits, is not marked broken, and the target carries the block the preview reads |
| `js_suite.rs` | `tests/js/*.test.js` | the front-end suite as one `cargo test` case, with the skip/setup-error split above and a TAP sanity check (`# fail 0`, at least one pass per file) |

`e2e.rs` carries two layers in one file, separated by a comment banner: the
first half observes the page through the library API, the second half drives
the binary. Only the binary can prove the artifacts, the reproducibility of a
build, the `--strict` gate and the exit codes, so both halves are needed and
neither replaces the other.

## Front-end files

| File | SUT | What it asserts |
| --- | --- | --- |
| `router.test.js` | `router.js` | hash parsing and formatting, percent decoding, non-document hashes, malformed encoding kept verbatim |
| `links.test.js` | `links.js` | recognising the reader's own links: route parsing, block references, plain left clicks, route identity, the missing-anchor attribute |
| `anchor.test.js` | `anchor.js`, cross-checked against `preview.js` | which chapter a route anchor addresses; the emitted slug and the author's spelling resolving to the same chapter; navigation and the hover preview never disagreeing |
| `preview.test.js` | `preview.js` | the chapter a block reference previews: its own block plus everything nested under it, never a sibling or an ancestor |
| `search.test.js` | `search.js` | CJK tokenisation, flattening a nested outline into searchable text, the `minisearch` adapter |
| `table.test.js` | `table.js` | cell type detection (numbers, thousands separators, percents), the table model's ordering and filtering |
| `toc.test.js` | `toc.js` | which section the reading line is in, including headings far outside the viewport |
| `graph.test.js` | `graph.js` | the seeded layout: stable seeds, a replayable generator, edge deduplication, degree-based radii, the same graph laid out identically twice, every node inside the normalised box, isolated documents |
| `diagrams.test.js` | `diagrams.js` | selecting diagram markup, initialising only when a diagram exists, theme mapping, a fresh config per call |
| `banner.test.js` | `banner.js` (fake DOM) | the banner taking no layout space, closing itself after the timeout, a second message restarting the countdown, a close button reachable and labelled, falling back to the document when the anchor is missing |
| `preview-view.test.js` | `preview-view.js` (fake DOM) | the popover opening for an existing chapter and turning into a notice for a missing one, the banner reserved for the click that navigates, pinning, dragging, and the close/dismiss contract |
| `graph-view.test.js` | `graph-view.js` (fake DOM, real `d3-drag`/`d3-zoom`/`d3-selection`) | one plain left click opening a node's document, a drag only moving it, a modified click staying with the browser, highlighting following the pointer |
| `app-session.test.js` | `app.js` (fake DOM, fake `location`, graph and diagrams stubbed) | a navigation that changes the address re-rendering and walking to the chapter, the walk repeated once the markup settles, a same-address navigation scrolling without re-rendering, the open document staying highlighted while filtered |
| `doc-body.test.js` | `doc-body.js` (fake DOM) | the shared body's class composition and markup injection, the caller's table and chapter options left alone unless asked, a chapter's range (nested chapters inside it, the next sibling outside), the deepest level never foldable, an arrow after every foldable heading with its `aria-expanded` and labels, folding and unfolding a chapter's own range while leaving the sibling chapter untouched, and a navigation reopening the chapters that hold it |

## Fixtures

Committed fixtures are sites, not documents: each one is pinned to a class of
input, and the tests that use it assert against the whole site.

| Fixture | Purpose | Trap |
| --- | --- | --- |
| `fixtures/site/` | the canonical site: three documents, one asset, three edges, a table, a code fence and a Mermaid fence | it is `--strict` clean, and `tests/site.rs` asserts that; adding a broken link here would fail an unrelated test |
| `fixtures/links/` | the link matrix: every destination shape in one document, next to a CJK chapter with punctuation | it deliberately carries three warnings (missing document, missing chapter, escaping asset), so it is the fixture `--strict` is *expected* to reject |
| `fixtures/code/code.md` | one fence per highlighting category | it is read with `include_str!` by `markdown.rs`, so the fence count is asserted, not just the rendering |

Most tests do not use a committed fixture. Anything about a specific edge — a
non-UTF-8 file, a document containing `</script>`, an empty folder, a stale
artifact — is written into a `tempfile` and scanned from there, which keeps the
committed fixtures small and the scenario next to its assertion.

## Conventions

**A fake DOM must keep the browser's semantics.** It implements only the members
the module under test calls, and it must not grow a member the real environment
lacks. `preview-view.test.js` deliberately omits `createElementNS` from its
element stub: a real `SVGElement` does not have that method, only `document`
does, and a stub that handed it out let a view creating SVG children through its
parent pass 30+ green cases and throw in the browser. Every capability a stub
adds has to be confirmed against the real thing first.

**Dispatch events where the listener is.** The preview delegates hover to
`content` (the `#doc-content` element it is given), so the test fires at
`content` with the link as `target`. Firing at the link itself never invokes the
handler and the case passes for the wrong reason.

**Reproduce the gesture the browser sends, not the one that is convenient.**
A pointer moving inside the popover arrives as `pointerout` → `pointerover` →
`pointerleave` → `pointerenter`, so a test that fires a single `pointerover`
misses the move *between* the sub-elements of a link. A press on a graph node
arrives as `pointerdown`/`mousedown`/`pointerup`/`mouseup` and, once `d3-drag`
has taken it with pointer capture, **no `click`** at all — and the press itself
blurs the page. `graph-view.test.js` documents the full anatomy at the top of
the file.

**Never replace a global timer for the duration of a test.** `node --test`
schedules its own bookkeeping through `setTimeout`, so a replacement that
outlives the gesture makes the process hang with every case green.
`graph-view.test.js` installs its fake timers for one gesture and restores them
in a `finally`, and drains only the timers that already exist — d3 arms new ones
from inside its own callbacks.

**Assert on literals, not identifiers.** The reader is bundled by esbuild as a
minified IIFE, so `e2e.rs` asserts on string literals and attribute names
(`wikicc-payload`, `table-filter-toggle`, `graph-node`) because minification
leaves those alone. A test that names an exported function inside the bundle is
testing the bundler.

**Determinism is a contract, so it is asserted at every layer.**
`markdown.rs` renders a source twice, `site.rs` compares the payload JSON,
`e2e.rs` and `writers.rs` compare whole output trees for both formats.
Reproducibility is what the content-addressed assets and the sorted collections
exist for, so a stage that introduces a timestamp or a map iteration order is
caught by the stage's own file.

**Desensitise before reproducing.** Any scenario taken from a user report is
rewritten into unrelated wording in both the fixture and the test. A test that
quotes the reported document is a leak, and the assertion never actually needs
those words — only their shape (a numbered CJK heading, a nested chapter).

**No network, no browser.** A test may not fetch, and may not assume a browser is
installed. The binary tests run in a `tempfile`; the front-end tests run under
Node with a hand-written DOM.

**The highlighting guard is real.** The unit test in `src/markdown/highlight.rs`
asserts a wall-clock budget on a 5000-line code block. `Cargo.toml` compiles
`syntect`, `fancy-regex` and `regex-automata` at `opt-level = 3` even in the dev
and test profiles so that the guard measures the engine rather than the
unoptimised build.

## Where a new test belongs

| The change | The test |
| --- | --- |
| a pure function in a Rust module | the module's `#[cfg(test)]`, next to the code |
| one pipeline stage's output | the stage's `tests/*.rs` file (`scan`, `markdown`, `links`, `site`, `writers`) |
| the artifact, the CLI surface, a `--strict` or exit-code rule | `tests/cli.rs`, `tests/writers.rs` or the binary half of `tests/e2e.rs` |
| the page against the payload | the library half of `tests/e2e.rs` |
| a reported scenario that crosses stages | a new file named after the scenario (`tests/preview.rs` is the model), with its own `tempfile` site and a header comment naming the root cause |
| a pure reader function | a `tests/js/<module>.test.js` next to its siblings |
| a reader view | a `tests/js/<module>-view.test.js` with a fake DOM, or the view's own file if it has one |

Name a test after the rule it enforces, not the function it calls:
`a_missing_chapter_still_opens_its_document` states a promise a reader can
notice; `test_links` does not. A regression test carries a header comment saying
which defect it pins down and where the other half of the scenario is tested, so
a later reader knows why the assertion is shaped the way it is.

## Quality gates

Every change has to leave all four green; the first three are what
`.github/workflows/lint.yml` runs in CI:

```sh
cargo fmt --check                          # Rust formatting
cargo clippy --all-targets -- -D warnings  # Rust lint
npm run check                              # JS formatting and lint (Biome)
cargo test                                 # everything, including the front-end suite
```

## See also

- [`../docs/design.md`](../docs/design.md) — layers, pipeline stages, invariants and the determinism rules the tests enforce.
- [`../README.md`](../README.md) — the features and the usage these tests describe. It is deliberately kept to features and usage only, so a rule that only matters to a test is stated here or in the test's header comment, never in the product README.
