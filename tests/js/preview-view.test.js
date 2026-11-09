/**
 * Tests for `src/web/js/preview-view.js`: the popover around a chapter or a
 * whole-document reference.
 *
 * Driven with a minimal fake DOM — plain objects with just the methods the view
 * calls — because the rules under test are *when* things happen, not how the
 * browser paints them: the popover opens for a chapter that exists, opens at
 * once as a loading panel when the document still travels and fills it on
 * arrival, says so inside the panel when the arrival fails, turns into a
 * notice for one that does not, and reporting a broken reference through the
 * banner is reserved for the click that navigates.
 *
 * The second half of the file covers pinning: a panel the reader clicked on
 * belongs to them, so a pointer leaving it, a click elsewhere, a navigation or
 * a scroll must all leave it alone until it is closed on purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS_CLASS,
  BODY_CLASS,
  CLOSE_CLASS,
  CLOSE_DELAY_MS,
  CLOSE_LABEL,
  DRAGGING_ATTRIBUTE,
  DRAG_LABEL,
  DRAG_THRESHOLD_PX,
  ERROR_ATTRIBUTE,
  HEAD_CLASS,
  HEAD_TEXT_CLASS,
  HOVER_DELAY_MS,
  LOADING_ATTRIBUTE,
  LOADING_CLASS,
  LOADING_LABEL,
  MISSING_ATTRIBUTE,
  MISSING_LABEL,
  MIN_HEIGHT_PX,
  MIN_WIDTH_PX,
  PIN_ATTRIBUTE,
  PIN_CLASS,
  PIN_LABEL,
  POPOVER_CLASS,
  PREVIEW_LABEL,
  RESIZE_ATTRIBUTE,
  RESIZE_CLASS,
  RESIZE_DIRECTION_ATTRIBUTE,
  UNPIN_LABEL,
  createPreviewView,
} from "../../src/web/js/preview-view.js";
import {
  DOC_LINK_ATTRIBUTE,
  DOC_LINK_SELECTOR,
  MISSING_ANCHOR_ATTRIBUTE,
  MISSING_CLASS,
} from "../../src/web/js/links.js";

/** Element stub: attributes, listeners, closest and the geometry `position` reads. */
function fakeElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    children: [],
    attributes: {},
    listeners: {},
    classes: [],
    hidden: false,
    textContent: "",
    // `innerHTML` is only ever assigned a preview body or cleared, so a string
    // that records the write is enough to see what the panel was told to show.
    innerHTML: "",
    style: {},
    offsetWidth: 480,
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    // Deliberately absent: a real `SVGElement` has no `createElementNS` — only
    // `document` does. A stub that hands it to every node would let a view that
    // creates SVG children through its parent pass here and throw
    // "createElementNS is not a function" in a browser, which is exactly the
    // defect this file failed to catch.
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
      }
      child.parentNode = null;
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
    // A click inside the panel arrives with one of its descendants as the
    // target, so containment has to be decided over the whole subtree.
    contains(node) {
      if (node === this) {
        return true;
      }
      return this.children.some(function (child) {
        return typeof child.contains === "function" && child.contains(node);
      });
    },
    closest(selector) {
      if (selector === "button") {
        return this.tagName === "BUTTON" ? this : null;
      }
      if (selector !== DOC_LINK_SELECTOR) {
        return null;
      }
      var tagged = Object.hasOwn(this.attributes, DOC_LINK_ATTRIBUTE);
      return this.tagName === "A" && tagged ? this : null;
    },
    /** Every descendant matching `a[href]`, the one selector `tag` asks for. */
    querySelectorAll(selector) {
      if (selector !== "a[href]") {
        return [];
      }

      const found = [];
      (function walk(node) {
        (node.children || []).forEach(function (child) {
          if (child.tagName === "A" && child.getAttribute("href") !== null) {
            found.push(child);
          }
          walk(child);
        });
      })(this);

      return found;
    },
    /** Set the class list the view reads through `classList.add`. */
    classList: null,
    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = this.listeners[type] || [];
      const index = handlers.indexOf(handler);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    },
    /** Dispatch one event to every listener, as the browser would. */
    fire(type, event) {
      (this.listeners[type] || []).slice().forEach(function (handler) {
        handler(event || {});
      });
    },
  };

  element.classList = {
    add(name) {
      if (element.classes.indexOf(name) === -1) {
        element.classes.push(name);
      }
    },
    contains(name) {
      return element.classes.indexOf(name) !== -1;
    },
  };

  // The real `textContent` setter replaces the whole subtree, which is how the
  // view empties a panel: `innerHTML` and the children have to follow, or a
  // notice could appear to sit on top of the preview it replaced.
  let text = "";
  Object.defineProperty(element, "textContent", {
    get() {
      return text;
    },
    set(value) {
      text = String(value);
      element.children = [];
      element.innerHTML = "";
    },
  });

  // A browser shrinks a panel whose `maxHeight` is set, and `position` reads
  // the height back right after writing it, so the stub has to answer the
  // shrunk value rather than the natural one — a plain field would make the
  // placement rules under test invisible.
  let naturalHeight = 200;
  Object.defineProperty(element, "offsetHeight", {
    get() {
      const limit = parseInt(String(element.style.maxHeight || ""), 10);
      return Number.isNaN(limit)
        ? naturalHeight
        : Math.min(naturalHeight, limit);
    },
    set(value) {
      naturalHeight = value;
    },
  });

  return element;
}

/**
 * Fake `document`.
 *
 * Tests insert links into `content` themselves, which is the only subtree the
 * view is given, so this object exists only for the elements `tag` and the
 * handlers create.
 */
function fakeDocument() {
  const body = fakeElement("body");
  const created = [];

  return {
    body,
    created,
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    createElement(tagName) {
      const element = fakeElement(tagName);
      created.push(element);
      return element;
    },
    createElementNS(_namespace, tagName) {
      const element = fakeElement(tagName);
      created.push(element);
      return element;
    },
    createTextNode(value) {
      return { nodeType: 3, textContent: String(value) };
    },
    // Both the document and the window stand for the page in these tests: a
    // handler registered on either is dispatched through the same `fire`.
    addEventListener(type, handler) {
      if (!globalThis.__previewListeners) {
        globalThis.__previewListeners = {};
      }
      const listeners = globalThis.__previewListeners;
      if (!listeners[type]) {
        listeners[type] = [];
      }
      listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const listeners = globalThis.__previewListeners || {};
      const handlers = listeners[type] || [];
      const index = handlers.indexOf(handler);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    },
  };
}

/** Fake global timers and viewport, installed around `run` and removed after. */
function withFakeWindow(run) {
  const timers = new Map();
  let nextId = 1;
  const previous = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
  };

  globalThis.setTimeout = function (handler, delay) {
    const id = nextId++;
    timers.set(id, { handler, delay });
    return id;
  };
  globalThis.clearTimeout = function (id) {
    timers.delete(id);
  };
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;

  const fire = function (type, event) {
    (
      (globalThis.__previewListeners && globalThis.__previewListeners[type]) ||
      []
    )
      .slice()
      .forEach(function (handler) {
        handler(event || {});
      });
  };
  globalThis.__previewListeners = {};
  globalThis.addEventListener = function (type, handler) {
    const listeners = globalThis.__previewListeners;
    if (!listeners[type]) {
      listeners[type] = [];
    }
    listeners[type].push(handler);
  };
  globalThis.removeEventListener = function (type, handler) {
    const handlers = globalThis.__previewListeners[type] || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
  };

  try {
    run({
      /** Delays of the timers still pending, in scheduling order. */
      delays() {
        return Array.from(timers.values()).map((timer) => timer.delay);
      },
      pending() {
        return timers.size;
      },
      /** Run every pending timer once. */
      runAll() {
        const due = Array.from(timers.entries());
        timers.clear();
        due.forEach(function (entry) {
          entry[1].handler();
        });
      },
      fire,
    });
  } finally {
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
    globalThis.innerWidth = previous.innerWidth;
    globalThis.innerHeight = previous.innerHeight;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    delete globalThis.__previewListeners;
  }
}

/** A link as the build writes it for a chapter that exists. */
function link(href, attributes) {
  const anchor = fakeElement("a");
  anchor.setAttribute("href", href);
  Object.keys(attributes || {}).forEach(function (name) {
    anchor.setAttribute(name, attributes[name]);
  });
  return anchor;
}

/**
 * A link the build marked as a broken reference: the route lost its anchor and
 * the authored chapter travels in the mark written on a sibling `<span>`.
 */
function brokenLink(href, chapter) {
  const span = fakeElement("span");
  span.setAttribute(MISSING_ANCHOR_ATTRIBUTE, chapter);

  const anchor = link(href);
  anchor.previousElementSibling = span;
  return anchor;
}

/** The payload document the tests route into. */
function payload() {
  return new Map([
    [
      "guide/intro.md",
      {
        id: "guide/intro.md",
        path: "guide/intro.md",
        title: "Guide Introduction",
        html: "<h1>Guide Introduction</h1>\n<p>body</p>\n",
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
  ]);
}

/** A store over `byId`, shaped the way the reader hands its views the documents. */
function asStore(byId) {
  return {
    peek(id) {
      return byId.get(id) || null;
    },
    get(id) {
      return Promise.resolve(byId.get(id) || null);
    },
  };
}

/**
 * A lazy store whose one document never arrives on its own: `get` hands the
 * test the resolver, so the answer — a document or a failure — is delivered
 * when the test says so.
 */
function travellingStore() {
  let deliver = null;
  const store = {
    isLazy() {
      return true;
    },
    peek() {
      return null;
    },
    title(id) {
      return id === "guide/intro.md" ? "Guide Introduction" : null;
    },
    get() {
      return {
        // biome-ignore lint/suspicious/noThenProperty: a deliberately synchronous thenable, so the test needs no microtask flush
        then(callback) {
          deliver = callback;
        },
      };
    },
  };

  return {
    store,
    /** Resolve the one request the view is waiting on. */
    deliver(doc) {
      deliver(doc);
    },
  };
}

/** The one popover the view builds, or `null` before it is built. */
function panelOf(doc) {
  return (
    doc.created
      .filter((element) => element.className === POPOVER_CLASS)
      .pop() || null
  );
}

/** The element with `className`, searched depth first below `root`. */
function byClass(root, className) {
  const found = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.className === className) {
        found.push(child);
      }
      walk(child);
    });
  })(root);

  return found;
}

/** The one button of `className` inside the panel. */
function buttonOf(panel, className) {
  return byClass(panel, className)[0] || null;
}

/** Press a button the way a reader does: a click that bubbles to the panel. */
function press(button, event) {
  button.fire(
    "click",
    Object.assign(
      {
        target: button,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
      },
      event || {},
    ),
  );
}

/** Click inside the panel, on one of its own elements. */
function clickInside(panel, target) {
  panel.fire("click", {
    target: target || panel,
    button: 0,
    preventDefault() {},
    stopPropagation() {},
  });
}

/** Everything the panel reads out, depth first, text included. */
function textOf(root) {
  const parts = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.nodeType === 3) {
        parts.push(String(child.textContent));
        return;
      }
      if (
        typeof child.textContent === "string" &&
        !(child.children || []).length
      ) {
        parts.push(child.textContent);
      }
      walk(child);
    });
  })(root);

  return parts.join(" ");
}

/** Run `body` with a view whose content is `content` and record every message. */
function setup(body, options) {
  withFakeWindow(function (window) {
    const doc = fakeDocument();
    const previousDocument = globalThis.document;
    globalThis.document = doc;

    try {
      const content = fakeElement("main");
      const messages = [];
      const navigations = [];
      const view = createPreviewView({
        content,
        documents: (options && options.documents) || asStore(payload()),
        onNavigate(id, anchor) {
          navigations.push({ id, anchor });
        },
        onMissingChapter(message) {
          messages.push(message);
        },
      });

      body({
        view,
        content,
        doc,
        clock: window,
        messages,
        navigations,
        fire: window.fire,
      });
      view.dispose();
    } finally {
      globalThis.document = previousDocument;
    }
  });
}

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

test("leaving a broken reference closes the notice", () => {
  setup(function ({ view, content, clock }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    assert.deepEqual(
      clock.delays(),
      [CLOSE_DELAY_MS],
      "leaving waits before closing",
    );
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
  });
});

test("escape and scrolling close the notice", () => {
  setup(function ({ view, content, clock, fire }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    fire("keydown", { key: "Escape" });
    assert.equal(view.isOpen(), false, "escape dismisses the notice");
  });

  setup(function ({ view, content, clock, fire }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    fire("scroll", {});
    assert.equal(view.isOpen(), false, "a scroll dismisses the notice");
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

test("a broken reference is tagged with its class and an expandable state", () => {
  setup(function ({ view, content }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(anchor.getAttribute(DOC_LINK_ATTRIBUTE), "");
    assert.ok(anchor.classList.contains(MISSING_CLASS));
    assert.equal(
      anchor.getAttribute("aria-expanded"),
      "false",
      "there is a notice to expand, so the state is announced",
    );
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

test("a document reference is tagged with an expandable state", () => {
  setup(function ({ view, content }) {
    const anchor = link("#/doc/guide/intro.md");
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(anchor.getAttribute(DOC_LINK_ATTRIBUTE), "");
    assert.equal(
      anchor.getAttribute("aria-expanded"),
      "false",
      "there is a preview to expand, so the state is announced",
    );
  });
});

test("an external link is never tagged and never previews", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("https://example.com/page");
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(
      anchor.getAttribute(DOC_LINK_ATTRIBUTE),
      null,
      "only a route is a document link",
    );

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), false, "a network resource has no preview");
  });
});

test("clicking the document reference a pinned panel describes closes it", () => {
  setup(function (ctx) {
    const { view, content, clock, navigations } = ctx;
    const { anchor, panel } = openPreview(ctx, "#/doc/guide/intro.md");
    clickInside(panel);

    let prevented = false;
    content.fire("click", {
      target: anchor,
      button: 0,
      preventDefault() {
        prevented = true;
      },
    });
    clock.runAll();

    assert.equal(
      prevented,
      true,
      "the browser must not follow the link as well",
    );
    assert.equal(view.isOpen(), false);
    assert.deepEqual(navigations, [], "closing the panel is not a navigation");
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
  });
});

test("clicking a broken reference still reports the chapter once", () => {
  setup(function ({ view, content, clock, messages, navigations }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    clock.runAll();
    content.fire("click", { target: anchor, button: 0, preventDefault() {} });

    assert.deepEqual(messages, [
      { docId: "guide/intro.md", anchor: "1.4 配色与字体" },
    ]);
    assert.deepEqual(navigations, [{ id: "guide/intro.md", anchor: null }]);
  });
});

test("a click closes the notice before navigating", () => {
  setup(function ({ view, content, clock, navigations }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    content.fire("click", { target: anchor, button: 0, preventDefault() {} });

    assert.equal(view.isOpen(), false);
    assert.deepEqual(navigations, [{ id: "guide/intro.md", anchor: null }]);
  });
});

/* ---------- clicking a block reference ---------- */

/**
 * Click `anchor` and report whether the handler kept the browser out.
 *
 * The browser's own navigation is what makes a hash route work at all — it
 * writes the entry, fires `hashchange` and scrolls — so a click the reader
 * "helps" with has to be judged by whether it asked the browser to stand down.
 */
function click(anchor, event) {
  return fireClick(anchor.__content, anchor, event);
}

/**
 * Dispatch a click on `anchor` through `content`, reporting whether the view
 * asked the browser to stand down.
 */
function fireClick(content, anchor, event) {
  let prevented = false;
  content.fire(
    "click",
    Object.assign(
      {
        target: anchor,
        button: 0,
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {},
      },
      event || {},
    ),
  );

  return prevented;
}

test("clicking a block reference leaves the navigation to the browser", () => {
  setup(function (ctx) {
    const { view, content, navigations } = ctx;
    const anchor = link("#/doc/guide/intro.md#getting-started");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    const prevented = click(anchor);

    assert.equal(
      prevented,
      false,
      "the browser must follow the href, which is what routes and scrolls",
    );
    assert.deepEqual(
      navigations,
      [],
      "the reader must not navigate a second time",
    );
  });
});

test("a modified click on a block reference is left alone as well", () => {
  setup(function (ctx) {
    const { view, content, navigations } = ctx;
    const anchor = link("#/doc/guide/intro.md#getting-started");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(click(anchor, { metaKey: true }), false);
    assert.equal(
      click(anchor, { button: 1 }),
      false,
      "a middle click opens a tab",
    );
    assert.deepEqual(navigations, []);
  });
});

test("clicking a link without a chapter still routes through the reader", () => {
  setup(function (ctx) {
    const { view, content, navigations } = ctx;
    const anchor = link("#/doc/guide/intro.md");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    const prevented = click(anchor);

    assert.equal(prevented, true, "the reader owns this navigation");
    assert.deepEqual(navigations, [{ id: "guide/intro.md", anchor: null }]);
  });
});

test("clicking a block reference closes the preview it opened", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const anchor = link("#/doc/guide/intro.md#getting-started");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    click(anchor);

    assert.equal(
      view.isOpen(),
      false,
      "the panel must not survive the navigation",
    );
  });
});

test("a broken reference still reports its chapter and keeps the route in the reader", () => {
  setup(function (ctx) {
    const { view, content, messages, navigations } = ctx;
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    const prevented = click(anchor);

    assert.equal(prevented, true, "the document has no anchor to scroll to");
    assert.deepEqual(messages, [
      { docId: "guide/intro.md", anchor: "1.4 配色与字体" },
    ]);
    assert.deepEqual(navigations, [{ id: "guide/intro.md", anchor: null }]);
  });
});

test("the preview closes once the pointer leaves it", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    assert.deepEqual(
      clock.delays(),
      [CLOSE_DELAY_MS],
      "leaving waits before closing",
    );
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
  });
});

/* ---------- pinning ---------- */

/** Open the ordinary preview of a fresh link and hand the panel back. */
function openPreview(ctx, href) {
  const anchor = link(href || "#/doc/guide/intro.md#getting-started");
  ctx.content.appendChild(anchor);
  ctx.view.tag(ctx.content);
  ctx.content.fire("pointerover", { target: anchor, relatedTarget: null });
  ctx.clock.runAll();

  return { anchor, panel: panelOf(ctx.doc) };
}

/**
 * Open the panel against a link placed at `rect`, with the panel standing
 * `panelHeight` pixels tall in a window `innerHeight` pixels high.
 *
 * The panel is created by a first, ordinary hover; its geometry is then given
 * the numbers under test and the panel is closed and reopened on the placed
 * link, because `position` reads the panel's height while it places it. The
 * window height is restored by `withFakeWindow` when the test ends.
 */
function openPlaced(ctx, rect, panelHeight, innerHeight) {
  const seed = link("#/doc/guide/intro.md#getting-started");
  ctx.content.appendChild(seed);
  ctx.view.tag(ctx.content);
  ctx.content.fire("pointerover", { target: seed, relatedTarget: null });
  ctx.clock.runAll();

  const panel = panelOf(ctx.doc);
  panel.offsetHeight = panelHeight;
  globalThis.innerHeight = innerHeight;

  ctx.content.fire("pointerout", { target: seed, relatedTarget: null });
  ctx.clock.runAll();

  const anchor = link("#/doc/guide/intro.md#getting-started");
  anchor.getBoundingClientRect = function () {
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    };
  };
  ctx.content.appendChild(anchor);
  ctx.view.tag(ctx.content);
  ctx.content.fire("pointerover", { target: anchor, relatedTarget: null });
  ctx.clock.runAll();

  return { anchor, panel };
}

test("a panel with room on neither side shrinks onto the roomier side above", () => {
  setup(function (ctx) {
    const { anchor, panel } = openPlaced(
      ctx,
      { top: 275, bottom: 296, left: 40, right: 160 },
      312,
      520,
    );

    // roomBelow = 520 - 10 - 304 = 206; roomAbove = 275 - 8 - 10 = 257.
    assert.equal(panel.style.maxHeight, "257px");
    assert.equal(parseFloat(panel.style.top), 10);
    assert.ok(
      10 + parseInt(panel.style.maxHeight, 10) <= 275,
      "the panel must end before the link it describes",
    );
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
});

test("a panel with room on neither side shrinks onto the roomier side below", () => {
  setup(function (ctx) {
    const { panel } = openPlaced(
      ctx,
      { top: 200, bottom: 221, left: 40, right: 160 },
      312,
      520,
    );

    // roomBelow = 510 - 229 = 281; roomAbove = 200 - 8 - 10 = 182.
    assert.equal(panel.style.maxHeight, "281px");
    assert.ok(
      parseFloat(panel.style.top) >= 221 + 8,
      "the panel must start one gap below the link it describes",
    );
    assert.equal(parseFloat(panel.style.top), 229);
  });
});

test("a panel the window holds below the link keeps its natural height", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);

    // below = 128; 128 + 200 fits inside 800 - 10: no shrink at all.
    assert.equal(panel.style.maxHeight, "");
    assert.equal(parseFloat(panel.style.top), 128);
  });
});

test("a panel that flips above the link is capped at its measured height", () => {
  setup(function (ctx) {
    // above = 230 - 8 - 200 = 22 >= 10: the whole panel fits above, and the
    // cap the placement writes equals the measured height, so nothing is
    // cut — but content that grows later cannot cross the link either.
    const { panel } = openPlaced(
      ctx,
      { top: 230, bottom: 250, left: 40, right: 160 },
      200,
      300,
    );

    assert.equal(panel.style.maxHeight, "200px");
    assert.equal(parseFloat(panel.style.top), 22);
  });
});

test("a panel placed above a bottom link never crosses it when it grows", () => {
  setup(function (ctx) {
    // The reported geometry: a link at 886/907 in a 1305-high window, the
    // panel measuring 753 — under the 60vh the stylesheet applies, so only
    // the placement's own cap stands between it and the link.
    const { anchor, panel } = openPlaced(
      ctx,
      { top: 886, bottom: 907, left: 40, right: 160 },
      753,
      1305,
    );

    assert.equal(parseFloat(panel.style.top), 125);
    assert.equal(panel.style.maxHeight, "753px");
    assert.ok(
      125 + 753 <= 886 - 8,
      "the panel must end one gap above the link it describes",
    );

    // The layout then disagrees with the measurement and the panel grows
    // past the cap. The cap holds — the body scrolls, the bottom edge stays
    // where the placement put it — and the next placement measures the
    // taller panel and still lands short of the link.
    panel.offsetHeight = 783;
    assert.equal(parseInt(panel.style.maxHeight, 10), 753);
    assert.ok(
      parseFloat(panel.style.top) + parseInt(panel.style.maxHeight, 10) <=
        886 - 8,
      "growth after the measurement must not push the panel over the link",
    );

    ctx.content.fire("pointerout", { target: anchor, relatedTarget: null });
    ctx.clock.runAll();
    ctx.content.fire("pointerover", { target: anchor, relatedTarget: null });
    ctx.clock.runAll();

    // above = 886 - 8 - 783 = 95; the cap follows the new measurement.
    assert.equal(parseFloat(panel.style.top), 95);
    assert.equal(panel.style.maxHeight, "783px");
    assert.ok(
      95 + 783 <= 886 - 8,
      "the replaced panel still ends one gap above the link",
    );
  });
});

test("a shrunk panel returns to its natural height on the next hover", () => {
  setup(function (ctx) {
    const { anchor, panel } = openPlaced(
      ctx,
      { top: 275, bottom: 296, left: 40, right: 160 },
      312,
      520,
    );
    assert.equal(panel.style.maxHeight, "257px");

    // The shrink belonged to the previous showing, not to the panel: reopened
    // against a link the window holds below, the panel measures afresh.
    ctx.content.fire("pointerout", { target: anchor, relatedTarget: null });
    ctx.clock.runAll();

    const other = link("#/doc/guide/intro.md#getting-started");
    ctx.content.appendChild(other);
    ctx.view.tag(ctx.content);
    ctx.content.fire("pointerover", { target: other, relatedTarget: null });
    ctx.clock.runAll();

    assert.equal(panel.style.maxHeight, "");
    assert.equal(parseFloat(panel.style.top), 128);
  });
});

test("the panel offers a pin and a close button", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);
    const actions = byClass(panel, ACTIONS_CLASS)[0];

    assert.ok(actions, "the buttons sit in their own group");
    assert.ok(
      byClass(panel, HEAD_TEXT_CLASS)[0],
      "the head keeps its text column",
    );

    const pin = buttonOf(panel, PIN_CLASS);
    assert.equal(pin.getAttribute("type"), "button");
    assert.equal(pin.getAttribute("aria-pressed"), "false");
    assert.equal(pin.getAttribute("aria-label"), PIN_LABEL);

    const close = buttonOf(panel, CLOSE_CLASS);
    assert.equal(close.getAttribute("type"), "button");
    assert.equal(close.getAttribute("aria-label"), CLOSE_LABEL);
    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      null,
      "a preview opens unpinned",
    );
  });
});

test("clicking inside the panel pins it", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);

    clickInside(panel, byClass(panel, "preview-scroll")[0]);

    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(
      buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      buttonOf(panel, PIN_CLASS).getAttribute("aria-label"),
      UNPIN_LABEL,
    );
  });
});

test("a pinned preview survives the pointer leaving both the link and the panel", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    assert.deepEqual(clock.delays(), [], "a pinned panel arms no close timer");
    clock.runAll();

    panel.fire("pointerleave", {});
    assert.deepEqual(
      clock.delays(),
      [],
      "leaving the panel arms no close timer",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
});

test("a pinned preview survives a click elsewhere on the page", () => {
  setup(function (ctx) {
    const { view, content, doc, clock } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);

    content.fire("click", { target: { closest: () => null }, button: 0 });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panelOf(doc), panel, "the same panel stays on screen");
  });
});

test("a pinned preview survives a scroll", () => {
  setup(function (ctx) {
    const { view, clock, fire } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);

    fire("scroll", {});
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
  });
});

test("a pinned preview survives a navigation to another document", () => {
  setup(function (ctx) {
    const { view, content, clock, navigations } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;

    // Following a second reference: the panel describes the first chapter and
    // stays where it is, while the click still navigates. A sound block
    // reference is followed by the browser, so the navigation happens there
    // rather than through `onNavigate` — either way it is one navigation.
    const other = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(other);
    view.tag(content);
    const prevented = fireClick(content, other);
    clock.runAll();

    assert.equal(prevented, false, "the browser follows the reference");
    assert.deepEqual(navigations, []);
    assert.equal(
      view.isOpen(),
      true,
      "navigating does not dismiss a pinned panel",
    );
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(
      byClass(panel, "preview-scroll")[0].innerHTML,
      shown,
      "the content is unchanged",
    );
  });
});

/* ---------- pointer movement inside a link ---------- */

/**
 * A link as the reader receives it from Markdown, with inline children.
 *
 * `[测试](doc.md#chapter)` may carry `<code>`, `<strong>` or a second `<a>` in
 * its label, and a pointer moving across that label crosses those children
 * without ever leaving the link. The browser then fires `pointerover` on each
 * child it enters, which is the sequence that used to restart the open timer
 * for as long as the hand moved.
 */
function nestedLink(href) {
  const anchor = link(href);
  const inner = fakeElement("code");
  anchor.appendChild(inner);
  return { anchor, inner };
}

/**
 * Move the pointer in the way a browser reports it.
 *
 * Crossing from `from` to `to` fires, in this order: `pointerout` on `from`,
 * `pointerover` on `to`, then the boundary events `pointerleave` on `from` and
 * `pointerenter` on `to` (a browser derives those from the pair and, with an
 * `over`/`out` listener on an ancestor, does dispatch them). A test that fires
 * only the `pointerover` half never reproduces what a hand actually does.
 */
function movePointer(content, from, to) {
  content.fire("pointerout", { target: from, relatedTarget: to });
  content.fire("pointerover", { target: to, relatedTarget: from });
  content.fire("pointerleave", { target: from, relatedTarget: to });
  content.fire("pointerenter", { target: to, relatedTarget: from });
}

/** Move the pointer onto `to` from somewhere outside every link. */
function enterPointer(content, to) {
  movePointer(content, fakeElement("p"), to);
}

test("moving between the children of one link does not restart the open timer", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink(
      "#/doc/guide/intro.md#getting-started",
    );
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "the first hover arms the timer",
    );

    // The pointer is still on the link, it has merely crossed into the code
    // span inside its label: the browser reports an `out` and an `over` pair
    // whose `relatedTarget` sits inside the same link.
    movePointer(content, anchor, inner);
    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "crossing into the link's own child must not arm a second timer",
    );

    clock.runAll();

    assert.equal(
      view.isOpen(),
      true,
      "the preview must still open after the delay",
    );
  });
});

test("crossing a link with nested elements opens its preview", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink(
      "#/doc/guide/intro.md#getting-started",
    );
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    movePointer(content, anchor, inner);
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
});

test("a pointer leaving a link for its own child keeps the preview open", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink(
      "#/doc/guide/intro.md#getting-started",
    );
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    movePointer(content, anchor, inner);
    assert.deepEqual(
      clock.delays(),
      [],
      "moving inside the link arms no close timer",
    );
    clock.runAll();
    assert.equal(view.isOpen(), true);
  });
});

test("a pointer leaving the link for the page starts the close delay", () => {
  setup(function ({ view, content, clock }) {
    const { anchor } = nestedLink("#/doc/guide/intro.md#getting-started");
    const outside = fakeElement("p");
    content.appendChild(anchor);
    content.appendChild(outside);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    movePointer(content, anchor, outside);
    assert.deepEqual(
      clock.delays(),
      [CLOSE_DELAY_MS],
      "leaving the link waits before closing",
    );
    clock.runAll();

    assert.equal(view.isOpen(), false);
  });
});

test("repeated hovers over one link arm exactly one timer", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink(
      "#/doc/guide/intro.md#getting-started",
    );
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    for (let index = 0; index < 4; index += 1) {
      movePointer(content, anchor, inner);
      movePointer(content, inner, anchor);
    }

    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "a pointer that keeps moving must not pile up timers",
    );
  });
});

test("a closed preview reopens when the same link is hovered again", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    // Closed by a scroll while the pointer never left the link: the reader is
    // asking to see the chapter again the moment they move back onto it.
    clock.fire("scroll", {});
    assert.equal(view.isOpen(), false);

    enterPointer(content, anchor);
    clock.runAll();

    assert.equal(view.isOpen(), true, "the link must be previewable again");
  });
});

test("a full enter/leave/enter cycle reopens the preview", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    const outside = fakeElement("p");
    content.appendChild(anchor);
    content.appendChild(outside);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    movePointer(content, anchor, outside);
    clock.runAll();
    assert.equal(view.isOpen(), false);

    movePointer(content, outside, anchor);
    clock.runAll();

    assert.equal(
      view.isOpen(),
      true,
      "hovering again after a close must open again",
    );
  });
});

test("a close armed before re-entering the link never fires", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    const outside = fakeElement("p");
    content.appendChild(anchor);
    content.appendChild(outside);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    // Leaving arms the close delay, and re-entering right after cancels it.
    movePointer(content, anchor, outside);
    movePointer(content, outside, anchor);

    clock.runAll();

    assert.equal(
      view.isOpen(),
      true,
      "the stale close timer must not close the panel",
    );
  });
});

test("a superseded open timer does not open the wrong link", () => {
  setup(function ({ view, content, clock, doc }) {
    const first = link("#/doc/guide/intro.md#getting-started");
    const second = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(first);
    content.appendChild(second);
    view.tag(content);

    enterPointer(content, first);
    movePointer(content, first, second);

    clock.runAll();

    const panel = panelOf(doc);
    assert.equal(view.isOpen(), true);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      "true",
      "the second link is the one shown",
    );
  });
});

test("the panel builds its icons through the document, not through the svg", () => {
  setup(function (ctx) {
    const { view, doc, content, clock } = ctx;
    const anchor = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    // A real `SVGElement` has no `createElementNS`, so an icon that builds its
    // own `<path>` throws and the panel never appears — the defect that made
    // hovering do nothing in a browser while this file stayed green. Every SVG
    // node must therefore be created by the document.
    const panel = panelOf(doc);
    assert.ok(panel, "the panel must exist");
    const paths = [];
    (function walk(node) {
      (node.children || []).forEach(function (child) {
        if (child.tagName === "PATH") {
          paths.push(child);
        }
        walk(child);
      });
    })(panel);

    assert.equal(paths.length, 5, "the pin and the cross draw five strokes");
    const createdByDocument = doc.created.filter(
      (element) => element.tagName === "PATH",
    );
    assert.equal(
      createdByDocument.length,
      paths.length,
      "every path must come from `document.createElementNS`",
    );
  });
});

test("a pinned panel ignores pointer boundary events", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;

    const other = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(other);
    view.tag(content);

    enterPointer(content, other);
    assert.deepEqual(
      clock.delays(),
      [],
      "no preview is scheduled over a pinned one",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(byClass(panel, "preview-scroll")[0].innerHTML, shown);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
  });
});

test("hovering another reference leaves a pinned preview alone", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;

    const other = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(other);
    ctx.view.tag(content);

    content.fire("pointerover", { target: other, relatedTarget: null });
    assert.deepEqual(
      clock.delays(),
      [],
      "no preview is scheduled over a pinned one",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      null,
      "the pinned role is unchanged",
    );
    assert.equal(byClass(panel, "preview-scroll")[0].innerHTML, shown);
  });
});

test("the pin button pins and unpins an open preview", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { anchor, panel } = openPreview(ctx);
    const pin = buttonOf(panel, PIN_CLASS);

    press(pin);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(pin.getAttribute("aria-pressed"), "true");
    assert.equal(pin.getAttribute("aria-label"), UNPIN_LABEL);

    press(pin);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(pin.getAttribute("aria-pressed"), "false");
    assert.equal(pin.getAttribute("aria-label"), PIN_LABEL);

    // Unpinning hands the panel back to the pointer: leaving closes it.
    assert.equal(
      view.isOpen(),
      true,
      "the panel stays while the click is still on it",
    );
    content.fire("pointerout", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), false);
  });
});

test("the close button closes a pinned preview and clears its state", () => {
  setup(function (ctx) {
    const { view, content, clock, doc } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);

    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      null,
      "no pinned frame is left behind",
    );
    assert.equal(panel.hidden, true);
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
    assert.equal(panelOf(doc), panel, "the panel is still the one instance");

    // The next hover opens an unpinned preview again.
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(
      buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"),
      "false",
    );
  });
});

test("clicking the reference a pinned panel describes unpins and closes it", () => {
  setup(function (ctx) {
    const { view, content, clock, navigations } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);

    let prevented = false;
    content.fire("click", {
      target: anchor,
      button: 0,
      preventDefault() {
        prevented = true;
      },
    });
    clock.runAll();

    assert.equal(
      prevented,
      true,
      "the browser must not follow the link as well",
    );
    assert.equal(view.isOpen(), false);
    assert.deepEqual(navigations, [], "closing the panel is not a navigation");
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
  });
});

test("escape still closes a pinned preview", () => {
  setup(function (ctx) {
    const { view, clock, fire } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);

    fire("keydown", { key: "Escape" });
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
  });
});

test("hovering the reference again reopens the preview after it was closed", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);
    press(buttonOf(panel, PIN_CLASS));

    // Closed on purpose while the pointer is elsewhere: the panel forgets both
    // the pin and the link it described, so the next hover is an ordinary
    // first hover rather than one the old anchor could dismiss.
    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();
    assert.equal(view.isOpen(), false);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
});

test("unpinning with the pointer away closes the panel after the delay", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true, "a pinned panel ignores the pointer");

    press(buttonOf(panel, PIN_CLASS));
    assert.equal(view.isOpen(), true, "the click is still on the panel");
    assert.deepEqual(
      clock.delays(),
      [CLOSE_DELAY_MS],
      "the grace period comes back",
    );

    clock.runAll();
    assert.equal(view.isOpen(), false);
  });
});

test("a notice can be pinned and closed with the same two buttons", () => {
  setup(function (ctx) {
    const { view, content, clock, doc } = ctx;
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    clickInside(panel);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), "true");

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true, "a pinned notice stays too");

    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), null);
  });
});

test("switching documents keeps a pinned preview and drops nothing of it", () => {
  setup(function (ctx) {
    const { view, content, clock, doc } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;

    // A render replaces the article and re-tags the new links; the panel lives
    // on `body`, so nothing it holds is touched.
    view.tag(content);
    content.fire("pointerout", { target: content, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(byClass(panel, "preview-scroll")[0].innerHTML, shown);
    assert.equal(panelOf(doc), panel);
  });
});

/* ---------- wheel over the panel ---------- */

test("a wheel over the panel outside its body is answered with nothing", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);
    const head = byClass(panel, HEAD_CLASS)[0];

    let prevented = false;
    panel.fire("wheel", {
      target: head,
      deltaY: 120,
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(
      prevented,
      true,
      "nothing in the head scrolls, so the default would reach the article",
    );
  });

  setup(function ({ view, content, clock, doc }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    const notice = byClass(panel, "preview-missing")[0];

    let prevented = false;
    panel.fire("wheel", {
      target: notice,
      deltaY: 120,
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(
      prevented,
      true,
      "the notice has no scroller either — the wheel must not leave the panel",
    );
    assert.equal(
      view.isOpen(),
      true,
      "a wheel the panel answered is not a scroll of the article",
    );
  });
});

test("a wheel over the scroll body keeps the browser's own scrolling", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);
    const scroll = byClass(panel, "preview-scroll")[0];
    // A target inside the body answers `closest` the way a real element does:
    // the guard asks it once, and the body it names keeps its default.
    const inside = {
      closest(selector) {
        return selector === "." + BODY_CLASS ? scroll : null;
      },
    };

    let prevented = false;
    panel.fire("wheel", {
      target: inside,
      deltaY: 120,
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(
      prevented,
      false,
      "the body scrolls the chapter; the stylesheet keeps the rest from chaining",
    );
  });
});

/* ---------- dragging the panel by its head ---------- */

/** A press on the head, dispatched where the view listens for it. */
function pressHead(_panel, head, x, y) {
  let prevented = false;
  head.fire("pointerdown", {
    target: head,
    button: 0,
    clientX: x,
    clientY: y,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });

  return prevented;
}

/** A pointer move during a drag, dispatched on the page rather than the head. */
function dragTo(fire, x, y) {
  fire("pointermove", { clientX: x, clientY: y });
}

/** A pointer release, wherever the pointer happens to be. */
function releasePointer(fire, x, y) {
  fire("pointerup", { clientX: x, clientY: y });
}

/**
 * Open a preview and hand back its panel and head.
 *
 * The panel is positioned against the link before the first press, which is
 * what a reader always starts from: `left`/`top` are already written.
 */
function openPanel(ctx) {
  const opened = openPreview(ctx);
  return Object.assign(
    { head: byClass(opened.panel, HEAD_CLASS)[0] },
    ctx,
    opened,
  );
}

test("the head is the handle a reader drags the panel by", () => {
  setup(function (ctx) {
    const { panel, head } = openPanel(ctx);

    assert.ok(head, "the head is the element the pointer has to find");
    assert.equal(head.getAttribute("title"), DRAG_LABEL);
    assert.equal(
      panel.getAttribute(DRAGGING_ATTRIBUTE),
      null,
      "nothing is being dragged yet",
    );
  });
});

test("dragging the head moves the panel with the pointer", () => {
  setup(function (ctx) {
    const { panel, head, fire } = openPanel(ctx);
    const left = parseFloat(panel.style.left);
    const top = parseFloat(panel.style.top);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 57, 110 + 40);

    assert.equal(parseFloat(panel.style.left), left + DRAG_THRESHOLD_PX + 57);
    assert.equal(parseFloat(panel.style.top), top + 40);
    assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), "true");

    releasePointer(fire, 160, 150);

    assert.equal(
      panel.getAttribute(DRAGGING_ATTRIBUTE),
      null,
      "the drag is over",
    );
    assert.equal(
      parseFloat(panel.style.left),
      left + DRAG_THRESHOLD_PX + 57,
      "the panel stays where the reader let go",
    );
  });
});

test("a drag pins the panel before it moves a pixel", () => {
  setup(function (ctx) {
    const { view, content, panel, head, clock, fire, anchor } = openPanel(ctx);
    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      null,
      "a hovered preview is unpinned",
    );

    pressHead(panel, head, 100, 110);

    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      "true",
      "the press itself claims the panel",
    );
    assert.equal(
      buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"),
      "true",
    );

    // The pointer leaves the link on its way out of the panel: a pinned panel
    // must not arm the close delay it is guarded against.
    content.fire("pointerout", { target: anchor, relatedTarget: null });
    panel.fire("pointerleave", {});
    fire("scroll", {});
    assert.deepEqual(
      clock.delays(),
      [],
      "no delay may take a dragged panel away",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
  });
});

test("a press on the head without movement moves nothing", () => {
  setup(function (ctx) {
    const { panel, head, fire } = openPanel(ctx);
    const left = panel.style.left;
    const top = panel.style.top;

    pressHead(panel, head, 100, 110);
    // Sub-threshold jitter: a hand on a mouse button is never perfectly still.
    dragTo(fire, 100 + DRAG_THRESHOLD_PX - 1, 110 + 1);
    releasePointer(fire, 101, 111);

    assert.equal(panel.style.left, left, "a click must not nudge the panel");
    assert.equal(panel.style.top, top);
    assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), null);
  });
});

test("a press on a head button starts no drag", () => {
  setup(function (ctx) {
    const { panel, fire } = openPanel(ctx);
    const left = panel.style.left;

    for (const className of [PIN_CLASS, CLOSE_CLASS]) {
      const button = buttonOf(panel, className);
      pressHead(panel, button, 100, 110);
      dragTo(fire, 100 + DRAG_THRESHOLD_PX + 80, 110);
      releasePointer(fire, 200, 110);

      assert.equal(
        panel.style.left,
        left,
        "the buttons keep their own meaning",
      );
      assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), null);
    }
  });
});

test("the head of a panel the pointer reached by keyboard drags as well", () => {
  setup(function (ctx) {
    const { view, panel, head, fire } = openPanel(ctx);
    // The reader never pressed the panel before: this drag is the first act.
    const left = parseFloat(panel.style.left);

    pressHead(panel, head, 50, 60);
    dragTo(fire, 50 + DRAG_THRESHOLD_PX + 20, 60 + 5);
    releasePointer(fire, 73, 65);

    assert.equal(parseFloat(panel.style.left), left + DRAG_THRESHOLD_PX + 20);
    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(panelOf(ctx.doc), panel, "the same panel, in a new place");
  });
});

test("a drag cannot carry the panel out of the viewport", () => {
  setup(function (ctx) {
    const { panel, head, fire } = openPanel(ctx);
    // The stub is 480 wide and 200 tall, in a 1200 x 800 viewport, and the
    // margin the automatic placement already keeps is the one a drag keeps.
    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 - 5000, 110 - 5000);
    releasePointer(fire, 0, 0);

    assert.equal(parseFloat(panel.style.left), 10);
    assert.equal(parseFloat(panel.style.top), 10);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + 5000, 110 + 5000);
    releasePointer(fire, 5200, 5300);

    assert.equal(parseFloat(panel.style.left), 1200 - 480 - 10);
    assert.equal(parseFloat(panel.style.top), 800 - 200 - 10);
  });
});

test("a dragged panel keeps its place until it is closed", () => {
  setup(function (ctx) {
    const { view, content, panel, head, clock, fire } = openPanel(ctx);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 40, 110 + 30);
    releasePointer(fire, 143, 140);
    const left = panel.style.left;
    const top = panel.style.top;

    // A second drag starts from where the first one ended.
    pressHead(panel, head, 200, 200);
    dragTo(fire, 200 + DRAG_THRESHOLD_PX + 10, 200 + 10);
    releasePointer(fire, 213, 213);

    assert.equal(
      parseFloat(panel.style.left),
      parseFloat(left) + DRAG_THRESHOLD_PX + 10,
    );
    assert.equal(parseFloat(panel.style.top), parseFloat(top) + 10);

    // A render, a scroll and the pointer leaving all leave it alone.
    view.tag(content);
    content.fire("pointerout", { target: content, relatedTarget: null });
    fire("scroll", {});
    panel.fire("pointerleave", {});
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(
      panel.style.left,
      String(parseFloat(left) + DRAG_THRESHOLD_PX + 10) + "px",
    );
  });
});

test("closing a dragged panel forgets where the reader put it", () => {
  setup(function (ctx) {
    const { view, content, panel, head, clock, fire, anchor } = openPanel(ctx);
    const original = panel.style.left;

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 200, 110 + 120);
    releasePointer(fire, 303, 230);
    assert.notEqual(panel.style.left, original, "the drag really moved it");

    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();
    assert.equal(view.isOpen(), false);

    // The next preview is an ordinary one, placed against its own link.
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(
      panel.style.left,
      original,
      "the manual place does not outlive the panel",
    );
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
  });
});

test("a notice is dragged by the same head", () => {
  setup(function (ctx) {
    const { view, content, clock, fire, doc } = ctx;
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");

    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    const head = byClass(panel, HEAD_CLASS)[0];
    const left = parseFloat(panel.style.left);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 30, 110 + 20);
    releasePointer(fire, 133, 130);

    assert.equal(parseFloat(panel.style.left), left + DRAG_THRESHOLD_PX + 30);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      "true",
      "the notice keeps its role",
    );
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
  });
});

test("a release outside the panel ends the drag", () => {
  setup(function (ctx) {
    const { panel, head, fire } = openPanel(ctx);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 10, 110);
    releasePointer(fire, 5000, 5000);
    const left = panel.style.left;

    // Nothing listens any more, so a stray move cannot drag a panel nobody holds.
    fire("pointermove", { clientX: 900, clientY: 700 });

    assert.equal(panel.style.left, left);
    assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), null);
  });
});

/* ---------- resizing the panel by its edges ---------- */

/** The panel's one handle for `direction`, or `null` when it has none. */
function handleOf(panel, direction) {
  const found = byClass(panel, RESIZE_CLASS).filter(function (handle) {
    return handle.getAttribute(RESIZE_DIRECTION_ATTRIBUTE) === direction;
  });

  return found[0] || null;
}

/** A press on a resize handle, dispatched on the handle itself. */
function pressHandle(handle, x, y) {
  let prevented = false;
  handle.fire("pointerdown", {
    target: handle,
    button: 0,
    clientX: x,
    clientY: y,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });

  return prevented;
}

/** Open the ordinary preview and hand back its three handles with it. */
function openResizable(ctx) {
  const opened = openPreview(ctx);
  // A real element's style properties read "" before anything writes them;
  // the stub's style is a plain object, so the axes the view may leave
  // untouched are seeded to keep the browser's semantics.
  opened.panel.style.width = "";
  opened.panel.style.height = "";
  opened.panel.style.maxHeight = "";
  opened.panel.offsetWidth = 480;
  opened.panel.offsetHeight = 200;

  return Object.assign({}, ctx, opened, {
    east: handleOf(opened.panel, "e"),
    south: handleOf(opened.panel, "s"),
    corner: handleOf(opened.panel, "se"),
  });
}

test("the panel wears one handle per resizable edge", () => {
  setup(function (ctx) {
    const { panel } = openResizable(ctx);

    assert.ok(handleOf(panel, "e"), "the east edge is a handle");
    assert.ok(handleOf(panel, "s"), "the south edge is a handle");
    assert.ok(handleOf(panel, "se"), "the corner is a handle");
    assert.equal(
      panel.getAttribute(RESIZE_ATTRIBUTE),
      null,
      "nothing is being resized yet",
    );
  });
});

test("dragging the east handle changes the width and leaves the height alone", () => {
  setup(function (ctx) {
    const { panel, east, fire } = openResizable(ctx);

    pressHandle(east, 100, 110);
    dragTo(fire, 100 + 57, 110);

    assert.equal(panel.style.width, "537px");
    assert.equal(
      panel.style.height,
      "",
      "an east resize leaves the height to the content and the placement",
    );
    assert.equal(panel.style.maxHeight, "");
    assert.equal(panel.getAttribute(RESIZE_ATTRIBUTE), "true");

    releasePointer(fire, 157, 110);

    assert.equal(
      panel.getAttribute(RESIZE_ATTRIBUTE),
      null,
      "the resize is over",
    );
    assert.equal(
      panel.style.width,
      "537px",
      "the panel keeps the size the gesture left",
    );
  });
});

test("dragging the south handle changes the height and leaves the width alone", () => {
  setup(function (ctx) {
    const { panel, south, fire } = openResizable(ctx);

    pressHandle(south, 100, 110);
    dragTo(fire, 100, 110 + 40);

    assert.equal(panel.style.height, "240px");
    assert.equal(
      panel.style.maxHeight,
      "240px",
      "the stylesheet's own share of the window must not cap the reader's",
    );
    assert.equal(
      panel.style.width,
      "",
      "a south resize leaves the width alone",
    );

    releasePointer(fire, 100, 150);

    assert.equal(panel.style.height, "240px", "the height stays");
  });
});

test("dragging the corner changes both axes at once", () => {
  setup(function (ctx) {
    const { panel, corner, fire } = openResizable(ctx);

    pressHandle(corner, 100, 110);
    dragTo(fire, 100 + 57, 110 + 40);

    assert.equal(panel.style.width, "537px");
    assert.equal(panel.style.height, "240px");
    assert.equal(panel.style.maxHeight, "240px");

    releasePointer(fire, 157, 150);
  });
});

test("a press on a handle without movement changes nothing", () => {
  setup(function (ctx) {
    const { panel, east, fire } = openResizable(ctx);

    pressHandle(east, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX - 1, 110);
    releasePointer(fire, 102, 110);

    assert.equal(panel.style.width, "", "a click must not nudge the frame");
    assert.equal(panel.getAttribute(RESIZE_ATTRIBUTE), null);
  });
});

test("a resize cannot shrink the panel below its floor", () => {
  setup(function (ctx) {
    const { panel, corner, fire } = openResizable(ctx);

    pressHandle(corner, 100, 110);
    dragTo(fire, 100 - 5000, 110 - 5000);

    assert.equal(panel.style.width, MIN_WIDTH_PX + "px");
    assert.equal(panel.style.height, MIN_HEIGHT_PX + "px");

    releasePointer(fire, 0, 0);
  });
});

test("a resize cannot carry the panel out of the viewport", () => {
  setup(function (ctx) {
    const { panel, east, south, fire } = openResizable(ctx);
    // The stub is 480 wide and 200 tall, placed at 40/128, in a 1200 x 800
    // window; the margin the automatic placement keeps is the one a resize
    // keeps too.

    pressHandle(east, 100, 110);
    dragTo(fire, 100 + 5000, 110);
    assert.equal(panel.style.width, "1150px", "1200 - 40 - 10");

    releasePointer(fire, 5100, 110);

    pressHandle(south, 100, 110);
    dragTo(fire, 100, 110 + 5000);
    assert.equal(panel.style.height, "662px", "800 - 128 - 10");
    assert.equal(panel.style.maxHeight, "662px");

    releasePointer(fire, 100, 5100);
  });
});

test("a press on a handle claims the panel before it moves a pixel", () => {
  setup(function (ctx) {
    const { view, content, panel, east, clock, fire, anchor } =
      openResizable(ctx);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);

    pressHandle(east, 100, 110);

    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      "true",
      "the press itself claims the panel",
    );

    // The pointer leaves the link on its way out of the panel: a pinned panel
    // must not arm the close delay it is guarded against.
    content.fire("pointerout", { target: anchor, relatedTarget: null });
    panel.fire("pointerleave", {});
    fire("scroll", {});
    assert.deepEqual(
      clock.delays(),
      [],
      "no delay may take a panel mid-resize away",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
  });
});

test("a resized panel keeps its size until it is closed", () => {
  setup(function (ctx) {
    const { view, content, panel, corner, clock, fire } = openResizable(ctx);

    pressHandle(corner, 100, 110);
    dragTo(fire, 100 + 57, 110 + 40);
    releasePointer(fire, 157, 150);

    // A render, a scroll and the pointer leaving all leave it alone.
    view.tag(content);
    content.fire("pointerout", { target: content, relatedTarget: null });
    fire("scroll", {});
    panel.fire("pointerleave", {});
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.style.width, "537px");
    assert.equal(panel.style.height, "240px");
  });
});

test("closing a resized panel forgets the size", () => {
  setup(function (ctx) {
    const { view, content, panel, corner, clock, fire, anchor } =
      openResizable(ctx);

    pressHandle(corner, 100, 110);
    dragTo(fire, 100 + 57, 110 + 40);
    releasePointer(fire, 157, 150);
    assert.notEqual(panel.style.width, "", "the resize really took");

    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();
    assert.equal(view.isOpen(), false);
    assert.equal(panel.style.width, "");
    assert.equal(panel.style.height, "");
    assert.equal(panel.style.maxHeight, "");

    // The next preview is an ordinary one, opened at the stylesheet's size.
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.style.width, "");
    assert.equal(panel.style.height, "");
    assert.equal(panel.style.maxHeight, "");
  });
});

test("a release outside the panel ends the resize", () => {
  setup(function (ctx) {
    const { panel, east, fire } = openResizable(ctx);

    pressHandle(east, 100, 110);
    dragTo(fire, 100 + 10, 110);
    releasePointer(fire, 5000, 5000);

    // Nothing listens any more, so a stray move cannot resize a panel nobody
    // holds.
    fire("pointermove", { clientX: 900, clientY: 700 });

    assert.equal(panel.style.width, "490px");
    assert.equal(panel.getAttribute(RESIZE_ATTRIBUTE), null);
  });
});

test("a resized panel is not re-anchored when its document arrives", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock, doc, fire }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      const panel = panelOf(doc);
      assert.equal(
        panel.getAttribute(LOADING_ATTRIBUTE),
        "true",
        "the panel is up before the document is",
      );
      panel.style.width = "";
      panel.style.height = "";
      panel.style.maxHeight = "";
      panel.offsetWidth = 480;
      panel.offsetHeight = 200;

      pressHandle(handleOf(panel, "se"), 100, 110);
      dragTo(fire, 100 + 57, 110 + 40);
      releasePointer(fire, 157, 150);
      assert.equal(panel.style.width, "537px");

      travelling.deliver(payload().get("guide/intro.md"));

      assert.equal(view.isOpen(), true);
      assert.match(textOf(panel), /Getting Started/);
      assert.equal(
        panel.style.width,
        "537px",
        "the fill must not re-anchor a panel placed by hand",
      );
      assert.equal(panel.style.height, "240px");
      assert.equal(panel.style.maxHeight, "240px");
    },
    { documents: travelling.store },
  );
});
