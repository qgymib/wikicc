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
