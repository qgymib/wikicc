/**
 * Link graph core: deterministic force layout and adjacency queries.
 *
 * The payload carries the document ids and the resolved `edges` array, so the
 * graph needs no build-time work: positions are computed once in the browser.
 * Layout is delegated to `d3-force` (Barnes–Hut many-body, spring links, collide
 * and centering), and every source of randomness is replaced by a PRNG seeded
 * from the document ids. Reloading the page therefore yields exactly the same
 * coordinates, which is what makes the panel feel stable.
 *
 * The module is DOM-free on purpose: `node --test` imports it directly, and the
 * SVG layer lives in `graph-view.js`. Nothing here calls `Math.random`,
 * `Date.now` or `performance.now`.
 */
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";

/** Above this many nodes the renderer drops labels and arrowheads. */
export var SIMPLIFY_THRESHOLD = 400;

/** Golden angle, used to spread the initial positions evenly. */
var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Layout geometry and force parameters, all in layout units. */
export var LAYOUT_DEFAULTS = {
  width: 320,
  height: 260,
  padding: 18,
  iterations: 300,
  linkDistance: 46,
  linkStrength: 0.6,
  chargeStrength: -170,
  collideRadius: 12,
  isolateScale: 1.3,
  maxUpscale: 1,
};

/**
 * The node count at which the frame reaches its default size.
 *
 * Below it the frame shrinks, which lets the display magnify the picture and is
 * what keeps a small neighbourhood readable; above it the frame grows until
 * `MAX_SPREAD` caps it, so a whole site still lays out into one frame.
 */
export var REF_NODES = 12;

/** Bounds of the per-node frame scaling factor. */
export var MIN_SPREAD = 0.6;
export var MAX_SPREAD = 3;

/**
 * Frame geometry for a node count, in layout units.
 *
 * The frame scales with the square root of the node count: twice as many
 * documents need twice the area, so the average spacing a reader sees stays
 * roughly constant instead of growing with the emptiness of a fixed frame.
 */
export function frameFor(count) {
  var total = Number(count);
  if (!Number.isFinite(total) || total <= 0) {
    total = 1;
  }

  var spread = Math.min(
    MAX_SPREAD,
    Math.max(MIN_SPREAD, Math.sqrt(total / REF_NODES)),
  );
  return {
    width: LAYOUT_DEFAULTS.width * spread,
    height: LAYOUT_DEFAULTS.height * spread,
    padding: LAYOUT_DEFAULTS.padding * spread,
  };
}

/** FNV-1a over UTF-16 code units, so the seed never depends on the locale. */
export function hashSeed(text) {
  var source = String(text === null || text === undefined ? "" : text);
  var value = 0x811c9dc5;

  for (var index = 0; index < source.length; index += 1) {
    value ^= source.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }

  return value >>> 0;
}

/** mulberry32: a tiny, fast, deterministic PRNG returning `[0, 1)`. */
export function mulberry32(seed) {
  var state = seed >>> 0;

  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    var value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether a graph this large has to drop labels and arrowheads. */
export function shouldSimplify(nodeCount) {
  return Number(nodeCount) > SIMPLIFY_THRESHOLD;
}

/** Radius of a node in layout units; larger degrees read as more important. */
export function nodeRadius(degree, simplified) {
  var value = Number(degree);
  var base = simplified ? 1.5 : 2.5;

  if (!Number.isFinite(value) || value <= 0) {
    return base;
  }

  return base + Math.min(simplified ? 1 : 3.5, Math.sqrt(value) * 1.1);
}

/** Trim an edge endpoint to a string, `""` for anything unusable. */
function endpoint(value) {
  return String(value === null || value === undefined ? "" : value);
}

/**
 * Normalise an edge list.
 *
 * Duplicates collapse, self-loops are dropped, and — when `knownIds` is given —
 * so is every edge that touches an id outside the document list, because
 * `d3-force` throws on an unresolvable link. The result is sorted by
 * `(from, to)` so the layout never depends on the payload order of the edges.
 */
export function dedupeEdges(edges, knownIds) {
  var known =
    knownIds === null || knownIds === undefined ? null : new Set(knownIds);
  var seen = new Set();
  var result = [];

  (edges || []).forEach(function (edge) {
    if (!edge) {
      return;
    }

    var from = endpoint(edge.from);
    var to = endpoint(edge.to);
    if (!from || !to || from === to) {
      return;
    }
    if (known && (!known.has(from) || !known.has(to))) {
      return;
    }

    var key = from + "\u0000" + to;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push({ from: from, to: to });
  });

  return result.sort(function (left, right) {
    if (left.from !== right.from) {
      return left.from < right.from ? -1 : 1;
    }
    if (left.to !== right.to) {
      return left.to < right.to ? -1 : 1;
    }
    return 0;
  });
}

/** Union of the outgoing and incoming neighbours of `id`, sorted. */
function unionNeighbors(outgoing, incoming, id) {
  var result = new Set();

  if (outgoing) {
    outgoing.forEach(function (target) {
      if (target !== id) {
        result.add(target);
      }
    });
  }
  if (incoming) {
    incoming.forEach(function (source) {
      if (source !== id) {
        result.add(source);
      }
    });
  }

  return Array.from(result).sort();
}

/**
 * Build the two adjacency directions plus the neighbour count of every node.
 *
 * `degree` counts *distinct* neighbours in both directions, so a pair of
 * documents that link to each other is worth one neighbour, not two.
 */
export function buildAdjacency(edges) {
  var out = new Map();
  var incoming = new Map();
  var degree = new Map();

  function bucket(map, id) {
    var set = map.get(id);
    if (!set) {
      set = new Set();
      map.set(id, set);
    }
    return set;
  }

  (edges || []).forEach(function (edge) {
    if (!edge) {
      return;
    }

    var from = endpoint(edge.from);
    var to = endpoint(edge.to);
    if (!from || !to || from === to) {
      return;
    }

    bucket(out, from).add(to);
    bucket(incoming, to).add(from);
  });

  var ids = new Set();
  [out, incoming].forEach(function (map) {
    map.forEach(function (neighbors, id) {
      ids.add(id);
      neighbors.forEach(function (neighbor) {
        ids.add(neighbor);
      });
    });
  });

  ids.forEach(function (id) {
    degree.set(id, unionNeighbors(out.get(id), incoming.get(id), id).length);
  });

  return { out: out, incoming: incoming, degree: degree };
}

/** Neighbour ids of `id` in either direction, sorted, without `id` itself. */
export function neighbors(adjacency, id) {
  if (!adjacency) {
    return [];
  }

  return unionNeighbors(
    adjacency.out ? adjacency.out.get(id) : null,
    adjacency.incoming ? adjacency.incoming.get(id) : null,
    id,
  );
}

/** Hops a local view reaches out from its seed. */
export var LOCAL_DEPTH = 1;

/**
 * The neighbourhood of `seed`, ready to be laid out on its own.
 *
 * "Related" means linked in either direction — the same relation the hover
 * highlight traces — so a document that only receives links is as much part of
 * the local view as one the seed points at. `depth` hops are taken, one by
 * default: enough that every neighbour is on screen, and small enough that the
 * picture still says what the current document is.
 *
 * Edges are kept only when both ends survive the cut, because a line to a node
 * that is not drawn is a line to nothing. The result keeps the order of `ids`,
 * so the same payload always yields the same subgraph — and therefore the same
 * layout, which is what keeps switching documents from shuffling the picture.
 *
 * A seed that is not one of `ids` yields an empty subgraph: nothing is known
 * about a document that is not on the site, and inventing a lone node for it
 * would draw a document the reader cannot open.
 */
export function subgraph(ids, edges, seed, depth) {
  var list = [];
  var seen = new Set();

  (ids || []).forEach(function (id) {
    var value = endpoint(id);
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    list.push(value);
  });

  var anchor = endpoint(seed);
  if (!anchor || !seen.has(anchor)) {
    return { ids: [], edges: [] };
  }

  var hops =
    Number.isFinite(Number(depth)) && Number(depth) >= 1
      ? Math.floor(Number(depth))
      : LOCAL_DEPTH;
  var kept = dedupeEdges(edges, list);
  var adjacency = buildAdjacency(kept);

  // Breadth-first over the bidirectional relation: every step adds the
  // neighbours of everything reached so far, which is exactly "depth hops".
  var inside = new Set([anchor]);
  var frontier = [anchor];
  for (var step = 0; step < hops && frontier.length; step += 1) {
    var next = [];
    frontier.forEach(function (id) {
      neighbors(adjacency, id).forEach(function (other) {
        if (!inside.has(other)) {
          inside.add(other);
          next.push(other);
        }
      });
    });
    frontier = next;
  }

  return {
    ids: list.filter(function (id) {
      return inside.has(id);
    }),
    edges: kept.filter(function (edge) {
      return inside.has(edge.from) && inside.has(edge.to);
    }),
  };
}

/** Non-finite coordinates would poison the normalisation; clamp them to zero. */
function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

/** Centroid of a node list, `{ x: 0, y: 0 }` when it is empty. */
function centroid(nodes) {
  if (!nodes.length) {
    return { x: 0, y: 0 };
  }

  var sum = nodes.reduce(
    function (accumulator, node) {
      return { x: accumulator.x + node.x, y: accumulator.y + node.y };
    },
    { x: 0, y: 0 },
  );

  return { x: sum.x / nodes.length, y: sum.y / nodes.length };
}

/** Largest distance from `center` to any node in the list. */
function maxRadius(nodes, center) {
  return nodes.reduce(function (largest, node) {
    var distance = Math.sqrt(
      (node.x - center.x) * (node.x - center.x) +
        (node.y - center.y) * (node.y - center.y),
    );
    return Math.max(largest, distance);
  }, 0);
}

/**
 * Scale and center the layout inside `[padding, width - padding]` by
 * `[padding, height - padding]`, keeping the aspect ratio.
 *
 * Content larger than the frame is scaled down to fit; content smaller than
 * the frame is centered without being stretched, up to `maxUpscale`. A
 * degenerate bounding box (one node, or every node on a line) collapses one
 * axis; the uniform scale then centers the cluster on that axis instead of
 * stretching it.
 */
function normalize(nodes, settings) {
  if (!nodes.length) {
    return;
  }

  var minX = Infinity;
  var maxX = -Infinity;
  var minY = Infinity;
  var maxY = -Infinity;

  nodes.forEach(function (node) {
    node.x = finiteOrZero(node.x);
    node.y = finiteOrZero(node.y);
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  });

  var spanX = maxX - minX;
  var spanY = maxY - minY;
  var innerWidth = Math.max(1, settings.width - 2 * settings.padding);
  var innerHeight = Math.max(1, settings.height - 2 * settings.padding);
  var scale = Math.min(
    spanX > 0 ? innerWidth / spanX : Infinity,
    spanY > 0 ? innerHeight / spanY : Infinity,
  );

  if (!Number.isFinite(scale)) {
    scale = 1;
  }

  // A frame smaller than its content is scaled down to fit; a frame larger
  // than its content is not stretched to fill. Stretching a settled force
  // layout is what used to fling a small neighbourhood to the corners of the
  // panel and leave the middle empty, so the scale stops at `maxUpscale` and
  // the surplus frame stays around the centered cluster.
  scale = Math.min(scale, settings.maxUpscale);

  var offsetX = settings.padding + (innerWidth - spanX * scale) / 2;
  var offsetY = settings.padding + (innerHeight - spanY * scale) / 2;

  nodes.forEach(function (node) {
    node.x = offsetX + (node.x - minX) * scale;
    node.y = offsetY + (node.y - minY) * scale;
  });
}

/**
 * Compute a deterministic layout for `ids` and `edges`.
 *
 * Steps: seed the PRNG from the document ids, spread the initial positions on a
 * golden-angle disc, run `d3-force` for `iterations` synchronous ticks, move the
 * isolated nodes onto a ring around the connected cluster, then normalise into
 * the frame. Unless `opts` pins an explicit viewport, the frame is sized by
 * `frameFor` from the node count. `opts` overrides [`LAYOUT_DEFAULTS`].
 *
 * Returns `{ width, height, links, nodes: [{ id, x, y, degree, radius }] }`;
 * nodes keep the order of `ids` and `links` is the deduplicated edge list the
 * renderer draws.
 */
export function layout(ids, edges, options) {
  var overrides = options || {};
  var settings = Object.assign({}, LAYOUT_DEFAULTS, overrides);
  var seen = new Set();
  var list = [];

  (ids || []).forEach(function (id) {
    var value = endpoint(id);
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    list.push(value);
  });

  var links = dedupeEdges(edges, list);
  var adjacency = buildAdjacency(links);

  if (!list.length) {
    return {
      width: settings.width,
      height: settings.height,
      links: [],
      nodes: [],
    };
  }

  // An explicit viewport wins; otherwise the frame follows the node count, so
  // a two-document neighbourhood is not laid out into a frame sized for a
  // whole site — the display then magnifies the small picture instead of
  // scattering it across a large, empty one.
  if (overrides.width === undefined && overrides.height === undefined) {
    var frame = frameFor(list.length);
    settings.width = frame.width;
    settings.height = frame.height;
    if (overrides.padding === undefined) {
      settings.padding = frame.padding;
    }
  }

  var random = mulberry32(hashSeed(list.join("\u0000")));
  var nodes = list.map(function (id, index) {
    return { id: id, index: index, x: 0, y: 0 };
  });

  // Golden-angle disc: even coverage without clustering, and the PRNG only
  // nudges the points so the forces never start from a perfectly symmetric
  // configuration (which would keep symmetric layouts stuck).
  var disc = Math.max(1, Math.sqrt(nodes.length));
  nodes.forEach(function (node, index) {
    var angle = index * GOLDEN_ANGLE;
    var distance = disc * Math.sqrt((index + 0.5) / nodes.length);
    node.x = Math.cos(angle) * distance + (random() - 0.5) * 0.01;
    node.y = Math.sin(angle) * distance + (random() - 0.5) * 0.01;
  });

  if (nodes.length > 1) {
    var simulation = forceSimulation(nodes)
      .randomSource(random)
      .force(
        "link",
        forceLink(
          links.map(function (link) {
            return { source: link.from, target: link.to };
          }),
        )
          .id(function (node) {
            return node.id;
          })
          .distance(settings.linkDistance)
          .strength(settings.linkStrength),
      )
      .force("charge", forceManyBody().strength(settings.chargeStrength))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(settings.collideRadius))
      .stop();

    // Synchronous ticks: no timer, no animation frame, so the page paints the
    // final layout once and the coordinates are reproducible.
    for (var tick = 0; tick < settings.iterations; tick += 1) {
      simulation.tick();
    }
  }

  var connected = nodes.filter(function (node) {
    return (adjacency.degree.get(node.id) || 0) > 0;
  });
  var isolated = nodes.filter(function (node) {
    return (adjacency.degree.get(node.id) || 0) === 0;
  });

  if (isolated.length) {
    // Documents that link nowhere would be pushed far away by the repulsion,
    // so they are parked on a ring around the connected cluster instead.
    var center = centroid(connected);
    var ring = Math.max(
      maxRadius(connected, center) * settings.isolateScale,
      settings.linkDistance,
    );

    isolated.forEach(function (node, index) {
      var angle = (2 * Math.PI * index) / isolated.length - Math.PI / 2;
      node.x = center.x + Math.cos(angle) * ring;
      node.y = center.y + Math.sin(angle) * ring;
    });
  }

  normalize(nodes, settings);

  var simplified = shouldSimplify(nodes.length);
  return {
    width: settings.width,
    height: settings.height,
    links: links,
    nodes: nodes.map(function (node) {
      var degree = adjacency.degree.get(node.id) || 0;
      return {
        id: node.id,
        x: node.x,
        y: node.y,
        degree: degree,
        radius: nodeRadius(degree, simplified),
      };
    }),
  };
}
