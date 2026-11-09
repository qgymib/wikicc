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
 * - the document list always highlights the open document, filter or not;
 * - a search result opened with `Enter` walks the reader to the passage it
 *   named, and the marks of that arrival go when the reading moves on.
 *
 * The diagram engine and the graph are stubbed: this is not their test, and the
 * real ones need a browser.
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * The real timer, captured before any session replaces `globalThis.setTimeout`
 * with its own: settling a fetched document needs a genuine macrotask.
 */
const realSetTimeout = globalThis.setTimeout;

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
    replaceChild(next, child) {
      const index = this.children.indexOf(child);
      if (index < 0) {
        return child;
      }
      this.children[index] = next;
      next.parentNode = this;
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
      return Object.hasOwn(this.attributes, name);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
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
    /**
     * Answer a selector over this element's subtree.
     *
     * The session asks two questions — the article's document body by class,
     * and the inspector's tabs — so both are honoured over children, which is
     * the shape the browser answers them in.
     */
    querySelector(selector) {
      const found = this.querySelectorAll(selector);
      return found.length ? found[0] : null;
    },
    querySelectorAll(selector) {
      const found = [];
      const wanted = String(selector).replace(/^\./, "");

      if (String(selector).indexOf(".") === 0) {
        (function walk(node) {
          (node.children || []).forEach(function (child) {
            if (String(child.className).split(" ").indexOf(wanted) !== -1) {
              found.push(child);
            }
            walk(child);
          });
        })(this);
      }

      return found;
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

  // `classList` reads and writes the same `className` string the browser's
  // does, so a module that adds a class is visible to a selector asking for it.
  element.classList = {
    add(name) {
      const parts = String(element.className).split(" ").filter(Boolean);
      if (parts.indexOf(name) === -1) {
        parts.push(name);
      }
      element.className = parts.join(" ");
    },
    remove(name) {
      element.className = String(element.className)
        .split(" ")
        .filter(function (part) {
          return part && part !== name;
        })
        .join(" ");
    },
    contains(name) {
      return String(element.className).split(" ").indexOf(name) !== -1;
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
      // The browser parses markup into children, and the search jump's
      // highlight walks those children; the fake parses the same way the
      // build's own markup asks for. The string stays on `__html` for the
      // tests that read the markup back.
      element.children = [];
      parseInto(element, String(value));
    },
  });

  return element;
}

/**
 * Parse the tags of `html` into children of `root`.
 *
 * Ported from the search panel's own fake, and deliberately just as minimal:
 * every tag opens or closes, nothing is void, and attributes matter only as
 * far as the class name. That is exactly what the build emits for a document
 * body, and anything more would be a parser the tests then have to trust.
 */
function parseInto(root, html) {
  const open = [root];
  const pattern = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let match = pattern.exec(html);

  while (match) {
    if (match[4] !== undefined) {
      if (match[4]) {
        open[open.length - 1].appendChild(textNode(decodeText(match[4])));
      }
    } else if (match[1]) {
      if (open.length > 1) {
        open.pop();
      }
    } else {
      const node = fakeElement(match[2]);
      const attribute = /([a-zA-Z-]+)="([^"]*)"/g;
      let found = attribute.exec(match[3] || "");

      while (found) {
        node.setAttribute(found[1], found[2]);
        if (found[1] === "class") {
          node.className = found[2];
        }
        found = attribute.exec(match[3] || "");
      }

      open[open.length - 1].appendChild(node);
      open.push(node);
    }
    match = pattern.exec(html);
  }
}

/** The few entities the build writes into a body. */
function decodeText(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * A text node the way the search jump's highlight meets it.
 *
 * `splitText` is the one member the highlight's cutting needs, and the walk
 * it serves is live: the halves a cut leaves behind are visited where a
 * browser would visit them, because the slot numbering depends on that
 * behaviour rather than on a snapshot of it.
 */
function textNode(value) {
  const node = {
    nodeType: 3,
    tagName: "#text",
    children: [],
    parentNode: null,
  };
  let text = String(value);

  Object.defineProperty(node, "textContent", {
    get() {
      return text;
    },
    set(next) {
      text = String(next);
    },
  });

  Object.defineProperty(node, "nodeValue", {
    get() {
      return text;
    },
    set(next) {
      text = String(next);
    },
  });

  node.splitText = function (offset) {
    if (!node.parentNode) {
      return node;
    }

    const tail = textNode(text.slice(offset));
    node.textContent = text.slice(0, offset);

    const parent = node.parentNode;
    const index = parent.children.indexOf(node);
    parent.children.splice(index + 1, 0, tail);
    tail.parentNode = parent;

    return tail;
  };

  return node;
}

/**
 * A walker over the text nodes below `root`, in document order.
 *
 * Live, as the browser's own is: nodes that enter the tree while it runs —
 * the halves `splitText` leaves behind, the text a fresh mark now holds —
 * are visited where a browser would visit them.
 */
function treeWalker(root) {
  /** The node the walk last returned, or the root before the first ask. */
  let current = root;

  /** The first text node below `node`, or `null`. */
  function firstText(node) {
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      if (child.nodeType === 3) {
        return child;
      }
      const found = firstText(child);
      if (found) {
        return found;
      }
    }

    return null;
  }

  /** The next text node from `node`'s position onward, or `null` at the end. */
  function nextFrom(node) {
    if (node.nodeType !== 3) {
      const inner = firstText(node);
      if (inner) {
        return inner;
      }
    }

    let parent = node.parentNode;
    while (parent) {
      const siblings = parent.children;
      for (
        let index = siblings.indexOf(node) + 1;
        index < siblings.length;
        index += 1
      ) {
        if (siblings[index].nodeType === 3) {
          return siblings[index];
        }
        const found = firstText(siblings[index]);
        if (found) {
          return found;
        }
      }

      node = parent;
      if (node === root) {
        return null;
      }
      parent = node.parentNode;
    }

    return null;
  }

  return {
    nextNode() {
      current = nextFrom(current);
      return current;
    },
  };
}

/** Every `<mark>` below `root`, in document order. */
function marksOf(root) {
  const found = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.tagName === "MARK") {
        found.push(child);
      }
      walk(child);
    });
  })(root);
  return found;
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
        blocks: [
          {
            id: "top",
            level: 2,
            parent: null,
            html: "<p>root</p>",
            subtree: [0],
          },
        ],
      },
      {
        id: "guide/intro.md",
        title: "Intro",
        html: '<h2 id="getting-started">Getting Started</h2><p>body</p>',
        text: "intro",
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
 * The manifest the pages format embeds: one reference per document, no
 * bodies — the documents themselves travel in `pages/` files.
 */
function lazyManifest() {
  return {
    title: "Fixture",
    mode: "pages",
    docs: [
      { id: "index.md", title: "Index", hash: "h0" },
      { id: "guide/intro.md", title: "Intro", hash: "h1" },
    ],
    edges: [],
    stats: { documents: 2, assets: 0 },
  };
}

/** The chunks the build wrote next to the shell, keyed by their URLs. */
function lazyChunks() {
  return {
    "pages/index.md.json?v=h0": {
      id: "index.md",
      title: "Index",
      html: "<p>root</p>",
      toc: [],
      blocks: [],
      text: "root",
    },
    "pages/guide/intro.md.json?v=h1": {
      id: "guide/intro.md",
      title: "Intro",
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
          html: "<p>body</p>",
          subtree: [0],
        },
      ],
      text: "intro",
    },
  };
}

/** The search corpus the build wrote next to the shell. */
function lazyCorpus() {
  return {
    docs: [
      { id: "index.md", title: "Index", headings: "", text: "root" },
      {
        id: "guide/intro.md",
        title: "Intro",
        headings: "Getting Started",
        text: "intro",
      },
    ],
  };
}

/**
 * Install a fake page and run `start()`.
 *
 * `options.hash` is where the reader arrives; `options.lazy` swaps the
 * embedded payload for the pages manifest and serves its chunks through
 * `options.fetchImpl` (or, with `options.broken`, serves nothing). The object
 * handed to `body` exposes the pieces a test asserts on: the headings the
 * session can find by id, the address bar, and the frame queue.
 */
async function withSession(options, body) {
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
    fetch: globalThis.fetch,
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
  payloadElement.textContent = JSON.stringify(
    options.lazy ? lazyManifest() : payload(),
  );

  const shellRoot = fakeElement("body");
  shellRoot.appendChild(payloadElement);
  shell.forEach(function (element) {
    shellRoot.appendChild(element);
  });

  // The pages session fetches its documents; the requests are recorded
  // so a test can see what the reader asked for.
  const fetchCalls = [];
  if (options.lazy) {
    const chunks = options.broken ? {} : lazyChunks();
    if (!options.broken) {
      chunks["search.json"] = lazyCorpus();
    }
    globalThis.fetch = function (url) {
      fetchCalls.push(url);
      const body = Object.hasOwn(chunks, url) ? chunks[url] : null;
      return Promise.resolve({
        ok: body !== null,
        json() {
          return Promise.resolve(body);
        },
      });
    };
  }

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
    createElementNS(_namespace, tagName) {
      return fakeElement(tagName);
    },
    createTextNode(value) {
      return textNode(value);
    },
    createTreeWalker(root) {
      return treeWalker(root);
    },
    addEventListener(type, handler) {
      if (!doc.listeners[type]) {
        doc.listeners[type] = [];
      }
      doc.listeners[type].push(handler);
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
    if (!windowListeners[type]) {
      windowListeners[type] = [];
    }
    windowListeners[type].push(handler);
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
  globalThis.scrollTo = function (_x, y) {
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
    return await body({
      doc,
      shell,
      location,
      frames,
      headings,
      fetchCalls,
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
      /**
       * Let every pending promise settle, which is what a fetched document
       * waits for before it reaches the article.
       */
      settle() {
        return new Promise((resolve) => realSetTimeout(resolve, 0));
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
    globalThis.fetch = previous.fetch;
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
    assert.equal(
      button.getAttribute("aria-label"),
      "Show only this document and its neighbours",
    );

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

    assert.equal(
      button.getAttribute("aria-pressed"),
      "true",
      "the reader chose the global view, not one document",
    );
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
    if (
      node.tagName === "INPUT" &&
      String(node.className).indexOf("search-input") !== -1
    ) {
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

/* ---------- pages session ---------- */

/** Every text node below `node`, joined with spaces. */
function textOf(node) {
  const parts = [];
  (function walk(current) {
    (current.children || []).forEach(function (child) {
      if (child.nodeType === 3) {
        parts.push(String(child.textContent));
        return;
      }
      walk(child);
    });
  })(node);
  return parts.join(" ");
}

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
