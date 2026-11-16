//! Article-level encryption: the `encrypt` directive, password resolution
//! and the sealing pass.
//!
//! Documents declare encryption in their front matter with one field:
//!
//! - absent, `null` or `encrypt: false` — the document is public;
//! - `encrypt: true` — the document seals with the global password (the
//!   command line `--password`, the `WIKICC_PASSWORD` variable or the
//!   configuration `password` key);
//! - `encrypt: "密码"` — the document seals with its own password, which
//!   overrides the global one. The three YAML quote styles and a bare
//!   scalar all spell a password.
//!
//! Every other value — an empty string, a number, a list, a mapping — is a
//! hard error naming the document: a broken instruction must not silently
//! build a site the author did not ask for. Unknown keys are tolerated; the
//! front matter belongs to the author and to other tools, and only
//! `encrypt` means anything here.
//!
//! The sealing pass runs after assembly and before rendering. For every
//! declared document the body — html, outline, blocks and plain text — is
//! sealed into `enc` under a fresh random salt and nonce, with the document
//! id as the AES-GCM additional data, and the four fields are emptied: the
//! payload never carries the plaintext. Titles stay public; the link graph
//! and the counters are untouched, because ids and titles are metadata the
//! reader shows anyway. A document that declares encryption without any
//! available password is a hard error naming the document, whatever
//! `--strict` says.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_yaml::Value;

use crate::crypto;
use crate::error::{Error, Result};
use crate::markdown::{sections::Block, toc::TocEntry};
use crate::site::{EncryptedBlob, SiteBuild};

/// What a document's front matter asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncryptDirective {
    /// `encrypt: true`: seal with the global password.
    Global,
    /// `encrypt: "密码"`: seal with the document's own password.
    PerDoc(String),
}

/// Resolve the `encrypt` directive out of the raw front matter text.
///
/// `doc_id` names the document in every error, so a broken directive is
/// reported against the file the author has to fix. Text that is not a
/// mapping — a bare scalar, a list, nothing at all — names no `encrypt` key
/// and carries no directive: the front matter is not ours to judge.
pub fn parse_directive(raw: &str, doc_id: &str) -> Result<Option<EncryptDirective>> {
    let value: Value = serde_yaml::from_str(raw).map_err(|error| {
        Error::InvalidInput(format!(
            "document '{doc_id}': front matter is not valid YAML: {error}"
        ))
    })?;

    let Value::Mapping(mapping) = value else {
        return Ok(None);
    };

    match mapping.get(Value::from("encrypt")) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(true)) => Ok(Some(EncryptDirective::Global)),
        Some(Value::Bool(false)) => Ok(None),
        Some(Value::String(password)) if !password.is_empty() => {
            Ok(Some(EncryptDirective::PerDoc(password.clone())))
        }
        Some(other) => Err(Error::InvalidInput(format!(
            "document '{doc_id}': 'encrypt' must be true, false or a non-empty password \
             string, but is {}",
            describe(other)
        ))),
    }
}

/// Name the shape of an unacceptable `encrypt` value, for the error message.
fn describe(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "an empty string",
        Value::Sequence(_) => "a sequence",
        Value::Mapping(_) => "a mapping",
        Value::Tagged(_) => "a tagged value",
        Value::Null => "null",
    }
}

/// The body fields of one document, sealed as one canonical JSON value.
///
/// The four fields the reader needs to render — and everything the search
/// index and the preview read — travel together, so a decrypted document
/// behaves exactly like a never-encrypted one.
#[derive(serde::Serialize)]
struct PlainBody<'a> {
    html: &'a str,
    toc: &'a [TocEntry],
    blocks: &'a [Block],
    text: &'a str,
}

/// Seal every document whose front matter declares encryption, in place.
///
/// The document's own password wins over the global one. For each sealed
/// document the body is emptied and `enc` carries the ciphertext beside the
/// public title; `edges` and `stats` are untouched. The salt and the nonce
/// are fresh random bytes of every call, so two builds of the same site
/// never produce the same sealed bytes.
pub fn seal_bundle(build: &mut SiteBuild, global_password: Option<&str>) -> Result<()> {
    for (index, doc) in build.bundle.docs.iter_mut().enumerate() {
        let Some(raw) = build.front_matters.get(index).and_then(Option::as_deref) else {
            continue;
        };
        let Some(directive) = parse_directive(raw, &doc.id)? else {
            continue;
        };

        let password = match &directive {
            EncryptDirective::Global => global_password,
            EncryptDirective::PerDoc(password) => Some(password.as_str()),
        };
        let Some(password) = password else {
            return Err(Error::InvalidInput(format!(
                "document '{}' declares encryption but no password is available: pass \
                 --password, set WIKICC_PASSWORD, or set 'password' in .wikicc.json",
                doc.id
            )));
        };

        let plain = serde_json::to_vec(&PlainBody {
            html: &doc.html,
            toc: &doc.toc,
            blocks: &doc.blocks,
            text: &doc.text,
        })
        .expect("a document body always serialises to JSON");
        let sealed = crypto::seal(&plain, password, doc.id.as_bytes());

        let blob = EncryptedBlob {
            v: crypto::FORMAT_VERSION,
            kdf: crypto::KDF_NAME.to_string(),
            iters: crypto::KDF_ITERATIONS,
            salt: STANDARD.encode(sealed.salt),
            nonce: STANDARD.encode(sealed.nonce),
            ct: STANDARD.encode(&sealed.ct),
        };

        doc.html = String::new();
        doc.toc = Vec::new();
        doc.blocks = Vec::new();
        doc.text = String::new();
        doc.enc = Some(blob);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::Value as Json;

    use crate::crypto::{SealedRef, open};
    use crate::scan::SourceDoc;
    use crate::site::build_site;

    use super::*;

    const GLOBAL: &str = "global secret";

    /// Build a one-document site whose source carries `front` as the front
    /// matter and seal it with `global`.
    fn sealed(text: &str, global: Option<&str>) -> Result<crate::site::SiteBuild> {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [SourceDoc {
            id: "a.md".to_string(),
            path: dir.path().join("a.md"),
            title: "A".to_string(),
            text: text.to_string(),
        }];
        let mut build = build_site("Site", dir.path(), &docs);
        seal_bundle(&mut build, global)?;
        Ok(build)
    }

    /// The front matter text of a document that declares `directive`.
    fn declared(directive: &str) -> String {
        format!("---\n{directive}\n---\n\n# A\n\nsecret body\n")
    }

    // The `encrypt` semantic matrix.

    #[test]
    fn true_means_the_global_password() {
        assert_eq!(
            parse_directive("encrypt: true\n", "a.md").expect("parses"),
            Some(EncryptDirective::Global)
        );
    }

    #[test]
    fn false_null_and_absent_mean_no_encryption() {
        for raw in ["encrypt: false\n", "encrypt:\n", "", "title: t\n"] {
            assert_eq!(
                parse_directive(raw, "a.md").expect("parses"),
                None,
                "raw: {raw:?}"
            );
        }
    }

    #[test]
    fn every_string_spelling_carries_a_document_password() {
        for raw in [
            "encrypt: \"密码\"\n",
            "encrypt: '密码'\n",
            "encrypt: 密码\n",
        ] {
            assert_eq!(
                parse_directive(raw, "a.md").expect("parses"),
                Some(EncryptDirective::PerDoc("密码".to_string())),
                "raw: {raw:?}"
            );
        }
    }

    #[test]
    fn unknown_keys_are_tolerated() {
        let raw = "title: t\nencrypt: true\nother: kept\n";
        assert_eq!(
            parse_directive(raw, "a.md").expect("parses"),
            Some(EncryptDirective::Global)
        );
    }

    #[test]
    fn a_non_mapping_front_matter_carries_no_directive() {
        for raw in ["just a scalar\n", "- one\n- two\n"] {
            assert_eq!(
                parse_directive(raw, "a.md").expect("parses"),
                None,
                "raw: {raw:?}"
            );
        }
    }

    #[test]
    fn illegal_values_are_hard_errors_naming_the_document() {
        for raw in [
            "encrypt: \"\"\n",
            "encrypt: 123\n",
            "encrypt: [a, b]\n",
            "encrypt: {a: b}\n",
        ] {
            let error = parse_directive(raw, "a.md").expect_err("an illegal value is rejected");

            assert!(
                error.to_string().contains("document 'a.md'"),
                "the error names the document: {error}"
            );
            assert!(
                error.to_string().contains("'encrypt'"),
                "the error names the field: {error}"
            );
        }

        let error = parse_directive("encrypt: 123\n", "a.md").expect_err("a number");
        assert!(error.to_string().contains("a number"), "{error}");
        let error = parse_directive("encrypt: \"\"\n", "a.md").expect_err("an empty string");
        assert!(error.to_string().contains("an empty string"), "{error}");
    }

    #[test]
    fn a_broken_yaml_front_matter_is_a_hard_error() {
        let error = parse_directive("encrypt: [unclosed\n", "a.md").expect_err("not valid YAML");

        assert!(
            error.to_string().contains("front matter is not valid YAML"),
            "unexpected message: {error}"
        );
        assert!(error.to_string().contains("document 'a.md'"), "{error}");
    }

    // The sealing pass.

    #[test]
    fn a_global_password_seals_the_declared_document() {
        let build = sealed(&declared("encrypt: true"), Some(GLOBAL)).expect("seals");
        let doc = &build.bundle.docs[0];

        assert!(doc.enc.is_some(), "the document is sealed");
        assert_eq!(doc.html, "");
        assert_eq!(doc.toc, Vec::new());
        assert_eq!(doc.blocks, Vec::new());
        assert_eq!(doc.text, "");
        assert_eq!(doc.title, "A", "the title stays public");
    }

    #[test]
    fn a_document_password_seals_without_a_global_one() {
        let build = sealed(&declared("encrypt: \"docpw\""), None).expect("seals");

        assert!(build.bundle.docs[0].enc.is_some());
    }

    #[test]
    fn a_missing_password_is_a_hard_error_naming_the_document() {
        let error = sealed(&declared("encrypt: true"), None).expect_err("no password is available");

        assert!(
            error.to_string().contains("document 'a.md'"),
            "the error names the document: {error}"
        );
        assert!(
            error.to_string().contains("no password is available"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn undeclared_documents_stay_public_and_other_fields_survive() {
        let build = sealed(&declared("encrypt: true"), Some(GLOBAL)).expect("seals");

        assert_eq!(build.bundle.edges.len(), 0, "no links, no edges");
        assert_eq!(build.bundle.stats.documents, 1);
        assert!(
            !build.bundle.docs[0]
                .enc
                .as_ref()
                .expect("sealed")
                .salt
                .is_empty(),
            "the salt travels in the artifact"
        );
    }

    #[test]
    fn the_sealed_body_opens_to_the_canonical_json_shape() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [SourceDoc {
            id: "a.md".to_string(),
            path: dir.path().join("a.md"),
            title: "A".to_string(),
            text: "---\nencrypt: true\n---\n\n# A\n\n## Section\n\nbody text\n".to_string(),
        }];
        let mut build = build_site("Site", dir.path(), &docs);
        seal_bundle(&mut build, Some(GLOBAL)).expect("seals");

        let blob = build.bundle.docs[0].enc.as_ref().expect("sealed");
        let plain = open(
            SealedRef {
                salt: &STANDARD.decode(&blob.salt).expect("salt decodes"),
                nonce: &STANDARD.decode(&blob.nonce).expect("nonce decodes"),
                ct: &STANDARD.decode(&blob.ct).expect("ct decodes"),
            },
            GLOBAL,
            "a.md".as_bytes(),
        )
        .expect("the global password opens the body");
        let value: Json = serde_json::from_slice(&plain).expect("canonical JSON");

        assert_eq!(
            value
                .as_object()
                .map(|object| object.keys().map(String::as_str).collect::<Vec<_>>()),
            Some(vec!["blocks", "html", "text", "toc"]),
            "the plaintext is exactly the four body fields"
        );
        assert!(
            value["html"]
                .as_str()
                .expect("html")
                .contains("<h1 id=\"a\">A</h1>"),
            "html: {}",
            value["html"]
        );
        assert!(
            value["text"].as_str().expect("text").contains("body text"),
            "text: {}",
            value["text"]
        );
    }

    #[test]
    fn a_wrong_password_cannot_open_the_sealed_body() {
        let build = sealed(&declared("encrypt: true"), Some(GLOBAL)).expect("seals");
        let blob = build.bundle.docs[0].enc.as_ref().expect("sealed");

        let error = open(
            SealedRef {
                salt: &STANDARD.decode(&blob.salt).expect("salt decodes"),
                nonce: &STANDARD.decode(&blob.nonce).expect("nonce decodes"),
                ct: &STANDARD.decode(&blob.ct).expect("ct decodes"),
            },
            "wrong password",
            "a.md".as_bytes(),
        )
        .expect_err("the wrong password cannot open the body");

        assert_eq!(error, crate::crypto::OpenError::Authenticated);
    }

    #[test]
    fn two_seals_of_the_same_document_never_share_parameters() {
        let first = sealed(&declared("encrypt: true"), Some(GLOBAL))
            .expect("seals")
            .bundle
            .docs[0]
            .enc
            .clone()
            .expect("sealed");
        let second = sealed(&declared("encrypt: true"), Some(GLOBAL))
            .expect("seals")
            .bundle
            .docs[0]
            .enc
            .clone()
            .expect("sealed");

        assert_ne!(first.salt, second.salt, "the salt is fresh per build");
        assert_ne!(first.nonce, second.nonce, "the nonce is fresh per build");
        assert_ne!(first.ct, second.ct, "the ciphertext differs too");
    }

    #[test]
    fn the_artifact_never_carries_the_password_or_the_plaintext() {
        let build = sealed(&declared("encrypt: true"), Some(GLOBAL)).expect("seals");
        let json = build.bundle.to_json();

        assert!(
            !json.contains(GLOBAL),
            "the password never reaches the payload"
        );
        assert!(
            !json.contains("secret body"),
            "the plaintext never reaches the payload"
        );
        assert!(
            !json.contains("encrypt: true"),
            "the front matter never reaches the payload"
        );
    }
}
