/**
 * Tests for `src/web/js/anchor.js`: which chapter a route anchor addresses.
 *
 * The promise under test is the one the README makes about block references: a
 * reference shows the chapter it names. Navigation has to agree with the hover
 * preview, so both the anchor the build wrote (a slug) and the spelling an
 * author used (`#1.4 配色与字体`) resolve to the same chapter.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { collectPreview } from "../../src/web/js/preview.js";
import { resolveDocAnchor, resolveEntry } from "../../src/web/js/anchor.js";

/** A document whose heading `1.4 配色与字体` slugs to `14-配色与字体`. */
function doc() {
  return withBlocks({
    id: "笔记/旅行清单.md",
    toc: [
      {
        id: "1-出行准备",
        text: "1. 出行准备",
        level: 2,
        children: [
          {
            id: "14-配色与字体",
            text: "1.4 配色与字体",
            level: 3,
            children: [],
          },
        ],
      },
      { id: "getting-started", text: "Getting Started", level: 2, children: [] },
      { id: "第一章", text: "第一章", level: 2, children: [] },
    ],
  });
}

/**
 * Give `source` one block per outline entry, as the build does.
 *
 * The preview resolves a chapter through its block, so a fixture without
 * blocks would only exercise the "no preview" path.
 */
function withBlocks(source) {
  const flat = [];
  (function walk(entries, parent) {
    entries.forEach(function (entry) {
      flat.push({ entry: entry, parent: parent });
      walk(entry.children || [], flat.length - 1);
    });
  })(source.toc, null);

  const blocks = flat.map(function (item, index) {
    return {
      id: item.entry.id,
      level: item.entry.level,
      parent: item.parent,
      html: "<p>" + item.entry.id + "</p>",
      subtree: [index],
    };
  });

  // Every open ancestor contains the block, exactly as the build fills it in.
  blocks.forEach(function (block, index) {
    for (let ancestor = block.parent; ancestor !== null; ancestor = blocks[ancestor].parent) {
      blocks[ancestor].subtree.push(index);
    }
  });

  source.blocks = blocks;
  return source;
}

test("the anchor the build writes resolves to its own chapter", () => {
  assert.equal(resolveEntry(doc(), "14-配色与字体").id, "14-配色与字体");
});

test("the author's spelling of a numbered heading resolves to its slug", () => {
  const entry = resolveEntry(doc(), "1.4 配色与字体");

  assert.ok(entry, "the chapter must be found");
  assert.equal(entry.id, "14-配色与字体");
});

test("a heading's text resolves to the slug the reader emits", () => {
  assert.equal(resolveEntry(doc(), "Getting Started").id, "getting-started");
});

test("a CJK anchor resolves exactly and through its slug", () => {
  assert.equal(resolveEntry(doc(), "第一章").id, "第一章");
  assert.equal(resolveEntry(doc(), "第二章"), null, "only real chapters resolve");
});

test("an unknown chapter resolves to nothing", () => {
  for (const anchor of ["nope", "", null, undefined]) {
    assert.equal(resolveEntry(doc(), anchor), null, `anchor: ${String(anchor)}`);
  }
  assert.equal(resolveEntry(null, "a"), null);
  assert.equal(resolveEntry({ id: "a.md" }, "a"), null);
});

test("navigation and the hover preview agree on the chapter", () => {
  const source = doc();

  for (const anchor of ["1.4 配色与字体", "14-配色与字体"]) {
    const indices = collectPreview(source, anchor);

    assert.equal(indices.length, 1, `anchor: ${anchor}`);
    assert.equal(
      resolveEntry(source, anchor).id,
      source.blocks[indices[0]].id,
      `anchor: ${anchor}`,
    );
  }
});

test("a resolved anchor carries the element and the outline entry", () => {
  const element = { id: "14-配色与字体" };
  const found = resolveDocAnchor(doc(), "1.4 配色与字体", function (id) {
    return id === element.id ? element : null;
  });

  assert.deepEqual(found, { entry: doc().toc[0].children[0], element, anchor: element.id });
});

test("an element without an outline entry still anchors the document", () => {
  const element = { id: "raw-html-heading" };
  const found = resolveDocAnchor(
    { id: "a.md", toc: [] },
    "raw-html-heading",
    function () {
      return element;
    },
  );

  assert.deepEqual(found, { entry: null, element, anchor: "raw-html-heading" });
});

test("a missing chapter resolves to nothing even when the lookup is generous", () => {
  assert.equal(
    resolveDocAnchor(doc(), "no-such-chapter", function () {
      return null;
    }),
    null,
  );
});

test("candidate anchors are tried from most to least literal", () => {
  const tried = [];
  resolveDocAnchor(doc(), "1.4 配色与字体", function (id) {
    tried.push(id);
    return null;
  });

  assert.deepEqual(tried, ["1.4 配色与字体", "14-配色与字体"]);
});
