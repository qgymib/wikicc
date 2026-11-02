/**
 * Tests for `src/web/js/preview.js`: what a block reference previews.
 *
 * The rules under test are the product promise: a reference shows the chapter
 * it names and every chapter nested below it, and never a sibling or an
 * ancestor.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_SLUG,
  buildPreviewHtml,
  collectPreview,
  createPreview,
  previewTitle,
  resolveAnchor,
  slugify,
} from "../../src/web/js/preview.js";

/**
 * A document whose outline is
 *
 *     A            (h1)
 *       A1         (h2)
 *         A1a      (h3)
 *         A1b      (h3)
 *       A2         (h2)
 *     B            (h1)
 *       B1         (h2)
 *
 * The blocks carry the same nesting the build records: `parent` names the
 * enclosing block and `subtree` lists the block and everything under it.
 */
function doc() {
  var blocks = [
    { id: "a", level: 1, parent: null, subtree: [0, 1, 2, 3, 4] },
    { id: "a1", level: 2, parent: 0, subtree: [1, 2, 3] },
    { id: "a1a", level: 3, parent: 1, subtree: [2] },
    { id: "a1b", level: 3, parent: 1, subtree: [3] },
    { id: "a2", level: 2, parent: 0, subtree: [4] },
    { id: "b", level: 1, parent: null, subtree: [5, 6] },
    { id: "b1", level: 2, parent: 5, subtree: [6] },
  ].map(function (block) {
    block.html = "<p>" + block.id + "</p>";
    return block;
  });

  return {
    id: "guide/intro.md",
    path: "guide/intro.md",
    toc: [
      {
        id: "a",
        text: "A",
        level: 1,
        children: [
          {
            id: "a1",
            text: "A1",
            level: 2,
            children: [
              { id: "a1a", text: "A1a", level: 3, children: [] },
              { id: "a1b", text: "A1b", level: 3, children: [] },
            ],
          },
          { id: "a2", text: "A2", level: 2, children: [] },
        ],
      },
      {
        id: "b",
        text: "B",
        level: 1,
        children: [{ id: "b1", text: "B1", level: 2, children: [] }],
      },
    ],
    blocks: blocks,
  };
}

test("a chapter previews itself and everything below it", () => {
  assert.deepEqual(collectPreview(doc(), "a1"), [1, 2, 3], "A1, A1a, A1b");
  assert.deepEqual(collectPreview(doc(), "a"), [0, 1, 2, 3, 4], "all of A");
  assert.deepEqual(collectPreview(doc(), "a1a"), [2], "a leaf is only itself");
});

test("sibling chapters are excluded", () => {
  const preview = collectPreview(doc(), "a1");

  assert.equal(preview.includes(4), false, "a2 is a sibling of the chapter");
  assert.equal(preview.includes(0), false, "the parent");
  assert.equal(preview.includes(5), false, "a later root");
  assert.equal(preview.includes(6), false, "a chapter of another root");
});

test("the preview reads the block's own subtree instead of walking the outline", () => {
  const source = doc();
  // An outline with no children at all: a preview built from `toc` would show
  // the chapter alone, while the block says the chapter contains more.
  source.toc = [{ id: "a", text: "A", level: 1, children: [] }];

  assert.deepEqual(collectPreview(source, "a"), [0, 1, 2, 3, 4]);
  assert.equal(
    buildPreviewHtml(source, "a"),
    "<p>a</p><p>a1</p><p>a1a</p><p>a1b</p><p>a2</p>",
  );
});

test("a chapter whose anchor names a block the payload does not have has no preview", () => {
  const source = doc();
  source.blocks = source.blocks.slice(0, 3);

  assert.deepEqual(collectPreview(source, "a2"), []);
  assert.equal(buildPreviewHtml(source, "a2"), null);
});

test("the joined html follows document order and keeps every section", () => {
  assert.equal(
    buildPreviewHtml(doc(), "a1"),
    "<p>a1</p><p>a1a</p><p>a1b</p>",
  );
  assert.equal(
    buildPreviewHtml(doc(), "a"),
    "<p>a</p><p>a1</p><p>a1a</p><p>a1b</p><p>a2</p>",
  );
  assert.equal(buildPreviewHtml(doc(), "b"), "<p>b</p><p>b1</p>");
});

test("an unknown chapter has no preview", () => {
  assert.equal(collectPreview(doc(), "nope").length, 0);
  assert.equal(buildPreviewHtml(doc(), "nope"), null);
  assert.equal(resolveAnchor(doc().toc, "nope"), null);
  assert.equal(createPreview(doc(), "nope"), null);
});

test("a chapter is found through its own spelling of the heading", () => {
  const source = {
    id: "a.md",
    toc: [
      { id: "getting-started", text: "Getting Started", level: 2, children: [] },
    ],
    blocks: [
      {
        id: "getting-started",
        level: 2,
        parent: null,
        html: "<p>body</p>",
        subtree: [0],
      },
    ],
  };

  assert.equal(resolveAnchor(source.toc, "Getting Started").id, "getting-started");
  assert.equal(buildPreviewHtml(source, "Getting Started"), "<p>body</p>");
});

test("CJK anchors resolve exactly and through their slug", () => {
  const source = {
    id: "中文.md",
    toc: [
      { id: "第一章", text: "第一章", level: 1, children: [] },
      { id: "第二章-概述", text: "第二章 概述", level: 1, children: [] },
    ],
    blocks: [
      {
        id: "第一章",
        level: 1,
        parent: null,
        html: "<h1>第一章</h1>",
        subtree: [0],
      },
      {
        id: "第二章-概述",
        level: 1,
        parent: null,
        html: "<h1>第二章 概述</h1>",
        subtree: [1],
      },
    ],
  };

  assert.deepEqual(collectPreview(source, "第一章"), [0]);
  assert.deepEqual(collectPreview(source, "第二章 概述"), [1]);
  assert.equal(previewTitle(source, "第二章-概述"), "第二章 概述");
  assert.equal(previewTitle(source, "第二章"), "第二章");
});

test("a document without an outline or blocks degrades to nothing", () => {
  assert.equal(buildPreviewHtml({ id: "a.md" }, "a"), null);
  assert.equal(buildPreviewHtml({ id: "a.md", toc: [] }, "a"), null);
  assert.equal(buildPreviewHtml({ id: "a.md", blocks: [] , toc: doc().toc }, "a"), null);
  assert.equal(createPreview(null, "a"), null);
  assert.equal(createPreview(doc(), ""), null);
});

test("a truncated subtree yields no preview rather than half a chapter", () => {
  const source = doc();
  // The subtree still names blocks 2 and 3, but the payload stops at 1: the
  // preview must refuse instead of silently showing only the first block.
  source.blocks = source.blocks.slice(0, 2);

  assert.equal(buildPreviewHtml(source, "a1"), null);
});

test("a block without markup yields no preview rather than an empty one", () => {
  const source = doc();
  delete source.blocks[2].html;

  assert.equal(buildPreviewHtml(source, "a1a"), null);
});

test("a subtree is read without mutating the payload", () => {
  const source = doc();
  const before = source.blocks[0].subtree.slice();

  collectPreview(source, "a").push(99);

  assert.deepEqual(
    source.blocks[0].subtree,
    before,
    "a caller cannot corrupt the payload through the returned list",
  );
});

test("the preview carries the chapter title and the document path", () => {
  assert.deepEqual(createPreview(doc(), "a1"), {
    html: "<p>a1</p><p>a1a</p><p>a1b</p>",
    title: "A1",
    path: "guide/intro.md",
  });
});

test("previewTitle falls back to the anchor for an unknown chapter", () => {
  assert.equal(previewTitle(doc(), "nope"), "nope");
  assert.equal(previewTitle(doc(), null), "");
});

test("slugify mirrors the build's rules", () => {
  assert.equal(slugify("Getting Started"), "getting-started");
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("C++ / C# & Rust"), "c-c-rust");
  assert.equal(slugify("Node.js in 2024"), "nodejs-in-2024");
  assert.equal(slugify("a--b"), "a-b");
  assert.equal(slugify("-leading"), "leading");
  assert.equal(slugify("trailing---"), "trailing");
  assert.equal(slugify("snake_case"), "snake_case");
  assert.equal(slugify("第一章 概述"), "第一章-概述");
  assert.equal(slugify("ÜBERSICHT"), "übersicht");
  assert.equal(slugify("!!!"), FALLBACK_SLUG);
  assert.equal(slugify(""), FALLBACK_SLUG);
});
