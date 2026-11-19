/**
 * Reader controller: payload, theme, and the composition of the reader's
 * parts.
 *
 * The payload is embedded by the build as `<script type="application/json">`.
 * In the shell formats it carries every document, so reading is a lookup and
 * no request is ever made. In the pages format it carries only the
 * manifest, and the documents arrive from `pages/` when the reader navigates
 * to them (see `doc-store.js`) — which is why a document render is a promise
 * the navigation controller guards against a newer navigation, and why the
 * whole-site search asks for its corpus the first time the reader widens the
 * scope.
 *
 * Document HTML is inserted with `innerHTML` because the Markdown source is
 * trusted build input (raw HTML passthrough is documented behaviour, see
 * `docs/design.md`); every other string goes through `textContent`.
 *
 * This module is the composition root: it reads the payload — refusing one
 * whose format version it does not speak — builds the store, the session
 * and the views, and hands them to the controllers the
 * reader is made of — `navigation.js` (the route cycle), `doc-render.js`
 * (what the article shows), `panels.js` (the layout panels) and
 * `search-controller.js` (the search scopes). The navigation and the search
 * controller answer each other, so each is named before the views that
 * route to it and assigned once its counterpart exists; the closures read
 * them only when the reader acts, by which time the wiring is done.
 *
 * `main.js` is the bundle entry point and calls `start()`; this module only
 * exports the controller so the same functions stay testable in isolation.
 */
import * as AssetLinks from "./asset-links.js";
import * as Backlinks from "./backlinks.js";
import * as Banner from "./banner.js";
import * as DocList from "./doc-list.js";
import * as DocStore from "./doc-store.js";
import * as GraphView from "./graph-view.js";
import * as PreviewView from "./preview-view.js";
import * as SearchView from "./search-view.js";
import * as Session from "./session.js";
import * as Tags from "./tags.js";
import * as Toc from "./toc.js";
import { createDocRender } from "./doc-render.js";
import { createNavigation } from "./navigation.js";
import { createPanels } from "./panels.js";
import { createSearchController } from "./search-controller.js";
import { versionProblem } from "./payload-version.js";

/** Read, parse and version-check the embedded payload. */
function readPayload() {
  var element = document.getElementById("wikicc-payload");
  if (!element) {
    throw new Error("wikicc payload element is missing");
  }
  var payload = JSON.parse(element.textContent);
  var problem = versionProblem(payload.v, "The site payload");
  if (problem) {
    throw new Error(problem);
  }
  return payload;
}

/**
 * Say, where the article would be, that the payload cannot be read.
 *
 * A payload the reader cannot speak — a format version it does not know,
 * text that is not JSON — ends the start before anything is wired: the
 * message lands in the article column, where every other reader failure
 * speaks, and the rest of the shell stays as the build wrote it.
 */
function showFatal(message) {
  var article = document.getElementById("doc-article");
  if (!article) {
    return;
  }
  article.textContent = "";
  var failed = document.createElement("p");
  failed.className = "doc-empty";
  failed.textContent = message;
  article.appendChild(failed);
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

export function start() {
  // A payload the reader cannot speak ends the start here, with the reason
  // on screen: wiring the views against an unreadable bundle is what a
  // silent misrender is.
  var bundle;
  try {
    bundle = readPayload();
  } catch (error) {
    showFatal(error.message);
    return;
  }
  var docs = Array.isArray(bundle.docs) ? bundle.docs : [];
  var ids = docs.map(function (doc) {
    return doc.id;
  });
  // The tag aggregation the build folded out of the bodies. A payload that
  // predates the key — or a manifest that never carried one — reads as no
  // tags at all.
  var bundleTags = Array.isArray(bundle.tags) ? bundle.tags : [];
  // The document the reader opens at an empty or unknown address, from the
  // `home` key of .wikicc.json; anything else falls back to the first one.
  var home = typeof bundle.home === "string" ? bundle.home : null;
  var store = DocStore.createDocStore(bundle);

  /**
   * The session: the passwords this visit has seen, the documents they
   * opened, and the preferences the reader left behind on an earlier one.
   * The store decrypts; the session remembers — the table is memory-only,
   * never written to any storage, and the door only reports what a
   * password did.
   */
  var session = Session.createSession({
    decrypt: function (id, password) {
      return store.decrypt(id, password);
    },
    // A navigation away from a document stops its silent attempts: the
    // reader is elsewhere, and the queue would only spend derivations on
    // a page nobody is reading. The navigation controller owns which
    // document is on screen and is built after the session, so the answer
    // is read through it once the wiring is done.
    isActive: function (id) {
      return !!navigation && navigation.isCurrent(id);
    },
  });

  /**
   * Try `password` on the sealed document `sealed`.
   *
   * The attempt belongs to the store: `decrypt` is the one door, and a
   * password that opened a document is remembered for the session, so
   * the next sealed page — or this one again — never asks twice.
   */
  function tryPassword(password, sealed) {
    if (!sealed || !sealed.id) {
      return Promise.resolve(false);
    }
    return session.unlock(sealed.id, password).then(function (unlocked) {
      return !!unlocked;
    });
  }

  // The store announces every decryption it performs; the session keeps the
  // map of what a password has opened, and the listeners below hear about
  // each one from the session rather than from the store.
  store.onDecrypted(function (unlocked) {
    session.recordDecrypted(unlocked);
  });

  var content = document.getElementById("doc-content");
  var article = document.getElementById("doc-article");
  var stats = document.getElementById("stats");
  var sidebarToggle = document.getElementById("sidebar-toggle");
  var sidebarCollapse = document.getElementById("sidebar-collapse");
  var backdrop = document.getElementById("drawer-backdrop");
  var themeToggle = document.getElementById("theme-toggle");
  var graphLocalToggle = document.getElementById("graph-local-toggle");
  var graphGlobalToggle = document.getElementById("graph-global-toggle");
  var backlinksToggle = document.getElementById("backlinks-toggle");
  var tagsToggle = document.getElementById("tags-toggle");
  var outlineToggle = document.getElementById("outline-toggle");
  // The floating window the graph's two panels live in: a press outside it
  // folds the window (see `createPanels`).
  var inspector = document.getElementById("inspector");

  // The navigation and the search controller answer each other — the cycle
  // hands every arrival to the search's marks, and a result hands its jump
  // to the cycle — so each is declared here and assigned by the wiring
  // below, in the order the reader reaches them.
  var navigation = null;
  var searchController = null;

  var preview = PreviewView.createPreviewView({
    content: content,
    documents: store,
    theme: currentTheme,
    onNavigate: function (id, anchor) {
      navigation.navigate(id, anchor);
    },
    onMissingChapter: function (message) {
      navigation.queueMissingChapter(message);
    },
    // The locked panel's password form answers through the same door the
    // lock page's form does: the store decrypts, and a password that
    // opened its document is remembered for the session by the same hand,
    // so the next sealed page — or this one again — never asks twice.
    onUnlock: function (docId, password) {
      return session.unlock(docId, password).then(function (unlocked) {
        return !!unlocked;
      });
    },
    // The quiet attempt reads the same session table, so a site whose
    // articles share one password asks for it once, wherever the reader
    // first typed it.
    passwordCandidates: function (docId) {
      return session.candidates(docId);
    },
  });

  var docList = DocList.createDocList({
    container: document.getElementById("doc-list"),
    docs: docs,
    onSelect: function (id, anchor) {
      navigation.navigate(id, anchor);
    },
  });

  /**
   * The tag aggregation, and the one selection it answers to.
   *
   * `activeTag` is the composition root's own state: the panel draws it, the
   * document list filters through it, and every answer — a row in the panel,
   * a chip in the article — walks the same path. Selecting the selected tag
   * again puts the filter away.
   */
  var activeTag = null;

  /** The ids the document list keeps while `activeTag` filters it. */
  function docFilter() {
    return activeTag ? Tags.docsOfTag(bundleTags, activeTag) : null;
  }

  /** Select `tag`, or put the selection away when it was the one selected. */
  function setTagFilter(tag) {
    activeTag = activeTag === tag ? null : tag || null;
    tagsPanel.render(activeTag);
    var current = navigation ? navigation.currentDoc() : null;
    docList.render(docFilter(), current ? current.id : null);
  }

  // The floating window's fourth view: the tags the build collected, each
  // row answering with the tag it carries. Drawn once at the start — the
  // aggregation never changes while the page is up — and redrawn only when
  // a selection moves.
  var tagsPanel = Tags.createTagsPanel({
    container: document.getElementById("tags"),
    docs: docs,
    tags: bundleTags,
    onSelect: function (tag) {
      setTagFilter(tag);
    },
    onNavigate: function (id) {
      navigation.navigate(id, null);
    },
  });
  tagsPanel.render(null);

  var toc = Toc.createToc({
    container: document.getElementById("toc"),
    onNavigate: function (id, anchor) {
      navigation.navigate(id, anchor);
    },
  });

  // What links here: the reverse half of the graph the build resolved. The
  // panel is the floating window's third view, and its list answers the
  // document the reader is on — refreshed by the navigation cycle, whether
  // or not the window is showing.
  var backlinks = Backlinks.createBacklinks({
    container: document.getElementById("backlinks"),
    docs: docs,
    edges: Array.isArray(bundle.edges) ? bundle.edges : [],
    onNavigate: function (id) {
      navigation.navigate(id, null);
    },
  });

  // Two views, two components, one picture each: the local one answers what
  // the document at hand is connected to — the view a reader starts in — and
  // the global one holds the whole site. The global layout is spent the first
  // time its panel is shown (see `createGlobalGraph`), so a reader who never
  // opens it never pays for it.
  var localGraph = GraphView.createLocalGraph({
    container: document.getElementById("graph-local"),
    docs: docs,
    edges: Array.isArray(bundle.edges) ? bundle.edges : [],
    onSelect: function (id, anchor) {
      navigation.navigate(id, anchor);
    },
  });

  var globalGraph = GraphView.createGlobalGraph({
    container: document.getElementById("graph-global"),
    docs: docs,
    edges: Array.isArray(bundle.edges) ? bundle.edges : [],
    onSelect: function (id, anchor) {
      navigation.navigate(id, anchor);
    },
  });

  var fitLocalButton = document.getElementById("graph-fit-local");
  if (fitLocalButton) {
    fitLocalButton.addEventListener("click", function () {
      localGraph.fit();
    });
  }

  var fitGlobalButton = document.getElementById("graph-fit-global");
  if (fitGlobalButton) {
    fitGlobalButton.addEventListener("click", function () {
      globalGraph.fit();
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
      searchController.handleQuery(query, mode);
    },
    onSelect: function (id, anchor, jump) {
      // The passage a result names travels outside the route: queue it for
      // the render this navigation causes, then let the address change.
      navigation.queueJump(jump);
      navigation.navigate(id, anchor);
    },
  });

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

  var docRender = createDocRender({
    content: content,
    article: article,
    banner: banner,
    toc: toc,
    siteTitle: bundle.title,
    tryPassword: tryPassword,
    preview: preview,
    currentTheme: currentTheme,
    currentDoc: function () {
      return navigation.currentDoc();
    },
  });

  var panels = createPanels({
    sidebarToggle: sidebarToggle,
    sidebarCollapse: sidebarCollapse,
    outlineToggle: outlineToggle,
    backdrop: backdrop,
    graphLocalToggle: graphLocalToggle,
    graphGlobalToggle: graphGlobalToggle,
    backlinksToggle: backlinksToggle,
    tagsToggle: tagsToggle,
    session: session,
    globalGraph: globalGraph,
    inspector: inspector,
  });

  navigation = createNavigation({
    store: store,
    ids: ids,
    home: home,
    docList: docList,
    docFilter: docFilter,
    localGraph: localGraph,
    globalGraph: globalGraph,
    toc: toc,
    backlinks: backlinks,
    banner: banner,
    article: article,
    content: content,
    siteTitle: bundle.title,
    session: session,
    docRender: docRender,
    // Every arrival hands the search's marks their turn — a jump lands when
    // the article is on screen, a plain navigation takes the marks back off.
    // The search controller is built below, so the call goes through the
    // holder declared above.
    onArrive: function (jump) {
      searchController.arrive(jump);
    },
    onCloseDrawer: panels.closeDrawer,
  });

  searchController = createSearchController({
    view: searchView,
    button: searchButton,
    panel: searchPanel,
    store: store,
    docs: docs,
    session: session,
    content: content,
    currentDoc: navigation.currentDoc,
  });

  /* ---------- tags: the article's chips ---------- */

  /**
   * Answer a chip the click started on, wherever in the article it sits.
   *
   * A chip in the article is the tag it carries: selecting it filters the
   * document list and unfolds the tag in the panel, and both come into view.
   * The `preventDefault` also cancels the navigation a chip inside a link
   * would otherwise start — the reader asked for the tag, not the page.
   */
  function answerTagChip(event) {
    var target = event && event.target;
    var chip =
      target && typeof target.closest === "function"
        ? target.closest(Tags.TAG_CHIP_SELECTOR)
        : null;
    if (!chip) {
      return;
    }

    event.preventDefault();
    setTagFilter(chip.getAttribute(Tags.TAG_CHIP_ATTRIBUTE));
    panels.openTagsView();
  }

  // The build writes the button role on every chip, so a keyboard press
  // promises the same answer; `Space` would otherwise scroll the page.
  article.addEventListener("click", answerTagChip);
  article.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      answerTagChip(event);
    }
  });

  // An unlock anywhere in the reader is heard twice, in the order below:
  // the navigation re-renders the document the reader is looking at, and
  // the search refolds its indexes around the full model.
  session.onDecrypted(function (unlocked) {
    navigation.revealUnlocked(unlocked.id);
  });
  session.onDecrypted(function (unlocked) {
    searchController.onUnlocked(unlocked);
  });

  /* ---------- theme ---------- */

  applyTheme(session.theme(), themeToggle);

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = currentTheme() === "light" ? "dark" : "light";
      applyTheme(next, themeToggle);
      session.setTheme(next);
      // Diagram colours are baked into the SVG, so they need a re-render — in
      // the document and in an open preview alike.
      docRender.refreshDiagrams();
      preview.refreshDiagrams();
    });
  }

  document.addEventListener("keydown", function (event) {
    // `Ctrl`/`Cmd`+`F` is the reader asking for search, wherever the focus is.
    // The browser's own find bar would search the rendered page, which is not
    // the same thing: this search reads the whole site, including documents
    // that are not open. A repeat — the key held down — is still one request.
    if (SearchView.isSearchShortcut(event)) {
      event.preventDefault();
      searchController.openSearch();
      return;
    }

    if (event.key === "Escape") {
      // The panel has the first claim on Escape: it is the thing on top.
      if (searchController.isOpen()) {
        searchController.closeSearch();
        if (searchButton) {
          searchButton.focus();
        }
        return;
      }
      panels.closeDrawer();
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

  globalThis.addEventListener("hashchange", function () {
    navigation.render();
  });

  // The single-file build inlines assets as `data:` URIs, which a browser
  // refuses to navigate to; the delegated pair below is what makes a link to
  // an inlined PDF open in the browser's own viewer instead of dying at
  // `about:blank#blocked`. Document routes are decided before this is ever
  // consulted: their `href`s start with the route prefix, not with `data:`.
  AssetLinks.listenForInlineDataLinks(document);

  panels.restore();
  navigation.render();
}
