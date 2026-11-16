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

import {
  DOC_LINK_ATTRIBUTE,
  DOC_LINK_SELECTOR,
} from "../../src/web/js/links.js";

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
  "sidebar-collapse",
  "graph-local-toggle",
  "graph-global-toggle",
  "outline-toggle",
  "drawer-backdrop",
  "theme-toggle",
  "doc-list",
  "toc",
  "graph-local",
  "graph-global",
  "graph-fit-local",
  "graph-fit-global",
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
     * The session asks one question by class — the article's document body —
     * so it is honoured over children, which is the shape the browser answers
     * it in.
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

      // The hover preview tags its links and asks for them by the tag and
      // attribute every route carries, which is the one other selector the
      // reader's views ask of this fake.
      if (String(selector) === "a[href]") {
        (function walk(node) {
          (node.children || []).forEach(function (child) {
            if (child.tagName === "A" && child.getAttribute("href") !== null) {
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
    // The hover preview's handlers find the link an event started on by the
    // mark the tag step wrote on it; the two selectors a real `closest` is
    // asked here are the link mark and the head's buttons.
    closest(selector) {
      if (selector === "button") {
        return this.tagName === "BUTTON" ? this : null;
      }
      if (selector !== DOC_LINK_SELECTOR) {
        return null;
      }
      const tagged = Object.hasOwn(this.attributes, DOC_LINK_ATTRIBUTE);
      return this.tagName === "A" && tagged ? this : null;
    },
    // The preview's placement measures the link it describes; one fixed
    // rectangle keeps the panel beside the link instead of inside it.
    getBoundingClientRect() {
      return {
        top: 100,
        bottom: 120,
        left: 40,
        right: 160,
        width: 120,
        height: 20,
      };
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
 * `options.fetchImpl` (or, with `options.broken`, serves nothing); `options.drawer`
 * holds the session at the width where the document list is a drawer; and
 * `options.storage` seeds the fake `localStorage`, whose map comes back on the
 * session so a test can read what the reader wrote. The object handed to
 * `body` exposes the pieces a test asserts on: the headings the session can
 * find by id, the address bar, and the frame queue.
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
  // `options.docs` swaps the embedded payload's documents (a test that needs
  // a sealed document builds one here); `options.payload` replaces the whole
  // payload, which is how a pages test seeds its own manifest.
  const embedded = options.docs
    ? Object.assign(payload(), { docs: options.docs })
    : null;
  payloadElement.textContent = JSON.stringify(
    embedded || options.payload || (options.lazy ? lazyManifest() : payload()),
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
    // `options.chunks` seeds a manifest's chunks of its own; without one the
    // stock chunks and the stock corpus serve, and `broken` serves nothing.
    const chunks = options.chunks || (options.broken ? {} : lazyChunks());
    if (!options.chunks && !options.broken) {
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
      // The graphs are drawn with d3, which needs a real layout engine; a
      // missing container makes `createLocalGraph` and `createGlobalGraph`
      // no-ops without touching this test.
      if (id === "graph-local" || id === "graph-global") {
        return null;
      }
      return shell.get(id) || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
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

  // The preview panel's placement reads the viewport through the document
  // element when the window has no inner size, as this fake window has not.
  doc.documentElement.clientWidth = 1200;
  doc.documentElement.clientHeight = 800;

  const frames = [];
  const location = { hash: options.hash || "" };
  const history = { replaceState() {} };
  let scrollTop = 0;

  globalThis.document = doc;
  globalThis.location = location;
  globalThis.history = history;
  // The theme query stays light-hostile so the reader stays dark; a test that
  // sets `options.drawer` moves the session to the width where the document
  // list is a drawer, which is the only other query the session branches on.
  globalThis.matchMedia = function (query) {
    return {
      matches: Boolean(options.drawer) && query === "(max-width: 640px)",
    };
  };
  // The store starts empty; `options.storage` seeds it, and the same map is
  // handed back on the session for the tests that read a write back.
  const storageMap = options.storage || {};
  globalThis.localStorage = {
    getItem(key) {
      return Object.hasOwn(storageMap, key) ? storageMap[key] : null;
    },
    setItem(key, value) {
      storageMap[key] = String(value);
    },
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
      storage: storageMap,
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

test("the toggle puts the document list away and brings it back", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const toggle = session.shell.get("sidebar-collapse");

    assert.equal(
      body.getAttribute("data-sidebar"),
      null,
      "the list starts showing on a wide screen",
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Hide document list");

    toggle.fire("click");
    assert.equal(body.getAttribute("data-sidebar"), "hidden");
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      "false",
      "the toggle answers for the list it hid",
    );
    assert.equal(
      toggle.getAttribute("aria-label"),
      "Show document list",
      "the rail's switch now offers to bring the list back",
    );

    toggle.fire("click");
    assert.equal(body.getAttribute("data-sidebar"), null);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Hide document list");
  });
});

test("a navigation keeps the document list put away", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();
    session.shell.get("sidebar-collapse").fire("click");
    assert.equal(session.doc.body.getAttribute("data-sidebar"), "hidden");

    // Following a document closes only the drawer's state: the wide layout's
    // hidden column is the reader's choice, not a navigation side effect.
    session.follow("#/doc/guide/intro.md#getting-started");
    assert.equal(session.doc.body.getAttribute("data-sidebar"), "hidden");
    assert.equal(session.doc.body.getAttribute("data-drawer"), "closed");
  });
});

test("the narrow screen's toggle still drives the drawer", async () => {
  withSession({ hash: "#/doc/index.md", drawer: true }, (session) => {
    startSession();

    const body = session.doc.body;
    const toggle = session.shell.get("sidebar-toggle");

    assert.equal(body.getAttribute("data-drawer"), "closed");

    toggle.fire("click");
    assert.equal(body.getAttribute("data-drawer"), "open");
    assert.equal(
      body.getAttribute("data-sidebar"),
      null,
      "the drawer's switch never touches the wide layout's attribute",
    );

    toggle.fire("click");
    assert.equal(body.getAttribute("data-drawer"), "closed");
  });
});

test("the phone's switches trade the drawer's contents", async () => {
  withSession({ hash: "#/doc/index.md", drawer: true }, (session) => {
    startSession();

    const body = session.doc.body;
    const drawer = session.shell.get("sidebar-toggle");
    const outline = session.shell.get("outline-toggle");

    assert.equal(body.getAttribute("data-drawer"), "closed");

    outline.fire("click");
    assert.equal(
      body.getAttribute("data-drawer"),
      "open",
      "the outline's switch opens the drawer with the outline in it",
    );
    assert.equal(body.getAttribute("data-side-view"), "outline");
    assert.equal(
      body.getAttribute("data-sidebar"),
      null,
      "the drawer's switches never touch the wide layout's attribute",
    );

    drawer.fire("click");
    assert.equal(
      body.getAttribute("data-side-view"),
      "docs",
      "the drawer's toggle trades the outline for the list without closing",
    );
    assert.equal(body.getAttribute("data-drawer"), "open");

    drawer.fire("click");
    assert.equal(
      body.getAttribute("data-drawer"),
      "closed",
      "the toggle pressed again closes the drawer it opened",
    );

    outline.fire("click");
    assert.equal(body.getAttribute("data-drawer"), "open");
    assert.equal(body.getAttribute("data-side-view"), "outline");
  });
});

test("putting the list away writes the choice down", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const toggle = session.shell.get("sidebar-collapse");
    toggle.fire("click");
    assert.equal(session.storage["wikicc.sidebar"], "hidden");

    toggle.fire("click");
    assert.equal(session.storage["wikicc.sidebar"], "visible");
  });
});

test("the reader remembers the list was put away", async () => {
  withSession(
    { hash: "#/doc/index.md", storage: { "wikicc.sidebar": "hidden" } },
    (session) => {
      startSession();

      assert.equal(
        session.doc.body.getAttribute("data-sidebar"),
        "hidden",
        "the stored choice is applied when the session starts",
      );
      assert.equal(
        session.shell.get("sidebar-collapse").getAttribute("aria-expanded"),
        "false",
      );
    },
  );
});

test("the outline switch trades the list for the outline", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const outline = session.shell.get("outline-toggle");
    const collapse = session.shell.get("sidebar-collapse");

    assert.equal(
      body.getAttribute("data-side-view"),
      "docs",
      "the list is the view a page starts with",
    );
    assert.equal(outline.getAttribute("aria-expanded"), "false");
    assert.equal(outline.getAttribute("aria-label"), "Show outline panel");

    outline.fire("click");
    assert.equal(body.getAttribute("data-side-view"), "outline");
    assert.equal(
      body.getAttribute("data-sidebar"),
      null,
      "bringing the outline up never folds the column",
    );
    assert.equal(
      outline.getAttribute("aria-expanded"),
      "true",
      "the switch answers for the view it brought up",
    );
    assert.equal(outline.getAttribute("aria-label"), "Hide outline panel");
    assert.equal(
      collapse.getAttribute("aria-expanded"),
      "false",
      "the list's own switch now offers the list back",
    );
    assert.equal(collapse.getAttribute("aria-label"), "Show document list");

    outline.fire("click");
    assert.equal(
      body.getAttribute("data-sidebar"),
      "hidden",
      "the switch pressed again folds the whole column",
    );
    assert.equal(
      body.getAttribute("data-side-view"),
      "outline",
      "the view the reader chose is remembered while the column is away",
    );
    assert.equal(outline.getAttribute("aria-expanded"), "false");
    assert.equal(outline.getAttribute("aria-label"), "Show outline panel");

    outline.fire("click");
    assert.equal(body.getAttribute("data-sidebar"), null);
    assert.equal(
      body.getAttribute("data-side-view"),
      "outline",
      "the column comes back with the view it was folded in",
    );

    collapse.fire("click");
    assert.equal(
      body.getAttribute("data-side-view"),
      "docs",
      "the list's switch trades the outline for the list",
    );
    assert.equal(body.getAttribute("data-sidebar"), null);
    assert.equal(collapse.getAttribute("aria-expanded"), "true");
    assert.equal(collapse.getAttribute("aria-label"), "Hide document list");
    assert.equal(
      outline.getAttribute("aria-expanded"),
      "false",
      "the two switches never answer for the same view at once",
    );
  });
});

test("the side switches write their choices down", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const outline = session.shell.get("outline-toggle");
    const collapse = session.shell.get("sidebar-collapse");

    outline.fire("click");
    assert.equal(session.storage["wikicc.side-view"], "outline");

    outline.fire("click");
    assert.equal(
      session.storage["wikicc.sidebar"],
      "hidden",
      "folding the column is the sidebar's own choice, written where it always was",
    );
    assert.equal(
      session.storage["wikicc.side-view"],
      "outline",
      "the view survives the fold",
    );

    collapse.fire("click");
    assert.equal(session.storage["wikicc.side-view"], "docs");
    assert.equal(session.storage["wikicc.sidebar"], "visible");
  });
});

test("the reader remembers which side view was showing", async () => {
  withSession(
    { hash: "#/doc/index.md", storage: { "wikicc.side-view": "outline" } },
    (session) => {
      startSession();

      assert.equal(
        session.doc.body.getAttribute("data-side-view"),
        "outline",
        "the stored view is applied when the session starts",
      );
      assert.equal(
        session.shell.get("outline-toggle").getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(
        session.shell.get("sidebar-collapse").getAttribute("aria-expanded"),
        "false",
      );
    },
  );
});

test("the local view starts showing and both switches say so", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const local = session.shell.get("graph-local-toggle");
    const global = session.shell.get("graph-global-toggle");
    const outline = session.shell.get("outline-toggle");

    assert.equal(body.getAttribute("data-graph-view"), "local");
    assert.equal(body.getAttribute("data-graph"), null);
    assert.equal(local.getAttribute("aria-expanded"), "true");
    assert.equal(local.getAttribute("aria-label"), "Hide local graph");
    assert.equal(global.getAttribute("aria-expanded"), "false");
    assert.equal(global.getAttribute("aria-label"), "Show global graph");
    assert.equal(
      outline.getAttribute("aria-label"),
      "Show outline panel",
      "the side switches keep their own answer",
    );
  });
});

test("the graph's switches trade the views and fold the column", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const local = session.shell.get("graph-local-toggle");
    const global = session.shell.get("graph-global-toggle");

    // The other switch brings its view up and puts the first one away.
    global.fire("click");
    assert.equal(body.getAttribute("data-graph-view"), "global");
    assert.equal(body.getAttribute("data-graph"), null);
    assert.equal(global.getAttribute("aria-expanded"), "true");
    assert.equal(global.getAttribute("aria-label"), "Hide global graph");
    assert.equal(local.getAttribute("aria-expanded"), "false");
    assert.equal(local.getAttribute("aria-label"), "Show local graph");
    assert.equal(
      body.getAttribute("data-side-view"),
      "docs",
      "the graph's switches never touch the sidebar's view",
    );

    // The switch whose view is showing puts the column away.
    global.fire("click");
    assert.equal(body.getAttribute("data-graph"), "hidden");
    assert.equal(body.getAttribute("data-graph-view"), "global");
    assert.equal(global.getAttribute("aria-expanded"), "false");
    assert.equal(global.getAttribute("aria-label"), "Show global graph");
    assert.equal(local.getAttribute("aria-expanded"), "false");

    // A switch of the folded column brings its own view back.
    local.fire("click");
    assert.equal(body.getAttribute("data-graph"), null);
    assert.equal(body.getAttribute("data-graph-view"), "local");
    assert.equal(local.getAttribute("aria-expanded"), "true");
    assert.equal(local.getAttribute("aria-label"), "Hide local graph");

    // And its own switch folds it again.
    local.fire("click");
    assert.equal(body.getAttribute("data-graph"), "hidden");
    assert.equal(local.getAttribute("aria-expanded"), "false");
  });
});

test("the graph's switches keep no record of the fold", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    session.shell.get("graph-global-toggle").fire("click");
    session.shell.get("graph-global-toggle").fire("click");

    assert.equal(
      session.storage["wikicc.panels"],
      undefined,
      "no storage key is written for the graph's state",
    );
    assert.equal(
      session.doc.body.getAttribute("data-graph"),
      "hidden",
      "the fold holds for this visit only",
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

/* ---------- sealed documents ---------- */

/**
 * The blob the committed interop vector sealed `guide/intro.md` with — the
 * same constants `tests/js/lock.test.js` and `tests/js/doc-store.test.js`
 * pin, which `src/crypto.rs` keeps honest on the build side. Its plaintext
 * is the chapter-shaped body the outline and the anchor walk read.
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

/** The password both interop vectors answer to. */
const SEALED_PASSWORD = "密码 secret";

/** The embedded payload with two sealed documents beside the public one. */
function lockedDocs() {
  return [
    payload().docs[0],
    {
      id: "guide/intro.md",
      title: "Intro",
      html: "",
      text: "",
      toc: [],
      blocks: [],
      enc: SEALED_BLOB,
    },
    {
      id: "guide/other.md",
      title: "Other",
      html: "",
      text: "",
      toc: [],
      blocks: [],
      enc: OTHER_BLOB,
    },
  ];
}

/** The pages manifest marking its second document sealed. */
function lockedManifest() {
  return {
    title: "Fixture",
    mode: "pages",
    docs: [
      { id: "index.md", title: "Index", hash: "h0" },
      { id: "guide/intro.md", title: "Intro", hash: "h1", enc: true },
    ],
    edges: [],
    stats: { documents: 2, assets: 0 },
  };
}

/** The chunks the build wrote for the sealed pages fixture. */
function lockedChunks() {
  return {
    "pages/index.md.json?v=h0": {
      id: "index.md",
      title: "Index",
      // The reference the public page carries points into the sealed one, so
      // the preview tests can hover their way to the lock.
      html: '<p>root</p><a href="#/doc/guide/intro.md#getting-started">test</a>',
      toc: [],
      blocks: [],
      text: "root",
    },
    "pages/guide/intro.md.json?v=h1": {
      id: "guide/intro.md",
      title: "Intro",
      html: "",
      toc: [],
      blocks: [],
      text: "",
      enc: SEALED_BLOB,
    },
    // The corpus the build wrote for the sealed site: the sealed document
    // contributes its title alone, and nothing of its body.
    "search.json": {
      docs: [
        { id: "index.md", title: "Index", headings: "", text: "root" },
        { id: "guide/intro.md", title: "Intro" },
      ],
    },
  };
}

/**
 * Poll `probe` until it passes.
 *
 * A key derivation runs on Node's own Web Crypto, off the fake timer queue
 * the session installs, and takes real time at the shipped iteration count:
 * a fixed settle would race it. Five seconds is generous; a failure to
 * unlock by then is what the probe asserts anyway.
 */
async function waitFor(probe, what) {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for " + what);
    }
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
}

/** The lock page's password form, which is the one door the page carries. */
function lockedForm(article) {
  return article.children[3] || null;
}

/** The password field inside the lock page's form. */
function lockedInput(article) {
  const form = lockedForm(article);
  return form ? form.children[0].children[1] : null;
}

/** The line that reports a failed attempt on the lock page. */
function lockedError(article) {
  const form = lockedForm(article);
  return form ? form.children[2] : null;
}

/** Put `password` in the lock page's field and press its unlock action. */
function submitPassword(session, password) {
  const article = session.shell.get("doc-article");
  lockedInput(article).value = password;
  lockedForm(article).fire("submit", { preventDefault() {} });
}

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

/* ---------- sealed search ---------- */

/**
 * A word only the opened plaintext holds: the sealed corpus and the sealed
 * payload carry the title alone, so `body` answers nothing before the
 * password and the opened text `"getting started intro body"` answers it
 * after.
 */
const SEALED_BODY_WORD = "body";

/**
 * Ask the whole-site scope about `value`.
 *
 * Opens the panel if it is shut, puts the scope on the whole site, and lets
 * the debounce fire through the session's timers. Used across sessions that
 * may already hold an open panel, so both the open and the scope switch read
 * the state they find.
 */
function askGlobal(session, value) {
  const panel = session.shell.get("search-panel");
  if (panel.hidden) {
    session.shell.get("search-toggle").fire("click");
  }
  const mode = searchParts(session.shell, "search-mode")[0];
  if (mode.getAttribute("aria-pressed") !== "true") {
    mode.fire("click", { preventDefault() {} });
  }
  const input = searchInput(session.shell);
  input.value = value;
  input.fire("input", { target: input });
  session.runTimers();
}

/** The path cell of every row on screen. */
function resultPaths(session) {
  return searchParts(session.shell, "search-result-path").map(function (node) {
    return node.textContent;
  });
}

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

/* ---------- sealed references: the hover preview panel ---------- */

/** Every descendant of `root` whose class list carries `name`. */
function byClassIn(root, name) {
  const found = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (String(child.className).split(" ").indexOf(name) !== -1) {
        found.push(child);
      }
      walk(child);
    });
  })(root);
  return found;
}

/** The one popover the session built, or `null` before the first hover. */
function previewPanel(session) {
  return byClassIn(session.doc.body, "preview-popover")[0] || null;
}

/** The first `<a>` below `root`, which the payload's references are. */
function firstLink(root) {
  const found = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.tagName === "A") {
        found.push(child);
      }
      walk(child);
    });
  })(root);
  return found[0] || null;
}

/** Hover the one reference the public page carries, and open its panel. */
function hoverReference(session) {
  const article = session.shell.get("doc-article");
  const link = firstLink(article.children[1]);
  session.shell.get("doc-content").fire("pointerover", {
    target: link,
    relatedTarget: null,
  });
  session.runTimers();
  return link;
}

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
