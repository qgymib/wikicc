/**
 * Math rendering: the only module that touches both the DOM and the math
 * engine.
 *
 * `math.js` decides what a math element looks like; this module does the
 * typesetting. The engine is imported statically (esbuild bundles it into the
 * single inlined script), but it only runs when the current document actually
 * contains math, so documents without formulas pay nothing at runtime.
 *
 * A formula that fails to typeset must not take the page down: the element
 * keeps its source text and the failure is reported once on the console.
 * Unlike the diagrams, math colours are inherited from the text, so a theme
 * switch needs no re-render.
 */
import katex from "katex";

import * as MathPolicy from "./math.js";

/** Display-math blocks inside `root`, as a real array. */
export function mathBlocks(root) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return [];
  }
  return Array.prototype.slice.call(
    root.querySelectorAll(MathPolicy.SELECTOR_BLOCK),
  );
}

/** Inline-math spans inside `root`, as a real array. */
export function mathInlines(root) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return [];
  }
  return Array.prototype.slice.call(
    root.querySelectorAll(MathPolicy.SELECTOR_INLINE),
  );
}

/**
 * Typeset every formula inside `root`.
 *
 * Returns `true` when the engine ran, `false` when there was nothing to do.
 * The call is synchronous and never throws: one unparseable formula degrades
 * to its source text with a console message, and the text around it stays
 * readable.
 */
export function renderMath(root) {
  var blocks = mathBlocks(root);
  var inlines = mathInlines(root);
  var count = blocks.length + inlines.length;

  if (!MathPolicy.shouldRenderMath(count)) {
    return false;
  }

  blocks.forEach(function (node) {
    typeset(node, true);
  });
  inlines.forEach(function (node) {
    typeset(node, false);
  });

  return true;
}

/**
 * Typeset one element for `displayMode`, keeping the author's source first.
 *
 * The source is remembered before the engine touches the element, so the
 * element can always answer "what did the author write". A thrown error —
 * the engine promises not to throw for a parse failure, but nothing else in
 * the page may depend on that promise — leaves the source text in place.
 */
function typeset(node, displayMode) {
  if (!node.hasAttribute(MathPolicy.SOURCE_ATTRIBUTE)) {
    node.setAttribute(MathPolicy.SOURCE_ATTRIBUTE, node.textContent);
  }

  try {
    katex.render(node.textContent, node, MathPolicy.katexOptions(displayMode));
  } catch (error) {
    if (typeof console === "object" && typeof console.error === "function") {
      console.error("wikicc: failed to typeset a formula", error);
    }
  }
}
