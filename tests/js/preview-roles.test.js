/**
 * Tests for the preview's content states (`src/web/js/preview-roles.js`): what
 * the panel shows for the link under the pointer.
 *
 * Driven with a minimal fake DOM — plain objects with just the methods the view
 * calls — because the rules under test are *when* things happen, not how the
 * browser paints them: the popover opens for a chapter that exists, opens at
 * once as a loading panel when the document still travels and fills it on
 * arrival, says so inside the panel when the arrival fails, turns into a
 * notice for one that does not, and a sealed document opens the password form
 * the reader answers in place — quietly first, when the session already holds
 * a password that fits.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BODY_CLASS,
  ERROR_ATTRIBUTE,
  HOVER_DELAY_MS,
  LOCKED_ATTRIBUTE,
  LOCKED_LABEL,
  LOADING_ATTRIBUTE,
  LOADING_CLASS,
  LOADING_LABEL,
  MISSING_ATTRIBUTE,
  MISSING_LABEL,
  PREVIEW_LABEL,
  UNLOCK_BUSY_TEXT,
  UNLOCK_ERROR_CLASS,
  UNLOCK_FORM_CLASS,
  UNLOCK_INPUT_CLASS,
  UNLOCK_SUBMIT_CLASS,
  UNLOCK_SUBMIT_TEXT,
} from "../../src/web/js/preview-view.js";
import {
  brokenLink,
  byClass,
  clickInside,
  link,
  panelOf,
  payload,
  setup,
  textOf,
  travellingStore,
} from "./helpers/preview-fixture.js";

test("hovering a chapter that exists opens the preview", () => {
  setup(function ({ view, content, clock, doc }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });

    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "the open timer is armed",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");

    const panel = panelOf(doc);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      null,
      "an ordinary preview",
    );
    assert.equal(panel.getAttribute("aria-label"), PREVIEW_LABEL);
    assert.match(textOf(panel), /Getting Started/);
  });
});

test("hovering a chapter whose document travels in opens a loading panel at once", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      assert.equal(
        view.isOpen(),
        true,
        "the panel opens before the document arrives",
      );
      const panel = panelOf(doc);
      assert.equal(
        panel.getAttribute(LOADING_ATTRIBUTE),
        "true",
        "it is the loading state the panel shows",
      );
      assert.equal(panel.getAttribute("aria-busy"), "true");
      assert.equal(panel.getAttribute("aria-label"), LOADING_LABEL);
      assert.equal(byClass(panel, LOADING_CLASS).length, 1);
      assert.match(textOf(panel), /Loading/);
      assert.match(
        textOf(panel),
        /Guide Introduction/,
        "the head names the document from the manifest",
      );

      travelling.deliver(payload().get("guide/intro.md"));

      assert.equal(view.isOpen(), true, "the answer fills the panel");
      assert.equal(
        panel.getAttribute(LOADING_ATTRIBUTE),
        null,
        "the loading state is gone",
      );
      assert.equal(panel.getAttribute("aria-busy"), null);
      assert.equal(panel.getAttribute("aria-label"), PREVIEW_LABEL);
      assert.match(textOf(panel), /Getting Started/);
    },
    { documents: travelling.store },
  );
});

test("an answer for a hover the reader left behind opens nothing", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(view.isOpen(), true, "the loading panel is up");

      content.fire("pointerout", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(view.isOpen(), false, "leaving closes the loading panel");

      travelling.deliver(payload().get("guide/intro.md"));

      assert.equal(
        view.isOpen(),
        false,
        "a panel for a link nobody points at any more would be a surprise",
      );
    },
    { documents: travelling.store },
  );
});

test("hovering a broken reference opens a notice and reports nothing", () => {
  setup(function ({ view, content, clock, doc, messages }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.deepEqual(
      messages,
      [],
      "hovering is not a moment the reader reports",
    );
    assert.equal(view.isOpen(), true, "the notice is shown beside the link");

    const panel = panelOf(doc);
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), "true");
    assert.equal(panel.getAttribute("aria-label"), MISSING_LABEL);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");

    const text = textOf(panel);
    assert.match(text, /guide\/intro\.md/);
    assert.match(text, /1\.4 配色与字体/);
  });
});

test("the notice is built from text, never from html", () => {
  setup(function ({ view, content, clock, doc }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "<b>x</b> & <i>y</i>");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    const codes = byClass(panel, "preview-missing-code").map(
      (element) => element.textContent,
    );

    assert.ok(
      codes.includes("<b>x</b> & <i>y</i>"),
      "the chapter is an element of its own",
    );
    assert.equal(panel.innerHTML, "", "no html is assembled for the notice");
  });
});

test("a notice replaces an open preview and leaves nothing behind", () => {
  setup(function ({ view, content, clock, doc }) {
    const good = link("#/doc/guide/intro.md#getting-started");
    const broken = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(good);
    content.appendChild(broken);
    view.tag(content);

    content.fire("pointerover", { target: good, relatedTarget: null });
    clock.runAll();
    const panel = panelOf(doc);
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), null);

    content.fire("pointerover", { target: broken, relatedTarget: null });
    clock.runAll();

    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), "true");
    assert.equal(
      good.getAttribute("aria-expanded"),
      "false",
      "the old link is released",
    );
    assert.equal(broken.getAttribute("aria-expanded"), "true");
    assert.equal(
      byClass(panel, "preview-scroll")[0].innerHTML,
      "",
      "no preview body remains",
    );
  });
});

test("previewing after a notice restores the ordinary preview", () => {
  setup(function ({ view, content, clock, doc }) {
    const good = link("#/doc/guide/intro.md#getting-started");
    const broken = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(broken);
    content.appendChild(good);
    view.tag(content);

    content.fire("pointerover", { target: broken, relatedTarget: null });
    clock.runAll();

    content.fire("pointerover", { target: good, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      null,
      "the notice mark is gone",
    );
    assert.equal(panel.getAttribute("aria-label"), PREVIEW_LABEL);
    assert.match(byClass(panel, "preview-scroll")[0].innerHTML, /<p>body<\/p>/);
  });
});

test("focusing a broken reference opens the notice as hovering does", () => {
  setup(function ({ view, content, clock }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("focusin", { target: anchor });

    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "keyboard users get the same delay",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
  });
});

test("hovering a reference to a chapter the document lost stays silent", () => {
  setup(function ({ view, content, clock, messages }) {
    // A stale artifact: the anchor survives in the route but no longer exists.
    const anchor = link("#/doc/guide/intro.md#gone");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.deepEqual(messages, []);
    assert.equal(view.isOpen(), false);
  });
});

/* ---------- hovering a document reference ---------- */

test("hovering a document reference opens the whole document", () => {
  setup(function ({ view, content, clock, doc }) {
    const anchor = link("#/doc/guide/intro.md");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "the open timer is armed",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");

    const panel = panelOf(doc);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      null,
      "an ordinary preview",
    );
    assert.match(textOf(panel), /Guide Introduction/, "the head names it");
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;
    assert.match(shown, /<h1>Guide Introduction<\/h1>/);
    assert.match(shown, /<p>body<\/p>/);
  });
});

test("a document preview opens a loading panel at once and fills it on arrival", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      assert.equal(
        view.isOpen(),
        true,
        "the panel opens before the document arrives",
      );
      const panel = panelOf(doc);
      assert.equal(panel.getAttribute(LOADING_ATTRIBUTE), "true");

      travelling.deliver(payload().get("guide/intro.md"));

      assert.equal(view.isOpen(), true, "the answer fills the panel");
      assert.equal(panel.getAttribute(LOADING_ATTRIBUTE), null);
      assert.match(
        byClass(panel, "preview-scroll")[0].innerHTML,
        /<p>body<\/p>/,
      );
    },
    { documents: travelling.store },
  );
});

test("a document answer for a hover the reader left behind opens nothing", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock }) {
      const anchor = link("#/doc/guide/intro.md");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(view.isOpen(), true, "the loading panel is up");

      content.fire("pointerout", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(view.isOpen(), false, "leaving closes the loading panel");

      travelling.deliver(payload().get("guide/intro.md"));

      assert.equal(
        view.isOpen(),
        false,
        "a panel for a link nobody points at any more would be a surprise",
      );
    },
    { documents: travelling.store },
  );
});

test("a document that never arrives turns the panel into an error notice", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(view.isOpen(), true);

      travelling.deliver(null);

      assert.equal(
        view.isOpen(),
        true,
        "a panel whose document fails says so instead of closing on the reader",
      );
      const panel = panelOf(doc);
      assert.equal(panel.getAttribute(ERROR_ATTRIBUTE), "true");
      assert.equal(panel.getAttribute(LOADING_ATTRIBUTE), null);
      assert.equal(panel.getAttribute("aria-busy"), null);
      assert.match(textOf(panel), /Preview failed to load\./);
      assert.match(textOf(panel), /retry/);
      assert.match(
        textOf(panel),
        /Guide Introduction/,
        "the head keeps the document's name",
      );
    },
    { documents: travelling.store },
  );
});

test("a document without the hovered chapter answers with the broken-reference notice", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#no-such-chapter");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(view.isOpen(), true, "the loading panel is up");

      travelling.deliver(payload().get("guide/intro.md"));

      const panel = panelOf(doc);
      assert.equal(
        panel.getAttribute(MISSING_ATTRIBUTE),
        "true",
        "a missing chapter sounds like a broken reference",
      );
      assert.equal(panel.getAttribute(LOADING_ATTRIBUTE), null);
      assert.equal(panel.getAttribute("aria-label"), MISSING_LABEL);
      assert.match(textOf(panel), /No chapter named /);
    },
    { documents: travelling.store },
  );
});

test("a reference the embedded payload does not hold stays silent", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/missing.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(
      view.isOpen(),
      false,
      "no request could produce a document the payload does not hold",
    );
  });
});

test("a broken reference hovered while a panel loads replaces the loading state", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock, doc }) {
      const loadingLink = link("#/doc/guide/intro.md#getting-started");
      const broken = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
      content.appendChild(loadingLink);
      content.appendChild(broken);
      view.tag(content);

      content.fire("pointerover", {
        target: loadingLink,
        relatedTarget: null,
      });
      clock.runAll();
      assert.equal(
        panelOf(doc).getAttribute(LOADING_ATTRIBUTE),
        "true",
        "the first hover is loading",
      );

      content.fire("pointerover", { target: broken, relatedTarget: null });
      clock.runAll();

      const panel = panelOf(doc);
      assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), "true");
      assert.equal(
        panel.getAttribute(LOADING_ATTRIBUTE),
        null,
        "the notice owns the panel; no loading mark survives it",
      );
      assert.equal(panel.getAttribute("aria-busy"), null);
    },
    { documents: travelling.store },
  );
});

test("a loading panel pinned by the reader keeps the pin once the document arrives", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      clickInside(panelOf(doc));

      travelling.deliver(payload().get("guide/intro.md"));

      assert.equal(view.isOpen(), true);
      assert.equal(
        view.isPinned(),
        true,
        "the pin the reader put on the loading panel survives the answer",
      );
      assert.match(textOf(panelOf(doc)), /Getting Started/);

      // And the pin holds: the pointer leaving must not take the panel away.
      content.fire("pointerout", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(view.isOpen(), true);
    },
    { documents: travelling.store },
  );
});

test("a broken reference without an anchor still opens the notice, not a document preview", () => {
  setup(function ({ view, content, clock, doc }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      "true",
      "the mark outranks the missing anchor",
    );
    assert.equal(
      byClass(panel, "preview-scroll")[0].innerHTML,
      "",
      "no document body is assembled for a notice",
    );
  });
});

/* ---------- sealed documents: the locked state and its password form ---------- */

/** A document as the build writes it when `encrypt` sealed it. */
function sealedDoc() {
  return {
    id: "guide/intro.md",
    path: "guide/intro.md",
    title: "Guide Introduction",
    html: "",
    toc: [],
    blocks: [],
    text: "",
    enc: {
      v: 1,
      kdf: "pbkdf2-sha256",
      iters: 600000,
      salt: "AAECAwQFBgcICQ==",
      nonce: "AAAAAAAAAAAA",
      ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  };
}

/** The document the password opens: the shape the store swaps in. */
function unlockedDoc() {
  return {
    id: "guide/intro.md",
    path: "guide/intro.md",
    title: "Guide Introduction",
    html: "<h2>Getting Started</h2><p>intro body</p>",
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
}

/** A public document beside the sealed one, for a pointer that moves on. */
function openDoc() {
  return {
    id: "guide/open.md",
    path: "guide/open.md",
    title: "Open",
    html: "<h2>Open Chapter</h2><p>open body</p>",
    toc: [{ id: "open-chapter", text: "Open Chapter", level: 2, children: [] }],
    blocks: [
      {
        id: "open-chapter",
        level: 2,
        parent: null,
        html: "<p>open body</p>",
        subtree: [0],
      },
    ],
    text: "open chapter open body",
  };
}

/** A store over `byId` that knows which documents are sealed, as the reader's does. */
function asLockingStore(byId) {
  return {
    peek(id) {
      return byId.get(id) || null;
    },
    get(id) {
      return Promise.resolve(byId.get(id) || null);
    },
    title(id) {
      const doc = byId.get(id);
      return doc && doc.title ? doc.title : null;
    },
    isEncrypted(id) {
      const doc = byId.get(id);
      return !!doc && !!doc.enc;
    },
    isLazy() {
      return false;
    },
  };
}

/** Let every microtask the unlock answers queued run to completion. */
async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await null;
  }
}

test("a reference into a sealed document opens the locked panel, not a preview", () => {
  const store = asLockingStore(new Map([["guide/intro.md", sealedDoc()]]));

  setup(
    function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      assert.equal(view.isOpen(), true, "the panel opens for a sealed target");
      const panel = panelOf(doc);
      assert.equal(panel.getAttribute(LOCKED_ATTRIBUTE), "true");
      assert.equal(
        panel.getAttribute(MISSING_ATTRIBUTE),
        null,
        "a sealed chapter is not a missing one",
      );
      assert.equal(panel.getAttribute(LOADING_ATTRIBUTE), null);
      assert.equal(panel.getAttribute(ERROR_ATTRIBUTE), null);
      assert.equal(panel.getAttribute("aria-label"), LOCKED_LABEL);
      assert.match(textOf(panel), /Chapter locked/);
      assert.match(
        textOf(panel),
        /Guide Introduction/,
        "the head names the document the payload still says in public",
      );
      assert.match(textOf(panel), /guide\/intro\.md/);

      assert.equal(byClass(panel, UNLOCK_FORM_CLASS).length, 1);
      const input = byClass(panel, UNLOCK_INPUT_CLASS)[0];
      assert.equal(input.getAttribute("type"), "password");
      assert.equal(
        byClass(panel, UNLOCK_SUBMIT_CLASS)[0].textContent,
        UNLOCK_SUBMIT_TEXT,
      );
      assert.equal(
        byClass(panel, UNLOCK_ERROR_CLASS)[0].hidden,
        true,
        "no error before any try",
      );
      assert.equal(
        byClass(panel, BODY_CLASS)[0].innerHTML,
        "",
        "no plaintext, whatever the form holds",
      );
    },
    { documents: store },
  );
});

test("the locked panel opens without fetching a document the manifest already marked", () => {
  const calls = [];
  const store = {
    peek() {
      return null;
    },
    get(id) {
      calls.push(id);
      return Promise.resolve(null);
    },
    title(id) {
      return id === "guide/intro.md" ? "Guide Introduction" : null;
    },
    isEncrypted(id) {
      return id === "guide/intro.md";
    },
    isLazy() {
      return true;
    },
  };

  setup(
    function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      const panel = panelOf(doc);
      assert.equal(panel.getAttribute(LOCKED_ATTRIBUTE), "true");
      assert.deepEqual(
        calls,
        [],
        "the manifest's mark is enough: no chunk travels before a password",
      );
      assert.match(textOf(panel), /Guide Introduction/);
    },
    { documents: store },
  );
});

test("a password the session holds opens the chapter without asking", async () => {
  const byId = new Map([["guide/intro.md", sealedDoc()]]);
  const store = asLockingStore(byId);
  const tries = [];

  await setup(
    async function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(
        panelOf(doc).getAttribute(LOCKED_ATTRIBUTE),
        "true",
        "the form is up first, whatever the session holds",
      );

      await settle();

      const panel = panelOf(doc);
      assert.equal(
        panel.getAttribute(LOCKED_ATTRIBUTE),
        null,
        "the quiet answer replaced the locked state",
      );
      assert.equal(panel.getAttribute("aria-label"), PREVIEW_LABEL);
      assert.match(
        byClass(panel, BODY_CLASS)[0].innerHTML,
        /intro body/,
        "the chapter the password opened is the ordinary preview",
      );
      assert.deepEqual(
        tries,
        ["密码 secret"],
        "the attempt went through the one door",
      );
    },
    {
      documents: store,
      passwordCandidates(id) {
        return id === "guide/intro.md" ? ["密码 secret"] : [];
      },
      onUnlock(id, password) {
        tries.push(password);
        byId.set(id, unlockedDoc());
        return Promise.resolve(true);
      },
    },
  );
});

test("quiet passwords that all fail leave the locked panel without an error", async () => {
  const store = asLockingStore(new Map([["guide/intro.md", sealedDoc()]]));
  const tries = [];

  await setup(
    async function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      await settle();

      const panel = panelOf(doc);
      assert.equal(
        panel.getAttribute(LOCKED_ATTRIBUTE),
        "true",
        "still asking, quietly",
      );
      assert.equal(
        byClass(panel, UNLOCK_ERROR_CLASS)[0].hidden,
        true,
        "a quiet failure is not an error the reader caused",
      );
      assert.deepEqual(tries, ["first", "second"], "every candidate, in order");
    },
    {
      documents: store,
      passwordCandidates() {
        return ["first", "second"];
      },
      onUnlock(_id, password) {
        tries.push(password);
        return Promise.resolve(false);
      },
    },
  );
});

test("a quiet answer for a hover the reader left behind opens nothing", async () => {
  const byId = new Map([
    ["guide/intro.md", sealedDoc()],
    ["guide/open.md", openDoc()],
  ]);
  const store = asLockingStore(byId);
  let release = null;

  await setup(
    async function ({ view, content, clock, doc }) {
      const sealed = link("#/doc/guide/intro.md#getting-started");
      const open = link("#/doc/guide/open.md#open-chapter");
      content.appendChild(sealed);
      content.appendChild(open);
      view.tag(content);

      content.fire("pointerover", { target: sealed, relatedTarget: null });
      clock.runAll();
      assert.equal(panelOf(doc).getAttribute(LOCKED_ATTRIBUTE), "true");

      content.fire("pointerout", { target: sealed, relatedTarget: null });
      content.fire("pointerover", { target: open, relatedTarget: null });
      clock.runAll();
      assert.match(
        byClass(panelOf(doc), BODY_CLASS)[0].innerHTML,
        /open body/,
        "the pointer moved on to a sound reference",
      );

      // Let the quiet attempt reach its first try, then hold the answer
      // until the pointer has chosen the sound reference for good.
      await settle();
      release();
      await settle();

      assert.equal(
        byClass(panelOf(doc), BODY_CLASS)[0].innerHTML.indexOf("open body") !==
          -1,
        true,
        "the panel shows what the pointer chose",
      );
      assert.equal(
        byClass(panelOf(doc), BODY_CLASS)[0].innerHTML.indexOf("intro body"),
        -1,
        "the abandoned answer opens nothing",
      );
    },
    {
      documents: store,
      passwordCandidates() {
        return ["密码 secret"];
      },
      onUnlock(id) {
        return new Promise(function (resolve) {
          release = function () {
            byId.set(id, unlockedDoc());
            resolve(true);
          };
        });
      },
    },
  );
});

test("submitting the form unlocks the document in place", async () => {
  const byId = new Map([["guide/intro.md", sealedDoc()]]);
  const store = asLockingStore(byId);
  const submits = [];

  await setup(
    async function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      const panel = panelOf(doc);
      const form = byClass(panel, UNLOCK_FORM_CLASS)[0];
      const input = byClass(panel, UNLOCK_INPUT_CLASS)[0];
      const button = byClass(panel, UNLOCK_SUBMIT_CLASS)[0];

      input.value = "密码 secret";
      form.fire("submit", { preventDefault() {} });

      assert.equal(
        input.disabled,
        true,
        "the form is busy while the attempt runs",
      );
      assert.equal(
        button.textContent,
        UNLOCK_BUSY_TEXT,
        "the button says what is happening",
      );

      await settle();

      const shown = panelOf(doc);
      assert.equal(
        shown.getAttribute(LOCKED_ATTRIBUTE),
        null,
        "the chapter took the panel",
      );
      assert.equal(shown.getAttribute("aria-label"), PREVIEW_LABEL);
      assert.match(
        byClass(shown, BODY_CLASS)[0].innerHTML,
        /intro body/,
        "the chapter the password opened is the ordinary preview",
      );
      assert.deepEqual(submits, ["密码 secret"]);
      assert.equal(
        input.value,
        "",
        "the password is cleared once it has opened the document",
      );
      assert.equal(
        input.disabled,
        false,
        "the busy state went with the attempt",
      );
    },
    {
      documents: store,
      onUnlock(id, password) {
        submits.push(password);
        byId.set(id, unlockedDoc());
        return Promise.resolve(true);
      },
    },
  );
});

test("a password that does not open the document reports itself and allows a retry", async () => {
  const byId = new Map([["guide/intro.md", sealedDoc()]]);
  const store = asLockingStore(byId);
  const attempts = [];

  await setup(
    async function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      const panel = panelOf(doc);
      const form = byClass(panel, UNLOCK_FORM_CLASS)[0];
      const input = byClass(panel, UNLOCK_INPUT_CLASS)[0];
      const error = byClass(panel, UNLOCK_ERROR_CLASS)[0];

      input.value = "not the password";
      form.fire("submit", { preventDefault() {} });
      await settle();

      assert.equal(
        panel.getAttribute(LOCKED_ATTRIBUTE),
        "true",
        "the panel stays with the form",
      );
      assert.equal(
        error.hidden,
        false,
        "the failure is named where the typing was",
      );
      assert.match(error.textContent, /did not unlock/);
      assert.equal(input.disabled, false, "the field is back for a retype");
      assert.equal(
        input.value,
        "not the password",
        "what the reader typed is kept for correcting",
      );

      input.fire("input", {});
      assert.equal(
        error.hidden,
        true,
        "typing clears the failed attempt's answer",
      );

      input.value = "密码 secret";
      form.fire("submit", { preventDefault() {} });
      await settle();

      assert.equal(
        panelOf(doc).getAttribute(LOCKED_ATTRIBUTE),
        null,
        "the second try opened it",
      );
      assert.match(
        byClass(panelOf(doc), BODY_CLASS)[0].innerHTML,
        /intro body/,
      );
      assert.deepEqual(attempts, ["not the password", "密码 secret"]);
    },
    {
      documents: store,
      onUnlock(id, password) {
        attempts.push(password);
        if (password === "密码 secret") {
          byId.set(id, unlockedDoc());
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      },
    },
  );
});

test("a no that arrives after the document opened elsewhere is no failure", async () => {
  const byId = new Map([["guide/intro.md", sealedDoc()]]);
  const store = asLockingStore(byId);

  await setup(
    async function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      const panel = panelOf(doc);
      const form = byClass(panel, UNLOCK_FORM_CLASS)[0];
      const input = byClass(panel, UNLOCK_INPUT_CLASS)[0];

      input.value = "密码 secret";
      form.fire("submit", { preventDefault() {} });
      await settle();

      assert.equal(
        panel.getAttribute(LOCKED_ATTRIBUTE),
        null,
        "the document is open, whatever the answer said",
      );
      assert.match(byClass(panel, BODY_CLASS)[0].innerHTML, /intro body/);
      assert.equal(
        byClass(panel, UNLOCK_ERROR_CLASS)[0].hidden,
        true,
        "no error claims the password failed",
      );
    },
    {
      documents: store,
      // The quiet attempt won the race while the reader was still typing:
      // the document is the full model now, and the store's decrypt — the
      // door this answer came from — replies "no" to a document that is no
      // longer sealed.
      onUnlock(id) {
        byId.set(id, unlockedDoc());
        return Promise.resolve(false);
      },
    },
  );
});

test("an empty password asks for nothing", async () => {
  const store = asLockingStore(new Map([["guide/intro.md", sealedDoc()]]));
  const attempts = [];

  await setup(
    async function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      const panel = panelOf(doc);
      const form = byClass(panel, UNLOCK_FORM_CLASS)[0];
      const input = byClass(panel, UNLOCK_INPUT_CLASS)[0];

      form.fire("submit", { preventDefault() {} });
      await settle();

      assert.deepEqual(attempts, [], "nothing to try, nothing tried");
      assert.equal(panel.getAttribute(LOCKED_ATTRIBUTE), "true");
      assert.equal(
        byClass(panel, UNLOCK_ERROR_CLASS)[0].hidden,
        true,
        "an empty field is not a failure",
      );
      assert.equal(input.disabled, false);
    },
    {
      documents: store,
      onUnlock(_id, password) {
        attempts.push(password);
        return Promise.resolve(true);
      },
    },
  );
});

test("closing the panel clears the locked state's form", async () => {
  const store = asLockingStore(new Map([["guide/intro.md", sealedDoc()]]));

  await setup(
    async function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      const panel = panelOf(doc);
      const form = byClass(panel, UNLOCK_FORM_CLASS)[0];
      const input = byClass(panel, UNLOCK_INPUT_CLASS)[0];
      const error = byClass(panel, UNLOCK_ERROR_CLASS)[0];

      input.value = "half typed";
      form.fire("submit", { preventDefault() {} });
      await settle();
      assert.equal(error.hidden, false, "the try failed, the line is up");

      view.close();
      assert.equal(view.isOpen(), false);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      assert.equal(view.isOpen(), true, "the next hover starts clean");
      assert.equal(input.value, "", "no password survives the close");
      assert.equal(error.hidden, true, "no failed answer survives the close");
      assert.equal(input.disabled, false, "no busy state survives the close");
    },
    {
      documents: store,
      onUnlock() {
        return Promise.resolve(false);
      },
    },
  );
});

test("escape closes the locked panel like any other", () => {
  const store = asLockingStore(new Map([["guide/intro.md", sealedDoc()]]));

  setup(
    function ({ view, content, clock, fire }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      assert.equal(view.isOpen(), true);

      fire("keydown", { key: "Escape" });
      assert.equal(view.isOpen(), false, "the panel is closed on purpose");
    },
    { documents: store },
  );
});

test("reaching for the password field claims the panel", () => {
  const store = asLockingStore(new Map([["guide/intro.md", sealedDoc()]]));

  setup(
    function ({ view, content, clock, doc }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();

      const panel = panelOf(doc);
      const input = byClass(panel, UNLOCK_INPUT_CLASS)[0];

      assert.equal(view.isPinned(), false, "a hover is not a claim");
      clickInside(panel, input);
      assert.equal(
        view.isPinned(),
        true,
        "typing into the panel is the reader holding it",
      );
    },
    { documents: store },
  );
});
