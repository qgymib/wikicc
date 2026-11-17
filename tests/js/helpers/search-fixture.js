/**
 * The shared fake page the search tests run on.
 *
 * The search dialog is driven with a minimal fake DOM — plain objects carrying
 * just the members the view touches — because the rules under test are about
 * *when* things happen, not how the browser paints them: typing debounces
 * into one query, the list and the preview describe the same row, Enter opens
 * what is selected, and the panel goes away on Escape or on a press outside
 * it.
 *
 * The fake page follows the browser where it matters here: a text node is a
 * node with a tag of `#text`, so a test can tell a `<mark>` from the text
 * around it and prove that document text never arrived as markup.
 *
 * What a specific behaviour needs beyond this — the scroll observers, the
 * documents that travel — lives next to the tests that use it.
 */
import {
  DOCUMENT_CLASS,
  createSearchView,
} from "../../../src/web/js/search-view.js";
import {
  closestMatch,
  createFakeDocument,
  createFakeElement,
  createFakeTimers,
  descendantsByTag,
  hasClass,
  walkDescendants,
  withGlobals,
} from "./dom.js";

/** A fake element: attributes, listeners, children and the text written into it. */
export function fakeElement(tagName) {
  const element = createFakeElement(tagName, {
    markup: "parse",
    parseFactory() {
      return createNode;
    },
  });

  /**
   * The nearest ancestor — this node included — matching a tag selector.
   *
   * Only the two forms the view asks for are understood: `a` and `a[href]`,
   * the latter requiring the attribute the view relies on.
   */
  element.closest = function (selector) {
    const wanted = String(selector).toUpperCase();
    const needsHref = wanted.indexOf("[HREF]") !== -1;
    const tag = wanted.split("[")[0];
    return closestMatch(element, function (node) {
      return (
        node.tagName === tag &&
        (!needsHref || node.getAttribute("href") !== null)
      );
    });
  };

  element.querySelectorAll = function () {
    return [];
  };

  /** Every descendant whose class list holds `name`, the panel included. */
  element.findAll = function (name) {
    const found = [];
    walkDescendants(element, function (node) {
      if (hasClass(node, name)) {
        found.push(node);
      }
    });
    return found;
  };

  /** Every descendant with `tagName`, which is how a `<mark>` is counted. */
  element.findAllByTag = function (tagName) {
    return descendantsByTag(element, tagName);
  };

  return element;
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

/** Install a fake page, run `work`, then restore it. */
export function withPage(work) {
  const timers = createFakeTimers();
  const body = fakeElement("body");
  const container = fakeElement("div");
  container.id = "search-panel";
  body.appendChild(container);

  /**
   * A hook run on every element the fake page creates.
   *
   * The view builds its own nodes, so a test that has to observe one — the
   * `<mark>` it scrolls to — can only do it from here.
   */
  const decorators = [];

  function make(tagName) {
    const element = fakeElement(tagName);
    decorators.forEach(function (decorate) {
      decorate(element);
    });

    return element;
  }

  // Parsed markup's elements go through the page's factory, so a test can
  // observe the `<pre>` a code block's hit is brought to as well.
  const previousCreateNode = createNode;
  createNode = function (tagName) {
    return make(tagName);
  };

  const doc = createFakeDocument({
    createElement: make,
  });
  doc.body = body;
  doc.getElementById = function () {
    return null;
  };

  let outcome;
  try {
    outcome = withGlobals(
      {
        document: doc,
        NodeFilter: { SHOW_TEXT: 4 },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
      function () {
        return work({
          container: container,
          /** Deliver a press anywhere: the panel listens to the whole document. */
          press(target) {
            doc.fire("pointerdown", { target: target });
          },
          /** Run the debounced query the field scheduled, if any is pending. */
          settle() {
            timers.runAll();
          },
          pending() {
            return timers.pending();
          },
          documentListenerCount() {
            return (doc.listeners.pointerdown || []).length;
          },
          /** Observe every element created from now on. */
          decorate(fn) {
            decorators.push(fn);
          },
        });
      },
    );
  } finally {
    createNode = previousCreateNode;
  }

  return outcome;
}

/** The snippet a result carries: a body hit with both ends cut. */
export function snippet(hit) {
  return {
    before: "or ",
    hit: hit,
    after: " and more",
    trimmedStart: true,
    trimmedEnd: true,
  };
}

/** One entry as `search.js` returns it, naming its occurrence when given. */
export function entry(id, title, hit, ordinal) {
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

/** One entry for a sealed document: a title-only match the controller marked. */
export function lockedEntry(id, title) {
  return {
    id: id,
    title: title,
    path: id,
    snippet: null,
    hit: -1,
    locked: true,
  };
}

/** The preview area, which is the panel's last child. */
export function previewOf(page) {
  return page.container.children[page.container.children.length - 1];
}

/** A payload document, as `app.js` would hand it over. */
export function documentModel(id, title, html) {
  return { id: id, title: title, html: html };
}

/** The body of the whole document the preview drew, or `null`. */
export function documentOf(page) {
  var found = previewOf(page).findAll(DOCUMENT_CLASS);
  return found.length ? found[0] : null;
}

/** The panel built over `container`, with `onQuery`/`onSelect` recorded. */
export function build(options) {
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
export function type(view, page, value) {
  var input = view.input();
  input.value = value;
  input.fire("input", { target: input });
  page.settle();
}
