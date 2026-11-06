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
  DOCUMENT_CLASS,
  EMPTY_CLASS,
  GLOBAL_MODE,
  HIT_ACTIVE_CLASS,
  HIT_CLASS,
  LOCAL_MODE,
  MODE_CLASS,
  MODE_GLOBAL_LABEL,
  MODE_LOCAL_LABEL,
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
    replaceChild(next, child) {
      var index = this.children.indexOf(child);
      if (index < 0) {
        return child;
      }
      this.children[index] = next;
      next.parentNode = this;
      child.parentNode = null;
      return child;
    },
    insertBefore(next, child) {
      var index = this.children.indexOf(child);
      if (index < 0) {
        this.children.push(next);
      } else {
        this.children.splice(index, 0, next);
      }
      next.parentNode = this;
      return next;
    },
    /** Descendants in document order, the way a tree walker visits them. */
    querySelectorAll() {
      return [];
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
    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
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
    /**
     * The nearest ancestor — this node included — matching a tag selector.
     *
     * Only the two forms the view asks for are understood: `a` and `a[href]`,
     * the latter requiring the attribute the view relies on.
     */
    closest(selector) {
      var wanted = String(selector).toUpperCase();
      var needsHref = wanted.indexOf("[HREF]") !== -1;
      var tag = wanted.split("[")[0];
      var node = this;

      while (node) {
        if (
          node.tagName === tag &&
          (!needsHref || node.getAttribute("href") !== null)
        ) {
          return node;
        }
        node = node.parentNode;
      }

      return null;
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
      // A node with children reads theirs, as a browser does; a node written
      // with `textContent` holds its own text and has none.
      return element.children.length
        ? element.children.map(textOf).join("")
        : text;
    },
    set(value) {
      text = String(value);
      element.children = [];
    },
  });

  /**
   * The markup written into the element, parsed into children.
   *
   * A real parser is not needed here: the payload's HTML is the build's own
   * output, so a test that reads it back only has to know tags and text. The
   * reading side returns the same markup it was given, which is what lets a
   * test prove a document was inserted *as* markup rather than as text.
   */
  var markup = "";
  Object.defineProperty(element, "innerHTML", {
    get() {
      return markup || element.children.map(outerOf).join("");
    },
    set(value) {
      markup = String(value);
      text = "";
      element.children = [];
      parseInto(element, markup);
    },
  });

  return element;
}

/** Markup of one node, rebuilt from what it holds. */
function outerOf(node) {
  if (node.nodeType === 3) {
    return node.textContent;
  }

  var attributes = Object.keys(node.attributes || {})
    .map(function (name) {
      return " " + name + '="' + node.attributes[name] + '"';
    })
    .join("");

  return (
    "<" +
    node.tagName.toLowerCase() +
    attributes +
    ">" +
    node.children.map(outerOf).join("") +
    "</" +
    node.tagName.toLowerCase() +
    ">"
  );
}

/**
 * Parse the tags of `html` into children of `root`.
 *
 * Deliberately minimal: every tag opens or closes, nothing is void, no
 * attributes matter beyond the class name. That is exactly what the build
 * emits for a document body, and anything more would be a parser the tests
 * then have to trust.
 */
function parseInto(root, html) {
  var open = [root];
  var pattern = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  var match = pattern.exec(html);

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
      var node = createNode(match[2]);
      var attribute = /([a-zA-Z-]+)="([^"]*)"/g;
      var found = attribute.exec(match[3] || "");

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

/**
 * The factory parsed markup's elements come from.
 *
 * A test that has to observe a node the payload's HTML brought in — the
 * `<pre>` a code block's hit scrolls to — swaps this for the page's own
 * factory while it runs, which `withPage` does; the default is the plain
 * one, so no test sees a hook it did not ask for.
 */
var createNode = fakeElement;

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
 * A text node, which is how a snippet's plain text reaches the page.
 *
 * `markup` is what a browser would make of the text if it were parsed as HTML;
 * it is never set here, so a test that finds it missing proves the text was
 * written with `textContent` instead of `innerHTML`.
 */
function textNode(value) {
  var node = { nodeType: 3, tagName: "#text", children: [], parentNode: null };
  var text = String(value);

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

  /**
   * Split this node at `offset`, as the browser does: the half after the cut
   * becomes a new node inserted right behind this one and is returned.
   */
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

/**
 * A walker over the text nodes below `root`, in document order.
 *
 * The walk is live, as the browser's own is: nodes that enter the tree while
 * it runs — the halves `splitText` leaves behind, the text a fresh mark now
 * holds — are visited where a browser would visit them, because the view's
 * bookkeeping depends on that behaviour rather than on a snapshot of it.
 */
function treeWalker(root) {
  /** The node the walk last returned, or the root before the first ask. */
  var current = root;

  /** The first text node below `node`, or `null`. */
  function firstText(node) {
    for (var index = 0; index < node.children.length; index += 1) {
      var child = node.children[index];
      if (child.nodeType === 3) {
        return child;
      }
      var found = firstText(child);
      if (found) {
        return found;
      }
    }

    return null;
  }

  /** The next text node from `node`'s position onward, or `null` at the end. */
  function nextFrom(node) {
    if (node.nodeType !== 3) {
      var inner = firstText(node);
      if (inner) {
        return inner;
      }
    }

    var parent = node.parentNode;
    while (parent) {
      var siblings = parent.children;
      for (
        var index = siblings.indexOf(node) + 1;
        index < siblings.length;
        index += 1
      ) {
        if (siblings[index].nodeType === 3) {
          return siblings[index];
        }
        var found = firstText(siblings[index]);
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

/** Install a fake page, run `work`, then restore it. */
function withPage(work) {
  var previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    createNode: createNode,
  };

  var body = fakeElement("body");
  var container = fakeElement("div");
  container.id = "search-panel";
  body.appendChild(container);

  /**
   * A hook run on every element the fake page creates.
   *
   * The view builds its own nodes, so a test that has to observe one — the
   * `<mark>` it scrolls to — can only do it from here.
   */
  var decorators = [];

  function make(tagName) {
    var element = fakeElement(tagName);
    decorators.forEach(function (decorate) {
      decorate(element);
    });

    return element;
  }

  var documentListeners = {};
  var doc = {
    body: body,
    documentElement: fakeElement("html"),
    getElementById() {
      return null;
    },
    createElement(tagName) {
      return make(tagName);
    },
    createElementNS(_namespace, tagName) {
      return make(tagName);
    },
    createTextNode(value) {
      return textNode(value);
    },
    createTreeWalker(root) {
      return treeWalker(root);
    },
    addEventListener(type, handler) {
      if (!documentListeners[type]) {
        documentListeners[type] = [];
      }
      documentListeners[type].push(handler);
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
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  // Parsed markup's elements go through the page's factory, so a test can
  // observe the `<pre>` a code block's hit is brought to as well.
  createNode = function (tagName) {
    return make(tagName);
  };
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
        (documentListeners.pointerdown || [])
          .slice()
          .forEach(function (handler) {
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
      /** Observe every element created from now on. */
      decorate(fn) {
        decorators.push(fn);
      },
    });
  } finally {
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
    createNode = previous.createNode;
    timers.length = 0;
  }
}

/** The snippet a result carries: a body hit with both ends cut. */
function snippet(hit) {
  return {
    before: "or ",
    hit: hit,
    after: " and more",
    trimmedStart: true,
    trimmedEnd: true,
  };
}

/** One entry as `search.js` returns it, naming its occurrence when given. */
function entry(id, title, hit, ordinal) {
  var row = {
    id: id,
    title: title,
    path: id,
    snippet: hit ? snippet(hit) : null,
  };
  if (typeof ordinal === "number") {
    row.hit = ordinal;
  }
  return row;
}

/** The preview area, which is the panel's last child. */
function previewOf(page) {
  return page.container.children[page.container.children.length - 1];
}

/** The panel built over `container`, with `onQuery`/`onSelect` recorded. */
function build(options) {
  var calls = { queries: [], modes: [], selections: [], asked: [] };
  var view = createSearchView({
    container: options.container,
    toggle: options.toggle,
    delay: 0,
    theme: function () {
      return "dark";
    },
    documents: {
      peek(id) {
        calls.asked.push(id);
        if (!options.documents) {
          return null;
        }
        return options.documents[id] || null;
      },
      get(id) {
        if (options.travelling) {
          return options.travelling(id);
        }
        return Promise.resolve(null);
      },
    },
    onQuery(query, mode) {
      calls.queries.push(query);
      calls.modes.push(mode);
      if (options.answer) {
        view.setResults(options.answer(query), 0);
      }
    },
    onSelect(id, anchor, jump) {
      // The jump is recorded only when it travels, so the assertions on the
      // paths that never carry one — the preview's links — stay as they were.
      var call = { id: id, anchor: anchor };
      if (jump !== undefined) {
        call.jump = jump;
      }
      calls.selections.push(call);
      if (options.onSelect) {
        options.onSelect(id, anchor, jump);
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

    assert.equal(
      built.calls.queries.length,
      0,
      "nothing is asked while the hand is still moving",
    );

    page.settle();

    assert.deepEqual(built.calls.queries, ["alp"]);
  });
});

test("every match is a row of the context it was found in and the file holding it", () => {
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

    // The passage leads the row and the file closes it, which is the order
    // the two columns are drawn in.
    var cells = rows[0].children;
    assert.equal(cells.length, 2);
    assert.equal(cells[0].className, "search-result-context");
    assert.equal(cells[1].className, "search-result-path");

    assert.equal(textOf(cells[0]), "\u2026or alpha and more\u2026");
    assert.equal(
      cells[1].textContent,
      "a.md",
      "the trailing column names the file, and nothing else",
    );
    assert.equal(
      cells[1].children.length,
      0,
      "the file cell holds its text and no title above it",
    );
    assert.equal(
      cells[1].getAttribute("title"),
      "a.md",
      "the whole path is offered on hover, for a cell too narrow to show it",
    );

    assert.equal(
      page.container
        .findAll("search-result-context")[1]
        .parentNode.getAttribute("aria-selected"),
      "false",
    );
  });
});

test("the context of a match never arrives as markup", () => {
  withPage(function (page) {
    // The file's path is plain data, and the passage is the document's own
    // text; both are printed as written, so a document containing markup
    // cannot become markup on this page.
    var path = "<img src=x onerror=alert(1)>";
    var hit = "<b>bold</b>";
    var built = build({
      container: page.container,
      answer() {
        return [entry(path, "Alpha", hit)];
      },
    });
    built.view.open();
    type(built.view, page, "bold");

    assert.equal(
      page.container.findAll("search-result-path")[0].textContent,
      path,
    );

    var marks = page.container.findAllByTag("mark");
    assert.ok(
      marks.length > 0,
      "the hit is marked in the list and in the preview: " + marks.length,
    );
    assert.ok(
      marks.every(function (node) {
        return node.children.length === 0;
      }),
      "the text is set as text, not parsed",
    );
    assert.equal(
      page.container.findAll("search-result-context")[0].children[1]
        .textContent,
      hit,
    );
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
        assert.ok(
          !node.children.length,
          "a passage is text and one mark, never markup",
        );
        return node.tagName === "MARK"
          ? "[" + textOf(node) + "]"
          : textOf(node);
      }),
      ["\u2026or ", "[alpha]", " and more\u2026"],
    );
  });
});

/** A payload document, as `app.js` would hand it over. */
function documentModel(id, title, html) {
  return { id: id, title: title, html: html };
}

/** The body of the whole document the preview drew, or `null`. */
function documentOf(page) {
  var found = previewOf(page).findAll(DOCUMENT_CLASS);
  return found.length ? found[0] : null;
}

test("the preview shows the whole document, not just the passage", () => {
  withPage(function (page) {
    var html =
      '<h1 id="alpha">Alpha</h1>\n<p>alpha one</p>\n<p>alpha two</p>\n<p>alpha three</p>\n';
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var body = documentOf(page);
    assert.ok(body, "the document body is on screen");
    assert.equal(body.className, DOCUMENT_CLASS + " doc-body");
    assert.equal(
      textOf(body).replace(/\n/g, ""),
      "Alphaalpha onealpha twoalpha three",
      "every paragraph arrived, not a cut-out one",
    );
    assert.equal(
      page.container.findAll("search-passage").length,
      0,
      "the excerpt is only the fallback",
    );
    assert.equal(
      page.container.findAll("search-doc-head").length,
      0,
      "no banner sits between the panel and the document",
    );
    assert.equal(
      page.container.findAll("search-doc-title").length,
      0,
      "no title line repeats what the reader picked",
    );
    assert.equal(
      page.container.findAll("search-doc-path").length,
      0,
      "no path line above the body",
    );
  });
});

test("every hit in the whole document is marked, not only the first", () => {
  withPage(function (page) {
    var html =
      "<h1>A</h1>\n<p>alpha here</p>\n<p>nothing</p>\n<p>alpha again</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2, "each paragraph's hit is marked");
    assert.deepEqual(
      marks.map(textOf),
      ["alpha", "alpha"],
      "a hit keeps the text the reader sees",
    );
  });
});

test("a hit inside a code block is not marked", () => {
  withPage(function (page) {
    var html = "<p>alpha text</p>\n<pre><code>alpha</code></pre>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 1, "the code block is left as written");
    assert.equal(marks[0].parentNode.tagName, "P");
  });
});

test("the preview is scrolled to the first hit", () => {
  var scrolled = [];

  withPage(function (page) {
    // Every element the page creates learns to report its own reveal, so the
    // assertion can see which node the view asked the browser to bring in.
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ text: textOf(element), options: options });
      };
    });

    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha first</p>\n<p>alpha second</p>\n",
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    // The list reveals its rows with `nearest`; these assertions hear only
    // the preview's own asks, which ask for the middle of the document.
    var previews = scrolled.filter(function (call) {
      return call.options && call.options.block === "center";
    });

    assert.equal(previews.length, 1, "one hit is revealed, not every hit");
    assert.equal(previews[0].text, "alpha");
    assert.equal(
      previews[0].options.block,
      "center",
      "the picked hit is asked for the middle of the preview",
    );
  });
});

test("the hit the preview scrolled to is the one that stands out", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha first</p>\n<p>filler</p>\n<p>alpha second</p>\n",
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha", 1)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2);
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS],
      "the second occurrence is the reader's pick and carries the active class alone",
    );
  });
});

test("the standout follows the selection to another occurrence", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha first</p>\n<p>alpha second</p>\n",
        ),
      },
      answer() {
        return [
          entry("a.md", "Alpha", "alpha", 0),
          entry("a.md", "Alpha", "alpha", 1),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(
      marks[0].className,
      HIT_CLASS + " " + HIT_ACTIVE_CLASS,
      "the first row's hit stands out first",
    );

    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });

    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS],
      "the second row's hit takes the standout from the first",
    );
  });
});

test("a document drawn without a mark leaves no standout behind", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel("a.md", "Alpha", "<p>alpha text</p>\n"),
        "b.md": documentModel("b.md", "Beta", "<p>plain text</p>\n"),
      },
      answer() {
        return [entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "beta");

    // `b.md` matched on its title alone, so the preview shows it with no hit
    // of the query anywhere: no mark exists, and none may claim the standout.
    assert.equal(page.container.findAll(HIT_CLASS).length, 0);
    assert.equal(page.container.findAll(HIT_ACTIVE_CLASS).length, 0);
  });
});

test("a code block's occurrence is brought to its block, not a textual stand-in", () => {
  var scrolled = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      documents: {
        // A hit inside the code block is counted by the list but never marked,
        // so a row can name an occurrence the preview holds no mark for.
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha here</p>\n<pre><code>alpha</code></pre>\n",
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha", 1)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 1, "the code block's hit is not marked");
    assert.equal(
      marks[0].className,
      HIT_CLASS,
      "no textual hit is made to stand in for the code block's own",
    );

    // Only the preview's asks are read here; the list's `nearest` reveal of
    // its own row is the row navigation's business.
    var revealed = scrolled
      .filter(function (call) {
        return call.options && call.options.block === "center";
      })
      .map(function (call) {
        return call.element;
      });

    assert.deepEqual(
      revealed,
      [previewOf(page).findAllByTag("PRE")[0]],
      "the eye is brought to the block the hit sits in",
    );
  });
});

test("a hit inside inline code is marked like any other text", () => {
  withPage(function (page) {
    var html = "<p>plain <code>alpha</code> tail</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 1, "the inline code's hit is marked");
    assert.equal(
      marks[0].parentNode.tagName,
      "CODE",
      "the mark sits inside the code element it highlights",
    );
    assert.equal(textOf(marks[0]), "alpha");
  });
});

test("the inline-code hit takes the standout when picked", () => {
  withPage(function (page) {
    var html = "<p>alpha first</p>\n<p>see <code>alpha</code> code</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha", 1)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2);
    assert.equal(marks[1].parentNode.tagName, "CODE");
    assert.equal(
      marks[1].className,
      HIT_CLASS + " " + HIT_ACTIVE_CLASS,
      "the picked inline-code hit raises its voice like a textual one",
    );
  });
});

test("inline code and code blocks keep their own places in the slot order", () => {
  var scrolled = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha one</p>\n<p>see <code>alpha</code> code</p>\n<pre><code>alpha</code></pre>\n<p>alpha two</p>\n",
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha", 2)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 3, "inline code is marked, the block is not");
    assert.equal(marks[1].parentNode.tagName, "CODE");
    assert.equal(
      marks[2].className,
      HIT_CLASS,
      "no textual hit stands in for the block's own occurrence",
    );

    // Only the preview's asks are read here; the list's `nearest` reveal of
    // its own row is the row navigation's business.
    var revealed = scrolled
      .filter(function (call) {
        return call.options && call.options.block === "center";
      })
      .map(function (call) {
        return call.element;
      });

    assert.deepEqual(
      revealed,
      [previewOf(page).findAllByTag("PRE")[0]],
      "the block's occurrence still scrolls to its block",
    );
  });
});

test("picking another occurrence of one document scrolls, and does not redraw", () => {
  var scrolled = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha first</p>\n<p>alpha second</p>\n",
        ),
      },
      answer() {
        return [
          entry("a.md", "Alpha", "alpha", 0),
          entry("a.md", "Alpha", "alpha", 1),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2);
    var drawn = built.calls.asked.length;
    scrolled.length = 0;

    // The second row names the second occurrence of the document already on
    // screen: the marks stand where they stood, and only the eye moves.
    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });

    assert.equal(
      built.calls.asked.length,
      drawn,
      "the same document is not drawn twice",
    );

    // The click also reveals the row itself with `nearest`; the asks read
    // here are the preview's, which move the eye inside the document.
    var revealed = scrolled
      .filter(function (call) {
        return call.options && call.options.block === "center";
      })
      .map(function (call) {
        return call.element;
      });

    assert.deepEqual(
      revealed,
      [marks[1]],
      "the scroll lands on the occurrence the row names",
    );
    assert.equal(built.view.isOpen(), true);
  });
});

test("the scope button starts local, and every query names the scope it was asked in", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var mode = page.container.findAll(MODE_CLASS)[0];
    assert.ok(mode, "the field carries a scope button");
    assert.equal(
      mode.textContent,
      MODE_LOCAL_LABEL,
      "the default reads the document in view",
    );
    assert.equal(mode.getAttribute("aria-pressed"), "false");
    assert.deepEqual(built.calls.modes, [LOCAL_MODE]);
    assert.equal(built.view.mode(), LOCAL_MODE);
  });
});

test("pressing the scope button re-asks at once, in the scope just chosen", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    // A keystroke is still pending when the reader presses the button: the
    // switch must not leave that older query to be answered in the old scope.
    var input = built.view.input();
    input.value = "alph";
    input.fire("input", { target: input });
    assert.equal(page.pending(), 1, "a debounce is scheduled");

    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });

    assert.deepEqual(
      built.calls.modes,
      [LOCAL_MODE, GLOBAL_MODE],
      "the press re-asks in the new scope",
    );
    assert.deepEqual(
      built.calls.queries,
      ["alpha", "alph"],
      "the field's own words are asked",
    );
    assert.equal(
      page.pending(),
      0,
      "the old scope's debounce is cancelled, not kept",
    );
    assert.equal(built.view.mode(), GLOBAL_MODE);

    var mode = page.container.findAll(MODE_CLASS)[0];
    assert.equal(mode.textContent, MODE_GLOBAL_LABEL);
    assert.equal(mode.getAttribute("aria-pressed"), "true");
  });
});

test("pressing the scope button again returns to the local scope", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var mode = page.container.findAll(MODE_CLASS)[0];
    mode.fire("click", { preventDefault() {} });
    mode.fire("click", { preventDefault() {} });

    // The first entry is the typed query's own, asked in the scope it started in.
    assert.deepEqual(built.calls.modes, [LOCAL_MODE, GLOBAL_MODE, LOCAL_MODE]);
    assert.equal(mode.textContent, MODE_LOCAL_LABEL);
    assert.equal(mode.getAttribute("aria-pressed"), "false");
    assert.equal(built.view.mode(), LOCAL_MODE);
  });
});

// Regression: a press on the scope button left the focus on the button, so
// the arrow keys — bound to the field — no longer moved the selection and the
// browser scrolled the page behind the fixed dialog instead. The field hands
// the reader back after the press, the way the clear button already does.
test("pressing the scope button hands the focus back to the field, so the arrows still answer", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    // The browser hands the focus to the button on the press, taking it from
    // the field; the fake page does not move the focus by itself, so the
    // gesture is modelled here — exactly the state the panel is asked to mend.
    var input = built.view.input();
    input.focused = false;

    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });

    assert.ok(input.focused, "the field holds the focus again after the press");

    input.fire("keydown", { key: "ArrowDown" });
    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(
      rows[1].getAttribute("aria-selected"),
      "true",
      "the arrows still move the selection in the scope just chosen",
    );
  });
});

test("an empty field makes the switch a change of mind, not a question", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });

    assert.deepEqual(
      built.calls.queries,
      [],
      "nothing is asked of an empty field",
    );
    assert.equal(built.view.mode(), GLOBAL_MODE);
  });
});

test("a query typed after the switch is asked in the scope in force", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });
    type(built.view, page, "alpha");

    assert.deepEqual(built.calls.modes, [GLOBAL_MODE]);
  });
});

test("the scope survives closing and reopening the panel", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();
    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });
    built.view.close();
    built.view.open();

    assert.equal(
      built.view.mode(),
      GLOBAL_MODE,
      "the reader was probably not done looking",
    );
    assert.equal(
      page.container.findAll(MODE_CLASS)[0].textContent,
      MODE_GLOBAL_LABEL,
    );
  });
});

test("the preview is drawn again for a new query, and not for the same row", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel("a.md", "Alpha", "<p>alpha one</p>"),
        "b.md": documentModel("b.md", "Beta", "<p>beta</p>"),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    var first = built.calls.asked.length;
    var input = built.view.input();

    // Moving inside the row already selected is not a new document.
    input.fire("keydown", { key: "ArrowUp" });
    assert.equal(
      built.calls.asked.length,
      first,
      "the same row is not asked for twice",
    );

    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(built.calls.asked[built.calls.asked.length - 1], "b.md");
    assert.equal(
      textOf(documentOf(page)),
      "beta",
      "the second document is on screen",
    );
  });
});

test("a payload that cannot answer falls back to the excerpt", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    assert.equal(documentOf(page), null);
    var passage = page.container.findAll("search-passage");
    assert.equal(
      passage.length,
      1,
      "the reader still sees where the query was found",
    );
    assert.equal(textOf(passage[0]), "\u2026or alpha and more\u2026");
  });
});

test("the document's own text is never turned into markup", () => {
  withPage(function (page) {
    // The body is the build's own HTML; the query is a tag name, which must
    // not be able to cut the markup it is looking for.
    var html = "<p>about &lt;b&gt;bold&lt;/b&gt; text</p>";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "bold")];
      },
    });
    built.view.open();
    type(built.view, page, "bold");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 1);
    assert.equal(textOf(marks[0]), "bold");
    assert.equal(
      marks[0].children.length,
      0,
      "a mark holds text, never elements",
    );
  });
});

test("a link in the previewed document navigates and closes the panel", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          '<p>see <a href="#/doc/b.md#details">details</a></p>',
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var link = page.container.findAllByTag("a")[0];
    assert.ok(link, "the document contributes its links");
    assert.equal(link.getAttribute("href"), "#/doc/b.md#details");

    var prevented = false;
    previewOf(page).fire("click", {
      target: link,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });

    assert.equal(prevented, true);
    assert.deepEqual(built.calls.selections, [
      { id: "b.md", anchor: "details" },
    ]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("an external link in the preview is left to the browser", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          '<p><a href="https://example.com">out</a></p>',
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var link = page.container.findAllByTag("a")[0];
    previewOf(page).fire("click", { target: link, preventDefault() {} });

    assert.deepEqual(
      built.calls.selections,
      [],
      "the panel is not a router for the web",
    );
    assert.equal(built.view.isOpen(), true);
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
    assert.equal(
      page.container.findAll(RESULT_CLASS)[0].getAttribute("aria-selected"),
      "true",
    );

    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[1].getAttribute("aria-selected"), "true");
    assert.equal(rows[0].getAttribute("aria-selected"), "false");
  });
});

test("arrow navigation brings each chosen row into sight", () => {
  var revealed = [];

  withPage(function (page) {
    // Every element the page creates learns to report the reveal the view
    // asks for, so the assertions can read which row was handed to the
    // browser and with what alignment. The preview reveals its own marks
    // with `center`, so the row asks are told apart by `nearest`.
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        revealed.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      answer() {
        return [
          entry("a.md", "Alpha", "alpha"),
          entry("b.md", "Beta", "beta"),
          entry("c.md", "Gamma", "gamma"),
          entry("d.md", "Delta", "delta"),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    revealed.length = 0;
    var rows = page.container.findAll(RESULT_CLASS);
    var input = built.view.input();

    /** The reveals that asked for a row of the list, not a mark of a document. */
    var rowReveals = function () {
      return revealed.filter(function (call) {
        return call.options && call.options.block === "nearest";
      });
    };

    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(rowReveals().length, 1, "the row the arrow chose is revealed");
    assert.equal(rowReveals()[0].element, rows[1]);
    assert.deepEqual(rowReveals()[0].options, { block: "nearest" });

    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(rowReveals().length, 3, "every step reveals its row");
    assert.equal(rowReveals()[2].element, rows[3]);

    input.fire("keydown", { key: "ArrowUp" });
    assert.equal(rowReveals().length, 4, "the upward step reveals too");
    assert.equal(rowReveals()[3].element, rows[2]);
    assert.deepEqual(rowReveals()[3].options, { block: "nearest" });
  });
});

test("Home and End bring the first and the last row into sight", () => {
  var revealed = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        revealed.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      answer() {
        return [
          entry("a.md", "Alpha", "alpha"),
          entry("b.md", "Beta", "beta"),
          entry("c.md", "Gamma", "gamma"),
          entry("d.md", "Delta", "delta"),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    revealed.length = 0;
    var rows = page.container.findAll(RESULT_CLASS);
    var input = built.view.input();

    input.fire("keydown", { key: "End" });
    assert.equal(revealed.length, 1);
    assert.equal(revealed[0].element, rows[3]);
    assert.deepEqual(revealed[0].options, { block: "nearest" });

    input.fire("keydown", { key: "Home" });
    assert.equal(revealed.length, 2);
    assert.equal(revealed[1].element, rows[0]);
  });
});

test("a fresh answer brings its own first row into sight", () => {
  var revealed = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        revealed.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      answer(query) {
        return query === "a"
          ? [entry("a.md", "Alpha", "alpha")]
          : [entry("b.md", "Beta", "beta"), entry("c.md", "Gamma", "gamma")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    // The list of the first answer opens at its head, so a reader who typed
    // with the list scrolled away still lands on the top of the new one.
    var first = page.container.findAll(RESULT_CLASS)[0];
    assert.equal(revealed.length, 1);
    assert.equal(revealed[0].element, first);
    assert.deepEqual(revealed[0].options, { block: "nearest" });

    type(built.view, page, "b");
    var second = page.container.findAll(RESULT_CLASS)[0];
    assert.equal(revealed.length, 2, "the replaced list is revealed again");
    assert.equal(
      revealed[1].element,
      second,
      "the new list's head, not the old",
    );
  });
});

test("staying on the selected row asks for no reveal", () => {
  var revealed = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        revealed.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    assert.equal(revealed.length, 1, "the only row was revealed once");

    var input = built.view.input();
    input.fire("keydown", { key: "ArrowUp" });
    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(
      revealed.length,
      1,
      "clamped steps change nothing, so they scroll nothing",
    );
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
    // query that has not been asked yet, and this one has been. The rows
    // carry no occurrence, so there is no passage to open at.
    assert.deepEqual(built.calls.selections, [
      { id: "b.md", anchor: null, jump: null },
    ]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("Enter asks for what was typed even when the pause has not come yet", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer(query) {
        return [entry("a.md", "Alpha", query, 0)];
      },
    });
    built.view.open();

    var input = built.view.input();
    input.value = "alp";
    input.fire("input", { target: input });
    input.fire("keydown", { key: "Enter" });

    assert.deepEqual(
      built.calls.queries,
      ["alp"],
      "a query still pending is asked now",
    );
    // The jump names the settled answer, not the older list: the passage
    // that opens is the one the just-landed row described.
    assert.deepEqual(built.calls.selections, [
      { id: "a.md", anchor: null, jump: { query: "alp", hit: 0 } },
    ]);
  });
});

test("the pointer crossing a result leaves the selection alone", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    page.container.findAll(RESULT_CLASS)[1].fire("pointermove", {});

    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[0].getAttribute("aria-selected"), "true");
    assert.equal(rows[1].getAttribute("aria-selected"), "false");
    assert.equal(
      previewOf(page).children[0].children[1].textContent,
      "alpha",
      "the preview still describes the row the reader chose",
    );
  });
});

test("clicking a result selects it and keeps the panel open", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });

    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[0].getAttribute("aria-selected"), "false");
    assert.equal(rows[1].getAttribute("aria-selected"), "true");
    assert.equal(previewOf(page).children[0].children[1].textContent, "beta");
    assert.deepEqual(
      built.calls.selections,
      [],
      "choosing which row to read is not yet choosing to leave",
    );
    assert.equal(built.view.isOpen(), true);
  });
});

test("double-clicking a result opens it", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    // The browser's own double click is two clicks and then a `dblclick`;
    // the clicks only select, so the last event alone does the leaving.
    var row = page.container.findAll(RESULT_CLASS)[1];
    row.fire("click", { preventDefault() {} });
    row.fire("click", { preventDefault() {} });
    row.fire("dblclick", { preventDefault() {} });

    assert.deepEqual(built.calls.selections, [
      { id: "b.md", anchor: null, jump: null },
    ]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("Enter opens the passage the selected row names", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [
          entry("a.md", "Alpha", "alpha one", 0),
          entry("a.md", "Alpha", "alpha two", 1),
          entry("a.md", "Alpha", "alpha three", 2),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var input = built.view.input();
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "Enter" });

    assert.deepEqual(
      built.calls.selections,
      [{ id: "a.md", anchor: null, jump: { query: "alpha", hit: 2 } }],
      "the row the arrows chose is the passage the jump names",
    );
    assert.equal(built.view.isOpen(), false);
  });
});

test("double-clicking a result opens the passage it names too", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [
          entry("a.md", "Alpha", "alpha", 0),
          entry("b.md", "Beta", "beta", 1),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    var row = page.container.findAll(RESULT_CLASS)[1];
    row.fire("click", { preventDefault() {} });
    row.fire("click", { preventDefault() {} });
    row.fire("dblclick", { preventDefault() {} });

    assert.deepEqual(built.calls.selections, [
      { id: "b.md", anchor: null, jump: { query: "a", hit: 1 } },
    ]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("a match with no place in the body opens without a passage to land on", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", null, -1)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    built.view.input().fire("keydown", { key: "Enter" });

    assert.deepEqual(
      built.calls.selections,
      [{ id: "a.md", anchor: null, jump: null }],
      "a title-only match has no occurrence for the article to open at",
    );
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
    var built = build({
      container: page.container,
      toggle: fakeElement("button"),
    });
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
    assert.equal(
      prevented,
      true,
      "the key must not also close the preview behind it",
    );
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
    assert.equal(
      empties.length,
      2,
      "the list and the preview both have nothing",
    );
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
      "",
      "there is no passage to quote, so the leading column stays empty",
    );
    assert.equal(
      page.container.findAll("search-result-path")[0].textContent,
      "a.md",
      "the path names the document in the trailing column",
    );
    assert.equal(
      page.container.findAll(EMPTY_CLASS)[0].textContent,
      PREVIEW_IDLE_LABEL,
    );
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
    assert.equal(
      page.container.findAll(EMPTY_CLASS)[0].textContent,
      RESULTS_IDLE_LABEL,
    );
    assert.deepEqual(
      built.calls.queries,
      ["alpha"],
      "a blank query is not asked about",
    );
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
    assert.equal(
      page.container.findAll(RESULT_CLASS).length,
      0,
      "a closed panel forgets its list",
    );
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
  assert.equal(
    isSearchShortcut({ key: "f", ctrlKey: true, altKey: true }),
    false,
  );
  assert.equal(isSearchShortcut({ key: "g", ctrlKey: true }), false);
  assert.equal(isSearchShortcut(null), false);
});

/**
 * The list numbers occurrences over the document's whole text — a code block's
 * text included — while the highlight leaves code as authored, so the row an
 * ordinal names and the mark the preview addresses must stay paired even when
 * the code block's own occurrences hold no mark at all.
 */
test("every occurrence addresses its own mark, even past a code block", () => {
  var scrolled = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ text: textOf(element), options: options });
      };
    });

    // The engine's `occurrences` reads "… one … two … three … four …" — the
    // code block's hit is the second of four, and carries no mark below.
    var html =
      "<p>alpha one</p>\n<pre><code>alpha two</code></pre>\n" +
      "<p>alpha three</p>\n<p>alpha four</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [
          entry("a.md", "Alpha", "alpha one", 0),
          entry("a.md", "Alpha", "alpha two", 1),
          entry("a.md", "Alpha", "alpha three", 2),
          entry("a.md", "Alpha", "alpha four", 3),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 3, "the code block alone stays unwrapped");

    /** The preview's own asks since `scrolled.length` was last reset. */
    function revealed() {
      return scrolled
        .filter(function (call) {
          return call.options && call.options.block === "center";
        })
        .map(function (call) {
          return call.text;
        });
    }

    // The code block's own row: nothing pretends to highlight it, and the
    // block that holds the hit is where the eye is brought.
    scrolled.length = 0;
    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS, HIT_CLASS],
      "a hit inside the code block is addressed without a standout",
    );
    assert.deepEqual(
      revealed(),
      ["alpha two"],
      "the code block's row is brought to the code block itself",
    );

    // The row after it names the next paragraph, not the one the code block
    // just displaced.
    scrolled.length = 0;
    page.container
      .findAll(RESULT_CLASS)[2]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS, HIT_CLASS],
      "the third occurrence stands out where its paragraph says",
    );
    assert.deepEqual(
      revealed(),
      ["alpha"],
      "the third occurrence's own mark is the one brought to the middle",
    );

    // The last row keeps its pairing too.
    page.container
      .findAll(RESULT_CLASS)[3]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS],
      "the fourth occurrence stands out where its paragraph says",
    );
  });
});

/** Two hits sharing one text node must be addressed in the order read. */
test("two hits of one paragraph are addressed in reading order", () => {
  withPage(function (page) {
    var html = "<p>alpha and alpha again</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [
          entry("a.md", "Alpha", "alpha", 0),
          entry("a.md", "Alpha", "alpha", 1),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2, "both hits of the paragraph are marked");
    assert.equal(
      documentOf(page).textContent,
      "alpha and alpha again\n",
      "wrapping two hits of one node keeps the paragraph's text whole",
    );

    page.container
      .findAll(RESULT_CLASS)[0]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS + " " + HIT_ACTIVE_CLASS, HIT_CLASS],
      "the first hit of the paragraph is the first one addressed",
    );

    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS],
      "the second hit of the paragraph is the second one addressed",
    );
  });
});

/* ---------- the pages format: documents and answers that travel ---------- */

test("loading names the wait where the rows will appear", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    built.view.setLoading();

    var results = page.container.children[1];
    assert.match(textOf(results), /Loading/);
    assert.equal(
      page.container.findAll(RESULT_CLASS).length,
      0,
      "no row pretends there is an answer yet",
    );

    built.view.setResults([entry("a.md", "Alpha", "alpha")], 0);
    assert.doesNotMatch(
      textOf(page.container.children[1]),
      /Loading/,
      "the answer replaces the wait",
    );
  });
});

test("a document that travels in replaces the excerpt when it lands", () => {
  withPage(function (page) {
    var deliver = null;
    var built = build({
      container: page.container,
      travelling() {
        return {
          // biome-ignore lint/suspicious/noThenProperty: a deliberately synchronous thenable, so the test needs no microtask flush
          then(callback) {
            deliver = callback;
          },
        };
      },
    });

    built.view.setResults([entry("a.md", "Alpha", "alpha")], 0);

    assert.match(
      textOf(previewOf(page)),
      /alpha/,
      "the excerpt answers while the document is on its way",
    );

    deliver({
      id: "a.md",
      html: "<p>the whole document</p>",
      toc: [],
      blocks: [],
    });

    assert.match(
      textOf(previewOf(page)),
      /the whole document/,
      "the fetched document takes the excerpt's place",
    );
    assert.doesNotMatch(textOf(previewOf(page)), /alpha/);
  });
});

test("an answer for a selection the reader has left behind draws nothing", () => {
  withPage(function (page) {
    // One callback per request, like the promises the store really returns:
    // the older answer still lands, it just finds a newer row drawn.
    const deliveries = [];
    var built = build({
      container: page.container,
      travelling() {
        return {
          // biome-ignore lint/suspicious/noThenProperty: a deliberately synchronous thenable, so the test needs no microtask flush
          then(callback) {
            deliveries.push(callback);
          },
        };
      },
    });

    built.view.setResults([entry("a.md", "Alpha", "alpha")], 0);
    built.view.setResults([entry("b.md", "Beta", "beta")], 0);
    assert.equal(deliveries.length, 2, "each row asked for its own document");

    deliveries[0]({
      id: "a.md",
      html: "<p>stale document</p>",
      toc: [],
      blocks: [],
    });

    assert.doesNotMatch(
      textOf(previewOf(page)),
      /stale/,
      "the newer row owns the preview",
    );
    assert.match(textOf(previewOf(page)), /beta/);
  });
});
