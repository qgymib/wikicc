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
 * which the list never re-sorts. The one selected result is what the preview
 * shows, and the selection moves only when the reader asks it to — a click on
 * a row, an arrow key, never a pointer merely crossing the list — so the list
 * and the preview always describe the same row. Opening the document is a
 * firmer gesture still: a double click on the row, or `Enter` on the field.
 *
 * **The preview shows the document, not a quotation from it.** A reader who
 * picked a result is asking to read it, and a paragraph cut out of the middle
 * answers the wrong question: it says "this is the one" where the reader wants
 * to know what it says. So the payload's body is inserted whole — by the same
 * shared document-body render the article uses — scrolls in the preview's own
 * column, and carries a `<mark>` on every place the query occurs — the same
 * words `search.js` found, so the list and the page agree. Diagrams are drawn
 * there because their source would otherwise sit on screen as code; tables
 * are deliberately *not* enhanced, because the sort and filter buttons belong
 * to the article and not to a dialog.
 *
 * Document text reaches the page as text, never as markup: titles and contexts
 * are written with `textContent`, and a passage that falls back to the excerpt
 * is assembled from three nodes. Highlighting works on text nodes for the same
 * reason — the query may as well name a tag as a word, and replacing inside
 * the markup string would tear the document apart at the place the reader is
 * looking. The search engine's `match` data would have been a more direct
 * source for the offsets, but it addresses its own token stream — the words
 * are found in `search.js` instead, in the text the reader sees.
 *
 * Keyboard support is the list's, not the field's: `ArrowUp`/`ArrowDown`,
 * `Home`/`End` move the selection and are taken before the caret can use them,
 * `Enter` opens it where the caret would otherwise insert a newline in a
 * multi-line field, and `Escape` closes the panel — the one key the reader
 * expects to undo whatever is open.
 */
import { ELLIPSIS, matchRanges, matchSnippet } from "./search.js";
import * as Links from "./links.js";
import * as DocBody from "./doc-body.js";

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

/** Class of the whole-document body inside the preview. */
export var DOCUMENT_CLASS = "search-document";

/** Class of one highlighted hit inside the preview. */
export var HIT_CLASS = "search-hit";

/** Class of the banner naming the document the preview shows. */
export var DOC_TITLE_CLASS = "search-doc-title";

/** Class of the document's path under the banner. */
export var DOC_PATH_CLASS = "search-doc-path";

/**
 * Elements whose text is never highlighted.
 *
 * A hit inside a code block or a diagram source is real, but marking it would
 * restart the diagram engine's placeholder text and turn a rendered picture
 * back into source, so those subtrees are left as authored. `mark` is skipped
 * too, which is what keeps a second pass from wrapping a hit it already knows.
 */
var UNHIGHLIGHTED_TAGS = ["PRE", "CODE", "SCRIPT", "STYLE", "MARK"];

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
  // The whole document behind a result, so the preview can show it. Absent in
  // a shell without a payload and in the aim of an older artifact; the preview
  // then keeps the excerpt it always drew, which is degraded but never broken.
  var documentOf = (options && options.documentOf) || null;
  // Diagram colours are baked into the SVG, so the preview has to be drawn for
  // the theme in effect — the same callback the article is rendered with.
  var theme =
    (options && options.theme) ||
    function () {
      return null;
    };
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

  /**
   * What the preview currently shows, as `id + "\u0000" + query`.
   *
   * The list marks a row on every pointer move and every arrow key, and almost
   * all of those land on the row already selected. Rebuilding a whole document
   * — with its highlights and its diagrams — on each of them would make the
   * reader's own pointer stutter, so the signature decides whether there is
   * anything to draw.
   */
  var drawn = null;

  /** The text node wrapped for each hit, so a redraw can put them back. */
  var hits = [];

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
    var link = event && event.target && typeof event.target.closest === "function"
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
    closePanel();
    onSelect(route.id, route.anchor);
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

  /** A `<mark>` around one word of a snippet. */
  function markNode(text) {
    var mark = document.createElement("mark");
    mark.textContent = String(text === null || text === undefined ? "" : text);
    return mark;
  }

  /**
   * Show the document `entry` was found in — the whole of it.
   *
   * A reader who picked a result is asking to read, not to peek: a paragraph
   * cut out of the middle answers "is this the one" but never "what does it
   * say", and the dialog is large enough to hold the article itself. The body
   * is therefore inserted as authored, scrolled on its own, and every hit of
   * the query is marked in place so the eye lands where the list said.
   *
   * Two things the article's own render does and this one must not: enhancing
   * the tables, which injects sort and filter buttons into a panel that is not
   * the reader's page, and nothing else. Diagrams *are* drawn, because their
   * source would otherwise sit on screen as code.
   *
   * A shell with no payload to ask — or a query whose answer landed on a
   * document the payload does not hold — falls back to the excerpt the entry
   * carries, so the half is never blank where it could say something.
   */
  function renderPreview(entry) {
    if (!preview) {
      return;
    }

    if (!entry) {
      // Nothing selected is not a state worth remembering: the panel draws it
      // on build, on every empty answer and again after a close, and a
      // signature for "nothing" would only ever skip one of those.
      drawn = null;
      hits = [];
      preview.textContent = "";
      preview.scrollTop = 0;
      renderIdle();
      return;
    }

    var signature = entry.id + "\u0000" + query();
    if (signature === drawn) {
      return;
    }
    drawn = signature;
    hits = [];

    preview.textContent = "";
    preview.scrollTop = 0;

    var doc = documentFor(entry.id);
    if (doc && typeof doc.html === "string" && doc.html) {
      renderDocument(doc, entry);
      return;
    }

    renderExcerpt(entry);
  }

  /** The payload's document for `id`, or `null` when the shell cannot say. */
  function documentFor(id) {
    if (!documentOf) {
      return null;
    }

    try {
      return documentOf(id) || null;
    } catch (error) {
      // The preview is built from whatever the page hands over; a payload
      // that throws is the page's problem to log, not a reason the panel
      // stops answering.
      return null;
    }
  }

  /** Name the half, in its middle, and say nothing else. */
  function renderIdle() {
    var idle = document.createElement("p");
    idle.className = EMPTY_CLASS;
    idle.textContent = PREVIEW_IDLE_LABEL;
    preview.appendChild(idle);
  }

  /** The fallback: the passage `search.js` cut for the list. */
  function renderExcerpt(entry) {
    var cut = entry && entry.snippet;
    if (!cut) {
      renderIdle();
      return;
    }

    var passage = document.createElement("p");
    passage.className = "search-passage";
    passage.appendChild(
      document.createTextNode((cut.trimmedStart ? ELLIPSIS : "") + cut.before),
    );
    passage.appendChild(markNode(cut.hit));
    passage.appendChild(document.createTextNode(cut.after + (cut.trimmedEnd ? ELLIPSIS : "")));
    preview.appendChild(passage);
  }

  /**
   * Insert the whole document, mark every hit, and scroll to the first one.
   *
   * The path above the body is the one thing the article has and this must
   * not: a reader already knows which document they picked, so the banner
   * repeats it quietly rather than as a title.
   */
  function renderDocument(doc, entry) {
    var banner = document.createElement("div");
    banner.className = "search-doc-head";

    var title = document.createElement("p");
    title.className = DOC_TITLE_CLASS;
    title.textContent = String(doc.title || entry.title || entry.id || "");

    var path = document.createElement("p");
    path.className = DOC_PATH_CLASS;
    path.textContent = String(doc.id || entry.path || entry.id || "");

    banner.appendChild(title);
    banner.appendChild(path);

    // The body is the article's own render — the shared document-body module —
    // with the dialog's one declared difference: its tables stay untouched,
    // because the sort and filter buttons belong to the article and the filter
    // panel they open is parented outside this one.
    var body = DocBody.createDocBody(doc.html, {
      extraClass: DOCUMENT_CLASS,
      enhanceTables: false,
    });

    preview.appendChild(banner);
    preview.appendChild(body);

    highlight(body, query());
    // Diagrams are drawn after insertion — the body module's one deferred
    // step, because the engine measures its labels with the layout — and
    // asynchronously, so the text is readable while the pictures arrive.
    DocBody.drawDiagrams(body, theme());

    scrollToFirstHit(body);
  }

  /**
   * Wrap every hit of `query` in `root`'s text, and remember what was wrapped.
   *
   * The work is done on text nodes, never on markup: the document's own HTML
   * carries tags whose names and attributes could match the query, and a
   * string replacement would tear the page apart at exactly the place the
   * reader is looking. Each node is split at its hits and the middle pieces
   * are replaced by `<mark>` elements around the same text.
   *
   * Splitting while walking is the one ordering hazard here: `splitText`
   * leaves the fresh half *after* the node, where a tree walker would visit
   * it again — and its hits begin where the previous node's ended, so they
   * would be found twice. The walk therefore restarts from the last piece,
   * which is past every hit already handled.
   */
  function highlight(root, value) {
    if (!document.createTreeWalker || !root) {
      return;
    }

    var walker = document.createTreeWalker(root, textNodes(), null);
    var node = walker.nextNode();

    while (node) {
      if (!skippable(node)) {
        var ranges = matchRanges(textOfNode(node), value);
        if (ranges.length) {
          node = wrapHits(node, ranges);
        }
      }
      node = walker.nextNode();
    }
  }

  /** The text a node carries, read the way both a browser and a DOM stand-in allow. */
  function textOfNode(node) {
    if (!node) {
      return "";
    }

    return String(node.nodeValue === undefined ? node.textContent : node.nodeValue);
  }

  /** `NodeFilter.SHOW_TEXT`, without depending on the constant being exposed. */
  function textNodes() {
    return typeof NodeFilter === "undefined" || !NodeFilter.SHOW_TEXT ? 4 : NodeFilter.SHOW_TEXT;
  }

  /** Whether a text node sits in a subtree whose text is left alone. */
  function skippable(node) {
    if (!textOfNode(node).trim()) {
      return true;
    }

    var parent = node.parentNode;
    while (parent && parent !== preview) {
      if (parent.tagName && UNHIGHLIGHTED_TAGS.indexOf(String(parent.tagName).toUpperCase()) !== -1) {
        return true;
      }
      parent = parent.parentNode;
    }

    return false;
  }

  /**
   * Split `node` at `ranges` and wrap each piece in a `<mark>`.
   *
   * The pieces are taken from the right so every split happens on the part
   * that has not been cut yet: `splitText` leaves the new node in place, after
   * the piece before it, so the original node ends up holding only the text up
   * to the first hit and the rest of the chain is built backwards from there.
   * Each `<mark>` then replaces the piece that is exactly its own text.
   *
   * Returns the first hit, which is where the walk resumes — a tree walker
   * enters a `<mark>` and would otherwise offer the highlighted text again.
   */
  function wrapHits(node, ranges) {
    var text = textOfNode(node);
    var rest = node;

    for (var index = ranges.length - 1; index >= 0; index -= 1) {
      var start = ranges[index].start;
      var end = start + ranges[index].length;
      var tail = splitTail(rest, start);
      var piece = splitTail(tail, end - start);

      if (!piece || !tail.parentNode) {
        continue;
      }

      var hit = document.createElement("mark");
      hit.className = HIT_CLASS;
      hit.textContent = text.slice(start, end);
      tail.parentNode.replaceChild(hit, tail);

      hits.push(hit);
      rest = piece;
    }

    return hits.length ? hits[hits.length - 1] : node;
  }

  /**
   * The node holding everything `node` has from `index` onwards.
   *
   * A browser answers with `splitText`; a DOM without it — the fake page the
   * tests drive — cannot cut a node at all, so the node comes back whole and
   * the caller's `<mark>` simply takes its place.
   */
  function splitTail(node, index) {
    if (!node) {
      return null;
    }

    if (typeof node.splitText === "function") {
      return node.splitText(index);
    }

    return node;
  }

  /**
   * Bring the first hit into view inside the preview.
   *
   * The preview is its own scroll container, so the page never moves — and
   * that is the point: the article behind the dialog keeps the place the
   * reader left it. `scrollIntoView` is asked for the nearest block: centring
   * a hit three lines into a short document would leave a gap above it, which
   * reads as missing text.
   */
  function scrollToFirstHit(root) {
    if (!hits.length) {
      return;
    }

    var first = hits[0];
    if (!first || typeof first.scrollIntoView !== "function") {
      return;
    }

    first.scrollIntoView({ block: "nearest" });
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

    // The query is part of what the preview shows, and it has just been
    // emptied: the next opening must draw the document again rather than
    // trust a signature that describes a query nobody can see any more.
    drawn = null;
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
    hits = [];
    drawn = null;
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
