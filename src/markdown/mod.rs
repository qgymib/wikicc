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
//! One authoring idiom is normalised before the rewriter sees it: Typora users
//! wrap a numbered citation in a second pair of brackets, writing `[[1]][1]`
//! for a citation whose definition block is `[1]: https://…`. CommonMark reads
//! that as a literal `[`, the reference link `[1]`, a literal `]` and a second
//! reference link `[1]`, so the reader would show `[1]1`. [`fold_bracketed_reference`]
//! collapses the sequence into the single link `[1]` Typora displays.
//!
//! Folding therefore has to happen before the destinations are rewritten, and
//! it can only be recognised once the *second* link closes. A link that may
//! open such a citation is kept pending instead of being rewritten at its own
//! closing event; the next event settles the question. The swallowed duplicate
//! consequently never reaches the resolver, so it cannot produce a second
//! diagnostic or a second link-graph edge.
//!
//! The same pass also collects the plain text of the document, which is what
//! the front end searches. Keeping it here rather than in a second parse means
//! `html`, `toc` and `text` always describe exactly the same source.

pub mod highlight;
pub mod links;
pub mod slug;
pub mod toc;

use pulldown_cmark::html::push_html;
use pulldown_cmark::{
    CodeBlockKind, CowStr, Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd,
};

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

/// Link whose destination has not been rewritten yet.
///
/// Links are rewritten when they close, not when they open, because a
/// `[[n]][n]` citation is only recognisable at the closing event of its second
/// link — and by then one of the two must be gone, so the resolver is called
/// exactly once.
struct OpenLink {
    /// Position of the opening event in the buffer.
    index: usize,
    /// 1-based source line the link starts on.
    line: usize,
    /// Byte length of the plain text when the link opened.
    text_start: usize,
}

/// Rewrite the destination of the link whose `Start` is at `index`.
///
/// A no-op when the event there is no longer a link, which keeps the caller
/// free of extra bookkeeping.
fn rewrite_link_at<R: LinkRewriter + ?Sized>(
    events: &mut [Event<'_>],
    index: usize,
    rewriter: &mut R,
    line: usize,
) {
    let Some(Event::Start(Tag::Link {
        link_type,
        dest_url,
        title,
        id,
    })) = events.get(index)
    else {
        return;
    };
    events[index] = Event::Start(Tag::Link {
        link_type: *link_type,
        dest_url: CowStr::from(rewriter.rewrite(dest_url, line)),
        title: title.clone(),
        id: id.clone(),
    });
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
    let mut open_links: Vec<OpenLink> = Vec::new();
    // Link whose rewrite waits until it is known whether it opens a
    // `[[n]][n]` citation. At most one such link can be pending: the shape
    // only ever spans two adjacent links.
    let mut pending: Option<OpenLink> = None;

    for (event, range) in Parser::new_ext(source, PARSER_OPTIONS).into_offset_iter() {
        match event {
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                // The destination is rewritten when the fold is settled, not
                // here: a `[[n]][n]` pair must be matched on the destinations
                // the author wrote, and a swallowed duplicate must never reach
                // the resolver.
                events.push(Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    title,
                    id,
                }));
                open_links.push(OpenLink {
                    index: events.len() - 1,
                    line: line_of(&line_starts, range.start),
                    // The plain text does not hold this link's own content yet.
                    text_start: text.len(),
                });
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
            Event::End(TagEnd::Link) => {
                events.push(Event::End(TagEnd::Link));
                let Some(open_link) = open_links.pop() else {
                    continue;
                };
                // A fold can only be recognised once the *second* link closes,
                // so the first link of a possible `[[n]][n]` is kept pending.
                // Rewriting it now would leave the two destinations different
                // and the fold would never match.
                if pending.is_none() && looks_like_wrap_candidate(&events, open_link.index) {
                    pending = Some(open_link);
                    continue;
                }

                match pending
                    .as_ref()
                    .and_then(|pending_link| fold_bracketed_reference(&mut events, pending_link))
                {
                    Some(fold) => {
                        // The citation reads as `[n]`, not as `[[n]][n]`. The
                        // plain text holds `[`, `n`, `]` and then the duplicate
                        // `n`; `text_start` marks the `n` of the surviving link,
                        // so keeping it and closing the bracket is the citation.
                        let keep = fold.text_start + fold.duplicate_len;
                        text.truncate(keep);
                        text.push_str(CLOSING_BRACKET);
                        if let Some(heading) = open.as_mut() {
                            heading.text.truncate(keep.min(heading.text.len()));
                            heading.text.push_str(CLOSING_BRACKET);
                        }
                        // The two links are settled; the pending slot is free.
                        pending = None;
                        // Only the surviving link reaches the resolver, and it
                        // keeps the line it starts on.
                        rewrite_link_at(&mut events, fold.link_start, &mut *rewriter, fold.line);
                    }
                    None => {
                        // No citation here. When a link was pending, *this* link
                        // is the one that broke the shape, so the pending link
                        // is rewritten first and this one after it; otherwise
                        // only this link is rewritten.
                        let earlier = pending.take();
                        if let Some(pending_link) = earlier {
                            rewrite_link_at(
                                &mut events,
                                pending_link.index,
                                &mut *rewriter,
                                pending_link.line,
                            );
                        }
                        rewrite_link_at(
                            &mut events,
                            open_link.index,
                            &mut *rewriter,
                            open_link.line,
                        );
                    }
                }
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
                // A pending link waits for the event after it to prove whether it
                // opens a citation. Only the `]` that would separate the two
                // links keeps it waiting; anything else settles the question.
                if !is_literal(&other, CLOSING_BRACKET)
                    && let Some(pending_link) = pending.take()
                {
                    rewrite_link_at(
                        &mut events,
                        pending_link.index,
                        &mut *rewriter,
                        pending_link.line,
                    );
                }
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

/// The character that opens a citation wrap, `[[n]][n]`.
const OPENING_BRACKET: &str = "[";
/// The literal that separates the two links of `[[n]][n]`.
const CLOSING_BRACKET: &str = "]";

/// What a successful fold did, so the caller can keep its own bookkeeping in
/// step with the events it just replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Folded {
    /// Index of the surviving link's `Start` after the fold.
    link_start: usize,
    /// Source line the surviving link starts on, for the resolver's diagnostics.
    line: usize,
    /// Byte length of the plain text when the surviving link opened.
    text_start: usize,
    /// Byte length of the citation's visible text, which is `n` for `[[n]][n]`.
    duplicate_len: usize,
}

/// Whether the link starting at `index` may open a `[[n]][n]` citation.
///
/// Only a reference link preceded by a `[` text event can, which is a cheap
/// test that keeps ordinary links on the immediate-rewrite path.
fn looks_like_wrap_candidate(events: &[Event<'_>], index: usize) -> bool {
    let Some(opening) = index.checked_sub(1) else {
        return false;
    };
    let Some(Event::Text(text)) = events.get(opening) else {
        return false;
    };
    if !text.ends_with(OPENING_BRACKET) {
        return false;
    }
    matches!(
        events.get(index),
        Some(Event::Start(Tag::Link { link_type, .. })) if is_reference(*link_type)
    )
}

/// Fold a Typora-style `[[n]][n]` citation into the single link `[n]`.
///
/// The event stream the parser produces for `[[1]][1]` is a literal `[`, a
/// reference link `[1]`, a literal `]` and a second, identical reference link
/// `[1]`. Serialising that yields `[<a>1</a>]<a>1</a>`, which a reader shows as
/// `[1]1`; Typora instead shows one `[1]` link. This function runs right after
/// the closing event of a link has been pushed and, when the last events form
/// exactly that shape, rewrites them into `<a href="…">[1]</a>`:
///
/// * the `[` that opened the wrap is dropped from the preceding text event,
/// * the `]` between the links is dropped,
/// * the second link is dropped entirely, and
/// * `[` and `]` are pushed inside the first link, so the brackets become part
///   of its visible text instead of anonymous text around it.
///
/// Both links must be reference links (`Shortcut` or `Collapsed`) to the same
/// destination with the same visible text; an inline `[1](url)` pair is left
/// alone, because there the brackets are the author's own syntax rather than a
/// wrap around a citation. Folding stops at any other event, so a match can
/// never cross a block or inline boundary.
///
/// Returns `None` when the tail is not a `[[n]][n]`, which is the common case.
fn fold_bracketed_reference(events: &mut Vec<Event<'_>>, pending: &OpenLink) -> Option<Folded> {
    let Shape {
        first_end,
        second_start,
        opening,
        opening_is_empty,
        ..
    } = bracket_shape(events)?;

    // Drop the duplicate link together with the `]` that separated the two
    // links. Removing from the back keeps the surviving indices valid.
    events.truncate(second_start);
    events.pop();

    // The `[` that opened the wrap goes next: either the whole text event when
    // it held nothing else, or just the bracket when it was glued to the text
    // in front of it (`text[[1]][1]`).
    if opening_is_empty {
        events.remove(opening);
    } else if let Event::Text(text) = &events[opening] {
        let prefix = text.strip_suffix(OPENING_BRACKET).unwrap_or(text);
        events[opening] = Event::Text(CowStr::from(prefix.to_string()));
    }
    // Only the `[` event, when it was dropped whole, sat before the surviving
    // link; the removals below it never shift its indices.
    let shift = usize::from(opening_is_empty);
    let link_start = opening + (1 - shift);
    let link_end = first_end - shift;

    // The brackets move inside the link, so the reader sees the same `[1]`
    // Typora shows instead of anonymous text around a link. Insert from the
    // back so the earlier index stays valid.
    events.insert(link_end, Event::Text(CowStr::Borrowed(CLOSING_BRACKET)));
    events.insert(
        link_start + 1,
        Event::Text(CowStr::Borrowed(OPENING_BRACKET)),
    );

    Some(Folded {
        link_start,
        line: pending.line,
        text_start: pending.text_start,
        duplicate_len: visible_text(events, link_start)
            .trim_start_matches(OPENING_BRACKET)
            .trim_end_matches(CLOSING_BRACKET)
            .len(),
    })
}

/// Indices of the events that make up one `[[n]][n]` at the tail of the buffer.
struct Shape {
    /// Index of the surviving link's `End`.
    first_end: usize,
    /// Index of the dropped link's `Start`.
    second_start: usize,
    /// Index of the text event that ends with the wrap's `[`.
    opening: usize,
    /// Whether that text event holds nothing but the `[`.
    opening_is_empty: bool,
}

/// Recognise the tail of `events` as `[[n]][n]` and return its layout.
///
/// Returns `None` for every other shape, which is the common case: the checks
/// are a handful of index lookups, so the fast path stays cheap.
fn bracket_shape(events: &[Event<'_>]) -> Option<Shape> {
    // The buffer always ends with the dropped link's `End`.
    let second_end = events.len().checked_sub(1)?;
    match events.get(second_end)? {
        Event::End(TagEnd::Link) => {}
        _ => return None,
    }
    let second_start = find_link_start(events, second_end)?;

    // Between the links sits exactly one `]` text event.
    let separator = second_start.checked_sub(1)?;
    if !is_literal(events.get(separator)?, CLOSING_BRACKET) {
        return None;
    }

    // Before the surviving candidate: its `End`, then the text that ends with
    // the `[` that opened the wrap.
    let first_end = separator.checked_sub(1)?;
    match events.get(first_end)? {
        Event::End(TagEnd::Link) => {}
        _ => return None,
    }
    let first_start = find_link_start(events, first_end)?;
    let opening = first_start.checked_sub(1)?;
    let Event::Text(text) = events.get(opening)? else {
        return None;
    };
    let opening_is_empty = text.strip_suffix(OPENING_BRACKET)?.is_empty();

    if !same_reference(events, first_start, second_start)
        || !same_visible_text(events, first_start, second_start)
    {
        return None;
    }

    Some(Shape {
        first_end,
        second_start,
        opening,
        opening_is_empty,
    })
}

/// Index of the `Start(Tag::Link)` that opened the link closing at `end`.
///
/// The scan walks backwards over inline events only: any other link, block or
/// inline container means the closing event does not belong to a plain link
/// here, and the shape is rejected.
fn find_link_start(events: &[Event<'_>], end: usize) -> Option<usize> {
    let mut index = end;
    while index > 0 {
        index -= 1;
        match &events[index] {
            Event::Start(Tag::Link { .. }) => return Some(index),
            Event::Start(_) | Event::End(_) | Event::Html(_) | Event::InlineHtml(_) => {
                return None;
            }
            _ => {}
        }
    }
    None
}

/// Whether the two links are reference links to the same destination.
///
/// Both destinations are compared as written. The surviving link may already
/// have been rewritten when a previous `End(Link)` was handled, so the
/// rewritten form is stripped back to the author's destination first.
fn same_reference(events: &[Event<'_>], first_start: usize, second_start: usize) -> bool {
    let (
        Event::Start(Tag::Link {
            link_type: first_type,
            dest_url: first_dest,
            title: first_title,
            ..
        }),
        Event::Start(Tag::Link {
            link_type: second_type,
            dest_url: second_dest,
            title: second_title,
            ..
        }),
    ) = (&events[first_start], &events[second_start])
    else {
        return false;
    };

    is_reference(*first_type)
        && is_reference(*second_type)
        && first_dest == second_dest
        && first_title == second_title
}

/// Whether a link type is `[n]` / `[n][]` rather than `[n](url)`.
fn is_reference(link_type: LinkType) -> bool {
    matches!(link_type, LinkType::Shortcut | LinkType::Collapsed)
}

/// Whether the two links render the same visible text.
fn same_visible_text(events: &[Event<'_>], first_start: usize, second_start: usize) -> bool {
    let first = visible_text(events, first_start);
    let second = visible_text(events, second_start);
    !first.is_empty() && first == second
}

/// Visible text of the link that starts at `start`, up to its `End`.
///
/// Only plain text and code spans count: anything else (emphasis, an image, a
/// nested link) makes the link uninteresting to the fold, and an empty string
/// is returned so the comparison fails.
fn visible_text(events: &[Event<'_>], start: usize) -> String {
    let mut text = String::new();
    for event in &events[start + 1..] {
        match event {
            Event::Text(value) | Event::Code(value) => text.push_str(value),
            Event::End(TagEnd::Link) => break,
            _ => return String::new(),
        }
    }
    text
}

/// Whether `event` is a text event holding exactly `literal`.
fn is_literal(event: &Event<'_>, literal: &str) -> bool {
    matches!(event, Event::Text(value) if value.as_ref() == literal)
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

    /// A document whose `[1]` and `[2]` are reference link definitions.
    fn citation_source(body: &str) -> String {
        format!("{body}\n\n[1]: https://example.com/1\n[2]: https://example.com/2\n")
    }

    #[test]
    fn bracketed_citation_collapses_to_one_link() {
        let doc = render_document(&citation_source("text[[1]][1] more"));

        assert_eq!(
            doc.html, "<p>text<a href=\"https://example.com/1\">[1]</a> more</p>\n",
            "html: {}",
            doc.html
        );
        assert_eq!(doc.html.matches("<a ").count(), 1, "one link only");
    }

    #[test]
    fn bracketed_citation_reads_as_a_citation_in_the_text() {
        let doc = render_document(&citation_source("text[[1]][1] more"));

        assert_eq!(doc.text, "text[1] more");
    }

    #[test]
    fn bracketed_citation_inside_a_table_cell_collapses() {
        let source = citation_source("| a | b |\n| - | - |\n| x[[1]][1] | y |");
        let doc = render_document(&source);

        assert!(
            doc.html
                .contains("<td>x<a href=\"https://example.com/1\">[1]</a></td>"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.html.matches("<a ").count(), 1);
        assert_eq!(doc.text, "a b x[1] y");
    }

    #[test]
    fn bracketed_citation_inside_a_heading_updates_text_and_anchor() {
        let doc = render_document(&citation_source("## Ref [[1]][1]"));

        assert!(
            doc.html
                .contains("<h2 id=\"ref-1\">Ref <a href=\"https://example.com/1\">[1]</a>"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.toc[0].text, "Ref [1]");
    }

    #[test]
    fn several_citations_in_one_paragraph_each_collapse() {
        let doc = render_document(&citation_source("a[[1]][1]b[[2]][2]c"));

        assert_eq!(
            doc.html,
            "<p>a<a href=\"https://example.com/1\">[1]</a>b<a href=\"https://example.com/2\">[2]</a>c</p>\n",
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, "a[1]b[2]c");
    }

    #[test]
    fn a_wrapped_link_without_its_duplicate_is_left_alone() {
        let doc = render_document(&citation_source("text[[1]] more"));

        assert!(
            doc.html
                .contains("text[<a href=\"https://example.com/1\">1</a>] more"),
            "html: {}",
            doc.html
        );
        assert_eq!(doc.text, "text[1] more");
    }

    #[test]
    fn adjacent_inline_links_are_not_folded() {
        let source = "[1](https://example.com)[1](https://example.com)\n";
        let doc = render_document(source);

        assert_eq!(
            doc.html,
            "<p><a href=\"https://example.com\">1</a><a href=\"https://example.com\">1</a></p>\n",
            "inline brackets are author syntax, not a wrap: {}",
            doc.html
        );
    }

    #[test]
    fn adjacent_reference_links_without_a_wrap_are_not_folded() {
        let doc = render_document(&citation_source("[1] [1]"));

        assert_eq!(doc.html.matches("<a ").count(), 2, "html: {}", doc.html);
    }

    #[test]
    fn an_undefined_reference_is_left_verbatim() {
        let doc = render_document("text[[1]][1] more\n");

        assert!(doc.html.contains("text[[1]][1] more"), "html: {}", doc.html);
    }

    #[test]
    fn citations_inside_code_are_never_folded() {
        let source = "`[[1]][1]`\n\n```\n[[1]][1]\n```\n\n[1]: https://example.com/1\n";
        let doc = render_document(source);

        assert!(
            doc.html.contains("<code>[[1]][1]</code>"),
            "html: {}",
            doc.html
        );
        assert!(!doc.html.contains("<a "), "html: {}", doc.html);
    }

    #[test]
    fn the_folded_citation_resolves_to_one_destination() {
        let mut recorder = Recorder::new();

        let doc = render_document_with(&citation_source("x[[1]][1]y"), &mut recorder);

        assert_eq!(
            recorder.seen,
            [("https://example.com/1".to_string(), 1)],
            "only the surviving link reaches the resolver"
        );
        assert_eq!(
            doc.html.matches("href=").count(),
            1,
            "the duplicate link must not survive: {}",
            doc.html
        );
    }

    #[test]
    fn a_pending_link_that_ends_a_paragraph_is_still_rewritten() {
        let mut recorder = Recorder::new();

        let doc = render_document_with(&citation_source("see [[1]]"), &mut recorder);

        assert_eq!(recorder.seen, [("https://example.com/1".to_string(), 1)]);
        assert_eq!(
            doc.html, "<p>see [<a href=\"rewritten:https://example.com/1\">1</a>]</p>\n",
            "html: {}",
            doc.html
        );
    }
}
