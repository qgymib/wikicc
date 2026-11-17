/**
 * Tests for the reader's search (`src/web/js/search-controller.js` through
 * the composed `app.js`).
 *
 * The rules under test are the ones a query depends on: the panel opens and
 * closes by button, shortcut and `Escape`; the local scope reads the document
 * in view and the global one fetches the pages corpus; `Enter` on a result
 * walks the reader to the passage it named, and the marks of that arrival go
 * when the reading moves on; a sealed document is a locked row until its
 * password opens the body the query can then answer.
 *
 * The page itself comes from `./helpers/app-fixture.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  marksOf,
  withSession,
  startSession,
  searchInput,
  searchParts,
  keydown,
  SEALED_PASSWORD,
  lockedDocs,
  lockedManifest,
  lockedChunks,
  waitFor,
  submitPassword,
  SEALED_BODY_WORD,
  askGlobal,
  resultPaths,
} from "./helpers/app-fixture.js";

test("the toolbar button opens the search panel and says so", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const button = session.shell.get("search-toggle");
    assert.equal(button.getAttribute("aria-expanded"), "false");

    button.fire("click");

    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(session.shell.get("search-panel").hidden, false);
  });
});

test("the toolbar button is a switch: pressing it again closes the panel", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();
    const button = session.shell.get("search-toggle");

    button.fire("click");
    button.fire("click");

    assert.equal(session.shell.get("search-panel").hidden, true);
    assert.equal(button.getAttribute("aria-expanded"), "false");
  });
});

test("Ctrl+F opens the search panel instead of the browser's find", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    let prevented = false;
    session.doc.fireEvent("keydown", {
      key: "f",
      ctrlKey: true,
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(prevented, true, "the browser's own find bar must not open");
    assert.equal(session.shell.get("search-panel").hidden, false);
    assert.equal(
      session.shell.get("search-toggle").getAttribute("aria-expanded"),
      "true",
    );
  });
});

test("Escape closes the search panel and returns the focus to its button", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();
    const button = session.shell.get("search-toggle");

    button.fire("click");
    session.doc.fireEvent("keydown", keydown("Escape"));

    assert.equal(session.shell.get("search-panel").hidden, true);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(
      button.focused,
      true,
      "the keyboard reader lands back on the button",
    );
  });
});

test("the search panel starts local, reading the document in view", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const button = session.shell.get("search-toggle");
    button.fire("click");

    const input = searchInput(session.shell);
    assert.ok(input, "the panel built a field to type in");
    input.value = "root";
    input.fire("input", { target: input });

    // The debounce fires through the fake timers the session installed.
    session.runTimers();

    const mode = searchParts(session.shell, "search-mode")[0];
    assert.ok(mode, "the field carries a scope switch");
    assert.equal(
      mode.textContent,
      "Local",
      "the scope starts at the document in view",
    );
    assert.deepEqual(
      searchParts(session.shell, "search-result-path").map(function (node) {
        return node.textContent;
      }),
      ["index.md"],
      "the current document's hits are the list, each naming its file",
    );
  });
});

test("the tail budget follows the panel's layout when it has one", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    // The panel's own width is what the caller measures before the first row
    // exists: 708 leaves 400 for the context column, which at the 12.5px the
    // stylesheet sets is 32 units the engine cuts the tail by. The row that
    // first query renders answers no width at all (the fake DOM has no
    // layout), so the next query falls back to the engine's own budget — and
    // both answers still come back whole.
    session.shell.get("search-panel").clientWidth = 708;

    session.shell.get("search-toggle").fire("click");

    const input = searchInput(session.shell);
    input.value = "root";
    input.fire("input", { target: input });
    session.runTimers();

    const first = searchParts(session.shell, "search-result-context");
    assert.equal(first.length, 1, "the first query answers");
    assert.equal(
      first[0].children.length,
      3,
      "the context holds the passage with its marked hit, cut to the budget",
    );

    searchParts(session.shell, "search-mode")[0].fire("click");
    input.value = "intro";
    input.fire("input", { target: input });
    session.runTimers();

    const second = searchParts(session.shell, "search-result-context");
    assert.equal(second.length, 1, "the second query answers too");
    assert.equal(
      second[0].children.length,
      3,
      "the second query reads the row, finds no layout and answers still",
    );
  });
});

test("the scope switch widens the search to every document", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    session.shell.get("search-toggle").fire("click");

    const input = searchInput(session.shell);
    input.value = "getting";
    input.fire("input", { target: input });
    session.runTimers();

    assert.deepEqual(
      searchParts(session.shell, "search-result-path").map(function (node) {
        return node.textContent;
      }),
      [],
      "local reads the document in view, which holds no such heading",
    );

    searchParts(session.shell, "search-mode")[0].fire("click");

    assert.deepEqual(
      searchParts(session.shell, "search-result-path").map(function (node) {
        return node.textContent;
      }),
      ["guide/intro.md"],
      "global asks the engine about every document again",
    );
  });
});

test("Enter on a result opens the article at the passage it names", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const article = session.shell.get("doc-article");
    const body = article.children[1];

    session.shell.get("search-toggle").fire("click");
    const input = searchInput(session.shell);
    input.value = "root";
    input.fire("input", { target: input });
    session.runTimers();

    input.fire("keydown", keydown("Enter"));

    // The address was already the document's: the passage is walked to in
    // place, and a render would have thrown away exactly the article the
    // reader was asked into.
    assert.equal(article.children[1], body, "the article is not rebuilt");

    const marks = marksOf(body);
    assert.equal(marks.length, 1, "the query's occurrence is marked");
    assert.equal(marks[0].textContent, "root");
    assert.equal(
      marks[0].className,
      "search-hit search-hit-active",
      "the passage the row named is the one that stands out",
    );
    assert.deepEqual(
      marks[0].scrollCalls,
      [{ block: "center" }],
      "the reader is brought to the passage",
    );

    // The settling walk re-lands on the passage once diagrams and images
    // have had their say.
    session.runFrames();
    assert.ok(
      marks[0].scrollCalls.length > 1,
      "the passage is walked to again after the layout settles",
    );
  });
});

test("a navigation after a search takes the marks back off", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    session.shell.get("search-toggle").fire("click");
    const input = searchInput(session.shell);
    input.value = "root";
    input.fire("input", { target: input });
    session.runTimers();
    input.fire("keydown", keydown("Enter"));

    const article = session.shell.get("doc-article");
    const marked = article.children[1];
    const mark = marksOf(marked)[0];
    assert.ok(mark, "the arrival carries its marks");

    session.follow("#/doc/guide/intro.md");

    const body = article.children[1];
    assert.notEqual(body, marked, "the document changed");
    assert.equal(
      marksOf(body).length,
      0,
      "the reading that follows opens as authored",
    );
    assert.equal(mark.parentNode, null, "the mark went back to plain text");
  });
});

test("a match with no body occurrence opens the document without marks", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    session.shell.get("search-toggle").fire("click");
    const input = searchInput(session.shell);
    input.value = "Index";
    input.fire("input", { target: input });
    session.runTimers();

    input.fire("keydown", keydown("Enter"));

    const body = session.shell.get("doc-article").children[1];
    assert.equal(
      marksOf(body).length,
      0,
      "a title-only match has no passage to mark or walk to",
    );
  });
});

test("a pages session fetches the corpus on the first global search", async () => {
  await withSession({ hash: "#/doc/index.md", lazy: true }, async (session) => {
    startSession();
    await session.settle();

    session.shell.get("search-toggle").fire("click");
    const input = searchInput(session.shell);
    input.value = "intro";
    input.fire("input", { target: input });
    session.runTimers();
    await session.settle();

    // The local scope answered from the document in view; no corpus was asked
    // for, because the document the reader opened carries its own text.
    assert.deepEqual(session.fetchCalls, ["pages/index.md.json?v=h0"]);

    searchParts(session.shell, "search-mode")[0].fire("click");
    await session.settle();

    // The first global query fetches the corpus, and the answer replaces the
    // wait the panel showed while it travelled.
    assert.ok(
      session.fetchCalls.indexOf("search.json") !== -1,
      "the corpus arrives with the first global query: " +
        JSON.stringify(session.fetchCalls),
    );
    assert.deepEqual(
      searchParts(session.shell, "search-result-path").map(function (node) {
        return node.textContent;
      }),
      ["guide/intro.md"],
      "the corpus answers the query",
    );
  });
});

test("a sealed document answers its title as a locked row and its body with nothing", () => {
  withSession({ hash: "#/doc/index.md", docs: lockedDocs() }, (session) => {
    startSession();

    askGlobal(session, SEALED_BODY_WORD);
    assert.deepEqual(
      resultPaths(session),
      [],
      "a body word the site cannot show answers with no row at all",
    );

    askGlobal(session, "intro");
    assert.deepEqual(resultPaths(session), ["guide/intro.md"]);
    const markers = searchParts(session.shell, "search-result-locked");
    assert.equal(
      markers.length,
      1,
      "the row says the lock is why it quotes no passage",
    );
    assert.equal(markers[0].textContent, "Locked");
    assert.equal(
      markers[0].getAttribute("title"),
      "This document is encrypted",
    );
    const notices = searchParts(session.shell, "search-locked");
    assert.equal(notices.length, 1, "the preview names the lock too");
    assert.match(notices[0].textContent, /Open it to unlock its contents/);
  });
});

test("opening a locked result lands on the lock page with no passage to mark", async () => {
  await withSession(
    { hash: "#/doc/index.md", docs: lockedDocs() },
    (session) => {
      startSession();

      askGlobal(session, "intro");
      searchInput(session.shell).fire("keydown", { key: "Enter" });

      // The pick changed the address; the browser's own hashchange is what
      // turns it into a render, which follow models here.
      assert.equal(session.location.hash, "#/doc/guide/intro.md");
      session.follow(session.location.hash);

      const article = session.shell.get("doc-article");
      assert.match(
        article.children[1].className,
        /doc-locked-title/,
        "the row's one action opens the document at its lock",
      );
      assert.equal(session.shell.get("search-panel").hidden, true);
    },
  );
});

test("the opened body answers the query the sealed title could not", async () => {
  await withSession(
    { hash: "#/doc/guide/intro.md", docs: lockedDocs() },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");

      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the unlocked document");

      askGlobal(session, SEALED_BODY_WORD);
      assert.deepEqual(
        resultPaths(session),
        ["guide/intro.md"],
        "the body the password opened is searchable at once",
      );
      assert.equal(
        searchParts(session.shell, "search-result-locked").length,
        0,
        "an unlocked document's rows carry no lock marker",
      );
      assert.equal(
        searchParts(session.shell, "search-result-context")[0].children.length,
        3,
        "the passage arrived with its marked hit",
      );

      askGlobal(session, "intro");
      assert.deepEqual(resultPaths(session), ["guide/intro.md"]);
      assert.equal(
        searchParts(session.shell, "search-result-locked").length,
        0,
        "the title row of an opened document is a plain row",
      );
    },
  );
});

test("the local scope of a sealed document reads its title, and the opened body after the unlock", async () => {
  await withSession(
    { hash: "#/doc/guide/intro.md", docs: lockedDocs() },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");
      assert.match(
        article.children[1].className,
        /doc-locked-title/,
        "the locked page is showing",
      );

      session.shell.get("search-toggle").fire("click");
      const input = searchInput(session.shell);

      input.value = SEALED_BODY_WORD;
      input.fire("input", { target: input });
      session.runTimers();
      assert.deepEqual(
        resultPaths(session),
        [],
        "the sealed body answers nothing in its own scope either",
      );

      input.value = "intro";
      input.fire("input", { target: input });
      session.runTimers();
      assert.equal(
        searchParts(session.shell, "search-result-locked").length,
        1,
        "the title hit carries the lock marker",
      );

      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the unlocked document");

      input.value = SEALED_BODY_WORD;
      input.fire("input", { target: input });
      session.runTimers();
      assert.deepEqual(
        resultPaths(session),
        ["guide/intro.md"],
        "the same field finds the body once the password opened it",
      );
    },
  );
});

test("a pages session finds the opened body after a search already knew the title", async () => {
  await withSession(
    {
      hash: "#/doc/index.md",
      lazy: true,
      payload: lockedManifest(),
      chunks: lockedChunks(),
    },
    async (session) => {
      startSession();
      await session.settle();

      askGlobal(session, "intro");
      await session.settle();
      assert.deepEqual(resultPaths(session), ["guide/intro.md"]);
      assert.equal(
        searchParts(session.shell, "search-result-locked").length,
        1,
        "the sealed title row is marked locked",
      );

      // The corpus is already in: opening the document and unlocking it must
      // reach the very index this search reads.
      session.follow("#/doc/guide/intro.md");
      await session.settle();
      const article = session.shell.get("doc-article");
      assert.match(article.children[1].className, /doc-locked-title/);

      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the unlocked document");

      askGlobal(session, SEALED_BODY_WORD);
      assert.deepEqual(
        resultPaths(session),
        ["guide/intro.md"],
        "the opened body is searchable through the same index",
      );
      assert.deepEqual(
        session.fetchCalls,
        [
          "pages/index.md.json?v=h0",
          "search.json",
          "pages/guide/intro.md.json?v=h1",
        ],
        "the unlock costs no further request",
      );
    },
  );
});

test("a pages session that unlocks before its first search finds the body too", async () => {
  await withSession(
    {
      hash: "#/doc/guide/intro.md",
      lazy: true,
      payload: lockedManifest(),
      chunks: lockedChunks(),
    },
    async (session) => {
      startSession();
      await session.settle();
      const article = session.shell.get("doc-article");

      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the unlocked document");

      // The first global search is the one that fetches the corpus, and the
      // corpus still names the document by its title alone: the model the
      // password opened stands in for it.
      askGlobal(session, SEALED_BODY_WORD);
      await session.settle();

      assert.ok(
        session.fetchCalls.indexOf("search.json") !== -1,
        "the corpus arrived for the first global search",
      );
      assert.deepEqual(
        resultPaths(session),
        ["guide/intro.md"],
        "the opened body answers even though the corpus was fetched after the unlock",
      );
      assert.equal(
        searchParts(session.shell, "search-result-locked").length,
        0,
        "an opened document's rows carry no lock marker",
      );
    },
  );
});
