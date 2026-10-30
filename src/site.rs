//! Site bundle assembly: the deterministic payload the front end consumes.
//!
//! This is the `assemble` stage described in `docs/DESIGN.md`. It folds the outputs of the
//! previous stages into one serialisable [`SiteBundle`]:
//!
//! - [`DocModel`] per document: id, title, rewritten HTML, chapter outline and
//!   the plain text used by the search index;
//! - [`Edge`] per resolved internal link, deduplicated, self-loops dropped and
//!   sorted by `(from, to)`;
//! - [`Stats`]: how many documents and unique assets the site has, and how many
//!   bytes the assets occupy.
//!
//! Determinism is a hard requirement (two builds of the same input must be
//! byte-identical), so documents keep scan order, edges live in a
//! [`BTreeSet`] while they are collected, every collection is a `Vec` or a
//! `BTreeMap` underneath, and nothing in the payload depends on the clock, the
//! host locale or the file system order.
//!
//! The bundle never carries asset bytes: the HTML references each resource by
//! the opaque placeholder [`crate::ASSET_PLACEHOLDER_PREFIX`]`<hash>`, and the
//! writers turn that into a `data:` URI, an `assets/…` path or a `cid:`
//! reference. [`SiteBuild`] therefore returns the [`AssetTable`] alongside the
//! payload.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::assets::AssetTable;
use crate::markdown::toc::TocEntry;
use crate::markdown::{LinkContext, render_document_with};
use crate::scan::{Diagnostic, Severity, SourceDoc};

/// One document as the front end sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocModel {
    /// Relative path with `/` separators, e.g. `guide/intro.md`.
    pub id: String,
    /// Addressable path of the document.
    ///
    /// Identical to [`DocModel::id`] today; kept as a separate field so a
    /// future slug-based identifier can differ from the source path without
    /// breaking the payload shape.
    pub path: String,
    /// First level-one heading, else the file stem.
    pub title: String,
    /// Rendered body HTML, with links rewritten to hash routes and assets
    /// addressed by their opaque placeholder.
    pub html: String,
    /// Chapter outline in document order, nested by heading level.
    pub toc: Vec<TocEntry>,
    /// Plain text of the document, for the search index.
    pub text: String,
}

/// Directed link from one document to another.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Edge {
    /// Document id the link starts at.
    pub from: String,
    /// Document id the link points at.
    pub to: String,
}

/// Site-wide counters shown in the reader and in the build summary.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stats {
    /// Number of compiled documents.
    pub documents: usize,
    /// Number of unique assets, deduplicated by content hash.
    pub assets: usize,
    /// Total size of those assets, in bytes.
    pub asset_bytes: u64,
}

/// Everything the front end needs, in one serialisable value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteBundle {
    /// Site title from `--title`.
    pub title: String,
    /// Documents in scan order, i.e. sorted by id in byte order.
    pub docs: Vec<DocModel>,
    /// Link graph, sorted by `(from, to)`.
    pub edges: Vec<Edge>,
    /// Document and asset counters.
    pub stats: Stats,
}

impl SiteBundle {
    /// Compact JSON, which is what the product embeds.
    ///
    /// Serialisation cannot fail: the payload is built from strings, numbers
    /// and sequences, with no map that could hold a non-string key and no
    /// float that could be `NaN`.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a site bundle always serialises to JSON")
    }

    /// Indented JSON, for tests and manual inspection.
    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(self).expect("a site bundle always serialises to JSON")
    }

    /// Document with the given id.
    pub fn doc(&self, id: &str) -> Option<&DocModel> {
        self.docs.iter().find(|doc| doc.id == id)
    }
}

/// Result of the assemble stage: the payload plus what the writers need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteBuild {
    /// Payload embedded into the shell.
    pub bundle: SiteBundle,
    /// Assets referenced by the documents, deduplicated by content.
    pub assets: AssetTable,
    /// Link and asset problems found while resolving, in document order.
    pub diagnostics: Vec<Diagnostic>,
}

impl SiteBuild {
    /// Number of diagnostics that `--strict` treats as errors.
    pub fn warning_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Warning)
            .count()
    }
}

/// Turn resolved `(from, to)` pairs into the payload's edge list.
///
/// Self-loops are dropped (a document pointing at its own anchor is not an
/// edge of the graph), duplicates collapse, and the result is sorted by
/// `(from, to)` because the pairs are collected into a [`BTreeSet`].
///
/// Only successfully resolved links reach this function: a target that does
/// not exist inside the site never becomes an edge.
pub fn build_edges(links: &[(String, String)]) -> Vec<Edge> {
    links
        .iter()
        .filter(|(from, to)| from != to)
        .map(|(from, to)| Edge {
            from: from.clone(),
            to: to.clone(),
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Run the parse and resolve stages over `docs` and assemble the payload.
///
/// `root` is the input directory every relative asset path is resolved
/// against. Never fails: rendering cannot fail and unreadable assets or
/// unresolvable links degrade to diagnostics, so a broken link never aborts a
/// build (it only fails one that was run with `--strict`).
///
/// Documents are visited in the order they are given, which is scan order, so
/// the payload lists them exactly once and always in the same order.
pub fn build_site(title: &str, root: &Path, docs: &[SourceDoc]) -> SiteBuild {
    let mut context = LinkContext::new(root.to_path_buf(), docs.iter().map(|doc| doc.id.clone()));
    let mut models: Vec<DocModel> = Vec::with_capacity(docs.len());
    let mut links: Vec<(String, String)> = Vec::new();

    for doc in docs {
        let mut resolver = context.for_doc(&doc.id);
        let rendered = render_document_with(&doc.text, &mut resolver);
        let targets = resolver.take_targets();
        drop(resolver);

        links.extend(targets.into_iter().map(|target| (doc.id.clone(), target)));

        models.push(DocModel {
            id: doc.id.clone(),
            path: doc.id.clone(),
            title: doc.title.clone(),
            html: rendered.html,
            toc: rendered.toc,
            text: rendered.text,
        });
    }

    let edges = build_edges(&links);
    let (assets, diagnostics) = context.into_parts();
    let stats = Stats {
        documents: models.len(),
        assets: assets.len(),
        asset_bytes: assets.total_bytes(),
    };

    SiteBuild {
        bundle: SiteBundle {
            title: title.to_string(),
            docs: models,
            edges,
            stats,
        },
        assets,
        diagnostics,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn source(id: &str, title: &str, text: &str) -> SourceDoc {
        SourceDoc {
            id: id.to_string(),
            path: PathBuf::from(id),
            title: title.to_string(),
            text: text.to_string(),
        }
    }

    fn write(root: &Path, relative: &str, contents: impl AsRef<[u8]>) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, contents).expect("write fixture file");
    }

    fn pairs(links: &[(&str, &str)]) -> Vec<(String, String)> {
        links
            .iter()
            .map(|(from, to)| ((*from).to_string(), (*to).to_string()))
            .collect()
    }

    #[test]
    fn edges_are_deduplicated_sorted_and_free_of_self_loops() {
        let links = pairs(&[
            ("b.md", "c.md"),
            ("a.md", "c.md"),
            ("a.md", "c.md"),
            ("a.md", "a.md"),
            ("b.md", "a.md"),
        ]);

        assert_eq!(
            build_edges(&links),
            [
                Edge {
                    from: "a.md".to_string(),
                    to: "c.md".to_string()
                },
                Edge {
                    from: "b.md".to_string(),
                    to: "a.md".to_string()
                },
                Edge {
                    from: "b.md".to_string(),
                    to: "c.md".to_string()
                },
            ]
        );
    }

    #[test]
    fn no_links_means_no_edges() {
        assert!(build_edges(&[]).is_empty());
        assert!(build_edges(&pairs(&[("a.md", "a.md")])).is_empty());
    }

    #[test]
    fn documents_keep_scan_order_and_their_rendered_parts() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [
            source("a.md", "A", "# A\n\n[to b](b.md)\n"),
            source("b.md", "B", "# B\n\n## Section\n\nbody text\n"),
        ];

        let build = build_site("Site", dir.path(), &docs);

        assert_eq!(build.bundle.title, "Site");
        assert_eq!(
            build
                .bundle
                .docs
                .iter()
                .map(|doc| doc.id.as_str())
                .collect::<Vec<_>>(),
            ["a.md", "b.md"]
        );
        assert_eq!(build.bundle.docs[0].path, "a.md");
        assert_eq!(build.bundle.docs[0].title, "A");
        assert!(build.bundle.docs[0].html.contains("href=\"#/doc/b.md\""));
        assert_eq!(build.bundle.docs[1].toc[0].children[0].text, "Section");
        assert_eq!(build.bundle.docs[1].text, "B Section body text");
    }

    #[test]
    fn resolved_links_become_edges_and_unknown_ones_do_not() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [
            source(
                "a.md",
                "A",
                "[b](b.md) [b again](b.md) [missing](missing.md)\n",
            ),
            source("b.md", "B", "[a](a.md)\n"),
        ];

        let build = build_site("Site", dir.path(), &docs);

        assert_eq!(
            build.bundle.edges,
            [
                Edge {
                    from: "a.md".to_string(),
                    to: "b.md".to_string()
                },
                Edge {
                    from: "b.md".to_string(),
                    to: "a.md".to_string()
                },
            ]
        );
        assert_eq!(build.warning_count(), 1);
        assert!(
            build.diagnostics[0].message.contains("missing.md"),
            "diagnostics: {:?}",
            build.diagnostics
        );
    }

    #[test]
    fn anchors_and_self_links_never_produce_edges() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [source("a.md", "A", "# A\n\n[self](#a) [local](a.md#a)\n")];

        let build = build_site("Site", dir.path(), &docs);

        assert!(build.bundle.edges.is_empty());
        assert!(build.diagnostics.is_empty());
    }

    #[test]
    fn stats_count_documents_and_unique_assets() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "img/logo.svg", b"<svg>logo</svg>");
        write(dir.path(), "img/copy.svg", b"<svg>logo</svg>");
        let docs = [
            source("a.md", "A", "![one](img/logo.svg)\n"),
            source("b.md", "B", "![two](img/copy.svg)\n"),
        ];

        let build = build_site("Site", dir.path(), &docs);

        assert_eq!(
            build.bundle.stats,
            Stats {
                documents: 2,
                assets: 1,
                asset_bytes: 15,
            }
        );
        assert_eq!(build.assets.total_bytes(), build.bundle.stats.asset_bytes);
        assert_eq!(build.assets.len(), build.bundle.stats.assets);
    }

    #[test]
    fn an_empty_site_serialises_with_empty_arrays() {
        let dir = tempfile::tempdir().expect("temp dir");

        let build = build_site("Empty", dir.path(), &[]);

        assert_eq!(build.bundle.docs.len(), 0);
        assert_eq!(build.bundle.edges.len(), 0);
        assert_eq!(build.bundle.stats, Stats::default());
        assert_eq!(
            build.bundle.to_json(),
            r#"{"title":"Empty","docs":[],"edges":[],"stats":{"documents":0,"assets":0,"asset_bytes":0}}"#
        );
    }

    #[test]
    fn serialising_the_same_bundle_twice_is_byte_identical() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [
            source("a.md", "A", "# A\n\n[to b](b.md)\n"),
            source("b.md", "B", "# B\n"),
        ];

        let build = build_site("Site", dir.path(), &docs);

        assert_eq!(build.bundle.to_json(), build.bundle.to_json());
        assert_eq!(build.bundle.to_json_pretty(), build.bundle.to_json_pretty());
        assert_ne!(build.bundle.to_json(), build.bundle.to_json_pretty());
    }

    #[test]
    fn two_builds_of_the_same_sources_are_byte_identical() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "img/logo.svg", b"<svg/>");
        let docs = [
            source("a.md", "A", "[b](b.md) ![logo](img/logo.svg)\n"),
            source("b.md", "B", "[a](a.md)\n"),
        ];

        let first = build_site("Site", dir.path(), &docs);
        let second = build_site("Site", dir.path(), &docs);

        assert_eq!(first.bundle.to_json(), second.bundle.to_json());
        assert_eq!(first.assets, second.assets);
        assert_eq!(first.diagnostics, second.diagnostics);
    }

    #[test]
    fn the_payload_keeps_unicode_and_finds_documents_by_id() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [source("中文/说明.md", "说明", "# 说明\n\n正文\n")];

        let build = build_site("站点", dir.path(), &docs);
        let json = build.bundle.to_json();

        assert!(json.contains("中文/说明.md"), "json: {json}");
        assert!(json.contains("正文"), "json: {json}");
        assert_eq!(
            build
                .bundle
                .doc("中文/说明.md")
                .map(|doc| doc.title.as_str()),
            Some("说明")
        );
        assert!(build.bundle.doc("missing.md").is_none());
    }

    #[test]
    fn json_carries_the_documented_keys() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docs = [source("a.md", "A", "# A\n")];

        let build = build_site("Site", dir.path(), &docs);
        let value: serde_json::Value =
            serde_json::from_str(&build.bundle.to_json()).expect("valid JSON");

        // `serde_json::Map` is a `BTreeMap`, so keys come back sorted rather
        // than in declaration order.
        assert_eq!(
            value.as_object().map(|object| keys(object)),
            Some(vec!["docs", "edges", "stats", "title"])
        );
        assert_eq!(
            value["docs"][0].as_object().map(keys),
            Some(vec!["html", "id", "path", "text", "title", "toc"])
        );
        assert_eq!(
            value["stats"].as_object().map(keys),
            Some(vec!["asset_bytes", "assets", "documents"])
        );
    }

    /// Object keys as owned `&str`s, in the order the map iterates them.
    fn keys(object: &serde_json::Map<String, serde_json::Value>) -> Vec<&str> {
        object.keys().map(String::as_str).collect()
    }
}
