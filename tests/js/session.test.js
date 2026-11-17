/**
 * Tests for `src/web/js/session.js`: what one visit has unlocked and
 * remembers.
 *
 * The session is the reader's memory around the store's decrypting door. A
 * password that opened a document is filed for the page's lifetime and is
 * never written anywhere but memory; the documents those passwords opened
 * are kept by id and announced to every listener; and the silent attempt
 * for the next sealed page reads the same table, one attempt per document
 * at a time, abandoning the queue when the reader navigates away. The
 * preferences — theme, sidebar, side view — are the one exception that
 * outlives the page, and they go through the module's one safe door to
 * `localStorage`, which may refuse and cost nothing but the memory.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { withGlobals } from "./helpers/dom.js";
import {
  createSession,
  createSessionPasswords,
} from "../../src/web/js/session.js";

/** Let every pending promise settle, which is what a queue step waits for. */
function settle() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

/**
 * A decrypting door stub: `answers` maps a password to the model it opens
 * (every other password answers `null`), and every attempt is recorded on
 * `calls` when one is handed in.
 */
function door(answers, calls) {
  return function (id, password) {
    if (calls) {
      calls.push({ id: id, password: password });
    }
    return Promise.resolve(
      Object.hasOwn(answers, password) ? answers[password] : null,
    );
  };
}

/** A `localStorage` double over a plain map, with a refuse-everything mode. */
function fakeStorage(map, broken) {
  return {
    getItem: function (key) {
      if (broken) {
        throw new Error("storage is disabled");
      }
      return Object.hasOwn(map, key) ? map[key] : null;
    },
    setItem: function (key, value) {
      if (broken) {
        throw new Error("storage is disabled");
      }
      map[key] = String(value);
    },
  };
}

test("the session password table answers to the document and the order", () => {
  const session = createSessionPasswords();

  assert.equal(session.passwordFor("a.md"), null, "the session starts empty");
  assert.deepEqual(session.candidates("a.md"), [], "nothing to try silently");

  session.remember("a.md", "first");
  session.remember("b.md", "second");
  session.remember("a.md", "revised");

  assert.equal(session.passwordFor("a.md"), "revised");
  assert.equal(session.passwordFor("b.md"), "second");
  assert.deepEqual(
    session.candidates("b.md"),
    ["second", "revised", "first"],
    "its own password first, then the others newest first",
  );
  assert.deepEqual(
    session.candidates("c.md"),
    ["revised", "second", "first"],
    "a stranger document tries the session newest first",
  );
  assert.deepEqual(
    session.candidates("a.md"),
    ["revised", "second", "first"],
    "the document's own password is never tried twice",
  );
});

test("a recorded decryption is announced and remembered by id", () => {
  const session = createSession({ decrypt: door({}) });
  const heard = [];
  const stop = session.onDecrypted(function (doc) {
    heard.push(doc);
  });

  const model = { id: "a.md", html: "<p>full</p>" };
  session.recordDecrypted(model);

  assert.deepEqual(heard, [model], "the listener hears the model");
  assert.equal(session.decryptedDoc("a.md"), model);
  assert.equal(
    session.decryptedDoc("b.md"),
    null,
    "a document no password opened is not there",
  );

  stop();
  session.recordDecrypted({ id: "b.md" });
  assert.equal(heard.length, 1, "an unregistered listener hears nothing more");
  assert.equal(session.decryptedDoc("b.md").id, "b.md");
});

test("unlock remembers only a password that opened its document", async () => {
  const model = { id: "a.md", html: "<p>full</p>" };
  const calls = [];
  const session = createSession({ decrypt: door({ right: model }, calls) });

  assert.equal(
    await session.unlock("a.md", "wrong"),
    null,
    "a password that does not authenticate answers null",
  );
  assert.deepEqual(
    session.candidates("a.md"),
    [],
    "a failed attempt is forgotten",
  );

  assert.equal(await session.unlock("a.md", "right"), model);
  assert.deepEqual(
    session.candidates("a.md"),
    ["right"],
    "a password that opened the document is remembered",
  );
  assert.deepEqual(
    calls,
    [
      { id: "a.md", password: "wrong" },
      { id: "a.md", password: "right" },
    ],
    "the door saw both attempts",
  );
});

test("a silent attempt tries its own password first and stops when it opens", async () => {
  const model = { id: "a.md" };
  const calls = [];
  const session = createSession({ decrypt: door({ two: model }, calls) });
  session.remember("other.md", "one");
  session.remember("a.md", "two");

  session.attemptSilentUnlock({ id: "a.md" });
  await settle();

  assert.deepEqual(
    calls,
    [{ id: "a.md", password: "two" }],
    "the password that opened the document ended the queue",
  );
});

test("a silent attempt falls through to a sibling's password", async () => {
  const model = { id: "b.md" };
  const calls = [];
  const session = createSession({
    decrypt: function (id, password) {
      calls.push({ id: id, password: password });
      return Promise.resolve(
        id === "b.md" && password === "shared" ? model : null,
      );
    },
  });
  session.remember("a.md", "shared");

  session.attemptSilentUnlock({ id: "b.md" });
  await settle();

  assert.deepEqual(
    calls,
    [{ id: "b.md", password: "shared" }],
    "the sibling's password opened it",
  );
  assert.deepEqual(
    session.candidates("b.md"),
    ["shared"],
    "the password that opened it is filed",
  );
});

test("a document with an attempt running does not start a second one", async () => {
  const calls = [];
  let release = null;
  const session = createSession({
    decrypt: function (id, password) {
      calls.push({ id: id, password: password });
      return new Promise(function (resolve) {
        release = function () {
          resolve(null);
        };
      });
    },
  });
  session.remember("a.md", "first");
  session.remember("b.md", "second");

  const doc = { id: "a.md" };
  session.attemptSilentUnlock(doc);
  await settle();
  session.attemptSilentUnlock(doc);
  await settle();

  assert.deepEqual(
    calls,
    [{ id: "a.md", password: "first" }],
    "the attempt running owns the document; the second call joined nothing",
  );

  release();
  await settle();
  await settle();

  assert.deepEqual(
    calls,
    [
      { id: "a.md", password: "first" },
      { id: "a.md", password: "second" },
    ],
    "the queue carried on through the candidates",
  );
});

test("a navigation away abandons the rest of a silent queue", async () => {
  const model = { id: "a.md" };
  const calls = [];
  let release = null;
  let active = true;
  const session = createSession({
    decrypt: function (id, password) {
      calls.push({ id: id, password: password });
      if (password === "one") {
        return new Promise(function (resolve) {
          release = function () {
            resolve(null);
          };
        });
      }
      return Promise.resolve(password === "two" ? model : null);
    },
    isActive: function () {
      return active;
    },
  });
  session.remember("a.md", "one");
  session.remember("b.md", "two");

  session.attemptSilentUnlock({ id: "a.md" });
  await settle();
  active = false;
  release();
  await settle();
  await settle();

  assert.deepEqual(
    calls,
    [{ id: "a.md", password: "one" }],
    "the remaining candidates were not spent on a page left behind",
  );
});

test("a finished attempt frees the document for the next one", async () => {
  const model = { id: "a.md" };
  const calls = [];
  const session = createSession({ decrypt: door({ late: model }, calls) });
  session.remember("a.md", "early");

  session.attemptSilentUnlock({ id: "a.md" });
  await settle();
  assert.deepEqual(
    calls,
    [{ id: "a.md", password: "early" }],
    "the first try failed and the attempt ended",
  );

  session.remember("b.md", "late");
  session.attemptSilentUnlock({ id: "a.md" });
  await settle();
  assert.deepEqual(
    calls,
    [
      { id: "a.md", password: "early" },
      { id: "a.md", password: "early" },
      { id: "a.md", password: "late" },
    ],
    "a later attempt reads the table anew and opens the document",
  );
  assert.deepEqual(
    session.candidates("a.md"),
    ["late", "early"],
    "the password that opened it is filed",
  );
});

test("the preferences are written through the one storage door", () => {
  const map = {};
  withGlobals({ localStorage: fakeStorage(map) }, function () {
    const session = createSession({ decrypt: door({}) });

    assert.equal(session.theme(), null, "no explicit choice yet");
    assert.equal(session.sidebarHidden(), false);
    assert.equal(session.sideView(), "docs", "the list starts showing");

    session.setTheme("light");
    session.setSidebarHidden(true);
    session.setSideView("outline");

    assert.equal(map["wikicc.theme"], "light");
    assert.equal(map["wikicc.sidebar"], "hidden");
    assert.equal(map["wikicc.side-view"], "outline");

    assert.equal(session.theme(), "light");
    assert.equal(session.sidebarHidden(), true);
    assert.equal(session.sideView(), "outline");

    session.setSidebarHidden(false);
    assert.equal(map["wikicc.sidebar"], "visible");
    assert.equal(session.sidebarHidden(), false);
  });
});

test("a theme that storage never named follows the OS", () => {
  const map = { "wikicc.theme": "sepia", "wikicc.side-view": "outline" };
  withGlobals({ localStorage: fakeStorage(map) }, function () {
    const session = createSession({ decrypt: door({}) });

    assert.equal(session.theme(), null, "an unknown value is no choice");
    assert.equal(session.sideView(), "outline", "a known value rides in");
  });
});

test("storage that refuses costs the preferences nothing", () => {
  // The absence of a throw is the assertion: the reads answer their
  // fallbacks and the writes are swallowed.
  withGlobals({ localStorage: fakeStorage({}, true) }, function () {
    const session = createSession({ decrypt: door({}) });

    assert.equal(session.theme(), null);
    assert.equal(session.sidebarHidden(), false);
    assert.equal(session.sideView(), "docs");

    session.setTheme("dark");
    session.setSidebarHidden(true);
    session.setSideView("outline");
  });
});
