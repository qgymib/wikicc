import test from "node:test";
import assert from "node:assert/strict";

import * as router from "../../src/web/js/router.js";

test("parses a document route with a folder and an anchor", () => {
  assert.deepEqual(router.parseHash("#/doc/guide/intro.md#getting-started"), {
    id: "guide/intro.md",
    anchor: "getting-started",
  });
});

test("decodes percent-encoded ids and anchors", () => {
  assert.deepEqual(
    router.parseHash("#/doc/%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md#%E6%AD%A3%E6%96%87"),
    { id: "中文/说明.md", anchor: "正文" },
  );
});

test("ignores hashes that are not document routes", () => {
  for (const hash of ["", "#", "#section", "#/other/x", "#/doc/", "#/docs/a.md"]) {
    assert.deepEqual(router.parseHash(hash), { id: null, anchor: null }, `hash: ${hash}`);
  }
});

test("keeps malformed percent-encoding verbatim", () => {
  assert.deepEqual(router.parseHash("#/doc/%E4.md"), { id: "%E4.md", anchor: null });
});

test("formats a route without an anchor", () => {
  assert.equal(router.formatHash("guide/intro.md"), "#/doc/guide/intro.md");
});

test("encodes every id segment but keeps the folder separators", () => {
  assert.equal(
    router.formatHash("中文/说明.md"),
    "#/doc/%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md",
  );
  assert.equal(router.encodeId("a b/c#d.md"), "a%20b/c%23d.md");
});

test("encodes anchors, including spaces", () => {
  assert.equal(router.formatHash("a.md", "第 1 节"), "#/doc/a.md#%E7%AC%AC%201%20%E8%8A%82");
  assert.equal(router.formatHash("a.md", "#already"), "#/doc/a.md#already");
});

test("format and parse round-trip an id and an anchor", () => {
  const hash = router.formatHash("中文/说明.md", "第 1 节");

  assert.deepEqual(router.parseHash(hash), { id: "中文/说明.md", anchor: "第 1 节" });
});

test("resolves a known document and keeps its anchor", () => {
  assert.deepEqual(router.resolveRoute("#/doc/b.md#part", ["a.md", "b.md"]), {
    id: "b.md",
    anchor: "part",
    known: true,
  });
});

test("falls back to the first document for unknown ids", () => {
  assert.deepEqual(router.resolveRoute("#/doc/gone.md#part", ["a.md", "b.md"]), {
    id: "a.md",
    anchor: null,
    known: false,
  });
});

test("falls back to the first document for an empty hash", () => {
  assert.deepEqual(router.resolveRoute("", ["a.md", "b.md"]), {
    id: "a.md",
    anchor: null,
    known: false,
  });
});

test("resolves to nothing when the site has no documents", () => {
  assert.deepEqual(router.resolveRoute("#/doc/a.md", []), { id: null, anchor: null, known: false });
});
