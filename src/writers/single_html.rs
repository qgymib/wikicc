//! `single-html` writer: one file with every resource inlined as a data URI.
//!
//! This is the `single-html` writer described in `docs/DESIGN.md`. The rendered page already contains the
//! whole reader (markup, styles, script and payload); the only thing left to do
//! is to turn every `wikicc-asset:<hash>` placeholder into
//! `data:<mime>;base64,<payload>`, which is what makes the artifact survive a
//! double click from any directory, offline and with no sibling files.
//!
//! Peak memory is bounded deliberately: the expansion is one pass over the page
//! (see [`super::expand_placeholders`]) and the base64 payload is written into a
//! single scratch buffer that is reused for every occurrence. A document that
//! references the same image from five places therefore encodes it five times
//! instead of keeping five copies of the data URI alive — CPU traded for memory,
//! which is the right trade for media files that can be tens of megabytes. The
//! output page is the dominant allocation either way.

use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use crate::assets::Asset;
use crate::error::{Error, Result};
use crate::options::OutputFormat;
use crate::render::RenderedSite;
use crate::site::SiteBuild;

use super::{HTML_FILE_NAME, SiteWriter, WriteReport, expand_placeholders};

/// Writer for [`OutputFormat::SingleHtml`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SingleHtmlWriter;

impl SiteWriter for SingleHtmlWriter {
    fn format(&self) -> OutputFormat {
        OutputFormat::SingleHtml
    }

    fn write(&self, build: &SiteBuild, rendered: &RenderedSite, out: &Path) -> Result<WriteReport> {
        let mut scratch: Vec<u8> = Vec::new();
        let (html, _) = expand_placeholders(&rendered.html, &build.assets, |asset, sink| {
            write_data_uri(asset, sink, &mut scratch)
        })?;

        let path = out.join(HTML_FILE_NAME);
        // `as_bytes()` writes the page as UTF-8 without a BOM, which is the
        // encoding the document declares in its `<meta charset="utf-8">`.
        std::fs::write(&path, html.as_bytes())
            .map_err(|error| Error::Write(format!("{}: {error}", path.display())))?;

        Ok(WriteReport {
            files: 1,
            bytes: html.len() as u64,
            // A registered asset is always referenced by at least one document,
            // so the table size is the number of distinct resources inlined.
            assets: build.assets.len(),
        })
    }
}

/// `data:<mime>;base64,<payload>` for `asset`.
///
/// Convenience wrapper around [`write_data_uri`] for callers (and tests) that
/// want the URI as a value instead of appending it to a buffer.
pub fn data_uri(asset: &Asset) -> Result<String> {
    let mut uri = String::new();
    let mut scratch: Vec<u8> = Vec::new();
    write_data_uri(asset, &mut uri, &mut scratch)?;

    Ok(uri)
}

/// Append the data URI of `asset` to `out`, reusing `scratch` for the encoding.
///
/// The buffer is sized with [`base64::encoded_len`] and filled with
/// [`base64::Engine::encode_slice`], so no intermediate `String` is allocated
/// per asset. The prefix is pushed only after a successful encode, so a failure
/// never leaves a half-written URI in the destination.
pub fn write_data_uri(asset: &Asset, out: &mut String, scratch: &mut Vec<u8>) -> Result<()> {
    let encoded_len = base64::encoded_len(asset.bytes.len(), true).ok_or_else(|| {
        Error::Write(format!(
            "asset '{}' is too large to inline as a data URI",
            asset.hash
        ))
    })?;

    scratch.resize(encoded_len, 0);
    let written = STANDARD
        .encode_slice(&asset.bytes, scratch.as_mut_slice())
        .map_err(|error| {
            Error::Write(format!(
                "asset '{}' cannot be base64 encoded: {error}",
                asset.hash
            ))
        })?;

    out.push_str("data:");
    out.push_str(&asset.mime);
    out.push_str(";base64,");
    // Base64 is ASCII, so the encoded slice is always valid UTF-8.
    out.push_str(std::str::from_utf8(&scratch[..written]).expect("base64 output is ASCII"));

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::assets::AssetTable;
    use crate::site::{SiteBundle, Stats};

    /// Asset with the given MIME type and content.
    fn asset(mime: &str, bytes: &[u8]) -> Asset {
        Asset {
            hash: "0000000000000000".to_string(),
            mime: mime.to_string(),
            extension: "bin".to_string(),
            bytes: bytes.to_vec(),
        }
    }

    /// Build whose only asset is `content` read from `name`.
    fn build_with(name: &str, content: &[u8]) -> (SiteBuild, String) {
        let mut assets = AssetTable::new();
        let hash = assets.insert_bytes(Path::new(name), content.to_vec());

        let build = SiteBuild {
            bundle: SiteBundle {
                title: "Site".to_string(),
                docs: Vec::new(),
                edges: Vec::new(),
                stats: Stats::default(),
            },
            assets,
            diagnostics: Vec::new(),
        };

        (build, hash)
    }

    #[test]
    fn a_data_uri_carries_the_mime_type_and_the_payload() {
        let uri = data_uri(&asset("text/plain", b"hello")).expect("data uri");

        // base64("hello") = aGVsbG8=
        assert_eq!(uri, "data:text/plain;base64,aGVsbG8=");
    }

    #[test]
    fn the_payload_matches_a_known_vector() {
        let uri = data_uri(&asset("image/svg+xml", b"<svg/>")).expect("data uri");

        // base64("<svg/>") = PHN2Zy8+
        assert_eq!(uri, "data:image/svg+xml;base64,PHN2Zy8+");
    }

    #[test]
    fn padding_is_standard_base64() {
        assert_eq!(
            data_uri(&asset("text/plain", b"a")).expect("data uri"),
            "data:text/plain;base64,YQ=="
        );
        assert_eq!(
            data_uri(&asset("text/plain", b"ab")).expect("data uri"),
            "data:text/plain;base64,YWI="
        );
        assert_eq!(
            data_uri(&asset("text/plain", b"abc")).expect("data uri"),
            "data:text/plain;base64,YWJj"
        );
    }

    #[test]
    fn an_empty_asset_still_produces_a_valid_data_uri() {
        assert_eq!(
            data_uri(&asset("application/octet-stream", b"")).expect("data uri"),
            "data:application/octet-stream;base64,"
        );
    }

    #[test]
    fn a_binary_payload_survives_encoding() {
        let bytes: Vec<u8> = (0..=255u8).collect();
        let uri = data_uri(&asset("application/octet-stream", &bytes)).expect("data uri");
        let payload = uri
            .strip_prefix("data:application/octet-stream;base64,")
            .expect("prefix");
        let decoded = STANDARD.decode(payload).expect("valid base64");

        assert_eq!(decoded, bytes);
    }

    #[test]
    fn the_scratch_buffer_is_reused_across_assets() {
        let mut scratch = vec![0xFF; 128];
        let mut out = String::new();

        write_data_uri(&asset("text/plain", b"hello"), &mut out, &mut scratch).expect("first");
        write_data_uri(&asset("text/plain", b"a"), &mut out, &mut scratch).expect("second");

        assert_eq!(
            out,
            "data:text/plain;base64,aGVsbG8=data:text/plain;base64,YQ=="
        );
        assert_eq!(scratch.len(), 4, "the buffer shrinks to the smaller asset");
    }

    #[test]
    fn the_writer_inlines_every_placeholder_into_one_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hash) = build_with("logo.svg", b"<svg/>");
        let rendered = RenderedSite {
            html: format!(
                "<html><body><img src=\"wikicc-asset:{hash}\"><img src=\"wikicc-asset:{hash}\"></body></html>"
            ),
        };

        let report = SingleHtmlWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        let html = fs::read_to_string(dir.path().join(HTML_FILE_NAME)).expect("index.html");
        assert_eq!(
            html,
            "<html><body><img src=\"data:image/svg+xml;base64,PHN2Zy8+\">\
             <img src=\"data:image/svg+xml;base64,PHN2Zy8+\"></body></html>"
        );
        assert!(!html.contains("wikicc-asset:"));
        assert_eq!(report.files, 1);
        assert_eq!(report.bytes, html.len() as u64);
        assert_eq!(report.assets, 1);
    }

    #[test]
    fn a_page_without_assets_is_written_verbatim() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with("logo.svg", b"<svg/>");
        let rendered = RenderedSite {
            html: "<html></html>".to_string(),
        };

        let report = SingleHtmlWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        assert_eq!(
            fs::read_to_string(dir.path().join(HTML_FILE_NAME)).expect("index.html"),
            "<html></html>"
        );
        assert_eq!(report.bytes, 13);
    }

    #[test]
    fn an_unknown_placeholder_fails_before_anything_is_written() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with("logo.svg", b"<svg/>");
        let rendered = RenderedSite {
            html: "<img src=\"wikicc-asset:0000000000000000\">".to_string(),
        };

        let error = SingleHtmlWriter
            .write(&build, &rendered, dir.path())
            .expect_err("unknown placeholder");

        assert!(
            error.to_string().contains("unknown asset placeholder"),
            "unexpected message: {error}"
        );
        assert!(
            !dir.path().join(HTML_FILE_NAME).exists(),
            "a failed expansion must not leave a partial artifact"
        );
    }

    #[test]
    fn the_written_file_is_utf8_without_a_bom() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with("logo.svg", b"<svg/>");
        let rendered = RenderedSite {
            html: "<p>说明</p>".to_string(),
        };

        SingleHtmlWriter
            .write(&build, &rendered, dir.path())
            .expect("write");

        let bytes = fs::read(dir.path().join(HTML_FILE_NAME)).expect("index.html");
        assert_eq!(bytes, "<p>说明</p>".as_bytes());
        assert_ne!(bytes.get(..3), Some(&b"\xEF\xBB\xBF"[..]));
    }

    #[test]
    fn the_writer_declares_its_format() {
        assert_eq!(SingleHtmlWriter.format(), OutputFormat::SingleHtml);
    }
}
