/**
 * Tests for the backlinks view (`src/web/js/backlinks.js`).
 *
 * The reverse references are a filter over the payload's link graph, so the
 * pure half is tested the way the graph itself is: what survives the filter,
 * in the order the edges carry, and what a hand-made payload that breaks the
 * build's invariants is answered. The view half drives the same fake DOM the
 * other view tests use — a link's click reaches `onNavigate` exactly when a
 * plain left click does, and a document without sources is answered with a
 * message instead of an empty box.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { backlinksOf, createBacklinks } from "../../src/web/js/backlinks.js";
import { createFakeDocument, withGlobals } from "./helpers/dom.js";

function edge(from, to) {
  return { from, to };
}

test("an absent graph answers no backlinks", () => {
  assert.deepEqual(backlinksOf([], "a.md"), []);
  assert.deepEqual(backlinksOf(null, "a.md"), []);
  assert.deepEqual(backlinksOf(undefined, "a.md"), []);
});

test("only the edges that point at the document survive", () => {
  const edges = [
    edge("b.md", "a.md"),
    edge("a.md", "b.md"),
    edge("c.md", "a.md"),
  ];

  assert.deepEqual(backlinksOf(edges, "a.md"), ["b.md", "c.md"]);
  assert.deepEqual(backlinksOf(edges, "b.md"), ["a.md"]);
  assert.deepEqual(backlinksOf(edges, "missing.md"), []);
});

test("a self-loop is not a backlink", () => {
  assert.deepEqual(backlinksOf([edge("a.md", "a.md")], "a.md"), []);
});

test("a repeated source is listed once", () => {
  // The build deduplicates its edges, but a hand-made payload may not: the
  // filter must not lean on an invariant it cannot see.
  const edges = [
    edge("b.md", "a.md"),
    edge("b.md", "a.md"),
    edge("b.md", "a.md"),
  ];

  assert.deepEqual(backlinksOf(edges, "a.md"), ["b.md"]);
});

test("the sources keep the order the edges carry", () => {
  const edges = [
    edge("c.md", "a.md"),
    edge("a.md", "a.md"),
    edge("b.md", "a.md"),
    edge("d.md", "a.md"),
  ];

  assert.deepEqual(backlinksOf(edges, "a.md"), ["c.md", "b.md", "d.md"]);
});

test("a malformed edge is skipped instead of thrown", () => {
  const edges = [null, edge("b.md", "a.md"), {}];

  assert.deepEqual(backlinksOf(edges, "a.md"), ["b.md"]);
});

/** Every `<a>` below `container`, in document order. */
function renderedLinks(container) {
  const links = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.tagName === "A") {
        links.push(child);
      }
      walk(child);
    });
  })(container);
  return links;
}

/**
 * A view over a fake document, built — and rendered — inside the fake
 * globals: `document.createElement` reads the global, so every call that
 * touches it runs while the fake is installed.
 */
function buildView(extra) {
  const doc = createFakeDocument();
  const container = doc.createElement("nav");
  const state = { doc: doc, container: container };

  withGlobals({ document: doc }, function () {
    state.view = createBacklinks(
      Object.assign(
        {
          container: container,
          docs: [
            { id: "guide/intro.md", title: "Intro" },
            { id: "guide/other.md", title: "" },
          ],
          edges: [
            edge("guide/intro.md", "index.md"),
            edge("guide/other.md", "index.md"),
            edge("missing.md", "index.md"),
          ],
          onNavigate: function () {},
        },
        extra || {},
      ),
    );
  });

  state.render = function (id) {
    withGlobals({ document: doc }, function () {
      state.view.render(id);
    });
  };

  return state;
}

test("the panel lists every source under the payload's titles", () => {
  const state = buildView();
  state.render("index.md");

  const links = renderedLinks(state.container);
  assert.equal(links.length, 3);
  assert.deepEqual(
    links.map(function (link) {
      return link.textContent;
    }),
    ["Intro", "guide/other.md", "missing.md"],
    "a titleless document falls back to its id",
  );
  assert.deepEqual(
    links.map(function (link) {
      return link.href;
    }),
    ["#/doc/guide/intro.md", "#/doc/guide/other.md", "#/doc/missing.md"],
  );
});

test("the id rides along on every link", () => {
  const state = buildView();
  state.render("index.md");

  const links = renderedLinks(state.container);
  assert.equal(links[0].title, "guide/intro.md");
});

test("a document without sources is answered with a message", () => {
  const state = buildView();
  state.render("unlinked.md");

  assert.equal(state.container.children.length, 1);
  const empty = state.container.children[0];
  assert.equal(empty.tagName, "P");
  assert.equal(empty.className, "backlinks-empty");
  assert.equal(empty.textContent, "No documents link to this one.");
});

test("an unknown document reads as an unlinked one", () => {
  const state = buildView();
  state.render("missing.md");

  assert.equal(state.container.children[0].className, "backlinks-empty");
});

test("clearing the panel answers nothing at all", () => {
  const state = buildView();
  state.render("index.md");
  state.render(null);

  assert.equal(state.container.children.length, 0);
});

test("a plain left click navigates to the source", () => {
  const arrived = [];
  const state = buildView({
    onNavigate: function (id, anchor) {
      arrived.push([id, anchor]);
    },
  });
  state.render("index.md");

  const link = renderedLinks(state.container)[0];
  link.fire("click", {
    button: 0,
    preventDefault() {
      link.prevented = true;
    },
  });

  assert.deepEqual(arrived, [["guide/intro.md", null]]);
  assert.ok(link.prevented, "the navigation takes the route, not the browser");
});

test("a modified click keeps the browser's own behaviour", () => {
  const arrived = [];
  const state = buildView({
    onNavigate: function (id, anchor) {
      arrived.push([id, anchor]);
    },
  });
  state.render("index.md");

  renderedLinks(state.container)[0].fire("click", {
    button: 0,
    metaKey: true,
    preventDefault() {},
  });

  assert.deepEqual(arrived, []);
});

test("a view without a container renders nothing", () => {
  const doc = createFakeDocument();
  withGlobals({ document: doc }, function () {
    const view = createBacklinks({ container: null, docs: [], edges: [] });
    view.render("index.md");
  });
});
