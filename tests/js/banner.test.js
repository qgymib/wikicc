/**
 * Tests for `src/web/js/banner.js`: the banner shown for a chapter that a
 * document does not have.
 *
 * The module is driven with a minimal fake DOM — plain objects with the few
 * methods the banner calls — because the rules under test are the timing and
 * the markup contract, not the browser's rendering: the banner must not take up
 * layout space, must go away on its own after `timeoutMs` and must be closable
 * from the button on its right.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { BANNER_TIMEOUT_MS, createBanner } from "../../src/web/js/banner.js";

/** Element stub: records children, attributes and listeners. */
function fakeElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    children: [],
    attributes: {},
    listeners: {},
    hidden: false,
    textContent: "",
    appended: [],
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      // Browsers make `textContent` read the subtree; the fake mirrors that so
      // a test can read a message off the root.
      if (child.nodeType === 3) {
        this.textContent = String(child.textContent);
      }
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

  return element;
}

/** A fake `document` that records the elements the banner builds. */
function fakeDocument() {
  const created = [];

  return {
    created,
    createElement(tagName) {
      const element = fakeElement(tagName);
      created.push(element);
      return element;
    },
    createElementNS(namespace, tagName) {
      const element = fakeElement(tagName);
      element.namespaceURI = namespace;
      created.push(element);
      return element;
    },
    createTextNode(value) {
      return { nodeType: 3, textContent: String(value) };
    },
  };
}

/** Fake timers, so a multi-second timeout costs no wall-clock time. */
function fakeClock() {
  let nextId = 1;
  const timers = new Map();

  return {
    pending() {
      return timers.size;
    },
    setTimeout(handler, delay) {
      const id = nextId++;
      timers.set(id, { handler, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) {
        timer.cleared = true;
      }
      timers.delete(id);
    },
    /** Run every timer that has not been cleared. */
    runAll() {
      const due = Array.from(timers.entries());
      timers.clear();
      due.forEach(function (entry) {
        if (!entry[1].cleared) {
          entry[1].handler();
        }
      });
    },
    /** Delays of the timers still pending, in scheduling order. */
    delays() {
      return Array.from(timers.values()).map((timer) => timer.delay);
    },
  };
}

function setup(options) {
  const container = fakeElement("main");
  const clock = fakeClock();
  const doc = fakeDocument();
  const banner = createBanner({
    container,
    document: doc,
    timers: clock,
    timeoutMs: 1000,
    ...(options || {}),
  });

  return { banner, container, clock, doc };
}

/** Every element below `root`, depth first, text nodes excluded. */
function descendants(root) {
  return root.children.flatMap(function (child) {
    return child.nodeType === 3 ? [] : [child].concat(descendants(child));
  });
}

/** Everything the banner reads out, depth first, leaving out the icons. */
function messageOf(root) {
  return descendants(root)
    .filter((element) => element.className !== "doc-alert-icon")
    .map((element) => {
      const own = element.children
        .filter((child) => child.nodeType === 3)
        .map((child) => child.textContent);

      return own.concat(
        element.children
          .filter((child) => child.nodeType === 3 || !child.children.length)
          .filter((child) => child.nodeType !== 3)
          .map((child) => child.textContent || ""),
      );
    })
    .flat()
    .join(" ");
}

/** The two `<code>` elements that carry the document and the chapter. */
function codesOf(root) {
  return descendants(root).filter(function (element) {
    return element.tagName === "CODE";
  });
}

test("the banner starts hidden and takes no layout space", () => {
  const { container } = setup();

  assert.equal(container.children.length, 1);
  const root = container.children[0];

  assert.equal(root.hidden, true);
  assert.equal(root.getAttribute("role"), "status");
  assert.equal(root.getAttribute("aria-live"), "polite");
  assert.equal(root.getAttribute("aria-hidden"), "true");
});

test("showing a broken reference fills in the document and the chapter", () => {
  const { banner, container } = setup();
  const root = container.children[0];

  banner.show({ docId: "guide/intro.md", anchor: "1.4 配色与字体" });

  assert.equal(root.hidden, false);
  assert.equal(root.getAttribute("aria-hidden"), null);
  assert.equal(root.getAttribute("data-open"), "true");
  assert.equal(banner.isOpen(), true);

  const text = messageOf(root);

  assert.match(text, /Chapter not found/);
  assert.match(text, /guide\/intro\.md/);
  assert.match(text, /1\.4 配色与字体与字体/);
});

test("the document and the chapter are their own elements, never concatenated html", () => {
  const { banner, container } = setup();
  const root = container.children[0];

  banner.show({ docId: "<b>x.md</b>", anchor: "<i>y</i>" });

  const codes = codesOf(root);

  assert.equal(codes.length, 2, "the message is built from child elements");
  assert.equal(codes[0].textContent, "<b>x.md</b>");
  assert.equal(codes[0].className, "doc-alert-code");
  assert.equal(codes[0].tagName, "CODE");
  assert.equal(codes[1].textContent, "<i>y</i>");
});

test("the banner closes itself after the timeout", () => {
  const { banner, container, clock } = setup();
  const root = container.children[0];

  banner.show({ docId: "a.md", anchor: "x" });

  assert.equal(clock.pending(), 1, "a countdown is scheduled");
  assert.equal(clock.delays().pop(), 1000, "the countdown uses the configured timeout");
  clock.runAll();

  assert.equal(root.hidden, true);
  assert.equal(banner.isOpen(), false);
  assert.equal(clock.pending(), 0);
});

test("the default timeout outlives a glance and stays short", () => {
  assert.ok(BANNER_TIMEOUT_MS >= 4000, "long enough to read the message");
  assert.ok(BANNER_TIMEOUT_MS <= 12000, "short enough not to linger");
});

test("a second message restarts the countdown instead of stacking banners", () => {
  const { banner, container, clock } = setup();
  const root = container.children[0];

  banner.show({ docId: "a.md", anchor: "x" });
  const first = clock.pending();
  banner.show({ docId: "b.md", anchor: "y" });

  assert.equal(container.children.length, 1, "one banner only");
  assert.equal(clock.pending(), 1, "the old timer was cancelled");
  assert.equal(first, 1);

  const text = messageOf(root);
  assert.match(text, /b\.md/);
  assert.match(text, /y/);
  assert.doesNotMatch(text, /a\.md/);
});

test("the close button hides the banner and cancels the countdown", () => {
  const { banner, container, clock } = setup();
  const root = container.children[0];
  const close = root.children[root.children.length - 1];

  banner.show({ docId: "a.md", anchor: "x" });
  close.fire("click", { preventDefault() {}, stopPropagation() {} });

  assert.equal(root.hidden, true);
  assert.equal(banner.isOpen(), false);
  assert.equal(clock.pending(), 0, "nothing is left to fire");
});

test("the close button is reachable and labelled for assistive technology", () => {
  const { container } = setup();
  const root = container.children[0];
  const close = root.children[root.children.length - 1];

  assert.equal(close.className, "doc-alert-close");
  assert.equal(close.tagName, "BUTTON");
  assert.equal(close.getAttribute("type"), "button");
  assert.equal(close.getAttribute("aria-label"), "Dismiss");
  assert.ok(close.getAttribute("title"));
  assert.ok(close.children.length, "the button carries an icon");
});

test("hiding an already hidden banner is a no-op", () => {
  const { banner, container, clock } = setup();
  const root = container.children[0];

  banner.hide();
  banner.hide();

  assert.equal(root.hidden, true);
  assert.equal(clock.pending(), 0);
});

test("hiding does not touch the page layout", () => {
  const { banner, container } = setup();
  const root = container.children[0];

  banner.show({ docId: "a.md", anchor: "x" });
  banner.hide();

  assert.equal(container.children.length, 1, "the slot stays in place");
  assert.equal(root.getAttribute("aria-hidden"), "true");
});

test("a message longer than the timeout is shown in full", () => {
  const { banner, container } = setup();
  const root = container.children[0];
  const long = "第".repeat(400);

  banner.show({ docId: "a.md", anchor: long });

  assert.equal(root.hidden, false);
  assert.equal(codesOf(root)[1].textContent, long);
});

test("dispose removes the banner and its timers", () => {
  const { banner, container, clock } = setup();

  banner.show({ docId: "a.md", anchor: "x" });
  banner.dispose();

  assert.equal(container.children.length, 0);
  assert.equal(clock.pending(), 0);
  assert.equal(banner.isOpen(), false);
});

test("a banner survives a missing anchor by falling back to the document", () => {
  const { banner, container } = setup();
  const root = container.children[0];

  banner.show({ docId: "a.md", anchor: null });

  assert.equal(root.hidden, false);
  const codes = codesOf(root);
  assert.equal(codes[0].textContent, "a.md");
  assert.equal(codes[1].textContent, "", "an empty chapter rather than a null");
});
