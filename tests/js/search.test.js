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

test("a snippet cuts the text around the hit and says what it dropped", () => {
  const text = "one two three four five six seven eight nine ten";
  const snippet = search.matchSnippet(text, "five", { radius: 9 });

  // Both edges stop at a word boundary, and both were trimmed, so the reader
  // sees an ellipsis on either side of the words that were kept.
  assert.equal(snippet.hit, "five");
  assert.equal(snippet.before, "four ");
  assert.equal(snippet.after, " six");
  assert.equal(snippet.trimmedStart, true);
  assert.equal(snippet.trimmedEnd, true);
});

test("a prefix hit is highlighted as the whole word it begins", () => {
  const snippet = search.matchSnippet("read the introduction first", "introd");

  assert.equal(snippet.hit, "introduction");
  assert.equal(snippet.after, " first");
});

test("a hit is only recognised at the start of a word", () => {
  assert.equal(search.matchSnippet("concatenate strings", "cat"), null);
  assert.equal(search.matchSnippet("concat", "cat"), null);
  assert.equal(search.matchSnippet("the cat sat", "cat").hit, "cat");
});

test("a tag name is not a word a query can start in", () => {
  // "<b>bold</b>": the "b" of the tag must not be mistaken for the start of
  // "bold", and "<" and ">" must not be treated as part of a word.
  const snippet = search.matchSnippet("about <b>bold</b> text", "bold");

  assert.equal(snippet.hit, "bold");
  assert.equal(snippet.before, "about <b>");
  assert.equal(snippet.after, "</b> text");
});

test("a snippet of text that fits keeps the ends and marks no trimming", () => {
  const snippet = search.matchSnippet("the setup notes", "setup", { radius: 80 });

  assert.deepEqual(snippet, {
    before: "the ",
    hit: "setup",
    after: " notes",
    trimmedStart: false,
    trimmedEnd: false,
  });
});

test("a snippet finds the hit whatever its case", () => {
  assert.equal(search.matchSnippet("Install the CLI", "cli").hit, "CLI");
  assert.equal(search.matchSnippet("install the cli", "CLI").hit, "cli");
});

test("an exact hit wins over a prefix one", () => {
  // "cats" also begins "cat", which appears earlier; the reader typed "cats",
  // so the word they typed is the one highlighted.
  const snippet = search.matchSnippet("cat and cats", "cats");

  assert.equal(snippet.hit, "cats");
  assert.equal(snippet.before, "cat and ");
});

test("the earliest hit wins among words of equal standing", () => {
  // "one" occurs twice; the first one is the one the snippet starts at, which
  // the "two" that follows it proves.
  const snippet = search.matchSnippet("one two three one", "one", { radius: 6 });

  assert.equal(snippet.before, "");
  assert.equal(snippet.after, " two");
});

test("a snippet finds CJK text by its words", () => {
  const snippet = search.matchSnippet("中文，说明，文档", "说明", { radius: 1 });

  assert.equal(snippet.hit, "说明");
  assert.equal(snippet.before, "，");
});

test("a snippet of text without the query is null", () => {
  assert.equal(search.matchSnippet("nothing here", "zzz"), null);
  assert.equal(search.matchSnippet("", "anything"), null);
  assert.equal(search.matchSnippet(null, "anything"), null);
});

test("contexts keeps the ranked order and pairs each document with its hit", () => {
  const entries = search.contexts(docs, search.search(index, "introduction"), "introduction");

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["a.md", "b.md"],
  );
  assert.equal(entries[0].title, "Introduction");
  assert.equal(entries[0].path, "a.md");
  // `a.md` is matched on its title alone, so it is listed with no context at
  // all rather than with an empty or invented one.
  assert.equal(entries[0].snippet, null);
  assert.equal(entries[1].snippet.before, "install the ");
  assert.equal(entries[1].snippet.hit, "introduction");
});

test("contexts falls back to the outline when the body holds no hit", () => {
  const local = [doc("heading.md", "Other", "unrelated words", [{ text: "Deployment", children: [] }])];
  const entries = search.contexts(local, ["heading.md"], "deployment");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].snippet.hit, "Deployment");
});

test("a document matched only on its title is listed without a snippet", () => {
  const titled = [doc("titled.md", "Setup", "nothing of interest")];
  const entries = search.contexts(titled, ["titled.md"], "setup");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Setup");
  assert.equal(entries[0].snippet, null);
});

test("contexts honours its limit and skips unknown ids", () => {
  const ids = ["a.md", "missing.md", "b.md", "c.md"];

  assert.equal(search.contexts(docs, ids, "the").length, 3);
  assert.equal(search.contexts(docs, ids, "the", { limit: 1 }).length, 1);
  assert.deepEqual(
    search.contexts(docs, ["missing.md"], "the"),
    [],
    "an id the payload does not hold is dropped rather than rendered as a blank row",
  );
});

