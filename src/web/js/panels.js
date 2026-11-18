/**
 * The layout panels: the sidebar's two views, the graph panel's two views,
 * and the phone's drawer.
 *
 * Every panel is one body attribute the stylesheet answers to, and the
 * switches around it — the rail's, the graph's, the drawer's backdrop — are
 * synced by the setters that surround each write, so a screen reader hears
 * the same answer whichever switch asked. The sidebar's view and its
 * visibility are the reader's own preferences and travel through the
 * session; the graph's are the page's own for this visit only.
 *
 * Pure wiring over the attributes: nothing here renders content.
 */

/** The media query below which the document list is a drawer, not a column. */
var DRAWER_QUERY = "(max-width: 640px)";

export function createPanels(deps) {
  var sidebarToggle = deps.sidebarToggle;
  var sidebarCollapse = deps.sidebarCollapse;
  var outlineToggle = deps.outlineToggle;
  var backdrop = deps.backdrop;
  var graphLocalToggle = deps.graphLocalToggle;
  var graphGlobalToggle = deps.graphGlobalToggle;
  var session = deps.session;
  var globalGraph = deps.globalGraph;
  var inspector = deps.inspector;

  function setDrawer(open) {
    document.body.setAttribute("data-drawer", open ? "open" : "closed");
    if (backdrop) {
      backdrop.hidden = !open;
    }
    syncSideControls();
  }

  /** Whether the reader is at a width where the document list is a drawer. */
  function drawerMode() {
    return (
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia(DRAWER_QUERY).matches
    );
  }

  /**
   * Put the sidebar's column away or bring it back.
   *
   * The wide layouts hide the column through the body attribute alone; the
   * drawer's state is a different attribute and never touched here. The
   * rail's switches answer for the column — collapsed, it is the rail the
   * reader brings the sidebar back from, so their accessible states and the
   * labels they offer follow the sidebar, not the gesture.
   */
  function setSidebarHidden(hidden) {
    if (hidden) {
      document.body.setAttribute("data-sidebar", "hidden");
    } else {
      document.body.removeAttribute("data-sidebar");
    }
    syncSideControls();
  }

  /**
   * The sidebar view currently selected, and whether it is showing.
   *
   * The view is one body attribute the stylesheet answers to; "showing" is
   * the drawer's openness on the phone and the column's unfolded attribute
   * on the wider layouts. The switches read both through here, so a screen
   * reader hears the same answer whichever switch asked.
   */
  function currentSideView() {
    return document.body.getAttribute("data-side-view") === "outline"
      ? "outline"
      : "docs";
  }

  function sideVisible() {
    if (drawerMode()) {
      return document.body.getAttribute("data-drawer") === "open";
    }
    return document.body.getAttribute("data-sidebar") !== "hidden";
  }

  /**
   * Point every side switch at the state it now offers.
   *
   * Each switch speaks for the view it selects, not for the sidebar as a
   * whole: its pressed state says whether that view is the one showing, and
   * its label offers what a press would do — bring the view up, or put the
   * sidebar away when the view is already up.
   */
  function syncSideControls() {
    var view = currentSideView();
    var visible = sideVisible();

    if (outlineToggle) {
      var lit = view === "outline" && visible;
      var label = lit ? "Hide outline panel" : "Show outline panel";
      outlineToggle.setAttribute("aria-expanded", lit ? "true" : "false");
      outlineToggle.setAttribute("aria-label", label);
      outlineToggle.setAttribute("title", label);
    }

    var listLit = view === "docs" && visible;
    var listLabel = listLit ? "Hide document list" : "Show document list";
    if (sidebarToggle) {
      sidebarToggle.setAttribute("aria-expanded", listLit ? "true" : "false");
      sidebarToggle.setAttribute("aria-label", listLabel);
    }
    if (sidebarCollapse) {
      sidebarCollapse.setAttribute("aria-expanded", listLit ? "true" : "false");
      sidebarCollapse.setAttribute("aria-label", listLabel);
      sidebarCollapse.setAttribute("title", listLabel);
    }
  }

  /**
   * Select the view the sidebar shows.
   *
   * The attribute is the state the stylesheet answers to; the switches are
   * synced by the setters that surround the write.
   */
  function setSideView(view) {
    if (view === "outline") {
      document.body.setAttribute("data-side-view", "outline");
    } else {
      document.body.setAttribute("data-side-view", "docs");
    }
    syncSideControls();
  }

  /**
   * The graph view currently selected, and whether its panel is showing.
   *
   * The view is one body attribute the stylesheet answers to, and the other
   * is the one that folds the panel column; the switches read both through
   * here, so a screen reader hears the same answer whichever switch asked.
   */
  function currentGraphView() {
    return document.body.getAttribute("data-graph-view") === "global"
      ? "global"
      : "local";
  }

  function graphVisible() {
    return document.body.getAttribute("data-graph") !== "hidden";
  }

  /**
   * Point every graph switch at the state it now offers.
   *
   * Each switch speaks for the view it selects, not for the panel column as a
   * whole: its expanded state says whether that view is the one showing, and
   * its label offers what a press would do — bring the view up, or put the
   * column away when the view is already up.
   */
  function syncGraphButtons() {
    var view = currentGraphView();
    var visible = graphVisible();

    var localLit = view === "local" && visible;
    var localLabel = localLit ? "Hide local graph" : "Show local graph";
    if (graphLocalToggle) {
      graphLocalToggle.setAttribute(
        "aria-expanded",
        localLit ? "true" : "false",
      );
      graphLocalToggle.setAttribute("aria-label", localLabel);
      graphLocalToggle.setAttribute("title", localLabel);
    }

    var globalLit = view === "global" && visible;
    var globalLabel = globalLit ? "Hide global graph" : "Show global graph";
    if (graphGlobalToggle) {
      graphGlobalToggle.setAttribute(
        "aria-expanded",
        globalLit ? "true" : "false",
      );
      graphGlobalToggle.setAttribute("aria-label", globalLabel);
      graphGlobalToggle.setAttribute("title", globalLabel);
    }
  }

  /**
   * Select the view the graph panel shows.
   *
   * The attribute is the state the stylesheet answers to; showing a view
   * always unfolds the floating window, and the first look at the global
   * view spends its layout — a panel never shown has never been laid out
   * (see `createGlobalGraph`).
   */
  function setGraphView(view) {
    if (view === "global") {
      document.body.setAttribute("data-graph-view", "global");
      globalGraph.refresh();
    } else {
      document.body.setAttribute("data-graph-view", "local");
    }
    document.body.removeAttribute("data-graph");
    syncGraphButtons();
  }

  /**
   * Put the graph panel away.
   *
   * The stylesheet folds the floating window when the attribute is set. The
   * selected view stays selected, so bringing the window back restores
   * exactly the picture that was showing.
   */
  function hideGraph() {
    document.body.setAttribute("data-graph", "hidden");
    syncGraphButtons();
  }

  /**
   * Whether a press landed inside the floating window.
   *
   * A press on the window belongs to the graph — a node's gesture, a pan, the
   * Fit control — and never to whatever sits behind it. `contains` is the
   * browser's own answer over the subtree; a synthetic node without it can
   * only be the window itself.
   */
  function insideInspector(node) {
    if (!node || !inspector) {
      return false;
    }
    if (typeof inspector.contains === "function") {
      return inspector.contains(node);
    }
    return node === inspector;
  }

  /**
   * Whether a press landed on one of the rail's graph switches.
   *
   * The switches toggle the window through their own `click`, so a press on
   * them is the reader asking for that toggle, not a press outside the
   * window: folding here would race the click and leave the window stuck
   * open — the same exclusion the search panel's dialog keeps.
   */
  function insideGraphToggle(node) {
    if (!node) {
      return false;
    }
    if (
      graphLocalToggle &&
      typeof graphLocalToggle.contains === "function" &&
      graphLocalToggle.contains(node)
    ) {
      return true;
    }
    return Boolean(
      graphGlobalToggle &&
        typeof graphGlobalToggle.contains === "function" &&
        graphGlobalToggle.contains(node),
    );
  }

  /**
   * Fold the window when a press lands outside it.
   *
   * The press is what dismisses the window, not the click that follows it —
   * the press is the moment the reader has moved on, and the one gesture
   * nothing sitting between the window and the page can swallow. The
   * listener stays for the page's life; while the window is folded, the
   * `graphVisible` guard makes every press a no-op.
   */
  function onDocumentPointerDown(event) {
    if (!graphVisible()) {
      return;
    }

    var node = event && event.target;
    if (insideInspector(node) || insideGraphToggle(node)) {
      return;
    }

    hideGraph();
  }

  /**
   * One gesture for the side switches: the switch selects the view it names,
   * and pressed again while that view is up, puts the sidebar away — the way
   * an activity bar folds its panel. Which way the gesture answers depends
   * on the width the reader is reading at, not on which button was pressed:
   * on the phone the sidebar is a drawer over the page, so selecting the
   * view that is already open closes the drawer, and selecting the other
   * view swaps the drawer's contents without closing it.
   */
  function selectSide(view) {
    if (drawerMode()) {
      var open = document.body.getAttribute("data-drawer") === "open";
      if (currentSideView() === view && open) {
        setDrawer(false);
        return;
      }
      setSideView(view);
      session.setSideView(view);
      setDrawer(true);
      return;
    }

    var visible = document.body.getAttribute("data-sidebar") !== "hidden";
    if (currentSideView() === view && visible) {
      setSidebarHidden(true);
      session.setSidebarHidden(true);
      return;
    }
    setSideView(view);
    session.setSideView(view);
    setSidebarHidden(false);
    session.setSidebarHidden(false);
  }

  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", function () {
      selectSide("docs");
    });
  }

  if (sidebarCollapse) {
    sidebarCollapse.addEventListener("click", function () {
      selectSide("docs");
    });
  }

  if (outlineToggle) {
    outlineToggle.addEventListener("click", function () {
      selectSide("outline");
    });
  }

  if (backdrop) {
    backdrop.addEventListener("click", function () {
      setDrawer(false);
    });
  }

  /**
   * One gesture for a graph's switch: bring its view up, or — the view
   * already showing — put the floating window away. The choice is the
   * page's own for this visit only; no record is kept across a reload.
   */
  function selectGraph(view) {
    if (currentGraphView() === view && graphVisible()) {
      hideGraph();
      return;
    }
    setGraphView(view);
  }

  if (graphLocalToggle) {
    graphLocalToggle.addEventListener("click", function () {
      selectGraph("local");
    });
  }

  if (graphGlobalToggle) {
    graphGlobalToggle.addEventListener("click", function () {
      selectGraph("global");
    });
  }

  document.addEventListener("pointerdown", onDocumentPointerDown, true);

  /**
   * The state the reader starts in.
   *
   * The drawer starts closed; the sidebar's view starts where the reader
   * last left it, and the graph starts in the local view with its floating
   * window folded away — the reader asks for the picture with a switch, and
   * the switches' accessible records follow. The graph keeps no record
   * across a reload: every visit starts with nothing showing and the local
   * view selected.
   */
  function restore() {
    setDrawer(false);
    setSideView(session.sideView());
    setSidebarHidden(session.sidebarHidden());
    setGraphView("local");
    hideGraph();
  }

  return {
    /** Close the drawer, whatever the reader opened it from. */
    closeDrawer: function () {
      setDrawer(false);
    },
    restore: restore,
  };
}
