/**
 * Tests for `src/web/js/doc-body.js`: the shared document-body render.
 *
 * Driven with a minimal fake DOM — an element records the markup written into
 * it and the queries run over it — because the rules under test are about
 * *what* the shared render does, not how the browser paints it: the class
 * composition, the markup injection, and whether the tables were handed to
 * the enhancer, which is the caller's declared intent.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BODY_CLASS,
  createDocBody,
  drawDiagrams,
  fillDocBody,
} from "../../src/web/js/doc-body.js";

/** Element stub: records markup writes and every query run over it. */
function fakeElement(tagName) {
  return {
    tagName: String(tagName).toUpperCase(),
    className: "",
    children: [],
    parentNode: null,
    queries: [],
    innerHTML: "",
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    /**
     * Record the selector instead of answering it: a fake table would have to
     * impersonate the enhancer's whole protocol, and the only fact under test
     * is *that* the walk was asked for — which is what the option declares.
     */
    querySelectorAll(selector) {
      this.queries.push(String(selector));
      return [];
    },
  };
}

/** Install a fake `document`, run `work` with the elements it created, restore. */
function withDocument(work) {
  const created = [];
  const previous = globalThis.document;

  globalThis.document = {
    createElement(tagName) {
      const element = fakeElement(tagName);
      created.push(element);
      return element;
    },
  };

  try {
    work(created);
  } finally {
    globalThis.document = previous;
  }
}

test("the shared body class is the article's own typography class", () => {
  assert.equal(BODY_CLASS, "doc-body");
});

test("createDocBody builds a doc-body carrying the markup", () => {
  withDocument(function (created) {
    var body = createDocBody("<p>alpha</p>");

    assert.equal(created.length, 1, "one element, built by the document");
    assert.equal(body.tagName, "DIV");
    assert.equal(body.className, "doc-body");
    assert.equal(body.innerHTML, "<p>alpha</p>", "the markup arrived as markup");
    assert.equal(fillDocBody(body, ""), body, "the fill hands the body back");
  });
});

test("createDocBody names the container first and typesets it second", () => {
  withDocument(function () {
    var body = createDocBody("<p>alpha</p>", { extraClass: "search-document" });

    assert.equal(
      body.className,
      "search-document doc-body",
      "what it is, then that it typesets like the article",
    );
  });
});

test("fillDocBody enhances the tables when the caller says so", () => {
  withDocument(function () {
    var body = fakeElement("div");

    fillDocBody(body, "<table></table>", { enhanceTables: true });

    assert.equal(body.innerHTML, "<table></table>");
    assert.deepEqual(body.queries, ["table"], "the enhancer walked the body");
  });
});

test("fillDocBody leaves the tables alone unless asked", () => {
  withDocument(function () {
    var body = fakeElement("div");

    fillDocBody(body, "<table></table>");
    assert.deepEqual(body.queries, [], "no walk without the option");

    fillDocBody(body, "<p>alpha</p>", { enhanceTables: false });
    assert.deepEqual(body.queries, [], "an explicit false is the same as absent");
  });
});

test("drawDiagrams hands the body to the diagram engine", () => {
  withDocument(function () {
    var body = fakeElement("div");

    var drawing = drawDiagrams(body, "dark");

    // The engine answers a promise even when there is nothing to draw — a
    // body without diagram blocks is the common case — and the recorded query
    // is the evidence the body, not something else, was handed over.
    assert.ok(drawing && typeof drawing.then === "function", "the drawing is asynchronous");
    assert.deepEqual(body.queries, ["pre.mermaid"], "the engine walked the body for diagrams");
  });
});
