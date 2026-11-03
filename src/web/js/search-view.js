/**
 * The search panel: a query field, the documents it matches, and the passage
 * the highlighted match was found in.
 *
 * The panel is one column in three parts, top to bottom, and each part is a
 * different answer to the same question: what the reader typed, which documents
 * hold it, and where. `search.js` supplies every piece of that content; this
 * module only decides when to ask, and draws what comes back.
 *
 * **The panel is opened, not present.** The reader asks for it — a toolbar
 * button or `Ctrl`/`Cmd`+`F` — and it goes away on `Escape` or on a click
 * outside it. Nothing about it is permanent: the sidebar keeps the document
 * list alone, and a reader who is not searching sees no search furniture.
 *
 * **Every stroke is a query.** Typing is debounced (`QUERY_DELAY_MS`) rather
 * than throttled: the field's own value is never touched, so the caret only
 * moves where the reader puts it, and one query is asked per pause instead of
 * one per keystroke. `onQuery` answers with the entries to show, which keeps
 * this module free of the index — it takes what to draw, never how to find it.
 *
 * **A result is two lines and one action.** The title says which document, the
 * context says why it is there, and both are chosen by the engine's ranking,
 * which the list never re-sorts. The one selected result — the first until the
 * reader moves it — is what the preview shows and what Enter opens, so the list
 * and the preview always describe the same row.
 *
 * Document text reaches the page as text, never as markup: titles and contexts
 * are written with `textContent`, and the preview puts the matched words in a
 * `<mark>` by splitting the snippet into pieces and appending three nodes. The
 * search engine's `match` data would have been a more direct source for the
 * offsets, but it addresses its own token stream — the words a snippet cut from
 * the document are found in `search.js` instead, in the text the reader sees.
 *
 * Keyboard support is the list's, not the field's: `ArrowUp`/`ArrowDown`,
 * `Home`/`End` move the selection and are taken before the caret can use them,
 * `Enter` opens it where the caret would otherwise insert a newline in a
 * multi-line field, and `Escape` closes the panel — the one key the reader
 * expects to undo whatever is open.
 */
import { ELLIPSIS, matchSnippet } from "./search.js";

/** Class of the panel root. */
export var PANEL_CLASS = "search-panel";

/** Class of the query field's wrapper, which carries the icon and the clear button. */
export var FIELD_CLASS = "search-field";

/** Class of the query input. */
export var INPUT_CLASS = "search-input";

/** Class of the button that empties the field. */
export var CLEAR_CLASS = "search-clear";

/** Class of the list of matching documents. */
export var RESULTS_CLASS = "search-results";

/** Class of one matching document. */
export var RESULT_CLASS = "search-result";

/** Class of the document title inside a result. */
export var TITLE_CLASS = "search-result-title";

/** Class of the context line inside a result. */
export var CONTEXT_CLASS = "search-result-context";

/** Class of the preview area at the bottom of the panel. */
export var PREVIEW_CLASS = "search-preview";

/** Class of the placeholder shown where a list or a preview has nothing. */
export var EMPTY_CLASS = "search-empty";

/** Attribute marking the panel as open, which is what the stylesheet animates. */
export var OPEN_ATTRIBUTE = "data-open";

/** Placeholder of the query field. */
export var INPUT_PLACEHOLDER = "Search documents";

/** Accessible name of the panel. */
export var PANEL_LABEL = "Search documents";

/** Accessible name of the clear button. */
export var CLEAR_LABEL = "Clear the search";

/**
 * Shown in the middle of the list while it has no rows to show.
 *
 * The two halves of the panel name themselves when they are empty and say
 * nothing once they hold something: an empty area labelled "Results" tells the
 * reader which half they are looking at, and the label leaves with the first
 * row, so no per-empty-state sentence has to be invented — a search that found
 * nothing simply leaves the area empty, which is what it is.
 */
export var RESULTS_IDLE_LABEL = "Results";

/** Shown in the middle of the preview while it has no passage to show. */
export var PREVIEW_IDLE_LABEL = "Preview";

/**
 * How long typing must pause before a query is asked, in milliseconds.
 *
 * Long enough that a word arrives whole, short enough that the list never
 * feels behind the hand that typed it.
 */
export var QUERY_DELAY_MS = 90;

/** Whether a keyboard event is the one that opens the panel on this platform. */
export function isSearchShortcut(event) {
  if (!event || typeof event.key !== "string" || event.key.toLowerCase() !== "f") {
    return false;
  }

  // `Ctrl` on Windows and Linux, `Cmd` on macOS, where the same key combination
  // is what the browser's own find uses — hence the `preventDefault` at the
  // call site, and never `Alt` or `Shift` alone.
  return !!(event.ctrlKey || event.metaKey) && !event.altKey;
}

/**
 * Create the search panel for one reader instance.
 *
 * `options.container` is the element the panel is built in, `options.onQuery`
 * is asked for the entries matching a query, and `options.onSelect(id, anchor)`
 * is called for the document the reader picks. `options.delay` overrides the
 * debounce, which the tests need and a reader never does. `options.toggle` is
 * the button that opens and closes the panel, if the page has one: a press on
 * it is left to the button's own click, so the button is a real switch rather
 * than a way in that reopens what it just closed, and the view keeps its
 * `aria-expanded` in step with the panel however the panel closes.
 *
 * Returns `{ open, close, toggle, isOpen, query, setResults, dispose }`, where
 * `setResults` draws what `onQuery` was answered with. Every method is a no-op
 * when the page has no container, so a shell without a search panel — an older
 * artifact, a test — still runs.
 */
export function createSearchView(options) {
  var container = options && options.container;
  var onQuery = (options && options.onQuery) || function () {};
  var onSelect = (options && options.onSelect) || function () {};
  var delay =
    options && typeof options.delay === "number" ? Math.max(0, options.delay) : QUERY_DELAY_MS;

  /** The button that opens and closes the panel, if the page has one. */
  var toggle = (options && options.toggle) || null;

  var input = null;
  var results = null;
  var preview = null;
  var clearButton = null;
  var timer = 0;

  /** The entries on screen, in the engine's order. */
  var entries = [];

  /** The entry the preview describes and Enter opens, or `null`. */
  var selected = null;

  /** The nodes drawn for `entries`, so a selection moves without a rebuild. */
  var rows = [];

  /** Whether the panel is on screen. */
  var open = false;

  /** Whether a keystroke has been typed that no query has answered yet. */
  var stale = false;

  function view() {
    return globalThis;
  }

  function clearTimer() {
    if (timer) {
      view().clearTimeout(timer);
      timer = 0;
    }
  }

  /** Build the empty panel once, on first use. */
  function ensurePanel() {
    if (input || !container) {
      return;
    }

    container.textContent = "";
    container.setAttribute("role", "dialog");
    container.setAttribute("aria-label", PANEL_LABEL);
    container.hidden = true;

    var field = document.createElement("div");
    field.className = FIELD_CLASS;

    var icon = document.createElementNS
      ? document.createElementNS("http://www.w3.org/2000/svg", "svg")
      : document.createElement("svg");
    icon.setAttribute("class", "search-icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    [["circle", { cx: "11", cy: "11", r: "7" }], ["path", { d: "M16.5 16.5 21 21" }]].forEach(
      function (shape) {
        var node = document.createElementNS
          ? document.createElementNS("http://www.w3.org/2000/svg", shape[0])
          : document.createElement(shape[0]);
        Object.keys(shape[1]).forEach(function (name) {
          node.setAttribute(name, shape[1][name]);
        });
        icon.appendChild(node);
      },
    );

    input = document.createElement("input");
    input.className = INPUT_CLASS;
    input.setAttribute("type", "search");
    input.setAttribute("placeholder", INPUT_PLACEHOLDER);
    input.setAttribute("aria-label", INPUT_PLACEHOLDER);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeyDown);

    clearButton = document.createElement("button");
    clearButton.className = CLEAR_CLASS;
    clearButton.setAttribute("type", "button");
    clearButton.setAttribute("aria-label", CLEAR_LABEL);
    clearButton.setAttribute("title", CLEAR_LABEL);
    clearButton.hidden = true;
    clearButton.addEventListener("click", onClearClick);

    field.appendChild(icon);
    field.appendChild(input);
    field.appendChild(clearButton);

    results = document.createElement("div");
    results.className = RESULTS_CLASS;
    results.setAttribute("role", "listbox");
    results.setAttribute("aria-label", "Matching documents");

    preview = document.createElement("div");
    preview.className = PREVIEW_CLASS;
    preview.setAttribute("aria-live", "polite");

    container.appendChild(field);
    container.appendChild(results);
    container.appendChild(preview);

    // A press is what dismisses the panel, not a click: the panel takes the
    // press before a link behind it can, which is the moment the reader has
    // moved on. Capture, so nothing in between can swallow it.
    document.addEventListener("pointerdown", onPointerDown, true);

    // The empty panel says what to do with it. Written here rather than
    // through `setResults`, which the first caller of it would otherwise find
    // already satisfied and skip, leaving an empty box on screen.
    var empty = document.createElement("p");
    empty.className = EMPTY_CLASS;
    empty.textContent = RESULTS_IDLE_LABEL;
    results.appendChild(empty);
    renderPreview(null);
  }

  /** Whether a node is inside the panel, at any depth. */
  function contains(node) {
    if (!node) {
      return false;
    }
    if (typeof container.contains === "function") {
      return container.contains(node);
    }

    return node === container;
  }

  /**
   * Whether a node is inside the button that opens and closes the panel.
   *
   * A press on the toggle is the reader asking to switch the panel, not a
   * press outside it: closing here would race the button's own click, which
   * would open the panel again and leave it stuck on screen.
   */
  function insideToggle(node) {
    if (!toggle || !node) {
      return false;
    }
    if (typeof toggle.contains === "function") {
      return toggle.contains(node);
    }

    return node === toggle;
  }

  /**
   * The state the opening button describes, whatever way the panel changed.
   *
   * Every close — the button, `Escape`, a pick, a press outside — passes
   * through here, so the button never says the panel is open after the panel
   * has gone; the caller keeps its own sync for the paths it drives.
   */
  function setToggleExpanded(expanded) {
    if (toggle && typeof toggle.setAttribute === "function") {
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
  }

  /** A press outside the panel closes it; one inside it is used by the panel. */
  function onPointerDown(event) {
    if (!open || contains(event && event.target) || insideToggle(event && event.target)) {
      return;
    }

    closePanel();
  }

  function onInput() {
    if (clearButton) {
      clearButton.hidden = !input.value;
    }
    if (input.getAttribute) {
      input.setAttribute("aria-expanded", input.value ? "true" : "false");
    }

    clearTimer();
    // A keystroke makes the list on screen describe an older query, so the
    // field is marked as needing an answer; `Enter` settles that before it
    // reads the selection rather than opening a row about to change.
    stale = true;
    timer = view().setTimeout(function () {
      timer = 0;
      ask();
    }, delay);
  }

  /** Ask for the entries `input` describes; an empty query clears the list. */
  function ask() {
    stale = false;
    var query = input ? input.value : "";
    if (!String(query).trim()) {
      setResults([], 0);
      return;
    }

    onQuery(query);
  }

  function onClearClick(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (input) {
      input.value = "";
      input.focus();
    }
    if (clearButton) {
      clearButton.hidden = true;
    }
    clearTimer();
    setResults([], 0);
  }

  function onKeyDown(event) {
    if (!event || typeof event.key !== "string") {
      return;
    }

    if (event.key === "Escape") {
      stopEvent(event);
      closePanel();
      return;
    }

    if (event.key === "Enter") {
      stopEvent(event);
      // A pause the reader has not waited out yet is a query already typed:
      // opening the top of a list that is about to change would open the wrong
      // document, so the answer is taken before the selection is read. A list
      // that already answers the field is left alone, so the entry the reader
      // moved to with the arrow keys is still the one that opens.
      if (stale) {
        clearTimer();
        ask();
      }
      if (selected) {
        choose(selected);
      }
      return;
    }

    var index = entries.indexOf(selected);
    if (event.key === "ArrowDown") {
      stopEvent(event);
      move(index + 1);
    } else if (event.key === "ArrowUp") {
      stopEvent(event);
      move(index <= 0 ? 0 : index - 1);
    } else if (event.key === "Home") {
      stopEvent(event);
      move(0);
    } else if (event.key === "End") {
      stopEvent(event);
      move(entries.length - 1);
    }
  }

  /** Keep the event out of the caret's hands and out of the page's shortcuts. */
  function stopEvent(event) {
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
  }

  /** Select entry `index`, clamped to the list, and describe it in the preview. */
  function move(index) {
    if (!entries.length) {
      return;
    }

    var next = Math.min(Math.max(0, index), entries.length - 1);
    mark(next);
  }

  /** Select the entry at `index` and show its context. */
  function mark(index) {
    var entry = entries[index] || null;
    if (entry === selected) {
      return;
    }

    selected = entry;
    rows.forEach(function (row, position) {
      row.setAttribute("aria-selected", position === index ? "true" : "false");
    });

    renderPreview(entry);
  }

  /**
   * Open the document behind `entry`.
   *
   * The panel closes first, so the navigation it causes is not competing with
   * a panel that would still be covering the document. The second argument is
   * the chapter to land on, which a text hit has none of — the reader searched
   * for words, not for an outline entry — so the document opens at its top and
   * `null` says exactly that.
   */
  function choose(entry) {
    if (!entry) {
      return;
    }

    closePanel();
    onSelect(entry.id, null);
  }

  /** Replace the list with `entries`, selecting `active`. */
  function setResults(next, active) {
    if (!container) {
      return;
    }

    ensurePanelIfNeeded();
    entries = Array.isArray(next) ? next : [];
    rows = [];
    results.textContent = "";

    if (!entries.length) {
      selected = null;
      var empty = document.createElement("p");
      empty.className = EMPTY_CLASS;
      empty.textContent = RESULTS_IDLE_LABEL;
      results.appendChild(empty);
      renderPreview(null);
      return;
    }

    // The selection is cleared before the rows exist, so the first row is not
    // already "selected" and therefore skipped by `mark`.
    selected = null;
    entries.forEach(function (entry, index) {
      rows.push(renderRow(entry, index));
    });

    mark(typeof active === "number" ? active : 0);
  }

  /**
   * `setResults` may be the first thing a page calls — a test, a controller
   * that rendered before opening — so the shell is built on demand rather than
   * relying on `open` having run first.
   */
  function ensurePanelIfNeeded() {
    if (!input) {
      ensurePanel();
    }
  }

  /** One result: the title, then the context it was found in. */
  function renderRow(entry, index) {
    var row = document.createElement("div");
    row.className = RESULT_CLASS;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.setAttribute("data-index", String(index));

    var title = document.createElement("span");
    title.className = TITLE_CLASS;
    title.textContent = String(entry.title || entry.id || "");
    row.appendChild(title);

    var context = document.createElement("span");
    context.className = CONTEXT_CLASS;
    if (entry.snippet) {
      var cut = entry.snippet;
      context.appendChild(
        document.createTextNode((cut.trimmedStart ? ELLIPSIS : "") + cut.before),
      );
      context.appendChild(markNode(cut.hit));
      context.appendChild(document.createTextNode(cut.after + (cut.trimmedEnd ? ELLIPSIS : "")));
    } else {
      // A document matched on its title alone has no passage to quote; its own
      // path is the next most useful thing to put beside the title.
      context.textContent = String(entry.path || entry.id || "");
    }
    row.appendChild(context);

    row.addEventListener("pointermove", function () {
      mark(index);
    });
    row.addEventListener("click", function (event) {
      if (event && typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      mark(index);
      choose(entries[index]);
    });

    results.appendChild(row);
    return row;
  }

  /** A `<mark>` around one word of a snippet. */
  function markNode(text) {
    var mark = document.createElement("mark");
    mark.textContent = String(text === null || text === undefined ? "" : text);
    return mark;
  }

  /**
   * Show the passage `entry` was found in.
   *
   * The entry already carries the cut `search.js` made, so nothing is searched
   * again here; a document with no passage shows the heading of the preview
   * instead of an empty box, which tells the reader *why* there is nothing.
   */
  function renderPreview(entry) {
    if (!preview) {
      return;
    }

    preview.textContent = "";
    // Whether nothing has been asked yet, the query found nothing, or the
    // selected document matched on its title alone, the preview has no passage
    // to show — and it says so the same quiet way every time: by naming itself.
    if (!entry || !entry.snippet) {
      var idle = document.createElement("p");
      idle.className = EMPTY_CLASS;
      idle.textContent = PREVIEW_IDLE_LABEL;
      preview.appendChild(idle);
      return;
    }

    var cut = entry.snippet;
    var passage = document.createElement("p");
    passage.className = "search-passage";
    passage.appendChild(
      document.createTextNode((cut.trimmedStart ? ELLIPSIS : "") + cut.before),
    );
    passage.appendChild(markNode(cut.hit));
    passage.appendChild(document.createTextNode(cut.after + (cut.trimmedEnd ? ELLIPSIS : "")));
    preview.appendChild(passage);
  }

  /** Put the panel on screen with the field focused and its text selected. */
  function openPanel() {
    ensurePanelIfNeeded();
    if (!input) {
      return;
    }

    open = true;
    container.hidden = false;
    container.setAttribute(OPEN_ATTRIBUTE, "true");
    setToggleExpanded(true);
    input.focus();
    if (typeof input.select === "function") {
      input.select();
    }

    // Opening on a field that already holds a query shows that query's
    // results without a keystroke: the reader asked for search, not for a
    // search they have to repeat.
    if (String(input.value).trim()) {
      ask();
    }
  }

  /** Take the panel away and forget the query it held. */
  function closePanel() {
    clearTimer();
    open = false;
    setToggleExpanded(false);

    if (input) {
      input.value = "";
    }
    if (clearButton) {
      clearButton.hidden = true;
    }
    if (container) {
      container.removeAttribute(OPEN_ATTRIBUTE);
      container.hidden = true;
    }

    setResults([], 0);
  }

  function isOpen() {
    return open;
  }

  /** The query on screen, as typed. */
  function query() {
    return input ? input.value : "";
  }

  function toggle() {
    if (open) {
      closePanel();
      return;
    }

    openPanel();
  }

  /** Drop the panel, its listeners and its nodes. */
  function dispose() {
    clearTimer();
    // Only a panel that was built ever registered the listener, and a shell
    // without a container never builds one — so there may be nothing to take
    // away, and where there is no document there is nothing to take it from.
    if (input && typeof document !== "undefined" && document.removeEventListener) {
      document.removeEventListener("pointerdown", onPointerDown, true);
    }
    if (container) {
      container.textContent = "";
    }
    input = null;
    results = null;
    preview = null;
    clearButton = null;
    rows = [];
    entries = [];
    selected = null;
    open = false;
  }

  ensurePanel();

  return {
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    query: query,
    setResults: setResults,
    /** The element the reader types in, for a caller that has to focus it. */
    input: function () {
      return input;
    },
    dispose: dispose,
  };
}

/**
 * The passage a document's hit is in, for a caller that has the document.
 *
 * Re-exported so a controller does not have to import `search.js` twice: the
 * panel and the index agree on what a context is, which is what lets the list
 * and the preview be drawn from one value.
 */
export { matchSnippet };
