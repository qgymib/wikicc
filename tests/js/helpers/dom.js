/**
 * The shared fake DOM behind the reader's view tests.
 *
 * Every view test drives its module through a hand-written fake page: plain
 * objects carrying just the members the module under test calls. The core of
 * that fake — an element's attributes, children, listeners, class list and
 * the `fire` that dispatches to them — is the same in every file, so it
 * lives here once; what genuinely differs between the views is a documented
 * extension point each test file keeps for itself.
 *
 * The file's name keeps it out of the runner's discovery glob
 * (`tests/js_suite.rs` picks up `*.test.js` only), so nothing here executes
 * as a test; it still has to pass `npm run check` like any other module
 * under `tests/js`.
 *
 * The conventions the fakes follow (see `tests/README.md`):
 *
 * - **Keep the browser's semantics.** A fake implements only the members the
 *   module under test calls, and it must not grow a member the real
 *   environment lacks — every capability a stub adds has to be confirmed
 *   against the real thing first.
 * - **The SVG trap.** A real `SVGElement` has no `createElementNS` — only
 *   `document` does. The fake element therefore deliberately omits it: a
 *   stub that handed the method to every node let a view that creates SVG
 *   children through its parent pass 30+ green cases and throw
 *   "createElementNS is not a function" in a browser.
 * - **Dispatch events where the listener is.** `fire` runs the handlers
 *   registered on the element it is called on; a delegated handler is fired
 *   at the element that carries it, with the event's `target` naming where
 *   the press landed.
 * - **Never replace a global timer for longer than one body.** The timer
 *   fakes below are installed for the duration of one `work` body and
 *   drained before the runtime's own `setTimeout` comes back, because the
 *   runner schedules its own bookkeeping through the same globals.
 *
 * The extension points the test files keep for themselves:
 *
 * - **geometry** — `element.rect` backs `getBoundingClientRect`, and the
 *   offset members are plain fields a file can redefine; the preview's test
 *   gives `offsetHeight` its shrink-under-`maxHeight` reading, for instance.
 * - **`closest` and `querySelectorAll`** — which selectors an element
 *   answers is a per-file policy, because a view under test may depend on a
 *   selector going *unmatched* (`preview-view.js` asks `.doc-body` and its
 *   test keeps that answer null). The core only provides the walking
 *   machinery: `walkDescendants`, `closestMatch`, `descendantsByTag`.
 * - **markup** — `innerHTML` either records the string it was given
 *   (`markup: "record"`, the default — a stub that parsed would be a parser,
 *   not a page) or parses the build's own tags into children
 *   (`markup: "parse"`, with `parseFactory` naming where parsed tags come
 *   from) for the tests that walk the markup they were handed.
 * - **appending** — the core does not re-parent a child that already has a
 *   parent, because the highlight's mark-wrapping walks text nodes that keep
 *   their slot in the paragraph; the table test, the one view that really
 *   moves nodes between parents, restores the browser's move semantics on
 *   its own elements.
 * - **the table's live collections** — `rows`, `cells`, `tBodies`, `tHead`
 *   are the browser's live views over a table's section elements; only the
 *   table test follows them, as overrides on its own elements.
 * - **document factories** — `createFakeDocument` wires the common factory
 *   methods; each file extends the document with what its view asks for
 *   (`execCommand`, `getElementById`, a fragment factory and so on).
 */

/**
 * Whether `node`'s class list holds `name`, the way a class selector
 * matches.
 */
export function hasClass(node, name) {
  return String(node.className).split(" ").indexOf(name) !== -1;
}

/**
 * The text of a subtree, as `textContent` reads it in a browser: text nodes
 * contribute their text, childless elements their own, parents their
 * children's.
 */
export function textOf(node) {
  if (node.nodeType === 3) {
    return node.textContent;
  }
  if (!node.children || !node.children.length) {
    return node.textContent;
  }
  return node.children.map(textOf).join("");
}

/**
 * Visit every descendant of `node` in document order, depth first, handing
 * each to `visit`. Live, as the browser's own collections are: nodes that
 * enter the tree while a walk over them runs are visited where a browser
 * would visit them.
 */
export function walkDescendants(node, visit) {
  (node.children || []).forEach(function (child) {
    visit(child);
    walkDescendants(child, visit);
  });
}

/**
 * Walk from `node` up through its ancestors — the node itself included —
 * and answer the first one `match` accepts, or null.
 */
export function closestMatch(node, match) {
  let current = node;
  while (current) {
    if (match(current)) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

/** Every descendant of `root` with `tagName`, in document order. */
export function descendantsByTag(root, tagName) {
  const wanted = String(tagName).toUpperCase();
  const found = [];
  walkDescendants(root, function (node) {
    if (node.tagName === wanted) {
      found.push(node);
    }
  });
  return found;
}

/**
 * The markup of one node, rebuilt from what it holds — the reading side of
 * `markup: "parse"`, which lets a test prove a document was inserted *as*
 * markup rather than as text.
 */
export function outerHtml(node) {
  if (node.nodeType === 3) {
    return node.textContent;
  }

  const attributes = Object.keys(node.attributes || {})
    .map(function (name) {
      return " " + name + '="' + node.attributes[name] + '"';
    })
    .join("");

  return (
    "<" +
    node.tagName.toLowerCase() +
    attributes +
    ">" +
    node.children.map(outerHtml).join("") +
    "</" +
    node.tagName.toLowerCase() +
    ">"
  );
}

/** The few entities the build writes into a body. */
export function decodeText(value) {
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
 * `splitText` is the member the highlight's cutting needs, and it behaves as
 * the browser's does: the half after the cut becomes a new node inserted
 * right behind this one, so a live walk visits the halves where a browser
 * would visit them.
 */
export function createTextNode(value) {
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

    const tail = createTextNode(text.slice(offset));
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
 * The walk is live, as the browser's own is: nodes that enter the tree
 * while it runs — the halves `splitText` leaves behind, the text a fresh
 * mark now holds — are visited where a browser would visit them, because
 * the views' bookkeeping depends on that behaviour rather than on a
 * snapshot of it.
 */
export function createTreeWalker(root) {
  /** The node the walk last returned, or the root before the first ask. */
  let current = root;

  /** The first text node below `node`, or null. */
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

  /** The next text node from `node`'s position onward, or null at the end. */
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

/**
 * Parse the tags of `html` into children of `root`.
 *
 * Deliberately minimal: every tag opens or closes, nothing is void, and
 * attributes matter only as far as their name and value. That is exactly
 * what the build emits for a document body, and anything more would be a
 * parser the tests then have to trust. Parsed tags come from
 * `createElement` — pass the file's own factory so parsed children carry
 * the same behaviour the rest of the page's elements have.
 */
export function parseInto(root, html, createElement) {
  const make = createElement || createFakeElement;
  const open = [root];
  const pattern = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let match = pattern.exec(html);

  while (match) {
    if (match[4] !== undefined) {
      if (match[4]) {
        open[open.length - 1].appendChild(createTextNode(decodeText(match[4])));
      }
    } else if (match[1]) {
      if (open.length > 1) {
        open.pop();
      }
    } else {
      const node = make(match[2]);
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

/**
 * A fake element with the browser's core plumbing.
 *
 * `options.markup` picks the `innerHTML` behaviour ("record", the default,
 * keeps the written string; "parse" also parses it into children), and
 * `options.parseFactory` names where parsed tags come from. Everything else
 * a file needs beyond this — its `closest` policy, its selectors, its
 * geometry — it adds on top; see the file header for the extension points.
 */
export function createFakeElement(tagName, options = {}) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    id: "",
    children: [],
    parentNode: null,
    attributes: {},
    listeners: {},
    hidden: false,
    style: {},
    value: "",
    focused: false,
    selected: false,
    ownerDocument: null,
    offsetWidth: 0,
    offsetHeight: 0,
    rect: {
      top: 100,
      bottom: 120,
      left: 40,
      right: 160,
      width: 120,
      height: 20,
    },
    appendChild(child) {
      element.children.push(child);
      child.parentNode = element;
      return child;
    },
    removeChild(child) {
      const index = element.children.indexOf(child);
      if (index >= 0) {
        element.children.splice(index, 1);
      }
      child.parentNode = null;
      return child;
    },
    replaceChild(next, child) {
      const index = element.children.indexOf(child);
      if (index < 0) {
        return child;
      }
      element.children[index] = next;
      next.parentNode = element;
      child.parentNode = null;
      return child;
    },
    insertBefore(child, reference) {
      const index = reference ? element.children.indexOf(reference) : -1;
      if (index < 0) {
        element.children.push(child);
      } else {
        element.children.splice(index, 0, child);
      }
      child.parentNode = element;
      return child;
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(element.attributes, name)
        ? element.attributes[name]
        : null;
    },
    hasAttribute(name) {
      return Object.hasOwn(element.attributes, name);
    },
    removeAttribute(name) {
      delete element.attributes[name];
    },
    addEventListener(type, handler) {
      if (!element.listeners[type]) {
        element.listeners[type] = [];
      }
      element.listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = element.listeners[type] || [];
      const index = handlers.indexOf(handler);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    },
    /** Dispatch one event to every listener, as the browser would. */
    fire(type, event) {
      (element.listeners[type] || []).slice().forEach(function (handler) {
        handler(event || {});
      });
    },
    focus() {
      element.focused = true;
    },
    /** A textarea answers select, the way the copy's veteran route asks. */
    select() {
      element.selected = true;
    },
    // Containment is decided over the whole subtree, as the browser does:
    // a press inside a panel arrives with one of its descendants as the
    // target.
    contains(node) {
      if (node === element) {
        return true;
      }
      return element.children.some(function (child) {
        return typeof child.contains === "function" && child.contains(node);
      });
    },
    get firstChild() {
      return element.children[0] || null;
    },
    getBoundingClientRect() {
      return element.rect;
    },
    // Deliberately absent: `createElementNS` — a real `SVGElement` has no
    // such method, only `document` does. See the file header.
  };

  // `classList` reads and writes the same `className` string the browser's
  // does, so a module that adds a class is visible to a selector asking for
  // it.
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
      return hasClass(element, name);
    },
  };

  // The browser's `textContent` reads the subtree and replaces it when
  // written, which is how the views empty a panel. Configurable, so a file
  // with its own reading of it can redefine the member on top.
  let text = "";
  Object.defineProperty(element, "textContent", {
    configurable: true,
    get() {
      return element.children.length
        ? element.children.map(textOf).join("")
        : text;
    },
    set(value) {
      text = String(value);
      element.children = [];
    },
  });

  if (options.markup === "parse") {
    let markup = "";
    Object.defineProperty(element, "innerHTML", {
      configurable: true,
      get() {
        return markup || element.children.map(outerHtml).join("");
      },
      set(value) {
        markup = String(value);
        text = "";
        element.children = [];
        const make = options.parseFactory
          ? options.parseFactory()
          : createFakeElement;
        parseInto(element, markup, make);
      },
    });
  } else {
    // `innerHTML` is only ever assigned a body or cleared, so a string that
    // records the write is enough to see what a view was told to show.
    element.innerHTML = "";
  }

  return element;
}

/**
 * A document stub carrying the factory methods every fake page needs.
 *
 * `options.createElement` and `options.createElementNS` name the element
 * factory (the file's own wrapper, when it has one); the document records
 * what it built in `created` and `createdNS` for the tests that count it.
 * Like a real document, and unlike the fake element, it answers
 * `createElementNS`.
 */
export function createFakeDocument(options = {}) {
  const doc = {
    isDocumentRoot: true,
    listeners: {},
    created: [],
    createdNS: [],
  };
  const makeElement = options.createElement || createFakeElement;

  doc.documentElement = createFakeElement("html");
  doc.documentElement.parentNode = doc;
  doc.documentElement.clientWidth = 1200;
  doc.documentElement.clientHeight = 800;
  doc.body = createFakeElement("body");
  doc.body.parentNode = doc.documentElement;

  doc.createElement = function (tagName) {
    const element = makeElement(tagName);
    element.ownerDocument = doc;
    doc.created.push(element);
    return element;
  };
  doc.createElementNS = function (_namespace, tagName) {
    const element = (options.createElementNS || makeElement)(tagName);
    element.ownerDocument = doc;
    doc.createdNS.push(element);
    return element;
  };
  doc.createTextNode = function (value) {
    return createTextNode(value);
  };
  doc.createTreeWalker = function (root) {
    return createTreeWalker(root);
  };
  doc.createDocumentFragment = function () {
    const fragment = createFakeElement("#document-fragment");
    fragment.ownerDocument = doc;
    fragment.isFragment = true;
    return fragment;
  };
  doc.addEventListener = function (type, handler) {
    if (!doc.listeners[type]) {
      doc.listeners[type] = [];
    }
    doc.listeners[type].push(handler);
  };
  doc.removeEventListener = function (type, handler) {
    const handlers = doc.listeners[type] || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
  };
  doc.fire = function (type, event) {
    (doc.listeners[type] || []).slice().forEach(function (handler) {
      handler(event || {});
    });
  };

  return doc;
}

/**
 * Install a fake global for as long as the synchronous `work` runs, answer
 * the previous value.
 *
 * Nothing installed here may outlive the test that asked for it: the runner
 * schedules its own bookkeeping through these same globals.
 */
export function installGlobal(name, value) {
  const previous = globalThis[name];
  Object.defineProperty(globalThis, name, {
    value: value,
    configurable: true,
    writable: true,
  });
  return previous;
}

/**
 * Install the fake globals of `overrides`, run `work`, restore every one of
 * them — after an awaited body settles, too.
 *
 * A body that awaits promise answers keeps the fakes until it settles: the
 * restore rides the outcome's `finally` when `work` returns a thenable.
 */
export function withGlobals(overrides, work) {
  const names = Object.keys(overrides);
  const previous = {};
  names.forEach(function (name) {
    previous[name] = globalThis[name];
    globalThis[name] = overrides[name];
  });

  let outcome;
  try {
    outcome = work();
  } catch (error) {
    names.forEach(function (name) {
      globalThis[name] = previous[name];
    });
    throw error;
  }

  if (outcome && typeof outcome.then === "function") {
    return outcome.finally(function () {
      names.forEach(function (name) {
        globalThis[name] = previous[name];
      });
    });
  }

  names.forEach(function (name) {
    globalThis[name] = previous[name];
  });
  return outcome;
}

/**
 * A queue of fake timers: `setTimeout` records, nothing waits, and the test
 * runs what it is waiting for.
 *
 * The queue answers how many timers are pending, what delays they carry,
 * and runs every pending timer once — which is what a debounce settles.
 */
export function createFakeTimers() {
  const timers = new Map();
  let nextId = 1;

  return {
    setTimeout(handler, delay) {
      const id = nextId++;
      timers.set(id, { handler: handler, delay: delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** How many timers are still pending. */
    pending() {
      return timers.size;
    },
    /** Delays of the timers still pending, in scheduling order. */
    delays() {
      return Array.from(timers.values()).map(function (timer) {
        return timer.delay;
      });
    },
    /** Run every pending timer once. */
    runAll() {
      const due = Array.from(timers.entries());
      timers.clear();
      due.forEach(function (entry) {
        entry[1].handler();
      });
    },
  };
}
