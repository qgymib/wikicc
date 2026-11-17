/**
 * Tests for the reader session around one payload (`src/web/js/session.js`
 * through the composed `app.js`).
 *
 * The rules under test are the session's: a sealed document opens as a lock
 * page, a wrong password says so, the right one opens the document in place,
 * a sibling sealed under the same password opens without asking, and a
 * refresh forgets every password; the preview panel unlocks a sealed chapter
 * in place through the same door.
 *
 * The page itself comes from `./helpers/app-fixture.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  withSession,
  startSession,
  SEALED_PASSWORD,
  payload,
  lockedDocs,
  lockedManifest,
  lockedChunks,
  waitFor,
  lockedForm,
  lockedInput,
  lockedError,
  submitPassword,
  byClassIn,
  previewPanel,
  hoverReference,
} from "./helpers/app-fixture.js";

test("a sealed document opens as a locked page that carries the password form", () => {
  withSession(
    { hash: "#/doc/guide/intro.md", docs: lockedDocs() },
    (session) => {
      startSession();

      const article = session.shell.get("doc-article");
      assert.equal(
        article.children[0].textContent,
        "guide/intro.md",
        "the path stays public",
      );
      const title = article.children[1];
      assert.match(
        title.className,
        /doc-locked-title/,
        "the title stands where the body's own would",
      );
      assert.equal(
        title.children.length,
        0,
        "the title is a plain heading — the form below is the one control",
      );
      assert.equal(
        title.textContent,
        "Intro",
        "the title the lists show is what the page names",
      );
      const note = article.children[2];
      assert.match(note.className, /doc-locked/);
      assert.match(note.textContent, /encrypted/);
      assert.match(
        note.textContent,
        /stay hidden until it is unlocked/,
        "the note names the lock, and no more",
      );
      assert.equal(note.children.length, 0, "the note holds text only");
      assert.match(
        article.className,
        /doc-locked-page/,
        "the lock page centers itself in the column",
      );
      const form = lockedForm(article);
      const input = lockedInput(article);
      assert.match(
        form.className,
        /doc-locked-form/,
        "the password form stands in the page itself",
      );
      assert.equal(
        input.getAttribute("type"),
        "password",
        "the reader can type the password right where they landed",
      );
      assert.equal(input.focused, true, "the field takes the focus");
      assert.equal(input.value, "", "the field starts empty");
      assert.equal(
        lockedError(article).hidden,
        true,
        "no error before any attempt",
      );
      assert.equal(
        document.title,
        "Intro · Fixture",
        "the title the lists show is still the document's",
      );
    },
  );
});

test("a navigation into and out of a sealed document switches the views", () => {
  withSession({ hash: "#/doc/index.md", docs: lockedDocs() }, (session) => {
    startSession();
    const article = session.shell.get("doc-article");
    assert.match(
      article.children[1].className,
      /doc-body/,
      "the public document renders its markup",
    );

    session.follow("#/doc/guide/intro.md");
    assert.match(article.children[1].className, /doc-locked/);

    session.follow("#/doc/index.md");
    assert.match(
      article.children[1].className,
      /doc-body/,
      "the reader comes back to markup",
    );
  });
});

test("a sealed document stays quiet about a chapter it cannot reach", () => {
  withSession({ hash: "#/doc/index.md", docs: lockedDocs() }, (session) => {
    startSession();

    session.follow("#/doc/guide/intro.md#getting-started");

    assert.equal(
      session.shell.get("doc-alert").hidden,
      true,
      "the lock is the reason, not a missing chapter",
    );
    assert.match(
      session.shell.get("doc-article").children[1].className,
      /doc-locked/,
    );
  });
});

test("a wrong password says so, and the right one opens the document", async () => {
  await withSession(
    { hash: "#/doc/guide/intro.md", docs: lockedDocs(), storage: {} },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");

      submitPassword(session, "not the password");
      await waitFor(function () {
        return lockedError(article).hidden === false;
      }, "the wrong-password error");
      assert.match(lockedError(article).textContent, /did not unlock/);
      assert.match(
        article.children[1].className,
        /doc-locked-title/,
        "the document stays sealed",
      );

      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the unlocked document");

      assert.equal(article.children[0].textContent, "guide/intro.md");
      assert.match(article.children[1].innerHTML, /intro body/);
      assert.equal(
        session.shell.get("toc").children.length,
        1,
        "the outline the seal hid is on screen",
      );
      assert.equal(
        lockedForm(article),
        null,
        "the success takes the form away with the lock page",
      );

      // The password the session heard lives in memory alone: whatever the
      // reader wrote down between visits, it is not this.
      Object.keys(session.storage).forEach(function (key) {
        assert.ok(
          String(session.storage[key]).indexOf(SEALED_PASSWORD) === -1,
          "the storage holds no password: " + key,
        );
        assert.ok(
          key.indexOf("password") === -1,
          "no storage key speaks of passwords: " + key,
        );
      });
    },
  );
});

test("the chapter the address named is reached once the document is open", async () => {
  await withSession(
    { hash: "#/doc/guide/intro.md#getting-started", docs: lockedDocs() },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");
      assert.match(
        article.children[1].className,
        /doc-locked-title/,
        "the arrival shows the lock first",
      );

      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the unlocked document");

      // The walk itself, before the settling frames repeat it: the arrival
      // the route named is reached as soon as the body is on screen.
      assert.deepEqual(
        session.headings.get("getting-started").scrollCalls,
        [{ block: "start" }],
        "the deep link lands on its chapter after the unlock",
      );
    },
  );
});

test("a password the session holds opens the next sealed document without asking", async () => {
  await withSession(
    { hash: "#/doc/guide/intro.md", docs: lockedDocs() },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");

      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the first unlocked document");

      session.follow("#/doc/guide/other.md");
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the second document");

      assert.equal(article.children[0].textContent, "guide/other.md");
      assert.match(article.children[1].innerHTML, /另一篇/);
      assert.equal(
        lockedForm(article),
        null,
        "the second document never stopped to ask",
      );
    },
  );
});

test("a fresh session has to ask for the password again", async () => {
  await withSession(
    { hash: "#/doc/guide/intro.md", docs: lockedDocs() },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");
      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the unlocked document");
    },
  );

  // The second session is what a reload looks like: the password the first
  // one heard went with it, so the document seals itself again.
  await withSession(
    { hash: "#/doc/guide/intro.md", docs: lockedDocs() },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");

      assert.match(
        article.children[1].className,
        /doc-locked-title/,
        "the document is sealed again",
      );
      const form = lockedForm(article);
      const input = lockedInput(article);
      assert.ok(form, "the form stands in the page again");
      assert.equal(input.value, "", "the fresh field starts empty");
      assert.equal(
        lockedError(article).hidden,
        true,
        "and nothing opens it by itself",
      );
    },
  );
});

test("a pages session unlocks through the lock page's form over the fetched chunk", async () => {
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
      assert.equal(article.children[0].textContent, "guide/intro.md");
      assert.match(article.children[1].className, /doc-locked-title/);
      assert.deepEqual(
        session.fetchCalls,
        ["pages/guide/intro.md.json?v=h1"],
        "the sealed chunk is fetched like any other",
      );

      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(article.children[1].className);
      }, "the unlocked document");

      assert.match(article.children[1].innerHTML, /intro body/);
      assert.deepEqual(
        session.fetchCalls,
        ["pages/guide/intro.md.json?v=h1"],
        "the unlock costs no further request",
      );
    },
  );
});

test("a pages session shows the locked placeholder from the fetched chunk", async () => {
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
      assert.equal(article.children[0].textContent, "guide/intro.md");
      assert.match(article.children[1].className, /doc-locked-title/);
      assert.deepEqual(
        session.fetchCalls,
        ["pages/guide/intro.md.json?v=h1"],
        "the sealed chunk is fetched like any other",
      );
    },
  );
});

test("hovering a reference into a sealed document opens the locked panel and unlocks in place", async () => {
  await withSession(
    { docs: lockedDocs(), hash: "#/doc/index.md" },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");
      assert.match(
        article.children[1].className,
        /doc-body/,
        "the page the reference is on is public",
      );

      hoverReference(session);

      const panel = previewPanel(session);
      assert.ok(panel, "the panel is on the page for a sealed target");
      assert.equal(
        panel.getAttribute("data-locked"),
        "true",
        "the locked state is what the hover shows",
      );
      assert.equal(
        byClassIn(panel, "preview-title")[0].textContent,
        "Intro",
        "the head names the document the payload still says in public",
      );
      assert.equal(
        byClassIn(panel, "preview-path")[0].textContent,
        "guide/intro.md",
      );
      assert.equal(
        byClassIn(panel, "preview-unlock-input")[0].getAttribute("type"),
        "password",
      );
      assert.equal(
        byClassIn(panel, "preview-unlock-error")[0].hidden,
        true,
        "no error before any try",
      );
      assert.equal(
        byClassIn(panel, "preview-scroll")[0].innerHTML,
        "",
        "no plaintext travels with the form",
      );

      const form = byClassIn(panel, "preview-unlock")[0];
      const input = byClassIn(panel, "preview-unlock-input")[0];
      input.value = SEALED_PASSWORD;
      form.fire("submit", { preventDefault() {} });

      await waitFor(function () {
        const shown = previewPanel(session);
        return (
          shown &&
          shown.getAttribute("data-locked") === null &&
          /intro body/.test(byClassIn(shown, "preview-scroll")[0].innerHTML)
        );
      }, "the unlocked chapter in the panel");

      assert.equal(
        previewPanel(session).getAttribute("aria-label"),
        "Chapter preview",
        "what replaced the form is the ordinary preview",
      );
      assert.equal(
        byClassIn(previewPanel(session), "preview-unlock-input")[0].value,
        "",
        "the password is cleared once it has opened the document",
      );
      Object.keys(session.storage).forEach(function (key) {
        assert.ok(
          String(session.storage[key]).indexOf(SEALED_PASSWORD) === -1,
          "the storage holds no password: " + key,
        );
        assert.ok(
          key.indexOf("password") === -1,
          "the storage holds no password key: " + key,
        );
      });
    },
  );
});

test("a password the page already holds previews the sealed chapter without asking", async () => {
  await withSession(
    { docs: lockedDocs(), hash: "#/doc/guide/other.md" },
    async (session) => {
      startSession();
      const article = session.shell.get("doc-article");
      assert.match(article.children[1].className, /doc-locked-title/);

      // The reader opens the other sealed document first; its password is
      // the session's from then on.
      submitPassword(session, SEALED_PASSWORD);
      await waitFor(function () {
        return /doc-body/.test(
          session.shell.get("doc-article").children[1].className,
        );
      }, "the first unlocked document");

      session.follow("#/doc/index.md");
      await session.settle();

      hoverReference(session);

      await waitFor(function () {
        const shown = previewPanel(session);
        return (
          shown &&
          shown.getAttribute("data-locked") === null &&
          /intro body/.test(byClassIn(shown, "preview-scroll")[0].innerHTML)
        );
      }, "the sealed chapter the session's password opened quietly");

      assert.equal(
        byClassIn(previewPanel(session), "preview-unlock-input")[0].value,
        "",
        "the reader never typed into this panel",
      );
      assert.equal(
        lockedForm(session.shell.get("doc-article")),
        null,
        "and the lock page is gone with its form",
      );
    },
  );
});

test("a wrong password in the panel reports itself and the right one retries", async () => {
  await withSession(
    { docs: lockedDocs(), hash: "#/doc/index.md" },
    async (session) => {
      startSession();
      hoverReference(session);

      const panel = previewPanel(session);
      assert.ok(panel, "the locked panel is up");
      const form = byClassIn(panel, "preview-unlock")[0];
      const input = byClassIn(panel, "preview-unlock-input")[0];
      const error = byClassIn(panel, "preview-unlock-error")[0];

      input.value = "not the password";
      form.fire("submit", { preventDefault() {} });
      await waitFor(function () {
        return error.hidden === false;
      }, "the failed attempt's answer");

      assert.equal(
        previewPanel(session).getAttribute("data-locked"),
        "true",
        "the panel stays with the form",
      );
      assert.match(error.textContent, /did not unlock/);
      assert.equal(input.disabled, false, "the field is back for a retype");

      input.fire("input", {});
      assert.equal(
        error.hidden,
        true,
        "typing clears the failed attempt's answer",
      );

      input.value = SEALED_PASSWORD;
      form.fire("submit", { preventDefault() {} });
      await waitFor(function () {
        const shown = previewPanel(session);
        return (
          shown &&
          shown.getAttribute("data-locked") === null &&
          /intro body/.test(byClassIn(shown, "preview-scroll")[0].innerHTML)
        );
      }, "the unlocked chapter");
    },
  );
});

test("a pages session shows the lock without fetching, and the unlock travels once", async () => {
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

      assert.deepEqual(
        session.fetchCalls,
        ["pages/index.md.json?v=h0"],
        "only the page the reader opened was requested",
      );

      hoverReference(session);

      const panel = previewPanel(session);
      assert.ok(panel, "the manifest's mark is enough to open the lock");
      assert.equal(panel.getAttribute("data-locked"), "true");
      assert.deepEqual(
        session.fetchCalls,
        ["pages/index.md.json?v=h0"],
        "no chunk travels before a password",
      );

      const form = byClassIn(panel, "preview-unlock")[0];
      const input = byClassIn(panel, "preview-unlock-input")[0];
      input.value = SEALED_PASSWORD;
      form.fire("submit", { preventDefault() {} });

      await waitFor(function () {
        const shown = previewPanel(session);
        return (
          shown &&
          shown.getAttribute("data-locked") === null &&
          /intro body/.test(byClassIn(shown, "preview-scroll")[0].innerHTML)
        );
      }, "the unlocked chapter in the panel");

      assert.deepEqual(
        session.fetchCalls,
        ["pages/index.md.json?v=h0", "pages/guide/intro.md.json?v=h1"],
        "the sealed chunk travels once, for the unlock",
      );
    },
  );
});

test("a payload built for another format version shows the reader's message", () => {
  withSession(
    { hash: "#/doc/index.md", payload: Object.assign(payload(), { v: 2 }) },
    (session) => {
      startSession();

      const article = session.shell.get("doc-article");
      assert.equal(
        article.children.length,
        1,
        "the start stops at the message; nothing is wired after it",
      );
      const note = article.children[0];
      assert.match(
        note.className,
        /doc-empty/,
        "the message wears the article's failure styling",
      );
      assert.match(
        note.textContent,
        /payload format version 2/,
        "the message names the version it refused",
      );
      assert.match(
        note.textContent,
        /rebuild/,
        "the message says what to do about it",
      );
      assert.equal(
        activeDocListEntries(session),
        0,
        "no document list was built for a payload the reader refused",
      );
    },
  );
});

test("a payload without a format version shows the reader's message too", () => {
  const withoutVersion = payload();
  delete withoutVersion.v;
  withSession(
    { hash: "#/doc/index.md", payload: withoutVersion },
    (session) => {
      startSession();

      const article = session.shell.get("doc-article");
      assert.equal(
        article.children.length,
        1,
        "the start stops at the message",
      );
      assert.match(
        article.children[0].textContent,
        /no payload format version/,
        "the message names the missing field",
      );
    },
  );
});

/** How many entries the document list carries, for the refusal assertions. */
function activeDocListEntries(session) {
  const list = session.shell.get("doc-list");
  let count = 0;
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.tagName === "A") {
        count += 1;
      }
      walk(child);
    });
  })(list);
  return count;
}
