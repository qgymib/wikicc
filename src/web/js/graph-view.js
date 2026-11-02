/**
 * Link graph view: SVG rendering and interaction.
 *
 * `graph.js` owns the geometry; this module only draws it and wires the pointer
 * behaviour. `d3-selection` builds the markup, `d3-zoom` handles wheel/pinch
 * zoom and drag-to-pan, and `d3-drag` handles node dragging with pointer
 * capture.
 *
 * Everything is created once per page load. Changing the active document only
 * toggles a class, so routing never recomputes the layout; dragging moves the
 * existing elements instead of re-rendering the graph.
 *
 * Clicking is decided by the press/release pair, not by the `click` event. A
 * press on a node arms a selection and the release settles it: a release
 * without movement opens the document, while a press that moved the node is
 * only a drag. The `click` cannot be trusted to arrive at all — `d3-drag` keeps
 * pointer capture on the window, and Chrome reports no `click` for such a
 * gesture — so a click here is "pressed and released without moving", observed
 * directly. The native `click` is only the fallback for presses this module
 * never saw (keyboard activation, a synthesised event in a test).
 *
 * A release is the only thing that settles a press, so nothing may drop the
 * press while the pointer is still down. A `blur` arrives on every press: the
 * focus moves to the link, and `d3-zoom` provokes one itself. Only a window
 * without the focus means the reader left the page mid-gesture.
 *
 * The document already on screen is not reopened: a click on its node is a
 * click on what the reader is reading, so it does nothing.
 */
import { drag as d3Drag } from "d3-drag";
import { select as d3Select } from "d3-selection";
import { zoom as d3Zoom, zoomIdentity } from "d3-zoom";

import * as Graph from "./graph.js";
import { formatHash } from "./router.js";

/** Marker id of the arrowhead; the page holds a single graph. */
var ARROW_ID = "wikicc-graph-arrow";

/** Class of a node that is hovered or a neighbour of the hovered node. */
var HOT_CLASS = "is-hot";

/** Class of everything that is not part of the hovered neighbourhood. */
var DIM_CLASS = "is-dim";

/** Class of the document currently displayed. */
var ACTIVE_CLASS = "is-active";

/** Longest label before it is truncated with an ellipsis. */
var LABEL_LIMIT = 22;

/**
 * How far a press may travel and still count as a click, in pixels.
 *
 * The same slack the rest of the page allows, so a node tolerates the same
 * hand tremor a block reference does before the press becomes a drag.
 */
var DRAG_THRESHOLD_PX = 3;

/** Pointer buttons a click may come from; `undefined` covers synthetic events. */
var LEFT_BUTTON = 0;

/** Whether a press came from the unmodified left button. */
function isPlainLeftPress(event) {
  if (!event) {
    // Nothing to judge by: d3-drag only reports presses it filtered for, so a
    // gesture without a source event is one the browser made.
    return true;
  }

  var button = event.button === undefined ? LEFT_BUTTON : event.button;
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && button === LEFT_BUTTON;
}

/** Whether a click should be handled by the router instead of the browser. */
function isPlainLeftClick(event) {
  return isPlainLeftPress(event);
}

/**
 * Whether an event happened on `element` or on something inside it.
 *
 * `closest` is the browser's own answer; it is missing only on synthetic events
 * and on the node itself, where comparing the two is the same answer.
 */
function isNodeTarget(event, element) {
  var target = event && event.target;
  if (!target) {
    return true;
  }
  if (typeof target.closest === "function") {
    return target.closest(".graph-node") === element;
  }

  return target === element;
}

/** Readable label for a node: the document title, truncated, else its id. */
export function labelFor(doc) {
  var text = String((doc && (doc.title || doc.id)) || "");
  return text.length > LABEL_LIMIT ? text.slice(0, LABEL_LIMIT - 1) + "\u2026" : text;
}

/** Spoken description of a node, including how connected it is. */
function describe(doc, degree) {
  var connections = degree === 1 ? "1 connection" : degree + " connections";
  return labelFor(doc) + ", " + connections;
}

/** Position one node element with an SVG transform. */
function placeNode(element, node) {
  element.setAttribute("transform", "translate(" + node.x + "," + node.y + ")");
}

/** Position one edge, stopping short of the target so the arrowhead fits. */
function placeEdge(element, link) {
  var dx = link.target.x - link.source.x;
  var dy = link.target.y - link.source.y;
  var length = Math.sqrt(dx * dx + dy * dy);
  var shrink = Math.min(link.shrink, length * 0.6);
  var unitX = length > 0 ? dx / length : 0;
  var unitY = length > 0 ? dy / length : 0;

  element.setAttribute("x1", String(link.source.x));
  element.setAttribute("y1", String(link.source.y));
  element.setAttribute("x2", String(link.target.x - unitX * shrink));
  element.setAttribute("y2", String(link.target.y - unitY * shrink));
}

/** Replace the container's content with a short hint. */
function renderHint(container, text) {
  container.textContent = "";
  var hint = document.createElement("p");
  hint.className = "panel-hint";
  hint.textContent = text;
  container.appendChild(hint);
}

/**
 * Render the link graph into `options.container`.
 *
 * `options.docs` is the payload's document list (only `id` and `title` are
 * used), `options.edges` its edge list, and `options.onSelect(id)` is called
 * once per unmodified left click on a node — pressing and releasing without
 * moving, so a single click opens the document and a drag does not. A node whose
 * document is the one `setActive` last reported calls nothing: the reader is
 * already there. Returns `{ setActive(id), fit() }`; both are no-ops when the
 * site has no documents.
 */
export function createGraph(options) {
  var container = options && options.container;
  var docs = (options && options.docs) || [];
  var edges = (options && options.edges) || [];
  var onSelect = (options && options.onSelect) || function () {};

  var noop = { setActive: function () {}, fit: function () {} };
  if (!container) {
    return noop;
  }
  if (!docs.length) {
    renderHint(container, "No documents");
    return noop;
  }

  var docById = new Map();
  docs.forEach(function (doc) {
    docById.set(doc.id, doc);
  });

  var ids = docs.map(function (doc) {
    return doc.id;
  });
  var result = Graph.layout(ids, edges);
  var simplified = Graph.shouldSimplify(result.nodes.length);

  var nodeById = new Map();
  result.nodes.forEach(function (node) {
    nodeById.set(node.id, node);
  });

  var links = result.links
    .filter(function (link) {
      return nodeById.has(link.from) && nodeById.has(link.to);
    })
    .map(function (link) {
      var value = { source: nodeById.get(link.from), target: nodeById.get(link.to) };
      value.shrink = value.target.radius + (simplified ? 0 : 3);
      return value;
    });

  var adjacency = Graph.buildAdjacency(
    links.map(function (link) {
      return { from: link.source.id, to: link.target.id };
    }),
  );

  var incident = new Map();
  links.forEach(function (link) {
    [link.source, link.target].forEach(function (node) {
      var list = incident.get(node.id);
      if (!list) {
        list = [];
        incident.set(node.id, list);
      }
      list.push(link);
    });
  });

  container.textContent = "";
  container.setAttribute("data-simplified", simplified ? "true" : "false");
  container.setAttribute("data-nodes", String(result.nodes.length));
  container.setAttribute("data-links", String(links.length));

  var svg = d3Select(container)
    .append("svg")
    .attr("class", "graph-svg")
    .attr("viewBox", "0 0 " + result.width + " " + result.height)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .attr("role", "group")
    .attr("aria-label", "Link graph");

  svg
    .append("title")
    .text(
      "Link graph: " +
        result.nodes.length +
        (result.nodes.length === 1 ? " document" : " documents") +
        ", " +
        links.length +
        (links.length === 1 ? " link" : " links"),
    );

  if (!simplified) {
    svg
      .append("defs")
      .append("marker")
      .attr("id", ARROW_ID)
      .attr("class", "graph-arrow")
      .attr("viewBox", "0 0 6 6")
      .attr("refX", 5)
      .attr("refY", 3)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,0 L6,3 L0,6 Z");
  }

  var viewport = svg.append("g").attr("class", "graph-viewport");

  var edgeSelection = viewport
    .append("g")
    .attr("class", "graph-edges")
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("class", "graph-edge");

  if (!simplified) {
    edgeSelection.attr("marker-end", "url(#" + ARROW_ID + ")");
  }

  var nodeSelection = viewport
    .append("g")
    .attr("class", "graph-nodes")
    .selectAll("a")
    .data(result.nodes)
    .enter()
    .append("a")
    .attr("class", "graph-node")
    .attr("href", function (node) {
      return formatHash(node.id);
    })
    .attr("aria-label", function (node) {
      return describe(docById.get(node.id), node.degree);
    });

  nodeSelection.append("circle").attr("r", function (node) {
    return node.radius;
  });

  if (!simplified) {
    nodeSelection
      .append("text")
      .attr("class", "graph-label")
      .attr("text-anchor", "middle")
      .attr("dy", function (node) {
        return node.radius + 11;
      })
      .text(function (node) {
        return labelFor(docById.get(node.id));
      });
  }

  // Keep the DOM element on each datum: dragging then repositions the affected
  // lines directly instead of searching the selection on every pointer move.
  nodeSelection.each(function (node) {
    placeNode(this, node);
  });
  edgeSelection.each(function (link) {
    link.element = this;
    placeEdge(this, link);
  });

  var activeId = null;

  function highlight(id) {
    var near = null;
    if (id) {
      near = new Set([id].concat(Graph.neighbors(adjacency, id)));
    }

    nodeSelection
      .classed(HOT_CLASS, function (node) {
        return near !== null && near.has(node.id);
      })
      .classed(DIM_CLASS, function (node) {
        return near !== null && !near.has(node.id);
      });

    edgeSelection
      .classed(HOT_CLASS, function (link) {
        return near !== null && near.has(link.source.id) && near.has(link.target.id);
      })
      .classed(DIM_CLASS, function (link) {
        return near !== null && !(near.has(link.source.id) && near.has(link.target.id));
      });
  }

  function setActive(id) {
    activeId = id || null;
    nodeSelection
      .classed(ACTIVE_CLASS, function (node) {
        return node.id === activeId;
      })
      .attr("aria-current", function (node) {
        return node.id === activeId ? "true" : null;
      });
  }

  var zoomBehavior = d3Zoom()
    .scaleExtent([0.4, 4])
    .on("zoom", function (event) {
      viewport.attr("transform", event.transform);
    });

  svg.call(zoomBehavior);

  function fit() {
    svg.call(zoomBehavior.transform, zoomIdentity);
  }

  /** Move a node and the lines attached to it. */
  function moveNode(element, node) {
    placeNode(element, node);
    (incident.get(node.id) || []).forEach(function (link) {
      placeEdge(link.element, link);
    });
  }

  /**
   * The press the pointer is on, or `null` between gestures.
   *
   * `opens` records whether the release would open the document and `x`/`y`
   * where the press started. The press is dropped as soon as it is settled,
   * which is what tells the `click` path that this gesture has been handled.
   */
  var press = null;

  /** The object the pointer is followed on for the last press, or `null`. */
  var pointerWatcher = null;

  /** Remember where a plain left press landed; anything else ignores the release. */
  function armPress(source, node) {
    press = {
      id: node.id,
      x: source.clientX,
      y: source.clientY,
      opens: isPlainLeftPress(source),
    };
  }

  /** A press that moved is a pan or a drag, not a click. */
  function trackPointer(event) {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD_PX) {
      press.opens = false;
    }
  }

  /** Stop following the pointer; the gesture is over either way. */
  function unwatchPointer() {
    if (!pointerWatcher) {
      return;
    }

    d3Select(pointerWatcher).on(".press", null);
    pointerWatcher = null;
  }

  /**
   * Release the pending press: open the document unless it became a drag.
   *
   * The press is dropped either way — a gesture is decided once — but the
   * document behind it is only opened for a press that stayed put.
   */
  function settlePress(dragged) {
    var current = press;
    if (!current) {
      return;
    }

    unwatchPointer();
    press = null;
    if (dragged || !current.opens) {
      return;
    }

    openDocument(current.id);
  }

  /**
   * Open the document behind a node, unless it is already the one on screen.
   *
   * A click on the node of the document being read asks for what the reader
   * already has, so it does nothing at all — no navigation, no scroll, no
   * re-render. That is also what keeps a double click from opening the same
   * document twice: the first press has already made it the active one.
   */
  function openDocument(id) {
    if (id === activeId) {
      return;
    }

    onSelect(id);
  }

  /** Whether the window the page lives in still has the focus. */
  function pageHasFocus(view) {
    if (!view || typeof view.hasFocus !== "function") {
      // Nothing to ask: assume the page kept the focus, so a `blur` is the one
      // the page's own focus move causes and not the reader leaving.
      return true;
    }

    return view.hasFocus();
  }

  /**
   * Keep the press alive unless the reader has left the page with it.
   *
   * A press inside the page moves the focus: the element that had it announces
   * `blur`, and the press itself arrives at the window, so a `blur` is what a
   * perfectly ordinary press on a node looks like — `d3-zoom` even provokes one
   * by installing its own `blur` handler for the duration of the gesture. Only a
   * window without the focus is the reader having gone elsewhere mid-gesture,
   * which never sends a release and would otherwise leave a stale press behind
   * to judge the next gesture.
   */
  function dropPressOnLeave(event) {
    if (pageHasFocus((event && event.view) || pointerWatcher)) {
      return;
    }

    unwatchPointer();
    press = null;
  }

  /**
   * Follow the pointer until the button is back up.
   *
   * Neither gesture library can report the release of a press on a node usefully:
   * `d3-zoom` takes the press for panning and stops it before `d3-drag` sees it,
   * and `d3-drag` keeps the pointer capture on the window, so the release is
   * reported to the window rather than to the node. Both ends are therefore
   * watched here, and the release decides whether the press travelled far enough
   * to be a drag.
   *
   * `event.view` is `null` for a release the page synthesises, so the container
   * stands in: the handler only needs the coordinates the press recorded.
   */
  function watchPointer(event) {
    if (pointerWatcher) {
      return;
    }

    var view = (event && event.view) || (typeof globalThis !== "undefined" ? globalThis : null);
    if (!view) {
      return;
    }

    pointerWatcher = view;
    d3Select(view)
      .on("mousemove.press", trackPointer, { capture: true, passive: true })
      .on("mouseup.press pointerup.press", function () {
        settlePress();
      }, { capture: true, passive: true })
      .on("blur.press", dropPressOnLeave, { capture: true, passive: true })
      .on("touchmove.press", trackPointer, { capture: true, passive: true })
      .on("touchend.press touchcancel.press", function (release) {
        settlePress(release.type === "touchcancel");
      }, { capture: true, passive: true });
  }

  var dragBehavior = d3Drag()
    .container(function () {
      return viewport.node();
    })
    .subject(function (event, node) {
      // A press that lands between the nodes belongs to the canvas, which
      // d3-zoom pans; only a press on the node itself is a candidate click.
      var onNode = isNodeTarget(event.sourceEvent, this);
      return onNode ? { x: node.x, y: node.y } : null;
    })
    .clickDistance(DRAG_THRESHOLD_PX)
    .on("start", function (event, node) {
      d3Select(this).classed("is-dragging", true).raise();
      node.x = event.x;
      node.y = event.y;
      moveNode(this, node);
    })
    .on("drag", function (event, node) {
      node.x = event.x;
      node.y = event.y;
      moveNode(this, node);

      trackPointer(event);
    })
    .on("end", function () {
      d3Select(this).classed("is-dragging", false);
    });

  nodeSelection.call(dragBehavior);

  // A press is recorded on `pointerdown`, which a browser reports as well as
  // `mousedown`, and on `mousedown` as a fallback for a page without Pointer
  // Events. Neither is written onto the node: d3's handler list is captured per
  // dispatch, so a listener that writes one would see the same event twice.
  //
  // `defaultPrevented` deliberately plays no part: `d3-drag` and `d3-zoom`
  // cancel every press they take, and so does a browser for a link it is about
  // to follow, so a press that arrives already cancelled is the ordinary case
  // rather than a hint that this is not a new gesture. Whether the press was a
  // click is decided by the release, from how far the pointer travelled.
  nodeSelection.each(function (node) {
    ["pointerdown", "mousedown"].forEach(function (type) {
      this.addEventListener(type, function (event) {
        // A press that belongs to a gesture already under way — the compatibility
        // `mousedown` after the `pointerdown` of the same press, or a second
        // finger — is the same gesture, not a new one.
        if (press || event.button !== LEFT_BUTTON) {
          return;
        }

        armPress(event, node);
        watchPointer(event);
      });
    }, this);
  });

  nodeSelection
    .on("mouseenter", function (event, node) {
      highlight(node.id);
    })
    .on("mouseleave", function () {
      highlight(null);
    })
    .on("focus", function (event, node) {
      highlight(node.id);
    })
    .on("blur", function () {
      highlight(null);
    })
    .on("click", function (event, node) {
      // A modified click belongs to the browser: a new tab has to open there.
      if (!isPlainLeftClick(event)) {
        return;
      }

      // A press is only still pending when nothing settled it — the browser
      // announced no release this module could see — so this click is then the
      // whole gesture. A click that arrives after a settled press is its shadow
      // and is dropped: by `d3-drag`'s own suppression, by the release having
      // opened the document already, or by the double-click that the release of
      // the first press had answered.
      if (!press || press.id !== node.id) {
        return;
      }

      press = null;
      unwatchPointer();
      event.preventDefault();
      openDocument(node.id);
    });

  return { setActive: setActive, fit: fit };
}
