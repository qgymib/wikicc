/**
 * The search dialog's frame: the field, the list of results, and the keys
 * that move through them — everything the dialog does that is not drawing a
 * document.
 *
 * The panel is one column in three parts, top to bottom, and each part is a
 * different answer to the same question: what the reader typed, where it is
 * matched, and how it reads there. The field takes its own height and the
 * other two split the rest — the list a third, the document two thirds —
 * which is one reading line rather than two columns to sweep across.
 * `search.js` supplies every piece of that content; this module only decides
 * when to ask, and draws what comes back. The bottom third is a host element
 * this module builds and `search-preview.js` fills; the two meet in
 * `search-view.js`, which wires the pair and keeps the routes.
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
 * **A result is one place, and one action.** Every place the query occurs is
 * its own row — ten hits in a document are ten rows — so the list reads as a
 * set of passages rather than a set of files, and the row the reader picks is
 * the place the preview opens at. A row is laid out as a table of findings:
 * the passage on the left, the file it was found in on the right, so the words
 * the reader typed lead every line and the files line up in one column the
 * eye can run down. The order is the engine's ranking, which the list never
 * re-sorts. The one selected result is what the preview shows, and
 * the selection moves only when the reader asks it to — a click on a row, an
 * arrow key, never a pointer merely crossing the list — so the list and the
 * preview always describe the same row. Opening the document is a firmer
 * gesture still: a double click on the row, or `Enter` on the field, and the
 * article itself opens on the place the row describes — the query's hits
 * marked there by the same module the preview used, the picked one standing
 * out.
 *
 * **The scope is a button, not a setting.** A search reads the document being
 * read — the default — or every document the site holds, and the button at
 * the field's right edge names the scope in force. Pressing it hands the same
 * query back to the engine at once, without waiting for a pause the reader
 * did not take, and the choice lasts as long as the panel does: a reader who
 * went global was probably looking for something they had not found yet.
 *
 * Document text reaches the page as text, never as markup: contexts and paths
 * are written with `textContent`, so a document containing markup cannot
 * become markup on this page.
 *
 * Keyboard support is the list's, not the field's: `ArrowUp`/`ArrowDown`,
 * `Home`/`End` move the selection and are taken before the caret can use them,
 * `Enter` opens the selected passage in the article where the caret would
 * otherwise insert a newline in a multi-line field, and `Escape` closes the
 * panel — the one key the reader
 * expects to undo whatever is open. Each move keeps its row in sight: the
 * list asks the browser to bring the chosen row in over whichever edge it
 * hangs from, so a long list scrolls with the arrows instead of leaving the
 * selection out of view.
 */
import { ELLIPSIS } from "./search.js";
import { t } from "./i18n.js";

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

/** Class of the context line inside a result: the passage it was found in. */
export var CONTEXT_CLASS = "search-result-context";

/** Class of the trailing cell of a result: the file the passage was found in. */
export var PATH_CLASS = "search-result-path";

/** Class of the preview area at the bottom of the panel. */
export var PREVIEW_CLASS = "search-preview";

/** Class of the placeholder shown where a list or a preview has nothing. */
export var EMPTY_CLASS = "search-empty";

/** Class of the marker naming a result whose document is sealed. */
export var LOCKED_CLASS = "search-result-locked";

/** Text of that marker. */
export var LOCKED_LABEL = "Locked";

/** Hover description the marker carries. */
export var LOCKED_TITLE = "This document is encrypted";

/** Attribute marking the panel as open, which is what the stylesheet animates. */
export var OPEN_ATTRIBUTE = "data-open";

/** Placeholder of the query field. */
export var INPUT_PLACEHOLDER = "Search documents";

/** Accessible name of the panel. */
export var PANEL_LABEL = "Search documents";

/** Accessible name of the clear button. */
export var CLEAR_LABEL = "Clear the search";

/** Class of the button that switches the search's scope. */
export var MODE_CLASS = "search-mode";

/** The scope that reads the document being read. */
export var LOCAL_MODE = "local";

/** The scope that reads every document the site holds. */
export var GLOBAL_MODE = "global";

/** The scope the panel starts in: the reader is usually after what is in view. */
export var DEFAULT_MODE = LOCAL_MODE;

/** Text the scope button carries while the search reads the current document. */
export var MODE_LOCAL_LABEL = "Local";

/** Text the scope button carries while the search reads the whole site. */
export var MODE_GLOBAL_LABEL = "Global";

/** Accessible name of the scope button while the search reads the current document. */
export var MODE_LOCAL_TITLE = "Search every document";

/** Accessible name of the scope button while the search reads the whole site. */
export var MODE_GLOBAL_TITLE = "Search only this document";

/**
 * Shown in the middle of the list while it has no rows to show.
 *
 * The two halves below the field name themselves when they are empty and say
 * nothing once they hold something: an empty area labelled "Results" tells the
 * reader which half they are looking at, and the label leaves with the first
 * row, so no per-empty-state sentence has to be invented — a search that found
 * nothing simply leaves the area empty, which is what it is.
 */
export var RESULTS_IDLE_LABEL = "Results";

/**
 * Shown in the middle of the list while the answer is still on its way.
 *
 * The corpus of the pages format travels over the network the first time
 * a reader searches the whole site; this names that wait where the rows will
 * appear, and the answer replaces it the moment it lands.
 */
export var RESULTS_LOADING_LABEL = "Loading\u2026";

/**
 * How long typing must pause before a query is asked, in milliseconds.
 *
 * Long enough that a word arrives whole, short enough that the list never
 * feels behind the hand that typed it.
 */
export var QUERY_DELAY_MS = 90;

/** Whether a keyboard event is the one that opens the panel on this platform. */
export function isSearchShortcut(event) {
  if (
    !event ||
    typeof event.key !== "string" ||
    event.key.toLowerCase() !== "f"
  ) {
    return false;
  }

  // `Ctrl` on Windows and Linux, `Cmd` on macOS, where the same key combination
  // is what the browser's own find uses — hence the `preventDefault` at the
  // call site, and never `Alt` or `Shift` alone.
  return !!(event.ctrlKey || event.metaKey) && !event.altKey;
}

/** A `<mark>` around one word of a snippet. */
export function markNode(text) {
  var mark = document.createElement("mark");
  mark.textContent = String(text === null || text === undefined ? "" : text);
  return mark;
}

/**
 * Create the search dialog's frame for one reader instance.
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
 * `options.onPreview(entry)` is what the dialog's bottom half does when the
 * row it describes changes — a selection, an empty answer, the loading note,
 * the freshly built shell; `search-preview.js` owns the drawing.
 * `options.onPreviewClick(event)` hears a click on that bottom half, which is
 * the composer's hand-over: a link in the previewed document is a route.
 *
 * Returns `{ open, close, toggle, isOpen, query, setResults, setLoading, mode,
 * input, preview, build, dispose }`, where `setResults` draws what `onQuery`
 * was answered with and `build` puts the shell up — the composer calls it once
 * the preview is wired, which is what keeps "created, therefore built" true.
 * Every method is a no-op when the page has no container, so a shell without a
 * search panel — an older artifact, a test — still runs.
 */
export function createSearchPanel(options) {
  var container = options && options.container;
  var onQuery = (options && options.onQuery) || function () {};
  var onSelect = (options && options.onSelect) || function () {};
  var onPreview = (options && options.onPreview) || function () {};
  var onPreviewClick = (options && options.onPreviewClick) || function () {};
  var delay =
    options && typeof options.delay === "number"
      ? Math.max(0, options.delay)
      : QUERY_DELAY_MS;

  /** The button that opens and closes the panel, if the page has one. */
  var toggleButton = (options && options.toggle) || null;

  var input = null;
  var results = null;
  var preview = null;
  var clearButton = null;
  var modeButton = null;
  var timer = 0;

  /** The scope in force: the document being read, or the whole site. */
  var mode = DEFAULT_MODE;

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
    container.setAttribute("aria-label", t("search.panelLabel"));
    container.hidden = true;

    var field = document.createElement("div");
    field.className = FIELD_CLASS;

    var icon = document.createElementNS
      ? document.createElementNS("http://www.w3.org/2000/svg", "svg")
      : document.createElement("svg");
    icon.setAttribute("class", "search-icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    [
      ["circle", { cx: "11", cy: "11", r: "7" }],
      ["path", { d: "M16.5 16.5 21 21" }],
    ].forEach(function (shape) {
      var node = document.createElementNS
        ? document.createElementNS("http://www.w3.org/2000/svg", shape[0])
        : document.createElement(shape[0]);
      Object.keys(shape[1]).forEach(function (name) {
        node.setAttribute(name, shape[1][name]);
      });
      icon.appendChild(node);
    });

    input = document.createElement("input");
    input.className = INPUT_CLASS;
    input.setAttribute("type", "search");
    input.setAttribute("placeholder", t("search.placeholder"));
    input.setAttribute("aria-label", t("search.placeholder"));
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
    clearButton.setAttribute("aria-label", t("search.clear"));
    clearButton.setAttribute("title", CLEAR_LABEL);
    clearButton.hidden = true;
    clearButton.addEventListener("click", onClearClick);

    // The scope button sits at the field's right edge, past the clear button:
    // the two are both field furniture, and the reader reaching for either is
    // still reaching for the field.
    modeButton = document.createElement("button");
    modeButton.className = MODE_CLASS;
    modeButton.setAttribute("type", "button");
    modeButton.addEventListener("click", onModeClick);
    syncModeButton();

    field.appendChild(icon);
    field.appendChild(input);
    field.appendChild(clearButton);
    field.appendChild(modeButton);

    results = document.createElement("div");
    results.className = RESULTS_CLASS;
    results.setAttribute("role", "listbox");
    results.setAttribute("aria-label", t("search.matchingAria"));

    preview = document.createElement("div");
    preview.className = PREVIEW_CLASS;
    preview.setAttribute("aria-live", "polite");
    // A click on the previewed document is the composer's hand-over: a link
    // there is a route, and the browser must not take it behind the dialog.
    preview.addEventListener("click", onPreviewClick);

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
    empty.textContent = t("search.resultsIdle");
    results.appendChild(empty);
    onPreview(null);
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
    if (!toggleButton || !node) {
      return false;
    }
    if (typeof toggleButton.contains === "function") {
      return toggleButton.contains(node);
    }

    return node === toggleButton;
  }

  /**
   * The state the opening button describes, whatever way the panel changed.
   *
   * Every close — the button, `Escape`, a pick, a press outside — passes
   * through here, so the button never says the panel is open after the panel
   * has gone; the caller keeps its own sync for the paths it drives.
   */
  function setToggleExpanded(expanded) {
    if (toggleButton && typeof toggleButton.setAttribute === "function") {
      toggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
  }

  /** A press outside the panel closes it; one inside it is used by the panel. */
  function onPointerDown(event) {
    if (
      !open ||
      contains(event && event.target) ||
      insideToggle(event && event.target)
    ) {
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

    onQuery(query, mode);
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

  /**
   * Describe the scope on its button: what is searched now, and what a click
   * asks instead.
   *
   * The label names the scope in force, as the graph's mode button does; the
   * accessible name and the tooltip describe the state a press leads to, and
   * `aria-pressed` carries the state itself, which a screen reader announces
   * before the label.
   */
  function syncModeButton() {
    if (!modeButton) {
      return;
    }

    var global = mode === GLOBAL_MODE;
    var label = global
      ? t("search.modeGlobalTitle")
      : t("search.modeLocalTitle");
    modeButton.textContent = global
      ? t("search.modeGlobal")
      : t("search.modeLocal");
    modeButton.setAttribute("aria-pressed", global ? "true" : "false");
    modeButton.setAttribute("aria-label", label);
    modeButton.setAttribute("title", label);
  }

  /** Switch the scope and ask again at once, without waiting for a pause. */
  function onModeClick(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }

    mode = mode === GLOBAL_MODE ? LOCAL_MODE : GLOBAL_MODE;
    syncModeButton();

    // The list on screen describes the scope just left, so the answer is
    // asked for now — a pending debounce from before is cancelled rather
    // than kept, because the query it would settle is the old scope's.
    clearTimer();
    ask();

    // The press left the focus on the button, and the keys that answer the
    // list are bound to the field: a reader who switched the scope is still
    // searching, so the field takes the focus back — the same return the
    // clear button makes — instead of leaving the arrows to scroll the page
    // behind the dialog. The text stays unselected, so a stroke amends the
    // query rather than sweeping it.
    if (input) {
      input.focus();
    }
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

    reveal(rows[index]);
    onPreview(entry);
  }

  /**
   * Ask the browser to bring `row` into the list's viewport.
   *
   * `nearest` is the listbox semantics the arrows want: a row hanging below
   * the window aligns its bottom edge with the viewport's, so a downward step
   * lands on the last visible row, and a row above aligns its top edge — an
   * upward step lands on the first. A row already showing stays where it is,
   * and a list that never overflowed scrolls nothing at all. The view asks
   * rather than computes because the browser owns the geometry; a page
   * without one — the tests — simply never hears the question.
   */
  function reveal(row) {
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * Open the document behind `entry`, at the place the row described.
   *
   * The panel closes first, so the navigation it causes is not competing with
   * a panel that would still be covering the document. The second argument is
   * the chapter to land on, which a text hit has none of — the reader searched
   * for words, not for an outline entry — so the document opens at its top and
   * `null` says exactly that. The place itself travels as the third argument:
   * the query the field still holds and the ordinal the row carried, for the
   * caller to mark the article with and walk to — the same places the preview
   * just showed. A pick with no place in the body, a title-only match, carries
   * no jump: there is nothing to land on, and the top is the whole answer.
   */
  function choose(entry) {
    if (!entry) {
      return;
    }

    // The query is read before the panel closes, which empties the field:
    // the jump has to name the words the article is about to mark.
    var jump = entry.hit >= 0 ? { query: query(), hit: entry.hit } : null;
    closePanel();
    onSelect(entry.id, null, jump);
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
      empty.textContent = t("search.resultsIdle");
      results.appendChild(empty);
      onPreview(null);
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

  /**
   * One result, as one row of a table: the passage it was found in on the
   * left, and the file it was found in on the right.
   *
   * The row used to lead with the title, which made the list a list of
   * documents with a quotation under each. Leading with the passage turns it
   * into a list of places instead — what the reader typed is the leftmost
   * thing on every line, so the eye compares one hit with the next without
   * reading past a document name first — and the name moves to the column it
   * would occupy in any table of findings: the trailing one.
   *
   * The trailing cell gives the file's path, which already ends in its name:
   * a result names where to go, not what the document calls itself. Two files
   * that share a title are told apart by it, where a title would have read the
   * same twice and said nothing. A title-only match — a document whose name
   * matches where its text does not — has no passage to quote, so the left
   * cell stays empty rather than repeating the path the right cell carries.
   */
  function renderRow(entry, index) {
    var row = document.createElement("div");
    row.className = RESULT_CLASS;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.setAttribute("data-index", String(index));

    var context = document.createElement("span");
    context.className = CONTEXT_CLASS;
    if (entry.snippet) {
      var cut = entry.snippet;
      context.appendChild(
        document.createTextNode(
          (cut.trimmedStart ? ELLIPSIS : "") + cut.before,
        ),
      );
      context.appendChild(markNode(cut.hit));
      context.appendChild(
        document.createTextNode(cut.after + (cut.trimmedEnd ? ELLIPSIS : "")),
      );
    } else if (entry.locked) {
      // A sealed document is a title-only match by construction — its body
      // is the ciphertext — so the cell the passage would fill names the
      // lock instead of sitting empty.
      context.appendChild(lockedMarker());
    }
    row.appendChild(context);

    // The file cell truncates from the left, keeping the file name and giving
    // up the directories above it — the ellipsis trails behind whatever the
    // reader is actually looking for, instead of throwing it away. The whole
    // path is also the cell's `title`, so a reader whose cell is too narrow
    // can hover it and read all of it.
    var file = String(entry.path || entry.id || "");

    var path = document.createElement("span");
    path.className = PATH_CLASS;
    path.setAttribute("title", file);
    path.textContent = file;
    row.appendChild(path);

    // The selection follows the reader's decision, not the pointer's path:
    // crossing a row on the way somewhere else must not rewrite the preview
    // the reader is reading. A click is the deliberate "show me this one".
    row.addEventListener("click", function (event) {
      if (event && typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      mark(index);
    });

    // Opening the document is a firmer gesture: a double click, whose two
    // clicks have already selected this row, so only the `dblclick` itself
    // needs to navigate.
    row.addEventListener("dblclick", function (event) {
      if (event && typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      choose(entries[index]);
    });

    results.appendChild(row);
    return row;
  }

  /** The marker that names a sealed document in the row its title was found by. */
  function lockedMarker() {
    var marker = document.createElement("span");
    marker.className = LOCKED_CLASS;
    marker.setAttribute("title", t("search.lockedTitle"));
    marker.textContent = t("search.lockedLabel");
    return marker;
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

    // The field's query is gone, and the query is part of what the preview
    // shows: the empty answer below redraws the idle half rather than trust a
    // signature that describes a query nobody can see any more.
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
    if (
      input &&
      typeof document !== "undefined" &&
      document.removeEventListener
    ) {
      document.removeEventListener("pointerdown", onPointerDown, true);
    }
    if (container) {
      container.textContent = "";
    }
    input = null;
    results = null;
    preview = null;
    clearButton = null;
    modeButton = null;
    rows = [];
    entries = [];
    selected = null;
    mode = DEFAULT_MODE;
    open = false;
  }

  /**
   * Show that the answer is still on its way.
   *
   * The corpus of the pages format is fetched on the first global search,
   * so the query that triggered it cannot be answered yet: the wait is named
   * where the rows will appear, and the answer replaces it when it lands.
   * Nothing is selected and the preview holds nothing, because there is
   * nothing yet to select or show.
   */
  function setLoading() {
    if (!container) {
      return;
    }

    ensurePanelIfNeeded();
    entries = [];
    rows = [];
    selected = null;
    results.textContent = "";

    var loading = document.createElement("p");
    loading.className = EMPTY_CLASS;
    loading.textContent = t("search.resultsLoading");
    results.appendChild(loading);
    onPreview(null);
  }

  return {
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    query: query,
    setResults: setResults,
    setLoading: setLoading,
    /** The scope in force, for a caller that describes it elsewhere. */
    mode: function () {
      return mode;
    },
    /** The element the reader types in, for a caller that has to focus it. */
    input: function () {
      return input;
    },
    /** The element the preview draws into, for the module that fills it. */
    preview: function () {
      return preview;
    },
    /** Put the shell up now; the composer calls this once the preview exists. */
    build: ensurePanel,
    dispose: dispose,
  };
}
