# wikicc

Compile a folder of Markdown documents into a self-contained, offline HTML
reader you can double-click.

The compiled reader needs no server, no sibling files and no network: search the
whole folder, read a document with syntax highlighting and Mermaid diagrams,
follow the link graph between documents, and navigate long documents through
their chapter outline.

## Features

### Reader

- **Search** over titles, headings and body text, including CJK.
- **Link graph** of the folder with zoom, pan and drag; clicking a node opens
  that document.
- **Chapter outline** of the current document, following the section being read.
- **Block references**: a link to a chapter of another document previews that
  chapter on hover and opens it on click. A chapter that does not exist is
  reported as a broken reference and explained by the reader.
- **Tables**: sorting and Excel-style per-column filtering.
- **Theme** toggle (light/dark) and a layout that stays usable down to phone
  width.

### Markdown support

- GitHub-flavored Markdown: tables, task lists, strikethrough and footnotes.
- Nested chapters with stable, Unicode-aware heading anchors, so CJK headings
  keep their text.
- Chapter links: `[label](path/to/doc.md#chapter)` addresses one chapter of
  another document, `[label](path/to/doc.md)` addresses the document as a whole.
- Fenced code highlighting, done at build time.
- Mermaid diagrams from a fence tagged `mermaid`.
- Raw HTML inside Markdown, passed through unchanged. **The input is trusted:
  there is no sanitizer, so do not compile untrusted documents.**

### Output formats

| Format | Artifact | Assets |
| --- | --- | --- |
| `single-html` (default) | one `index.html` | inlined into the page |
| `html-dir` | `index.html` + `assets/` | one file per unique resource |

Both formats carry the same page. Assets are content-addressed, so identical
bytes are stored once no matter how many documents reference them.

- **`single-html`** opens by double click, offline, from any directory, with no
  sibling files.
- **`html-dir`** is smallest and can be copied, zipped or served statically as it
  is.

### Offline and reproducibility

- Nothing is fetched at runtime: no CDN, no web font, no remote stylesheet.
- The build itself never touches the network; the only network step is the
  one-time `npm ci` that installs the pinned front-end dependencies.
- Two builds of the same input produce byte-identical artifacts.

## Usage

### Prerequisites and install

- **Rust 1.85 or newer** (the crate uses edition 2024).
- **Node.js 22.12 or newer** and npm — the reader is bundled at build time, and
  22.12 is the floor of the diagram engine.

```sh
npm ci                     # once, and again whenever package-lock.json changes
cargo build --release      # build.rs bundles the reader into the binary
cargo install --path .     # optional: put `wikicc` on PATH
```

The compiled binary and the generated HTML have no external dependencies.

### Command line

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

```sh
wikicc path/to/docs                       # writes path/to/docs/dist/index.html
wikicc path/to/docs -o build --title "Handbook"
wikicc path/to/docs --format html-dir
wikicc path/to/docs --strict              # broken links fail the build
```

A successful build prints a summary line and reports diagnostics on stderr;
`--quiet` suppresses the summary only.

### Output directory

- A missing directory is created; an empty one is used as it is.
- A directory holding a previous build is emptied and reused, so rebuilding needs
  no flags and leaves no stale files.
- Any other non-empty directory requires `--force`.
- The output directory cannot be the input folder, an ancestor of it, or the
  current working directory, and it is excluded from scanning.
- Symlinks inside the output directory are removed as links, never followed.

### Warnings and `--strict`

Broken links, missing assets, chapter anchors a document does not have and links
that escape the input directory are warnings: the build still succeeds and the
original destination is left untouched, so the reader can still show the link.

`--strict` turns warnings into a failure. The gate runs before anything is
written, so a refused build neither creates an artifact nor empties a previous
one.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (possibly with warnings) |
| 1 | Runtime failure: missing input, I/O error, `--strict` with warnings |
| 2 | Usage error: invalid arguments |

## Documentation

- [`docs/design.md`](docs/design.md) — how `wikicc` is built.
- [`tests/README.md`](tests/README.md) — how the test suite is organised.

## License

GPL-3.0-only. See [LICENSE](LICENSE) for the full text.
