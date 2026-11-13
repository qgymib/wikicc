//! `pages` writer: a shell page, one JSON chunk per document, a search
//! corpus file and the content-addressed `assets/` folder.
//!
//! This is the `pages` writer described in `docs/design.md`. The artifact
//! is a static site for an HTTP host (GitHub Pages and any other static
//! server): the shell `index.html` carries the reader and the document
//! manifest, and every document's content travels in its own chunk file that
//! the reader fetches only when the reader navigates to it:
//!
//! ```text
//! dist/
//! ├── index.html            ← shell: styles, script bundle, manifest
//! ├── search.json           ← the search corpus, fetched on first global search
//! ├── pages/
//! │   ├── a.md.json         ← one chunk per document
//! │   └── guide/
//! │       └── intro.md.json
//! └── assets/
//!     └── 1f0c…e9.svg
//! ```
//!
//! Chunk file names derive from the document id alone (percent-encoded
//! segment by segment, exactly as the reader's router encodes ids), so a name
//! never changes across builds and a cached shell never points at a file a
//! redeploy removed; freshness travels in the manifest's per-document content
//! hash instead. The names are safe on Windows, in URLs and on static hosts.
//!
//! Ordering is deliberate and preserves the "fail before writing" guarantee
//! the other writers keep: every chunk's and the shell's placeholders are
//! expanded first (an unknown hash fails before a single file exists), then
//! the assets are written, then the chunks, then `search.json`, and
//! `index.html` last. The page therefore never references a file that is not
//! on disk yet, and `index.html` appearing means the build finished writing
//! resources. `AssetTable` iterates in hash order and chunks follow scan
//! order, so two builds of the same input produce byte-identical directories.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::options::OutputFormat;
use crate::render::{PAGES_DIR_NAME, RenderedOutput, SEARCH_FILE_NAME};
use crate::site::SiteBuild;

use super::{
    ASSETS_DIR_NAME, HTML_FILE_NAME, SiteWriter, WriteReport, asset_file_name, asset_relative_path,
    expand_placeholders, io_error,
};

/// Writer for [`OutputFormat::Pages`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PagesWriter;

impl SiteWriter for PagesWriter {
    fn format(&self) -> OutputFormat {
        OutputFormat::Pages
    }

    fn write(
        &self,
        build: &SiteBuild,
        rendered: &RenderedOutput,
        out: &Path,
    ) -> Result<WriteReport> {
        let pages = match rendered {
            RenderedOutput::Pages(pages) => pages,
            _ => {
                return Err(Error::Render(
                    "the pages writer received a shell render".to_string(),
                ));
            }
        };

        // Expanding every chunk first keeps the "fail before writing"
        // guarantee: a chunk that references an unregistered resource produces
        // no directory at all.
        let mut expanded = Vec::with_capacity(pages.chunks.len());
        for chunk in &pages.chunks {
            let (json, _) = expand_placeholders(&chunk.json, &build.assets, |asset, sink| {
                sink.push_str(&asset_relative_path(asset));
                Ok(())
            })?;
            expanded.push((chunk.name.as_str(), json));
        }

        // The shell carries the favicon placeholder in its head, so it is
        // expanded like the chunks — still before anything is written.
        let (shell_html, _) =
            expand_placeholders(&pages.shell.html, &build.assets, |asset, sink| {
                sink.push_str(&asset_relative_path(asset));
                Ok(())
            })?;

        let mut files = 0;
        let mut bytes = 0u64;

        if !build.assets.is_empty() {
            let assets_dir = out.join(ASSETS_DIR_NAME);
            std::fs::create_dir_all(&assets_dir)
                .map_err(|error| io_error("create the asset directory", &assets_dir, error))?;

            // Hash order, so the write order is independent of discovery order.
            for (_, asset) in build.assets.iter() {
                let path = assets_dir.join(asset_file_name(asset));
                std::fs::write(&path, &asset.bytes)
                    .map_err(|error| io_error("write the asset", &path, error))?;
                files += 1;
                bytes += asset.len() as u64;
            }
        }

        if !expanded.is_empty() {
            let pages_dir = out.join(PAGES_DIR_NAME);
            std::fs::create_dir_all(&pages_dir)
                .map_err(|error| io_error("create the chunk directory", &pages_dir, error))?;

            // Scan order, so the write order is independent of discovery order.
            // Nested ids create nested directories, which `create_dir_all`
            // covers per chunk.
            for (name, json) in &expanded {
                let path = chunk_path(out, name);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| io_error("create the chunk directory", parent, error))?;
                }
                std::fs::write(&path, json.as_bytes())
                    .map_err(|error| io_error("write the chunk", &path, error))?;
                files += 1;
                bytes += json.len() as u64;
            }
        }

        // The corpus is written even for an empty site, so the layout of the
        // artifact never depends on the content it carries.
        let search_path = out.join(SEARCH_FILE_NAME);
        std::fs::write(&search_path, pages.search_json.as_bytes())
            .map_err(|error| io_error("write the search corpus", &search_path, error))?;
        files += 1;
        bytes += pages.search_json.len() as u64;

        let page = out.join(HTML_FILE_NAME);
        std::fs::write(&page, shell_html.as_bytes())
            .map_err(|error| io_error("write the page", &page, error))?;
        files += 1;
        bytes += shell_html.len() as u64;

        Ok(WriteReport {
            files,
            bytes,
            // One file per unique resource: content-addressed names collapse
            // duplicates before the writer ever sees them.
            assets: build.assets.len(),
        })
    }
}

/// On-disk path of a chunk `name` (a `/`-separated URL path) inside `out`.
///
/// The name is split on the literal separator instead of being passed to
/// `Path::join` as one string, so the path is built from real components and
/// never depends on how the host filesystem treats `/` inside a segment.
fn chunk_path(out: &Path, name: &str) -> PathBuf {
    let mut path = out.to_path_buf();
    for part in name.split('/') {
        path.push(part);
    }
    path
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::assets::AssetTable;
    use crate::render::{RenderedPages, RenderedSite, chunk_file_name};
    use crate::site::{SiteBundle, Stats};

    /// Names of the entries directly inside `dir`, sorted.
    fn entry_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("read the output directory")
            .map(|entry| {
                entry
                    .expect("read a directory entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();

        names
    }

    /// Build whose assets are the given `(file name, content)` pairs.
    fn build_with(assets: &[(&str, &[u8])]) -> (SiteBuild, Vec<String>) {
        let mut table = AssetTable::new();
        let mut hashes = Vec::new();

        for (name, content) in assets {
            hashes.push(table.insert_bytes(Path::new(name), content.to_vec()));
        }

        let build = SiteBuild {
            bundle: SiteBundle {
                title: "Site".to_string(),
                home: None,
                docs: Vec::new(),
                edges: Vec::new(),
                stats: Stats::default(),
            },
            front_matters: Vec::new(),
            assets: table,
            diagnostics: Vec::new(),
        };

        (build, hashes)
    }

    /// A rendered pages output with `chunk_count` empty chunks and a corpus.
    fn pages_with(chunk_count: usize) -> RenderedPages {
        let chunks = (0..chunk_count)
            .map(|index| crate::render::ChunkArtifact {
                name: chunk_file_name(&format!("doc{index}.md")),
                hash: "0000000000000000".to_string(),
                json: format!(r#"{{"id":"doc{index}.md"}}"#),
            })
            .collect();

        RenderedPages {
            shell: RenderedSite {
                html: "<html></html>".to_string(),
            },
            chunks,
            search_json: r#"{"docs":[]}"#.to_string(),
        }
    }

    #[test]
    fn the_writer_declares_its_format() {
        assert_eq!(PagesWriter.format(), OutputFormat::Pages);
    }

    #[test]
    fn a_shell_render_is_refused_instead_of_written() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);
        let rendered = RenderedOutput::Page(RenderedSite {
            html: "<html></html>".to_string(),
        });

        let error = PagesWriter
            .write(&build, &rendered, dir.path())
            .expect_err("mismatched render");

        assert!(
            error.to_string().contains("shell render"),
            "unexpected message: {error}"
        );
        assert!(
            !dir.path().join(HTML_FILE_NAME).exists(),
            "a mismatched render must not leave an artifact"
        );
    }

    #[test]
    fn the_layout_is_shell_chunks_corpus_and_assets() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let rendered = RenderedOutput::Pages(pages_with(2));

        let report = PagesWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        // The shell, the corpus, two chunks and one asset.
        assert_eq!(report.files, 5);
        assert_eq!(report.assets, 1);
        assert_eq!(
            entry_names(dir.path()),
            ["assets", "index.html", "pages", "search.json"]
        );
        assert_eq!(
            entry_names(&dir.path().join("pages")),
            ["doc0.md.json", "doc1.md.json"]
        );
        assert_eq!(
            fs::read(dir.path().join("pages").join("doc0.md.json")).expect("chunk"),
            br#"{"id":"doc0.md"}"#
        );
        assert_eq!(
            fs::read(dir.path().join("search.json")).expect("corpus"),
            br#"{"docs":[]}"#
        );
        assert_eq!(
            fs::read(
                dir.path()
                    .join(ASSETS_DIR_NAME)
                    .join(format!("{}.svg", hashes[0]))
            )
            .expect("asset"),
            b"<svg/>"
        );
        assert_eq!(
            report.bytes,
            13 + 11 + 16 + 16 + 6,
            "the report counts the bytes it wrote, not the bytes it received"
        );
    }

    #[test]
    fn nested_ids_create_nested_chunk_directories() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);
        let mut pages = pages_with(0);
        pages.chunks.push(crate::render::ChunkArtifact {
            name: chunk_file_name("guide/intro.md"),
            hash: "0000000000000000".to_string(),
            json: r#"{"id":"guide/intro.md"}"#.to_string(),
        });
        let rendered = RenderedOutput::Pages(pages);

        PagesWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        assert_eq!(
            entry_names(&dir.path().join("pages")),
            ["guide"],
            "the chunk directory holds one entry per top-level id segment"
        );
        assert_eq!(
            entry_names(&dir.path().join("pages").join("guide")),
            ["intro.md.json"]
        );
    }

    #[test]
    fn an_empty_site_writes_shell_and_corpus_but_no_pages_nor_assets() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);
        let rendered = RenderedOutput::Pages(pages_with(0));

        let report = PagesWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        assert_eq!(report.files, 2);
        assert_eq!(
            entry_names(dir.path()),
            ["index.html", "search.json"],
            "an empty chunk or asset directory would only look like a broken build"
        );
    }

    #[test]
    fn placeholders_become_relative_asset_addresses_in_chunks() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let mut pages = pages_with(0);
        pages.chunks.push(crate::render::ChunkArtifact {
            name: chunk_file_name("a.md"),
            hash: "0000000000000000".to_string(),
            json: format!(r#"{{"html":"<img src=\"wikicc-asset:{0}\">"}}"#, hashes[0]),
        });
        let rendered = RenderedOutput::Pages(pages);

        PagesWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        let chunk = fs::read_to_string(dir.path().join("pages").join("a.md.json")).expect("chunk");
        assert_eq!(
            chunk,
            format!(r#"{{"html":"<img src=\"assets/{}.svg\">"}}"#, hashes[0])
        );
        assert!(!chunk.contains("wikicc-asset:"));
    }

    #[test]
    fn the_shell_placeholders_become_relative_asset_addresses() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let mut pages = pages_with(0);
        pages.shell = RenderedSite {
            html: format!(r#"<link rel="icon" href="wikicc-asset:{}">"#, hashes[0]),
        };
        let rendered = RenderedOutput::Pages(pages);

        PagesWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        let shell = fs::read_to_string(dir.path().join(HTML_FILE_NAME)).expect("shell");
        assert_eq!(
            shell,
            format!(r#"<link rel="icon" href="assets/{}.svg">"#, hashes[0]),
            "the favicon link addresses the asset the writer put next to the page"
        );
        assert!(!shell.contains("wikicc-asset:"));
    }

    #[test]
    fn an_unknown_placeholder_in_the_shell_fails_before_anything_is_written() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);
        let mut pages = pages_with(0);
        pages.shell = RenderedSite {
            html: r#"<link rel="icon" href="wikicc-asset:0000000000000000">"#.to_string(),
        };
        let rendered = RenderedOutput::Pages(pages);

        let error = PagesWriter
            .write(&build, &rendered, dir.path())
            .expect_err("unknown placeholder in the shell");

        assert!(
            error.to_string().contains("unknown asset placeholder"),
            "unexpected message: {error}"
        );
        assert_eq!(
            entry_names(dir.path()),
            Vec::<String>::new(),
            "a failed expansion must not leave a partial artifact"
        );
    }

    #[test]
    fn an_unknown_placeholder_fails_before_anything_is_written() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);
        let mut pages = pages_with(0);
        pages.chunks.push(crate::render::ChunkArtifact {
            name: chunk_file_name("a.md"),
            hash: "0000000000000000".to_string(),
            json: r#"{"html":"<img src=\"wikicc-asset:0000000000000000\">"}"#.to_string(),
        });
        let rendered = RenderedOutput::Pages(pages);

        let error = PagesWriter
            .write(&build, &rendered, dir.path())
            .expect_err("unknown placeholder");

        assert!(
            error.to_string().contains("unknown asset placeholder"),
            "unexpected message: {error}"
        );
        assert_eq!(
            entry_names(dir.path()),
            Vec::<String>::new(),
            "a failed expansion must not leave a partial artifact"
        );
    }

    #[test]
    fn the_shell_page_is_written_last() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);

        // A reader that arrives while the writer runs must never see a page
        // whose sibling files are not on disk yet, which is why the page is
        // the last file the writer touches. The mtimes pin that order down.
        let rendered = RenderedOutput::Pages(pages_with(1));
        PagesWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        let page = fs::metadata(dir.path().join(HTML_FILE_NAME))
            .expect("the page exists")
            .modified()
            .expect("page mtime");
        let corpus = fs::metadata(dir.path().join(SEARCH_FILE_NAME))
            .expect("the corpus exists")
            .modified()
            .expect("corpus mtime");
        let chunk = fs::metadata(dir.path().join("pages").join("doc0.md.json"))
            .expect("the chunk exists")
            .modified()
            .expect("chunk mtime");

        assert!(
            page >= corpus && page >= chunk,
            "the page must not predate the files it references"
        );
    }

    #[test]
    fn every_written_file_is_utf8_without_a_bom() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);
        let mut pages = pages_with(0);
        pages.chunks.push(crate::render::ChunkArtifact {
            name: chunk_file_name("中文.md"),
            hash: "0000000000000000".to_string(),
            json: r#"{"text":"说明"}"#.to_string(),
        });
        pages.search_json = r#"{"docs":[{"text":"说明"}]}"#.to_string();
        pages.shell = RenderedSite {
            html: "<p>说明</p>".to_string(),
        };
        let rendered = RenderedOutput::Pages(pages);

        PagesWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        for path in [
            dir.path().join(HTML_FILE_NAME),
            dir.path().join(SEARCH_FILE_NAME),
            dir.path().join("pages").join("%E4%B8%AD%E6%96%87.md.json"),
        ] {
            let bytes = fs::read(&path).expect("read the file");
            assert_ne!(
                bytes.get(..3),
                Some(&b"\xEF\xBB\xBF"[..]),
                "{} carries a BOM",
                path.display()
            );
            let text = String::from_utf8(bytes).expect("valid utf-8");
            assert!(
                text.contains('说'),
                "{} keeps the text verbatim",
                path.display()
            );
        }
    }

    #[test]
    fn chunk_paths_are_built_from_url_segments() {
        let path = chunk_path(Path::new("out"), "pages/guide/intro.md.json");

        assert_eq!(
            path,
            Path::new("out")
                .join("pages")
                .join("guide")
                .join("intro.md.json")
        );
    }
}
