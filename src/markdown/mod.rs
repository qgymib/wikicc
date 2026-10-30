//! Markdown rendering: GFM HTML with stable anchors and a chapter outline.
//!
//! Parsing and HTML serialisation are entirely delegated to `pulldown-cmark`.
//! This module adds the two things the crate does not provide: an anchor on
//! every heading and the nested outline derived from those headings.
//!
//! Anchors are injected at the event level, by filling the `id` field of
//! `Tag::Heading` that `push_html` renders as `<h2 id="…">`. The HTML string is
//! never post-processed, so attribute quoting and nesting cannot be corrupted.
//!
//! A heading's text is only complete when the closing event arrives, while its
//! `id` has to be present on the opening event. The renderer therefore buffers
//! the event stream, patches the buffered opening event once the slug is known,
//! and serialises once — the document is parsed exactly once.
//!
//! Code blocks take the same route: their text is buffered, highlighted once by
//! [`highlight::code_block_html`], and re-emitted as a single `Event::Html`, so
//! the highlight markup is produced structurally instead of by rewriting HTML.
//!
//! Link and image destinations are rewritten on the same event stream through
//! [`LinkRewriter`], which is how [`links`] turns author paths into hash routes
//! and asset placeholders. [`render_document`] keeps the destinations verbatim
//! and is therefore byte-for-byte identical to the pre-resolution renderer.
//!
//! The same pass also collects the plain text of the document, which is what
//! the front end searches. Keeping it here rather than in a second parse means
//! `html`, `toc` and `text` always describe exactly the same source.

pub mod highlight;
pub mod links;
pub mod slug;
pub mod toc;

use pulldown_cmark::html::push_html;
use pulldown_cmark::{CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use highlight::code_block_html;

pub use links::{LinkClass, LinkContext, LinkResolver, classify};
pub use slug::{FALLBACK_SLUG, Slugger, slugify};
pub use toc::{Heading, TocEntry, build_toc};

/// Markdown extensions compiled in.
///
/// Tables, footnotes, strikethrough and task lists are the GFM subset promised
/// by the plan. Smart punctuation stays off so quotes and `--` survive verbatim
/// instead of drifting with a library upgrade, and heading attributes stay off
/// so anchors are decided by [`slugify`] alone and never by author input.
pub const PARSER_OPTIONS: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_FOOTNOTES)
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_TASKLISTS);

/// Result of rendering one document.
///
/// `html`, `toc` and `text` come from the same parse, so a document is never
/// parsed twice: the HTML is what the reader shows, the outline is what the
/// right column lists and `text` is what the search index matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedDoc {
    /// Body HTML, with an `id` attribute on every heading.
    pub html: String,
    /// Chapter outline in document order, nested by heading level.
    pub toc: Vec<TocEntry>,
    /// Plain text of the document: every `Text` and `Code` event, with block
    /// boundaries turned into single spaces and whitespace collapsed.
    pub text: String,
}

/// Rewrites link and image destinations while a document is rendered.
///
/// The renderer calls this for every `Tag::Link` and `Tag::Image` it meets, on
/// the event stream and before any HTML exists, so a destination can be
/// replaced without touching attribute quoting. `line` is the 1-based source
/// line the destination starts on, which is what diagnostics quote.
pub trait LinkRewriter {
    /// Final destination for `destination`.
    fn rewrite(&mut self, destination: &str, line: usize) -> String;
}

/// Leaves every destination exactly as the author wrote it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NoRewrite;

impl LinkRewriter for NoRewrite {
    fn rewrite(&mut self, destination: &str, _line: usize) -> String {
        destination.to_string()
    }
}

/// Heading whose opening event is buffered but not yet patched.
struct OpenHeading<'a> {
    /// Position of the opening event in the buffer.
    index: usize,
    /// Heading level, reused for the patched event and the outline entry.
    level: HeadingLevel,
    /// Classes and attributes carried over from the parser.
    classes: Vec<CowStr<'a>>,
    attrs: Vec<(CowStr<'a>, Option<CowStr<'a>>)>,
    /// Text seen so far, collapsed once the heading closes.
    text: String,
}

/// Fenced or indented code block whose text is still being collected.
struct CodeBlockBuffer {
    /// Fence info string, `None` for an indented block.
    info: Option<String>,
    /// Verbatim code, in source order.
    code: String,
}

/// Render one Markdown document into HTML, its chapter outline and its text.
///
/// Never fails: `pulldown-cmark` accepts any input, and unknown constructs
/// degrade to escaped text. Link and image destinations are left exactly as
/// written; use [`render_document_with`] to resolve them.
pub fn render_document(source: &str) -> RenderedDoc {
    render_document_with(source, &mut NoRewrite)
}

/// Render one Markdown document, rewriting every link and image destination
/// through `rewriter` before the HTML is produced.
pub fn render_document_with<R: LinkRewriter + ?Sized>(
    source: &str,
    rewriter: &mut R,
) -> RenderedDoc {
    let line_starts = line_starts(source);
    let mut events: Vec<Event<'_>> = Vec::new();
    let mut headings: Vec<Heading> = Vec::new();
    let mut text = String::with_capacity(source.len());
    let mut slugger = Slugger::new();
    let mut open: Option<OpenHeading<'_>> = None;
    let mut code_block: Option<CodeBlockBuffer> = None;

    for (event, range) in Parser::new_ext(source, PARSER_OPTIONS).into_offset_iter() {
        match event {
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let line = line_of(&line_starts, range.start);
                events.push(Event::Start(Tag::Link {
                    link_type,
                    dest_url: CowStr::from(rewriter.rewrite(&dest_url, line)),
                    title,
                    id,
                }));
            }
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let line = line_of(&line_starts, range.start);
                events.push(Event::Start(Tag::Image {
                    link_type,
                    dest_url: CowStr::from(rewriter.rewrite(&dest_url, line)),
                    title,
                    id,
                }));
            }
            Event::Start(Tag::Heading {
                level,
                classes,
                attrs,
                ..
            }) => {
                // Placeholder: replaced by the patched event once the text is known.
                events.push(Event::Start(Tag::Heading {
                    level,
                    id: None,
                    classes: Vec::new(),
                    attrs: Vec::new(),
                }));
                separate(&mut text);
                open = Some(OpenHeading {
                    index: events.len() - 1,
                    level,
                    classes,
                    attrs,
                    text: String::new(),
                });
            }
            Event::End(TagEnd::Heading(level)) => {
                if let Some(heading) = open.take() {
                    let heading_text = collapse_whitespace(&heading.text);
                    let slug = slugger.unique(&heading_text);
                    events[heading.index] = Event::Start(Tag::Heading {
                        level: heading.level,
                        id: Some(CowStr::from(slug.clone())),
                        classes: heading.classes,
                        attrs: heading.attrs,
                    });
                    headings.push(Heading {
                        level: heading.level as u32,
                        id: slug,
                        text: heading_text,
                    });
                }
                events.push(Event::End(TagEnd::Heading(level)));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let info = match kind {
                    CodeBlockKind::Fenced(info) => Some(info.to_string()),
                    CodeBlockKind::Indented => None,
                };
                separate(&mut text);
                code_block = Some(CodeBlockBuffer {
                    info,
                    code: String::new(),
                });
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(block) = code_block.take() {
                    let html = code_block_html(&block.code, block.info.as_deref());
                    events.push(Event::Html(CowStr::from(html)));
                }
            }
            Event::Text(value) => {
                // Code is searchable too, so the plain text keeps a copy of
                // what the highlighter consumes.
                text.push_str(&value);
                if let Some(block) = code_block.as_mut() {
                    // Code is highlighted as a whole, so the text never reaches
                    // the serialiser as an event of its own.
                    block.code.push_str(&value);
                } else {
                    if let Some(heading) = open.as_mut() {
                        heading.text.push_str(&value);
                    }
                    events.push(Event::Text(value));
                }
            }
            Event::Code(value) => {
                text.push_str(&value);
                if let Some(heading) = open.as_mut() {
                    heading.text.push_str(&value);
                }
                events.push(Event::Code(value));
            }
            other @ (Event::SoftBreak | Event::HardBreak) => {
                text.push(' ');
                if let Some(heading) = open.as_mut() {
                    heading.text.push(' ');
                }
                events.push(other);
            }
            other => {
                // Block boundaries become spaces, so a table row reads as
                // `name value` instead of `namevalue` in the index. Inline
                // elements are deliberately not boundaries: `[a](b.md).` must
                // read as `a.`, not as `a .`.
                if let Event::Start(tag) = &other
                    && separates_words(tag)
                {
                    separate(&mut text);
                }
                if code_block.is_none() {
                    events.push(other);
                }
            }
        }
    }

    let mut html = String::with_capacity(source.len());
    push_html(&mut html, events.into_iter());

    RenderedDoc {
        html,
        toc: build_toc(&headings),
        text: collapse_whitespace(&text),
    }
}

/// Append one space unless the buffer is empty or already ends with whitespace.
///
/// Used at block boundaries: it keeps neighbouring pieces of text from gluing
/// together without ever producing runs of spaces.
fn separate(text: &mut String) {
    if !text.is_empty() && !text.ends_with(char::is_whitespace) {
        text.push(' ');
    }
}

/// Whether opening `tag` starts a new block in the plain text.
///
/// Only block-level tags separate words; emphasis, links, images, code spans
/// and footnote references stay glued to their neighbours, exactly as they
/// appear in the rendered document.
fn separates_words(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::Paragraph
            | Tag::Heading { .. }
            | Tag::BlockQuote(_)
            | Tag::CodeBlock(_)
            | Tag::HtmlBlock
            | Tag::List(_)
            | Tag::Item
            | Tag::FootnoteDefinition(_)
            | Tag::Table(_)
            | Tag::TableHead
            | Tag::TableRow
            | Tag::TableCell
    )
}

/// Collapse runs of whitespace into single spaces and trim the ends.
fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Byte offsets of every line start in `source`, always beginning with `0`.
///
/// Built once per document so a diagnostic can name the line of any event with
/// a binary search instead of rescanning the source for every link.
fn line_starts(source: &str) -> Vec<usize> {
    let mut starts = Vec::with_capacity(source.len() / 32 + 1);
    starts.push(0);
    starts.extend(
        source
            .bytes()
            .enumerate()
            .filter(|(_, byte)| *byte == b'\n')
            .map(|(index, _)| index + 1),
    );
    starts
}

/// 1-based line number of the line that contains `offset`.
fn line_of(line_starts: &[usize], offset: usize) -> usize {
    line_starts.partition_point(|&start| start <= offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heading_ids(doc: &RenderedDoc) -> Vec<&str> {
        doc.toc.iter().map(|entry| entry.id.as_str()).collect()
    }

    #[test]
    fn renders_gfm_tables_footnotes_tasks_and_strikethrough() {
        let source = "\
| a | b |
| - | - |
| 1 | 2 |

~~old~~ text[^note]

- [x] done
- [ ] pending

[^note]: the footnote
";
        let doc = render_document(source);

        assert!(doc.html.contains("<table>"), "html: {}", doc.html);
        assert!(doc.html.contains("<thead>"), "html: {}", doc.html);
        assert!(doc.html.contains("<del>old</del>"), "html: {}", doc.html);
        assert!(
            doc.html.contains("class=\"footnote-reference\""),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("class=\"footnote-definition\""),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("type=\"checkbox\" checked=\"\""),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn injects_ids_on_headings() {
        let doc = render_document("## Hello, World!\n\ntext\n");

        assert!(doc.html.contains("<h2 id=\"hello-world\">"));
        assert!(doc.html.contains("Hello, World!"));
    }

    #[test]
    fn keeps_cjk_heading_ids() {
        let doc = render_document("## 第一章\n");

        assert!(
            doc.html.contains("<h2 id=\"第一章\">"),
            "html: {}",
            doc.html
        );
        assert_eq!(heading_ids(&doc), ["第一章"]);
    }

    #[test]
    fn duplicate_headings_get_unique_ids() {
        let doc = render_document("## Notes\n\n## Notes\n\n## Notes\n");

        assert!(doc.html.contains("<h2 id=\"notes\">"));
        assert!(doc.html.contains("<h2 id=\"notes-1\">"));
        assert!(doc.html.contains("<h2 id=\"notes-2\">"));
        assert_eq!(heading_ids(&doc), ["notes", "notes-1", "notes-2"]);
    }

    #[test]
    fn outline_mirrors_document_order_and_levels() {
        let doc = render_document("# A\n\n## A1\n\n### A1a\n\n# B\n");

        assert_eq!(doc.toc.len(), 2);
        assert_eq!(doc.toc[0].text, "A");
        assert_eq!(doc.toc[0].children[0].text, "A1");
        assert_eq!(doc.toc[0].children[0].children[0].text, "A1a");
        assert_eq!(doc.toc[1].text, "B");
    }

    #[test]
    fn outline_text_strips_inline_markup() {
        let doc = render_document("## **Bold** and `code` and [link](other.md)\n");

        assert_eq!(doc.toc[0].text, "Bold and code and link");
        assert_eq!(doc.toc[0].id, "bold-and-code-and-link");
    }

    #[test]
    fn headings_inside_code_blocks_are_not_collected() {
        let doc = render_document("```\n# Not a heading\n```\n");

        assert!(doc.toc.is_empty());
        assert!(!doc.html.contains("<h1"));
    }

    #[test]
    fn smart_punctuation_stays_off() {
        let doc = render_document("He said \"hi\" -- and left...\n");

        assert!(
            doc.html.contains("\"hi\" -- and left..."),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains('“'));
    }

    #[test]
    fn raw_html_passes_through_unchanged() {
        let doc = render_document("<div class=\"raw\">keep</div>\n");

        assert!(doc.html.contains("<div class=\"raw\">keep</div>"));
    }

    #[test]
    fn empty_document_renders_nothing() {
        let doc = render_document("");

        assert_eq!(doc.html, "");
        assert!(doc.toc.is_empty());
    }

    #[test]
    fn rendering_is_deterministic() {
        let source = "# Title\n\n## Notes\n\n## Notes\n\ntext\n";

        assert_eq!(render_document(source), render_document(source));
    }

    #[test]
    fn parser_options_match_the_documented_gfm_subset() {
        assert!(PARSER_OPTIONS.contains(Options::ENABLE_TABLES));
        assert!(PARSER_OPTIONS.contains(Options::ENABLE_FOOTNOTES));
        assert!(PARSER_OPTIONS.contains(Options::ENABLE_STRIKETHROUGH));
        assert!(PARSER_OPTIONS.contains(Options::ENABLE_TASKLISTS));
        assert!(!PARSER_OPTIONS.contains(Options::ENABLE_SMART_PUNCTUATION));
        assert!(!PARSER_OPTIONS.contains(Options::ENABLE_HEADING_ATTRIBUTES));
    }

    #[test]
    fn heading_text_collapses_whitespace() {
        let doc = render_document("## Spaced   out\n");

        assert_eq!(doc.toc[0].text, "Spaced out");
    }

    #[test]
    fn fenced_code_block_is_highlighted() {
        let doc = render_document("```rust\nfn main() {}\n```\n");

        assert!(
            doc.html
                .contains("<pre class=\"code\"><code class=\"language-rust\">"),
            "html: {}",
            doc.html
        );
        assert!(doc.html.contains("<span class=\""), "html: {}", doc.html);
        assert!(doc.html.contains("</code></pre>"), "html: {}", doc.html);
        assert!(!doc.html.contains("```"), "html: {}", doc.html);
    }

    #[test]
    fn unknown_fence_is_escaped_without_spans() {
        let doc = render_document("```foo\na < b\n```\n");

        assert!(
            doc.html.contains(
                "<pre class=\"code\"><code class=\"language-foo\">a &lt; b\n</code></pre>"
            ),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains("<span"), "html: {}", doc.html);
    }

    #[test]
    fn indented_code_block_has_no_language_class() {
        let doc = render_document("    let x = 1;\n");

        assert!(
            doc.html
                .contains("<pre class=\"code\"><code>let x = 1;\n</code></pre>"),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn inline_code_stays_inline_and_unhighlighted() {
        let doc = render_document("use `let x = 1;` here\n");

        assert!(
            doc.html.contains("<code>let x = 1;</code>"),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains("<pre"), "html: {}", doc.html);
    }

    /// Rewriter that records every destination and tags it, so a test can see
    /// exactly what the renderer handed over.
    struct Recorder {
        seen: Vec<(String, usize)>,
    }

    impl Recorder {
        fn new() -> Self {
            Self { seen: Vec::new() }
        }
    }

    impl LinkRewriter for Recorder {
        fn rewrite(&mut self, destination: &str, line: usize) -> String {
            self.seen.push((destination.to_string(), line));
            format!("rewritten:{destination}")
        }
    }

    #[test]
    fn link_rewriter_sees_every_destination_and_its_line() {
        let source = "# T\n\ntext [a](a.md) and ![i](i.png)\n\n[d](b.md#x)\n";
        let mut recorder = Recorder::new();

        let doc = render_document_with(source, &mut recorder);

        assert_eq!(
            recorder.seen,
            [
                ("a.md".to_string(), 3),
                ("i.png".to_string(), 3),
                ("b.md#x".to_string(), 5),
            ]
        );
        assert!(
            doc.html.contains("href=\"rewritten:a.md\""),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("src=\"rewritten:i.png\""),
            "html: {}",
            doc.html
        );
        assert!(
            doc.html.contains("href=\"rewritten:b.md#x\""),
            "html: {}",
            doc.html
        );
    }

    #[test]
    fn the_default_rewriter_is_the_identity() {
        let source = "# T\n\n[a](a.md) ![i](i.png) [e](https://example.com)\n";

        assert_eq!(
            render_document(source),
            render_document_with(source, &mut NoRewrite)
        );
        assert_eq!(
            render_document(source).html,
            render_document_with(source, &mut NoRewrite).html,
            "destinations stay verbatim"
        );
    }

    #[test]
    fn destinations_inside_code_blocks_are_not_rewritten() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("```\n[a](a.md)\n```\n", &mut recorder);

        assert!(recorder.seen.is_empty(), "seen: {:?}", recorder.seen);
        assert!(doc.html.contains("[a](a.md)"), "html: {}", doc.html);
    }

    #[test]
    fn rewriting_does_not_change_heading_slugs() {
        let mut recorder = Recorder::new();

        let doc = render_document_with("## [Guide](guide.md)\n", &mut recorder);

        assert_eq!(doc.toc[0].id, "guide");
        assert_eq!(doc.toc[0].text, "Guide");
        assert_eq!(recorder.seen, [("guide.md".to_string(), 1)]);
    }

    #[test]
    fn code_block_followed_by_a_heading_keeps_the_outline() {
        let doc = render_document("```rust\nfn main() {}\n```\n\n## After\n");

        assert_eq!(doc.toc.len(), 1);
        assert_eq!(doc.toc[0].text, "After");
        assert!(doc.html.contains("<h2 id=\"after\">"), "html: {}", doc.html);
    }

    #[test]
    fn text_covers_every_block_kind_without_markup() {
        let source = "\
# Title

A **bold** paragraph with `code` and a [link](other.md).

- one
- two

| name | value |
| ---- | ----- |
| a    | 1     |

```rust
fn main() {}
```
";
        let doc = render_document(source);

        for expected in [
            "Title",
            "A bold paragraph with code and a link.",
            "one two",
            "name value",
            "a 1",
            "fn main() {}",
        ] {
            assert!(
                doc.text.contains(expected),
                "missing {expected:?} in text: {}",
                doc.text
            );
        }
        for marker in ['#', '*', '`', '|'] {
            assert!(
                !doc.text.contains(marker),
                "text still carries {marker:?}: {}",
                doc.text
            );
        }
    }

    #[test]
    fn text_keeps_unicode_and_collapses_whitespace() {
        let doc = render_document("## 第一章\n\n中文   文本\n");

        assert_eq!(doc.text, "第一章 中文 文本");
    }

    #[test]
    fn text_of_an_empty_document_is_empty() {
        assert_eq!(render_document("").text, "");
    }

    #[test]
    fn text_separates_adjacent_blocks_but_not_inline_runs() {
        let doc = render_document("alpha\n\nbeta **gamma** delta\n");

        assert_eq!(doc.text, "alpha beta gamma delta");
    }
}
