/**
 * Reader controller: payload, theme, hash routing, search and layout controls.
 *
 * The payload is embedded by the build as `<script type="application/json">`, so
 * no request is ever made and the page works from `file://`. Document HTML is
 * inserted with `innerHTML` because the Markdown source is trusted build input
 * (raw HTML passthrough is documented behaviour, see `docs/DESIGN.md`); every
 * other string goes through `textContent`.
 *
 * `main.js` is the bundle entry point and calls `start()`; this module only
 * exports the controller so the same functions stay testable in isolation.
 */
import * as Router from "./router.js";
import * as Links from "./links.js";
import * as Search from "./search.js";
import * as DocList from "./doc-list.js";
import * as Toc from "./toc.js";
import * as TableView from "./table-view.js";
import * as GraphView from "./graph-view.js";
import * as Diagrams from "./diagrams.js";
import * as DiagramView from "./diagram-view.js";
import * as PreviewView from "./preview-view.js";
import * as Anchor from "./anchor.js";
import * as Banner from "./banner.js";

/** `localStorage` key holding the explicit theme choice. */
var THEME_KEY = "wikicc.theme";

/** Class of the banner shown when a chapter anchor does not exist. */
export var ALERT_CLASS = Banner.BANNER_CLASS;

/** Read and parse the embedded payload. */
function readPayload() {
  var element = document.getElementById("wikicc-payload");
  if (!element) {
    throw new Error("wikicc payload element is missing");
  }
  return JSON.parse(element.textContent);
}

/** Theme the operating system asks for. */
export function systemTheme() {
  if (typeof globalThis.matchMedia === "function") {
    return globalThis.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

/** Explicit theme choice, or `null` when the reader should follow the OS. */
function storedTheme() {
  try {
    var value = globalThis.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch (error) {
    return null;
  }
}

function storeTheme(theme) {
  try {
    globalThis.localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    /* Storage can be disabled; the theme still applies for this page. */
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
    var label = current === "light" ? "Switch to dark theme" : "Switch to light theme";
    toggle.setAttribute("aria-pressed", current === "light" ? "true" : "false");
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }
}

export function start() {
  var bundle = readPayload();
  var docs = Array.isArray(bundle.docs) ? bundle.docs : [];
  var ids = docs.map(function (doc) {
    return doc.id;
  });
  var byId = new Map(
    docs.map(function (doc) {
      return [doc.id, doc];
    }),
  );

  var content = document.getElementById("doc-content");
  var article = document.getElementById("doc-article");
  var filter = document.getElementById("doc-filter");
  var stats = document.getElementById("stats");
  var inspector = document.getElementById("inspector");
  var sidebarToggle = document.getElementById("sidebar-toggle");
  var backdrop = document.getElementById("drawer-backdrop");
  var themeToggle = document.getElementById("theme-toggle");
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".inspector-tab"));

  var index = Search.createSearch(docs);
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

  var preview = PreviewView.createPreviewView({
    content: content,
    byId: byId,
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
  });

  var fitButton = document.getElementById("graph-fit");
  if (fitButton) {
    fitButton.addEventListener("click", function () {
      graph.fit();
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
    var doc = route && route.id ? byId.get(route.id) : null;
    if (!doc) {
      return;
    }

    docList.render(listedIds(doc.id), doc.id);
    graph.setActive(doc.id);

    if (!route.anchor) {
      if (typeof globalThis.scrollTo === "function") {
        globalThis.scrollTo(0, 0);
      }
      return;
    }

    scrollToAnchor(findAnchor(doc, route.anchor));
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
    if (remaining <= 0 || typeof globalThis.requestAnimationFrame !== "function") {
      scrollToAnchor(findAnchor(doc, anchor));
      return;
    }

    globalThis.requestAnimationFrame(function () {
      scrollToAnchor(findAnchor(doc, anchor));
      settleAtAnchor(doc, anchor, remaining - 1);
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
      scrollToAnchorOnly(Router.resolveRoute(hash, ids));
      return;
    }

    globalThis.location.hash = hash;
  }

  /** Ids matching the current filter, or `null` when the filter is empty. */
  function filteredIds() {
    return filter ? Search.search(index, filter.value) : null;
  }

  /**
   * Ids the document list should show, keeping the open document in reach.
   *
   * The list is both a filter result and the place the reader looks to see what
   * they are reading, so a filter that hides the open document would leave the
   * sidebar pointing at nothing while the article behind it is on screen: a
   * block reference followed while a filter is typed in would look like it went
   * nowhere. The open document is therefore always listed; the filter decides
   * only which of the *other* documents are.
   */
  function listedIds(activeId) {
    var matched = filteredIds();
    if (matched === null || !activeId || matched.indexOf(activeId) !== -1) {
      return matched;
    }

    return [activeId].concat(matched);
  }

  /** Banner for a chapter the current document does not contain. */
  var banner = Banner.createBanner({
    container: content,
    host: document.getElementById("doc-alert"),
  });

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

  /** Park the document at `anchor`, which `findAnchor` has already resolved. */
  function scrollToAnchor(found) {
    if (found && found.element && found.element.scrollIntoView) {
      found.element.scrollIntoView({ block: "start" });
    }
  }

  function renderDocument(doc) {
    var path = document.createElement("p");
    path.className = "doc-path";
    path.textContent = doc.id;

    var body = document.createElement("div");
    body.className = "doc-body";
    body.innerHTML = doc.html;
    // Tables are enhanced after the markup exists and before it is inserted, so
    // the first paint already carries the sortable headers and filter buttons.
    TableView.enhanceTables(body);

    // Only the article is replaced: the banner slot sits beside it in `content`
    // for the whole session, so a document change can neither remove it nor
    // rebuild it, and the article's width never depends on whether it is shown.
    content.textContent = "";
    content.appendChild(banner.element());
    content.appendChild(article);
    article.textContent = "";
    article.appendChild(path);
    article.appendChild(body);

    // Diagrams are rendered after insertion: the engine measures label sizes
    // with the DOM, which is impossible for a detached subtree. The call is
    // asynchronous and swallows its own failures, so the document is already
    // readable when the SVGs replace their source blocks.
    DiagramView.renderDiagrams(body, currentTheme());

    // The links this document carries are the ones the hover preview watches.
    preview.tag(body);
  }

  /** Re-render the current document's diagrams for the theme now in effect. */
  function refreshDiagrams() {
    var doc = currentId ? byId.get(currentId) : null;
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

  function render() {
    var route = Router.resolveRoute(globalThis.location.hash, ids);

    // A message queued by a click is only valid for the render it triggered:
    // take it now, so a later navigation can never replay it.
    var queued = pendingMissing;
    pendingMissing = null;

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

    var doc = byId.get(route.id);
    var changed = route.id !== currentId;
    currentId = route.id;

    if (changed) {
      renderDocument(doc);
      toc.render(doc.toc, doc.id);
      document.title = doc.title ? doc.title + " · " + bundle.title : bundle.title;
    }

    docList.render(listedIds(route.id), route.id);
    graph.setActive(route.id);

    // A banner explains the *previous* navigation, so it never outlives it.
    banner.hide();

    // A block reference whose chapter the document does not have still opens
    // the document, at the top, and says what was asked for. A click on such a
    // reference leaves no anchor in the route — the build cannot address a
    // chapter that has no element — so the queued message stands in for it.
    var wanted = route.anchor
      ? { docId: doc.id, anchor: route.anchor }
      : queued;

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

    if (!route.known) {
      // Canonicalise the address bar without adding a history entry. Some
      // browsers refuse `replaceState` on `file://`; the page still works.
      try {
        globalThis.history.replaceState(null, "", Router.formatHash(route.id));
      } catch (error) {
        /* Keep the hash the user arrived with. */
      }
    }

    if (changed && !firstRender) {
      content.focus({ preventScroll: true });
    }
    firstRender = false;
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

  if (filter) {
    filter.addEventListener("input", function () {
      docList.render(listedIds(currentId), currentId);
    });
    filter.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && filter.value) {
        filter.value = "";
        docList.render(null, currentId);
      }
    });
  }

  /* ---------- layout controls ---------- */

  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", function () {
      setDrawer(document.body.getAttribute("data-drawer") !== "open");
    });
  }

  if (backdrop) {
    backdrop.addEventListener("click", function () {
      setDrawer(false);
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var panel = tab.getAttribute("data-panel");
      if (!panel || !inspector) {
        return;
      }
      inspector.setAttribute("data-panel", panel);
      tabs.forEach(function (other) {
        other.setAttribute("aria-selected", other === tab ? "true" : "false");
      });
    });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      setDrawer(false);
    }
  });

  /* ---------- stats ---------- */

  if (stats) {
    var assets = bundle.stats && typeof bundle.stats.assets === "number" ? bundle.stats.assets : 0;
    stats.textContent =
      docs.length +
      (docs.length === 1 ? " document" : " documents") +
      " · " +
      assets +
      (assets === 1 ? " asset" : " assets");
  }

  globalThis.addEventListener("hashchange", render);
  setDrawer(false);
  render();
}
