/**
 * Diagram rendering: the only module that touches both the DOM and the diagram
 * engine.
 *
 * `diagrams.js` decides whether to render; this module does it. The engine is
 * imported statically (esbuild bundles it into the single inlined script), but
 * it is only initialised and run when the current document actually contains a
 * diagram block, so documents without diagrams pay nothing at runtime.
 *
 * A diagram that fails to parse must not take the page down: the run is
 * started with `suppressErrors` so the element keeps its source text, which is
 * the documented fallback, and the failure is reported once on the console.
 */
import mermaid from "mermaid";

import * as Diagrams from "./diagrams.js";

/** Attribute holding the author's source while the element shows an SVG. */
const SOURCE_ATTRIBUTE = "data-source";

/** Diagram blocks inside `root`, as a real array. */
export function diagramNodes(root) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return [];
  }
  return Array.prototype.slice.call(root.querySelectorAll(Diagrams.SELECTOR));
}

/**
 * Put every diagram back to its source text so it can be rendered again.
 *
 * The engine replaces the element's content with an SVG and marks it
 * `data-processed`; the source is kept in `data-source` on the first run.
 * Restoring the text (rather than rebuilding the document) keeps everything
 * else on the page — table sort, filters, scroll position — untouched.
 */
export function resetDiagrams(root) {
  diagramNodes(root).forEach(function (node) {
    var source = node.getAttribute(SOURCE_ATTRIBUTE);
    if (source === null) {
      return;
    }
    node.textContent = source;
    node.removeAttribute("data-processed");
  });
}

/**
 * Render every diagram inside `root` for `theme`.
 *
 * Resolves to `true` when the engine ran, `false` when there was nothing to do
 * or the engine reported a failure. The promise never rejects: the caller is a
 * render path that must not fail because of one bad diagram.
 */
export function renderDiagrams(root, theme) {
  var nodes = diagramNodes(root);

  if (!Diagrams.shouldInitMermaid(nodes.length)) {
    return Promise.resolve(false);
  }

  nodes.forEach(function (node) {
    if (!node.hasAttribute(SOURCE_ATTRIBUTE)) {
      node.setAttribute(SOURCE_ATTRIBUTE, node.textContent);
    }
  });

  mermaid.initialize(Diagrams.mermaidConfig(theme));

  return mermaid
    .run({ nodes: nodes, suppressErrors: true })
    .then(function () {
      return true;
    })
    .catch(function (error) {
      if (typeof console === "object" && typeof console.error === "function") {
        console.error("wikicc: failed to render a diagram", error);
      }
      return false;
    });
}
