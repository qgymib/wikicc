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
import * as Search from "./search.js";
import * as DocList from "./doc-list.js";
import * as Toc from "./toc.js";
import * as Table from "./table.js";
import * as GraphView from "./graph-view.js";
import * as Diagrams from "./diagrams.js";
import * as DiagramView from "./diagram-view.js";

/** `localStorage` key holding the explicit theme choice. */
var THEME_KEY = "wikicc.theme";

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

  function navigate(id, anchor) {
    setDrawer(false);
    var hash = Router.formatHash(id, anchor);
    if (globalThis.location.hash === hash) {
      render();
    } else {
      globalThis.location.hash = hash;
    }
  }

  /** Ids matching the current filter, or `null` when the filter is empty. */
  function filteredIds() {
    return filter ? Search.search(index, filter.value) : null;
  }

  function scrollToAnchor(anchor) {
    if (!anchor) {
      return;
    }
    var target = document.getElementById(anchor);
    if (target) {
      target.scrollIntoView({ block: "start" });
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
    // the first paint already carries the sortable headers and filter row.
    Table.enhanceTables(body);

    content.textContent = "";
    content.appendChild(path);
    content.appendChild(body);

    // Diagrams are rendered after insertion: the engine measures label sizes
    // with the DOM, which is impossible for a detached subtree. The call is
    // asynchronous and swallows its own failures, so the document is already
    // readable when the SVGs replace their source blocks.
    DiagramView.renderDiagrams(body, currentTheme());
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

    if (!route.id) {
      content.textContent = "";
      var empty = document.createElement("p");
      empty.className = "doc-empty";
      empty.textContent = "This site has no documents.";
      content.appendChild(empty);
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

    docList.render(filteredIds(), route.id);
    graph.setActive(route.id);
    scrollToAnchor(route.anchor);

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
      // Diagram colours are baked into the SVG, so they need a re-render.
      refreshDiagrams();
    });
  }

  /* ---------- search ---------- */

  if (filter) {
    filter.addEventListener("input", function () {
      docList.render(filteredIds(), currentId);
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
