/**
 * Which chapter a route anchor addresses.
 *
 * The route grammar is `#/doc/<id>[#<anchor>]`, and the anchor half has to be
 * turnable into an element id. Two things conspire against a plain
 * `getElementById`:
 *
 * - the build rewrites an author's spelling into the anchor the renderer emits
 *   (`#1.4 配色与字体` → `#14-配色与字体`), which the outline in
 *   the payload mirrors, and
 * - an artifact built before that rewrite still carries the author's spelling in
 *   its hrefs.
 *
 * Reading the outline is therefore both the source of truth and the fallback:
 * the payload's `toc` holds every heading id the body emits, so an anchor that
 * matches none of them is a chapter that really does not exist — which is what
 * the missing-chapter banner keys off.
 *
 * Pure except for the injected `lookup` callback: no DOM is touched directly,
 * so `node --test` covers the selection rules.
 */
import { resolveAnchor, slugify } from "./preview.js";

/**
 * Outline entry `anchor` addresses, or `null` when the document has none.
 *
 * The exact anchor, its slug and the heading texts of the outline are all
 * accepted, in that order, mirroring the build's `match_anchor`.
 */
export function resolveEntry(doc, anchor) {
  if (!doc || !anchor) {
    return null;
  }

  return (
    resolveAnchor(doc.toc, anchor) || resolveAnchor(doc.toc, slugify(anchor))
  );
}

/**
 * Candidate element ids for `anchor`, most literal first.
 *
 * The first candidate is the anchor as routed, which is what a correct build
 * writes; the rest let an artifact from an older build still navigate.
 */
export function anchorCandidates(doc, anchor) {
  var candidates = [];

  function add(value) {
    if (value && candidates.indexOf(value) === -1) {
      candidates.push(value);
    }
  }

  add(anchor);
  add(anchor ? anchor.trim() : "");

  var entry = resolveEntry(doc, anchor);
  if (entry) {
    add(entry.id);
  }

  add(anchor ? slugify(anchor) : "");

  return candidates;
}

/**
 * Resolve `anchor` against `doc` and the live document.
 *
 * `lookup(id)` returns the element anchored `id`, or `null`; `app.js` passes
 * `document.getElementById`, so this module stays free of DOM assumptions.
 *
 * Returns `{ entry, element, anchor }` where `anchor` is the id that was found,
 * `entry` is the matching outline entry (or `null` for a heading the outline
 * does not carry, such as a hand-written raw-HTML one) and `element` is the
 * node to scroll to. Returns `null` when the document has no such chapter.
 */
export function resolveDocAnchor(doc, anchor, lookup) {
  if (!anchor || typeof lookup !== "function") {
    return null;
  }

  var entry = resolveEntry(doc, anchor);
  var candidates = anchorCandidates(doc, anchor);

  for (var index = 0; index < candidates.length; index += 1) {
    var element = lookup(candidates[index]);
    if (element) {
      return { entry: entry, element: element, anchor: candidates[index] };
    }
  }

  return null;
}
