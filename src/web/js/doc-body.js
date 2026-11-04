/**
 * The body of one document, shared by every surface that shows a whole one.
 *
 * A document's markup reaches the page in three places — the article column
 * (`app.js`), the search dialog's full-text preview (`search-view.js`) and the
 * hover preview of a block reference (`preview-view.js`) — and all three do
 * the same two-step dance with it. This module is that dance, written once:
 *
 * - the markup goes into an element *before* the element is on screen, and
 *   the tables inside it are enhanced in the same breath, so the first paint
 *   already carries the sortable headers and filter buttons the article
 *   shows;
 * - the diagrams are drawn only *after* the element is in the document,
 *   because the engine measures its labels with the layout, which a detached
 *   subtree does not have.
 *
 * Whether tables are enhanced is the caller's declaration, not this module's
 * guess: the article and the hover preview enhance them, and the search
 * preview deliberately does not — the filter panel the buttons open is
 * parented to `document.body`, outside the dialog, which the search panel
 * would read as a press outside itself. The option keeps that decision where
 * it belongs, at the call site, instead of hiding a special case in here.
 *
 * Insertion itself stays with the caller — the article replaces a column,
 * the search preview appends under a banner, the hover preview refills a
 * body it keeps for its whole session — because a shared insert would be a
 * callback-shaped API for three lines apiece.
 */
import * as TableView from "./table-view.js";
import * as DiagramView from "./diagram-view.js";

/** Class every document body carries; the stylesheet keys the typography off it. */
export var BODY_CLASS = "doc-body";

/**
 * Fill an existing element with a document's markup.
 *
 * `options.enhanceTables` says whether the tables in the markup gain the sort
 * and filter controls of the article. The work happens here, right after the
 * markup exists and — for a caller that has not inserted the element yet —
 * before it is on screen.
 *
 * Returns `body`, so a call can sit at the head of an expression.
 */
export function fillDocBody(body, html, options) {
  body.innerHTML = html;

  if (options && options.enhanceTables) {
    TableView.enhanceTables(body);
  }

  return body;
}

/**
 * Build the body element of one document.
 *
 * `options.extraClass` names what the container is — the search preview's
 * `search-document`, for one — and goes in front, so the class string reads
 * "what it is, and that it typesets like the article". `options.enhanceTables`
 * is handed to `fillDocBody` untouched.
 */
export function createDocBody(html, options) {
  var body = document.createElement("div");
  body.className =
    options && options.extraClass
      ? options.extraClass + " " + BODY_CLASS
      : BODY_CLASS;

  return fillDocBody(body, html, options);
}

/**
 * Draw the diagrams of a body that is already in the document.
 *
 * This is the one step a caller must not do early: the engine measures its
 * labels with the layout, which a detached subtree does not have. The call
 * is asynchronous and swallows its own failures, so the text around the
 * diagrams is readable while the pictures arrive.
 */
export function drawDiagrams(body, theme) {
  return DiagramView.renderDiagrams(body, theme);
}
