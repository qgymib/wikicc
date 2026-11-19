/**
 * Tests for the tags view (`src/web/js/tags.js`).
 *
 * The aggregation is a filter over the payload's tag list, so the pure half
 * is tested the way the backlinks filter is: what a tag's documents list
 * answers, and what a hand-made payload that breaks the build's invariants
 * is answered. The view half drives the same fake DOM the other view tests
 * use — a row's click reaches `onSelect` exactly when a plain left click
 * does, the selected row unfolds its documents, and a site without tags is
 * answered with a message instead of an empty box.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TAG_CHIP_ATTRIBUTE,
  TAG_CHIP_SELECTOR,
  createTagsPanel,
  docsOfTag,
} from "../../src/web/js/tags.js";
import { createFakeDocument, withGlobals } from "./helpers/dom.js";

function entry(tag, docs) {
  return { tag, docs };
}

test("the chip attribute and selector are one contract", () => {
  assert.equal(TAG_CHIP_ATTRIBUTE, "data-tag");
  assert.equal(TAG_CHIP_SELECTOR, ".doc-tag[data-tag]");
});

test("an absent aggregation answers no documents", () => {
  assert.deepEqual(docsOfTag([], "a-tag"), []);
  assert.deepEqual(docsOfTag(null, "a-tag"), []);
  assert.deepEqual(docsOfTag(undefined, "a-tag"), []);
});

test("the tag's documents arrive in the payload's order", () => {
  const tags = [entry("rust", ["b.md", "a.md"]), entry("solo", ["c.md"])];

  assert.deepEqual(docsOfTag(tags, "rust"), ["b.md", "a.md"]);
  assert.deepEqual(docsOfTag(tags, "solo"), ["c.md"]);
  assert.deepEqual(docsOfTag(tags, "missing"), []);
});

test("a malformed entry is skipped instead of thrown", () => {
  const tags = [null, entry("rust", "not-a-list"), {}, entry("rust", ["a.md"])];

  assert.deepEqual(docsOfTag(tags, "rust"), ["a.md"]);
});

test("answering with one tag never hands out the payload's own list", () => {
  const tags = [entry("rust", ["a.md"])];
  const docs = docsOfTag(tags, "rust");
  docs.push("smuggled.md");

  assert.deepEqual(tags[0].docs, ["a.md"]);
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

/** Every `.tag-name` row below `container`, in document order. */
function renderedRows(container) {
  const rows = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.tagName === "BUTTON" && child.className === "tag-name") {
        rows.push(child);
      }
      walk(child);
    });
  })(container);
  return rows;
}

/**
 * A view over a fake document, built — and rendered — inside the fake
 * globals: `document.createElement` reads the global, so every call that
 * touches it runs while the fake is installed.
 */
function buildView(extra) {
  const doc = createFakeDocument();
  const container = doc.createElement("nav");
  const state = { doc: doc, container: container, selected: [], navigated: [] };

  withGlobals({ document: doc }, function () {
    state.view = createTagsPanel(
      Object.assign(
        {
          container: container,
          docs: [
            { id: "index.md", title: "Index" },
            { id: "guide/intro.md", title: "Intro" },
          ],
          tags: [
            entry("rust", ["guide/intro.md", "index.md"]),
            entry("solo", ["index.md"]),
          ],
          onSelect: function (tag) {
            state.selected.push(tag);
          },
          onNavigate: function (id) {
            state.navigated.push(id);
          },
        },
        extra || {},
      ),
    );
  });

  state.render = function (activeTag) {
    withGlobals({ document: doc }, function () {
      state.view.render(activeTag);
    });
  };

  return state;
}

test("an empty aggregation renders the empty message", () => {
  const state = buildView({ tags: [] });
  state.render(null);

  assert.equal(state.container.children.length, 1);
  const empty = state.container.children[0];
  assert.equal(empty.className, "tags-empty");
  assert.equal(empty.textContent, "No tags yet.");
});

test("the panel lists every tag with its document count", () => {
  const state = buildView();
  state.render(null);

  const rows = renderedRows(state.container);
  assert.equal(rows.length, 2, "one row per tag, in payload order");
  assert.deepEqual(
    rows.map(function (row) {
      return row.children.map(function (child) {
        return child.textContent;
      });
    }),
    [
      ["#rust", "2"],
      ["#solo", "1"],
    ],
  );
  assert.equal(
    renderedLinks(state.container).length,
    0,
    "nothing is unfolded before a selection",
  );
});

test("the selected row unfolds its documents under the payload's titles", () => {
  const state = buildView();
  state.render("rust");

  const rows = renderedRows(state.container);
  assert.equal(rows[0].getAttribute("aria-expanded"), "true");
  assert.equal(rows[1].getAttribute("aria-expanded"), "false");

  const links = renderedLinks(state.container);
  assert.deepEqual(
    links.map(function (link) {
      return link.textContent;
    }),
    ["Intro", "Index"],
    "the documents keep the payload's order, named by title",
  );
  assert.deepEqual(
    links.map(function (link) {
      return link.href;
    }),
    ["#/doc/guide/intro.md", "#/doc/index.md"],
  );
  assert.deepEqual(
    links.map(function (link) {
      return link.title;
    }),
    ["guide/intro.md", "index.md"],
    "the id stays at hand when titles do not tell two files apart",
  );
});

test("a row answers its tag to onSelect on a plain left click", () => {
  const state = buildView();
  state.render(null);

  renderedRows(state.container)[0].fire("click", {
    button: 0,
    preventDefault() {},
  });

  assert.deepEqual(state.selected, ["rust"]);
});

test("a modified click on a row keeps its native behaviour", () => {
  const state = buildView();
  state.render(null);

  renderedRows(state.container)[0].fire("click", {
    button: 0,
    ctrlKey: true,
    preventDefault() {
      assert.fail("a modified click must not be cancelled");
    },
  });

  assert.deepEqual(state.selected, []);
});

test("a document link answers to onNavigate", () => {
  const state = buildView();
  state.render("solo");

  const link = renderedLinks(state.container)[0];
  assert.equal(link.textContent, "Index");
  link.fire("click", { button: 0, preventDefault() {} });

  assert.deepEqual(state.navigated, ["index.md"]);
});

test("a malformed entry is skipped instead of thrown", () => {
  const state = buildView({ tags: [null, {}, entry("solo", [])] });
  state.render(null);

  const rows = renderedRows(state.container);
  assert.equal(rows.length, 1, "only the tag a payload really carried");
  assert.deepEqual(
    rows.map(function (row) {
      return row.children[1].textContent;
    }),
    ["0"],
    "a tag with no documents still lists its zero",
  );
});

test("a null container renders nothing", () => {
  const doc = createFakeDocument();
  withGlobals({ document: doc }, function () {
    const view = createTagsPanel({ container: null, tags: [] });
    view.render(null);
  });
});
