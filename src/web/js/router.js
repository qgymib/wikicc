/**
 * Hash routing for the wikicc reader.
 *
 * The route grammar is fixed by the build side (`src/markdown/links.rs`):
 *
 *     #/doc/<percent-encoded document id>[#<percent-encoded anchor>]
 *
 * Document ids are relative paths, so `/` is kept as a separator and every other
 * character is percent-encoded. Anchors are decoded on the way in and encoded on
 * the way out, which makes `#/doc/a.md#%E7%AC%AC` round-trip.
 *
 * Everything here is a pure function: no DOM, no history, no timers, so the
 * module can be imported by `node --test` as well as bundled into the page.
 */

/** Prefix every document route starts with. */
export const ROUTE_PREFIX = "#/doc/";

/**
 * Decode one route component, keeping the input when it is not valid
 * percent-encoding. A malformed hash must never throw while routing.
 */
export function decodePart(text) {
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

/** Percent-encode a document id while keeping its folder separators. */
export function encodeId(id) {
  var value = String(id === null || id === undefined ? "" : id);
  return value
    .split("/")
    .map(function (segment) {
      return encodeURIComponent(segment);
    })
    .join("/");
}

/**
 * Split a hash into the document id and the anchor.
 *
 * Returns `{ id: null, anchor: null }` for anything that is not a document
 * route, including a bare `#anchor` and an empty hash.
 */
export function parseHash(hash) {
  var raw = String(hash === null || hash === undefined ? "" : hash);
  var body = raw.charAt(0) === "#" ? raw.slice(1) : raw;

  if (body.slice(0, 5) !== "/doc/") {
    return { id: null, anchor: null };
  }

  var rest = body.slice(5);
  var split = rest.indexOf("#");
  var path = split === -1 ? rest : rest.slice(0, split);
  var anchor = split === -1 ? "" : rest.slice(split + 1);

  return {
    id: path ? decodePart(path) : null,
    anchor: anchor ? decodePart(anchor) : null,
  };
}

/** Build the canonical hash for a document and an optional anchor. */
export function formatHash(id, anchor) {
  var hash = ROUTE_PREFIX + encodeId(id);
  if (anchor) {
    hash += "#" + encodeURIComponent(String(anchor).replace(/^#/, ""));
  }
  return hash;
}

/**
 * Resolve a hash against the known document ids.
 *
 * An unknown id falls back to the first document, as does an empty hash; the
 * `known` flag lets the caller decide whether the address bar should be
 * rewritten without guessing.
 */
export function resolveRoute(hash, ids) {
  var route = parseHash(hash);
  var list = Array.isArray(ids) ? ids : [];
  var known = route.id !== null && list.indexOf(route.id) !== -1;

  if (known) {
    return { id: route.id, anchor: route.anchor, known: true };
  }

  return { id: list.length ? list[0] : null, anchor: null, known: false };
}
