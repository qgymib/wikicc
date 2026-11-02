/**
 * Recognition of the reader's own document links.
 *
 * A block reference — `[label](other.md#chapter)` — is rewritten by the build
 * into a hash route (`#/doc/<id>[#<anchor>]`), so by the time the reader sees
 * it, it is only an `href`. Everything that acts on such a link (the hover
 * preview, the click that navigates, the notice and the banner for a chapter
 * that does not exist) needs the same two pieces out of that string, which is
 * what this module extracts.
 *
 * Pure: no DOM and no history, so `node --test` covers it directly.
 */
import { parseHash, ROUTE_PREFIX } from "./router.js";

/**
 * Attribute marking a link the preview may open.
 *
 * The build never writes it: the reader adds it to the anchors it recognises,
 * so the hover handler can find candidates with one attribute selector instead
 * of re-parsing every href in the document.
 */
export var DOC_LINK_ATTRIBUTE = "data-wikicc-doc-link";

/** Selector matching an internal document link. */
export var DOC_LINK_SELECTOR = "a[" + DOC_LINK_ATTRIBUTE + "]";

/**
 * Attribute carrying the chapter a block reference named but its document
 * lacks.
 *
 * The build cannot route to such a chapter — no element emits that anchor — so
 * it drops the anchor from the `href` and writes the authored spelling here
 * instead. Without this the reader would see an ordinary link to the document
 * and could never say what was asked for.
 *
 * Must stay in step with `MISSING_ANCHOR_ATTRIBUTE` in
 * `src/markdown/mod.rs`.
 */
export var MISSING_ANCHOR_ATTRIBUTE = "data-wikicc-missing-anchor";

/**
 * Class the build writes for a link whose chapter its document lacks.
 *
 * The build marks a `<span>` before the link (it owns no attribute of the
 * anchor), and the reader copies both the mark and this class onto the anchor,
 * so the stylesheet and every selector work on the link the reader actually
 * points at. Must stay in step with `MISSING_LINK_CLASS` in
 * `src/markdown/mod.rs`.
 */
export var MISSING_CLASS = "doc-link-missing";

/**
 * Attributes matching the destination prefix the build emits.
 *
 * Used only to tag anchors once, when a document is rendered; the prefix is the
 * same constant the router parses.
 */
export var ROUTE_HREF_PREFIX = ROUTE_PREFIX;

/**
 * Parse an `href` that points at a document of this site.
 *
 * Returns `{ id, anchor }` where `anchor` is `null` for a link to the whole
 * document, or `null` when the `href` is not a document route. Both are
 * decoded, so a percent-encoded CJK chapter arrives as the text the author
 * wrote and can be compared with the outline.
 */
export function parseDocLink(href) {
  if (typeof href !== "string") {
    return null;
  }

  var route = parseHash(href);
  if (!route.id) {
    return null;
  }

  return { id: route.id, anchor: route.anchor };
}

/**
 * Whether `href` addresses one chapter of a document.
 *
 * A link without a chapter addresses the document as a whole and gets no
 * preview: the whole document is already what clicking it shows.
 */
export function isBlockReference(href) {
  var link = parseDocLink(href);
  return link !== null && link.anchor !== null;
}

/**
 * Chapter a block reference asked for but its document does not have.
 *
 * `value` is the attribute the build wrote — usually
 * `link.getAttribute(MISSING_ANCHOR_ATTRIBUTE)`. Returns the authored spelling,
 * so the message quotes the line the author has to fix, or `null` when the
 * reference is sound.
 *
 * An empty or blank value means the build marked nothing worth reporting: a
 * chapter named `""` cannot be fixed by the reader.
 */
export function missingAnchorOf(value) {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim() ? value : null;
}

/**
 * Normalised form of a document route, for comparing two addresses.
 *
 * Both halves are decoded, so the build's escaping (`#34-%E6%8A%80%E6%9C%AF`)
 * and a spelling that reached the address bar decoded (`#34-技术`) compare
 * equal — they address the same chapter and must not look like two routes.
 */
function routeKey(href) {
  var link = parseDocLink(href);
  if (!link) {
    return null;
  }

  return link.id + "\u0000" + (link.anchor === null ? "" : link.anchor);
}

/**
 * Whether `href` addresses the route the page is already showing.
 *
 * A link to the current route cannot be followed by changing `location.hash`:
 * the browser sees the same address and fires no `hashchange`, so the reader
 * would scroll nowhere while the document never re-renders. Callers use this to
 * decide who walks the reader to the chapter.
 */
export function isSameRoute(currentHash, href) {
  var current = routeKey(currentHash);
  if (current === null) {
    return false;
  }

  return current === routeKey(href);
}

/**
 * Whether a click on a link should be handled by the reader.
 *
 * Modified clicks (a new tab, a new window, a download) and clicks on another
 * mouse button stay with the browser, so the reader never overrides what the
 * platform already does.
 */
export function isPlainLeftClick(event) {
  return (
    !!event &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (event.button === 0 || event.button === undefined)
  );
}
