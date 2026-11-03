# wikicc

Compile a folder of Markdown documents into a self-contained, offline HTML
reader you can double-click.

The compiled reader needs no server, no sibling files and no network: search the
whole folder, read a document with syntax highlighting and Mermaid diagrams,
follow the link graph between documents, and navigate long documents through
their chapter outline.

## Features

### The executable

- **Icon in the file explorer.** On Windows, `wikicc.exe` carries the project
  logo as a PE resource, in every size the file explorer asks for. The other
  platforms are unaffected.

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
  22.12 is the floor of the diagram engine. Node is only needed to install the
  bundler: `build.rs` runs the native esbuild executable of the
  `@esbuild/<os>-<cpu>` package directly.

```sh
npm ci                     # once, and again whenever package-lock.json changes
cargo build --release      # build.rs bundles the reader into the binary
cargo install --path .     # optional: put `wikicc` on PATH
```

The compiled binary and the generated HTML have no external dependencies.

#### Prebuilt binaries

The [releases page](../../releases) carries the binaries CI builds for each
tagged version, one archive per platform:

| Platform | Archive | Binary inside |
| --- | --- | --- |
| Linux x86-64 | `wikicc-linux-release-v<version>-<sha>.tar.gz` | `wikicc` |
| Windows x86-64 | `wikicc-windows-release-v<version>-<sha>.zip` | `wikicc.exe` |

Unpack it anywhere and put the binary on `PATH`; nothing else has to be
installed. The Linux binary is statically linked against musl, so it runs on
any distribution without a matching glibc, and the Windows executable links the
C runtime statically, so it does not need the VC++ redistributable.

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

- [`CHANGELOG.md`](CHANGELOG.md) — what changed in each release.
- [`docs/design.md`](docs/design.md) — how `wikicc` is built.
- [`tests/README.md`](tests/README.md) — how the test suite is organised.

### The Windows icon

`docs/logo.svg` is the design source of the executable icon;
`docs/logo.ico` is a derived asset, rendered from it and committed, so that
the build needs no image toolchain. **After changing the design source, the
icon has to be rendered again:**

1. Render `docs/logo.svg` to square PNGs named `logo-<size>.png`, with
   `<size>` in 16, 24, 32, 48, 64, 128 and 256. Any renderer will do; the
   sizes have to match exactly.
2. Pack them into the icon:

   ```sh
   node tools/make-icon.mjs <png-dir> docs/logo.ico
   ```

3. Rebuild. `tools/make-icon.mjs` refuses a PNG whose size does not match its
   name, so an incomplete set is caught before the icon is written.

## License

GPL-3.0-only. See [LICENSE](LICENSE) for the full text.
