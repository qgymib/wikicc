/**
 * Tests for `src/web/js/search-view.js`: the search panel around the engine.
 *
 * Driven with a minimal fake DOM — plain objects carrying just the members the
 * view touches — because the rules under test are about *when* things happen,
 * not how the browser paints them: typing debounces into one query, the list
 * and the preview describe the same row, Enter opens what is selected, and the
 * panel goes away on Escape or on a press outside it.
 *
 * The fake page follows the browser where it matters here: a text node is a
 * node with a tag of `#text`, so a test can tell a `<mark>` from the text
 * around it and prove that document text never arrived as markup.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLEAR_LABEL,
  EMPTY_CLASS,
  OPEN_ATTRIBUTE,
  PANEL_LABEL,
  PREVIEW_IDLE_LABEL,
  RESULT_CLASS,
  RESULTS_IDLE_LABEL,
  createSearchView,
  isSearchShortcut,
} from "../../src/web/js/search-view.js";

/** Every timer the view scheduled while the fake timers were installed. */
const timers = [];

/** A fake element: attributes, listeners, children and the text written into it. */
function fakeElement(tagName) {
  var element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    children: [],
    attributes: {},
    listeners: {},
    hidden: false,
    focused: false,
    selected: false,
    value: "",
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      var index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
      }
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      var list = this.listeners[type] || [];
      var index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
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
    contains(node) {
      if (node === this) {
        return true;
      }
      return this.children.some(function (child) {
        return typeof child.contains === "function" && child.contains(node);
      });
    },
    /** Every descendant whose class list holds `name`, the panel included. */
    findAll(name) {
      var found = [];
      (function walk(node) {
        (node.children || []).forEach(function (child) {
          if (String(child.className).split(" ").indexOf(name) !== -1) {
            found.push(child);
          }
          walk(child);
        });
      })(this);

      return found;
    },
    /** Every descendant with `tagName`, which is how a `<mark>` is counted. */
    findAllByTag(tagName) {
      var found = [];
      var wanted = String(tagName).toUpperCase();
      (function walk(node) {
        (node.children || []).forEach(function (child) {
          if (child.tagName === wanted) {
            found.push(child);
          }
          walk(child);
        });
      })(this);

      return found;
    },
  };

  var text = "";
  Object.defineProperty(element, "textContent", {
    get() {
      return text;
    },
    set(value) {
      text = String(value);
      element.children = [];
    },
  });

  return element;
}

/**
 * A text node, which is how a snippet's plain text reaches the page.
 *
 * `markup` is what a browser would make of the text if it were parsed as HTML;
 * it is never set here, so a test that finds it missing proves the text was
 * written with `textContent` instead of `innerHTML`.
 */
function textNode(value) {
  return { nodeType: 3, tagName: "#text", textContent: String(value), children: [] };
}

/** The text of a subtree, as `textContent` reads it in a browser. */
function textOf(node) {
  if (node.nodeType === 3) {
    return node.textContent;
  }
  if (!node.children.length) {
    return node.textContent;
  }

  return node.children.map(textOf).join("");
}

/** Install a fake page, run `work`, then restore it. */
function withPage(work) {
  var previous = {
    document: globalThis.document,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  var body = fakeElement("body");
  var container = fakeElement("div");
  container.id = "search-panel";
  body.appendChild(container);

  var documentListeners = {};
  var doc = {
    body: body,
    documentElement: fakeElement("html"),
    getElementById() {
      return null;
    },
    createElement(tagName) {
      return fakeElement(tagName);
    },
    createElementNS(namespace, tagName) {
      return fakeElement(tagName);
    },
    createTextNode(value) {
      return textNode(value);
    },
    addEventListener(type, handler) {
      (documentListeners[type] = documentListeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      var list = documentListeners[type] || [];
      var index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
  };

  globalThis.document = doc;
  globalThis.setTimeout = function (callback) {
    timers.push(callback);
    return timers.length;
  };
  globalThis.clearTimeout = function (id) {
    if (id > 0 && id <= timers.length) {
      timers[id - 1] = null;
    }
  };

  try {
    return work({
      container: container,
      /** Deliver a press anywhere: the panel listens to the whole document. */
      press(target) {
        (documentListeners.pointerdown || []).slice().forEach(function (handler) {
          handler({ target: target });
        });
      },
      /** Run the debounced query the field scheduled, if any is pending. */
      settle() {
        var pending = timers.splice(0, timers.length).filter(Boolean);
        pending.forEach(function (callback) {
          callback();
        });
      },
      pending() {
        return timers.filter(Boolean).length;
      },
      documentListenerCount() {
        return (documentListeners.pointerdown || []).length;
      },
    });
  } finally {
    globalThis.document = previous.document;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
    timers.length = 0;
  }
}

/** The snippet a result carries: a body hit with both ends cut. */
function snippet(hit) {
  return { before: "or ", hit: hit, after: " and more", trimmedStart: true, trimmedEnd: true };
}

/** One entry as `search.js` returns it. */
function entry(id, title, hit) {
  return {
    id: id,
    title: title,
    path: id,
    snippet: hit ? snippet(hit) : null,
  };
}

/** The preview area, which is the panel's last child. */
function previewOf(page) {
  return page.container.children[page.container.children.length - 1];
}

/** The panel built over `container`, with `onQuery`/`onSelect` recorded. */
function build(options) {
  var calls = { queries: [], selections: [] };
  var view = createSearchView({
    container: options.container,
    toggle: options.toggle,
    delay: 0,
    onQuery(query) {
      calls.queries.push(query);
      if (options.answer) {
        view.setResults(options.answer(query), 0);
      }
    },
    onSelect(id, anchor) {
      calls.selections.push({ id: id, anchor: anchor });
      if (options.onSelect) {
        options.onSelect(id, anchor);
      }
    },
  });

  return { view: view, calls: calls };
}

/** Type `value` into the field and settle the debounce. */
function type(view, page, value) {
  var input = view.input();
  input.value = value;
  input.fire("input", { target: input });
  page.settle();
}

test("the panel starts hidden, each half naming itself", () => {
  withPage(function (page) {
    var built = build({ container: page.container });

    assert.equal(built.view.isOpen(), false);
    assert.equal(page.container.hidden, true);
    assert.equal(page.container.getAttribute("role"), "dialog");
    assert.equal(page.container.getAttribute("aria-label"), PANEL_LABEL);

    var empties = page.container.findAll(EMPTY_CLASS);
    assert.equal(empties.length, 2, "neither half is left blank");
    assert.equal(empties[0].textContent, RESULTS_IDLE_LABEL);
    assert.equal(previewOf(page).children[0].textContent, PREVIEW_IDLE_LABEL);
  });
});

test("opening shows the panel and focuses the field", () => {
  withPage(function (page) {
    var built = build({ container: page.container });

    built.view.open();

    assert.equal(built.view.isOpen(), true);
    assert.equal(page.container.hidden, false);
    assert.equal(page.container.getAttribute(OPEN_ATTRIBUTE), "true");
    assert.equal(built.view.input().focused, true);
    assert.equal(built.view.input().selected, true);
  });
});

test("closing empties the query and hides the panel", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });

    built.view.open();
    type(built.view, page, "alpha");
    assert.equal(built.view.query(), "alpha");

    built.view.close();

    assert.equal(built.view.isOpen(), false);
    assert.equal(built.view.query(), "");
    assert.equal(page.container.hidden, true);
    assert.equal(page.container.hasAttribute(OPEN_ATTRIBUTE), false);
    assert.equal(page.container.findAll(RESULT_CLASS).length, 0);
  });
});

test("typing asks one question per pause, not one per keystroke", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer(query) {
        return [entry("a.md", "Alpha", query)];
      },
    });
    built.view.open();

    var input = built.view.input();
    input.value = "a";
    input.fire("input", { target: input });
    input.value = "al";
    input.fire("input", { target: input });
    input.value = "alp";
    input.fire("input", { target: input });

    assert.equal(built.calls.queries.length, 0, "nothing is asked while the hand is still moving");

    page.settle();

    assert.deepEqual(built.calls.queries, ["alp"]);
  });
});

test("the list shows the title and the context of every match", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "alp");

    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].getAttribute("role"), "option");
    assert.equal(rows[0].getAttribute("aria-selected"), "true");
    assert.equal(rows[1].getAttribute("aria-selected"), "false");
    assert.equal(
      page.container.findAll("search-result-title")[0].textContent,
      "Alpha",
    );

    var context = page.container.findAll("search-result-context")[0];
    assert.equal(textOf(context), "\u2026or alpha and more\u2026");
    assert.equal(
      page.container.findAll("search-result-context")[1].parentNode.getAttribute("aria-selected"),
      "false",
    );
  });
});

test("the context of a match never arrives as markup", () => {
  withPage(function (page) {
    // The title is the document's own name and the context is its own text;
    // both are printed as written, so a document containing markup cannot
    // become markup on this page.
    var title = "<img src=x onerror=alert(1)>";
    var hit = "<b>bold</b>";
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", title, hit)];
      },
    });
    built.view.open();
    type(built.view, page, "bold");

    assert.equal(page.container.findAll("search-result-title")[0].textContent, title);

    var marks = page.container.findAllByTag("mark");
    assert.ok(marks.length > 0, "the hit is marked in the list and in the preview: " + marks.length);
    assert.ok(
      marks.every(function (node) {
        return node.innerHTML === undefined;
      }),
      "the text is set as text, not parsed",
    );
    assert.equal(page.container.findAll("search-result-context")[0].children[1].textContent, hit);
  });
});

test("the preview shows the passage of the selected match, with the hit marked", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "beta");

    // The engine's ranking decides the order, and the first entry is the one
    // selected; the preview is the passage of that entry.
    var preview = previewOf(page);
    var passage = preview.children[0];
    assert.equal(passage.className, "search-passage");
    assert.deepEqual(
      passage.children.map(function (node) {
        assert.ok(!node.children.length, "a passage is text and one mark, never markup");
        return node.tagName === "MARK" ? "[" + textOf(node) + "]" : textOf(node);
      }),
      ["\u2026or ", "[alpha]", " and more\u2026"],
    );
  });
});

test("moving the selection moves the preview with it", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    // The preview is the last child of the panel, past the list it follows.
    var preview = previewOf(page);
    var input = built.view.input();
    assert.equal(preview.children[0].children[1].textContent, "alpha");

    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(preview.children[0].children[1].textContent, "beta");

    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[0].getAttribute("aria-selected"), "false");
    assert.equal(rows[1].getAttribute("aria-selected"), "true");

    input.fire("keydown", { key: "ArrowUp" });
    assert.equal(preview.children[0].children[1].textContent, "alpha");
  });
});

test("the arrow keys stay inside the list", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    var input = built.view.input();
    input.fire("keydown", { key: "ArrowUp" });
    assert.equal(page.container.findAll(RESULT_CLASS)[0].getAttribute("aria-selected"), "true");

    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[1].getAttribute("aria-selected"), "true");
    assert.equal(rows[0].getAttribute("aria-selected"), "false");
  });
});

test("Enter opens the selected document and closes the panel", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    var input = built.view.input();
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "Enter" });

    // Moving to the second entry is what picks it: `Enter` settles only a
    // query that has not been asked yet, and this one has been.
    assert.deepEqual(built.calls.selections, [{ id: "b.md", anchor: null }]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("Enter asks for what was typed even when the pause has not come yet", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer(query) {
        return [entry("a.md", "Alpha", query)];
      },
    });
    built.view.open();

    var input = built.view.input();
    input.value = "alp";
    input.fire("input", { target: input });
    input.fire("keydown", { key: "Enter" });

    assert.deepEqual(built.calls.queries, ["alp"], "a query still pending is asked now");
    assert.deepEqual(built.calls.selections, [{ id: "a.md", anchor: null }]);
  });
});

test("clicking a result opens it", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    page.container.findAll(RESULT_CLASS)[1].fire("click", { preventDefault() {} });

    assert.deepEqual(built.calls.selections, [{ id: "b.md", anchor: null }]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("a press inside the panel leaves it open", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    page.press(built.view.input());

    assert.equal(built.view.isOpen(), true);
  });
});

test("a press anywhere else closes the panel", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    page.press({ tagName: "ARTICLE" });

    assert.equal(built.view.isOpen(), false);
  });
});

test("a press on the toggle is left to the button that opens the panel", () => {
  withPage(function (page) {
    var button = fakeElement("button");
    var built = build({ container: page.container, toggle: button });
    built.view.open();

    page.press(button);

    assert.equal(built.view.isOpen(), true);
  });
});

test("a press outside the panel closes it even when a toggle is given", () => {
  withPage(function (page) {
    var built = build({ container: page.container, toggle: fakeElement("button") });
    built.view.open();

    page.press({ tagName: "ARTICLE" });

    assert.equal(built.view.isOpen(), false);
  });
});

test("the toggle describes the panel however it closes", () => {
  withPage(function (page) {
    var button = fakeElement("button");
    var built = build({ container: page.container, toggle: button });

    built.view.open();
    assert.equal(button.getAttribute("aria-expanded"), "true");

    built.view.close();
    assert.equal(button.getAttribute("aria-expanded"), "false");
  });
});

test("opening a result says the panel closed on the toggle", () => {
  withPage(function (page) {
    var button = fakeElement("button");
    var built = build({
      container: page.container,
      toggle: button,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    built.view.input().fire("keydown", { key: "Enter" });

    assert.equal(built.view.isOpen(), false);
    assert.equal(button.getAttribute("aria-expanded"), "false");
  });
});

test("Escape closes the panel", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    var prevented = false;
    built.view.input().fire("keydown", {
      key: "Escape",
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(built.view.isOpen(), false);
    assert.equal(prevented, true, "the key must not also close the preview behind it");
    assert.equal(page.container.hidden, true);
  });
});

test("a query that matches nothing empties both halves, each naming itself", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [];
      },
    });
    built.view.open();
    type(built.view, page, "zzz");

    var empties = page.container.findAll(EMPTY_CLASS);
    assert.equal(page.container.findAll(RESULT_CLASS).length, 0);
    assert.equal(empties.length, 2, "the list and the preview both have nothing");
    assert.deepEqual(
      empties.map(textOf),
      [RESULTS_IDLE_LABEL, PREVIEW_IDLE_LABEL],
      "a half with nothing says which half it is, not what went wrong",
    );
  });
});

test("a document matched on its title alone has no passage to preview", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", null)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    assert.equal(
      page.container.findAll("search-result-context")[0].textContent,
      "a.md",
      "the path stands in for the passage the document does not have",
    );
    assert.equal(page.container.findAll(EMPTY_CLASS)[0].textContent, PREVIEW_IDLE_LABEL);
    assert.equal(page.container.findAll("mark").length, 0);
  });
});

test("an empty query empties the panel again", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");
    assert.equal(page.container.findAll(RESULT_CLASS).length, 1);

    type(built.view, page, "   ");

    assert.equal(page.container.findAll(RESULT_CLASS).length, 0);
    assert.equal(page.container.findAll(EMPTY_CLASS)[0].textContent, RESULTS_IDLE_LABEL);
    assert.deepEqual(built.calls.queries, ["alpha"], "a blank query is not asked about");
  });
});

test("the clear button empties the field and the list", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var clear = page.container.findAll("search-clear")[0];
    assert.equal(clear.getAttribute("aria-label"), CLEAR_LABEL);
    assert.equal(clear.hidden, false);

    clear.fire("click", { preventDefault() {} });

    assert.equal(built.view.query(), "");
    assert.equal(clear.hidden, true);
    assert.equal(page.container.findAll(RESULT_CLASS).length, 0);
  });
});

test("reopening a panel with a query asks about it again", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer(query) {
        return [entry("a.md", "Alpha", query)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    built.view.close();
    built.view.open();

    assert.deepEqual(built.calls.queries, ["alpha"]);
    assert.equal(built.view.input().focused, true);
    assert.equal(page.container.findAll(RESULT_CLASS).length, 0, "a closed panel forgets its list");
  });
});

test("disposing takes the panel and its page listener away", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    assert.equal(page.documentListenerCount(), 1);

    built.view.dispose();

    assert.equal(page.documentListenerCount(), 0);
    assert.equal(page.container.children.length, 0);
    assert.equal(built.view.isOpen(), false);
  });
});

test("a shell without a panel is inert rather than fatal", () => {
  var view = createSearchView({ container: null });

  view.open();
  assert.equal(view.isOpen(), false);
  assert.equal(view.query(), "");
  view.setResults([entry("a.md", "Alpha", "alpha")], 0);
  view.close();
  view.dispose();
});

test("the shortcut is Ctrl+F or Cmd+F, and nothing else", () => {
  assert.equal(isSearchShortcut({ key: "f", ctrlKey: true }), true);
  assert.equal(isSearchShortcut({ key: "F", ctrlKey: true }), true);
  assert.equal(isSearchShortcut({ key: "f", metaKey: true }), true);
  assert.equal(isSearchShortcut({ key: "f" }), false);
  assert.equal(isSearchShortcut({ key: "f", ctrlKey: true, altKey: true }), false);
  assert.equal(isSearchShortcut({ key: "g", ctrlKey: true }), false);
  assert.equal(isSearchShortcut(null), false);
});
