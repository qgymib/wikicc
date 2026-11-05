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

test("tokenizes CJK text into characters and pairs instead of one blob", () => {
  const cjk = search.tokenize("中文，说明，文档");

  assert.ok(cjk.includes("中文"), `tokens: ${cjk.join("/")}`);
  assert.ok(cjk.includes("说明"), `tokens: ${cjk.join("/")}`);
  assert.ok(
    cjk.every((token) => Array.from(token).length <= 2),
    `tokens: ${cjk.join("/")}`,
  );
  assert.ok(search.tokenize("中文说明文档正文").includes("中文"));
  assert.deepEqual(search.tokenize("Install the CLI"), [
    "Install",
    "the",
    "CLI",
  ]);
  assert.deepEqual(search.tokenize(""), []);
});

test("flattens a nested outline into one searchable string", () => {
  assert.equal(
    search.headingsText([
      {
        text: "One",
        children: [{ text: "Two", children: [{ text: "Three" }] }],
      },
    ]),
    "One Two Three",
  );
  assert.equal(search.headingsText([]), "");
  assert.equal(search.headingsText(null), "");
});

test("the heading text of a corpus record is the pre-flattened field", () => {
  assert.equal(search.headingsOf({ headings: "One Two" }), "One Two");
  assert.equal(
    search.headingsOf({
      toc: [{ text: "One", children: [{ text: "Two", children: [] }] }],
    }),
    "One Two",
    "a document of the embedded payload is flattened from its outline",
  );
  assert.equal(search.headingsOf(null), "");
  assert.equal(search.headingsOf({}), "");
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
  const heading = doc("heading.md", "Other", "unrelated", [
    { text: "Deployment", children: [] },
  ]);
  const body = doc("body.md", "Another", "deployment notes");
  const local = search.createSearch([body, heading]);

  assert.deepEqual(search.search(local, "deployment"), [
    "heading.md",
    "body.md",
  ]);
});

test("finds CJK words inside body text", () => {
  assert.deepEqual(search.search(index, "说明"), ["c.md"]);
});

test("returns nothing for an unknown term", () => {
  assert.deepEqual(search.search(index, "nonexistent"), []);
});

test("repeated queries are deterministic", () => {
  assert.deepEqual(
    search.search(index, "introduction"),
    search.search(index, "introduction"),
  );
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
  const snippet = search.matchSnippet("the setup notes", "setup", {
    radius: 80,
  });

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
  const snippet = search.matchSnippet("one two three one", "one", {
    radius: 6,
  });

  assert.equal(snippet.before, "");
  assert.equal(snippet.after, " two");
});

test("a snippet finds CJK text by its words", () => {
  const snippet = search.matchSnippet("中文，说明，文档", "说明", {
    radius: 1,
  });

  assert.equal(snippet.hit, "说明");
  assert.equal(snippet.before, "，");
});

test("a snippet of text without the query is null", () => {
  assert.equal(search.matchSnippet("nothing here", "zzz"), null);
  assert.equal(search.matchSnippet("", "anything"), null);
  assert.equal(search.matchSnippet(null, "anything"), null);
});

test("the default window fills one row and keeps the hit in sight", () => {
  // The result row caps its context at one line, and a one-line cut reads the
  // text from its start — so the default window spans about one line of the
  // widest panel, most of it spent on the tail, with the highlighted word
  // left near the head where the cut can never take it away.
  const latin = [];
  for (let i = 0; i < 120; i += 1) {
    latin.push(`w${String(i).padStart(3, "0")}`);
  }
  const words = latin.join(" ");
  const snippet = search.matchSnippet(`${words} needle ${words}`, "needle");

  assert.equal(snippet.hit, "needle");
  assert.ok(snippet.before.length > 0, "some lead-in survives");
  assert.ok(snippet.before.length <= 20, "the lead-in stays short");
  assert.ok(snippet.after.length >= 90, "the tail fills the line");
  assert.equal(snippet.trimmedStart, true);
  assert.equal(snippet.trimmedEnd, true);
});

test("the default window keeps whole lines of CJK around the hit", () => {
  // Han text has no spaces, so the boundary logic leaves the window exactly
  // as cut: the lead and the tail are what the widest row line holds.
  const lead = "前".repeat(60);
  const tail = "后".repeat(160);
  const snippet = search.matchSnippet(`${lead}探针${tail}`, "探针");

  assert.equal(snippet.before, lead.slice(-20));
  assert.equal(snippet.after, tail.slice(0, 100));
});

test("one side of the window can be widened without the other", () => {
  const snippet = search.matchSnippet(
    "前前前前前前前前中中后后后后后后后后",
    "中中",
    {
      lead: 3,
      tail: 5,
    },
  );

  assert.equal(snippet.before, "前前前");
  assert.equal(snippet.after, "后后后后后");
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
  assert.deepEqual(search.matchRanges("concatenate the cat", "cat"), [
    { start: 16, length: 3 },
  ]);
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
  assert.deepEqual(
    search.matchRanges("install the tool, then install", "install tool"),
    [
      { start: 0, length: 7 },
      { start: 12, length: 4 },
      { start: 23, length: 7 },
    ],
  );
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
    assert.ok(
      range.start + range.length <= text.length,
      "a range stays inside the text",
    );
    if (index > 0) {
      const previous = ranges[index - 1];
      assert.ok(
        previous.start + previous.length <= range.start,
        `range ${index} overlaps the one before it`,
      );
    }
  });
});

test("occurrences pairs every ranked document with its first place", () => {
  const entries = search.occurrences(
    docs,
    search.search(index, "introduction"),
    "introduction",
  );

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["a.md", "b.md"],
  );
  assert.equal(entries[0].title, "Introduction");
  assert.equal(entries[0].path, "a.md");
  // `a.md` is matched on its title alone, so it is listed once with no body
  // occurrence to scroll to and no context at all rather than an invented one.
  assert.equal(entries[0].hit, -1);
  assert.equal(entries[0].snippet, null);
  assert.equal(entries[1].hit, 0);
  assert.equal(entries[1].snippet.before, "install the ");
  assert.equal(entries[1].snippet.hit, "introduction");
});

test("every occurrence of a document becomes its own entry", () => {
  const local = [doc("one.md", "Ones", "one two one three one")];
  const entries = search.occurrences(local, ["one.md"], "one");

  assert.equal(
    entries.length,
    3,
    "three places, three entries — none merged or dropped",
  );
  assert.deepEqual(
    entries.map((entry) => entry.hit),
    [0, 1, 2],
  );
  assert.equal(entries[0].snippet.hit, "one");
  assert.equal(entries[1].snippet.before, "one two ");
  assert.equal(entries[2].snippet.after, "");
});

test("a document's occurrences stay together in the order the ids arrive", () => {
  const multi = [
    doc("first.md", "First", "intro once"),
    doc("second.md", "Second", "intro twice, intro again"),
  ];
  const entries = search.occurrences(multi, ["second.md", "first.md"], "intro");

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["second.md", "second.md", "first.md"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.hit),
    [0, 1, 0],
  );
});

test("a prefix query widens each occurrence to the word it begins", () => {
  const local = [doc("intro.md", "Intro", "introduction and intro")];
  const entries = search.occurrences(local, ["intro.md"], "introd");

  assert.equal(
    entries.length,
    1,
    "the tail of a longer word is not a hit of its own",
  );
  assert.equal(entries[0].snippet.hit, "introduction");
});

test("a word hidden inside a longer one is not an occurrence", () => {
  const local = [doc("cat.md", "Cat", "concatenate the cat")];
  const entries = search.occurrences(local, ["cat.md"], "cat");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].snippet.hit, "cat");
});

test("CJK occurrences are found by word", () => {
  const local = [doc("cjk.md", "Notes", "中文，说明，文档，说明")];
  const entries = search.occurrences(local, ["cjk.md"], "说明");

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.hit),
    [0, 1],
  );
  assert.equal(entries[0].snippet.hit, "说明");
  assert.equal(entries[1].snippet.hit, "说明");
});

test("occurrences falls back to the outline when the body holds no hit", () => {
  const local = [
    doc("heading.md", "Other", "unrelated words", [
      { text: "Deployment", children: [] },
    ]),
  ];
  const entries = search.occurrences(local, ["heading.md"], "deployment");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].hit, -1);
  assert.equal(entries[0].snippet.hit, "Deployment");
});

test("a document matched only on its title is listed without a snippet", () => {
  const titled = [doc("titled.md", "Setup", "nothing of interest")];
  const entries = search.occurrences(titled, ["titled.md"], "setup");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Setup");
  assert.equal(entries[0].hit, -1);
  assert.equal(entries[0].snippet, null);
});

test("an id the payload does not hold is dropped rather than rendered as a blank row", () => {
  assert.deepEqual(search.occurrences(docs, ["missing.md"], "the"), []);
  assert.equal(
    search.occurrences(docs, ["a.md", "missing.md", "b.md"], "the").length,
    2,
  );
});

test("occurrences read the corpus records the pages format ships", () => {
  // The records of `search.json` carry the same fields the embedded payload
  // does, except that the outline arrives pre-flattened under `headings`.
  const records = [
    { id: "a.md", title: "A", headings: "Getting Started", text: "plain body" },
    {
      id: "b.md",
      title: "B",
      headings: "Other",
      text: "started here and started again",
    },
  ];

  const entries = search.occurrences(records, ["b.md", "a.md"], "started");

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["b.md", "b.md", "a.md"],
    "the ranking is the engine's, the hits of one document together",
  );
  assert.deepEqual(
    entries.slice(0, 2).map((entry) => entry.hit),
    [0, 1],
    "the body hits of the record are enumerated in order",
  );
  assert.equal(entries[2].hit, -1, "the record matched on its headings only");
  assert.equal(
    entries[2].snippet.hit,
    "Started",
    "the outline context is cut from the flattened headings, not from a structure the record does not carry",
  );
});

/* ---------- CJK phrase accuracy ----------
 *
 * A multi-character CJK query has to match consecutive text only. The query
 * "镜轮" (a combination no dictionary segments as one word) must not match a
 * text that merely holds "镜" or "轮" somewhere apart — the regression behind
 * results like a lone "头" highlighted inside an unrelated word.
 */

const cjkDocs = [
  doc("phrase.md", "Alignment", "镜轮对准基准"),
  doc("apart.md", "Scatter", "镜面映轮"),
  doc("wheel.md", "Axle", "轮轴锈蚀"),
  doc("mirror.md", "Surface", "镜面抛光"),
];

test("indexes adjacent CJK characters as a bigram", () => {
  const tokens = search.tokenize("镜轮");

  assert.ok(tokens.includes("镜轮"), `tokens: ${tokens.join("/")}`);
});

test("a two-character CJK query matches only consecutive occurrences", () => {
  const local = search.createSearch(cjkDocs);

  assert.deepEqual(search.search(local, "镜轮"), ["phrase.md"]);
});

test("a single CJK character still matches any text holding it", () => {
  const local = search.createSearch(cjkDocs);

  assert.deepEqual(
    new Set(search.search(local, "镜")),
    new Set(["phrase.md", "apart.md", "mirror.md"]),
  );
  assert.deepEqual(
    new Set(search.search(local, "轮")),
    new Set(["phrase.md", "apart.md", "wheel.md"]),
  );
});

test("CJK highlighting only covers the consecutive phrase", () => {
  assert.deepEqual(search.matchRanges("轮轴磨损，镜轮松动", "镜轮"), [
    { start: 5, length: 2 },
  ]);
});

test("a document holding only single characters does not become an occurrence", () => {
  const local = search.createSearch(cjkDocs);
  const ids = search.search(local, "镜轮");
  const entries = search.occurrences(cjkDocs, ids, "镜轮");

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["phrase.md"],
  );
  assert.equal(entries[0].snippet.hit, "镜轮");
});

test("a snippet shows the consecutive phrase, not a lone character", () => {
  const snippet = search.matchSnippet("镜面与镜轮", "镜轮");

  assert.equal(snippet.hit, "镜轮");
});
