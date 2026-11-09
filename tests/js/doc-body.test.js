/**
 * Tests for `src/web/js/doc-body.js`: the shared document-body render.
 *
 * Driven with a minimal fake DOM — an element records the markup written into
 * it and the queries run over it — because the rules under test are about
 * *what* the shared render does, not how the browser paints it: the class
 * composition, the markup injection, whether the tables were handed to the
 * enhancer, and whether the chapters were given their fold arrows, which is
 * the caller's declared intent.
 *
 * The chapter half is tested at two levels. `chapterRanges` is pure and is
 * asserted on its own; `enhanceChapters` is driven through the fake DOM, which
 * follows the browser where it matters here: `children` is live, `insertBefore`
 * puts a node where it is asked, and an event fires at the element a click
 * landed on, so the handler's delegation is exercised the way a reader's click
 * exercises it.
 *
 * The copy half runs through the same fake DOM: the buttons are wrapped and
 * pressed the way a reader's press arrives, the veteran `execCommand` route
 * answers at once as it does in a browser, the asynchronous clipboard API is
 * stubbed the way `graph-view.test.js` installs its globals, and the revert
 * of the copied state runs through fake timers, which are drained before the
 * runtime's own come back.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BODY_CLASS,
  CODE_BLOCK_CLASS,
  COLLAPSIBLE_CLASS,
  COPY_BUTTON_CLASS,
  TOGGLE_CLASS,
  chapterRanges,
  createDocBody,
  drawDiagrams,
  expandTo,
  fillDocBody,
} from "../../src/web/js/doc-body.js";

/**
 * Element stub: records markup writes and every query run over it.
 *
 * `children` is a real array that `appendChild` and `insertBefore` maintain,
 * because chapter folding reads it as the browser's live collection.
 */
function fakeElement(tagName, owner) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    children: [],
    parentNode: null,
    attributes: {},
    listeners: {},
    queries: [],
    innerHTML: "",
    ownerDocument: owner || null,
    classList: null,
    style: {},
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
    /** The copy wrapper takes the block's own place among the siblings. */
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
    insertBefore(child, reference) {
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index < 0) {
        this.children.push(child);
      } else {
        this.children.splice(index, 0, child);
      }
      child.parentNode = this;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    hasAttribute(name) {
      return Object.hasOwn(this.attributes, name);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    /** A textarea answers select, the way the copy's veteran route asks. */
    select() {
      this.selected = true;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    /** A heading answers its own next sibling from the parent's collection. */
    get nextSibling() {
      if (!this.parentNode) {
        return null;
      }
      const index = this.parentNode.children.indexOf(this);
      return index >= 0 ? this.parentNode.children[index + 1] || null : null;
    },
    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
    },
    /** Fire at this element: the handlers are those delegated onto it. */
    fire(type, event) {
      (this.listeners[type] || []).slice().forEach(function (handler) {
        handler(event || { target: this });
      });
    },
    querySelectorAll(selector) {
      this.queries.push(String(selector));
      if (String(selector) === "h1,h2,h3,h4,h5,h6") {
        return this.children.filter(function (child) {
          return /^H[1-6]$/.test(child.tagName);
        });
      }
      if (String(selector) === "pre.code") {
        const found = [];
        (function walk(node) {
          (node.children || []).forEach(function (child) {
            if (
              child.tagName === "PRE" &&
              String(child.className).split(" ").indexOf("code") !== -1
            ) {
              found.push(child);
            }
            walk(child);
          });
        })(this);
        return found;
      }
      return [];
    },
    closest(selector) {
      const wanted = String(selector).replace(/^\./, "");
      let node = this;
      while (node) {
        if (String(node.className).split(" ").indexOf(wanted) !== -1) {
          return node;
        }
        node = node.parentNode;
      }
      return null;
    },
  };

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

  return element;
}

/** A document stub whose elements all know their owner. */
function fakeDocument() {
  const doc = {
    created: [],
    createdNS: [],
    commands: [],
    createElement(tagName) {
      const element = fakeElement(tagName, doc);
      doc.created.push(element);
      return element;
    },
    createElementNS(_namespace, tagName) {
      const element = fakeElement(tagName, doc);
      doc.createdNS.push(element);
      return element;
    },
    /** The copy command's veteran route, as a real document answers it. */
    execCommand(command) {
      doc.commands.push(String(command));
      return true;
    },
  };

  // `document.body` is there the moment a page is; the fake builds its own
  // the first time something asks, so the tests that never copy pay nothing.
  Object.defineProperty(doc, "body", {
    get() {
      if (!doc.pageBody) {
        doc.pageBody = fakeElement("body", doc);
      }
      return doc.pageBody;
    },
  });

  return doc;
}

/** Install a fake `document`, run `work` with it, restore. */
function withDocument(work) {
  const previous = globalThis.document;
  const doc = fakeDocument();
  globalThis.document = doc;

  try {
    work(doc);
  } finally {
    globalThis.document = previous;
  }
}

/**
 * Install a fake page carrying a document body, run `work` with it, restore.
 *
 * The body is a real element of the fake document, so the arrows the enhancer
 * inserts come from the same `createElement` a browser would give them.
 *
 * The fake `innerHTML` setter does not parse markup — a stub that did would be
 * a parser, not a page — so `markup` puts the chapters in through the same
 * `appendChild` calls the real markup would produce, and the attribute is only
 * kept as text.
 */
function withBody(work, markup) {
  withDocument(function (doc) {
    const body = doc.createElement("div");
    body.className = BODY_CLASS;

    if (typeof markup === "function") {
      markup(body, doc);
      body.innerHTML = "the markup of a document";
    }

    work(body, doc);
  });
}

/** Append a heading to `body`, as the markup of a document would. */
function addHeading(body, doc, level, id) {
  const heading = doc.createElement("h" + level);
  heading.id = id;
  body.appendChild(heading);
  return heading;
}

/** Append a paragraph to `body`, as the markup of a document would. */
function addParagraph(body, doc, text) {
  const paragraph = doc.createElement("p");
  paragraph.textContent = text;
  body.appendChild(paragraph);
  return paragraph;
}

/**
 * The arrow `heading` carries, or `null`.
 *
 * Searched for among the heading's own children, because the arrow is the
 * heading's first element and the heading's live `children` is also what the
 * enhancer itself walks.
 */
function toggleOf(heading) {
  const found = heading.children.filter(function (child) {
    return child.classList.contains(TOGGLE_CLASS);
  });
  return found[0] || null;
}

/** Press an arrow the way a reader does: a click that lands on it. */
function press(body, button) {
  body.fire("click", { target: button });
}

/** Whether every element of `elements` carries `hidden`. */
function allHidden(elements) {
  return elements.every(function (element) {
    return element.hasAttribute("hidden");
  });
}

/**
 * Append a code block to `body`, shaped the way the build emits one.
 *
 * A fenced block carries a language class on its `code`; an indented one
 * does not. The text ends in the newline the build always writes.
 */
function addCodeBlock(body, doc, code, language) {
  const pre = doc.createElement("pre");
  pre.className = "code";
  const codeElement = doc.createElement("code");
  if (language) {
    codeElement.className = "language-" + language;
  }
  codeElement.textContent = code;
  pre.appendChild(codeElement);
  body.appendChild(pre);
  return pre;
}

/** The copy button beside `pre` in its wrapper, or `null` when unwrapped. */
function copyButtonOfBlock(pre) {
  const wrapper = pre.parentNode;
  if (!wrapper || !wrapper.classList.contains(CODE_BLOCK_CLASS)) {
    return null;
  }
  const found = wrapper.children.filter(function (child) {
    return child.classList.contains(COPY_BUTTON_CLASS);
  });
  return found[0] || null;
}

/**
 * Install a fake global for as long as the synchronous `work` runs, restore
 * after.
 *
 * The same gesture-scoped swap `graph-view.test.js` makes for its globals:
 * nothing installed here may outlive the test that asked for it.
 */
function installGlobal(name, value) {
  const previous = globalThis[name];
  Object.defineProperty(globalThis, name, {
    value: value,
    configurable: true,
    writable: true,
  });
  return previous;
}

/**
 * Run `work` with the fake timers installed, then settle what it scheduled.
 *
 * The runtime's own `setTimeout` is back before this returns — the test
 * runner schedules its own bookkeeping through the same globals, so a
 * replacement that outlives the work would swallow it and keep the process
 * alive for ever. Only the timers that already exist run: the copied state's
 * revert is the leftover of the press, not work anyone is waiting for.
 */
function withTimers(work) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const queue = [];
  let ids = 0;

  installGlobal("setTimeout", function (callback) {
    queue.push({ callback: callback });
    return ++ids;
  });
  installGlobal("clearTimeout", function () {});

  try {
    work();
  } finally {
    installGlobal("setTimeout", realSetTimeout);
    installGlobal("clearTimeout", realClearTimeout);

    const pending = queue.splice(0, queue.length);
    for (const timer of pending) {
      timer.callback();
    }
  }
}

/* ---------- the body itself ---------- */

test("the shared body class is the article's own typography class", () => {
  assert.equal(BODY_CLASS, "doc-body");
});

test("createDocBody builds a doc-body carrying the markup", () => {
  withDocument(function (doc) {
    const body = createDocBody("<p>alpha</p>");

    assert.equal(doc.created.length, 1, "one element, built by the document");
    assert.equal(body.tagName, "DIV");
    assert.equal(body.className, "doc-body");
    assert.equal(
      body.innerHTML,
      "<p>alpha</p>",
      "the markup arrived as markup",
    );
    assert.equal(fillDocBody(body, ""), body, "the fill hands the body back");
  });
});

test("createDocBody names the container first and typesets it second", () => {
  withDocument(function () {
    const body = createDocBody("<p>alpha</p>", {
      extraClass: "search-document",
    });

    assert.equal(
      body.className,
      "search-document doc-body",
      "what it is, then that it typesets like the article",
    );
  });
});

test("fillDocBody enhances the tables when the caller says so", () => {
  withDocument(function () {
    const body = fakeElement("div");

    fillDocBody(body, "<table></table>", { enhanceTables: true });

    assert.equal(body.innerHTML, "<table></table>");
    assert.deepEqual(body.queries, ["table"], "the enhancer walked the body");
  });
});

test("fillDocBody leaves the tables alone unless asked", () => {
  withDocument(function () {
    const body = fakeElement("div");

    fillDocBody(body, "<table></table>");
    assert.deepEqual(body.queries, [], "no walk without the option");

    fillDocBody(body, "<p>alpha</p>", { enhanceTables: false });
    assert.deepEqual(
      body.queries,
      [],
      "an explicit false is the same as absent",
    );
  });
});

test("fillDocBody leaves the chapters alone unless asked", () => {
  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { enhanceTables: false });

      assert.equal(
        body.classList.contains(COLLAPSIBLE_CLASS),
        false,
        "the search preview and the hover preview fold nothing",
      );
      assert.equal(toggleOf(body.children[0]), null, "no arrow was added");
    },
    function (body, doc) {
      addHeading(body, doc, 2, "a");
      addParagraph(body, doc, "alpha");
      addHeading(body, doc, 2, "b");
    },
  );
});

test("drawDiagrams hands the body to the diagram engine", () => {
  withDocument(function () {
    const body = fakeElement("div");

    const drawing = drawDiagrams(body, "dark");

    // The engine answers a promise even when there is nothing to draw — a
    // body without diagram blocks is the common case — and the recorded query
    // is the evidence the body, not something else, was handed over.
    assert.equal(
      typeof drawing.then,
      "function",
      "the drawing is asynchronous",
    );
    assert.deepEqual(
      body.queries,
      ["pre.mermaid"],
      "the engine walked the body for diagrams",
    );
  });
});

/* ---------- which headings own which chapters ---------- */

test("a chapter runs up to the next heading of its own or a higher level", () => {
  // A (h1), A1 (h2), A1a (h3), A1b (h3), A2 (h2), B (h1), B1 (h2)
  assert.deepEqual(chapterRanges([1, 2, 3, 3, 2, 1, 2]), [
    { start: 0, end: 5 },
    { start: 1, end: 4 },
    { start: 2, end: 3 },
    { start: 3, end: 4 },
    { start: 4, end: 5 },
    { start: 5, end: 7 },
    { start: 6, end: 7 },
  ]);
});

test("a chapter of equal level never swallows the one after it", () => {
  assert.deepEqual(chapterRanges([2, 2, 2]), [
    { start: 0, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]);
});

test("a chapter holds everything below it however deep the outline jumps", () => {
  assert.deepEqual(chapterRanges([2, 4, 5]), [
    { start: 0, end: 3 },
    { start: 1, end: 3 },
    { start: 2, end: 3 },
  ]);
});

test("a document without headings has no chapters", () => {
  assert.deepEqual(chapterRanges([]), []);
  assert.deepEqual(chapterRanges(null), []);
});

/* ---------- the arrows ---------- */

/** The nested chapter of the fixture: one (h2) · one-a (h3) · two (h2). */
function nestedOutline(body, doc, out) {
  out.first = addHeading(body, doc, 2, "one");
  out.alpha = addParagraph(body, doc, "alpha");
  out.nested = addHeading(body, doc, 3, "one-a");
  out.beta = addParagraph(body, doc, "beta");
  out.second = addHeading(body, doc, 2, "two");
  out.gamma = addParagraph(body, doc, "gamma");
  return out;
}

test("every heading with a chapter is given an arrow inside the heading", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      const { first, nested, second } = out;
      assert.equal(body.classList.contains(COLLAPSIBLE_CLASS), true);

      const firstArrow = toggleOf(first);
      assert.ok(firstArrow, "the chapter in the middle of the document folds");
      assert.equal(firstArrow.tagName, "BUTTON");
      assert.equal(firstArrow.getAttribute("type"), "button");
      assert.equal(firstArrow.getAttribute("aria-expanded"), "true");
      assert.equal(firstArrow.getAttribute("aria-label"), "Collapse section");
      assert.equal(firstArrow.className, TOGGLE_CLASS);
      assert.equal(
        firstArrow.children[0].tagName,
        "SVG",
        "the arrow is drawn, not typed",
      );
      assert.equal(
        first.children.indexOf(firstArrow),
        0,
        "the arrow is the heading's first element",
      );

      assert.ok(
        toggleOf(nested),
        "a heading with content of its own folds, however deep",
      );
      assert.ok(toggleOf(second), "the trailing chapter folds too");
    },
    function (body, doc) {
      nestedOutline(body, doc, out);
    },
  );
});

test("clicking an arrow folds its whole chapter and only its chapter", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      const { first, alpha, nested, beta, second, gamma } = out;
      const arrow = toggleOf(first);
      press(body, arrow);

      assert.equal(
        arrow.getAttribute("aria-expanded"),
        "false",
        "the arrow now describes a folded chapter",
      );
      assert.equal(arrow.getAttribute("aria-label"), "Expand section");
      assert.ok(
        first.hasAttribute("data-collapsed"),
        "the heading says so too",
      );
      assert.equal(
        allHidden([alpha, nested, beta]),
        true,
        "the chapter's own content and its sub-chapters are folded with it",
      );
      assert.equal(
        first.hasAttribute("hidden"),
        false,
        "the heading stays: only the chapter is folded",
      );
      assert.equal(
        second.hasAttribute("hidden"),
        false,
        "the sibling is untouched",
      );
      assert.equal(
        gamma.hasAttribute("hidden"),
        false,
        "and so is its content",
      );
      assert.equal(
        toggleOf(second).hasAttribute("hidden"),
        false,
        "a chapter's arrow belongs to that chapter, never to the one before it",
      );
    },
    function (body, doc) {
      nestedOutline(body, doc, out);
    },
  );
});

test("clicking a folded chapter's arrow brings the chapter back", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      const { first, alpha, second, gamma } = out;
      const arrow = toggleOf(first);
      press(body, arrow);
      press(body, arrow);

      assert.equal(arrow.getAttribute("aria-expanded"), "true");
      assert.equal(arrow.getAttribute("aria-label"), "Collapse section");
      assert.equal(first.hasAttribute("data-collapsed"), false);
      assert.equal(alpha.hasAttribute("hidden"), false);
      assert.equal(second.hasAttribute("hidden"), false);
      assert.equal(gamma.hasAttribute("hidden"), false);
    },
    function (body, doc) {
      nestedOutline(body, doc, out);
    },
  );
});

test("a click that misses the arrow folds nothing", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      // The heading's own text is selectable and does nothing on a click; only
      // the arrow takes it.
      body.fire("click", { target: out.first });
      body.fire("click", { target: out.alpha });

      assert.equal(toggleOf(out.first).getAttribute("aria-expanded"), "true");
      assert.equal(out.alpha.hasAttribute("hidden"), false);
    },
    function (body, doc) {
      nestedOutline(body, doc, out);
    },
  );
});

test("a flat outline gets no arrows: folding it would hide nothing", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      assert.equal(toggleOf(out.first), null);
      assert.equal(toggleOf(out.second), null);
    },
    function (body, doc) {
      // Two headings of one level with nothing between them: folding either
      // would hide an empty range, so an arrow there would be a control that
      // does nothing.
      out.first = addHeading(body, doc, 2, "one");
      out.second = addHeading(body, doc, 2, "two");
    },
  );
});

test("a heading with nothing under it gets no arrow", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      // The first heading folds; the last one owns nothing after it. Fold-
      // ability is the heading's own, never its level's: one foldable heading
      // does not hand arrows to the empty ones beside it.
      assert.ok(toggleOf(out.first), "the heading with content folds");
      assert.equal(
        toggleOf(out.last),
        null,
        "the trailing heading owns nothing, so it gets no arrow",
      );
    },
    function (body, doc) {
      out.first = addHeading(body, doc, 2, "one");
      addParagraph(body, doc, "alpha");
      out.last = addHeading(body, doc, 2, "two");
      // The document ends here: the last heading owns nothing.
    },
  );
});

test("a heading folds its own content however deep it sits", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      assert.ok(toggleOf(out.outer), "the outer chapter has a sub-chapter");
      assert.ok(
        toggleOf(out.inner),
        "the deepest heading owns a paragraph, so it folds too",
      );
    },
    function (body, doc) {
      out.outer = addHeading(body, doc, 2, "outer");
      addParagraph(body, doc, "alpha");
      out.inner = addHeading(body, doc, 3, "inner");
      out.beta = addParagraph(body, doc, "beta");
    },
  );
});

/* ---------- navigating into a folded chapter ---------- */

test("expanding towards a chapter reopens the chapters that hold it", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      press(body, toggleOf(out.outer));
      assert.equal(
        out.beta.hasAttribute("hidden"),
        true,
        "the outer chapter is folded",
      );

      const expanded = expandTo(body, out.beta);

      assert.equal(
        expanded,
        true,
        "the route found something folded to reopen",
      );
      assert.equal(toggleOf(out.outer).getAttribute("aria-expanded"), "true");
      assert.equal(
        out.beta.hasAttribute("hidden"),
        false,
        "the content is back",
      );
      assert.equal(out.inner.hasAttribute("hidden"), false);
    },
    function (body, doc) {
      out.outer = addHeading(body, doc, 1, "outer");
      addParagraph(body, doc, "alpha");
      out.inner = addHeading(body, doc, 2, "inner");
      out.beta = addParagraph(body, doc, "beta");
      addHeading(body, doc, 1, "other");
      addParagraph(body, doc, "gamma");
    },
  );
});

test("expanding towards an open chapter changes nothing", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      assert.equal(expandTo(body, out.alpha), false);
      assert.equal(toggleOf(out.first).getAttribute("aria-expanded"), "true");
      assert.equal(out.alpha.hasAttribute("hidden"), false);
    },
    function (body, doc) {
      nestedOutline(body, doc, out);
    },
  );
});

test("a new document's body opens fully expanded", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });
      press(body, toggleOf(out.first));
    },
    function (body, doc) {
      nestedOutline(body, doc, out);
    },
  );

  // A document change builds a new body for the new markup rather than
  // refilling the old one, so the fold of the previous document goes with it:
  // a fold is a state of the document on screen, never a preference carried
  // across documents.
  const fresh = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { collapsible: true });

      assert.equal(
        toggleOf(fresh.first).getAttribute("aria-expanded"),
        "true",
        "the new document opens fully expanded",
      );
    },
    function (body, doc) {
      nestedOutline(body, doc, fresh);
    },
  );
});

/* ---------- the code copy buttons ---------- */

test("fillDocBody leaves the code blocks alone unless asked", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { enhanceTables: false });

      assert.equal(out.pre.parentNode, body, "the block stands where it was");
      assert.deepEqual(body.queries, [], "no walk without the option");
      assert.equal(copyButtonOfBlock(out.pre), null, "no button was added");
    },
    function (body, doc) {
      out.pre = addCodeBlock(body, doc, "let x = 1;\n", "js");
    },
  );
});

test("every code block the build emitted is wrapped with a labelled button", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { codeCopy: true });

      for (const pre of [out.fenced, out.indented]) {
        const wrapper = pre.parentNode;
        assert.equal(
          wrapper.classList.contains(CODE_BLOCK_CLASS),
          true,
          "the block lives in a wrapper now",
        );
        assert.equal(
          wrapper.children.indexOf(pre),
          0,
          "the pre is the wrapper's first element",
        );

        const button = copyButtonOfBlock(pre);
        assert.ok(button, "the block carries a copy button");
        assert.equal(button.tagName, "BUTTON");
        assert.equal(button.getAttribute("type"), "button");
        assert.equal(button.getAttribute("aria-label"), "Copy code");
        assert.equal(button.getAttribute("title"), "Copy code");
        assert.equal(button.className, COPY_BUTTON_CLASS);
        assert.equal(
          button.children[0].tagName,
          "SVG",
          "the glyph is drawn, not typed",
        );
        assert.equal(
          button.children[0].children.length,
          2,
          "two sheets make the glyph",
        );
      }

      assert.equal(out.math.parentNode, body, "a formula is not a code block");
      assert.equal(
        body.children.length,
        3,
        "each wrapper took its block's own place among the children",
      );
    },
    function (body, doc) {
      out.fenced = addCodeBlock(body, doc, "let x = 1;\n", "js");
      out.indented = addCodeBlock(body, doc, "let y = 2;\n", null);
      out.math = doc.createElement("pre");
      out.math.className = "math";
      body.appendChild(out.math);
    },
  );
});

test("pressing the button copies the code without its trailing newline", () => {
  const out = {};

  withBody(
    function (body, doc) {
      fillDocBody(body, "<ignored/>", { codeCopy: true });

      const button = copyButtonOfBlock(out.pre);
      press(body, button);

      assert.deepEqual(doc.commands, ["copy"], "the veteran command copied");
      const areas = doc.created.filter(function (element) {
        return element.tagName === "TEXTAREA";
      });
      assert.equal(areas.length, 1, "one textarea carried the text");
      assert.equal(
        areas[0].value,
        "let x = 1;",
        "the block's trailing newline does not ride along",
      );
      assert.equal(areas[0].getAttribute("readonly"), "");
      assert.ok(areas[0].selected, "the textarea was selected for the command");
      assert.equal(
        doc.body.children.indexOf(areas[0]),
        -1,
        "the textarea is gone again",
      );

      assert.equal(button.getAttribute("data-copied"), "");
      assert.equal(button.getAttribute("aria-label"), "Copied");
      assert.equal(button.getAttribute("title"), "Copied");

      // The revert timer is real here; dismiss it so it cannot outlive the
      // test and hold the runner for its full span.
      globalThis.clearTimeout(button.__wikiccCopyTimer);
    },
    function (body, doc) {
      out.pre = addCodeBlock(body, doc, "let x = 1;\n", "js");
    },
  );
});

test("the copied state reverts on its own", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { codeCopy: true });

      const button = copyButtonOfBlock(out.pre);

      withTimers(function () {
        press(body, button);
        assert.equal(
          button.hasAttribute("data-copied"),
          true,
          "the press said what it did",
        );
      });

      assert.equal(
        button.hasAttribute("data-copied"),
        false,
        "a moment later the button is back as it was",
      );
      assert.equal(button.getAttribute("aria-label"), "Copy code");
      assert.equal(button.getAttribute("title"), "Copy code");
    },
    function (body, doc) {
      out.pre = addCodeBlock(body, doc, "let x = 1;\n", "js");
    },
  );
});

test("the clipboard API is the route a page that has it offers first", async () => {
  const out = {};
  const writes = [];

  withBody(
    function (body) {
      const previous = installGlobal("navigator", {
        clipboard: {
          writeText: function (text) {
            writes.push(text);
            return Promise.resolve();
          },
        },
      });

      try {
        fillDocBody(body, "<ignored/>", { codeCopy: true });
        out.button = copyButtonOfBlock(out.pre);
        press(body, out.button);
      } finally {
        installGlobal("navigator", previous);
      }
    },
    function (body, doc) {
      out.pre = addCodeBlock(body, doc, "let x = 1;\n", "js");
    },
  );

  // The asynchronous write settles a turn later than the press; the
  // macrotask waits out every microtask, so the feedback is on by now.
  await new Promise(function (resolve) {
    setImmediate(resolve);
  });

  assert.deepEqual(
    writes,
    ["let x = 1;"],
    "the asynchronous clipboard got the text",
  );
  assert.equal(
    out.button.getAttribute("data-copied"),
    "",
    "and the button said so once it had",
  );

  // The revert timer is real; dismiss it so it cannot outlive the test.
  globalThis.clearTimeout(out.button.__wikiccCopyTimer);
});

test("a click that misses the button copies nothing", () => {
  const out = {};

  withBody(
    function (body, doc) {
      fillDocBody(body, "<ignored/>", { codeCopy: true });

      // The code itself is selectable text; only the button takes a press.
      body.fire("click", { target: out.pre });
      body.fire("click", { target: out.code });

      assert.deepEqual(doc.commands, [], "no copy left the page");
      assert.equal(
        copyButtonOfBlock(out.pre).hasAttribute("data-copied"),
        false,
        "and the button never claimed one",
      );
    },
    function (body, doc) {
      out.pre = addCodeBlock(body, doc, "let x = 1;\n", "js");
      out.code = out.pre.children[0];
    },
  );
});

test("an empty block takes no copy", () => {
  const out = {};

  withBody(
    function (body, doc) {
      fillDocBody(body, "<ignored/>", { codeCopy: true });

      press(body, copyButtonOfBlock(out.pre));

      assert.deepEqual(doc.commands, [], "there is nothing to write");
      assert.equal(
        copyButtonOfBlock(out.pre).hasAttribute("data-copied"),
        false,
        "and the button does not claim otherwise",
      );
    },
    function (body, doc) {
      out.pre = addCodeBlock(body, doc, "", "js");
    },
  );
});

test("a body filled twice does not wrap its blocks twice", () => {
  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { codeCopy: true });
      fillDocBody(body, "<ignored/>", { codeCopy: true });

      const blocks = body.querySelectorAll("pre.code");
      assert.equal(blocks.length, 1, "the block is still one");
      assert.equal(
        blocks[0].parentNode.children.length,
        2,
        "the wrapper holds the block and one button",
      );
    },
    function (body, doc) {
      addCodeBlock(body, doc, "let x = 1;\n", "js");
    },
  );
});

test("folding a chapter hides its code blocks with their buttons", () => {
  const out = {};

  withBody(
    function (body) {
      fillDocBody(body, "<ignored/>", { codeCopy: true, collapsible: true });

      const wrapper = out.pre.parentNode;
      assert.equal(wrapper.classList.contains(CODE_BLOCK_CLASS), true);

      press(body, toggleOf(out.heading));
      assert.equal(
        wrapper.hasAttribute("hidden"),
        true,
        "the fold hides the wrapper — block and button together",
      );

      press(body, toggleOf(out.heading));
      assert.equal(
        wrapper.hasAttribute("hidden"),
        false,
        "and brings them back",
      );
    },
    function (body, doc) {
      out.heading = addHeading(body, doc, 2, "one");
      addParagraph(body, doc, "alpha");
      out.pre = addCodeBlock(body, doc, "let x = 1;\n", "js");
    },
  );
});

test("pressing a copy button leaves the chapters as they are", () => {
  const out = {};

  withBody(
    function (body, doc) {
      fillDocBody(body, "<ignored/>", { codeCopy: true, collapsible: true });

      const arrow = toggleOf(out.heading);
      assert.ok(arrow, "the chapter is foldable");

      press(body, copyButtonOfBlock(out.pre));

      assert.equal(
        arrow.getAttribute("aria-expanded"),
        "true",
        "the copy is not a fold",
      );
      assert.equal(out.pre.parentNode.hasAttribute("hidden"), false);
      assert.deepEqual(doc.commands, ["copy"], "the copy went out as asked");

      // The revert timer is real; dismiss it so it cannot outlive the test.
      globalThis.clearTimeout(copyButtonOfBlock(out.pre).__wikiccCopyTimer);
    },
    function (body, doc) {
      out.heading = addHeading(body, doc, 2, "one");
      addParagraph(body, doc, "alpha");
      out.pre = addCodeBlock(body, doc, "let x = 1;\n", "js");
    },
  );
});
