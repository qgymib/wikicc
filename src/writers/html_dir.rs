//! `html-dir` writer: `index.html` plus an `assets/` folder.
//!
//! This is the `html-dir` writer described in `docs/DESIGN.md`. The page is the same rendered reader as
//! the single-file format; the only difference is addressing. Every
//! `wikicc-asset:<hash>` placeholder becomes `assets/<hash>.<ext>`, a path that
//! is relative to `index.html`, and the bytes land in a sibling directory:
//!
//! ```text
//! dist/
//! ├── index.html
//! └── assets/
//!     ├── 1f0c…e9.svg
//!     └── 7ab3…42.png
//! ```
//!
//! The reader keeps its hash routes, so the base URL never changes while the
//! user navigates; relative addresses therefore resolve from the directory the
//! page was opened from and the whole folder can be copied, zipped or served
//! statically without rewriting anything.
//!
//! Ordering is deliberate: the placeholders are expanded first (an unknown hash
//! fails before a single file exists), the assets are written next, and
//! `index.html` is written last. The page therefore never references a file
//! that is not on disk yet, and `index.html` appearing means the build finished
//! writing resources. `AssetTable` iterates in hash order, so two builds of the
//! same input produce byte-identical directories.

use std::path::Path;

use crate::error::Result;
use crate::options::OutputFormat;
use crate::render::RenderedSite;
use crate::site::SiteBuild;

use super::{
    ASSETS_DIR_NAME, HTML_FILE_NAME, SiteWriter, WriteReport, asset_file_name, asset_relative_path,
    expand_placeholders, io_error,
};

/// Writer for [`OutputFormat::HtmlDir`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HtmlDirWriter;

impl SiteWriter for HtmlDirWriter {
    fn format(&self) -> OutputFormat {
        OutputFormat::HtmlDir
    }

    fn write(&self, build: &SiteBuild, rendered: &RenderedSite, out: &Path) -> Result<WriteReport> {
        // Expanding first keeps the "fail before writing" guarantee: a page
        // that references an unregistered resource produces no directory.
        let (html, _) = expand_placeholders(&rendered.html, &build.assets, |asset, sink| {
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

        let page = out.join(HTML_FILE_NAME);
        std::fs::write(&page, html.as_bytes())
            .map_err(|error| io_error("write the page", &page, error))?;

        Ok(WriteReport {
            files: files + 1,
            bytes: bytes + html.len() as u64,
            // One file per unique resource: content-addressed names collapse
            // duplicates before the writer ever sees them.
            assets: build.assets.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::assets::AssetTable;
    use crate::site::{SiteBundle, Stats};

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
                docs: Vec::new(),
                edges: Vec::new(),
                stats: Stats::default(),
            },
            assets: table,
            diagnostics: Vec::new(),
        };

        (build, hashes)
    }

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

    /// Rendered page that references every hash in `hashes` once.
    fn page_with(hashes: &[String]) -> RenderedSite {
        let images: String = hashes
            .iter()
            .map(|hash| format!("<img src=\"wikicc-asset:{hash}\">"))
            .collect();

        RenderedSite {
            html: format!("<html><body>{images}</body></html>"),
        }
    }

    #[test]
    fn the_writer_declares_its_format() {
        assert_eq!(HtmlDirWriter.format(), OutputFormat::HtmlDir);
    }

    #[test]
    fn the_page_and_one_file_per_asset_are_written() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>"), ("pic.png", b"png")]);

        HtmlDirWriter
            .write(&build, &page_with(&hashes), dir.path())
            .expect("write");

        assert_eq!(entry_names(dir.path()), [ASSETS_DIR_NAME, HTML_FILE_NAME]);
        assert_eq!(
            entry_names(&dir.path().join(ASSETS_DIR_NAME)),
            [format!("{}.png", hashes[1]), format!("{}.svg", hashes[0])]
        );
        assert_eq!(
            fs::read(
                dir.path()
                    .join(ASSETS_DIR_NAME)
                    .join(format!("{}.svg", hashes[0]))
            )
            .expect("asset file"),
            b"<svg/>"
        );
    }

    #[test]
    fn identical_content_is_written_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hashes) = build_with(&[("a/logo.svg", b"<svg/>"), ("b/copy.svg", b"<svg/>")]);

        let report = HtmlDirWriter
            .write(&build, &page_with(&hashes), dir.path())
            .expect("write");

        assert_eq!(hashes[0], hashes[1], "same bytes, same hash");
        assert_eq!(
            entry_names(&dir.path().join(ASSETS_DIR_NAME)),
            [format!("{}.svg", hashes[0])]
        );
        assert_eq!(report.assets, 1);
        assert_eq!(report.files, 2, "the page plus the one deduplicated asset");
    }

    #[test]
    fn placeholders_become_relative_asset_addresses() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let rendered = RenderedSite {
            html: format!(
                "<img src=\"wikicc-asset:{hash}\"><img src=\"wikicc-asset:{hash}\">",
                hash = hashes[0]
            ),
        };

        HtmlDirWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        let page = fs::read_to_string(dir.path().join(HTML_FILE_NAME)).expect("index.html");
        let expected = format!("<img src=\"assets/{}.svg\">", hashes[0]);
        assert_eq!(page, format!("{expected}{expected}"));
        assert!(!page.contains("wikicc-asset:"));
    }

    #[test]
    fn a_site_without_assets_writes_only_the_page() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);
        let rendered = RenderedSite {
            html: "<html></html>".to_string(),
        };

        let report = HtmlDirWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        assert_eq!(entry_names(dir.path()), [HTML_FILE_NAME]);
        assert_eq!(report.files, 1);
        assert_eq!(report.assets, 0);
        assert!(
            !dir.path().join(ASSETS_DIR_NAME).exists(),
            "an empty asset directory would only look like a broken build"
        );
    }

    #[test]
    fn the_report_counts_the_page_and_every_asset() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hashes) = build_with(&[("a.svg", b"<svg/>"), ("b.bin", &[0u8, 1, 2, 3])]);

        let report = HtmlDirWriter
            .write(&build, &page_with(&hashes), dir.path())
            .expect("write");

        let page = fs::metadata(dir.path().join(HTML_FILE_NAME))
            .expect("artifact metadata")
            .len();

        assert_eq!(report.files, 3);
        assert_eq!(report.assets, 2);
        assert_eq!(
            report.bytes,
            page + 6 + 4,
            "the report counts the bytes it wrote, not the bytes it received"
        );
    }

    #[test]
    fn asset_bytes_are_written_verbatim() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bytes: Vec<u8> = (0..=255u8).collect();
        let (build, hashes) = build_with(&[("blob.bin", &bytes)]);

        HtmlDirWriter
            .write(&build, &page_with(&hashes), dir.path())
            .expect("write");

        assert_eq!(
            fs::read(
                dir.path()
                    .join(ASSETS_DIR_NAME)
                    .join(format!("{}.bin", hashes[0]))
            )
            .expect("asset file"),
            bytes,
            "html-dir stores the original bytes, not an encoding of them"
        );
    }

    #[test]
    fn an_unknown_placeholder_fails_before_anything_is_written() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[("logo.svg", b"<svg/>")]);
        let rendered = RenderedSite {
            html: "<img src=\"wikicc-asset:0000000000000000\">".to_string(),
        };

        let error = HtmlDirWriter
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
    fn the_page_is_written_as_utf8_without_a_bom() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[]);
        let rendered = RenderedSite {
            html: "<p>说明</p>".to_string(),
        };

        HtmlDirWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        let bytes = fs::read(dir.path().join(HTML_FILE_NAME)).expect("index.html");
        assert_eq!(bytes, "<p>说明</p>".as_bytes());
        assert_ne!(bytes.get(..3), Some(&b"\xEF\xBB\xBF"[..]));
    }
}
