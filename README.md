# wikicc

Compile a folder of Markdown documents into a self-contained, offline HTML
reader you can double-click.

One command scans the folder, renders every document, resolves every link and
asset, and writes **one artifact** that needs no server, no sibling files and no
network. Open it and read: search the whole folder, read a document with syntax
highlighting and Mermaid diagrams, follow the link graph between documents, and
navigate long documents through their chapter outline.

## Features

### Reader

- **Search** over titles, headings and body text, including CJK, with multiple
  words combined as AND.
- **Link graph** of the folder with zoom, pan and drag; clicking a node opens
  that document.
- **Chapter outline** of the current document, highlighting the section being
  read.
- **Tables**: click a header to sort; open the funnel on the right of a header
  to tick the values you want, or type to narrow that list, Excel-style.
- **Theme** toggle (light/dark) and a page that stays usable down to phone width.

### Markdown support

GitHub-flavored Markdown plus footnotes, task lists and strikethrough, rendered
with stable heading anchors (Unicode-aware, so CJK headings keep their text) and
a nested chapter outline. Tables become sortable in the reader, and every column
gets an Excel-style filter list of its distinct values.

Fenced code blocks are highlighted at build time (no client-side highlighter,
no grammar files loaded at runtime). A fence tagged `mermaid` becomes a diagram
rendered by the embedded Mermaid engine (pinned at **12.2.0**).

Raw HTML inside Markdown is passed through unchanged: the input is trusted, so
there is no sanitizer — do not compile untrusted documents.

### Output formats

| Format | Artifact | Assets | Trade-off |
| --- | --- | --- | --- |
| `single-html` (default) | one `index.html` | inlined as `data:` URIs | one file to send anywhere; ~4/3 the asset bytes, no browser caching |
| `html-dir` | `index.html` + `assets/` | `assets/<hash>.<ext>` | smallest artifact, copyable or servable as-is, one file per unique resource |
| `mhtml` | one `index.mhtml` | `cid:<hash>` parts | a mail-style archive; scripts do not run in Chromium (see below) |

All three carry the same page. Assets are content-addressed by a truncated
SHA-256, so identical bytes are stored once no matter how many documents
reference them, and names are stable across builds and machines.

- **`single-html`** inlines the stylesheet, the reader script, the site payload
  and every referenced asset, so it opens by double click, offline, from any
  directory, with no sibling files. The fixture site produces a ~5.3 MB page,
  most of which is the embedded diagram engine.
- **`html-dir`** writes the same page as `index.html` next to an `assets/`
  folder. Every reference in the page is relative, so the whole directory can be
  copied, zipped or served statically. A site without assets writes only the
  page — no empty folder.
- **`mhtml`** writes the same page as a single `multipart/related` archive. The
  HTML part comes first, every resource travels as a base64 part addressed by
  `cid:<hash>`, and each part also carries
  `Content-Location: assets/<hash>.<ext>` for readers that follow RFC 2557.

**Chromium-based browsers read the MHTML archive but do not run scripts inside
it.** The main frame is sandboxed without `allow-scripts`, so the reader stops
at its "This reader needs JavaScript to display the documents" notice: the
markup, the stylesheet and the `cid:` images do render, but the document list,
the search, the graph and the diagrams do not. This is a browser policy that no
archive can lift. Use `single-html` or `html-dir` for a reader you can navigate,
and `mhtml` for archives that have to travel as one mail-style file. The CLI
repeats this note on stderr when the format is selected.

### Offline and determinism

- Nothing is fetched at runtime: the payload is embedded in the page, because
  `fetch()` of a local JSON file is blocked by CORS under `file://`.
- No CDN, no web font, no remote stylesheet: the page has one inline
  `<style>` block and one inline classic `<script>`.
- The build itself never touches the network. The only network step is the
  one-time `npm ci` that installs the pinned front-end dependencies.
- Two builds of the same input are byte identical: stable document order,
  sorted collections, content-hash asset names and no timestamps.

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

Both the compiled binary and the generated HTML have no external dependencies:
the stylesheet, the reader script, the site payload and every referenced asset
travel inside the artifact.

### Command line

```
wikicc <INPUT_DIR> [OPTIONS]

  -o, --out <DIR>        Output directory [default: <INPUT_DIR>/dist]
      --format <FMT>     single-html | html-dir | mhtml [default: single-html]
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

A successful build prints one line on stdout:

```
compiled 3 documents, 1 asset -> path/to/docs/dist (single-html) in 84 ms
```

Diagnostics — notes, warnings, the warning count and the MHTML note — go to
stderr. `--quiet` suppresses only the summary line.

### Output directory rules

- A missing directory is created; an empty one is used as it is.
- A directory that holds a previous artifact (`index.html` or `index.mhtml`) is
  emptied and reused, so rebuilding needs no flags and leaves no stale files.
- Any other non-empty directory is refused with a `--force` hint, because
  `--out` can point anywhere and silently deleting unrelated files is data loss.
  Only the entries *inside* the directory are removed; symbolic links are
  removed as links, never followed.
- Three combinations are always rejected before anything is written: the output
  directory equal to the input root, an ancestor of the input root, and the
  current working directory.
- The output directory is excluded from scanning, so rebuilding never
  recompiles previous artifacts.

### Warnings and `--strict`

Broken links, missing assets and links that escape the input directory are
warnings: the build still succeeds, the original destination is left untouched
and the message names the document and line. They are summarized as
`N warnings (use --strict to fail)`.

`--strict` turns them into a failure (exit code 1) and reports the offending
links. The gate runs before anything is written, so a refused build neither
creates an artifact nor empties a previous one.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (possibly with warnings) |
| 1 | Runtime failure: missing input, I/O error, `--strict` with warnings |
| 2 | Usage error: invalid arguments |

## License

GPL-3.0-only. See [LICENSE](LICENSE) for the full text.
