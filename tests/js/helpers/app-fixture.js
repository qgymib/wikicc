/**
 * The page harness the app-shell test files share.
 *
 * `start()` insists on a whole page — a payload element, the shell's ids, a
 * hash to route — so the tests drive it with a fake DOM and a fake
 * `globalThis` location. This module installs that page (`withSession`),
 * starts the reader against it (`startSession`), and carries the fixtures
 * the assertions read: the embedded and pages payloads, the sealed-document
 * blobs and their chunks, and the lookups and polls the tests use.
 *
 * The diagram engine and the graph are stubbed: this is not their test, and
 * the real ones need a browser.
 */
import {
  DOC_LINK_ATTRIBUTE,
  DOC_LINK_SELECTOR,
} from "../../../src/web/js/links.js";
import {
  TAG_CHIP_ATTRIBUTE,
  TAG_CHIP_SELECTOR,
} from "../../../src/web/js/tags.js";
import {
  createFakeElement,
  createFakeTimers,
  createTextNode,
  createTreeWalker,
  descendantsByTag,
  hasClass,
  parseInto,
  walkDescendants,
  withGlobals,
} from "./dom.js";

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
  "backlinks-toggle",
  "tags-toggle",
  "outline-toggle",
  "drawer-backdrop",
  "theme-toggle",
  "doc-list",
  "toc",
  "backlinks",
  "tags",
  "tags-panel",
  "graph-local",
  "graph-global",
  "graph-fit-local",
  "graph-fit-global",
  "search-toggle",
  "search-panel",
  "doc-alert",
];

/** A fake element with the handful of members the session touches. */
export function fakeElement(tagName) {
  const element = createFakeElement(tagName);

  /**
   * Answer a selector over this element's subtree.
   *
   * The session asks one question by class — the article's document body —
   * so it is honoured over children, which is the shape the browser answers
   * it in.
   */
  element.querySelector = function (selector) {
    const found = element.querySelectorAll(selector);
    return found.length ? found[0] : null;
  };

  element.querySelectorAll = function (selector) {
    const found = [];
    const wanted = String(selector).replace(/^\./, "");

    if (String(selector).indexOf(".") === 0) {
      walkDescendants(element, function (node) {
        if (hasClass(node, wanted)) {
          found.push(node);
        }
      });
    }

    // The hover preview tags its links and asks for them by the tag and
    // attribute every route carries, which is the one other selector the
    // reader's views ask of this fake.
    if (String(selector) === "a[href]") {
      walkDescendants(element, function (node) {
        if (node.tagName === "A" && node.getAttribute("href") !== null) {
          found.push(node);
        }
      });
    }

    return found;
  };

  // The preview's placement measures the link it describes; one fixed
  // rectangle keeps the panel beside the link instead of inside it.
  element.scrollCalls = [];
  element.scrollIntoView = function (options) {
    element.scrollCalls.push(options || {});
  };

  // The hover preview's handlers find the link an event started on by the
  // mark the tag step wrote on it; the two selectors a real `closest` is
  // asked here are the link mark and the head's buttons.
  element.closest = function (selector) {
    if (selector === "button") {
      return element.tagName === "BUTTON" ? element : null;
    }
    if (selector === TAG_CHIP_SELECTOR) {
      return hasClass(element, "doc-tag") &&
        element.getAttribute(TAG_CHIP_ATTRIBUTE) !== null
        ? element
        : null;
    }
    if (selector !== DOC_LINK_SELECTOR) {
      return null;
    }
    const tagged = Object.hasOwn(element.attributes, DOC_LINK_ATTRIBUTE);
    return element.tagName === "A" && tagged ? element : null;
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
      parseInto(element, String(value), fakeElement);
    },
  });

  return element;
}

/** Every `<mark>` below `root`, in document order. */
export function marksOf(root) {
  return descendantsByTag(root, "MARK");
}

/** The payload the session routes against. */
export function payload() {
  return {
    v: 1,
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
export function lazyManifest() {
  return {
    v: 1,
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
export function lazyChunks() {
  return {
    "pages/index.md.json?v=h0": {
      v: 1,
      id: "index.md",
      title: "Index",
      html: "<p>root</p>",
      toc: [],
      blocks: [],
      text: "root",
    },
    "pages/guide/intro.md.json?v=h1": {
      v: 1,
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
export function lazyCorpus() {
  return {
    v: 1,
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
 *
 * The install is deliberately synchronous: everything `body` does before its
 * first `await` runs while the fake page is up, and anything `body` throws —
 * a failed assertion, most of all — propagates to the caller instead of
 * becoming a rejection nobody holds. An `async` wrapper would turn that
 * throw into a rejection the bridge's `--test-force-exit` exits before the
 * runner can report, and a failing test would pass. A `body` that needs to
 * settle promises returns a promise (or is itself `async`), and the caller
 * that awaits `withSession` waits for it.
 */
export function withSession(options, body) {
  // The search panel debounces its query, so the timers it schedules are kept
  // for the test to run instead of waiting for them.
  const timers = createFakeTimers();

  const shell = new Map();
  SHELL_IDS.forEach(function (id) {
    const element = fakeElement("div");
    element.id = id;
    shell.set(id, element);
  });

  const payloadElement = fakeElement("script");
  payloadElement.id = "wikicc-payload";
  // `options.docs` swaps the embedded payload's documents (a test that needs
  // a sealed document builds one here) and `options.edges` its link graph;
  // `options.payload` replaces the whole payload, which is how a pages test
  // seeds its own manifest.
  let embedded = null;
  if (options.docs || options.edges || options.tags) {
    embedded = payload();
    if (options.docs) {
      embedded.docs = options.docs;
    }
    if (options.edges) {
      embedded.edges = options.edges;
    }
    if (options.tags) {
      embedded.tags = options.tags;
    }
  }
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
  let fetchImpl = null;
  if (options.lazy) {
    // `options.chunks` seeds a manifest's chunks of its own; without one the
    // stock chunks and the stock corpus serve, and `broken` serves nothing.
    const chunks = options.chunks || (options.broken ? {} : lazyChunks());
    if (!options.chunks && !options.broken) {
      chunks["search.json"] = lazyCorpus();
    }
    fetchImpl = function (url) {
      fetchCalls.push(url);
      const response = Object.hasOwn(chunks, url) ? chunks[url] : null;
      return Promise.resolve({
        ok: response !== null,
        json() {
          return Promise.resolve(response);
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
      return createTextNode(value);
    },
    createTreeWalker(root) {
      return createTreeWalker(root);
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

  // `start()` listens for `hashchange` on the window, which is `globalThis` in
  // a page and in this fake one too.
  const windowListeners = {};

  // The store starts empty; `options.storage` seeds it, and the same map is
  // handed back on the session for the tests that read a write back.
  const storageMap = options.storage || {};

  const overrides = {
    document: doc,
    location: location,
    history: history,
    // The theme query stays light-hostile so the reader stays dark; a test
    // that sets `options.drawer` moves the session to the width where the
    // document list is a drawer, which is the only other query the session
    // branches on.
    matchMedia(query) {
      return {
        matches: Boolean(options.drawer) && query === "(max-width: 640px)",
      };
    },
    localStorage: {
      getItem(key) {
        return Object.hasOwn(storageMap, key) ? storageMap[key] : null;
      },
      setItem(key, value) {
        storageMap[key] = String(value);
      },
    },
    addEventListener(type, handler) {
      if (!windowListeners[type]) {
        windowListeners[type] = [];
      }
      windowListeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = windowListeners[type] || [];
      const index = handlers.indexOf(handler);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    },
    requestAnimationFrame(handler) {
      frames.push(handler);
      return frames.length;
    },
    scrollTo(_x, y) {
      scrollTop = y;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  if (fetchImpl) {
    overrides.fetch = fetchImpl;
  }

  return withGlobals(overrides, function () {
    return body({
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
        timers.runAll();
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
  });
}

/**
 * Import the reader controller.
 *
 * The import is awaited once, at module load, because `withSession` installs
 * the fake page synchronously: awaiting inside its body would hand control back
 * to the event loop, and the session would start against the restored globals.
 */
const app = await import("../../../src/web/js/app.js");

/** Start the session against the page `withSession` installed. */
export function startSession() {
  app.start();
}

/** The `aria-current` entry of the document list, or `null`. */
export function activeEntry(shell) {
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

/** How many document links the list holds. */
export function countLinks(container) {
  var count = 0;
  (function walk(node) {
    if (node.tagName === "A") {
      count += 1;
    }
    (node.children || []).forEach(walk);
  })(container);

  return count;
}

/** The query field the panel built, found by its class. */
export function searchInput(shell) {
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
export function searchParts(shell, className) {
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
export function keydown(key, extra) {
  return Object.assign({ key: key, preventDefault() {} }, extra || {});
}

/** Every text node below `node`, joined with spaces. */
export function textOf(node) {
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

/**
 * The blob the committed interop vector sealed `guide/intro.md` with — the
 * same constants `tests/js/lock.test.js` and `tests/js/doc-store.test.js`
 * pin, which `src/crypto.rs` keeps honest on the build side. Its plaintext
 * is the chapter-shaped body the outline and the anchor walk read.
 */
export const SEALED_BLOB = {
  v: 1,
  kdf: "pbkdf2-sha256",
  iters: 600000,
  salt: "EBESExQVFhcYGRobHB0eHw==",
  nonce: "sLGys7S1tre4ubq7",
  ct: "FdagYCNSGn2CfXUj43AcxGe/uvxMLy0VH4U/18evqxKAIAcqJPR1NabxtlrnYoUnGJefjCc/TROQPdMXpo/eVe5UoWQ7K26y9P+/pSWha4gzM5bA+GF8xRSXnA1x4auaYpG4OMQJZm3cZ3+bfWV+G7/p9Yc2s0shQb16Amq8yeJMwos8Uj/uIfxkjTS1FH9PshBkceKsQ46A73b2wvGyLcjJekcz2Pi7gndVRJVs73pszogDQk8iQbiSz/ISVb/wV8r0cQH8vlfHQFqyLtLFRfZSGeB8vEKGrQlAj00EiMWkx9NnhwzwqrnvuHy4GFte0fJhmUieET7Jnvkm3wjEFi0Y/F9HaI+IbzUv7gxDhYbNVrKBRp/ji2OPb+NVUMN4vXgNPBpb/mnrWRFD4Gc9EGZxGX1ULQ==",
};

/** The interop vector sealed `guide/other.md` with, under the same password. */
export const OTHER_BLOB = {
  v: 1,
  kdf: "pbkdf2-sha256",
  iters: 600000,
  salt: "ICEiIyQlJicoKSorLC0uLw==",
  nonce: "wMHCw8TFxsfIycrL",
  ct: "OH0yPKUuQm3nBjfjjxk27eenmLO5yntFrYoZc2X508M0aVGiD7n5djyHsLg4ozn8WpYOduZNxGruKOS6/E239D+h7zKJkC8oDlDIRaOuceMC0FJrfdI/GLc5K5axNHdGJnkiXH7SRg==",
};

/** The password both interop vectors answer to. */
export const SEALED_PASSWORD = "密码 secret";

/** The embedded payload with two sealed documents beside the public one. */
export function lockedDocs() {
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
export function lockedManifest() {
  return {
    v: 1,
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
export function lockedChunks() {
  return {
    "pages/index.md.json?v=h0": {
      v: 1,
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
      v: 1,
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
      v: 1,
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
export async function waitFor(probe, what) {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for " + what);
    }
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
}

/** The lock page's password form, which is the one door the page carries. */
export function lockedForm(article) {
  return article.children[3] || null;
}

/** The password field inside the lock page's form. */
export function lockedInput(article) {
  const form = lockedForm(article);
  return form ? form.children[0].children[1] : null;
}

/** The line that reports a failed attempt on the lock page. */
export function lockedError(article) {
  const form = lockedForm(article);
  return form ? form.children[2] : null;
}

/** Put `password` in the lock page's field and press its unlock action. */
export function submitPassword(session, password) {
  const article = session.shell.get("doc-article");
  lockedInput(article).value = password;
  lockedForm(article).fire("submit", { preventDefault() {} });
}

/**
 * A word only the opened plaintext holds: the sealed corpus and the sealed
 * payload carry the title alone, so `body` answers nothing before the
 * password and the opened text `"getting started intro body"` answers it
 * after.
 */
export const SEALED_BODY_WORD = "body";

/**
 * Ask the whole-site scope about `value`.
 *
 * Opens the panel if it is shut, puts the scope on the whole site, and lets
 * the debounce fire through the session's timers. Used across sessions that
 * may already hold an open panel, so both the open and the scope switch read
 * the state they find.
 */
export function askGlobal(session, value) {
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
export function resultPaths(session) {
  return searchParts(session.shell, "search-result-path").map(function (node) {
    return node.textContent;
  });
}

/** Every descendant of `root` whose class list carries `name`. */
export function byClassIn(root, name) {
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
export function previewPanel(session) {
  return byClassIn(session.doc.body, "preview-popover")[0] || null;
}

/** The first `<a>` below `root`, which the payload's references are. */
export function firstLink(root) {
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
export function hoverReference(session) {
  const article = session.shell.get("doc-article");
  const link = firstLink(article.children[1]);
  session.shell.get("doc-content").fire("pointerover", {
    target: link,
    relatedTarget: null,
  });
  session.runTimers();
  return link;
}
