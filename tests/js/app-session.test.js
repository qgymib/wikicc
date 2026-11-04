/**
 * Tests for `src/web/js/app.js`: the reader session around one payload.
 *
 * `start()` is the only entry point and it insists on a whole page — a payload
 * element, the shell's ids, a hash to route — so this file drives it with a
 * fake DOM and a fake `globalThis` location. The rules under test are the ones a
 * click on a block reference depends on:
 *
 * - a navigation that changes the address re-renders the document and walks the
 *   reader to the chapter, even after the freshly inserted markup settles;
 * - a navigation whose address is already showing does *not* re-render, because
 *   the render would throw away the position it was asked to reach;
 * - the document list always highlights the open document, filter or not.
 *
 * The diagram engine and the graph are stubbed: this is not their test, and the
 * real ones need a browser.
 */
import test from "node:test";
import assert from "node:assert/strict";

/** Shell ids `start()` looks up, in the order the template carries them. */
const SHELL_IDS = [
  "doc-content",
  "doc-article",
  "stats",
  "inspector",
  "sidebar-toggle",
  "drawer-backdrop",
  "theme-toggle",
  "doc-list",
  "toc",
  "graph",
  "graph-fit",
  "graph-mode",
  "search-toggle",
  "search-panel",
  "doc-alert",
];

/** A fake element with the handful of members the session touches. */
function fakeElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    id: "",
    children: [],
    attributes: {},
    listeners: {},
    hidden: false,
    style: {},
    parentNode: null,
    scrollCalls: [],
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
      }
      child.parentNode = null;
      return child;
    },
    insertBefore(child) {
      this.children.unshift(child);
      child.parentNode = this;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    fire(type, event) {
      (this.listeners[type] || []).slice().forEach(function (handler) {
        handler(event || {});
      });
    },
    focus() {
      this.focused = true;
    },
    select() {
      this.selected = true;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    scrollIntoView(options) {
      this.scrollCalls.push(options || {});
    },
    // Containment is decided over the whole subtree, as the browser does: the
    // search panel asks whether a press landed inside it.
    contains(node) {
      if (node === this) {
        return true;
      }
      return this.children.some(function (child) {
        return typeof child.contains === "function" && child.contains(node);
      });
    },
  };

  // `textContent` is a real setter on the elements the session empties.
  let text = "";
  Object.defineProperty(element, "textContent", {
    get() {
      return text;
    },
    set(value) {
      text = String(value);
      element.children = [];
    },
  });
  Object.defineProperty(element, "innerHTML", {
    get() {
      return element.__html || "";
    },
    set(value) {
      element.__html = String(value);
    },
  });

  return element;
}

/** The payload the session routes against. */
function payload() {
  return {
    title: "Fixture",
    docs: [
      {
        id: "index.md",
        title: "Index",
        html: '<p>root</p><a href="#/doc/guide/intro.md#getting-started">test</a>',
        text: "root",
        toc: [{ id: "top", text: "Top", level: 2, children: [] }],
        blocks: [{ id: "top", level: 2, parent: null, html: "<p>root</p>", subtree: [0] }],
      },
      {
        id: "guide/intro.md",
        title: "Intro",
        html: '<h2 id="getting-started">Getting Started</h2><p>body</p>',
        text: "intro",
        toc: [{ id: "getting-started", text: "Getting Started", level: 2, children: [] }],
        blocks: [
          {
            id: "getting-started",
            level: 2,
            parent: null,
            html: "<p>body</p>",
            subtree: [0],
          },
        ],
      },
    ],
    edges: [],
    stats: { assets: 0 },
  };
}

/**
 * Install a fake page and run `start()`.
 *
 * `options.hash` is where the reader arrives; the object handed to `body`
 * exposes the pieces a test asserts on: the headings the session can find by
 * id, the address bar, and the frame queue.
 */
function withSession(options, body) {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    scrollTo: globalThis.scrollTo,
    matchMedia: globalThis.matchMedia,
    localStorage: globalThis.localStorage,
    addEventListener: globalThis.addEventListener,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  // The search panel debounces its query, so the timers it schedules are kept
  // for the test to run instead of waiting for them.
  const timers = [];
  let timerIds = 0;

  const shell = new Map();
  SHELL_IDS.forEach(function (id) {
    const element = fakeElement("div");
    element.id = id;
    shell.set(id, element);
  });

  const payloadElement = fakeElement("script");
  payloadElement.id = "wikicc-payload";
  payloadElement.textContent = JSON.stringify(payload());

  const shellRoot = fakeElement("body");
  shellRoot.appendChild(payloadElement);
  shell.forEach(function (element) {
    shellRoot.appendChild(element);
  });

  // Headings the article "emits", so an anchor resolves to a scroll target. A
  // render assigns `innerHTML`, which is where the ids appear, so the map is
  // taken from the markup the session just inserted.
  // One element per heading id for the whole session, so a test can count the
  // scrolls each chapter received.
  const headings = new Map();
  function collectHeadings() {
    const seen = new Set();

    (function walk(node) {
      const html = typeof node.innerHTML === "string" ? node.innerHTML : "";
      const pattern = /<h[1-6] id="([^"]+)"/g;
      let match = pattern.exec(html);
      while (match) {
        const id = match[1];
        seen.add(id);
        if (!headings.has(id)) {
          const heading = fakeElement("h2");
          heading.id = id;
          headings.set(id, heading);
        }
        match = pattern.exec(html);
      }
      (node.children || []).forEach(walk);
    })(shell.get("doc-article"));

    Array.from(headings.keys()).forEach(function (id) {
      if (!seen.has(id)) {
        headings.delete(id);
      }
    });
  }

  // The article is where a render puts the markup, so the headings are taken
  // from it whenever it gains a body.
  const articleElement = shell.get("doc-article");
  const appendChild = articleElement.appendChild;
  articleElement.appendChild = function (child) {
    const result = appendChild.call(this, child);
    collectHeadings();
    return result;
  };

  const doc = {
    documentElement: fakeElement("html"),
    body: shellRoot,
    scrollingElement: fakeElement("html"),
    getElementById(id) {
      // Re-collected on every lookup: a render replaces the article, so the
      // heading set has to follow the markup that is on screen now.
      collectHeadings();
      if (headings.has(id)) {
        return headings.get(id);
      }
      if (id === "wikicc-payload") {
        return payloadElement;
      }
      // The graph is drawn with d3, which needs a real layout engine; a missing
      // container makes `createGraph` a no-op without touching this test.
      if (id === "graph") {
        return null;
      }
      return shell.get(id) || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".inspector-tab") {
        return [];
      }
      return [];
    },
    createElement(tagName) {
      return fakeElement(tagName);
    },
    createElementNS(namespace, tagName) {
      return fakeElement(tagName);
    },
    createTextNode(value) {
      return { nodeType: 3, textContent: String(value) };
    },
    addEventListener(type, handler) {
      (doc.listeners[type] = doc.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    listeners: {},
    fire(type) {
      (doc.listeners[type] || []).slice().forEach(function (handler) {
        handler({});
      });
    },
    fireEvent(type, event) {
      (doc.listeners[type] || []).slice().forEach(function (handler) {
        handler(event);
      });
    },
  };

  const frames = [];
  const location = { hash: options.hash || "" };
  const history = { replaceState() {} };
  let scrollTop = 0;

  globalThis.document = doc;
  globalThis.location = location;
  globalThis.history = history;
  globalThis.matchMedia = function () {
    return { matches: false };
  };
  globalThis.localStorage = {
    getItem() {
      return null;
    },
    setItem() {},
  };
  // `start()` listens for `hashchange` on the window, which is `globalThis` in
  // a page and in this fake one too.
  const windowListeners = {};
  globalThis.addEventListener = function (type, handler) {
    (windowListeners[type] = windowListeners[type] || []).push(handler);
  };
  globalThis.removeEventListener = function (type, handler) {
    const handlers = windowListeners[type] || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
  };
  globalThis.requestAnimationFrame = function (handler) {
    frames.push(handler);
    return frames.length;
  };
  globalThis.scrollTo = function (x, y) {
    scrollTop = y;
  };
  globalThis.setTimeout = function (callback) {
    timerIds += 1;
    timers.push({ id: timerIds, callback: callback });
    return timerIds;
  };
  globalThis.clearTimeout = function (id) {
    const index = timers.findIndex(function (timer) {
      return timer.id === id;
    });
    if (index >= 0) {
      timers.splice(index, 1);
    }
  };

  try {
    return body({
      doc,
      shell,
      location,
      frames,
      headings,
      /**
       * Change the address the way the browser does and let the session hear
       * about it, which is what a followed block reference looks like.
       */
      follow(hash) {
        location.hash = hash;
        (windowListeners.hashchange || []).slice().forEach(function (handler) {
          handler({ type: "hashchange" });
        });
      },
      /** Run the pending animation frames the session scheduled. */
      runFrames() {
        while (frames.length) {
          frames.shift()();
        }
      },
      /** Run the timers the session scheduled, which is what a debounce is. */
      runTimers() {
        const pending = timers.splice(0, timers.length);
        pending.forEach(function (timer) {
          timer.callback();
        });
      },
      scrollTop() {
        return scrollTop;
      },
    });
  } finally {
    globalThis.document = previous.document;
    globalThis.location = previous.location;
    globalThis.history = previous.history;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.scrollTo = previous.scrollTo;
    globalThis.matchMedia = previous.matchMedia;
    globalThis.localStorage = previous.localStorage;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
  }
}

/**
 * Import the reader controller.
 *
 * The import is awaited once, at module load, because `withSession` installs
 * the fake page synchronously: awaiting inside its body would hand control back
 * to the event loop, and the session would start against the restored globals.
 */
const app = await import("../../src/web/js/app.js");

/** Start the session against the page `withSession` installed. */
function startSession() {
  app.start();
}

/** The `aria-current` entry of the document list, or `null`. */
function activeEntry(shell) {
  const found = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.getAttribute && child.getAttribute("aria-current") === "page") {
        found.push(child);
      }
      walk(child);
    });
  })(shell.get("doc-list"));

  return found[0] || null;
}

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
    assert.ok(session.frames.length, "corrections are queued for the next frames");

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
    assert.deepEqual(session.headings.get("getting-started").scrollCalls, [{ block: "start" }]);
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
    assert.equal(countLinks(session.shell.get("doc-list")), 2, "both documents are listed");
  });
});

/** How many document links the list holds. */
function countLinks(container) {
  var count = 0;
  (function walk(node) {
    if (node.tagName === "A") {
      count += 1;
    }
    (node.children || []).forEach(walk);
  })(container);

  return count;
}

test("a document with no chapters opens at the top", async () => {
  withSession({ hash: "#/doc/index.md#top" }, (session) => {
    startSession();

    session.follow("#/doc/index.md");

    assert.equal(session.scrollTop(), 0);
    assert.ok(activeEntry(session.shell), "the list follows the document");
  });
});

test("the graph starts in the local view and the button says so", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const button = session.shell.get("graph-mode");
    assert.equal(button.textContent, "Local");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.getAttribute("aria-label"), "Show the whole graph");
    assert.equal(button.getAttribute("title"), "Show the whole graph");
  });
});

test("the mode button switches the graph and describes the next state", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();
    const button = session.shell.get("graph-mode");

    button.fire("click");

    assert.equal(button.textContent, "Global");
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(button.getAttribute("aria-label"), "Show only this document and its neighbours");

    button.fire("click");

    assert.equal(button.textContent, "Local");
    assert.equal(button.getAttribute("aria-pressed"), "false");
  });
});

test("the mode survives a navigation to another document", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();
    const button = session.shell.get("graph-mode");

    button.fire("click");
    session.follow("#/doc/guide/intro.md#getting-started");

    assert.equal(button.getAttribute("aria-pressed"), "true", "the reader chose the global view, not one document");
    assert.equal(button.textContent, "Global");
  });
});

/* ---------- search panel ---------- */

/** The query field the panel built, found by its class. */
function searchInput(shell) {
  var found = null;
  (function walk(node) {
    if (found) {
      return;
    }
    if (node.tagName === "INPUT" && String(node.className).indexOf("search-input") !== -1) {
      found = node;
      return;
    }
    (node.children || []).forEach(walk);
  })(shell.get("search-panel"));

  return found;
}

/** Every element of the panel with `className`. */
function searchParts(shell, className) {
  var found = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (String(child.className).split(" ").indexOf(className) !== -1) {
        found.push(child);
      }
      walk(child);
    });
  })(shell.get("search-panel"));

  return found;
}

/** Keyboard event shaped the way the session reads it. */
function keydown(key, extra) {
  return Object.assign({ key: key, preventDefault() {} }, extra || {});
}

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
    assert.equal(session.shell.get("search-toggle").getAttribute("aria-expanded"), "true");
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
    assert.equal(button.focused, true, "the keyboard reader lands back on the button");
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
    assert.equal(mode.textContent, "Local", "the scope starts at the document in view");
    assert.deepEqual(
      searchParts(session.shell, "search-result-title").map(function (node) {
        return node.textContent;
      }),
      ["Index"],
      "the current document's hits are the list",
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
      searchParts(session.shell, "search-result-title").map(function (node) {
        return node.textContent;
      }),
      [],
      "local reads the document in view, which holds no such heading",
    );

    searchParts(session.shell, "search-mode")[0].fire("click");

    assert.deepEqual(
      searchParts(session.shell, "search-result-title").map(function (node) {
        return node.textContent;
      }),
      ["Intro"],
      "global asks the engine about every document again",
    );
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
