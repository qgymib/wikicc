/**
 * The search panel: the composer that wires the dialog's frame and the
 * document preview into one controller.
 *
 * `search-panel.js` owns the frame — the query field, the result rows, the
 * keys that move through them, and the open/close choreography.
 * `search-preview.js` owns the dialog's bottom half — the whole document
 * behind the selected result, with its signature cache and the sealed
 * document's notice. This module reads the page's options, builds the pair in
 * the order their wiring needs, and keeps the routes: a click on a link
 * inside the previewed document is a navigation, which leaves the panel and
 * hands the route to the caller, because the browser would change the address
 * behind a dialog still covering the page.
 *
 * The constants each module defines are re-exported here, so the module's
 * public surface — the factory and every vocabulary word the stylesheet and
 * the tests spell — stays exactly what it was.
 */
import * as Links from "./links.js";
import { QUERY_DELAY_MS, createSearchPanel } from "./search-panel.js";
import { createSearchPreview } from "./search-preview.js";

export {
  CLEAR_LABEL,
  CONTEXT_CLASS,
  DEFAULT_MODE,
  EMPTY_CLASS,
  FIELD_CLASS,
  GLOBAL_MODE,
  INPUT_CLASS,
  INPUT_PLACEHOLDER,
  LOCAL_MODE,
  LOCKED_CLASS,
  LOCKED_LABEL,
  LOCKED_TITLE,
  MODE_CLASS,
  MODE_GLOBAL_LABEL,
  MODE_GLOBAL_TITLE,
  MODE_LOCAL_LABEL,
  MODE_LOCAL_TITLE,
  OPEN_ATTRIBUTE,
  PANEL_CLASS,
  PANEL_LABEL,
  PATH_CLASS,
  PREVIEW_CLASS,
  QUERY_DELAY_MS,
  RESULT_CLASS,
  RESULTS_CLASS,
  RESULTS_IDLE_LABEL,
  RESULTS_LOADING_LABEL,
  isSearchShortcut,
} from "./search-panel.js";

export {
  DOCUMENT_CLASS,
  LOCKED_NOTICE,
  PREVIEW_IDLE_LABEL,
  SEARCH_LOCKED_CLASS,
} from "./search-preview.js";

export { matchSnippet } from "./search.js";

export { HIT_CLASS, HIT_ACTIVE_CLASS } from "./search-highlight.js";

/**
 * Create the search panel for one reader instance.
 *
 * `options.container` is the element the panel is built in, `options.onQuery`
 * is asked for the entries matching a query, and `options.onSelect(id, anchor,
 * jump)` is called for the document the reader picks — `jump` names the
 * passage the row described, `{ query, hit }`, for the caller to open the
 * document at, and is absent when the pick has no place in the body, a
 * title-only match. `options.delay` overrides the
 * debounce, which the tests need and a reader never does. `options.toggle` is
 * the button that opens and closes the panel, if the page has one: a press on
 * it is left to the button's own click, so the button is a real switch rather
 * than a way in that reopens what it just closed, and the view keeps its
 * `aria-expanded` in step with the panel however the panel closes.
 *
 * `options.documents` is the reader's document store, which the preview asks
 * for the whole document behind a result. `options.theme` returns the theme
 * currently in effect, because diagrams bake their colours into the SVG.
 *
 * Returns `{ open, close, toggle, isOpen, query, setResults, setLoading, mode,
 * input, dispose }`, where `setResults` draws what `onQuery` was answered
 * with. Every method is a no-op when the page has no container, so a shell
 * without a search panel — an older artifact, a test — still runs.
 */
export function createSearchView(options) {
  var container = options && options.container;
  var onQuery = (options && options.onQuery) || function () {};
  var onSelect = (options && options.onSelect) || function () {};
  // The whole document behind a result, so the preview can show it. Absent in
  // a shell without a payload and in the aim of an older artifact; the preview
  // then keeps the excerpt it always drew, which is degraded but never broken.
  var documents = (options && options.documents) || null;
  var theme =
    (options && options.theme) ||
    function () {
      return null;
    };
  var delay =
    options && typeof options.delay === "number"
      ? Math.max(0, options.delay)
      : QUERY_DELAY_MS;

  /** The button that opens and closes the panel, if the page has one. */
  var toggleButton = (options && options.toggle) || null;

  /** Keep a link click from reaching the browser and the page's shortcuts. */
  function stopEvent(event) {
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
  }

  /**
   * Follow a link inside the previewed document.
   *
   * The preview shows the article the reader picked, and the article's links
   * are the same routes the page itself uses — so a click here means "take me
   * there", exactly as a click on a result row does. It goes through
   * `onSelect` rather than being left to the browser: the browser would change
   * the address behind a dialog still covering the page, and the reader would
   * be looking at the old document with no way to tell what happened.
   *
   * Anything that is not an internal document route — an external site, a
   * download, a `target` the author set — is left to the browser.
   */
  function onPreviewClick(event) {
    var link =
      event && event.target && typeof event.target.closest === "function"
        ? event.target.closest("a[href]")
        : null;
    if (!link) {
      return;
    }

    var route = Links.parseDocLink(link.getAttribute("href"));
    if (!route) {
      return;
    }

    // A modified click is the reader asking the browser for a new tab or
    // window, which is not the panel's to intercept.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button) {
      return;
    }

    stopEvent(event);
    panel.close();
    onSelect(route.id, route.anchor);
  }

  /** The query on screen, as typed — the preview's signature reads it. */
  function query() {
    return panel.query();
  }

  /** The list changed what it describes; the preview follows. */
  function renderPreview(entry) {
    return preview.render(entry);
  }

  /** Drop the panel, its listeners and its nodes. */
  function dispose() {
    panel.dispose();
    preview.dispose();
  }

  var panel = createSearchPanel({
    container: container,
    toggle: toggleButton,
    delay: delay,
    onQuery: onQuery,
    onSelect: onSelect,
    // Whatever the list does to its selection — a pick, an empty answer, the
    // loading note, the freshly built shell — decides what the preview shows.
    onPreview: renderPreview,
    // A click on the previewed document is the hand-over above.
    onPreviewClick: onPreviewClick,
  });

  var preview = createSearchPreview({
    panel: panel,
    query: query,
    documents: documents,
    theme: theme,
  });

  // Build now, exactly as the factory always did: the shell exists — hidden —
  // as soon as the view is created, each idle half naming itself. The step
  // waits until here because the preview is wired only after the panel exists.
  panel.build();

  return {
    open: panel.open,
    close: panel.close,
    toggle: panel.toggle,
    isOpen: panel.isOpen,
    query: query,
    setResults: panel.setResults,
    setLoading: panel.setLoading,
    /** The scope in force, for a caller that describes it elsewhere. */
    mode: panel.mode,
    /** The element the reader types in, for a caller that has to focus it. */
    input: panel.input,
    dispose: dispose,
  };
}
