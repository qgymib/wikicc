/**
 * Diagram policy: what a diagram block looks like, when the engine has to run
 * and how it is configured.
 *
 * This module is deliberately free of `document` and of the engine import, so
 * `node --test` can cover the decisions without a DOM or a 5 MB dependency.
 * `diagram-view.js` owns the DOM and the engine; `app.js` only calls it.
 *
 * The class name is a cross-language contract: the Rust renderer emits
 * `<pre class="mermaid">` for a ` ```mermaid ` fence
 * (`markdown::highlight::MERMAID_CLASS`) and this module selects it.
 */

/** Class of a diagram block, as emitted by the build. */
export const CLASS = "mermaid";

/** Selector of the diagram blocks inside a rendered document. */
export const SELECTOR = "pre." + CLASS;

/** Mermaid theme name for a reader theme. */
export function mermaidTheme(theme) {
  return theme === "light" ? "default" : "dark";
}

/**
 * Configuration handed to `mermaid.initialize` before every render.
 *
 * `startOnLoad` is off because the reader renders documents itself, one route
 * at a time; `securityLevel: "strict"` keeps labels sanitised even though the
 * Markdown input is trusted. A fresh object is returned on every call because
 * the engine is free to mutate the object it was given.
 */
export function mermaidConfig(theme) {
  return {
    startOnLoad: false,
    theme: mermaidTheme(theme),
    securityLevel: "strict",
  };
}

/**
 * Whether the engine has to be initialised and run at all.
 *
 * The reader calls this with the number of diagram blocks in the current
 * document, so a document without diagrams never touches the engine.
 */
export function shouldInitMermaid(count) {
  return Number.isFinite(count) && count > 0;
}

/**
 * Whether a document's HTML contains at least one diagram block.
 *
 * Used to decide whether a theme change has to re-render the current document:
 * the payload keeps the diagram source, so rebuilding the body resets the
 * already-rendered SVG and lets the new theme take over.
 */
export function hasDiagramSource(html) {
  return typeof html === "string" && html.includes('class="' + CLASS + '"');
}
