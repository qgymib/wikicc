import test from "node:test";
import assert from "node:assert/strict";

import * as graph from "../../src/web/js/graph.js";

const IDS = ["README.md", "guide/intro.md", "guide/setup.md", "notes.md"];
const EDGES = [
  { from: "README.md", to: "guide/intro.md" },
  { from: "guide/intro.md", to: "guide/setup.md" },
];

/** Distance between two laid-out nodes. */
function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/** Centroid of a node list. */
function centroid(nodes) {
  const sum = nodes.reduce((accumulator, node) => ({
    x: accumulator.x + node.x,
    y: accumulator.y + node.y,
  }), { x: 0, y: 0 });
  return { x: sum.x / nodes.length, y: sum.y / nodes.length };
}

function nodeOf(result, id) {
  const found = result.nodes.find((node) => node.id === id);
  assert.ok(found, `missing node ${id}`);
  return found;
}

test("hashes ids into a stable 32-bit seed", () => {
  assert.equal(graph.hashSeed("README.md"), graph.hashSeed("README.md"));
  assert.notEqual(graph.hashSeed("README.md"), graph.hashSeed("readme.md"));
  assert.notEqual(graph.hashSeed("a.md"), graph.hashSeed("b.md"));

  for (const text of ["", "a", "guide/intro.md", "中文/说明.md", "x".repeat(500)]) {
    const seed = graph.hashSeed(text);
    assert.ok(Number.isInteger(seed), `integer seed for ${text}`);
    assert.ok(seed >= 0 && seed <= 0xffffffff, `uint32 seed for ${text}`);
  }

  assert.equal(graph.hashSeed(null), graph.hashSeed(""));
  assert.equal(graph.hashSeed(undefined), graph.hashSeed(""));
});

test("mulberry32 replays the same sequence for the same seed", () => {
  const first = graph.mulberry32(12345);
  const second = graph.mulberry32(12345);
  const values = Array.from({ length: 32 }, () => first());

  assert.deepEqual(values, Array.from({ length: 32 }, () => second()));
  for (const value of values) {
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
  }
  assert.notDeepEqual(values, Array.from({ length: 32 }, graph.mulberry32(12346)));
});

test("deduplicates edges, drops self-loops and unknown documents", () => {
  const edges = [
    { from: "b.md", to: "c.md" },
    { from: "b.md", to: "c.md" },
    { from: "a.md", to: "a.md" },
    { from: "a.md", to: "b.md" },
    { from: "a.md", to: "ghost.md" },
    { from: "ghost.md", to: "a.md" },
    { from: "", to: "a.md" },
    null,
  ];

  assert.deepEqual(graph.dedupeEdges(edges, ["a.md", "b.md", "c.md"]), [
    { from: "a.md", to: "b.md" },
    { from: "b.md", to: "c.md" },
  ]);
  assert.deepEqual(graph.dedupeEdges(edges), [
    { from: "a.md", to: "b.md" },
    { from: "a.md", to: "ghost.md" },
    { from: "b.md", to: "c.md" },
    { from: "ghost.md", to: "a.md" },
  ]);
  assert.deepEqual(graph.dedupeEdges(null), []);
});

test("builds both adjacency directions and counts distinct neighbours", () => {
  const adjacency = graph.buildAdjacency([
    { from: "a.md", to: "b.md" },
    { from: "b.md", to: "a.md" },
    { from: "a.md", to: "c.md" },
    { from: "a.md", to: "c.md" },
    { from: "d.md", to: "d.md" },
  ]);

  assert.deepEqual(Array.from(adjacency.out.get("a.md")).sort(), ["b.md", "c.md"]);
  assert.deepEqual(Array.from(adjacency.incoming.get("a.md")).sort(), ["b.md"]);
  assert.deepEqual(graph.neighbors(adjacency, "a.md"), ["b.md", "c.md"]);
  assert.deepEqual(graph.neighbors(adjacency, "c.md"), ["a.md"]);

  assert.equal(adjacency.degree.get("a.md"), 2);
  assert.equal(adjacency.degree.get("b.md"), 1);
  assert.equal(adjacency.degree.has("d.md"), false, "self-loops are not neighbours");
  assert.deepEqual(graph.neighbors(adjacency, "ghost.md"), []);
  assert.deepEqual(graph.neighbors(null, "a.md"), []);
});

test("simplifies large graphs only above the threshold", () => {
  assert.equal(graph.shouldSimplify(0), false);
  assert.equal(graph.shouldSimplify(graph.SIMPLIFY_THRESHOLD), false);
  assert.equal(graph.shouldSimplify(graph.SIMPLIFY_THRESHOLD + 1), true);
  assert.equal(graph.shouldSimplify(5000), true);
});

test("grows node radius with degree and shrinks it in simplified mode", () => {
  assert.ok(graph.nodeRadius(0) < graph.nodeRadius(1));
  assert.ok(graph.nodeRadius(1) < graph.nodeRadius(9));
  assert.equal(graph.nodeRadius(9), graph.nodeRadius(100), "radius is clamped");
  assert.ok(graph.nodeRadius(3, true) < graph.nodeRadius(3));
  assert.ok(graph.nodeRadius(0) > 0);
});

test("lays the same graph out identically twice", () => {
  const first = graph.layout(IDS, EDGES);
  const second = graph.layout(IDS, EDGES);

  assert.deepEqual(first, second);
});

test("keeps every node inside the normalised box", () => {
  const result = graph.layout(IDS, EDGES);
  const padding = graph.LAYOUT_DEFAULTS.padding;

  assert.equal(result.width, graph.LAYOUT_DEFAULTS.width);
  assert.equal(result.height, graph.LAYOUT_DEFAULTS.height);
  assert.equal(result.nodes.length, IDS.length);
  assert.equal(result.links.length, EDGES.length);

  for (const node of result.nodes) {
    assert.ok(Number.isFinite(node.x), `finite x for ${node.id}`);
    assert.ok(Number.isFinite(node.y), `finite y for ${node.id}`);
    assert.ok(node.x >= padding - 1e-9 && node.x <= result.width - padding + 1e-9, `x in box: ${node.x}`);
    assert.ok(node.y >= padding - 1e-9 && node.y <= result.height - padding + 1e-9, `y in box: ${node.y}`);
    assert.ok(node.radius > 0, `radius for ${node.id}`);
  }
});

test("honours a custom viewport", () => {
  const result = graph.layout(IDS, EDGES, { width: 600, height: 200, padding: 10 });

  assert.equal(result.width, 600);
  assert.equal(result.height, 200);
  for (const node of result.nodes) {
    assert.ok(node.x >= 10 - 1e-9 && node.x <= 590 + 1e-9, `x in box: ${node.x}`);
    assert.ok(node.y >= 10 - 1e-9 && node.y <= 190 + 1e-9, `y in box: ${node.y}`);
  }
});

test("centers a single document", () => {
  const result = graph.layout(["only.md"], []);

  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].degree, 0);
  assert.equal(result.nodes[0].x, result.width / 2);
  assert.equal(result.nodes[0].y, result.height / 2);
});

test("returns an empty layout for an empty site", () => {
  const result = graph.layout([], []);

  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.links, []);
  assert.equal(result.width, graph.LAYOUT_DEFAULTS.width);
  assert.equal(result.height, graph.LAYOUT_DEFAULTS.height);
});

test("keeps documents without links on a ring around the connected cluster", () => {
  const ids = ["a.md", "b.md", "c.md", "orphan.md"];
  const edges = [
    { from: "a.md", to: "b.md" },
    { from: "b.md", to: "c.md" },
  ];
  const result = graph.layout(ids, edges);
  const connected = result.nodes.filter((node) => node.id !== "orphan.md");
  const center = centroid(connected);
  const farthestConnected = Math.max(...connected.map((node) => distance(node, center)));

  assert.equal(nodeOf(result, "orphan.md").degree, 0);
  assert.ok(
    distance(nodeOf(result, "orphan.md"), center) > farthestConnected,
    "the isolated node must sit outside the connected cluster",
  );
});

test("spreads a site made only of isolated documents on a circle", () => {
  const result = graph.layout(["a.md", "b.md", "c.md"], []);
  // Three points spaced 120° apart on a ring: their centroid is the ring centre.
  const center = centroid(result.nodes);
  const distances = result.nodes.map((node) => distance(node, center));

  for (const node of result.nodes) {
    assert.equal(node.degree, 0);
  }
  for (const value of distances) {
    assert.ok(Math.abs(value - distances[0]) < 1e-6, `ring radius: ${value} vs ${distances[0]}`);
  }
  assert.ok(distances[0] > 0, "the ring must not collapse to the center");
});

test("ignores ids and edges that do not belong to the site", () => {
  const result = graph.layout(["a.md", "a.md", ""], [{ from: "a.md", to: "ghost.md" }]);

  assert.deepEqual(result.nodes.map((node) => node.id), ["a.md"]);
  assert.deepEqual(result.links, []);
});

test("does not mutate the payload it is given", () => {
  const ids = IDS.slice();
  const edges = EDGES.map((edge) => ({ from: edge.from, to: edge.to }));

  graph.layout(ids, edges);

  assert.deepEqual(ids, IDS);
  assert.deepEqual(edges, EDGES);
});
