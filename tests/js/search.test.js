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

test("every hit of a word is found, in order", () => {
  const ranges = search.matchRanges("one two one three one", "one");

  assert.deepEqual(ranges, [
    { start: 0, length: 3 },
    { start: 8, length: 3 },
    { start: 18, length: 3 },
  ]);
});

test("a hit is only recognised at the start of a word", () => {
  assert.deepEqual(search.matchRanges("concatenate the cat", "cat"), [{ start: 16, length: 3 }]);
});

test("a prefix hit covers the whole word it begins", () => {
  // "introd" prefixes "introduction" but not "intro", which is the other way
  // round — so only the longer word is highlighted here.
  assert.deepEqual(search.matchRanges("introduction and intro", "introd"), [
    { start: 0, length: 12 },
  ]);
  // "intro" is a prefix of "introduction" rather than the other way round, so
  // only the word that really is "intro" is highlighted — until the widening
  // pass runs, which a complete word always satisfies first.
  assert.deepEqual(search.matchRanges("introduction and intro", "intro"), [
    { start: 17, length: 5 },
  ]);
  assert.deepEqual(search.matchRanges("intro and introduction", "intro"), [
    { start: 0, length: 5 },
    { start: 10, length: 12 },
  ]);
});

test("a word hidden behind an earlier hit is never highlighted", () => {
  // "intro" sits inside "introduction" at offset 0, but not at a word start:
  // walking on from the end of "introduction" would cut the text right at the
  // "o" and make the rest of the word look like a word of its own.
  assert.deepEqual(search.matchRanges("intro intro", "intro"), [
    { start: 0, length: 5 },
    { start: 6, length: 5 },
  ]);
  assert.deepEqual(
    search.matchRanges("catalogue and cat", "cat"),
    [{ start: 14, length: 3 }],
    "the tail of a longer word is not a hit",
  );
});

test("hits ignore case", () => {
  assert.deepEqual(search.matchRanges("Install the CLI and cli", "cli"), [
    { start: 12, length: 3 },
    { start: 20, length: 3 },
  ]);
});

test("every word of a multi-word query is highlighted", () => {
  assert.deepEqual(search.matchRanges("install the tool, then install", "install tool"), [
    { start: 0, length: 7 },
    { start: 12, length: 4 },
    { start: 23, length: 7 },
  ]);
});

test("overlapping hits merge instead of nesting", () => {
  // "cata" and "catalogue" both begin the same word: one range covers it,
  // whatever order the words arrive in.
  const ranges = search.matchRanges("catalogue cata", "cata catalogue");

  assert.deepEqual(ranges, [
    { start: 0, length: 9 },
    { start: 10, length: 4 },
  ]);
  assert.ok(
    ranges.every((range) => range.length > 0),
    "a merged range never collapses to nothing",
  );
});

test("CJK text is highlighted by word", () => {
  assert.deepEqual(search.matchRanges("中文，说明，文档，说明", "说明"), [
    { start: 3, length: 2 },
    { start: 9, length: 2 },
  ]);
});

test("a text without the query has no ranges", () => {
  assert.deepEqual(search.matchRanges("nothing here", "zzz"), []);
  assert.deepEqual(search.matchRanges("", "anything"), []);
  assert.deepEqual(search.matchRanges(null, "anything"), []);
  assert.deepEqual(search.matchRanges("some text", ""), []);
  assert.deepEqual(search.matchRanges("some text", "   "), []);
});

test("ranges never overlap and stay inside the text", () => {
  const text = "cat catalogue concat cat";
  const ranges = search.matchRanges(text, "cat cata");

  ranges.forEach((range, index) => {
    assert.ok(range.start >= 0 && range.length > 0);
    assert.ok(range.start + range.length <= text.length, "a range stays inside the text");
    if (index > 0) {
      const previous = ranges[index - 1];
      assert.ok(
        previous.start + previous.length <= range.start,
        `range ${index} overlaps the one before it`,
      );
    }
  });
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

