/**
 * Tests for `src/web/js/preview-view.js`: the popover around a block reference.
 *
 * Driven with a minimal fake DOM — plain objects with just the methods the view
 * calls — because the rules under test are *when* things happen, not how the
 * browser paints them: the popover opens for a chapter that exists, turns into
 * a notice for one that does not, and reporting a broken reference through the
 * banner is reserved for the click that navigates.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOSE_DELAY_MS,
  HOVER_DELAY_MS,
  MISSING_ATTRIBUTE,
  MISSING_LABEL,
  POPOVER_CLASS,
  PREVIEW_LABEL,
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
    offsetHeight: 200,
    parentNode: null,
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
    getBoundingClientRect() {
      return { top: 100, bottom: 120, left: 40, right: 160, width: 120, height: 20 };
    },
    contains(node) {
      return node === this;
    },
    closest(selector) {
      if (selector !== DOC_LINK_SELECTOR) {
        return null;
      }
      var tagged = Object.prototype.hasOwnProperty.call(this.attributes, DOC_LINK_ATTRIBUTE);
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
      (this.listeners[type] = this.listeners[type] || []).push(handler);
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
    createTextNode(value) {
      return { nodeType: 3, textContent: String(value) };
    },
    // Both the document and the window stand for the page in these tests: a
    // handler registered on either is dispatched through the same `fire`.
    addEventListener(type, handler) {
      const listeners = globalThis.__previewListeners || (globalThis.__previewListeners = {});
      (listeners[type] = listeners[type] || []).push(handler);
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
    (globalThis.__previewListeners && globalThis.__previewListeners[type] || [])
      .slice()
      .forEach(function (handler) {
        handler(event || {});
      });
  };
  globalThis.__previewListeners = {};
  globalThis.addEventListener = function (type, handler) {
    (globalThis.__previewListeners[type] = globalThis.__previewListeners[type] || []).push(handler);
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
  ]);
}

/** The one popover the view builds, or `null` before it is built. */
function panelOf(doc) {
  return doc.created.filter((element) => element.className === POPOVER_CLASS).pop() || null;
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

/** Everything the panel reads out, depth first, text included. */
function textOf(root) {
  const parts = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.nodeType === 3) {
        parts.push(String(child.textContent));
        return;
      }
      if (typeof child.textContent === "string" && !(child.children || []).length) {
        parts.push(child.textContent);
      }
      walk(child);
    });
  })(root);

  return parts.join(" ");
}

/** Run `body` with a view whose content is `content` and record every message. */
function setup(body) {
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
        byId: payload(),
        onNavigate(id, anchor) {
          navigations.push({ id, anchor });
        },
        onMissingChapter(message) {
          messages.push(message);
        },
      });

      body({ view, content, doc, clock: window, messages, navigations, fire: window.fire });
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

    assert.deepEqual(clock.delays(), [HOVER_DELAY_MS], "the open timer is armed");
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");

    const panel = panelOf(doc);
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), null, "an ordinary preview");
    assert.equal(panel.getAttribute("aria-label"), PREVIEW_LABEL);
    assert.match(textOf(panel), /Getting Started/);
  });
});

test("hovering a broken reference opens a notice and reports nothing", () => {
  setup(function ({ view, content, clock, doc, messages }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.deepEqual(messages, [], "hovering is not a moment the reader reports");
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
    const codes = byClass(panel, "preview-missing-code").map((element) => element.textContent);

    assert.ok(codes.includes("<b>x</b> & <i>y</i>"), "the chapter is an element of its own");
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
    assert.equal(good.getAttribute("aria-expanded"), "false", "the old link is released");
    assert.equal(broken.getAttribute("aria-expanded"), "true");
    assert.equal(byClass(panel, "preview-scroll")[0].innerHTML, "", "no preview body remains");
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
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), null, "the notice mark is gone");
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
    assert.deepEqual(clock.delays(), [CLOSE_DELAY_MS], "leaving waits before closing");
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

    assert.deepEqual(clock.delays(), [HOVER_DELAY_MS], "keyboard users get the same delay");
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

test("clicking a broken reference still reports the chapter once", () => {
  setup(function ({ view, content, clock, messages, navigations }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    clock.runAll();
    content.fire("click", { target: anchor, button: 0, preventDefault() {} });

    assert.deepEqual(messages, [{ docId: "guide/intro.md", anchor: "1.4 配色与字体" }]);
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

test("the preview closes once the pointer leaves it", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    assert.deepEqual(clock.delays(), [CLOSE_DELAY_MS], "leaving waits before closing");
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
  });
});
