//! Integration tests for build-side encryption: the `encrypt` front matter
//! directive, the three password sources and the artifact shapes, observed
//! through real builds of the compiled binary.
//!
//! The unit tests of `src/encrypt.rs` pin the directive matrix and the
//! sealing pass; the unit tests of `src/crypto.rs` pin the primitives. This
//! suite walks the binary: a password must reach the seal from the command
//! line, the environment or the configuration file, a missing one must abort
//! the build before anything is written whatever `--strict` says, and the
//! artifacts of all three formats must carry ciphertext and parameters
//! without ever carrying the password or the plaintext.

use std::path::Path;

use assert_cmd::Command;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use predicates::prelude::*;
use serde_json::Value;
use tempfile::TempDir;

use wikicc::crypto::{OpenError, SealedRef, open};

/// The global password the tests seal with.
const PASSWORD: &str = "global secret";

/// A body marker no artifact may carry in the clear.
const SECRET_BODY: &str = "a distinctive secret body";

/// The compiled `wikicc` binary.
fn wikicc() -> Command {
    Command::cargo_bin("wikicc").expect("wikicc binary is built for integration tests")
}

/// A two-document site: one sealed by its front matter, one public.
///
/// The ids are chosen so the sealed document is also the payload's first:
/// `intro.md` sorts before `public.md` in byte order, which is scan order.
fn fixture() -> TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("intro.md"),
        format!("---\nencrypt: true\n---\n\n# Intro\n\n{SECRET_BODY}\n"),
    )
    .expect("write fixture");
    std::fs::write(
        dir.path().join("public.md"),
        "# Public\n\nOpen to everyone.\n",
    )
    .expect("write fixture");
    dir
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}

/// Build `dir` into `out` with `format`, sealing with `--password`.
fn build_with_cli_password(dir: &TempDir, out: &Path, format: &str) {
    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(out), "--format", format])
        .args(["--password", PASSWORD])
        .assert()
        .success();
}

/// The JSON payload a shell page embeds.
fn shell_payload(page: &str) -> Value {
    let marker = r#"<script id="wikicc-payload" type="application/json">"#;
    let start = page.find(marker).expect("payload element") + marker.len();
    let end = page[start..].find("</script>").expect("payload end") + start;
    serde_json::from_str(&page[start..end]).expect("the payload parses")
}

/// The document entry of a payload for `id`.
fn payload_doc<'a>(payload: &'a Value, id: &str) -> &'a Value {
    payload["docs"]
        .as_array()
        .expect("payload docs")
        .iter()
        .find(|doc| doc["id"] == id)
        .expect("the document is in the payload")
}

/// Try to open a payload's `enc` block with `password`, binding `aad`.
fn opens_with(blob: &Value, password: &str, aad: &str) -> Result<Vec<u8>, OpenError> {
    open(
        SealedRef {
            salt: &STANDARD
                .decode(blob["salt"].as_str().expect("salt"))
                .expect("the salt decodes"),
            nonce: &STANDARD
                .decode(blob["nonce"].as_str().expect("nonce"))
                .expect("the nonce decodes"),
            ct: &STANDARD
                .decode(blob["ct"].as_str().expect("ct"))
                .expect("the ciphertext decodes"),
        },
        password,
        aad.as_bytes(),
    )
}

/// The object keys of a JSON value, sorted.
fn keys_of(value: &Value) -> Vec<&str> {
    value
        .as_object()
        .map(|object| object.keys().map(String::as_str).collect())
        .expect("an object")
}

#[test]
fn an_encrypted_document_without_any_password_fails_the_build() {
    let dir = fixture();
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .assert()
        .code(1)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("document 'intro.md'"))
        .stderr(predicate::str::contains("no password is available"));

    assert!(!out.exists(), "a refused build writes nothing");
}

#[test]
fn the_missing_password_error_is_hard_whatever_strict_says() {
    let dir = fixture();
    let out = dir.path().join("dist");

    for extra in [vec![], vec!["--strict"]] {
        wikicc()
            .arg(dir.path())
            .args(["--out", &path_string(&out)])
            .args(extra)
            .assert()
            .code(1)
            .stderr(predicate::str::contains("no password is available"));

        assert!(!out.exists(), "a refused build writes nothing");
    }
}

#[test]
fn the_command_line_password_seals_documents_in_every_format() {
    for format in ["single-html", "html-dir", "pages"] {
        let dir = fixture();
        let out = dir.path().join(format);
        build_with_cli_password(&dir, &out, format);

        // The two shell formats embed the whole documents; the pages format
        // embeds the manifest, where a lock is a mark and every body lives in
        // the chunk the shell refers to.
        let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
        let payload = shell_payload(&page);
        let sealed = payload_doc(&payload, "intro.md");
        let public = payload_doc(&payload, "public.md");
        let (sealed_body, public_body) = if format == "pages" {
            assert_eq!(sealed["enc"], true, "{format}: the manifest marks the lock");
            assert!(
                public.as_object().expect("an object").get("enc").is_none(),
                "{format}: the public manifest entry carries no enc mark"
            );
            let sealed_chunk: Value = serde_json::from_str(
                &std::fs::read_to_string(out.join("pages").join("intro.md.json"))
                    .expect("sealed chunk"),
            )
            .expect("chunk JSON");
            let public_chunk: Value = serde_json::from_str(
                &std::fs::read_to_string(out.join("pages").join("public.md.json"))
                    .expect("public chunk"),
            )
            .expect("chunk JSON");
            (sealed_chunk, public_chunk)
        } else {
            let blob = &sealed["enc"];
            assert_eq!(blob["v"], 1, "{format}");
            assert_eq!(blob["kdf"], "pbkdf2-sha256", "{format}");
            assert_eq!(blob["iters"], 600_000, "{format}");
            assert!(!blob["salt"].as_str().expect("salt").is_empty(), "{format}");
            assert!(
                !blob["nonce"].as_str().expect("nonce").is_empty(),
                "{format}"
            );
            assert!(!blob["ct"].as_str().expect("ct").is_empty(), "{format}");
            assert!(
                public.as_object().expect("an object").get("enc").is_none(),
                "{format}: an unsealed document carries no enc key"
            );
            (sealed.clone(), public.clone())
        };

        // The sealed body is emptied; the title stays public.
        assert_eq!(sealed_body["html"], "", "{format}");
        assert_eq!(sealed_body["text"], "", "{format}");
        assert_eq!(sealed_body["toc"], serde_json::json!([]), "{format}");
        assert_eq!(sealed_body["title"], "Intro", "{format}");

        // The public body keeps its markup.
        assert!(
            public_body["html"]
                .as_str()
                .expect("html")
                .contains("Open to everyone"),
            "{format}"
        );

        // The page never carries the password, the plaintext or the directive.
        assert!(!page.contains(PASSWORD), "{format}");
        assert!(!page.contains(SECRET_BODY), "{format}");
        assert!(!page.contains("encrypt:"), "{format}");
    }
}

#[test]
fn the_pages_format_carries_the_sealed_chunk_and_a_title_only_corpus_entry() {
    let dir = fixture();
    let out = dir.path().join("site");
    build_with_cli_password(&dir, &out, "pages");

    // The chunk carries the ciphertext beside the emptied body.
    let chunk = std::fs::read_to_string(out.join("pages").join("intro.md.json")).expect("chunk");
    let value: Value = serde_json::from_str(&chunk).expect("chunk JSON");
    assert_eq!(
        keys_of(&value),
        vec!["blocks", "enc", "html", "id", "text", "title", "toc", "v"]
    );
    assert!(!chunk.contains(SECRET_BODY) && !chunk.contains(PASSWORD));

    // The corpus lists the sealed document's title alone.
    let corpus = std::fs::read_to_string(out.join("search.json")).expect("corpus");
    let records = serde_json::from_str::<Value>(&corpus).expect("corpus JSON")["docs"]
        .as_array()
        .expect("records")
        .clone();
    let sealed = records
        .iter()
        .find(|record| record["id"] == "intro.md")
        .expect("the sealed record");
    assert_eq!(keys_of(sealed), vec!["id", "title"]);
    let public = records
        .iter()
        .find(|record| record["id"] == "public.md")
        .expect("the public record");
    assert_eq!(keys_of(public), vec!["headings", "id", "text", "title"]);

    // The manifest marks the lock beside the chunk reference.
    let page = std::fs::read_to_string(out.join("index.html")).expect("shell");
    let manifest = shell_payload(&page);
    assert_eq!(payload_doc(&manifest, "intro.md")["enc"], true);
    assert_eq!(
        payload_doc(&manifest, "intro.md")
            .as_object()
            .map(|object| object.len()),
        Some(4),
        "the manifest entry carries id, title, hash and the enc mark"
    );
    assert!(
        payload_doc(&manifest, "public.md")
            .as_object()
            .expect("an object")
            .get("enc")
            .is_none(),
        "the public entry carries no enc mark"
    );
}

#[test]
fn the_environment_variable_seals_documents() {
    let dir = fixture();
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .env("WIKICC_PASSWORD", PASSWORD)
        .assert()
        .success();

    let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
    assert!(
        payload_doc(&shell_payload(&page), "intro.md")["enc"].is_object(),
        "the variable's password sealed the document"
    );
}

#[test]
fn the_configured_password_seals_documents() {
    let dir = fixture();
    std::fs::write(
        dir.path().join(".wikicc.json"),
        format!(r#"{{"password": "{PASSWORD}"}}"#),
    )
    .expect("write config");
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .assert()
        .success();

    let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
    assert!(
        payload_doc(&shell_payload(&page), "intro.md")["enc"].is_object(),
        "the configured password sealed the document"
    );
}

#[test]
fn the_command_line_password_wins_over_the_environment_and_the_file() {
    let dir = fixture();
    std::fs::write(
        dir.path().join(".wikicc.json"),
        r#"{"password": "from-config"}"#,
    )
    .expect("write config");
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .env("WIKICC_PASSWORD", "from-env")
        .args(["--password", PASSWORD])
        .assert()
        .success();

    let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
    let blob = payload_doc(&shell_payload(&page), "intro.md")["enc"].clone();

    assert!(
        opens_with(&blob, PASSWORD, "intro.md").is_ok(),
        "the command line password sealed the document"
    );
    for loser in ["from-env", "from-config"] {
        assert_eq!(
            opens_with(&blob, loser, "intro.md"),
            Err(OpenError::Authenticated),
            "{loser} must not open the sealed body"
        );
    }
}

#[test]
fn the_environment_password_wins_over_the_file() {
    let dir = fixture();
    std::fs::write(
        dir.path().join(".wikicc.json"),
        r#"{"password": "from-config"}"#,
    )
    .expect("write config");
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .env("WIKICC_PASSWORD", PASSWORD)
        .assert()
        .success();

    let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
    let blob = payload_doc(&shell_payload(&page), "intro.md")["enc"].clone();

    assert!(opens_with(&blob, PASSWORD, "intro.md").is_ok());
    assert_eq!(
        opens_with(&blob, "from-config", "intro.md"),
        Err(OpenError::Authenticated)
    );
}

#[test]
fn the_sealed_body_opens_with_the_password_and_binds_the_document_id() {
    let dir = fixture();
    let out = dir.path().join("dist");
    build_with_cli_password(&dir, &out, "single-html");

    let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
    let blob = payload_doc(&shell_payload(&page), "intro.md")["enc"].clone();

    let plain = opens_with(&blob, PASSWORD, "intro.md").expect("the password opens the body");
    let value: Value = serde_json::from_slice(&plain).expect("canonical JSON");
    assert_eq!(
        keys_of(&value),
        vec!["blocks", "html", "text", "toc"],
        "the plaintext is exactly the four body fields"
    );
    assert!(value["text"].as_str().expect("text").contains(SECRET_BODY));

    assert_eq!(
        opens_with(&blob, PASSWORD, "public.md"),
        Err(OpenError::Authenticated),
        "the ciphertext is bound to its own document"
    );
    assert_eq!(
        opens_with(&blob, "wrong password", "intro.md"),
        Err(OpenError::Authenticated),
        "the wrong password opens nothing"
    );
}

#[test]
fn a_document_password_seals_without_a_global_one() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("notes.md"),
        format!("---\nencrypt: \"docpw\"\n---\n\n# Notes\n\n{SECRET_BODY}\n"),
    )
    .expect("write fixture");
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .assert()
        .success();

    let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
    let blob = payload_doc(&shell_payload(&page), "notes.md")["enc"].clone();

    assert!(opens_with(&blob, "docpw", "notes.md").is_ok());
    assert_eq!(
        opens_with(&blob, PASSWORD, "notes.md"),
        Err(OpenError::Authenticated),
        "the global password is not the document's password"
    );
    assert!(
        !page.contains("docpw"),
        "the document password never reaches the artifact"
    );
}

#[test]
fn every_document_password_spelling_seals() {
    for directive in ["encrypt: \"docpw\"", "encrypt: 'docpw'", "encrypt: docpw"] {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join("notes.md"),
            format!("---\n{directive}\n---\n\n# Notes\n\nbody\n"),
        )
        .expect("write fixture");
        let out = dir.path().join("dist");

        wikicc()
            .arg(dir.path())
            .args(["--out", &path_string(&out)])
            .assert()
            .success();

        let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
        assert!(
            payload_doc(&shell_payload(&page), "notes.md")["enc"].is_object(),
            "{directive}"
        );
    }
}

#[test]
fn an_empty_password_value_is_a_hard_error_whatever_the_source() {
    let dir = fixture();
    let out = dir.path().join("dist");

    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out), "--password", "   "])
        .assert()
        .code(1)
        .stderr(predicate::str::contains(
            "'password' must be a non-empty string",
        ));

    std::fs::write(dir.path().join(".wikicc.json"), r#"{"password": ""}"#).expect("write config");
    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .assert()
        .code(1)
        .stderr(predicate::str::contains(
            "'password' must be a non-empty string",
        ));

    assert!(!out.exists(), "a refused build writes nothing");
}

#[test]
fn a_blank_environment_password_did_not_speak() {
    let dir = fixture();
    let out = dir.path().join("dist");

    // A blank variable is unset, so the build falls through to the seal error
    // rather than sealing with an empty password.
    wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(&out)])
        .env("WIKICC_PASSWORD", "   ")
        .assert()
        .code(1)
        .stderr(predicate::str::contains("document 'intro.md'"));

    assert!(!out.exists(), "a refused build writes nothing");
}

#[test]
fn an_illegal_encrypt_value_fails_the_build() {
    for directive in ["encrypt: \"\"", "encrypt: 123", "encrypt: [a, b]"] {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join("notes.md"),
            format!("---\n{directive}\n---\n\n# Notes\n"),
        )
        .expect("write fixture");
        let out = dir.path().join("dist");

        wikicc()
            .arg(dir.path())
            .args(["--out", &path_string(&out)])
            .args(["--password", PASSWORD])
            .assert()
            .code(1)
            .stderr(predicate::str::contains("document 'notes.md'"))
            .stderr(predicate::str::contains("'encrypt'"));

        assert!(!out.exists(), "{directive}: a refused build writes nothing");
    }
}

#[test]
fn a_site_without_encryption_carries_no_enc_key_anywhere() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("intro.md"),
        "# Intro\n\nOpen to everyone.\n",
    )
    .expect("write fixture");

    for format in ["single-html", "html-dir", "pages"] {
        let out = dir.path().join(format);
        wikicc()
            .arg(dir.path())
            .args(["--out", &path_string(&out), "--format", format])
            .assert()
            .success();

        let page = std::fs::read_to_string(out.join("index.html")).expect("read page");
        assert!(
            !page.contains("\"enc\""),
            "{format}: no sealed document, no enc key anywhere"
        );

        if format == "pages" {
            let corpus = std::fs::read_to_string(out.join("search.json")).expect("corpus");
            let records = serde_json::from_str::<Value>(&corpus).expect("corpus JSON")["docs"]
                .as_array()
                .expect("records")
                .clone();
            assert_eq!(
                keys_of(&records[0]),
                vec!["headings", "id", "text", "title"],
                "{format}: a public record carries its text"
            );
        }
    }
}

/// Image X: shown by a public document and by a sealed one.
const X_IMAGE: &[u8] = b"<svg>shared image X</svg>";

/// Image Y: shown only by a sealed document.
const Y_IMAGE: &[u8] = b"<svg>sealed-only image Y</svg>";

/// A three-document site with the two halves of the asset boundary in one
/// place: `public.md` shows image X, `shared.md` (sealed) shows the same X,
/// and `private.md` (sealed) shows image Y that nothing public references.
fn asset_fixture() -> TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    let images = dir.path().join("img");
    std::fs::create_dir(&images).expect("create image directory");
    std::fs::write(images.join("x.svg"), X_IMAGE).expect("write X");
    std::fs::write(images.join("y.svg"), Y_IMAGE).expect("write Y");

    for (name, body) in [
        ("public.md", "# Public\n\n![x](img/x.svg)\n".to_string()),
        (
            "shared.md",
            "---\nencrypt: true\n---\n\n# Shared\n\n![x](img/x.svg)\n".to_string(),
        ),
        (
            "private.md",
            "---\nencrypt: true\n---\n\n# Private\n\n![y](img/y.svg)\n".to_string(),
        ),
    ] {
        std::fs::write(dir.path().join(name), body).expect("write fixture");
    }

    dir
}

/// Build `dir` into `out` with `format`, sealing with `--password`, and
/// return the summary line.
fn build_asset_site(dir: &TempDir, out: &Path, format: &str) -> String {
    let output = wikicc()
        .arg(dir.path())
        .args(["--out", &path_string(out), "--format", format])
        .args(["--password", PASSWORD])
        .output()
        .expect("run wikicc");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("stdout is utf-8")
}

/// Bytes of every regular file under `root`, recursively, in walk order.
fn artifact_bytes(root: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    for entry in walkdir::WalkDir::new(root) {
        let entry = entry.expect("walk the artifact");
        if entry.file_type().is_file() {
            bytes.extend(std::fs::read(entry.path()).expect("read artifact file"));
        }
    }

    bytes
}

/// Whether `haystack` contains `needle` as a byte substring.
fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// File names directly inside `dir`, sorted.
fn asset_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("the asset directory exists")
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

/// The boundary holds in the two formats that write assets as files: the
/// shared image is published for its public reference, the sealed-only image
/// is not published at all, and the summary and the payload stats follow.
#[test]
fn a_sealed_only_asset_is_not_written_and_the_counts_follow() {
    let x_file = format!("{}.svg", wikicc::asset_hash(X_IMAGE));
    let y_file = format!("{}.svg", wikicc::asset_hash(Y_IMAGE));
    let favicon_file = format!("{}.svg", wikicc::asset_hash(wikicc::DEFAULT_FAVICON));

    for format in ["html-dir", "pages"] {
        let dir = asset_fixture();
        let out = dir.path().join(format);
        let summary = build_asset_site(&dir, &out, format);

        assert!(
            summary.starts_with("compiled 3 documents, 2 assets -> "),
            "{format}: {summary}"
        );

        let names = asset_names(&out.join("assets"));
        assert!(
            names.contains(&x_file) && names.contains(&favicon_file),
            "{format}: the shared image and the favicon are written: {names:?}"
        );
        assert!(
            !names.contains(&y_file),
            "{format}: the sealed-only image is not written: {names:?}"
        );

        // The whole artifact carries Y's bytes nowhere in the clear — not
        // raw, not base64-encoded.
        let bytes = artifact_bytes(&out);
        assert!(
            !bytes_contain(&bytes, Y_IMAGE),
            "{format}: the sealed-only image leaks as raw bytes"
        );
        assert!(
            !bytes_contain(&bytes, STANDARD.encode(Y_IMAGE).as_bytes()),
            "{format}: the sealed-only image leaks as base64"
        );

        // Both shells carry the same stats: X and the favicon, not Y.
        let page = std::fs::read_to_string(out.join("index.html")).expect("read shell");
        assert_eq!(shell_payload(&page)["stats"]["assets"], 2, "{format}");
    }
}

/// `single-html` inlines what the artifact addresses and nothing else: the
/// shared image travels for its public reference, the sealed-only image only
/// inside the ciphertext.
#[test]
fn single_html_does_not_leak_a_sealed_only_asset() {
    let dir = asset_fixture();
    let out = dir.path().join("single");
    let summary = build_asset_site(&dir, &out, "single-html");

    assert!(
        summary.starts_with("compiled 3 documents, 2 assets -> "),
        "{summary}"
    );

    let page = std::fs::read(out.join("index.html")).expect("read artifact");
    assert!(
        !bytes_contain(&page, Y_IMAGE),
        "the sealed-only image leaks as raw bytes"
    );
    assert!(
        !bytes_contain(&page, STANDARD.encode(Y_IMAGE).as_bytes()),
        "the sealed-only image leaks as base64"
    );
    assert!(
        bytes_contain(&page, STANDARD.encode(X_IMAGE).as_bytes()),
        "the shared image is inlined for its public reference"
    );

    let payload = shell_payload(std::str::from_utf8(&page).expect("the page is utf-8"));
    assert_eq!(payload["stats"]["assets"], 2);
}

/// Unlocking seals the deal the other way round: the decrypted bodies render
/// their images natively as data URIs instead of dead placeholders.
#[test]
fn the_unlocked_bodies_render_their_images_as_data_uris() {
    let dir = asset_fixture();
    let out = dir.path().join("single");
    build_asset_site(&dir, &out, "single-html");

    let page = std::fs::read_to_string(out.join("index.html")).expect("read artifact");
    let payload = shell_payload(&page);

    let private_plain = opens_with(
        &payload_doc(&payload, "private.md")["enc"],
        PASSWORD,
        "private.md",
    )
    .expect("the global password opens the sealed body");
    let private: Value = serde_json::from_slice(&private_plain).expect("canonical JSON");
    let html = private["html"].as_str().expect("html");
    assert!(
        html.contains(&format!(
            "data:image/svg+xml;base64,{}",
            STANDARD.encode(Y_IMAGE)
        )),
        "the sealed-only image travels as a data URI: {html}"
    );
    assert!(
        !html.contains("wikicc-asset:"),
        "no dead placeholder survives the seal: {html}"
    );

    let shared_plain = opens_with(
        &payload_doc(&payload, "shared.md")["enc"],
        PASSWORD,
        "shared.md",
    )
    .expect("the global password opens the sealed body");
    let shared: Value = serde_json::from_slice(&shared_plain).expect("canonical JSON");
    assert!(
        shared["html"].as_str().expect("html").contains(&format!(
            "data:image/svg+xml;base64,{}",
            STANDARD.encode(X_IMAGE)
        )),
        "the shared image travels as a data URI too"
    );
}
