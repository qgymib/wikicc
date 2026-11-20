# Changelog

All notable changes to `wikicc` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries describe what a user of the binary can observe, not how the change was
implemented; the rules behind them live in `docs/design.md`.

## [2.3.0] - 2026-11-20

Audio and video play in place, documents collect their body tags and
their backlinks are one click away, and the reader can be built in
English or Chinese.

### Added

- Audio and video play in place. A reference to an audio or video file
  renders as a player with controls inside the article, and a link to
  one opens the viewer window with the same player instead of
  navigating away.
- A `language` setting. `en` or `zh`, case-insensitive and taken from
  the same three sources as every other setting, builds the reader for
  English or Chinese: copy baked into the documents at build time —
  dead-link reasons, tag labels — is written in that language and reads
  correctly without JavaScript, and the copy the reader renders itself
  follows suit. Any other value fails the build.
- Body tags. A `#tag` written in a document's body is collected at
  build time; the reader gains a tags panel listing every tag and the
  documents carrying it, and picking a tag — in the panel or on a chip
  in an article — filters the sidebar down to those documents.
- Backlinks. The floating window gains a backlinks view listing every
  document that links to the one being read; an entry navigates there
  on click.
- Mermaid diagrams join the content viewer. Hovering a rendered diagram
  shows the toolbar, and opening it enlarges the diagram in the lightbox
  with the viewer's zoom controls.
- Links with no target in the site are dead. A link that resolves to no
  document renders as dead and the reader stops its click, with the
  reason spelled out in the tooltip; a link to a real document but a
  missing chapter keeps working and says so.
- Extensionless assets are sniffed. An asset referenced without an
  extension is typed from its contents — text that reads as UTF-8
  without control bytes is served as `text/plain`, anything else falls
  back to `application/octet-stream` — and the file written beside the
  site takes its extension from that type.

### Changed

- An omitted input directory means the current directory. Building
  without a positional input used to fail; it now compiles the working
  directory.

### Fixed

- The mermaid frame no longer lingers after the viewer closes.
- Wheel zoom anchors at the cursor: the point under it stays put while
  zooming a viewer image.
- A press outside the graph panel closes it.

## [2.2.0] - 2026-11-17

Builds run in parallel across the machine's cores, a front matter title
can name the document, and a sealed document carries its assets with it.

### Added

- Parallel compilation. The per-document work — rendering each document's
  Markdown, resolving its links and assets, sealing the documents marked
  `encrypt` — runs across the machine's cores and is merged in scan order,
  so the worker count changes how long a build takes, never the bytes.
  `--jobs N` caps the worker threads (`--jobs 1` keeps the parallel stages
  effectively sequential); the setting takes the same three sources as
  every other one — `--jobs` over `WIKICC_JOBS` over the configuration
  file's `jobs` key — and without any of them the build uses every
  available core. A value below 1 fails the build.
- A front matter `title` names the document wherever the reader shows a
  title — the sidebar, the link graph, search, the lock page and the
  browser tab — while the body keeps its headings. Numbers and booleans
  are read as text; a value that cannot become a title warns at build
  time and the first heading (else the file name) decides.
- The payload the reader loads carries a format version, and the reader
  refuses a payload whose version it does not know.

### Fixed

- Assets a sealed document references are expanded into data URIs before
  sealing, so images inside encrypted documents render in the single
  file, and assets used only by sealed documents are pruned from the site.

## [2.1.0] - 2026-11-16

A document can be sealed with a password, settings can come from
environment variables, and the reader frame is rebuilt around two slim rails
with a floating link-graph window.

### Added

- Document encryption. An `encrypt` field in a document's front matter
  (`true` for the global password, or a password of its own) seals the body
  with AES-256-GCM at build time. The password comes from `--password`, the
  `WIKICC_PASSWORD` variable, or the configuration file; building an
  encrypted document without a password available is an error naming the
  document. A locked document keeps its title visible in the sidebar and in
  search; the reader shows a locked page with an unlock form in place of the
  article, and the unlocked body is kept in memory for the session only —
  it is never written to storage.
- Environment variables as a settings source. Every option the command line
  and `.wikicc.json` accept is also spelled as a `WIKICC_`-prefixed variable
  (`WIKICC_OUT`, `WIKICC_FORMAT`, `WIKICC_TITLE`, `WIKICC_STRICT`,
  `WIKICC_HOME`, `WIKICC_EXCLUDE`, `WIKICC_FAVICON`, `WIKICC_PASSWORD`),
  read below the command line and above the file. A blank variable did not
  speak, an unknown `WIKICC_*` name is ignored, and a value that cannot be
  understood fails the build naming the variable.
- A favicon for the reader page: the project logo is embedded as the
  default, and `--favicon`, the `favicon` configuration key, or
  `WIKICC_FAVICON` points at a different file.
- Every code block in the article carries a copy button, and a successful
  copy is announced with a check.
- The link preview popover grows edge handles and can be resized from its
  borders.
- A link to another web page opens in a new tab.
- The document sidebar can be hidden and shown again at desktop widths; on
  phone widths it stays a drawer.
- The link graph is split into a local and a global panel — the current
  document's neighbourhood and the whole folder — each opened from its own
  switch on the right rail. On desktop widths the panel floats above the
  article as a window, so opening or closing it no longer shifts the layout.

### Changed

- The reader frame is rebuilt around two slim rails: the left one switches
  the sidebar between the document list and the chapter outline, the right
  one carries search, the theme switch and the link-graph switches. The top
  toolbar is gone.
- The link preview panel opens on the roomier side of the article, so it
  never covers the link it previews.

### Fixed

- Syntax highlighting in the light theme keeps its colours instead of
  washing out.
- A table keeps the column widths it was laid out with, so sorting and
  filtering no longer shift them.

## [2.0.1] - 2026-11-09

### Fixed

- Search results and their preview agree: the list is built in reading order,
  so a hit inside a code block opens at that very block, and the selected row
  always points at the passage the preview shows.
- A search hit marks the typed fragment only instead of widening to the whole
  word: searching `read` marks `read` in `reader` rather than the word. The
  number of hits is unchanged.

### Changed

- A search result's context line is cut to the width the row really has, so
  wide characters such as CJK no longer overflow it or end it early; the line
  follows the panel width and the font size as they change.

## [2.0.0] - 2026-11-06

Second release: search becomes a panel with previews, math is typeset, links
preview on hover, chapters fold, and a site can be built as a static `pages`
artifact configured by a `.wikicc.json`.

### Added

- A search panel replaces the sidebar search field. It searches the current
  document (local) or the whole folder (global), lists one row per occurrence
  with a one-line context, and previews the passage with every hit marked,
  including hits inside inline code. Enter opens a result at its place in the
  article; the arrow keys keep the selected row in sight and survive a scope
  switch.
- Math typesetting: inline `$…$` and block `$$…$$` formulas are rendered with
  the bundled KaTeX, offline like everything else.
- Hover previews cover whole documents: a link to another document previews
  the document, a link to one of its chapters previews that chapter. A preview
  opens at once with a loading state; when it cannot be built, the panel shows
  a failure notice with a retry instead of closing. Scrolling inside the
  preview never scrolls the article underneath.
- Chapter folding: an arrow beside a heading folds that chapter — and
  everything nested under it — down to its title, and unfolds it again. The
  arrows appear when the pointer is on a heading, and folding is never
  remembered.
- The `pages` output format: a static site for an HTTP host such as GitHub
  Pages. The page carries the reader and a manifest only; each document is a
  JSON chunk fetched on navigation, and the global search corpus is fetched on
  first use, so first paint does not grow with the size of the folder.
- An optional `.wikicc.json` in the input folder root configures the opening
  document (`home`), excluded directories (`exclude`), the output directory
  (`out`), the format, the title and `strict`; every command-line flag
  overrides the file. `wikicc --init-config` writes a starter file without
  overwriting.
- `--exclude` keeps directories out of the site from the command line.
- Inlined `data:` asset links open as blob URLs in a new tab.
- The link graph can switch between the whole folder (global) and the current
  document's neighbourhood (local).
- Destinations of inline images and links may contain spaces.

### Changed

- Multi-character CJK queries match consecutive text only: the characters of
  a query no longer scatter across the document as separate hits.
- The search preview shows the passage alone, without a title and path banner,
  and centers the picked hit.
- The link graph is tighter: the frame adapts to the content, and nodes and
  labels are smaller.
- Release archives are named after the system that built them and the
  architecture: `wikicc-ubuntu-amd64-v<version>-<sha>.tar.gz` and
  `wikicc-windows-amd64-v<version>-<sha>.zip`.

### Fixed

- Reference-style links no longer silently degrade to plain text in
  citation-dense documents.
- The search preview lands on the right passage after a hit inside a code
  block.
- The search field shows a single clear button: the browser's native clear
  cross is hidden.
- The reader's bundled JavaScript and CSS are normalized to LF at build time,
  so two builds of one input stay byte-identical whatever the checkout's line
  endings.

## [1.0.0] - 2026-11-03

First stable release: the features the reader offers.

### Reader

- Compile a folder of Markdown documents into a self-contained reader that needs
  no server, no sibling files and no network.
- Search over titles, headings and body text, including CJK.
- Link graph of the folder with zoom, pan and drag; a plain left click opens the
  document of the node.
- Chapter outline of the current document, following the section being read.
- Block references: pointing at a chapter of another document previews that
  chapter, and the preview can be pinned and dragged out of the way. A chapter
  that does not exist is reported as a broken reference and explained.
- Tables with sorting and Excel-style per-column filtering.
- Light and dark themes, and a layout that stays usable down to phone width.

### Markdown support

- GitHub-flavored Markdown: tables, task lists, strikethrough and footnotes.
- Nested chapters with stable, Unicode-aware heading anchors, so CJK headings
  keep their text.
- Chapter links that address one chapter of another document
  (`[label](doc.md#chapter)`) or the document as a whole.
- Reference-style links (`[[n]]` plus a reference list) alongside ordinary
  Markdown links, and a reference list rendered for the styles that use it.
- Fenced code highlighting, done at build time.
- Mermaid diagrams from a fence tagged `mermaid`.
- Raw HTML inside Markdown, passed through unchanged; the input is trusted, so
  untrusted documents must not be compiled.

### Output

- Two output formats: `single-html` (one page with everything inlined, opens by
  double click from any directory) and `html-dir` (a page plus an `assets/`
  folder, ready to be copied, zipped or served as it is).
- Assets addressed by content, so identical bytes are stored once no matter how
  many documents reference them.
- Nothing is fetched at runtime: no CDN, no web font, no remote stylesheet.
- Two builds of the same input produce byte-identical artifacts.

### Executable

- One binary with no runtime dependencies: on Windows it carries the project
  logo as an icon in the file explorer.
- Statically linked release archives for Linux and Windows, so neither needs
  runtime packages on the machine that runs it.
