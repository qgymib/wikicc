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

/* ---------- encrypted documents ---------- */

/**
 * The blob the committed interop vector sealed `guide/intro.md` with — the
 * very same constants `tests/js/lock.test.js` pins, which `src/crypto.rs`
 * generated and keeps honest on the build side.
 */
const SEALED_BLOB = {
  v: 1,
  kdf: "pbkdf2-sha256",
  iters: 600000,
  salt: "EBESExQVFhcYGRobHB0eHw==",
  nonce: "sLGys7S1tre4ubq7",
  ct: "FdagYCNSGn2CfXUj43AcxGe/uvxMLy0VH4U/18evqxKAIAcqJPR1NabxtlrnYoUnGJefjCc/TROQPdMXpo/eVe5UoWQ7K26y9P+/pSWha4gzM5bA+GF8xRSXnA1x4auaYpG4OMQJZm3cZ3+bfWV+G7/p9Yc2s0shQb16Amq8yeJMwos8Uj/uIfxkjTS1FH9PshBkceKsQ46A73b2wvGyLcjJekcz2Pi7gndVRJVs73pszogDQk8iQbiSz/ISVb/wV8r0cQH8vlfHQFqyLtLFRfZSGeB8vEKGrQlAj00EiMWkx9NnhwzwqrnvuHy4GFte0fJhmUieET7Jnvkm3wjEFi0Y/F9HaI+IbzUv7gxDhYbNVrKBRp/ji2OPb+NVUMN4vXgNPBpb/mnrWRFD4Gc9EGZxGX1ULQ==",
};

/** The interop vector sealed `guide/other.md` with, under the same password. */
const OTHER_BLOB = {
  v: 1,
  kdf: "pbkdf2-sha256",
  iters: 600000,
  salt: "ICEiIyQlJicoKSorLC0uLw==",
  nonce: "wMHCw8TFxsfIycrL",
  ct: "OH0yPKUuQm3nBjfjjxk27eenmLO5yntFrYoZc2X508M0aVGiD7n5djyHsLg4ozn8WpYOduZNxGruKOS6/E239D+h7zKJkC8oDlDIRaOuceMC0FJrfdI/GLc5K5axNHdGJnkiXH7SRg==",
};

const SEALED_ID = "guide/intro.md";
const OTHER_ID = "guide/other.md";
const SEALED_PASSWORD = "密码 secret";
const SEALED_BODY = {
  html: '<h2 id="getting-started">Getting Started</h2><p>intro body</p>',
  toc: [
    {
      id: "getting-started",
      text: "Getting Started",
      level: 2,
      children: [],
    },
  ],
  blocks: [
    {
      id: "getting-started",
      level: 2,
      parent: null,
      html: "<p>intro body</p>",
      subtree: [0],
    },
  ],
  text: "getting started intro body",
};
const OTHER_BODY = {
  html: "<p>另一篇 已密封</p>",
  toc: [],
  blocks: [],
  text: "另一篇 已密封",
};

/** The embedded payload with two sealed documents beside a public one. */
function sealedDocs() {
  return [
    {
      id: "index.md",
      title: "Index",
      path: "index.md",
      html: "<p>root</p>",
      toc: [],
      blocks: [],
      text: "root",
    },
    {
      id: SEALED_ID,
      title: "Intro",
      path: SEALED_ID,
      html: "",
      toc: [],
      blocks: [],
      text: "",
      enc: SEALED_BLOB,
    },
    {
      id: OTHER_ID,
      title: "Other",
      path: OTHER_ID,
      html: "",
      toc: [],
      blocks: [],
      text: "",
      enc: OTHER_BLOB,
    },
  ];
}

function sealedBundle() {
  return {
    title: "Fixture",
    docs: sealedDocs(),
    edges: [],
    stats: { documents: 3, assets: 0, asset_bytes: 0 },
  };
}

test("an encrypted document is sealed until its password opens it", async () => {
  const fetch_ = fetcher({});
  const store = docStore.createDocStore(sealedBundle(), fetch_.fetch);

  assert.equal(
    store.isEncrypted(SEALED_ID),
    true,
    "the payload carries no plaintext for it",
  );
  assert.equal(store.isEncrypted("index.md"), false);
  assert.equal(
    store.peek(SEALED_ID).html,
    "",
    "the body is emptied, not absent",
  );

  const failed = await store.decrypt(SEALED_ID, "wrong password");
  assert.equal(failed, null, "a wrong password answers null");
  assert.equal(
    store.isEncrypted(SEALED_ID),
    true,
    "a failed attempt leaves the cache sealed",
  );
  assert.equal(store.peek(SEALED_ID).html, "", "and the sealed body in place");
  assert.deepEqual(fetch_.asked, [], "an embedded site never fetches");
});

test("the right password replaces the sealed model with the full one", async () => {
  const fetch_ = fetcher({});
  const store = docStore.createDocStore(sealedBundle(), fetch_.fetch);

  const full = await store.decrypt(SEALED_ID, SEALED_PASSWORD);

  assert.equal(full.id, SEALED_ID);
  assert.equal(full.title, "Intro", "the public metadata stays");
  assert.equal(full.path, SEALED_ID);
  assert.equal(full.html, SEALED_BODY.html);
  assert.deepEqual(full.toc, SEALED_BODY.toc);
  assert.deepEqual(full.blocks, SEALED_BODY.blocks);
  assert.equal(full.text, SEALED_BODY.text);
  assert.equal(full.enc, undefined, "the seal is gone from the model");
  assert.equal(
    store.isEncrypted(SEALED_ID),
    false,
    "the document reads like a public one now",
  );
  assert.equal(store.peek(SEALED_ID).html, SEALED_BODY.html);
  const again = await store.get(SEALED_ID);
  assert.equal(again.html, SEALED_BODY.html);
  assert.deepEqual(fetch_.asked, [], "and no request was ever made");
});

test("a decryption is announced only to the listeners still registered", async () => {
  const fetch_ = fetcher({});
  const store = docStore.createDocStore(sealedBundle(), fetch_.fetch);
  const firstHeard = [];
  const secondHeard = [];
  const stopFirst = store.onDecrypted(function (doc) {
    firstHeard.push(doc);
  });
  store.onDecrypted(function (doc) {
    secondHeard.push(doc);
  });

  await store.decrypt(SEALED_ID, "wrong password");
  assert.equal(firstHeard.length, 0, "a failed attempt announces nothing");

  const full = await store.decrypt(SEALED_ID, SEALED_PASSWORD);
  assert.equal(firstHeard.length, 1);
  assert.equal(firstHeard[0], full, "the listener hears the full model");
  assert.equal(secondHeard.length, 1);

  stopFirst();
  await store.decrypt(OTHER_ID, SEALED_PASSWORD);
  assert.equal(
    firstHeard.length,
    1,
    "an unregistered listener hears nothing more",
  );
  assert.equal(secondHeard.length, 2);
  assert.equal(secondHeard[1].id, OTHER_ID);
  assert.equal(secondHeard[1].html, OTHER_BODY.html);
});

test("a sealed document of the pages format is fetched, then opened", async () => {
  const manifest = {
    title: "Fixture",
    mode: "pages",
    docs: [
      { id: "index.md", title: "Index", hash: "h0" },
      { id: SEALED_ID, title: "Intro", hash: "h1", enc: true },
    ],
    edges: [],
    stats: { documents: 2, assets: 0 },
  };
  const fetch_ = fetcher({
    "pages/guide/intro.md.json?v=h1": {
      id: SEALED_ID,
      title: "Intro",
      html: "",
      toc: [],
      blocks: [],
      text: "",
      enc: SEALED_BLOB,
    },
  });
  const store = docStore.createDocStore(manifest, fetch_.fetch);

  assert.equal(
    store.isEncrypted(SEALED_ID),
    true,
    "the manifest says so before any fetch",
  );

  const full = await store.decrypt(SEALED_ID, SEALED_PASSWORD);
  assert.equal(full.html, SEALED_BODY.html);
  assert.deepEqual(
    fetch_.asked,
    ["pages/guide/intro.md.json?v=h1"],
    "the chunk travels first",
  );
  assert.equal(store.isEncrypted(SEALED_ID), false);
});

test("a decryption is refused for documents that carry no seal", async () => {
  const fetch_ = fetcher({});
  const store = docStore.createDocStore(sealedBundle(), fetch_.fetch);

  assert.equal(
    await store.decrypt("index.md", SEALED_PASSWORD),
    null,
    "a public document is not a locked one",
  );
  assert.equal(
    await store.decrypt("missing.md", SEALED_PASSWORD),
    null,
    "an unknown document neither",
  );
});
