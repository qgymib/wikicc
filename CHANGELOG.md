# Changelog

All notable changes to `wikicc` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries describe what a user of the binary can observe, not how the change was
implemented; the rules behind them live in `docs/design.md`.

## [Unreleased]

### Changed

- Release archives are now named after the build system and architecture as
  well as the version (`wikicc-ubuntu-amd64-v<semver>-<sha>.tar.gz`,
  `wikicc-windows-amd64-v<semver>-<sha>.zip`) instead of the vaguer
  `wikicc-linux-release-…` / `wikicc-windows-release-…` names.
- The link graph is laid out into a frame that follows the number of
  documents, so a small neighbourhood stays centered and readable instead of
  being stretched to the corners of the panel; nodes and labels are drawn
  larger to match.
- The search button lives in the top bar, which is now visible at every width
  as the app's own toolbar, instead of in a row inside the graph panel; the
  search panel drops down beneath the bar rather than covering the graph, and
  pressing the button again closes it.

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
