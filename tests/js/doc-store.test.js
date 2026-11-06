/**
 * Tests for `src/web/js/doc-store.js`: the documents of a site, fetched on
 * demand when the build split them into files.
 *
 * The store is pure logic over an injected fetcher, so every rule the reader
 * depends on is covered without a DOM: the embedded payload answers
 * synchronously, the split payload fetches `pages/<encoded id>.json` with the
 * manifest's hash as a cache buster, a request already in flight is shared
 * rather than duplicated, a loaded document is cached, and a failure — a
 * missing file, a refused request — answers `null` instead of rejecting.
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as docStore from "../../src/web/js/doc-store.js";

/** The manifest the pages format embeds: references, not documents. */
function manifest() {
  return {
    title: "Fixture",
    mode: "pages",
    docs: [
      { id: "index.md", title: "Index", hash: "hash0" },
      { id: "guide/intro.md", title: "Intro", hash: "hash1" },
    ],
    edges: [],
    stats: { documents: 2, assets: 0, asset_bytes: 0 },
  };
}

/** The chunk the build wrote for one document. */
function chunk(id) {
  return {
    id: id,
    title: "T",
    html: "<p>body of " + id + "</p>",
    toc: [],
    blocks: [],
    text: "body",
  };
}

/** A fetcher over `pages`, recording every URL it was asked for. */
function fetcher(pages) {
  const asked = [];
  return {
    asked,
    fetch(url) {
      asked.push(url);
      const body = Object.hasOwn(pages, url) ? pages[url] : null;
      return Promise.resolve({
        ok: body !== null,
        json() {
          return Promise.resolve(body);
        },
      });
    },
  };
}

test("the embedded payload answers without any request", async () => {
  const fetch_ = fetcher({});
  const store = docStore.createDocStore(
    {
      title: "Fixture",
      docs: [
        {
          id: "index.md",
          title: "Index",
          html: "<p>root</p>",
          toc: [],
          blocks: [],
          text: "root",
        },
      ],
      edges: [],
      stats: { documents: 1, assets: 0, asset_bytes: 0 },
    },
    fetch_.fetch,
  );

  assert.equal(store.isLazy(), false);
  const doc = await store.get("index.md");
  assert.equal(doc.html, "<p>root</p>");
  assert.equal(store.peek("index.md").title, "Index");
  assert.equal(await store.get("missing.md"), null);
  assert.deepEqual(fetch_.asked, [], "an embedded site never fetches");
});

test("a lazy store fetches the chunk at the encoded path with the hash as buster", async () => {
  const fetch_ = fetcher({
    "pages/guide/intro.md.json?v=hash1": chunk("guide/intro.md"),
  });
  const store = docStore.createDocStore(manifest(), fetch_.fetch);

  assert.equal(store.isLazy(), true);
  assert.equal(
    store.peek("guide/intro.md"),
    null,
    "nothing is on hand before the first fetch",
  );

  const doc = await store.get("guide/intro.md");
  assert.equal(doc.html, "<p>body of guide/intro.md</p>");
  assert.deepEqual(fetch_.asked, ["pages/guide/intro.md.json?v=hash1"]);
  assert.equal(
    docStore.chunkPath("中文/说明.md", "hash2"),
    "pages/%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md.json?v=hash2",
    "the path encodes exactly the way the build wrote the file names",
  );
});

test("the manifest's titles answer before any document is fetched", async () => {
  const fetch_ = fetcher({});
  const store = docStore.createDocStore(manifest(), fetch_.fetch);

  assert.equal(store.title("guide/intro.md"), "Intro");
  assert.equal(store.title("index.md"), "Index");
  assert.equal(
    store.title("missing.md"),
    null,
    "a document the manifest does not name has no title",
  );
  assert.deepEqual(
    fetch_.asked,
    [],
    "a title is a manifest read, never a fetch",
  );
});

test("a loaded document is cached and an in-flight request is shared", async () => {
  const fetch_ = fetcher({ "pages/index.md.json?v=hash0": chunk("index.md") });
  const store = docStore.createDocStore(manifest(), fetch_.fetch);

  const first = store.get("index.md");
  const second = store.get("index.md");
  assert.equal(first, second, "one request per document, however many callers");

  await first;
  const again = await store.get("index.md");
  assert.equal(again.html, "<p>body of index.md</p>");
  assert.deepEqual(
    fetch_.asked,
    ["pages/index.md.json?v=hash0"],
    "the second get is answered from the cache",
  );
  assert.equal(store.peek("index.md").id, "index.md");
});

test("a failed request answers null and lets a later attempt retry", async () => {
  let failing = true;
  const asked = [];
  const store = docStore.createDocStore(manifest(), (url) => {
    asked.push(url);
    if (failing) {
      return Promise.reject(new Error("offline"));
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(chunk("index.md")),
    });
  });

  assert.equal(
    await store.get("index.md"),
    null,
    "a failure is an answer, not an exception",
  );

  failing = false;
  const doc = await store.get("index.md");
  assert.equal(
    doc.html,
    "<p>body of index.md</p>",
    "the next attempt may succeed",
  );
  assert.deepEqual(asked, [
    "pages/index.md.json?v=hash0",
    "pages/index.md.json?v=hash0",
  ]);
});

test("a response that is not ok answers null", async () => {
  const store = docStore.createDocStore(manifest(), () =>
    Promise.resolve({ ok: false, status: 404 }),
  );

  assert.equal(await store.get("guide/intro.md"), null);
});

test("a response that carries no document answers null", async () => {
  for (const body of [null, {}, { id: "index.md" }, { html: 42 }]) {
    const store = docStore.createDocStore(manifest(), () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) }),
    );
    assert.equal(
      await store.get("index.md"),
      null,
      `body: ${JSON.stringify(body)}`,
    );
  }
});

test("the corpus is fetched once and answered from the cache", async () => {
  const corpus = {
    docs: [{ id: "index.md", title: "Index", headings: "Index", text: "root" }],
  };
  const fetch_ = fetcher({ "search.json": corpus });
  const store = docStore.createDocStore(manifest(), fetch_.fetch);

  const first = await store.corpus();
  const second = await store.corpus();
  assert.deepEqual(first, corpus.docs);
  assert.equal(first, second, "the corpus is fetched once per page");
  assert.deepEqual(fetch_.asked, ["search.json"]);
});

test("a failed corpus answers null once and is not fetched again", async () => {
  const asked = [];
  const store = docStore.createDocStore(manifest(), (url) => {
    asked.push(url);
    return Promise.reject(new Error("offline"));
  });

  assert.equal(await store.corpus(), null);
  assert.equal(await store.corpus(), null);
  assert.deepEqual(
    asked,
    ["search.json"],
    "the cache-once rule holds for failures too",
  );
});

test("an embedded store answers null for a corpus without fetching", async () => {
  const fetch_ = fetcher({});
  const store = docStore.createDocStore(
    {
      title: "Fixture",
      docs: [],
      edges: [],
      stats: { documents: 0, assets: 0, asset_bytes: 0 },
    },
    fetch_.fetch,
  );

  assert.equal(
    await store.corpus(),
    null,
    "the embedded payload is its own corpus",
  );
  assert.deepEqual(fetch_.asked, []);
});
