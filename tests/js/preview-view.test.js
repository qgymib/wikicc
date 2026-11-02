/**
 * Tests for `src/web/js/preview-view.js`: the popover around a block reference.
 *
 * Driven with a minimal fake DOM — plain objects with just the methods the view
 * calls — because the rules under test are *when* things happen, not how the
 * browser paints them: the popover opens for a chapter that exists, turns into
 * a notice for one that does not, and reporting a broken reference through the
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
  CLOSE_CLASS,
  CLOSE_DELAY_MS,
  CLOSE_LABEL,
  DRAGGING_ATTRIBUTE,
  DRAG_LABEL,
  DRAG_THRESHOLD_PX,
  HEAD_CLASS,
  HEAD_TEXT_CLASS,
  HOVER_DELAY_MS,
  MISSING_ATTRIBUTE,
  MISSING_LABEL,
  PIN_ATTRIBUTE,
  PIN_CLASS,
  PIN_LABEL,
  POPOVER_CLASS,
  PREVIEW_LABEL,
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
    offsetHeight: 200,
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
    createElementNS(namespace, tagName) {
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
    assert.deepEqual(navigations, [], "the reader must not navigate a second time");
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
    assert.equal(click(anchor, { button: 1 }), false, "a middle click opens a tab");
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

    assert.equal(view.isOpen(), false, "the panel must not survive the navigation");
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
    assert.deepEqual(messages, [{ docId: "guide/intro.md", anchor: "1.4 配色与字体" }]);
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

test("the panel offers a pin and a close button", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);
    const actions = byClass(panel, ACTIONS_CLASS)[0];

    assert.ok(actions, "the buttons sit in their own group");
    assert.ok(byClass(panel, HEAD_TEXT_CLASS)[0], "the head keeps its text column");

    const pin = buttonOf(panel, PIN_CLASS);
    assert.equal(pin.getAttribute("type"), "button");
    assert.equal(pin.getAttribute("aria-pressed"), "false");
    assert.equal(pin.getAttribute("aria-label"), PIN_LABEL);

    const close = buttonOf(panel, CLOSE_CLASS);
    assert.equal(close.getAttribute("type"), "button");
    assert.equal(close.getAttribute("aria-label"), CLOSE_LABEL);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null, "a preview opens unpinned");
  });
});

test("clicking inside the panel pins it", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);

    clickInside(panel, byClass(panel, "preview-scroll")[0]);

    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"), "true");
    assert.equal(buttonOf(panel, PIN_CLASS).getAttribute("aria-label"), UNPIN_LABEL);
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
    assert.deepEqual(clock.delays(), [], "leaving the panel arms no close timer");
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
    assert.equal(view.isOpen(), true, "navigating does not dismiss a pinned panel");
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(byClass(panel, "preview-scroll")[0].innerHTML, shown, "the content is unchanged");
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
    const { anchor, inner } = nestedLink("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    assert.deepEqual(clock.delays(), [HOVER_DELAY_MS], "the first hover arms the timer");

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

    assert.equal(view.isOpen(), true, "the preview must still open after the delay");
  });
});

test("crossing a link with nested elements opens its preview", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink("#/doc/guide/intro.md#getting-started");
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
    const { anchor, inner } = nestedLink("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    movePointer(content, anchor, inner);
    assert.deepEqual(clock.delays(), [], "moving inside the link arms no close timer");
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
    assert.deepEqual(clock.delays(), [CLOSE_DELAY_MS], "leaving the link waits before closing");
    clock.runAll();

    assert.equal(view.isOpen(), false);
  });
});

test("repeated hovers over one link arm exactly one timer", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink("#/doc/guide/intro.md#getting-started");
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

    assert.equal(view.isOpen(), true, "hovering again after a close must open again");
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

    assert.equal(view.isOpen(), true, "the stale close timer must not close the panel");
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
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), "true", "the second link is the one shown");
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
    const createdByDocument = doc.created.filter((element) => element.tagName === "PATH");
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
    assert.deepEqual(clock.delays(), [], "no preview is scheduled over a pinned one");
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
    assert.deepEqual(clock.delays(), [], "no preview is scheduled over a pinned one");
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), null, "the pinned role is unchanged");
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
    assert.equal(view.isOpen(), true, "the panel stays while the click is still on it");
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
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null, "no pinned frame is left behind");
    assert.equal(panel.hidden, true);
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
    assert.equal(panelOf(doc), panel, "the panel is still the one instance");

    // The next hover opens an unpinned preview again.
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"), "false");
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

    assert.equal(prevented, true, "the browser must not follow the link as well");
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
    assert.deepEqual(clock.delays(), [CLOSE_DELAY_MS], "the grace period comes back");

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

/* ---------- dragging the panel by its head ---------- */

/** A press on the head, dispatched where the view listens for it. */
function pressHead(panel, head, x, y) {
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
  return Object.assign({ head: byClass(opened.panel, HEAD_CLASS)[0] }, ctx, opened);
}

test("the head is the handle a reader drags the panel by", () => {
  setup(function (ctx) {
    const { panel, head } = openPanel(ctx);

    assert.ok(head, "the head is the element the pointer has to find");
    assert.equal(head.getAttribute("title"), DRAG_LABEL);
    assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), null, "nothing is being dragged yet");
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

    assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), null, "the drag is over");
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
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null, "a hovered preview is unpinned");

    pressHead(panel, head, 100, 110);

    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true", "the press itself claims the panel");
    assert.equal(buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"), "true");

    // The pointer leaves the link on its way out of the panel: a pinned panel
    // must not arm the close delay it is guarded against.
    content.fire("pointerout", { target: anchor, relatedTarget: null });
    panel.fire("pointerleave", {});
    fire("scroll", {});
    assert.deepEqual(clock.delays(), [], "no delay may take a dragged panel away");
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

      assert.equal(panel.style.left, left, "the buttons keep their own meaning");
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

    assert.equal(parseFloat(panel.style.left), parseFloat(left) + DRAG_THRESHOLD_PX + 10);
    assert.equal(parseFloat(panel.style.top), parseFloat(top) + 10);

    // A render, a scroll and the pointer leaving all leave it alone.
    view.tag(content);
    content.fire("pointerout", { target: content, relatedTarget: null });
    fire("scroll", {});
    panel.fire("pointerleave", {});
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.style.left, String(parseFloat(left) + DRAG_THRESHOLD_PX + 10) + "px");
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
    assert.equal(panel.style.left, original, "the manual place does not outlive the panel");
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
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), "true", "the notice keeps its role");
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
