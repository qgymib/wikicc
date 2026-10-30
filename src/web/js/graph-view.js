/**
 * Link graph view: SVG rendering and interaction.
 *
 * `graph.js` owns the geometry; this module only draws it and wires the pointer
 * behaviour. `d3-selection` builds the markup, `d3-zoom` handles wheel/pinch
 * zoom and drag-to-pan, and `d3-drag` handles node dragging with pointer
 * capture (and suppresses the click that ends a drag).
 *
 * Everything is created once per page load. Changing the active document only
 * toggles a class, so routing never recomputes the layout; dragging moves the
 * existing elements instead of re-rendering the graph.
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

/** Whether a click should be handled by the router instead of the browser. */
function isPlainLeftClick(event) {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
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
 * when a node is clicked with an unmodified left button. Returns
 * `{ setActive(id), fit() }`; both are no-ops when the site has no documents.
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

  var dragBehavior = d3Drag()
    .container(function () {
      return viewport.node();
    })
    .subject(function (event, node) {
      return { x: node.x, y: node.y };
    })
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
    })
    .on("end", function () {
      d3Select(this).classed("is-dragging", false);
    });

  nodeSelection.call(dragBehavior);

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
      // d3-drag already swallows the click that ends a real drag; the check
      // keeps that guarantee explicit. Modified clicks keep their native
      // behaviour, so a graph node can still be opened in a new tab.
      if (event.defaultPrevented || !isPlainLeftClick(event)) {
        return;
      }
      event.preventDefault();
      onSelect(node.id);
    });

  return { setActive: setActive, fit: fit };
}
