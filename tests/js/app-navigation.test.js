/**
 * Tests for the navigation cycle the reader is driven by
 * (`src/web/js/navigation.js` through the composed `app.js`).
 *
 * The rules under test are the ones a click on a block reference depends on:
 *
 * - a navigation that changes the address re-renders the document and walks the
 *   reader to the chapter, even after the freshly inserted markup settles;
 * - a navigation whose address is already showing does *not* re-render, because
 *   the render would throw away the position it was asked to reach;
 * - the document list always highlights the open document, filter or not;
 * - a document that travels first shows the wait and the failure, and lands
 *   the passage a search named when the chunk arrives.
 *
 * The page itself comes from `./helpers/app-fixture.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  marksOf,
  withSession,
  startSession,
  activeEntry,
  countLinks,
  lockedDocs,
  searchInput,
  searchParts,
  keydown,
  textOf,
} from "./helpers/app-fixture.js";

test("a navigation to another document renders it and scrolls to the chapter", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    assert.equal(session.scrollTop(), 0);

    session.follow("#/doc/guide/intro.md#getting-started");

    assert.deepEqual(
      session.headings.get("getting-started").scrollCalls,
      [{ block: "start" }],
      "the chapter is reached as soon as the markup is there",
    );
  });
});

test("the chapter is walked to again once the markup has settled", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();
    session.follow("#/doc/guide/intro.md#getting-started");

    const heading = session.headings.get("getting-started");
    assert.equal(heading.scrollCalls.length, 1);
    assert.ok(
      session.frames.length,
      "corrections are queued for the next frames",
    );

    session.runFrames();
    assert.ok(
      heading.scrollCalls.length > 1,
      "a diagram or an image can still move the chapter after the first scroll",
    );
  });
});

test("a navigation the reader is already on scrolls without re-rendering", async () => {
  withSession({ hash: "#/doc/guide/intro.md#top" }, (session) => {
    startSession();
    const article = session.shell.get("doc-article");
    const body = article.children[1];
    assert.ok(body, "the document is on screen");

    session.follow("#/doc/guide/intro.md#getting-started");

    assert.equal(
      article.children[1],
      body,
      "the article is not rebuilt: a render would drop the position just reached",
    );
    assert.deepEqual(session.headings.get("getting-started").scrollCalls, [
      { block: "start" },
    ]);
  });
});

test("clicking the document already open walks to its chapter", async () => {
  withSession({ hash: "#/doc/index.md#top" }, (session) => {
    startSession();
    const article = session.shell.get("doc-article");
    const body = article.children[1];

    // What the sidebar and the outline do for an address that is already
    // showing: no hash change happens, so the session has to scroll itself.
    session.doc.fire("hashchange");
    assert.equal(article.children[1], body);
  });
});

test("the document list keeps every document and highlights the open one", async () => {
  withSession({ hash: "#/doc/guide/intro.md#getting-started" }, (session) => {
    startSession();

    const entry = activeEntry(session.shell);
    assert.ok(entry, "the open document is highlighted");
    assert.equal(entry.textContent, "Intro");

    // The sidebar no longer filters: searching is the panel's job, so the list
    // is the site's table of contents for the whole session.
    assert.equal(
      countLinks(session.shell.get("doc-list")),
      2,
      "both documents are listed",
    );
  });
});

test("a document with no chapters opens at the top", async () => {
  withSession({ hash: "#/doc/index.md#top" }, (session) => {
    startSession();

    session.follow("#/doc/index.md");

    assert.equal(session.scrollTop(), 0);
    assert.ok(activeEntry(session.shell), "the list follows the document");
  });
});

test("a chapter the document does not have opens it from the top", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    session.follow("#/doc/guide/intro.md#no-such-chapter");

    assert.deepEqual(
      session.headings.get("getting-started").scrollCalls,
      [],
      "nothing is scrolled to when there is nothing to reach",
    );
    assert.equal(session.scrollTop(), 0);
  });
});

test("a pages session fetches the document it opens", async () => {
  await withSession({ hash: "#/doc/index.md", lazy: true }, async (session) => {
    startSession();
    await session.settle();

    const article = session.shell.get("doc-article");
    assert.equal(article.children[0].textContent, "index.md");
    assert.match(
      article.children[1].innerHTML,
      /root/,
      "the fetched chunk is on screen",
    );
    assert.deepEqual(
      session.fetchCalls,
      ["pages/index.md.json?v=h0"],
      "only the document the reader opened was requested",
    );

    session.follow("#/doc/guide/intro.md#getting-started");
    await session.settle();

    assert.deepEqual(
      session.headings.get("getting-started").scrollCalls,
      [{ block: "start" }],
      "the fetched document is placed and its chapter is reached",
    );
    assert.deepEqual(
      session.fetchCalls,
      ["pages/index.md.json?v=h0", "pages/guide/intro.md.json?v=h1"],
      "the chunk is fetched when the reader navigates to it",
    );
  });
});

test("a chunk that never arrives explains itself in the article and the banner", async () => {
  await withSession(
    { hash: "#/doc/index.md", lazy: true, broken: true },
    async (session) => {
      startSession();
      await session.settle();

      const article = session.shell.get("doc-article");
      assert.equal(
        article.children.length,
        1,
        "the article holds the failure note and nothing else",
      );
      assert.match(
        article.children[0].textContent,
        /could not be loaded/,
        "the article says the document is not there",
      );
      assert.match(
        textOf(session.shell.get("doc-alert")),
        /Could not load index\.md/,
        "the banner names the document and the likely cause",
      );
    },
  );
});

test("a pages session warns once when opened from a file address", async () => {
  await withSession({ hash: "#/doc/index.md", lazy: true }, async (session) => {
    const previousLocation = globalThis.location;
    globalThis.location = { hash: "#/doc/index.md", protocol: "file:" };

    try {
      startSession();
      await session.settle();

      assert.match(
        textOf(session.shell.get("doc-alert")),
        /served over HTTP/,
        "the reader says why no document can appear",
      );
    } finally {
      globalThis.location = previousLocation;
    }
  });
});

test("a pages session lands the search's passage when the document arrives", async () => {
  await withSession({ hash: "#/doc/index.md", lazy: true }, async (session) => {
    startSession();
    await session.settle();

    session.shell.get("search-toggle").fire("click");
    const input = searchInput(session.shell);
    input.value = "intro";
    input.fire("input", { target: input });
    session.runTimers();
    await session.settle();

    // The whole-site corpus travels on the first global query, and the
    // answer names the document the passage lives in.
    searchParts(session.shell, "search-mode")[0].fire("click");
    await session.settle();
    assert.deepEqual(
      searchParts(session.shell, "search-result-path").map(function (node) {
        return node.textContent;
      }),
      ["guide/intro.md"],
    );

    input.fire("keydown", keydown("Enter"));
    session.follow(session.location.hash);
    await session.settle();

    const article = session.shell.get("doc-article");
    assert.equal(
      article.children[0].textContent,
      "guide/intro.md",
      "the document the passage lives in is open",
    );
    const marks = marksOf(article.children[1]);
    assert.equal(
      marks.length,
      1,
      "the passage is marked once the fetched document is on screen",
    );
    assert.equal(marks[0].textContent, "intro");
    assert.match(
      marks[0].className,
      /search-hit-active/,
      "the passage the row described is the one that stands out",
    );
    assert.deepEqual(
      marks[0].scrollCalls,
      [{ block: "center" }],
      "the reader is brought to the passage",
    );
  });
});

test("every navigation refreshes the backlinks panel", async () => {
  withSession(
    {
      hash: "#/doc/index.md",
      edges: [
        { from: "index.md", to: "guide/intro.md" },
        { from: "guide/intro.md", to: "index.md" },
        { from: "guide/intro.md", to: "index.md" },
      ],
    },
    (session) => {
      startSession();

      const panel = session.shell.get("backlinks");
      assert.equal(
        countLinks(panel),
        1,
        "the page the reader opened lists what points at it",
      );

      session.follow("#/doc/guide/intro.md");
      assert.equal(
        countLinks(panel),
        1,
        "the panel answers the document the reader is on now",
      );

      // The list is links like any other view's: a plain left click follows
      // the route instead of the browser.
      panel.children[0].children[0].children[0].fire("click", {
        button: 0,
        preventDefault() {},
      });
      assert.equal(
        session.location.hash,
        "#/doc/index.md",
        "following a backlink navigates to its source",
      );
    },
  );
});

test("a locked document still lists what points at it", async () => {
  withSession(
    {
      hash: "#/doc/index.md",
      docs: lockedDocs(),
      edges: [{ from: "index.md", to: "guide/intro.md" }],
    },
    (session) => {
      startSession();

      const panel = session.shell.get("backlinks");
      assert.equal(
        countLinks(panel),
        0,
        "the public page carries no edge into it",
      );

      session.follow("#/doc/guide/intro.md");
      assert.equal(
        countLinks(panel),
        1,
        "the sealed page lists its sources: the graph was resolved before any body was sealed",
      );
    },
  );
});
