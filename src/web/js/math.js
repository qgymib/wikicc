/**
 * Math policy: what a math element looks like, when the engine has to run and
 * how it is configured.
 *
 * This module is deliberately free of `document` and of the engine import, so
 * `node --test` can cover the decisions without a DOM or an engine
 * dependency. `math-view.js` owns the DOM and the engine; `app.js` only calls
 * it.
 *
 * The class names are a cross-language contract: the Rust renderer emits
 * `<pre class="math">` for a `$$…$$` block and `<code class="math-inline">`
 * for a `$…$` span, and this module selects both.
 */

/** Class of a display-math block, as emitted by the build. */
export const BLOCK_CLASS = "math";

/** Class of an inline-math span, as emitted by the build. */
export const INLINE_CLASS = "math-inline";

/** Selector of the display-math blocks inside a rendered document. */
export const SELECTOR_BLOCK = "pre." + BLOCK_CLASS;

/** Selector of the inline-math spans inside a rendered document. */
export const SELECTOR_INLINE = "code." + INLINE_CLASS;

/**
 * Attribute holding the author's source while the element shows typeset math.
 *
 * The engine replaces the element's content with its own markup; the source
 * is kept on the element itself, so a failure can be traced and a re-render
 * can start over without the document.
 */
export const SOURCE_ATTRIBUTE = "data-source";

/**
 * Options handed to `katex.render` for one element.
 *
 * A formula that fails to parse must not take the page down: with
 * `throwOnError` off the engine renders the mistake inside the element and
 * the surrounding text keeps working, which is the documented fallback. A
 * fresh object is returned on every call because the engine is free to
 * mutate the object it was given.
 */
export function katexOptions(displayMode) {
  return {
    throwOnError: false,
    displayMode: displayMode === true,
  };
}

/**
 * Whether the engine has to run at all.
 *
 * The reader calls this with the number of math elements in the current
 * document, so a document without formulas never touches the engine.
 */
export function shouldRenderMath(count) {
  return Number.isFinite(count) && count > 0;
}
