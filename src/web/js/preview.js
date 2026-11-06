/**
 * What a reference shows when it is hovered.
 *
 * A chapter reference names one chapter, and the reader promises to show *that
 * chapter and nothing above it*: its own content plus every nested chapter
 * below it, with no sibling and no ancestor. The build already cut the body
 * into blocks (`DocModel.blocks`, one per heading, ending where the next
 * heading starts) and recorded each block's place in the outline, so the
 * preview is a lookup rather than a second parse of Markdown in the browser.
 *
 * A block holds its own chapter's markup and lists the blocks it contains
 * (`Block.subtree`, itself first, in document order), so showing a whole
 * chapter is "read that list and join the blocks it names": the order is the
 * source order and no paragraph is repeated, because every block owns its
 * markup exactly once.
 *
 * A reference without a chapter anchor names the whole document. Its preview
 * is the complete body — the preamble before the first heading joined with
 * every block in document order, which is exactly what `DocModel.html`
 * already is, because the build cuts the blocks to tile the body from its
 * first heading to its end. The reader recombines what the build wrote;
 * nothing new travels in the payload.
 *
 * Pure: no DOM, so `node --test` covers the selection rules directly.
 */

/**
 * Anchor of the chapter a reference points at, resolved against the outline.
 *
 * An author may write a heading's text rather than its slug (`#Getting
 * Started`), so an exact anchor is tried first and the slugified form second.
 * Returns `null` when the document has no such chapter, which is what the
 * banner for a broken reference keys off.
 */
export function resolveAnchor(toc, anchor) {
  if (!Array.isArray(toc) || !anchor) {
    return null;
  }

  var exact = findEntry(toc, anchor);
  if (exact) {
    return exact;
  }

  var slug = slugify(anchor);
  if (slug && slug !== anchor) {
    return findEntry(toc, slug);
  }

  return null;
}

/** The outline entry anchored `anchor`, searched depth first. */
function findEntry(entries, anchor) {
  for (var index = 0; index < entries.length; index += 1) {
    var entry = entries[index];
    if (!entry) {
      continue;
    }
    if (entry.id === anchor) {
      return entry;
    }

    var nested = findEntry(entry.children || [], anchor);
    if (nested) {
      return nested;
    }
  }

  return null;
}

/** Slug the build uses when a heading has no usable character. */
export var FALLBACK_SLUG = "section";

/**
 * Slug of a heading, mirroring the build's `slugify`.
 *
 * The build lowercases, keeps Unicode alphanumerics plus `_`, joins the words
 * with `-` and falls back to `section` when nothing survives, so `Getting
 * Started` matches `getting-started` while `第一章` keeps its characters. This
 * is only used to *recognise* an author's spelling of a heading; the anchor the
 * reader navigates to always comes from the outline, which the build wrote.
 */
export function slugify(text) {
  var lowered = String(
    text === null || text === undefined ? "" : text,
  ).toLowerCase();
  var slug = "";
  var dashPending = false;

  for (var index = 0; index < lowered.length; index += 1) {
    var character = lowered.charAt(index);

    if (/\s/.test(character)) {
      dashPending = true;
    } else if (/\p{L}|\p{N}|_/u.test(character)) {
      if (dashPending && slug) {
        slug += "-";
      }
      dashPending = false;
      slug += character;
    } else if (character === "-") {
      dashPending = true;
    }
  }

  return slug || FALLBACK_SLUG;
}

/**
 * Index of the block that opens `anchor`'s chapter, or -1 when there is none.
 *
 * `resolveAnchor` finds the outline entry because an author may name a heading
 * by its text (`#Getting Started`) rather than by its slug; the block is then
 * found by that anchor. A payload without blocks has no chapter to preview.
 */
function blockIndexOf(doc, anchor) {
  var entry = resolveAnchor(doc && doc.toc, anchor);
  if (!entry) {
    return -1;
  }

  var blocks = doc && Array.isArray(doc.blocks) ? doc.blocks : [];
  for (var index = 0; index < blocks.length; index += 1) {
    if (blocks[index] && blocks[index].id === entry.id) {
      return index;
    }
  }

  return -1;
}

/**
 * Indices of the blocks `anchor`'s chapter is made of, in document order.
 *
 * The build already recorded them on the block (`Block.subtree`: the block
 * itself first, then everything nested under it), so this is a read, not a
 * walk of the outline. Document order is what makes the joined HTML read
 * correctly: an entry is followed by its children, and a sibling comes after
 * the whole subtree above it.
 *
 * The indices are returned as the payload wrote them; `buildPreviewHtml`
 * validates them, so a truncated payload cannot silently drop part of a
 * chapter here.
 */
export function collectPreview(doc, anchor) {
  var index = blockIndexOf(doc, anchor);
  if (index < 0) {
    return [];
  }

  var subtree = doc.blocks[index].subtree;
  return Array.isArray(subtree) ? subtree.slice() : [index];
}

/**
 * HTML of the preview for `anchor`, or `null` when the chapter is unknown.
 *
 * The blocks the chapter names are joined in document order, reproducing the
 * chapter exactly as the source wrote it. A missing block — a payload that
 * disagrees with itself, or one compiled by a build that predates blocks —
 * yields `null` rather than a silently partial preview: a reference that shows
 * half a chapter is worse than one that says it cannot be shown.
 */
export function buildPreviewHtml(doc, anchor) {
  var indices = collectPreview(doc, anchor);
  if (!indices.length) {
    return null;
  }

  var blocks = doc.blocks;
  var html = "";

  for (var position = 0; position < indices.length; position += 1) {
    var block = blocks[indices[position]];
    if (!block || typeof block.html !== "string") {
      return null;
    }
    html += block.html;
  }

  return html || null;
}

/** Heading text of the preview's chapter, or the anchor as a fallback. */
export function previewTitle(doc, anchor) {
  var entry = resolveAnchor(doc && doc.toc, anchor);
  if (!entry) {
    return anchor ? String(anchor) : "";
  }

  return entry.text || entry.id;
}

/**
 * Everything the popover needs about one reference, or `null` when there is
 * nothing to show.
 *
 * `doc` may be missing when the reference points at a document the payload does
 * not carry, which is how a stale artifact degrades instead of throwing.
 */
export function createPreview(doc, anchor) {
  if (!doc || !anchor) {
    return null;
  }

  var html = buildPreviewHtml(doc, anchor);
  if (!html) {
    return null;
  }

  return {
    html: html,
    title: previewTitle(doc, anchor),
    path: doc.id || doc.path || "",
  };
}

/**
 * Everything the popover needs about a reference that names a whole document,
 * or `null` when there is nothing to show.
 *
 * The body is shown whole, so `html` is the document's own body: the same
 * bytes joining the preamble with every block in document order would
 * produce, since the blocks tile the body from the first heading to its end.
 * The title is the build's (`DocModel.title`, the first level-one heading or
 * the file stem), falling back to the path, because a document without a
 * title still has a name. A document without a body — a stale artifact, or a
 * payload that predates the field — answers `null`, which the reader reads as
 * silence rather than as a failure.
 */
export function createDocumentPreview(doc) {
  if (!doc || typeof doc.html !== "string" || !doc.html) {
    return null;
  }

  return {
    html: doc.html,
    title: doc.title || doc.id || doc.path || "",
    path: doc.id || doc.path || "",
  };
}
