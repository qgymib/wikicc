# Changelog

All notable changes to `wikicc` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries describe what a user of the binary can observe, not how the change was
implemented; the rules behind them live in `docs/design.md`.

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
