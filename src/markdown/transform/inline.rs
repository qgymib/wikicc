//! Inline sugar: Typora's highlight, subscript, superscript, comments, tags
//! and emoji shortcodes.
//!
//! None of these are parser constructs, so they arrive inside `Text` runs:
//! `==like this==`, `H~2~O`, `X^2^`, `%%hidden%%`, `#tag`, `:smile:`. This
//! pass matches the delimited runs and rewrites them into the typed nodes
//! the serialiser renders — the same children-array technique the fold
//! uses, so sugar composes with emphasis, links and code exactly where the
//! author wrote it (`==**bold**==` wraps the strong, `a ~b~ c` leaves the
//! spaces out of the subscript).
//!
//! Single-tilde strikethrough is off in the parser, so a lone `~` in a text
//! run is always ours to claim; `~~double~~` already arrived as a `Delete`
//! node and is never touched. Sub- and superscript follow Typora's rule that
//! the content may not begin or end with whitespace, so `a ~ b ~ c` stays
//! literal. `%%…%%` renders nothing: the run is dropped, comments included.
//!
//! Tags follow Obsidian's word-boundary rule: a `#` at the start of the run
//! or after whitespace, followed by letters, digits, `_`, `-` or `/`, and
//! not purely numeric (`#1` stays literal, `#v1` is a tag). Shortcodes are
//! `:name:` runs looked up in a built-in table; an unknown name stays
//! literal text.

use super::super::ast::{OwnKind, OwnNode, walk_blocks};

/// A recognised delimiter pair and what it becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Delimiter {
    /// `==…==` → `<mark>…</mark>`
    Highlight,
    /// `%%…%%` → nothing
    Comment,
    /// `~…~` → `<sub>…</sub>`
    Sub,
    /// `^…^` → `<sup>…</sup>`
    Sup,
}

impl Delimiter {
    /// The opening and closing spelling.
    fn spelling(self) -> &'static str {
        match self {
            Delimiter::Highlight => "==",
            Delimiter::Comment => "%%",
            Delimiter::Sub => "~",
            Delimiter::Sup => "^",
        }
    }

    /// Whether the content may not begin or end with whitespace.
    fn needs_tight_content(self) -> bool {
        matches!(self, Delimiter::Sub | Delimiter::Sup)
    }
}

/// The delimiters, each scanned over the whole run in turn.
const DELIMITERS: [Delimiter; 4] = [
    Delimiter::Highlight,
    Delimiter::Comment,
    Delimiter::Sub,
    Delimiter::Sup,
];

/// Run the inline sugar over the whole document.
pub(crate) fn run(root: &mut OwnNode) {
    walk_blocks(root, &mut |children| sugar_runs(children));
}

/// Apply the sugar to one run of phrasing content.
fn sugar_runs(children: &mut Vec<OwnNode>) {
    // Delimited runs first: they can span nodes, and the text they leave
    // behind is what tags and shortcodes are then matched in.
    for delimiter in DELIMITERS {
        expand_delimiter(children, delimiter);
    }
    expand_marks(children);
}

/// Claim every `delimiter` pair in the run, however often it occurs.
fn expand_delimiter(children: &mut Vec<OwnNode>, delimiter: Delimiter) {
    let mut index = 0;
    while index < children.len() {
        if claim_at(children, index, delimiter) {
            // One pair was claimed; rescan from the same position, since the
            // text that replaced the pair may hold or precede another one.
            continue;
        }
        index += 1;
    }
}

/// Whether a pair of `delimiter` claims the run starting at `index`.
///
/// A pair sits either inside one text run (`==a==`) or spans from the tail
/// of a text run across any inline nodes to the head of a later text run
/// (`a ==**b**== c`). Comments claim the same shapes and render nothing.
fn claim_at(children: &mut Vec<OwnNode>, index: usize, delimiter: Delimiter) -> bool {
    let line = children[index].line;
    let spelling = delimiter.spelling();

    // Case 1: the whole pair inside one text run.
    let within = match &children[index].kind {
        OwnKind::Text(value) => delimit_within(value, delimiter, line),
        _ => None,
    };
    if let Some(claimed) = within {
        children.splice(index..index + 1, claimed);
        return true;
    }

    // Case 2: the opening at the tail of a text run (`a ==b==`).
    let OwnKind::Text(opening) = &children[index].kind else {
        return false;
    };
    let Some(open_prefix) = opening.strip_suffix(spelling) else {
        return false;
    };
    if delimiter.needs_tight_content()
        && open_prefix.chars().last().is_some_and(char::is_whitespace)
    {
        return false;
    }
    let open_prefix = open_prefix.to_string();

    // The closing sits at the head of a later text run; non-text inline
    // nodes in between are spanned, but a text run that neither opens nor
    // closes ends the search — the pair would have to span over real text,
    // which no author means.
    let mut closing: Option<(usize, String)> = None;
    for (close, node) in children.iter().enumerate().skip(index + 1) {
        let OwnKind::Text(value) = &node.kind else {
            continue;
        };
        match value.strip_prefix(spelling) {
            Some(suffix) => {
                if delimiter.needs_tight_content()
                    && suffix.chars().next().is_some_and(char::is_whitespace)
                {
                    return false;
                }
                closing = Some((close, suffix.to_string()));
                break;
            }
            None => {
                if !value.is_empty() {
                    return false;
                }
            }
        }
    }
    let Some((close, close_suffix)) = closing else {
        return false;
    };

    // Splice: opening prefix, wrapped middle, closing suffix.
    let mut inner: Vec<OwnNode> = Vec::new();
    if !open_prefix.is_empty() {
        inner.push(OwnNode::new(line, OwnKind::Text(open_prefix)));
    }
    inner.extend(children.drain(index + 1..close));
    if !close_suffix.is_empty() {
        inner.push(OwnNode::new(line, OwnKind::Text(close_suffix)));
    }

    let replacement: Vec<OwnNode> = match delimiter {
        Delimiter::Comment => Vec::new(),
        Delimiter::Highlight => vec![OwnNode::new(line, OwnKind::Highlight(inner))],
        Delimiter::Sub => vec![OwnNode::new(line, OwnKind::Sub(inner))],
        Delimiter::Sup => vec![OwnNode::new(line, OwnKind::Sup(inner))],
    };
    children.splice(index..index + 1, replacement);
    true
}

/// Split a text run at its first `delimiter` pair, if it has one.
///
/// The content between the pair is wrapped; the text before and after stays
/// literal. The content of a wrapper is matched again by the caller's walk,
/// so nested sugar (`==a~b~c==`) lands one level down.
fn delimit_within(value: &str, delimiter: Delimiter, line: usize) -> Option<Vec<OwnNode>> {
    let spelling = delimiter.spelling();
    let open = value.find(spelling)?;
    let content_start = open + spelling.len();
    let close = value[content_start..].find(spelling)? + content_start;
    let content = &value[content_start..close];

    if content.is_empty()
        || (delimiter.needs_tight_content()
            && (content.starts_with(char::is_whitespace) || content.ends_with(char::is_whitespace)))
    {
        return None;
    }

    let before = value[..open].to_string();
    let after = value[close + spelling.len()..].to_string();
    let content = OwnNode::new(line, OwnKind::Text(content.to_string()));
    let wrapped = match delimiter {
        Delimiter::Comment => None,
        Delimiter::Highlight => Some(OwnKind::Highlight(vec![content])),
        Delimiter::Sub => Some(OwnKind::Sub(vec![content])),
        Delimiter::Sup => Some(OwnKind::Sup(vec![content])),
    };

    let mut nodes = Vec::new();
    if !before.is_empty() {
        nodes.push(OwnNode::new(line, OwnKind::Text(before)));
    }
    nodes.extend(wrapped.map(|kind| OwnNode::new(line, kind)));
    if !after.is_empty() {
        nodes.push(OwnNode::new(line, OwnKind::Text(after)));
    }
    Some(nodes)
}

/// Claim tags and shortcodes inside every text run of the array.
fn expand_marks(children: &mut Vec<OwnNode>) {
    let mut index = 0;
    while index < children.len() {
        let line = children[index].line;
        let marks = match &children[index].kind {
            OwnKind::Text(value) => marks_within(value, line),
            _ => None,
        };
        match marks {
            Some(replacement) => {
                let count = replacement.len();
                children.splice(index..index + 1, replacement);
                index += count;
            }
            None => index += 1,
        }
    }
}

/// Split a text run into literals, tags and shortcodes.
fn marks_within(value: &str, line: usize) -> Option<Vec<OwnNode>> {
    let mut nodes: Vec<OwnNode> = Vec::new();
    let mut literal = String::new();
    let mut byte_position = 0;
    let mut claimed = false;

    while let Some(character) = value[byte_position..].chars().next() {
        let rest = &value[byte_position + character.len_utf8()..];
        let boundary = byte_position == 0 || value[..byte_position].ends_with(char::is_whitespace);

        if character == '#'
            && boundary
            && let Some(tag) = tag_at(rest)
        {
            push_literal(&mut nodes, &mut literal, line);
            nodes.push(OwnNode::new(line, OwnKind::Tag(tag.to_string())));
            byte_position += 1 + tag.len();
            claimed = true;
            continue;
        }

        if character == ':'
            && let Some((name, emoji)) = shortcode_at(rest)
        {
            let consumed = 1 + name.len() + 1;
            push_literal(&mut nodes, &mut literal, line);
            nodes.push(OwnNode::new(line, OwnKind::Shortcode { name, emoji }));
            byte_position += consumed;
            claimed = true;
            continue;
        }

        literal.push(character);
        byte_position += character.len_utf8();
    }

    if !claimed {
        return None;
    }
    push_literal(&mut nodes, &mut literal, line);
    Some(nodes)
}

/// Push a pending literal run, if any.
fn push_literal(nodes: &mut Vec<OwnNode>, literal: &mut String, line: usize) {
    if !literal.is_empty() {
        nodes.push(OwnNode::new(line, OwnKind::Text(std::mem::take(literal))));
    }
}

/// The tag that starts in `rest`, if it is a well-formed one.
fn tag_at(rest: &str) -> Option<&str> {
    let end = rest
        .char_indices()
        .find(|(_, character)| !is_tag_character(*character))
        .map(|(index, _)| index)
        .unwrap_or(rest.len());
    let name = &rest[..end];

    if name.is_empty() || name.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(name)
}

/// Whether `character` can appear in a tag name.
fn is_tag_character(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '-' | '/')
}

/// The shortcode that starts in `rest`, resolved through the built-in table.
fn shortcode_at(rest: &str) -> Option<(String, char)> {
    let end = rest
        .char_indices()
        .find(|(_, character)| !is_shortcode_character(*character))
        .map(|(index, _)| index)
        .unwrap_or(rest.len());
    let name = &rest[..end];
    let closing = rest[end..].chars().next()?;

    if closing != ':' || name.is_empty() {
        return None;
    }
    let emoji = shortcode_emoji(name)?;
    Some((name.to_string(), emoji))
}

/// Whether `character` can appear in a shortcode name.
fn is_shortcode_character(character: char) -> bool {
    character.is_ascii_lowercase()
        || character.is_ascii_digit()
        || matches!(character, '_' | '+' | '-')
}

/// The emoji a shortcode name stands for.
///
/// The table covers the shortcodes that show up in everyday documents;
/// unknown names stay literal text rather than rendering as nothing.
fn shortcode_emoji(name: &str) -> Option<char> {
    let emoji = match name {
        "smile" => '😄',
        "smiley" => '😃',
        "laughing" | "lol" => '😆',
        "grin" => '😁',
        "wink" => '😉',
        "blush" => '😊',
        "slightly_smiling_face" => '🙂',
        "upside_down_face" => '🙃',
        "relieved" => '😌',
        "heart_eyes" => '😍',
        "kissing_heart" => '😘',
        "joy" => '😂',
        "sweat_smile" => '😅',
        "thinking" => '🤔',
        "neutral_face" => '😐',
        "expressionless" => '😑',
        "no_mouth" => '😶',
        "smirk" => '😏',
        "unamused" => '😒',
        "disappointed" => '😞',
        "pensive" => '😔',
        "confused" => '😕',
        "sunglasses" => '😎',
        "innocent" => '😇',
        "nerd_face" => '🤓',
        "star_struck" => '🤩',
        "zany_face" => '🤪',
        "sleeping" => '😴',
        "rocket" => '🚀',
        "tada" => '🎉',
        "sparkles" => '✨',
        "star" => '⭐',
        "fire" => '🔥',
        "heart" => '❤',
        "broken_heart" => '💔',
        "warning" => '⚠',
        "zap" => '⚡',
        "bulb" => '💡',
        "thumbsup" | "+1" => '👍',
        "thumbsdown" | "-1" => '👎',
        "ok_hand" => '👌',
        "clap" => '👏',
        "wave" => '👋',
        "pray" => '🙏',
        "muscle" => '💪',
        "point_right" => '👉',
        "eyes" => '👀',
        "100" => '💯',
        "bug" => '🐛',
        "memo" => '📝',
        "book" => '📖',
        "books" => '📚',
        "pencil" => '✏',
        "pushpin" => '📌',
        "link" => '🔗',
        "lock" => '🔒',
        "key" => '🔑',
        "hammer" => '🔨',
        "wrench" => '🔧',
        "gear" => '⚙',
        "mag" => '🔍',
        "chart_with_upwards_trend" => '📈',
        "bar_chart" => '📊',
        "calendar" => '📅',
        "clock" => '🕒',
        "hourglass" => '⌛',
        "computer" => '💻',
        "iphone" => '📱',
        "email" | "envelope" => '✉',
        "package" => '📦',
        "coffee" => '☕',
        "beer" => '🍺',
        "pizza" => '🍕',
        "apple" => '🍎',
        "cake" => '🎂',
        "sun" => '☀',
        "cloud" => '☁',
        "umbrella" => '☔',
        "snowflake" => '❄',
        "rainbow" => '🌈',
        "seedling" => '🌱',
        "dog" => '🐶',
        "cat" => '🐱',
        "bird" => '🐦',
        "fish" => '🐟',
        "house" => '🏠',
        "airplane" => '✈',
        "car" => '🚗',
        "bell" => '🔔',
        "musical_note" => '🎵',
        "trophy" => '🏆',
        "soccer" => '⚽',
        "dart" => '🎯',
        "gift" => '🎁',
        "crown" => '👑',
        "gem" => '💎',
        "speech_balloon" => '💬',
        "bomb" => '💣',
        "boom" | "collision" => '💥',
        "ghost" => '👻',
        "skull" => '💀',
        "alien" => '👽',
        "robot" => '🤖',
        "earth_asia" => '🌏',
        "white_check_mark" => '✅',
        "x" => '❌',
        "question" => '❓',
        "exclamation" => '❗',
        "arrow_right" => '➡',
        "arrow_left" => '⬅',
        "arrow_up" => '⬆',
        "arrow_down" => '⬇',
        "rewind" => '⏪',
        "fast_forward" => '⏩',
        "arrows_counterclockwise" => '🔄',
        "repeat" => '🔁',
        "clipboard" => '📋',
        "file_folder" => '📁',
        "page_facing_up" => '📄',
        "newspaper" => '📰',
        "notebook" => '📓',
        _ => return None,
    };
    Some(emoji)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::ast::to_own;
    use crate::markdown::parse::parse_document;
    use crate::markdown::refdefs;

    /// The first paragraph's children after the full transform chain.
    fn shapes(source: &str) -> Vec<String> {
        let mut own = to_own(&parse_document(source));
        let table = refdefs::collect(&own);
        crate::markdown::transform::fold::run(&mut own, &table);
        crate::markdown::transform::wikilink::run(&mut own, &table);
        run(&mut own);

        let OwnKind::Root(children) = &own.kind else {
            panic!("a document is a root");
        };
        let Some(OwnKind::Paragraph(paragraph)) = children.first().map(|node| &node.kind) else {
            panic!("the document opens with a paragraph: {:?}", own.kind);
        };
        paragraph
            .iter()
            .map(|node| format!("{:?}", node.kind))
            .collect()
    }

    #[test]
    fn highlight_claims_a_pair_in_one_run() {
        let shapes = shapes("a ==mark== b\n");

        assert!(
            shapes.iter().any(|shape| shape.contains("Highlight")),
            "{shapes:?}"
        );
        assert_eq!(
            shapes
                .iter()
                .filter(|shape| shape.contains("Text(\"a \")") || shape.contains("Text(\" b\")"))
                .count(),
            2,
            "the surrounding text stays: {shapes:?}"
        );
    }

    #[test]
    fn two_pairs_in_one_run_each_get_claimed() {
        let shapes = shapes("==a== and ==b==\n");

        assert_eq!(
            shapes
                .iter()
                .filter(|shape| shape.contains("Highlight"))
                .count(),
            2,
            "{shapes:?}"
        );
    }

    #[test]
    fn a_pair_can_span_across_emphasis() {
        let shapes = shapes("a ==**b**== c\n");

        assert!(
            shapes.iter().any(|shape| shape.contains("Highlight")),
            "{shapes:?}"
        );
        assert!(
            shapes.iter().any(|shape| shape.contains("Strong")),
            "{shapes:?}"
        );
    }

    #[test]
    fn sugar_nests_one_level_down() {
        let shapes = shapes("==a~x~b==\n");

        assert!(
            shapes.iter().any(|shape| shape.contains("Highlight")),
            "{shapes:?}"
        );
        assert!(
            shapes.iter().any(|shape| shape.contains("Sub")),
            "{shapes:?}"
        );
    }

    #[test]
    fn subscript_and_superscript_need_tight_content() {
        assert!(shapes("H~2~O\n").iter().any(|shape| shape.contains("Sub")));
        assert!(shapes("x^2^\n").iter().any(|shape| shape.contains("Sup")));
        assert!(
            !shapes("a ~ b ~ c\n")
                .iter()
                .any(|shape| shape.contains("Sub")),
            "spaced tildes stay literal"
        );
    }

    #[test]
    fn double_tilde_reaches_the_pass_as_delete_and_stays_one() {
        assert!(
            !shapes("~~old~~\n")
                .iter()
                .any(|shape| shape.contains("Sub")),
            "gfm strikethrough owns the double tilde"
        );
    }

    #[test]
    fn comments_render_nothing_but_keep_their_surroundings() {
        let shapes = shapes("a %%hidden%% b\n");

        assert!(
            shapes.iter().all(|shape| !shape.contains("hidden")),
            "{shapes:?}"
        );
        assert!(shapes.contains(&"Text(\"a \")".to_string()));
        assert!(shapes.contains(&"Text(\" b\")".to_string()));
    }

    #[test]
    fn a_comment_can_span_across_emphasis() {
        let shapes = shapes("a %%**b**%% c\n");

        assert!(
            !shapes.iter().any(|shape| shape.contains("Strong")),
            "{shapes:?}"
        );
    }

    #[test]
    fn tags_follow_the_word_boundary_rule() {
        let shapes = shapes("#v2 and #10 and x#tag\n");

        assert_eq!(
            shapes.iter().filter(|shape| shape.contains("Tag")).count(),
            1,
            "{shapes:?}"
        );
        assert!(
            shapes.iter().any(|shape| shape.contains("Tag(\"v2\")")),
            "{shapes:?}"
        );
    }

    #[test]
    fn nested_tags_are_one_tag() {
        let shapes = shapes("#a/b\n");

        assert!(
            shapes.iter().any(|shape| shape.contains("Tag(\"a/b\")")),
            "{shapes:?}"
        );
    }

    #[test]
    fn shortcodes_resolve_known_names_only() {
        let shapes = shapes(":smile: and :not_a_shortcode:\n");

        assert!(shapes.iter().any(|shape| shape.contains("Shortcode")));
        assert!(
            shapes.iter().any(|shape| shape.contains("not_a_shortcode")),
            "unknown names stay literal: {shapes:?}"
        );
    }

    #[test]
    fn sugar_never_touches_code() {
        let shapes = shapes("`==a==`\n");

        assert!(shapes.iter().any(|shape| shape.contains("InlineCode")));
        assert!(
            shapes.iter().all(|shape| !shape.contains("Highlight")),
            "{shapes:?}"
        );
    }
}
