//! `mhtml` writer: one `multipart/related` archive that holds the whole site.
//!
//! This is the `mhtml` writer described in `docs/DESIGN.md`. The page is the same rendered reader as
//! the other two formats; only the addressing differs. Every
//! `wikicc-asset:<hash>` placeholder becomes `cid:<hash>`, and the bytes travel
//! as separate MIME parts of one `index.mhtml` file:
//!
//! ```text
//! MIME-Version: 1.0
//! Content-Type: multipart/related; type="text/html"; boundary="----=_wikicc_…"
//!
//! ------=_wikicc_…
//! Content-Type: text/html; charset="utf-8"
//! Content-Transfer-Encoding: base64
//! Content-Location: index.html
//!
//! PGh0bWw+…
//! ------=_wikicc_…
//! Content-Type: image/svg+xml
//! Content-Transfer-Encoding: base64
//! Content-Location: assets/1f0c…e9.svg
//! Content-ID: <1f0c…e9>
//!
//! PHN2Zy8+
//! ------=_wikicc_…--
//! ```
//!
//! Three details are what make browsers actually show the archive:
//!
//! - the HTML part comes **first**, because Chromium treats the first part as
//!   the root resource of the archive;
//! - every asset part carries **both** `Content-Location` (the same
//!   `assets/<hash>.<ext>` address the `html-dir` format uses, which is what
//!   RFC 2557 resolves relative URIs against) and `Content-ID`, because a
//!   `cid:` reference is resolved by matching `Content-ID` inside an MHTML
//!   archive — a part with only `Content-Location` leaves `cid:` unresolvable;
//! - the envelope is CRLF throughout while the page keeps its own line endings,
//!   because the page is base64 encoded and never mixed into the envelope.
//!
//! Determinism: the boundary is derived from the rendered page (which already
//! contains the payload and every asset hash), the parts follow the hash order
//! of [`crate::assets::AssetTable`], and nothing here reads the clock, the
//! environment or a random source. There is no `Date` header for the same
//! reason. Two builds of the same input are therefore byte-identical.
//!
//! The archive is assembled in memory and written with a single `fs::write`,
//! which keeps the "a failed build writes no artifact" guarantee the other two
//! writers have: an unregistered placeholder or an encoding failure aborts
//! before the file exists. The price is peak memory of roughly
//! `page + base64 scratch + archive` (about 1.4x the payload on top of the
//! page), which is the right trade for a documentation build; streaming would
//! save that memory but would leave a truncated archive on disk when the disk
//! fills up mid-write.

use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use crate::assets::{Asset, asset_hash};
use crate::error::{Error, Result};
use crate::options::OutputFormat;
use crate::render::RenderedSite;
use crate::site::SiteBuild;

use super::{
    HTML_FILE_NAME, MHTML_FILE_NAME, SiteWriter, WriteReport, asset_relative_path,
    expand_placeholders, io_error,
};

/// Fixed prefix of the multipart boundary.
///
/// The `-` and `_` characters are what make a collision with a body impossible:
/// base64 only ever emits `A-Za-z0-9+/=`, so a delimiter containing `-` or `_`
/// can never be produced by the encoded payload and no collision scan is needed.
pub const BOUNDARY_PREFIX: &str = "----=_wikicc_";

/// Maximum number of base64 characters per line, per RFC 2045.
///
/// 76 is a multiple of 4, which is the width of one base64 quantum: slicing the
/// encoded text every 76 characters therefore never splits a 4-character group
/// and the result decodes to the original bytes without re-encoding.
pub const LINE_WIDTH: usize = 76;

/// Line terminator of the MIME envelope.
const CRLF: &str = "\r\n";

/// Writer for [`OutputFormat::Mhtml`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MhtmlWriter;

impl SiteWriter for MhtmlWriter {
    fn format(&self) -> OutputFormat {
        OutputFormat::Mhtml
    }

    fn write(&self, build: &SiteBuild, rendered: &RenderedSite, out: &Path) -> Result<WriteReport> {
        // The boundary only needs the rendered page: it carries the payload and
        // the content hash of every asset, so two builds that differ anywhere
        // also differ here. Deriving it before the expansion also means the
        // addresser below stays a pure substitution.
        let boundary = boundary_for(&rendered.html);

        // Expand first, so a page that references an unregistered resource fails
        // while the output directory is still empty.
        let (page, _) = expand_placeholders(&rendered.html, &build.assets, |asset, sink| {
            sink.push_str(&cid_reference(asset));
            Ok(())
        })?;

        let mut envelope = Vec::with_capacity(archive_capacity(
            page.len() as u64 + build.assets.total_bytes(),
        ));
        let mut scratch: Vec<u8> = Vec::new();

        write_archive_header(&mut envelope, &boundary);
        write_delimiter(&mut envelope, &boundary);
        write_html_part_headers(&mut envelope);
        write_folded_base64(page.as_bytes(), &mut envelope, &mut scratch)?;
        drop(page);

        // Hash order, so the part order is independent of discovery order.
        for (_, asset) in build.assets.iter() {
            write_delimiter(&mut envelope, &boundary);
            write_asset_part_headers(&mut envelope, asset);
            write_folded_base64(&asset.bytes, &mut envelope, &mut scratch)?;
        }

        write_closing_delimiter(&mut envelope, &boundary);

        let path = out.join(MHTML_FILE_NAME);
        std::fs::write(&path, &envelope)
            .map_err(|error| io_error("write the archive", &path, error))?;

        Ok(WriteReport {
            files: 1,
            bytes: envelope.len() as u64,
            // One part per unique resource: content-addressed hashes collapse
            // duplicates before the writer ever sees them.
            assets: build.assets.len(),
        })
    }
}

/// Boundary of an archive whose page is `page`: [`BOUNDARY_PREFIX`] plus the
/// content hash of the page.
///
/// The result is 28 characters, well below the 70-character limit of RFC 2046,
/// and stable for a given input, which is what keeps builds reproducible.
pub fn boundary_for(page: &str) -> String {
    format!("{BOUNDARY_PREFIX}{}", asset_hash(page.as_bytes()))
}

/// How the HTML refers to `asset`: `cid:<hash>`.
///
/// The hash is lowercase hexadecimal, so it needs no percent-encoding to be a
/// valid `cid:` URL (RFC 2392) and the payload stays valid JSON.
pub fn cid_reference(asset: &Asset) -> String {
    format!("cid:{}", asset.hash)
}

/// Append `bytes` to `out` as base64 folded at [`LINE_WIDTH`] columns.
///
/// Every line, including the last one, ends with CRLF and no line carries a
/// trailing space, so the part body is terminated exactly once and the next
/// delimiter starts on a line of its own. Empty input produces no line at all:
/// the part body is then empty, which is valid base64 for empty content.
///
/// `scratch` is reused across calls, so encoding a second asset does not
/// allocate a second full-size buffer.
pub fn write_folded_base64(bytes: &[u8], out: &mut Vec<u8>, scratch: &mut Vec<u8>) -> Result<()> {
    let encoded_len = base64::encoded_len(bytes.len(), true).ok_or_else(|| {
        Error::Write(format!(
            "a {}-byte resource is too large to base64 encode",
            bytes.len()
        ))
    })?;

    scratch.resize(encoded_len, 0);
    let written = STANDARD
        .encode_slice(bytes, scratch.as_mut_slice())
        .map_err(|error| Error::Write(format!("cannot base64 encode a resource: {error}")))?;

    for line in scratch[..written].chunks(LINE_WIDTH) {
        out.extend_from_slice(line);
        out.extend_from_slice(CRLF.as_bytes());
    }

    Ok(())
}

/// Upper bound for the archive size, so the envelope is built in one allocation.
///
/// Base64 turns every three raw bytes into four characters and folding adds a
/// CRLF per 76 characters, so the payload grows by at most ~37%; the fixed
/// slack covers the headers and the delimiters.
fn archive_capacity(raw_bytes: u64) -> usize {
    usize::try_from(raw_bytes.saturating_mul(14) / 10 + 4096).unwrap_or(0)
}

/// Append the envelope header block, terminated by the blank line that starts
/// the body.
///
/// The `Content-Type` line is longer than the 78 columns RFC 5322 recommends
/// for header fields; MIME sets no hard limit, and both `mailparse` and
/// Chromium parse it as it is, so it is kept on one line instead of being
/// folded for cosmetics.
fn write_archive_header(out: &mut Vec<u8>, boundary: &str) {
    push_line(out, "MIME-Version: 1.0");
    push(
        out,
        "Content-Type: multipart/related; type=\"text/html\"; boundary=\"",
    );
    push(out, boundary);
    push_line(out, "\"");
    push_line(out, "");
}

/// Append the `--boundary` line that opens a part.
fn write_delimiter(out: &mut Vec<u8>, boundary: &str) {
    push(out, "--");
    push_line(out, boundary);
}

/// Append the `--boundary--` line that closes the archive.
fn write_closing_delimiter(out: &mut Vec<u8>, boundary: &str) {
    push(out, "--");
    push(out, boundary);
    push_line(out, "--");
}

/// Append the headers of the HTML part, followed by its blank line.
fn write_html_part_headers(out: &mut Vec<u8>) {
    push_line(out, "Content-Type: text/html; charset=\"utf-8\"");
    push_line(out, "Content-Transfer-Encoding: base64");
    push(out, "Content-Location: ");
    push_line(out, HTML_FILE_NAME);
    push_line(out, "");
}

/// Append the headers of an asset part, followed by its blank line.
fn write_asset_part_headers(out: &mut Vec<u8>, asset: &Asset) {
    push(out, "Content-Type: ");
    push_line(out, &asset.mime);
    push_line(out, "Content-Transfer-Encoding: base64");
    push(out, "Content-Location: ");
    push_line(out, &asset_relative_path(asset));
    push(out, "Content-ID: <");
    push(out, &asset.hash);
    push_line(out, ">");
    push_line(out, "");
}

/// Append `text` as UTF-8 bytes.
fn push(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(text.as_bytes());
}

/// Append `text` and terminate the line with CRLF.
fn push_line(out: &mut Vec<u8>, text: &str) {
    push(out, text);
    push(out, CRLF);
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

    /// The archive of `build` as text, which is safe because every part is
    /// either a header or base64.
    fn archive_of(build: &SiteBuild, rendered: &RenderedSite) -> (Vec<u8>, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        MhtmlWriter
            .write(build, rendered, dir.path())
            .expect("write");
        let bytes = fs::read(dir.path().join(MHTML_FILE_NAME)).expect("index.mhtml");
        let text = String::from_utf8(bytes.clone()).expect("the archive is ASCII");

        (bytes, text)
    }

    /// Everything after each `--boundary` delimiter, in order.
    fn parts<'a>(archive: &'a str, boundary: &str) -> Vec<&'a str> {
        let delimiter = format!("--{boundary}");

        archive.split(&delimiter).skip(1).collect()
    }

    #[test]
    fn the_writer_declares_its_format() {
        assert_eq!(MhtmlWriter.format(), OutputFormat::Mhtml);
    }

    #[test]
    fn the_boundary_is_the_prefix_plus_the_page_hash() {
        let boundary = boundary_for("<html></html>");

        assert_eq!(
            boundary,
            format!("{BOUNDARY_PREFIX}{}", asset_hash(b"<html></html>"))
        );
        assert_eq!(boundary.len(), BOUNDARY_PREFIX.len() + 16);
        assert_eq!(boundary, boundary_for("<html></html>"));
        assert_ne!(boundary, boundary_for("<html> </html>"));
    }

    #[test]
    fn a_short_payload_is_a_single_folded_line() {
        let mut out = Vec::new();
        let mut scratch = Vec::new();

        write_folded_base64(b"hello", &mut out, &mut scratch).expect("encode");

        // base64("hello") = aGVsbG8=
        assert_eq!(out, b"aGVsbG8=\r\n");
    }

    #[test]
    fn an_empty_payload_produces_no_line() {
        let mut out = Vec::new();
        let mut scratch = Vec::new();

        write_folded_base64(b"", &mut out, &mut scratch).expect("encode");

        assert!(out.is_empty(), "an empty body must not emit a bare CRLF");
    }

    #[test]
    fn folding_wraps_at_76_columns_with_crlf() {
        let bytes: Vec<u8> = (0..200u8).collect();
        let mut out = Vec::new();
        let mut scratch = Vec::new();

        write_folded_base64(&bytes, &mut out, &mut scratch).expect("encode");

        let text = String::from_utf8(out).expect("base64 is ASCII");
        assert!(text.ends_with("\r\n"), "the last line is terminated too");
        assert!(
            !text.contains("\n\n"),
            "folding must not emit an empty line: {text:?}"
        );

        let lines: Vec<&str> = text.split("\r\n").filter(|line| !line.is_empty()).collect();
        // base64 of 200 bytes is 268 characters: 3 full lines plus 40.
        assert_eq!(lines.len(), 4);
        assert_eq!(lines.iter().map(|line| line.len()).sum::<usize>(), 268);

        for line in &lines[..3] {
            assert_eq!(line.len(), LINE_WIDTH, "line: {line}");
        }
        assert_eq!(lines[3].len(), 268 - 3 * LINE_WIDTH);
        assert!(
            !text.contains(" \r\n"),
            "a folded line must not end with a space"
        );
    }

    #[test]
    fn a_payload_of_exactly_one_line_gets_one_terminator() {
        // 57 bytes encode to exactly 76 characters.
        let bytes = vec![0u8; 57];
        let mut out = Vec::new();
        let mut scratch = Vec::new();

        write_folded_base64(&bytes, &mut out, &mut scratch).expect("encode");

        assert_eq!(out.len(), LINE_WIDTH + CRLF.len());
        assert!(out.ends_with(CRLF.as_bytes()));
    }

    #[test]
    fn a_payload_that_is_a_multiple_of_the_line_width_has_no_empty_line() {
        // 114 bytes encode to exactly 152 characters, i.e. two full lines.
        let bytes = vec![0u8; 114];
        let mut out = Vec::new();
        let mut scratch = Vec::new();

        write_folded_base64(&bytes, &mut out, &mut scratch).expect("encode");

        assert_eq!(out.len(), 2 * LINE_WIDTH + 2 * CRLF.len());
    }

    #[test]
    fn folded_output_decodes_back_to_the_input() {
        let bytes: Vec<u8> = (0..=255u8).collect();
        let mut out = Vec::new();
        let mut scratch = Vec::new();

        write_folded_base64(&bytes, &mut out, &mut scratch).expect("encode");

        let text = String::from_utf8(out).expect("base64 is ASCII");
        let joined: String = text.split("\r\n").collect();
        assert_eq!(STANDARD.decode(joined).expect("valid base64"), bytes);
    }

    #[test]
    fn the_scratch_buffer_is_reused_across_parts() {
        let mut scratch = vec![0xFF; 256];
        let mut out = Vec::new();

        write_folded_base64(b"hello", &mut out, &mut scratch).expect("first");
        write_folded_base64(b"a", &mut out, &mut scratch).expect("second");

        assert_eq!(out, b"aGVsbG8=\r\nYQ==\r\n");
        assert_eq!(
            scratch.len(),
            4,
            "the buffer shrinks to the smaller payload"
        );
    }

    #[test]
    fn the_archive_starts_with_the_multipart_header() {
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let (_, archive) = archive_of(&build, &page_with(&hashes));
        let boundary = boundary_for(&page_with(&hashes).html);

        assert!(archive.starts_with("MIME-Version: 1.0\r\n"));
        assert!(archive.contains(&format!(
            "Content-Type: multipart/related; type=\"text/html\"; boundary=\"{boundary}\"\r\n"
        )));
        assert!(archive.contains("\r\n\r\n--"));
        assert!(
            !archive.contains("Date:"),
            "a date header would break reproducibility"
        );
    }

    #[test]
    fn the_html_part_comes_first_and_assets_follow_in_hash_order() {
        let (build, hashes) = build_with(&[("b.png", b"png"), ("a.svg", b"<svg/>")]);
        let (_, archive) = archive_of(&build, &page_with(&hashes));
        let boundary = boundary_for(&page_with(&hashes).html);
        let parts = parts(&archive, &boundary);

        // The closing delimiter leaves one empty trailing slice.
        assert_eq!(parts.len(), 1 + build.assets.len() + 1);
        assert!(parts[0].contains("Content-Type: text/html"));

        let mut expected: Vec<&String> = hashes.iter().collect();
        expected.sort();
        for (part, hash) in parts[1..].iter().zip(expected) {
            assert!(
                part.contains(&format!("Content-ID: <{hash}>")),
                "part order must follow the hash order: {part}"
            );
        }
    }

    #[test]
    fn asset_parts_carry_location_mime_and_content_id() {
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let (_, archive) = archive_of(&build, &page_with(&hashes));
        let hash = &hashes[0];

        assert!(archive.contains(&format!("Content-Location: assets/{hash}.svg\r\n")));
        assert!(archive.contains("Content-Type: image/svg+xml\r\n"));
        assert!(archive.contains(&format!("Content-ID: <{hash}>\r\n")));
    }

    #[test]
    fn placeholders_become_cid_references() {
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let rendered = page_with(&hashes);
        let (_, archive) = archive_of(&build, &rendered);
        let boundary = boundary_for(&rendered.html);
        let html_part = parts(&archive, &boundary)[0];
        let (_, body) = html_part.split_once("\r\n\r\n").expect("headers and body");
        let joined: String = body.trim_end_matches("\r\n").replace("\r\n", "");
        let page = String::from_utf8(STANDARD.decode(joined).expect("valid base64"))
            .expect("the page is UTF-8");

        assert!(!page.contains("wikicc-asset:"));
        assert!(page.contains(&format!("cid:{}", hashes[0])));
        assert!(!page.contains("data:image"));
        assert!(!page.contains("assets/"));
    }

    #[test]
    fn the_envelope_is_crlf_only() {
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let (bytes, _) = archive_of(&build, &page_with(&hashes));

        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'\n' {
                assert!(
                    index > 0 && bytes[index - 1] == b'\r',
                    "a bare LF at offset {index} would break the MIME envelope"
                );
            }
        }
    }

    #[test]
    fn the_archive_ends_with_the_closing_delimiter() {
        let (build, hashes) = build_with(&[("logo.svg", b"<svg/>")]);
        let (_, archive) = archive_of(&build, &page_with(&hashes));
        let boundary = boundary_for(&page_with(&hashes).html);

        assert!(archive.ends_with(&format!("--{boundary}--\r\n")));
    }

    #[test]
    fn a_site_without_assets_holds_only_the_html_part() {
        let (build, _) = build_with(&[]);
        let rendered = RenderedSite {
            html: "<html></html>".to_string(),
        };
        let (_, archive) = archive_of(&build, &rendered);
        let boundary = boundary_for(&rendered.html);

        assert_eq!(
            parts(&archive, &boundary).len(),
            2,
            "the part and the close"
        );
        assert!(archive.contains("Content-Type: text/html"));
        assert!(!archive.contains("Content-ID:"));
    }

    #[test]
    fn the_report_counts_the_archive() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, hashes) = build_with(&[("a.svg", b"<svg/>"), ("b.bin", &[0u8, 1, 2, 3])]);

        let report = MhtmlWriter
            .write(&build, &page_with(&hashes), dir.path())
            .expect("write");

        let written = fs::metadata(dir.path().join(MHTML_FILE_NAME))
            .expect("artifact metadata")
            .len();
        assert_eq!(report.files, 1);
        assert_eq!(report.assets, 2);
        assert_eq!(report.bytes, written);
    }

    #[test]
    fn an_unknown_placeholder_fails_before_anything_is_written() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (build, _) = build_with(&[("logo.svg", b"<svg/>")]);
        let rendered = RenderedSite {
            html: "<img src=\"wikicc-asset:0000000000000000\">".to_string(),
        };

        let error = MhtmlWriter
            .write(&build, &rendered, dir.path())
            .expect_err("unknown placeholder");

        assert!(
            error.to_string().contains("unknown asset placeholder"),
            "unexpected message: {error}"
        );
        assert!(
            !dir.path().join(MHTML_FILE_NAME).exists(),
            "a failed expansion must not leave a partial archive"
        );
    }

    #[test]
    fn asset_bytes_survive_the_encoding() {
        let (build, hashes) = build_with(&[("blob.bin", &(0..=255u8).collect::<Vec<u8>>())]);
        let (_, archive) = archive_of(&build, &page_with(&hashes));
        let boundary = boundary_for(&page_with(&hashes).html);
        let asset_part = parts(&archive, &boundary)
            .into_iter()
            .find(|part| part.contains("Content-ID:"))
            .expect("an asset part");

        let (headers, body) = asset_part.split_once("\r\n\r\n").expect("headers and body");
        assert!(headers.contains("Content-Type: application/octet-stream"));
        let joined: String = body.trim_end_matches("\r\n").replace("\r\n", "");
        assert_eq!(
            STANDARD.decode(joined).expect("valid base64"),
            (0..=255u8).collect::<Vec<u8>>()
        );
    }
}
