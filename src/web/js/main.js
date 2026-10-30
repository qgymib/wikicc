/**
 * Bundle entry point for the reader.
 *
 * esbuild bundles this file (and everything it imports) into one IIFE that the
 * page inlines as a classic script. Booting here rather than inside `app.js`
 * keeps the controller free of side effects, so `node --test` can import it
 * without a DOM.
 */
import { start } from "./app.js";

function boot() {
  try {
    start();
  } catch (error) {
    if (typeof console === "object" && typeof console.error === "function") {
      console.error("wikicc: failed to start the reader", error);
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
