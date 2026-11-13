/**
 * Reader controller: payload, theme, hash routing, search and layout controls.
 *
 * The payload is embedded by the build as `<script type="application/json">`.
 * In the shell formats it carries every document, so reading is a lookup and
 * no request is ever made. In the pages format it carries only the
 * manifest, and the documents arrive from `pages/` when the reader navigates
 * to them (see `doc-store.js`) — which is why a document render is a promise
 * the controller guards against a newer navigation, and why the whole-site
 * search asks for its corpus the first time the reader widens the scope.
 *
 * Document HTML is inserted with `innerHTML` because the Markdown source is
 * trusted build input (raw HTML passthrough is documented behaviour, see
 * `docs/design.md`); every other string goes through `textContent`.
 *
 * `main.js` is the bundle entry point and calls `start()`; this module only
 * exports the controller so the same functions stay testable in isolation.
 */
import * as Router from "./router.js";
import * as Links from "./links.js";
import * as AssetLinks from "./asset-links.js";
import * as Search from "./search.js";
import * as SearchView from "./search-view.js";
import * as SearchHighlight from "./search-highlight.js";
import * as DocStore from "./doc-store.js";
import * as DocList from "./doc-list.js";
import * as Toc from "./toc.js";
import * as DocBody from "./doc-body.js";
import * as GraphView from "./graph-view.js";
import * as Diagrams from "./diagrams.js";
import * as DiagramView from "./diagram-view.js";
import * as PreviewView from "./preview-view.js";
import * as Anchor from "./anchor.js";
import * as Banner from "./banner.js";

/** `localStorage` key holding the explicit theme choice. */
var THEME_KEY = "wikicc.theme";

/** `localStorage` key holding the document list's visibility. */
var SIDEBAR_KEY = "wikicc.sidebar";

/**
 * `localStorage` key holding which panels were put away: the hidden set as
 * `none`, one panel's name, or `both`.
 */
var PANELS_KEY = "wikicc.panels";

/** The media query below which the document list is a drawer, not a column. */
var DRAWER_QUERY = "(max-width: 640px)";

/** Class of the banner shown when a chapter anchor does not exist. */
export var ALERT_CLASS = Banner.BANNER_CLASS;

/** Class of the paragraph shown while a document is being fetched. */
export var LOADING_CLASS = "doc-loading";

/** Read and parse the embedded payload. */
function readPayload() {
  var element = document.getElementById("wikicc-payload");
  if (!element) {
    throw new Error("wikicc payload element is missing");
  }
  return JSON.parse(element.textContent);
}

/** Whether the page was opened from a `file://` address. */
function openedFromFile() {
  return (
    typeof globalThis.location === "object" &&
    globalThis.location !== null &&
    globalThis.location.protocol === "file:"
  );
}

/** Theme the operating system asks for. */
export function systemTheme() {
  if (typeof globalThis.matchMedia === "function") {
    return globalThis.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return "dark";
}

/** Explicit theme choice, or `null` when the reader should follow the OS. */
function storedTheme() {
  try {
    var value = globalThis.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch (_error) {
    return null;
  }
}

function storeTheme(theme) {
  try {
    globalThis.localStorage.setItem(THEME_KEY, theme);
  } catch (_error) {
    /* Storage can be disabled; the theme still applies for this page. */
  }
}

/** Whether the document list was put away on an earlier visit. */
function storedSidebar() {
  try {
    return globalThis.localStorage.getItem(SIDEBAR_KEY) === "hidden";
  } catch (_error) {
    return false;
  }
}

function storeSidebar(hidden) {
  try {
    globalThis.localStorage.setItem(SIDEBAR_KEY, hidden ? "hidden" : "visible");
  } catch (_error) {
    /* Storage can be disabled; the list still hides for this page. */
  }
}

/** The panel set that was put away on an earlier visit, or `null` for none. */
function storedPanels() {
  try {
    var value = globalThis.localStorage.getItem(PANELS_KEY);
    return value === "graph" ||
      value === "outline" ||
      value === "both" ||
      value === "none"
      ? value
      : null;
  } catch (_error) {
    return null;
  }
}

function storePanels(graphHidden, outlineHidden) {
  var value =
    graphHidden && outlineHidden
      ? "both"
      : graphHidden
        ? "graph"
        : outlineHidden
          ? "outline"
          : "none";
  try {
    globalThis.localStorage.setItem(PANELS_KEY, value);
  } catch (_error) {
    /* Storage can be disabled; the panels still fold for this page. */
  }
}

/** Theme currently in effect: the explicit choice, or the system preference. */
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || systemTheme();
}

/** Apply a theme and keep the toggle's accessible state in sync. */
export function applyTheme(theme, toggle) {
  if (theme) {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }

  if (toggle) {
    var current = theme || systemTheme();
    var label =
      current === "light" ? "Switch to dark theme" : "Switch to light theme";
    toggle.setAttribute("aria-pressed", current === "light" ? "true" : "false");
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }
}

/**
 * Describe the graph's mode on its button: what is shown now, and what a click
 * would show instead.
 *
 * The label names the *next* state rather than the current one, as a switch
 * does: the reader is looking at the panel and can see what it holds, so the
 * button only has to say where it leads. `aria-pressed` carries the state
 * itself, which is what a screen reader announces before the label.
 */
export function syncModeButton(button, mode) {
  if (!button) {
    return;
  }

  var global = mode === GraphView.GLOBAL_MODE;
  var label = global
    ? "Show only this document and its neighbours"
    : "Show the whole graph";
  button.textContent = global ? "Global" : "Local";
  button.setAttribute("aria-pressed", global ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

export function start() {
  var bundle = readPayload();
  var docs = Array.isArray(bundle.docs) ? bundle.docs : [];
  var ids = docs.map(function (doc) {
    return doc.id;
  });
  // The document the reader opens at an empty or unknown address, from the
  // `home` key of .wikicc.json; anything else falls back to the first one.
  var home = typeof bundle.home === "string" ? bundle.home : null;
  var store = DocStore.createDocStore(bundle);

  var content = document.getElementById("doc-content");
  var article = document.getElementById("doc-article");
  var stats = document.getElementById("stats");
  var sidebarToggle = document.getElementById("sidebar-toggle");
  var sidebarCollapse = document.getElementById("sidebar-collapse");
  var backdrop = document.getElementById("drawer-backdrop");
  var themeToggle = document.getElementById("theme-toggle");
  var graphToggle = document.getElementById("graph-toggle");
  var outlineToggle = document.getElementById("outline-toggle");

  /**
   * The index over the whole site, and the records its answers are cut from.
   *
   * The embedded formats build both once, at startup, from the payload. The
   * pages format builds neither: its corpus is a file the reader fetches
   * the first time the scope widens past the document in view, and while it
   * travels the global scope answers "loading" instead of pretending there is
   * nothing to find.
   */
  var index = store.isLazy() ? null : Search.createSearch(docs);
  var corpusDocs = store.isLazy() ? null : docs;
  var globalIndexPromise = null;

  /** The whole-site index, fetching the corpus first when it is separate. */
  function ensureGlobalIndex() {
    if (index) {
      return Promise.resolve(index);
    }
    if (globalIndexPromise) {
      return globalIndexPromise;
    }

    globalIndexPromise = store.corpus().then(function (records) {
      if (records && records.length) {
        corpusDocs = records;
        index = Search.createSearch(records);
      }
      return index;
    });

    return globalIndexPromise;
  }

  var currentId = null;
  var firstRender = true;

  /**
   * Chapter a pending navigation has to report even though its route cannot.
   *
   * A broken block reference routes to its document without an anchor, so the
   * href the browser would have followed carries no hint at all. Clicking such
   * a link stores the authored chapter here, and `render` — which every
   * navigation ends up in, whether it came from a hash change or a direct
   * call — shows it once the document is on screen.
   */
  var pendingMissing = null;

  /**
   * The passage a pending navigation has to open at, or `null`.
   *
   * A search result names a place no route can carry: the hits live in the
   * body's text, and an address holds only a chapter. Opening one with
   * `Enter` therefore navigates by id alone and queues the place here — the
   * query to mark the article with and the ordinal to walk to — for the
   * render the navigation causes to consume. One navigation, one queue: like
   * `pendingMissing` it is taken once and never replayed, so a later
   * navigation can never inherit a jump that was not its own.
   */
  var pendingJump = null;

  /**
   * The `<mark>` elements the article currently carries for a search jump.
   *
   * The marks are the article's until the next navigation: a reader who
   * arrived at a passage wants to see where they are, and a reader who moves
   * on wants the page back as authored. Clearing unwraps each mark back into
   * its text, which also restores the original text the next jump's walk has
   * to count over.
   */
  var searchMarks = [];

  var preview = PreviewView.createPreviewView({
    content: content,
    documents: store,
    theme: currentTheme,
    onNavigate: navigate,
    // Only a click reports a broken reference this way. Hovering one opens the
    // preview panel with a notice instead, because a hint about the link under
    // the pointer belongs beside it. A click navigates, so its message is
    // queued for the render it triggers — shown now, it would be dismissed by
    // the navigation that follows it.
    onMissingChapter: function (message) {
      pendingMissing = { docId: message.docId, anchor: message.anchor };
      showMissingChapter(message);
    },
  });

  var docList = DocList.createDocList({
    container: document.getElementById("doc-list"),
    docs: docs,
    onSelect: navigate,
  });

  var toc = Toc.createToc({
    container: document.getElementById("toc"),
    onNavigate: navigate,
  });

  var graph = GraphView.createGraph({
    container: document.getElementById("graph"),
    docs: docs,
    edges: Array.isArray(bundle.edges) ? bundle.edges : [],
    onSelect: navigate,
    // A reader lands on the document they came for, not on a picture of the
    // whole site: the local view answers what this document is connected to.
    mode: GraphView.LOCAL_MODE,
  });

  var modeButton = document.getElementById("graph-mode");
  if (modeButton) {
    syncModeButton(modeButton, graph.getMode());
    modeButton.addEventListener("click", function () {
      var next =
        graph.getMode() === GraphView.GLOBAL_MODE
          ? GraphView.LOCAL_MODE
          : GraphView.GLOBAL_MODE;
      graph.setMode(next);
      syncModeButton(modeButton, graph.getMode());
    });
  }

  var fitButton = document.getElementById("graph-fit");
  if (fitButton) {
    fitButton.addEventListener("click", function () {
      graph.fit();
    });
  }

  /**
   * The search panel, which owns its own markup and asks for content here.
   *
   * A reader picks a document from it and lands in the article: the panel
   * closes first, inside the view, so the navigation it causes is not fighting
   * a panel still covering the page.
   */
  var searchButton = document.getElementById("search-toggle");
  var searchPanel = document.getElementById("search-panel");

  var searchView = SearchView.createSearchView({
    container: searchPanel,
    // The button asks the panel to open and to close; the view leaves the
    // button's own presses alone so the click below decides which.
    toggle: searchButton,
    // The preview shows the whole document behind the selected result, so the
    // view asks the store for it instead of the list carrying every body
    // along; a document that has to be fetched first is rendered when it
    // lands.
    documents: store,
    theme: currentTheme,
    onQuery: function (query, mode) {
      var sequence = ++querySequence;
      if (mode === SearchView.GLOBAL_MODE && !index) {
        // The corpus is a separate file in the pages format and this is
        // the first global search: name the wait, then answer when it lands.
        searchView.setLoading();
        ensureGlobalIndex().then(function (loaded) {
          if (sequence !== querySequence) {
            return; // A newer query owns the list now.
          }
          if (!loaded) {
            // The corpus never arrived: an empty answer is honest, and a
            // loading note forever is not.
            searchView.setResults([], 0);
            return;
          }
          searchView.setResults(searchResults(query, mode), 0);
        });
        return;
      }

      searchView.setResults(searchResults(query, mode), 0);
    },
    onSelect: function (id, anchor, jump) {
      // The passage a result names travels outside the route: queue it for
      // the render this navigation causes, then let the address change.
      pendingJump = jump || null;
      navigate(id, anchor);
    },
  });

  /** Show the panel and say so on the button that asked for it. */
  function openSearch() {
    searchView.open();
    if (searchButton) {
      searchButton.setAttribute("aria-expanded", "true");
    }
  }

  function closeSearch() {
    searchView.close();
    if (searchButton) {
      searchButton.setAttribute("aria-expanded", "false");
    }
  }

  if (searchButton) {
    // The button describes the panel from the start, so a reader arriving with
    // a screen reader hears a control that is closed rather than one that says
    // nothing about what it controls.
    searchButton.setAttribute("aria-expanded", "false");
    searchButton.addEventListener("click", function () {
      if (searchView.isOpen()) {
        closeSearch();
        return;
      }
      openSearch();
    });
  }

  function setDrawer(open) {
    document.body.setAttribute("data-drawer", open ? "open" : "closed");
    if (sidebarToggle) {
      sidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (backdrop) {
      backdrop.hidden = !open;
    }
  }

  /** Whether the reader is at a width where the document list is a drawer. */
  function drawerMode() {
    return (
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia(DRAWER_QUERY).matches
    );
  }

  /**
   * Put the document list's column away or bring it back.
   *
   * The wide layouts hide the list through the body attribute alone; the
   * drawer's state is a different attribute and never touched here. The
   * header's switch answers for the column — collapsed, it is the rail the
   * reader brings the list back from, so its accessible state and the label
   * it offers follow the list, not the gesture.
   */
  function setSidebarHidden(hidden) {
    if (hidden) {
      document.body.setAttribute("data-sidebar", "hidden");
    } else {
      document.body.removeAttribute("data-sidebar");
    }
    if (sidebarCollapse) {
      var label = hidden ? "Show document list" : "Hide document list";
      sidebarCollapse.setAttribute("aria-expanded", hidden ? "false" : "true");
      sidebarCollapse.setAttribute("aria-label", label);
      sidebarCollapse.setAttribute("title", label);
    }
  }

  /**
   * Put one of the panels away or bring it back.
   *
   * Each panel answers to its own body attribute, so the two can be combined
   * freely — both showing, one, neither; the stylesheet folds the whole column
   * when neither shows. The switch is rail furniture like the list's: its
   * accessible state and the label it offers follow the panel, not the
   * gesture.
   */
  function setPanelHidden(panel, hidden) {
    var attribute = panel === "graph" ? "data-graph" : "data-outline";
    var button = panel === "graph" ? graphToggle : outlineToggle;
    if (hidden) {
      document.body.setAttribute(attribute, "hidden");
    } else {
      document.body.removeAttribute(attribute);
    }
    if (button) {
      var label =
        (hidden ? "Show " : "Hide ") +
        (panel === "graph" ? "graph panel" : "outline panel");
      button.setAttribute("aria-expanded", hidden ? "false" : "true");
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
  }

  /**
   * Walk the reader to `route`'s chapter without rebuilding the document.
   *
   * Used when the requested address is the one already showing: the browser
   * fires no `hashchange` for it, and a render here would tear the article down
   * and put a fresh copy back — losing the very scroll position it had just
   * been asked to reach. The document is already the right one, so only the
   * chapter is resolved. An unknown document or chapter is not an error: the
   * reader stays where they are, exactly as a navigation to nothing would.
   */
  function scrollToAnchorOnly(route) {
    var jump = pendingJump;
    pendingJump = null;

    var doc = route && route.id ? store.peek(route.id) : null;
    if (!doc) {
      return;
    }

    docList.render(null, doc.id);
    graph.setActive(doc.id);

    if (!route.anchor) {
      if (typeof globalThis.scrollTo === "function") {
        globalThis.scrollTo(0, 0);
      }
    } else {
      scrollToAnchor(findAnchor(doc, route.anchor));
    }

    // The document is already the right one, so a jump is a marking and a
    // walk, not a render: the marks a previous arrival left go first, and
    // the passage the reader just asked for is applied to the body on
    // screen. A navigation that is not a jump takes the page back as
    // authored.
    SearchHighlight.clearSlots(searchMarks);
    searchMarks = [];
    if (jump) {
      applySearchJump(jump);
    }
  }

  /**
   * Scroll to `anchor` once more after the document has settled.
   *
   * A render inserts markup whose height keeps changing for a moment: diagrams
   * replace their source blocks asynchronously, images arrive, fonts reflow.
   * The scroll a render performs is therefore only the first attempt, and it
   * can leave the reader short of the chapter. Two frames later the layout is
   * stable enough to correct it. Environments without
   * `requestAnimationFrame` — the node tests — get the single attempt.
   */
  function settleAtAnchor(doc, anchor, frames) {
    if (!anchor) {
      return;
    }

    var remaining = typeof frames === "number" ? frames : 2;
    if (
      remaining <= 0 ||
      typeof globalThis.requestAnimationFrame !== "function"
    ) {
      scrollToAnchor(findAnchor(doc, anchor));
      return;
    }

    globalThis.requestAnimationFrame(function () {
      scrollToAnchor(findAnchor(doc, anchor));
      settleAtAnchor(doc, anchor, remaining - 1);
    });
  }

  /**
   * Walk to `jump`'s hit once more after the document has settled.
   *
   * The same settling every anchor scroll faces: diagrams replace their
   * source blocks, images arrive, fonts reflow, and the first scroll can
   * leave the reader short of the passage. Two frames later the layout is
   * stable enough to correct it. Environments without
   * `requestAnimationFrame` — the node tests — keep the single attempt the
   * jump itself made.
   */
  function settleAtHit(slots, ordinal, frames) {
    var remaining = typeof frames === "number" ? frames : 2;
    if (
      remaining <= 0 ||
      typeof globalThis.requestAnimationFrame !== "function"
    ) {
      return;
    }

    globalThis.requestAnimationFrame(function () {
      SearchHighlight.scrollToSlot(slots, ordinal);
      settleAtHit(slots, ordinal, remaining - 1);
    });
  }

  function navigate(id, anchor) {
    setDrawer(false);
    var hash = Router.formatHash(id, anchor);
    // Compared as routes, not as strings: the address bar may hold either
    // spelling of the same chapter, and only a *different* route makes the
    // browser fire `hashchange`.
    if (Links.isSameRoute(globalThis.location.hash, hash)) {
      // The address already says this: setting it again would fire nothing, so
      // the chapter is walked to directly instead of through a render.
      scrollToAnchorOnly(Router.resolveRoute(hash, ids, home));
      return;
    }

    globalThis.location.hash = hash;
  }

  /** Banner for a chapter the current document does not contain. */
  var banner = Banner.createBanner({
    container: content,
    host: document.getElementById("doc-alert"),
  });

  // The pages format fetches its documents and its search corpus, and a
  // browser refuses every one of those requests from a `file://` page. That is
  // said once, where the reader is looking, instead of once per navigation.
  if (store.isLazy() && openedFromFile()) {
    banner.showMessage(
      "This site is built in the pages format and needs to be served over HTTP(S); opening it from a file:// page cannot load its documents.",
    );
  }

  /**
   * Say that the document of `message` has no chapter `message.anchor`.
   *
   * Only a navigation calls this: a click on a broken reference, whose queued
   * message `render` replays once the document is on screen. Hovering the same
   * reference never gets here — it is answered by the preview panel's notice.
   */
  function showMissingChapter(message) {
    banner.show({
      docId: message && message.docId ? String(message.docId) : "",
      anchor: message && message.anchor ? String(message.anchor) : "",
    });
  }

  /**
   * Resolve `anchor` against `doc` and the live document.
   *
   * The route normally carries the anchor the build wrote, which is the heading
   * id itself; an artifact from an older build may still carry the author's
   * spelling, so the payload's outline is consulted as well. `null` means the
   * document really has no such chapter.
   */
  function findAnchor(doc, anchor) {
    return Anchor.resolveDocAnchor(doc, anchor, function (id) {
      return document.getElementById(id);
    });
  }

  /**
   * Park the document at `anchor`, which `findAnchor` has already resolved.
   *
   * A chapter the reader folded away is `hidden`, and nothing scrolls to a
   * hidden element: a deep link, an outline entry or a block reference pointing
   * inside a folded chapter would open the document at the top and say
   * nothing. Reopening the chapters that hold it first is what keeps every
   * route working, and it is the reader's own request that reopens them.
   */
  function scrollToAnchor(found) {
    if (!found || !found.element) {
      return;
    }

    var body = content.querySelector("." + DocBody.BODY_CLASS);
    if (body) {
      DocBody.expandTo(body, found.element);
    }

    if (found.element.scrollIntoView) {
      found.element.scrollIntoView({ block: "start" });
    }
  }

  /**
   * Empty the content column and put the banner and the article back.
   *
   * The banner slot sits beside the article for the whole session, so a
   * document change can neither remove it nor rebuild it; whatever a document
   * render, a loading note or a failure message writes, it writes into the
   * article only.
   */
  function mountArticle() {
    content.textContent = "";
    content.appendChild(banner.element());
    content.appendChild(article);
    article.textContent = "";
  }

  /** Name the wait where the document will appear. */
  function renderLoading(id) {
    var loading = document.createElement("p");
    loading.className = LOADING_CLASS;
    loading.textContent = "Loading " + id + " \u2026";

    mountArticle();
    article.appendChild(loading);
    // The previous document's outline would be a lie about what is open.
    toc.render([], id);
    document.title = bundle.title;
  }

  /** Say that the document never arrived, and why that can happen. */
  function renderLoadError(route) {
    var failed = document.createElement("p");
    failed.className = "doc-empty";
    failed.textContent = "This document could not be loaded.";

    mountArticle();
    article.appendChild(failed);
    toc.render([], route.id);
    document.title = bundle.title;
    banner.showMessage(
      "Could not load " +
        route.id +
        " \u2014 the file is missing, or the site is not being served over HTTP.",
    );
  }

  function renderDocument(doc) {
    var path = document.createElement("p");
    path.className = "doc-path";
    path.textContent = doc.id;

    // The shared document-body render: markup in, tables enhanced in the same
    // breath and still before insertion, so the first paint already carries
    // the sortable headers, filter buttons, code copy buttons and chapter
    // fold arrows. Folding is asked for here and nowhere else: the search
    // preview would read the arrow as a press outside its dialog, and the
    // hover preview is a window onto a chapter rather than a place to read
    // one.
    var body = DocBody.createDocBody(doc.html, {
      enhanceTables: true,
      collapsible: true,
      codeCopy: true,
    });

    mountArticle();
    article.appendChild(path);
    article.appendChild(body);

    // Diagrams are drawn after insertion — the one step the body module defers
    // to its caller, because the engine measures label sizes with the DOM,
    // which is impossible for a detached subtree. The call is asynchronous and
    // swallows its own failures, so the document is already readable when the
    // SVGs replace their source blocks.
    DocBody.drawDiagrams(body, currentTheme());

    // Formulas are typeset in the same insertion-time contract; the call is
    // synchronous and swallows its own failures.
    DocBody.drawMath(body);

    // The links this document carries are the ones the hover preview watches.
    preview.tag(body);
  }

  /** Re-render the current document's diagrams for the theme now in effect. */
  function refreshDiagrams() {
    var doc = currentId ? store.peek(currentId) : null;
    if (!doc || !Diagrams.hasDiagramSource(doc.html)) {
      return;
    }

    var body = content.querySelector(".doc-body");
    if (!body) {
      return;
    }

    // Diagram colours are baked into the SVG, so the rendered diagram has to be
    // reset to its source and drawn again. Only the diagrams are touched: the
    // rest of the document keeps its scroll position, table sort and filters.
    DiagramView.resetDiagrams(body);
    DiagramView.renderDiagrams(body, currentTheme());
  }

  /**
   * Place the document `route` names, already fetched, and walk to its chapter.
   *
   * Everything a navigation ends with happens here: the body, the outline, the
   * title, the anchor scroll, the address canonicalisation and the focus. The
   * parts that belong to a document change are guarded by `changed`, so a
   * re-anchor of the document on screen keeps its scroll position, its table
   * sorts and its fold states.
   */
  function place(route, doc, wanted, changed, jump) {
    if (changed) {
      renderDocument(doc);
      toc.render(doc.toc, doc.id);
      document.title = doc.title
        ? doc.title + " · " + bundle.title
        : bundle.title;
    }

    // A block reference whose chapter the document does not have still opens
    // the document, at the top, and says what was asked for. A click on such a
    // reference leaves no anchor in the route — the build cannot address a
    // chapter that has no element — so the queued message stands in for it.
    var found = findAnchor(doc, route.anchor);
    if (found) {
      scrollToAnchor(found);
      // Fresh markup changes height while it settles — that is what diagrams
      // and images do — so the chapter is walked to again once it has.
      settleAtAnchor(doc, route.anchor);
    } else if (wanted && wanted.anchor) {
      showMissingChapter(wanted);
      // The document is opened from its top: there is no chapter to scroll to.
      if (typeof globalThis.scrollTo === "function") {
        globalThis.scrollTo(0, 0);
      } else {
        var scrolling = document.scrollingElement || document.documentElement;
        scrolling.scrollTop = 0;
      }
    }

    // The jump lands last: the body is on screen, an anchor walk above has
    // had its say, and the reader's newest request is the passage the search
    // named. Without a jump the page is taken back as authored — the marks
    // of an arrival do not follow the reader into the reading.
    SearchHighlight.clearSlots(searchMarks);
    searchMarks = [];
    if (jump) {
      applySearchJump(jump);
    }

    if (!route.known) {
      // Canonicalise the address bar without adding a history entry. Some
      // browsers refuse `replaceState` on `file://`; the page still works.
      try {
        globalThis.history.replaceState(null, "", Router.formatHash(route.id));
      } catch (_error) {
        /* Keep the hash the user arrived with. */
      }
    }

    if (changed && !firstRender) {
      content.focus({ preventScroll: true });
    }
    firstRender = false;
  }

  /**
   * Mark the article with `jump`'s query and bring `jump`'s hit into view.
   *
   * The reader pressed `Enter` on a result row: the document is open, and
   * the place the row described is the only thing left to do. Every
   * occurrence of the query is wrapped in the same marks the preview wore —
   * the list, the preview and the article now name the same places — and
   * the occurrence the row numbered is the one that stands out and takes
   * the viewport. The marks are remembered so the next navigation can take
   * them back off: a search's highlights belong to the arrival, not to the
   * reading that follows.
   *
   * Anything that cannot be honoured — a body that never rendered, an
   * ordinal without a place — is quietly skipped: the document is open and
   * readable either way.
   */
  function applySearchJump(jump) {
    if (!jump || !jump.query || typeof jump.hit !== "number" || jump.hit < 0) {
      return;
    }

    var body = content.querySelector("." + DocBody.BODY_CLASS);
    if (!body) {
      return;
    }

    var slots = SearchHighlight.highlightHits(body, jump.query);
    slots.forEach(function (slot) {
      if (slot.mark) {
        searchMarks.push(slot.mark);
      }
    });

    SearchHighlight.scrollToSlot(slots, jump.hit);
    settleAtHit(slots, jump.hit);
  }

  function render() {
    var route = Router.resolveRoute(globalThis.location.hash, ids, home);

    // A message queued by a click is only valid for the render it triggered:
    // take it now, so a later navigation can never replay it.
    var queued = pendingMissing;
    pendingMissing = null;

    // A search jump rides the navigation it asked for: taken once, here, so
    // the render that follows is the only one that can apply it.
    var jump = pendingJump;
    pendingJump = null;

    if (!route.id) {
      banner.hide();
      article.textContent = "";
      var empty = document.createElement("p");
      empty.className = "doc-empty";
      empty.textContent = "This site has no documents.";
      article.appendChild(empty);
      docList.render(null, null);
      return;
    }

    docList.render(null, route.id);
    graph.setActive(route.id);

    // A banner explains the *previous* navigation, so it never outlives it.
    banner.hide();

    var wanted = route.anchor
      ? { docId: route.id, anchor: route.anchor }
      : queued;
    var changed = route.id !== currentId;
    currentId = route.id;

    // The document on hand is placed at once — every navigation in the
    // embedded formats, and any revisit in the split one. A document that has
    // to travel first shows the wait, and the answer is dropped when a newer
    // navigation has taken the article over by the time it lands.
    var doc = store.peek(route.id);
    if (doc) {
      place(route, doc, wanted, changed, jump);
      return;
    }

    if (changed) {
      renderLoading(route.id);
    }

    store.get(route.id).then(function (loaded) {
      // A navigation that happened while the chunk was in flight owns the
      // article now; this one is out of date.
      if (currentId !== route.id) {
        return;
      }
      if (!loaded) {
        renderLoadError(route);
        return;
      }

      place(route, loaded, wanted, changed, jump);
    });
  }

  /* ---------- theme ---------- */

  applyTheme(storedTheme(), themeToggle);

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = currentTheme() === "light" ? "dark" : "light";
      applyTheme(next, themeToggle);
      storeTheme(next);
      // Diagram colours are baked into the SVG, so they need a re-render — in
      // the document and in an open preview alike.
      refreshDiagrams();
      preview.refreshDiagrams();
    });
  }

  /* ---------- search ---------- */

  /**
   * A search over one document, and the index built for it.
   *
   * The local scope never needs the whole site: the document in view carries
   * its own text, so its index is rebuilt only when the reader turns the page.
   * In the pages format this is what makes the default scope cost
   * nothing — the document is already in hand, having been fetched to be read.
   */
  var localIndex = null;
  var localIndexId = null;

  function localSearch() {
    var doc = currentId ? store.peek(currentId) : null;
    if (!doc || typeof doc.text !== "string") {
      return null;
    }
    if (localIndexId !== doc.id || !localIndex) {
      localIndex = Search.createSearch([doc]);
      localIndexId = doc.id;
    }

    return localIndex;
  }

  /**
   * One past the newest query the panel asked for.
   *
   * A corpus that travels over the network answers late, and a query typed
   * while it was in flight must not have its list overwritten by the older
   * one that triggered the fetch.
   */
  var querySequence = 0;

  /**
   * The matches `query` finds in the scope `mode` names, one per place.
   *
   * The ranking is the engine's: `search` decides which documents and in what
   * order, and `occurrences` only enumerates the places inside them, so the
   * list a reader sees is the one the index scored — the hits of one document
   * together, each with the passage it was found in. The local scope is the
   * same query over the document being read, which leaves an empty list when
   * no document is open or it holds no hit. The global scope is `null` while
   * the corpus of the pages format is still on its way, which the caller
   * shows as a wait rather than as an empty answer.
   */
  /**
   * The tail budget the result rows render into, in display-width units.
   *
   * One unit is one em of the context line, so the budget is the column
   * width over the font size. An already-rendered row is the exact measure —
   * its context column is the space a tail fills beside the path column —
   * and before the first row exists, the panel's width stands in for one,
   * less the row's padding, the column gap and the widest path column the
   * stylesheet gives. Anything that cannot be read — a shell without a
   * panel, a test DOM with no layout — hands back nothing, and the engine
   * cuts with its own default.
   */
  function snippetTailUnits() {
    if (!searchPanel || !searchPanel.querySelector) {
      return null;
    }

    var context = searchPanel.querySelector("." + SearchView.CONTEXT_CLASS);
    var width = context
      ? context.clientWidth
      : searchPanel.clientWidth - 34 - 14 - 260;
    if (!width || width <= 0 || !Number.isFinite(width)) {
      return null;
    }

    var fontSize = 12.5;
    if (context && typeof getComputedStyle === "function") {
      var parsed = parseFloat(getComputedStyle(context).fontSize);
      if (parsed > 0 && Number.isFinite(parsed)) {
        fontSize = parsed;
      }
    }

    var units = Math.round(width / fontSize);
    return units > 0 ? units : null;
  }

  function searchResults(query, mode) {
    // The tail is cut to the line the list actually renders: the budget is
    // read off the panel on every query, so a resize or a typeface change
    // follows on the next answer. No budget keeps the engine's default.
    var tailUnits = snippetTailUnits();
    var cuts = tailUnits ? { tailUnits: tailUnits } : undefined;

    if (mode === SearchView.GLOBAL_MODE) {
      if (!index) {
        return null;
      }

      var everywhere = Search.search(index, query);
      if (!everywhere) {
        return [];
      }

      return Search.occurrences(corpusDocs || docs, everywhere, query, cuts);
    }

    var local = localSearch();
    if (!local) {
      return [];
    }

    var here = Search.search(local, query);
    if (!here) {
      return [];
    }

    return Search.occurrences([store.peek(currentId)], here, query, cuts);
  }

  /* ---------- layout controls ---------- */

  /**
   * One gesture for both switches in the left rail: the drawer's toggle, on
   * the phone where the list is a drawer over the page, and the collapse
   * switch, on the wider layouts where the list is a column. Which one
   * answers depends on the width the reader is reading at, not on which
   * button was pressed.
   */
  function toggleSidebar() {
    if (drawerMode()) {
      setDrawer(document.body.getAttribute("data-drawer") !== "open");
      return;
    }
    var hidden = document.body.getAttribute("data-sidebar") !== "hidden";
    setSidebarHidden(hidden);
    storeSidebar(hidden);
  }

  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", toggleSidebar);
  }

  if (sidebarCollapse) {
    sidebarCollapse.addEventListener("click", toggleSidebar);
  }

  if (backdrop) {
    backdrop.addEventListener("click", function () {
      setDrawer(false);
    });
  }

  /**
   * One gesture per switch: flip the panel it answers for and remember the
   * pair, so the arrangement the reader leaves survives a reload.
   */
  function togglePanel(panel) {
    var attribute = panel === "graph" ? "data-graph" : "data-outline";
    var hidden = document.body.getAttribute(attribute) === "hidden";
    setPanelHidden(panel, !hidden);
    storePanels(
      document.body.getAttribute("data-graph") === "hidden",
      document.body.getAttribute("data-outline") === "hidden",
    );
  }

  if (graphToggle) {
    graphToggle.addEventListener("click", function () {
      togglePanel("graph");
    });
  }

  if (outlineToggle) {
    outlineToggle.addEventListener("click", function () {
      togglePanel("outline");
    });
  }

  document.addEventListener("keydown", function (event) {
    // `Ctrl`/`Cmd`+`F` is the reader asking for search, wherever the focus is.
    // The browser's own find bar would search the rendered page, which is not
    // the same thing: this search reads the whole site, including documents
    // that are not open. A repeat — the key held down — is still one request.
    if (SearchView.isSearchShortcut(event)) {
      event.preventDefault();
      openSearch();
      return;
    }

    if (event.key === "Escape") {
      // The panel has the first claim on Escape: it is the thing on top.
      if (searchView.isOpen()) {
        closeSearch();
        if (searchButton) {
          searchButton.focus();
        }
        return;
      }
      setDrawer(false);
    }
  });

  /* ---------- stats ---------- */

  if (stats) {
    var assets =
      bundle.stats && typeof bundle.stats.assets === "number"
        ? bundle.stats.assets
        : 0;
    stats.textContent =
      docs.length +
      (docs.length === 1 ? " document" : " documents") +
      " · " +
      assets +
      (assets === 1 ? " asset" : " assets");
  }

  globalThis.addEventListener("hashchange", render);

  // The single-file build inlines assets as `data:` URIs, which a browser
  // refuses to navigate to; the delegated pair below is what makes a link to
  // an inlined PDF open in the browser's own viewer instead of dying at
  // `about:blank#blocked`. Document routes are decided before this is ever
  // consulted: their `href`s start with the route prefix, not with `data:`.
  AssetLinks.listenForInlineDataLinks(document);

  // The drawer starts closed; the document list's column and the panels start
  // where the reader last left them, which the switches' accessible states
  // then follow.
  setDrawer(false);
  setSidebarHidden(storedSidebar());
  var panels = storedPanels();
  setPanelHidden("graph", panels === "graph" || panels === "both");
  setPanelHidden("outline", panels === "outline" || panels === "both");
  render();
}
