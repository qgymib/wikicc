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
- **Chapter folding**: an arrow beside a heading folds that chapter — and
  everything nested under it — down to its title, and unfolds it again. The
  arrows appear when the pointer is on a heading and stay out of the way
  otherwise; folding is never remembered, so every document opens whole.
  Following a link or an outline entry into a folded chapter reopens it.
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
- Images and other local assets: `![alt](path/to/image.png)` is embedded
  content-addressed, and a destination containing spaces is accepted too.
- Fenced code highlighting, done at build time.
- Mermaid diagrams from a fence tagged `mermaid`.
- Raw HTML inside Markdown, passed through unchanged. **The input is trusted:
  there is no sanitizer, so do not compile untrusted documents.**

### Output formats

| Format | Artifact | Assets |
| --- | --- | --- |
| `single-html` (default; one self-contained file) | one `index.html` | inlined into the page |
| `html-dir` (page plus an assets folder) | `index.html` + `assets/` | one file per unique resource |
| `pages` (static site for GitHub Pages) | `index.html` + `pages/` + `search.json` + `assets/` | one file per unique resource |

All three carry the same reader. Assets are content-addressed, so identical
bytes are stored once no matter how many documents reference them.

- **`single-html`** opens by double click, offline, from any directory, with no
  sibling files.
- **`html-dir`** is smallest and can be copied, zipped or served statically as it
  is.
- **`pages`** is a static site for an HTTP host such as GitHub Pages: the
  page carries the reader and a document manifest only, and each document's
  content is one JSON file under `pages/` that the reader fetches when it
  navigates there. The search corpus is a separate `search.json`, fetched the
  first time the reader searches the whole site. Nothing but the shell and the
  manifest is downloaded up front, so first paint does not grow with the size
  of the folder. This format needs to be served over HTTP(S) — a browser
  refuses the fetches from a `file://` page, and the reader says so when it
  finds itself there.

#### Publishing to GitHub Pages

`pages` output deploys as it is: hash routes need no server
configuration, the file names are stable across builds (a cached page never
points at a file a redeploy removed), and each fetch carries the content hash
of the chunk it wants, so a browser that still holds a cached page refreshes
its documents after a redeploy. The artifact works at the root of a domain and
under a subpath alike:

```sh
wikicc path/to/docs --format pages -o site
git -C path/to/docs add site && git -C path/to/docs commit -m "Publish"
git -C path/to/docs subtree push --prefix site origin gh-pages
```

### Offline and reproducibility

- The shell formats fetch nothing at runtime: no CDN, no web font, no remote
  stylesheet. `pages` fetches only the files the build wrote next to the
  page — never a third-party origin.
- The build itself never touches the network; the only network step is the
  one-time `npm ci` that installs the pinned front-end dependencies.
- Two builds of the same input produce byte-identical artifacts, in every
  format.

## Usage

### Prerequisites and install

- **Rust 1.85 or newer** (the crate uses edition 2024).
- **Node.js 22.12 or newer** and npm — the reader is bundled at build time, and
  22.12 is the floor of the diagram engine. Node is needed for the build and
  the quality tooling: `build.rs` runs the native esbuild executable of the
  `@esbuild/<os>-<cpu>` package directly, and the formatter and linter of the
  front-end sources are installed into the same `node_modules`.

```sh
npm ci                     # once, and again whenever package-lock.json changes
cargo build --release      # build.rs bundles the reader into the binary
cargo install --path .     # optional: put `wikicc` on PATH
```

The compiled binary and the generated HTML have no external dependencies.

#### Prebuilt binaries

The [releases page](../../releases) carries the binaries CI builds for each
tagged version, one archive per build system and architecture:

| Build system | Architecture | Archive | Binary inside |
| --- | --- | --- | --- |
| Ubuntu | amd64 | `wikicc-ubuntu-amd64-v<version>-<sha>.tar.gz` | `wikicc` |
| Windows | amd64 | `wikicc-windows-amd64-v<version>-<sha>.zip` | `wikicc.exe` |

The archive name states the system it was built on rather than the kernel it
runs on, so the same archive also tells you which CI image produced it. Unpack
it anywhere and put the binary on `PATH`; nothing else has to be installed. The
Ubuntu binary is statically linked against musl, so it runs on any distribution
without a matching glibc, and the Windows executable links the C runtime
statically, so it does not need the VC++ redistributable.

### Command line

```
wikicc [OPTIONS] [INPUT_DIR]

  -o, --out <DIR>        Output directory [default: <INPUT_DIR>/dist]
      --format <FMT>     single-html | html-dir | pages [default: single-html]
      --title <TITLE>    Site title [default: input folder name]
      --strict[=<BOOL>]  Treat warnings as errors; --strict=false turns the gate off
      --home <DOC>       Document the reader opens first; overrides .wikicc.json
      --exclude <DIR>    Directory to keep out of the site; repeatable, overrides .wikicc.json
      --force            Overwrite the output directory without confirmation
  -q, --quiet            Suppress the summary line
      --init-config [DIR]
                         Write a default .wikicc.json into DIR [default: the
                         current directory] and exit
  -h, --help             Print help
  -V, --version          Print version
```

```sh
wikicc path/to/docs                       # writes path/to/docs/dist/index.html
wikicc path/to/docs -o build --title "Handbook"
wikicc path/to/docs --format html-dir
wikicc path/to/docs --format pages        # a static site for GitHub Pages
wikicc path/to/docs --strict              # broken links fail the build
wikicc path/to/docs --home guide/intro.md # override the configured opening document
wikicc path/to/docs --exclude drafts      # override the configured exclusions
wikicc --init-config path/to/docs         # writes path/to/docs/.wikicc.json
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

### Configuration file

A site can carry an optional `.wikicc.json` in the **input folder root**. The
file is JSON and knows six keys — the same settings the command line takes,
so each of them can also be overridden by a flag:

| Key | Meaning |
| --- | --- |
| `home` | Document the reader opens at an empty or unknown address [default: the first document] |
| `exclude` | Directories whose entire subtrees stay out of the site [default: none] |
| `out` | Output directory [default: `<INPUT_DIR>/dist`] |
| `format` | `single-html`, `html-dir` or `pages` [default: `single-html`] |
| `title` | Site title [default: the input folder name] |
| `strict` | Fail the build on warnings [default: `false`] |

`home` is a document id — the path relative to the input folder, `/`
separated, extension included — and a missing `.md` (or `.markdown`) suffix is
completed, so `"home": "intro"` addresses `intro.md`. Explicit links are never
redirected: the setting only decides what the opening page shows, and the
sidebar, graph and search see the same document they always did.

`exclude` lists directories relative to the input folder; each pruned
directory takes its documents and subfolders with it, so drafts and private
notes never reach the payload, the search index or the link graph. Entries
are normalized like `home` values — trimmed, `\` read as `/`, a leading `./`
and a trailing `/` dropped — and match exactly: `"drafts"` prunes the input
folder's own `drafts` directory, not `guide/drafts`. The build reports how
many directories were pruned as a note line.

`out` is resolved against the **input folder** — the directory the
configuration file sits in — so a relative value builds to the same place no
matter which working directory the build was started from. A command line
`--out` keeps its own convention: relative to the working directory.

```json
{
  "home": "guide/getting-started.md",
  "exclude": ["drafts", "archive/old"],
  "out": "site",
  "format": "pages",
  "title": "Handbook",
  "strict": false
}
```

**Every value the file names is a default; an explicit flag wins.**

- `--home` replaces the configured `home`.
- `--exclude` **replaces** the configured list entirely; repeat the flag for
  several directories.
- `--out`, `--format` and `--title` override their configured counterparts.
- A bare `--strict` turns the gate on and `--strict=false` turns it off,
  whatever the file says.
- `--force` and `--quiet` exist only on the command line; the file never
  asks for a destructive overwrite or a silent build.

- A `home` that matches no document is a warning — the build still succeeds
  and the reader falls back to the first document; `--strict` turns it into a
  failure.
- An `exclude` entry that escapes the input folder (`..`) or cannot match any
  directory (empty) fails the build for the same reason a broken `home` would,
  whatever the source it came from.
- An unreadable or invalid file fails the build: a broken instruction must
  not be silently ignored.
- Unknown keys warn, so a typo never silently changes nothing.
- Every output format honours the settings, and a site without a
  `.wikicc.json` builds exactly the artifact it always did.

A starter file can be written with `wikicc --init-config [DIR]` (the current
directory when the value is omitted). It writes the default content — every
key unset:

```json
{
  "home": null,
  "exclude": null,
  "out": null,
  "format": null,
  "title": null,
  "strict": null
}
```

- The target directory must already exist; a missing directory is rejected,
  not created.
- An existing `.wikicc.json` is never overwritten — delete it first.
- `--init-config` cannot be combined with an input directory.

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
- [`docs/search.md`](docs/search.md) — how the reader's search works, and the
  query syntax it understands.
- [`docs/design.md`](docs/design.md) — how `wikicc` is built.
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — the development rules: the
  quality gates every commit has to pass, and the steps that regenerate the
  Windows icon.
- [`tests/README.md`](tests/README.md) — how the test suite is organised.

## Development

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md).

## License

GPL-3.0-only. See [LICENSE](LICENSE) for the full text.
