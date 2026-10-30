//! Deterministic discovery of the Markdown documents that make up a site.
//!
//! This is the first pipeline stage described in `docs/DESIGN.md`: it turns a
//! directory tree into an ordered [`Vec<SourceDoc>`] plus a deterministic list
//! of [`Diagnostic`]s. It performs no Markdown rendering and writes nothing, so
//! the later stages can be tested against plain data.
//!
//! Ordering rules that make builds reproducible:
//!
//! - the walk is sorted by file name ([`walkdir::WalkDir::sort_by_file_name`]),
//!   so traversal-time diagnostics are stable;
//! - documents are finally sorted by [`SourceDoc::id`] in byte order;
//! - aggregated diagnostics are appended in a fixed order.

use std::fmt;
use std::path::{Component, Path, PathBuf};

use pulldown_cmark::{Event, HeadingLevel, Options as MarkdownOptions, Parser, Tag, TagEnd};
use walkdir::{DirEntry, WalkDir};

use crate::error::{Error, Result};
use crate::options::{normalize, path_components};

/// Recognised Markdown extensions, compared case-insensitively.
pub const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];

/// Directory names that are never scanned, on top of every dot-directory.
pub const SKIPPED_DIR_NAMES: [&str; 2] = [".git", "node_modules"];

/// Title used when a document has neither a heading nor a usable file stem.
pub const FALLBACK_DOC_TITLE: &str = "Untitled";

/// Diagnostic emitted when the input folder holds no Markdown document.
pub const NO_MARKDOWN_MESSAGE: &str = "no markdown files found";

/// How much a [`Diagnostic`] matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    /// Informational: the build never fails because of it.
    Note,
    /// A real problem: `--strict` upgrades it to a non-zero exit.
    Warning,
}

impl Severity {
    /// Lowercase spelling used in the `note:` / `warning:` prefixes.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Warning => "warning",
        }
    }
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One message produced while scanning, rendered as `<severity>: <message>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    /// Whether this message can fail a `--strict` build.
    pub severity: Severity,
    /// English, single-line, path-qualified description.
    pub message: String,
}

impl Diagnostic {
    /// Informational message.
    pub fn note(message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Note,
            message: message.into(),
        }
    }

    /// Message that `--strict` turns into an error.
    pub fn warning(message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Warning,
            message: message.into(),
        }
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.severity, self.message)
    }
}

/// One Markdown document discovered on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceDoc {
    /// Relative path with `/` separators, e.g. `guide/intro.md`.
    pub id: String,
    /// Path as discovered, i.e. rooted at the input directory.
    pub path: PathBuf,
    /// First level-one heading text, else the file stem, else `Untitled`.
    pub title: String,
    /// Raw Markdown source.
    pub text: String,
}

/// Result of one scan: the documents plus everything worth reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanReport {
    /// Documents sorted by [`SourceDoc::id`] in byte order.
    pub docs: Vec<SourceDoc>,
    /// Messages in deterministic order.
    pub diagnostics: Vec<Diagnostic>,
    /// Number of non-Markdown files that were skipped.
    pub ignored_files: usize,
}

impl ScanReport {
    /// Whether any diagnostic is a [`Severity::Warning`].
    pub fn has_warnings(&self) -> bool {
        self.warning_count() > 0
    }

    /// Number of diagnostics that `--strict` treats as errors.
    pub fn warning_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Warning)
            .count()
    }
}

/// Discover every Markdown document below `input`, excluding `out`.
///
/// `out` may be nested inside `input`; it is compared lexically (the output
/// directory usually does not exist yet) and case-insensitively on Windows.
///
/// Unreadable entries and non-UTF-8 files become warnings so a single bad file
/// cannot abort the build. Only a failure to read the input root itself is a
/// hard [`Error`].
pub fn scan(input: &Path, out: &Path) -> Result<ScanReport> {
    let out = normalize(out);
    let mut docs: Vec<SourceDoc> = Vec::new();
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut ignored_files = 0usize;
    let mut skipped_links = 0usize;

    let walker = WalkDir::new(input)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| keep_entry(entry, &out));

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                let message = entry_error_message(&error, input);
                if error.depth() == 0 {
                    return Err(Error::InvalidInput(message));
                }
                diagnostics.push(Diagnostic::warning(message));
                continue;
            }
        };

        if entry.file_type().is_symlink() {
            skipped_links += 1;
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if !is_markdown_path(entry.path()) {
            ignored_files += 1;
            continue;
        }

        let Some(id) = document_id(input, entry.path()) else {
            diagnostics.push(Diagnostic::warning(format!(
                "skipped '{}': path is not inside the input directory",
                entry.path().display()
            )));
            continue;
        };

        let bytes = match std::fs::read(entry.path()) {
            Ok(bytes) => bytes,
            Err(error) => {
                diagnostics.push(Diagnostic::warning(format!("cannot read '{id}': {error}")));
                continue;
            }
        };
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                diagnostics.push(Diagnostic::warning(format!(
                    "skipped '{id}': not valid UTF-8"
                )));
                continue;
            }
        };

        let title = extract_title(&text, entry.path());
        docs.push(SourceDoc {
            id,
            path: entry.path().to_path_buf(),
            title,
            text,
        });
    }

    docs.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));

    // Aggregated diagnostics always land in this order, after traversal ones.
    if skipped_links > 0 {
        diagnostics.push(Diagnostic::note(format!(
            "skipped {} (not followed)",
            count_phrase(skipped_links, "symbolic link", "symbolic links")
        )));
    }
    if ignored_files > 0 {
        diagnostics.push(Diagnostic::note(format!(
            "ignored {}",
            count_phrase(ignored_files, "non-markdown file", "non-markdown files")
        )));
    }
    if docs.is_empty() {
        diagnostics.push(Diagnostic::warning(NO_MARKDOWN_MESSAGE.to_string()));
    }

    Ok(ScanReport {
        docs,
        diagnostics,
        ignored_files,
    })
}

/// Whether `path` carries a Markdown extension, ignoring ASCII case.
pub fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
}

/// Document id: the path relative to `root`, `/`-separated, without `./`.
///
/// Returns `None` when `path` is not below `root` or contains a component that
/// cannot be represented (parent segments, a different prefix).
pub fn document_id(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut id = String::new();

    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => {
                if !id.is_empty() {
                    id.push('/');
                }
                id.push_str(&name.to_string_lossy());
            }
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => return None,
        }
    }

    if id.is_empty() { None } else { Some(id) }
}

/// Document title: first level-one heading text, else the file stem, else
/// [`FALLBACK_DOC_TITLE`].
///
/// The heading text is collected from the event stream, so inline markup
/// (`**bold**`, `` `code` ``, links) is stripped for free and a `#` inside a
/// fenced code block is never mistaken for a heading.
pub fn extract_title(text: &str, path: &Path) -> String {
    first_h1_text(text).unwrap_or_else(|| fallback_title(path))
}

/// Inline extensions that change how heading text is tokenised.
///
/// The renderer uses the full GFM set; scanning only needs the inline ones,
/// because block extensions cannot appear inside a heading.
const TITLE_OPTIONS: MarkdownOptions = MarkdownOptions::ENABLE_STRIKETHROUGH;

/// Text of the first level-one heading, collapsed to single spaces.
fn first_h1_text(text: &str) -> Option<String> {
    let mut inside = false;
    let mut title = String::new();

    for event in Parser::new_ext(text, TITLE_OPTIONS) {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) => inside = true,
            Event::End(TagEnd::Heading(_)) => {
                if inside {
                    break;
                }
            }
            Event::Text(value) | Event::Code(value) if inside => title.push_str(&value),
            Event::SoftBreak | Event::HardBreak if inside => title.push(' '),
            _ => {}
        }
    }

    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() { None } else { Some(title) }
}

/// File stem, or [`FALLBACK_DOC_TITLE`] when there is none.
fn fallback_title(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().trim().to_string())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| FALLBACK_DOC_TITLE.to_string())
}

/// Whether a directory name is skipped unconditionally.
///
/// Every dot-directory (`.git`, `.cache`, `.obsidian`, …) is skipped, which
/// also covers `.git` explicitly; `node_modules` is skipped case-insensitively.
pub fn is_skipped_dir_name(name: &str) -> bool {
    name.starts_with('.')
        || SKIPPED_DIR_NAMES
            .iter()
            .any(|skipped| name.eq_ignore_ascii_case(skipped))
}

/// Pruning predicate handed to [`walkdir::WalkDir::filter_entry`].
///
/// The root is never pruned: its name says nothing about the site, and pruning
/// it would silently produce an empty scan.
fn keep_entry(entry: &DirEntry, out: &Path) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if entry.file_type().is_dir() && entry.file_name().to_str().is_some_and(is_skipped_dir_name) {
        return false;
    }
    !is_same_or_descendant(&normalize(entry.path()), out)
}

/// Whether `path` equals `ancestor` or lives below it, comparing components.
fn is_same_or_descendant(path: &Path, ancestor: &Path) -> bool {
    let path = path_components(path);
    let ancestor = path_components(ancestor);

    ancestor.len() <= path.len()
        && ancestor
            .iter()
            .zip(&path)
            .all(|(left, right)| left == right)
}

/// Human-readable description of a walk failure, relative to the input root.
fn entry_error_message(error: &walkdir::Error, root: &Path) -> String {
    let path = error
        .path()
        .map(|path| document_id(root, path).unwrap_or_else(|| path.display().to_string()))
        .unwrap_or_else(|| root.display().to_string());

    match error.io_error() {
        Some(io) => format!("cannot read '{path}': {io}"),
        None => format!("cannot read '{path}': {error}"),
    }
}

/// `1 symbolic link` / `2 symbolic links`, so messages stay grammatical.
fn count_phrase(count: usize, singular: &str, plural: &str) -> String {
    format!("{count} {}", if count == 1 { singular } else { plural })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write_file(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(&path, contents).expect("write fixture file");
    }

    fn site(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        for (relative, contents) in files {
            write_file(dir.path(), relative, contents);
        }
        dir
    }

    fn ids(report: &ScanReport) -> Vec<&str> {
        report.docs.iter().map(|doc| doc.id.as_str()).collect()
    }

    fn messages(report: &ScanReport) -> Vec<String> {
        report
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.to_string())
            .collect()
    }

    #[test]
    fn recognises_markdown_extensions_case_insensitively() {
        for path in [
            "a.md",
            "a.MD",
            "a.MarkDown",
            "dir/b.markdown",
            "dir.with.dots/c.md",
        ] {
            assert!(
                is_markdown_path(Path::new(path)),
                "{path} should be a Markdown document"
            );
        }
    }

    #[test]
    fn ignores_other_extensions_and_missing_extensions() {
        for path in ["a.txt", "a.mdx", "a.md.bak", "README", "a.markdownx", ""] {
            assert!(
                !is_markdown_path(Path::new(path)),
                "{path} should not be a Markdown document"
            );
        }
    }

    #[test]
    fn document_id_uses_forward_slashes_without_cur_dir_prefix() {
        let root = Path::new("docs");
        let path = root.join("guide").join("intro.md");

        assert_eq!(document_id(root, &path).as_deref(), Some("guide/intro.md"));
        assert_eq!(
            document_id(root, &root.join(".").join("intro.md")).as_deref(),
            Some("intro.md")
        );
        assert_eq!(
            document_id(Path::new("."), Path::new("./guide/intro.md")).as_deref(),
            Some("guide/intro.md")
        );
    }

    #[cfg(windows)]
    #[test]
    fn document_id_accepts_backslash_separators() {
        let id = document_id(Path::new(r"docs"), Path::new(r"docs\guide\intro.md"));

        assert_eq!(id.as_deref(), Some("guide/intro.md"));
    }

    #[test]
    fn document_id_rejects_paths_outside_the_root() {
        assert_eq!(
            document_id(Path::new("docs"), Path::new("other/a.md")),
            None
        );
        assert_eq!(document_id(Path::new("docs"), Path::new("docs")), None);
    }

    #[test]
    fn title_uses_the_first_level_one_heading() {
        let path = Path::new("intro.md");
        assert_eq!(extract_title("# Hello\n\nbody\n", path), "Hello");
        assert_eq!(
            extract_title("intro\n\n# Later\n\n## Section\n", path),
            "Later"
        );
        assert_eq!(
            extract_title("## Section\n\n# Title\n", path),
            "Title",
            "a lower-level heading must not win"
        );
    }

    #[test]
    fn title_strips_inline_markup() {
        let path = Path::new("intro.md");

        assert_eq!(
            extract_title("# **Bold** and `code`\n", path),
            "Bold and code"
        );
        assert_eq!(
            extract_title("# [Guide](guide.md) intro\n", path),
            "Guide intro"
        );
        assert_eq!(
            extract_title("# ~~Old~~ *new* title\n", path),
            "Old new title"
        );
        assert_eq!(
            extract_title("# Title <span>raw</span>\n", path),
            "Title raw"
        );
    }

    #[test]
    fn title_ignores_headings_inside_code_blocks() {
        let path = Path::new("intro.md");
        let text = "```\n# Not a title\n```\n\n# Real title\n";

        assert_eq!(extract_title(text, path), "Real title");
    }

    #[test]
    fn title_handles_setext_headings() {
        let path = Path::new("intro.md");

        assert_eq!(
            extract_title("Setext title\n============\n", path),
            "Setext title"
        );
    }

    #[test]
    fn title_keeps_unicode_text() {
        let path = Path::new("intro.md");

        assert_eq!(extract_title("# 第一章 概述\n", path), "第一章 概述");
        assert_eq!(extract_title("# 中文**加粗**标题\n", path), "中文加粗标题");
    }

    #[test]
    fn title_falls_back_to_the_file_stem() {
        assert_eq!(
            extract_title("no heading here\n", Path::new("guide/getting-started.md")),
            "getting-started"
        );
        assert_eq!(extract_title("", Path::new("notes.markdown")), "notes");
        assert_eq!(
            extract_title("#\n\nbody\n", Path::new("empty-heading.md")),
            "empty-heading",
            "an empty heading must not become the title"
        );
    }

    #[test]
    fn title_falls_back_to_untitled() {
        assert_eq!(
            extract_title("no heading\n", Path::new("")),
            FALLBACK_DOC_TITLE
        );
    }

    #[test]
    fn documents_are_sorted_by_id_in_byte_order() {
        let dir = site(&[
            ("banana.md", "# Banana\n"),
            ("apple.md", "# Apple\n"),
            ("guide/z.md", "# Z\n"),
            ("guide/a.md", "# A\n"),
            ("Zebra.md", "# Zebra\n"),
        ]);
        let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

        assert_eq!(
            ids(&report),
            [
                "Zebra.md",
                "apple.md",
                "banana.md",
                "guide/a.md",
                "guide/z.md"
            ],
            "byte order puts uppercase before lowercase"
        );
    }

    #[test]
    fn skips_dot_directories_node_modules_and_git() {
        let dir = site(&[
            ("keep.md", "# Keep\n"),
            (".git/config.md", "# Ignored\n"),
            (".obsidian/notes.md", "# Ignored\n"),
            ("node_modules/pkg/readme.md", "# Ignored\n"),
            ("guide/.drafts/wip.md", "# Ignored\n"),
        ]);
        let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

        assert_eq!(ids(&report), ["keep.md"]);
    }

    #[test]
    fn skips_the_output_directory() {
        let dir = site(&[
            ("keep.md", "# Keep\n"),
            ("dist/index.md", "# Previous build\n"),
            ("dist/nested/old.md", "# Previous build\n"),
        ]);
        let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

        assert_eq!(ids(&report), ["keep.md"]);
    }

    #[test]
    fn output_directory_outside_the_input_is_harmless() {
        let dir = site(&[("keep.md", "# Keep\n")]);
        let elsewhere = tempfile::tempdir().expect("temp dir");
        let report = scan(dir.path(), elsewhere.path()).expect("scan");

        assert_eq!(ids(&report), ["keep.md"]);
    }

    #[test]
    fn non_utf8_documents_become_warnings() {
        let dir = site(&[("good.md", "# Good\n")]);
        fs::write(dir.path().join("latin1.md"), [0x23, 0x20, 0xff, 0xfe]).expect("write fixture");

        let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

        assert_eq!(ids(&report), ["good.md"]);
        assert_eq!(report.warning_count(), 1);
        assert!(
            messages(&report).iter().any(|message| message
                .starts_with("warning: skipped 'latin1.md'")
                && message.contains("not valid UTF-8")),
            "unexpected diagnostics: {:?}",
            messages(&report)
        );
    }

    #[test]
    fn counts_ignored_non_markdown_files() {
        let dir = site(&[
            ("keep.md", "# Keep\n"),
            ("image.png", "png"),
            ("notes.txt", "text"),
        ]);
        let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

        assert_eq!(report.ignored_files, 2);
        assert_eq!(
            messages(&report),
            ["note: ignored 2 non-markdown files".to_string()]
        );
        assert!(!report.has_warnings(), "ignored files are not warnings");
    }

    #[test]
    fn empty_folder_warns_but_does_not_fail() {
        let dir = tempfile::tempdir().expect("temp dir");
        let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

        assert!(report.docs.is_empty());
        assert_eq!(
            messages(&report),
            [format!("warning: {NO_MARKDOWN_MESSAGE}")]
        );
        assert!(report.has_warnings());
    }

    #[test]
    fn diagnostics_are_deterministic() {
        let dir = site(&[
            ("b.md", "# B\n"),
            ("a.md", "no heading\n"),
            ("image.png", "png"),
            ("nested/c.md", "# C\n"),
        ]);
        let first = scan(dir.path(), &dir.path().join("dist")).expect("scan");
        let second = scan(dir.path(), &dir.path().join("dist")).expect("scan");

        assert_eq!(first, second);
    }

    #[test]
    fn documents_keep_their_raw_text_and_path() {
        let dir = site(&[("guide/intro.md", "# Intro\n\nBody\n")]);
        let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");
        let doc = &report.docs[0];

        assert_eq!(doc.id, "guide/intro.md");
        assert_eq!(doc.title, "Intro");
        assert_eq!(doc.text, "# Intro\n\nBody\n");
        assert_eq!(doc.path, dir.path().join("guide").join("intro.md"));
    }

    #[test]
    fn missing_input_directory_is_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("nope");

        let error = scan(&missing, &dir.path().join("dist")).expect_err("scan should fail");

        assert!(
            error.to_string().contains("cannot read"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn diagnostic_display_prefixes_the_severity() {
        assert_eq!(Diagnostic::note("hi").to_string(), "note: hi");
        assert_eq!(Diagnostic::warning("hi").to_string(), "warning: hi");
        assert_eq!(Severity::Note.as_str(), "note");
        assert_eq!(Severity::Warning.as_str(), "warning");
    }

    #[cfg(unix)]
    fn create_file_symlink(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(original, link)
    }

    #[test]
    fn symbolic_links_are_not_followed() {
        let dir = site(&[("real.md", "# Real\n")]);
        let link = dir.path().join("linked.md");

        if create_file_symlink(&dir.path().join("real.md"), &link).is_err() {
            // Creating symlinks needs extra privileges on Windows.
            return;
        }

        let report = scan(dir.path(), &dir.path().join("dist")).expect("scan");

        assert_eq!(ids(&report), ["real.md"]);
        assert_eq!(
            messages(&report),
            ["note: skipped 1 symbolic link (not followed)".to_string()]
        );
    }

    #[test]
    fn skipped_directory_names_cover_dot_directories_and_node_modules() {
        assert!(is_skipped_dir_name(".git"));
        assert!(is_skipped_dir_name(".cache"));
        assert!(is_skipped_dir_name("node_modules"));
        assert!(is_skipped_dir_name("NODE_MODULES"));
        assert!(!is_skipped_dir_name("guide"));
        assert!(!is_skipped_dir_name("node_modules_old"));
    }
}
