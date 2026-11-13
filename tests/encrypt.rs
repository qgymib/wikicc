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
        vec!["blocks", "enc", "html", "id", "text", "title", "toc"]
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
