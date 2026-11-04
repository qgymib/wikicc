/**
 * Full-text search over the document list.
 *
 * The engine is MiniSearch, imported from the npm dependency declared in
 * `package.json` and bundled into the page by `build.rs`, so this file is a thin
 * adapter rather than a hand-written scorer. What the adapter adds:
 *
 * - a tokenizer that segments CJK text with `Intl.Segmenter`, because the
 *   engine's default tokenizer only splits on spaces and punctuation and would
 *   index a whole Chinese paragraph as one token;
 * - the field set (`title`, `headings`, `text`) and their weights, so a title
 *   hit outranks a heading hit, which outranks a body hit;
 * - `combineWith: "AND"`, so every word of a multi-word query has to match.
 *
 * Alongside the index it owns the *context* of a hit: `matchSnippet` cuts the
 * text around the first place a term really appears, and `occurrences` pairs
 * one such cut with every place the query occurs in every ranked document.
 * both have to read like the reader's own text, so they are found by scanning
 * the source string rather than taken from the engine's internal match data,
 * which knows offsets only within its own token stream.
 *
 * The module never touches the DOM and can be imported from `node --test`.
 */
import MiniSearch from "minisearch";

/**
 * Word segmenter used for every indexed and queried string.
 *
 * `Intl.Segmenter` is available in every browser the reader targets and in
 * Node; the fallback keeps older engines working with the upstream default
 * (split on Unicode spaces and punctuation).
 */
var SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/** Split text into search terms, dropping punctuation and whitespace. */
export function tokenize(text) {
  var value = String(text === null || text === undefined ? "" : text);
  if (!value) {
    return [];
  }

  if (SEGMENTER) {
    var tokens = [];
    var segments = SEGMENTER.segment(value);
    for (var segment of segments) {
      if (segment.isWordLike) {
        tokens.push(segment.segment);
      }
    }
    return tokens;
  }

  return value.split(/[\s\p{P}]+/u).filter(Boolean);
}

/** Flatten the outline into one searchable string. */
export function headingsText(toc) {
  var parts = [];

  function walk(entries) {
    if (!Array.isArray(entries)) {
      return;
    }
    entries.forEach(function (entry) {
      if (!entry) {
        return;
      }
      if (entry.text) {
        parts.push(entry.text);
      }
      walk(entry.children);
    });
  }

  walk(toc);
  return parts.join(" ");
}

/**
 * Build a search index over the payload documents.
 *
 * Documents are added in payload order, so equal scores keep that order when
 * results are sorted, which keeps the filtered list deterministic.
 */
export function createSearch(docs) {
  var index = new MiniSearch({
    idField: "id",
    fields: ["title", "headings", "text"],
    storeFields: ["id"],
    tokenize: tokenize,
    searchOptions: {
      boost: { title: 4, headings: 2 },
      prefix: true,
      combineWith: "AND",
    },
  });

  index.addAll(
    (docs || []).map(function (doc) {
      return {
        id: doc.id,
        title: doc.title || "",
        headings: headingsText(doc.toc),
        text: doc.text || "",
      };
    }),
  );

  return index;
}

/**
 * Ids matching `query`, best match first.
 *
 * Returns `null` for an empty query, which the caller reads as "no filter"
 * rather than "nothing matches".
 */
export function search(index, query) {
  var value = String(query === null || query === undefined ? "" : query).trim();
  if (!value) {
    return null;
  }

  return index.search(value).map(function (result) {
    return result.id;
  });
}

/* ---------- context around a hit ---------- */

/** Characters of text kept on each side of a hit, before the ellipsis. */
export var SNIPPET_RADIUS = 40;

/** Stands in for text a snippet had to drop. */
export var ELLIPSIS = "\u2026";

/**
 * A character a word does not run through: one that belongs to no word.
 *
 * Whitespace, punctuation, symbols and the ideographic characters a Chinese
 * sentence is written without spaces between. They delimit words just as a
 * space does, so a prefix match must not reach across one — and note that `<`
 * and `>` are symbols rather than punctuation, which is why a query "bold"
 * must be told it does not start at the "b" of "<b>".
 */
var VALUE_END = /^[\s\p{P}\p{S}\p{Ideographic}]$/u;

/**
 * The query split into the terms a snippet is searched for.
 *
 * The engine matches a document when *every* word of the query appears in it
 * (`combineWith: "AND"`), so any one term is a place a context can start. The
 * terms go through `tokenize`, which is also what the index was built with, so
 * a Chinese query is searched for its words and never for a whole paragraph.
 *
 * The comparison itself ignores case without lowercasing anything: see
 * `matchesAt`.
 */
export function terms(query) {
  return tokenize(query);
}

/**
 * Whether `needle` starts at `index` in `haystack`, ignoring case.
 *
 * Compared character by character instead of through a lowercase copy of the
 * whole string: lowercasing can change a string's length (the Turkish "İ"
 * becomes two code points), which would move every later offset.
 */
function matchesAt(haystack, index, needle) {
  for (var offset = 0; offset < needle.length; offset += 1) {
    var left = haystack.charAt(index + offset);
    var right = needle.charAt(offset);
    if (left.toLowerCase() !== right.toLowerCase()) {
      return false;
    }
  }

  return true;
}

/**
 * Whether a word can start at `index`.
 *
 * A word starts where nothing continues it: at the beginning of the text, or
 * after a space, a punctuation mark or a symbol. Without that test a query
 * "cat" would "hit" the middle of "concatenate" and the snippet would point at
 * a place the reader never asked about.
 */
function startsWord(text, index) {
  if (index === 0) {
    return true;
  }

  // A surrogate pair is one character and cannot be split: stepping into the
  // middle of one would make the test see half a character and never a break.
  var before = index >= 2 && isLowSurrogate(text.charCodeAt(index - 1)) ? index - 2 : index - 1;
  return VALUE_END.test(String.fromCodePoint(text.codePointAt(before)));
}

/** Whether a UTF-16 unit is the second half of a surrogate pair. */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The character at `index` of `text`, or `""` past its end.
 *
 * A single UTF-16 unit is a character of a regular expression only when it is
 * a whole code point: a lone surrogate half cannot be retyped through `\u`,
 * and a character outside the BMP is two units and has to be taken together.
 */
function codePointAt(text, index) {
  if (index >= text.length) {
    return "";
  }

  var code = text.codePointAt(index);
  return String.fromCodePoint(code);
}

/**
 * Where `term` is first found in `text` as a whole word or the start of one.
 *
 * A word the reader typed exactly wins over a longer word it merely begins —
 * "cat" finds "cat" before "catalogue" — because a snippet then shows the word
 * as written. Words are compared in the order they appear, so the earliest
 * hit of one term is taken whichever pass found it.
 *
 * Prefix matching mirrors the engine's `prefix: true`: a query "introd" is a
 * hit on "introduction" in the index, so it has to be a hit here too, or a
 * result would be listed with no context to show for it. `whole` restricts
 * the search to complete words, which is the first pass. `from` is where the
 * scan may start, so a caller walking the text for every hit does not pay for
 * the part it has already passed; the word boundary is still judged against
 * the whole text, which is what a cut string would get wrong.
 */
function indexOfTerm(text, term, whole, from) {
  if (!term) {
    return -1;
  }

  var fallback = -1;
  for (var start = Math.max(0, from || 0); start + term.length <= text.length; start += 1) {
    if (!matchesAt(text, start, term) || !startsWord(text, start)) {
      continue;
    }

    var end = start + term.length;
    if (!whole || end === text.length || VALUE_END.test(String.fromCodePoint(text.codePointAt(end)))) {
      return start;
    }
    if (fallback === -1) {
      fallback = start;
    }
  }

  return whole ? -1 : fallback;
}

/**
 * The most literal hit of `query` in `text`, as `{ start, length }`, or `null`.
 *
 * The earliest exact hit of any term is chosen first, so a snippet shows a
 * word the reader typed as typed; only when no term appears as a whole word
 * does the prefix pass run, and then only for queries the engine would have
 * matched that way. The returned length is the whole word the hit begins, so a
 * prefix hit is highlighted as the word it stands for, not as its fragment.
 */
function locate(text, query) {
  var haystack = String(text === null || text === undefined ? "" : text);
  var words = terms(query);
  var best = null;

  function consider(whole) {
    words.forEach(function (term) {
      var start = indexOfTerm(haystack, term, whole);
      if (start === -1) {
        return;
      }
      if (
        best === null ||
        start < best.start ||
        (start === best.start && term.length > best.length)
      ) {
        best = { start: start, length: term.length };
      }
    });
  }

  consider(true);
  if (best) {
    return best;
  }

  consider(false);
  if (!best) {
    return null;
  }

  // Widen a prefix hit to the word it starts, so highlighting matches what the
  // reader sees instead of stopping mid-word. The parameter is a code point
  // rather than a UTF-16 unit: a surrogate half would be retyped as U+FFFD,
  // and a character outside the BMP would never look like a break.
  var end = best.start + best.length;
  var code = codePointAt(haystack, end);
  while (code && !VALUE_END.test(code)) {
    end += code.length;
    code = codePointAt(haystack, end);
  }

  return { start: best.start, length: end - best.start };
}

/**
 * Every hit of `query` in `text`, as `{ start, length }`, sorted and disjoint.
 *
 * The search panel reads a whole document now, so the reader sees every place
 * the words appear rather than one cut-out paragraph; this is that list. The
 * rules are `locate`'s, applied over and over: a hit starts at a word
 * boundary, matches case-insensitively, and a prefix hit is widened to the
 * word it begins — so what is highlighted here reads exactly like the context
 * the same query produced in the result list.
 *
 * Overlaps are merged rather than nested: a word can begin inside a longer
 * word already highlighted ("cat" inside "catalogue" that "cata" began), and
 * two highlights on one character would mean either nested `<mark>` elements
 * or one highlight shortened. Merging keeps the list usable as a set of
 * character ranges, which is what the caller walks.
 *
 * The scan advances past each hit rather than one character at a time, so a
 * word repeated a thousand times costs a thousand steps, not a thousand times
 * the length of the text.
 */
export function matchRanges(text, query) {
  var value = String(text === null || text === undefined ? "" : text);
  var words = terms(query);
  if (!value || !words.length) {
    return [];
  }

  var found = [];
  var from = 0;

  while (from < value.length) {
    var hit = locateFrom(value, words, from);
    if (!hit) {
      break;
    }

    var previous = found.length ? found[found.length - 1] : null;
    if (previous && hit.start < previous.start + previous.length) {
      // The new hit begins inside the one before it: the earlier range grows
      // to cover both, so no character is highlighted twice.
      previous.length = Math.max(previous.length, hit.start + hit.length - previous.start);
    } else {
      found.push(hit);
    }

    from = hit.start + hit.length;
  }

  return found;
}

/**
 * The earliest hit of any of `words` in `value` at or after `from`.
 *
 * Only positions the scan has not passed are considered, which is what lets
 * `matchRanges` consume the text once instead of re-scanning it per hit. The
 * scan runs over the whole text and simply ignores the part before `from`:
 * cutting the text at `from` first would make its first character look like
 * the start of a word, and a word hidden at a cut — "intro" in "intro", when
 * the scan has already passed the "o" — would then be found inside a longer
 * word and highlighted as though the author had written it.
 *
 * The widening to the whole word runs only on the first pass: a larger
 * `whole` flag means "hit must be a complete word", so the end is not touched.
 */
function locateFrom(value, words, from) {
  var best = null;

  function consider(whole) {
    words.forEach(function (term) {
      var start = indexOfTerm(value, term, whole, from);
      if (start === -1) {
        return;
      }
      if (
        best === null ||
        start < best.start ||
        (start === best.start && term.length > best.length)
      ) {
        best = { start: start, length: term.length };
      }
    });
  }

  consider(true);
  if (best) {
    return best;
  }

  consider(false);
  if (!best) {
    return null;
  }

  var end = best.start + best.length;
  var code = codePointAt(value, end);
  while (code && !VALUE_END.test(code)) {
    end += code.length;
    code = codePointAt(value, end);
  }

  return { start: best.start, length: end - best.start };
}

/**
 * The text around the first hit of `query` in `text`.
 *
 * Returns `{ before, hit, after, trimmedStart, trimmedEnd }` or `null` when the
 * text holds no hit at all — a document matched on its title only, for
 * instance. The three parts are separate strings so the caller can wrap the
 * middle one in an element of its own without ever building markup out of
 * document text: the snippet is assembled from text nodes, never from HTML.
 *
 * The two flags say whether text was dropped at that end, which is what the
 * caller draws as an ellipsis. They are kept apart from the text itself so a
 * document that really contains "\u2026" cannot be confused with a truncation.
 *
 * `options.radius` is how many characters are kept on each side.
 */
export function matchSnippet(text, query, options) {
  var value = String(text === null || text === undefined ? "" : text);
  var found = locate(value, query);
  if (!found) {
    return null;
  }

  return cutAround(value, found.start, found.length, options);
}

/**
 * The text around the range that begins at `start` and runs `length` far.
 *
 * `matchSnippet` finds its range and cuts around it; `occurrences` is handed
 * the ranges already — one per place the query occurs — and cuts around each,
 * so the cut lives here for both. It is the same cut whatever the caller: a
 * window of `radius` characters on each side, moved to a word boundary where
 * one is close enough to reach, with the two flags saying whether text was
 * dropped at that end.
 */
function cutAround(text, start, length, options) {
  var radius =
    options && typeof options.radius === "number" ? Math.max(0, options.radius) : SNIPPET_RADIUS;

  var end = start + length;
  var from = Math.max(0, start - radius);
  var to = Math.min(text.length, end + radius);

  // A window that begins or ends inside a word would read as a typo, so the
  // cut moves to the word boundary when one is close enough to reach — and
  // only then: a window with no space in it is already a whole number of
  // words, however it was measured, so it is kept as it is.
  if (from > 0) {
    var space = text.slice(from, start).search(/\s/);
    if (space !== -1) {
      from += space + 1;
    }
  }
  if (to < text.length) {
    var endSpace = text.slice(end, to).search(/\s\S*$/);
    if (endSpace !== -1) {
      to = end + endSpace;
    }
  }

  return {
    before: text.slice(from, start),
    hit: text.slice(start, end),
    after: text.slice(end, to),
    trimmedStart: from > 0,
    trimmedEnd: to < text.length,
  };
}

/**
 * One entry per place the query occurs: the document, the passage around that
 * place, and which occurrence of the document it is.
 *
 * `docs` is the payload's document list and `ids` the ids the engine ranked, in
 * that order — the result list shows the engine's ranking, never a re-sort of
 * its own, and the hits of one document stay together: a document ranked first
 * lists all its hits before the next document's first. Within a document the
 * entries follow the body's own order, `hit` counting the occurrences from
 * zero, which is what lets the preview scroll to the place a row describes.
 *
 * The list is never truncated: the reader asked for every place the words
 * appear, and enumerating them is one linear scan of each ranked document's
 * text. A document with no hit in its body but one in its title or outline is
 * still listed once, as `hit: -1` — no body occurrence to scroll to — with a
 * context cut from the outline, or a `null` snippet when only the title
 * matched and the caller shows the path instead.
 */
export function occurrences(docs, ids, query, options) {
  var byId = new Map();
  (docs || []).forEach(function (doc) {
    byId.set(doc.id, doc);
  });

  var entries = [];

  (ids || []).forEach(function (id) {
    var doc = byId.get(id);
    if (!doc) {
      return;
    }

    var body = String(doc.text || "");
    var ranges = matchRanges(body, query);
    if (!ranges.length) {
      // The outline is part of what the engine indexes, so a hit there is a
      // hit worth showing; it is searched only after the body, which reads
      // better as a context than a list of headings.
      entries.push({
        id: doc.id,
        title: doc.title || doc.id,
        path: doc.id,
        snippet: matchSnippet(headingsText(doc.toc), query, options),
        hit: -1,
      });
      return;
    }

    ranges.forEach(function (range, index) {
      entries.push({
        id: doc.id,
        title: doc.title || doc.id,
        path: doc.id,
        snippet: cutAround(body, range.start, range.length, options),
        hit: index,
      });
    });
  });

  return entries;
}
