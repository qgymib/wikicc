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
//! payload never carries the plaintext. Titles, authors and dates stay
//! public — metadata the reader shows anyway — while a description and the
//! declared tags go with the body: both speak about what the body says. The
//! link graph and the counters are untouched. A document that declares
//! encryption without any available password is a hard error naming the
//! document, whatever `--strict` says. The per-document computation runs in
//! parallel and its results apply in document order, so the reported failure
//! is the first failing document in document order.
//!
//! The asset boundary is sealed with the body. Before a document is
//! encrypted, its own asset placeholders — in `html` and in every chapter
//! block — are expanded into `data:` URIs built from the asset table's MIME
//! type and bytes, the construction the single-html writer inlines with, so
//! a decrypted article renders its images natively and nothing has to
//! resolve a placeholder outside the artifact. After all documents are
//! sealed, the asset table is pruned to what the public documents and the
//! favicon still address: an asset only sealed documents referenced travels
//! inside the ciphertext and is not written to the artifact, and `stats`
//! follows the table.

use std::collections::BTreeSet;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_yaml::Value;

use crate::assets::{ASSET_PLACEHOLDER_PREFIX, AssetTable};
use crate::crypto;
use crate::error::{Error, Result};
use crate::markdown::{sections::Block, toc::TocEntry};
use crate::site::{DocModel, EncryptedBlob, SiteBuild};
use crate::writers::single_html::write_data_uri;
use crate::writers::{expand_placeholders, placeholder_hashes};

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
/// public title; `edges` and the rest of the metadata are untouched. The
/// salt and the nonce are fresh random bytes of every call, so two builds of
/// the same site never produce the same sealed bytes.
///
/// The per-document computation — placeholder expansion, serialisation and
/// the key derivation — reads only shared state, so it runs in parallel; the
/// results are collected in document order and the apply pass writes them in
/// the same order. A failure therefore surfaces for the first failing
/// document in document order, exactly as a sequential pass would report it.
///
/// `favicon` is the placeholder the favicon registration returned. The
/// favicon is addressed by the rendered head rather than by any document, so
/// the prune below could not know to keep it otherwise.
///
/// Before a document is encrypted, its own asset placeholders — in `html`
/// and in every chapter block — are expanded into `data:` URIs built from
/// the asset table's MIME type and bytes, so the sealed body renders its
/// images natively once unlocked. After all documents are sealed, the asset
/// table is pruned to what the public documents and the favicon still
/// address, and `stats` follows.
pub fn seal_bundle(
    build: &mut SiteBuild,
    global_password: Option<&str>,
    favicon_placeholder: &str,
) -> Result<()> {
    use rayon::prelude::*;

    // The computation is read-only over the bundle: `docs`, `front_matters`
    // and the asset table are only borrowed. The heavy work — the PBKDF2 key
    // derivation per sealed document — lives here, so the wall-clock time of
    // many sealed documents scales with the threads.
    let sealed: Vec<Result<Option<EncryptedBlob>>> = build
        .bundle
        .docs
        .par_iter()
        .zip(&build.front_matters)
        .map(|(doc, front_matter)| {
            seal_one(doc, front_matter.as_deref(), &build.assets, global_password)
        })
        .collect();

    // The apply pass walks the collected results in document order, so the
    // first `Err` is the first failing document — the message a sequential
    // pass would have printed. A document that sealed clears its plaintext
    // body and carries the blob beside the public title. The description and
    // the tags go with it: both speak about what the body says, and the
    // public surface of a locked document is its id, its title, its author
    // and its date — never a word of what its body said.
    let mut sealed_ids: Vec<String> = Vec::new();
    for (doc, result) in build.bundle.docs.iter_mut().zip(sealed) {
        let Some(blob) = result? else {
            continue;
        };

        doc.html = String::new();
        doc.toc = Vec::new();
        doc.blocks = Vec::new();
        doc.text = String::new();
        doc.description = None;
        doc.tags = Vec::new();
        doc.enc = Some(blob);
        sealed_ids.push(doc.id.clone());
    }

    // A tag describes what a document is about, so the aggregation loses
    // every sealed document with it, and entries whose last document sealed
    // are dropped — the public surface of a locked document is its id, its
    // title, its author and its date, never a word of what its body said.
    if !sealed_ids.is_empty() {
        for entry in &mut build.bundle.tags {
            entry
                .docs
                .retain(|doc| !sealed_ids.iter().any(|id| id == doc));
        }
        build.bundle.tags.retain(|entry| !entry.docs.is_empty());
    }

    prune_assets(build, favicon_placeholder);

    Ok(())
}

/// The sealed blob of one document, computed without touching the bundle.
///
/// `None` when the front matter declares nothing. The expanded body — the
/// placeholders turned into data URIs — is a local value: it feeds the
/// canonical JSON and the ciphertext and is dropped, because a sealed
/// document's payload fields are emptied in the apply pass anyway.
fn seal_one(
    doc: &DocModel,
    front_matter: Option<&str>,
    assets: &AssetTable,
    global_password: Option<&str>,
) -> Result<Option<EncryptedBlob>> {
    let Some(raw) = front_matter else {
        return Ok(None);
    };
    let Some(directive) = parse_directive(raw, &doc.id)? else {
        return Ok(None);
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

    // The sealed body must render after an unlock, so its own asset
    // references travel inside the ciphertext as data URIs. An unknown
    // placeholder is the same internal contract break it is at write
    // time — a document cannot carry one, because the resolve stage
    // leaves the original text and a warning for an asset it could not
    // read — and aborts the build before anything is reported or written.
    let mut scratch: Vec<u8> = Vec::new();
    let (html, _) = expand_placeholders(&doc.html, assets, |asset, sink| {
        write_data_uri(asset, sink, &mut scratch)
    })?;
    let mut blocks = Vec::with_capacity(doc.blocks.len());
    for block in &doc.blocks {
        let (html, _) = expand_placeholders(&block.html, assets, |asset, sink| {
            write_data_uri(asset, sink, &mut scratch)
        })?;
        let mut block = block.clone();
        block.html = html;
        blocks.push(block);
    }

    let plain = serde_json::to_vec(&PlainBody {
        html: &html,
        toc: &doc.toc,
        blocks: &blocks,
        text: &doc.text,
    })
    .expect("a document body always serialises to JSON");
    let sealed = crypto::seal(&plain, password, doc.id.as_bytes());

    Ok(Some(EncryptedBlob {
        v: crypto::FORMAT_VERSION,
        kdf: crypto::KDF_NAME.to_string(),
        iters: crypto::KDF_ITERATIONS,
        salt: STANDARD.encode(sealed.salt),
        nonce: STANDARD.encode(sealed.nonce),
        ct: STANDARD.encode(&sealed.ct),
    }))
}

/// Drop every asset the artifact no longer addresses, after all sealing.
///
/// The sealed bodies carry their assets inside the ciphertext, so the
/// artifact needs exactly the assets the public documents' `html` and
/// chapter blocks still address, plus the favicon entry the rendered head
/// carries. The counters are decremented per dropped entry — the way the
/// favicon registration incremented them per added one — so they keep
/// describing the assets the artifact actually carries.
fn prune_assets(build: &mut SiteBuild, favicon_placeholder: &str) {
    let favicon_hash = favicon_placeholder
        .strip_prefix(ASSET_PLACEHOLDER_PREFIX)
        .unwrap_or(favicon_placeholder);
    let mut keep: BTreeSet<&str> = BTreeSet::new();
    keep.insert(favicon_hash);

    for doc in build.bundle.docs.iter().filter(|doc| doc.enc.is_none()) {
        keep.extend(placeholder_hashes(&doc.html));
        for block in &doc.blocks {
            keep.extend(placeholder_hashes(&block.html));
        }
    }

    let (assets_before, bytes_before) = (build.assets.len(), build.assets.total_bytes());
    build.assets.retain(|hash| keep.contains(hash));
    build.bundle.stats.assets -= assets_before - build.assets.len();
    build.bundle.stats.asset_bytes -= bytes_before - build.assets.total_bytes();
}

#[cfg(test)]
mod tests {
    use serde_json::Value as Json;

    use crate::assets::asset_hash;
    use crate::crypto::{SealedRef, open};
    use crate::scan::{DocMeta, SourceDoc};
    use crate::site::build_site;

    use super::*;

    const GLOBAL: &str = "global secret";

    /// Image shared between a public and a sealed document.
    const X_MARK: &[u8] = b"<svg>shared image</svg>";

    /// Image referenced only by a sealed document.
    const Y_MARK: &[u8] = b"<svg>sealed-only image</svg>";

    /// Build a one-document site whose source carries `front` as the front
    /// matter and seal it with `global`.
    ///
    /// The favicon is registered first, the way the pipeline does, so the
    /// prune below sees the same shape a real build hands over.
    fn sealed(text: &str, global: Option<&str>) -> Result<crate::site::SiteBuild> {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [SourceDoc {
            id: "a.md".to_string(),
            path: dir.path().join("a.md"),
            title: "A".to_string(),
            metadata: DocMeta::default(),
            text: text.to_string(),
        }];
        let mut build = build_site("Site", dir.path(), &docs);
        let favicon = build.register_favicon("logo.svg", b"<svg/>");
        seal_bundle(&mut build, global, &favicon)?;
        Ok(build)
    }

    /// The front matter text of a document that declares `directive`.
    fn declared(directive: &str) -> String {
        format!("---\n{directive}\n---\n\n# A\n\nsecret body\n")
    }

    /// A site whose documents carry the given front-matter texts, sealed
    /// with `global`. The ids are zero-padded, so document order is
    /// lexicographic order.
    fn sealed_site(matters: &[&str], global: Option<&str>) -> Result<crate::site::SiteBuild> {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs: Vec<SourceDoc> = matters
            .iter()
            .enumerate()
            .map(|(index, matter)| SourceDoc {
                text: format!("---\n{matter}\n---\n\n# Doc {index}\n\nsecret {index}\n"),
                id: format!("{index:02}.md"),
                path: dir.path().join(format!("{index:02}.md")),
                title: format!("Doc {index}"),
                metadata: DocMeta::default(),
            })
            .collect();
        let mut build = build_site("Site", dir.path(), &docs);
        let favicon = build.register_favicon("logo.svg", b"<svg/>");
        seal_bundle(&mut build, global, &favicon)?;
        Ok(build)
    }

    /// Open the canonical JSON of a blob with `password`.
    fn opened_json(blob: &EncryptedBlob, password: &str, id: &str) -> Json {
        let plain = open(
            SealedRef {
                salt: &STANDARD.decode(&blob.salt).expect("salt decodes"),
                nonce: &STANDARD.decode(&blob.nonce).expect("nonce decodes"),
                ct: &STANDARD.decode(&blob.ct).expect("ct decodes"),
            },
            password,
            id.as_bytes(),
        )
        .expect("the password opens the body");

        serde_json::from_slice(&plain).expect("canonical JSON")
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
    fn a_sealed_document_loses_its_tags_but_a_public_one_keeps_them() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [
            SourceDoc {
                id: "00.md".to_string(),
                path: dir.path().join("00.md"),
                title: "Locked".to_string(),
                metadata: DocMeta {
                    description: Some("A secret summary".to_string()),
                    author: Some("Alice".to_string()),
                    date: Some("2026-01-02".to_string()),
                    tags: vec!["private".to_string(), "shared".to_string()],
                },
                text: "---\nencrypt: true\n---\n\n# Locked\n\nsecret body\n".to_string(),
            },
            SourceDoc {
                id: "01.md".to_string(),
                path: dir.path().join("01.md"),
                title: "Public".to_string(),
                metadata: DocMeta {
                    tags: vec!["shared".to_string()],
                    ..DocMeta::default()
                },
                text: "# Public\n\nopen body\n".to_string(),
            },
        ];
        let mut build = build_site("Site", dir.path(), &docs);
        let favicon = build.register_favicon("logo.svg", b"<svg/>");
        seal_bundle(&mut build, Some(GLOBAL), &favicon).expect("seals");

        assert!(
            build.bundle.docs[0].enc.is_some(),
            "the first document is sealed"
        );
        assert_eq!(
            build.bundle.tags,
            vec![crate::site::TagEntry {
                tag: "shared".to_string(),
                docs: vec!["01.md".to_string()],
            }],
            "a tag describes what a document is about: the locked one is stripped"
        );
        assert_eq!(
            build.bundle.docs[0].tags,
            Vec::<String>::new(),
            "the sealed document carries no tags of its own"
        );
        assert_eq!(
            build.bundle.docs[0].description, None,
            "a description speaks about the body: it is sealed with it"
        );
        assert_eq!(
            build.bundle.docs[0].author.as_deref(),
            Some("Alice"),
            "the author stays public"
        );
        assert_eq!(
            build.bundle.docs[0].date.as_deref(),
            Some("2026-01-02"),
            "the date stays public"
        );
        assert_eq!(
            build.bundle.docs[1].tags,
            vec!["shared".to_string()],
            "the public document keeps its tags"
        );
    }

    #[test]
    fn the_sealed_body_opens_to_the_canonical_json_shape() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [SourceDoc {
            id: "a.md".to_string(),
            path: dir.path().join("a.md"),
            title: "A".to_string(),
            metadata: DocMeta::default(),
            text: "---\nencrypt: true\n---\n\n# A\n\n## Section\n\nbody text\n".to_string(),
        }];
        let mut build = build_site("Site", dir.path(), &docs);
        let favicon = build.register_favicon("logo.svg", b"<svg/>");
        seal_bundle(&mut build, Some(GLOBAL), &favicon).expect("seals");

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
    fn several_documents_seal_and_every_one_opens_with_its_own_password() {
        let build = sealed_site(
            &["encrypt: true", "encrypt: \"doc1pw\"", "title: public"],
            Some(GLOBAL),
        )
        .expect("seals");

        let plain0 = opened_json(
            build.bundle.docs[0].enc.as_ref().expect("doc 0 seals"),
            GLOBAL,
            "00.md",
        );
        assert!(
            plain0["text"].as_str().expect("text").contains("secret 0"),
            "doc 0 sealed its own body: {}",
            plain0["text"]
        );

        let plain1 = opened_json(
            build.bundle.docs[1].enc.as_ref().expect("doc 1 seals"),
            "doc1pw",
            "01.md",
        );
        assert!(
            plain1["text"].as_str().expect("text").contains("secret 1"),
            "doc 1 sealed its own body: {}",
            plain1["text"]
        );

        assert!(
            build.bundle.docs[2].enc.is_none(),
            "the public document stays public"
        );
        assert_eq!(build.bundle.docs[2].text, "Doc 2 secret 2");
        assert_eq!(build.bundle.stats.documents, 3);
    }

    #[test]
    fn a_missing_password_reports_the_first_failing_document_in_order() {
        // Doc 0 seals with its own password; doc 1 needs the global one,
        // which is absent; doc 2 has its own too. The first failure in
        // document order is doc 1 — never doc 2, whatever the threads.
        let error = sealed_site(
            &["encrypt: \"own0\"", "encrypt: true", "encrypt: \"own2\""],
            None,
        )
        .expect_err("doc 1 has no password");

        assert!(
            error.to_string().contains("document '01.md'"),
            "the first failing document is named: {error}"
        );
    }

    #[test]
    fn a_single_thread_pool_seals_and_opens_like_the_default_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs: Vec<SourceDoc> = (0..4)
            .map(|index| SourceDoc {
                id: format!("{index:02}.md"),
                path: dir.path().join(format!("{index:02}.md")),
                title: format!("Doc {index}"),
                metadata: DocMeta::default(),
                text: format!("---\nencrypt: true\n---\n\n# Doc {index}\n\nsecret {index}\n"),
            })
            .collect();
        let mut build = build_site("Site", dir.path(), &docs);
        let favicon = build.register_favicon("logo.svg", b"<svg/>");

        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .expect("the pool builds");
        pool.install(|| seal_bundle(&mut build, Some(GLOBAL), &favicon))
            .expect("seals");

        assert_eq!(build.bundle.stats.documents, 4);
        for (index, doc) in build.bundle.docs.iter().enumerate() {
            let plain = opened_json(
                doc.enc.as_ref().expect("sealed"),
                GLOBAL,
                &format!("{index:02}.md"),
            );
            assert!(
                plain["text"]
                    .as_str()
                    .expect("text")
                    .contains(&format!("secret {index}")),
                "document {index} sealed its own body"
            );
        }
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

    // The sealed asset boundary.

    /// Open the sealed body of `id` with the global password and parse the
    /// canonical JSON.
    fn opened(build: &crate::site::SiteBuild, id: &str) -> Json {
        let doc = build.bundle.doc(id).expect("the document is in the bundle");
        let blob = doc.enc.as_ref().expect("the document is sealed");
        let plain = open(
            SealedRef {
                salt: &STANDARD.decode(&blob.salt).expect("salt decodes"),
                nonce: &STANDARD.decode(&blob.nonce).expect("nonce decodes"),
                ct: &STANDARD.decode(&blob.ct).expect("ct decodes"),
            },
            GLOBAL,
            id.as_bytes(),
        )
        .expect("the global password opens the body");

        serde_json::from_slice(&plain).expect("canonical JSON")
    }

    /// A site with the asset-boundary shape: `public.md` shows image X,
    /// `shared.md` (sealed) shows the same X, and `private.md` (sealed)
    /// shows image Y that nothing public references. Sealed with the global
    /// password; returns the build, X's and Y's hashes and the favicon
    /// placeholder.
    fn asset_site() -> (crate::site::SiteBuild, String, String, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        let images = dir.path().join("img");
        std::fs::create_dir(&images).expect("create image directory");
        std::fs::write(images.join("x.svg"), X_MARK).expect("write X");
        std::fs::write(images.join("y.svg"), Y_MARK).expect("write Y");

        let docs = [
            SourceDoc {
                id: "public.md".to_string(),
                path: dir.path().join("public.md"),
                title: "Public".to_string(),
                metadata: DocMeta::default(),
                text: "# Public\n\n![x](img/x.svg)\n".to_string(),
            },
            SourceDoc {
                id: "shared.md".to_string(),
                path: dir.path().join("shared.md"),
                title: "Shared".to_string(),
                metadata: DocMeta::default(),
                text: "---\nencrypt: true\n---\n\n# Shared\n\n## Part\n\n![x](img/x.svg)\n"
                    .to_string(),
            },
            SourceDoc {
                id: "private.md".to_string(),
                path: dir.path().join("private.md"),
                title: "Private".to_string(),
                metadata: DocMeta::default(),
                text: "---\nencrypt: true\n---\n\n# Private\n\n## Part\n\n![y](img/y.svg)\n"
                    .to_string(),
            },
        ];
        let mut build = build_site("Site", dir.path(), &docs);
        let favicon = build.register_favicon("logo.svg", b"<svg/>");
        seal_bundle(&mut build, Some(GLOBAL), &favicon).expect("seals");

        (build, asset_hash(X_MARK), asset_hash(Y_MARK), favicon)
    }

    #[test]
    fn a_sealed_body_carries_its_assets_as_data_uris() {
        let (build, _, _, _) = asset_site();
        let x_uri = STANDARD.encode(X_MARK);
        let y_uri = STANDARD.encode(Y_MARK);

        let shared = opened(&build, "shared.md");
        let html = shared["html"].as_str().expect("html");
        assert!(
            html.contains(&format!("data:image/svg+xml;base64,{x_uri}")),
            "the image travels as a data URI: {html}"
        );
        assert!(
            !html.contains("wikicc-asset:"),
            "no placeholder survives the seal: {html}"
        );
        // The chapter block that shows the image carries the same URI, so a
        // block reference previews it too.
        let block = shared["blocks"][1]["html"].as_str().expect("block html");
        assert!(
            block.contains(&format!("data:image/svg+xml;base64,{x_uri}")),
            "the block travels with its image: {block}"
        );
        assert!(!block.contains("wikicc-asset:"));

        let private = opened(&build, "private.md");
        let html = private["html"].as_str().expect("html");
        assert!(
            html.contains(&format!("data:image/svg+xml;base64,{y_uri}")),
            "the sealed-only image travels too: {html}"
        );
        assert!(!html.contains("wikicc-asset:"));
        assert!(
            !html.contains(&format!("data:image/svg+xml;base64,{x_uri}")),
            "no other document's asset leaks into the body"
        );
    }

    #[test]
    fn a_sealed_only_asset_is_pruned_and_the_stats_follow() {
        let (build, x, y, favicon) = asset_site();
        let favicon_hash = favicon
            .strip_prefix(crate::ASSET_PLACEHOLDER_PREFIX)
            .expect("a favicon placeholder");

        assert_eq!(build.assets.len(), 2, "X and the favicon survive");
        assert!(
            build.assets.get(&x).is_some(),
            "the shared asset survives for its public reference"
        );
        assert!(
            build.assets.get(&y).is_none(),
            "the sealed-only asset is pruned"
        );
        assert!(
            build.assets.get(favicon_hash).is_some(),
            "the favicon entry survives the prune"
        );
        assert_eq!(build.bundle.stats.assets, 2);
        assert_eq!(build.bundle.stats.asset_bytes, build.assets.total_bytes());
        assert_eq!(build.assets.len(), build.bundle.stats.assets);

        // The public document still addresses X by placeholder for the
        // writers to expand.
        let public = &build.bundle.doc("public.md").expect("public document").html;
        assert!(
            public.contains(&format!("wikicc-asset:{x}")),
            "the public document keeps its placeholder: {public}"
        );

        // Y reaches the payload only as ciphertext bytes.
        let json = build.bundle.to_json();
        assert!(
            !json.contains(std::str::from_utf8(Y_MARK).expect("utf-8")),
            "the sealed-only image never appears in the clear"
        );
    }

    #[test]
    fn an_unsealed_site_prunes_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let images = dir.path().join("img");
        std::fs::create_dir(&images).expect("create image directory");
        std::fs::write(images.join("x.svg"), X_MARK).expect("write X");
        let docs = [SourceDoc {
            id: "public.md".to_string(),
            path: dir.path().join("public.md"),
            title: "Public".to_string(),
            metadata: DocMeta::default(),
            text: "# Public\n\n![x](img/x.svg)\n".to_string(),
        }];
        let mut build = build_site("Site", dir.path(), &docs);
        let favicon = build.register_favicon("logo.svg", b"<svg/>");
        let stats = build.bundle.stats;
        let assets = build.assets.clone();

        seal_bundle(&mut build, Some(GLOBAL), &favicon).expect("no sealed document");

        assert_eq!(
            build.bundle.stats, stats,
            "no sealed document, no counter moves"
        );
        assert_eq!(
            build.assets, assets,
            "no sealed document, no asset is dropped"
        );
        assert!(
            build
                .bundle
                .doc("public.md")
                .expect("public document")
                .html
                .contains(&format!("wikicc-asset:{}", asset_hash(X_MARK))),
            "the placeholder stays for the writers to expand"
        );
    }
}
