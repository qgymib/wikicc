import test from "node:test";
import assert from "node:assert/strict";

import * as search from "../../src/web/js/search.js";

function doc(id, title, text, toc) {
  return { id, title, text, toc: toc || [] };
}

const docs = [
  doc("a.md", "Introduction", "welcome to the guide", [
    { text: "Getting started", children: [{ text: "Details", children: [] }] },
  ]),
  doc("b.md", "Setup", "install the introduction tool"),
  doc("c.md", "Notes", "中文，说明，文档"),
];

const index = search.createSearch(docs);

test("tokenizes CJK text into words instead of one blob", () => {
  const cjk = search.tokenize("中文，说明，文档");

  assert.deepEqual(cjk.slice(0, 2), ["中文", "说明"]);
  assert.ok(cjk.length >= 3, `tokens: ${cjk.join("/")}`);
  assert.ok(search.tokenize("中文说明文档正文").length > 1);
  assert.deepEqual(search.tokenize("Install the CLI"), ["Install", "the", "CLI"]);
  assert.deepEqual(search.tokenize(""), []);
});

test("flattens a nested outline into one searchable string", () => {
  assert.equal(
    search.headingsText([{ text: "One", children: [{ text: "Two", children: [{ text: "Three" }] }] }]),
    "One Two Three",
  );
  assert.equal(search.headingsText([]), "");
  assert.equal(search.headingsText(null), "");
});

test("an empty query means no filter", () => {
  assert.equal(search.search(index, ""), null);
  assert.equal(search.search(index, "   "), null);
  assert.equal(search.search(index, null), null);
});

test("matches case-insensitively", () => {
  assert.deepEqual(search.search(index, "SETUP"), ["b.md"]);
});

test("matches prefixes", () => {
  assert.deepEqual(search.search(index, "introd"), ["a.md", "b.md"]);
});

test("requires every word of a multi-word query", () => {
  assert.deepEqual(search.search(index, "introduction tool"), ["b.md"]);
  assert.deepEqual(search.search(index, "introduction missing"), []);
});

test("ranks a title hit above a body hit", () => {
  const body = doc("body.md", "Other", "setup notes");
  const titled = doc("titled.md", "Setup", "nothing here");
  const local = search.createSearch([body, titled]);

  assert.deepEqual(search.search(local, "setup"), ["titled.md", "body.md"]);
});

test("ranks a heading hit above a body hit", () => {
  const heading = doc("heading.md", "Other", "unrelated", [{ text: "Deployment", children: [] }]);
  const body = doc("body.md", "Another", "deployment notes");
  const local = search.createSearch([body, heading]);

  assert.deepEqual(search.search(local, "deployment"), ["heading.md", "body.md"]);
});

test("finds CJK words inside body text", () => {
  assert.deepEqual(search.search(index, "说明"), ["c.md"]);
});

test("returns nothing for an unknown term", () => {
  assert.deepEqual(search.search(index, "nonexistent"), []);
});

test("repeated queries are deterministic", () => {
  assert.deepEqual(search.search(index, "introduction"), search.search(index, "introduction"));
});
