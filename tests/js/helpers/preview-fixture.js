/**
 * The shared fake page the preview tests run on.
 *
 * The preview is driven with a minimal fake DOM — plain objects with just the
 * methods the view calls — because the rules under test are *when* things
 * happen, not how the browser paints them. This file is the parts every
 * preview test file shares: the element and document stubs with the geometry
 * `position` reads, the fake timers and viewport, the links and stores the
 * tests route through, the panel look-ups, and `setup`, which builds one view
 * against one fake page and takes it down again.
 *
 * What a specific behaviour needs beyond this — the nested links a pointer
 * crosses, the resize handles, the sealed documents — lives next to the tests
 * that use it.
 */
import {
  POPOVER_CLASS,
  createPreviewView,
} from "../../../src/web/js/preview-view.js";
import {
  DOC_LINK_ATTRIBUTE,
  DOC_LINK_SELECTOR,
  INVALID_ATTRIBUTE,
  INVALID_SELECTOR,
  MISSING_ANCHOR_ATTRIBUTE,
} from "../../../src/web/js/links.js";
import {
  createFakeDocument,
  createFakeElement,
  createFakeTimers,
  walkDescendants,
  withGlobals,
} from "./dom.js";

/** Element stub: attributes, listeners, closest and the geometry `position` reads. */
export function fakeElement(tagName) {
  const element = createFakeElement(tagName);
  element.offsetWidth = 480;

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

  // A click inside the panel arrives with one of its descendants as the
  // target; the selectors the handlers find their marks by are the link
  // mark, the dead-link mark and the head's buttons, and anything else
  // stays unmatched.
  element.closest = function (selector) {
    if (selector === "button") {
      return element.tagName === "BUTTON" ? element : null;
    }
    if (selector === INVALID_SELECTOR) {
      const dead = Object.hasOwn(element.attributes, INVALID_ATTRIBUTE);
      return element.tagName === "A" && dead ? element : null;
    }
    if (selector !== DOC_LINK_SELECTOR) {
      return null;
    }
    const tagged = Object.hasOwn(element.attributes, DOC_LINK_ATTRIBUTE);
    return element.tagName === "A" && tagged ? element : null;
  };

  /** Every descendant matching `a[href]`, the one selector `tag` asks for. */
  element.querySelectorAll = function (selector) {
    if (selector !== "a[href]") {
      return [];
    }

    const found = [];
    walkDescendants(element, function (node) {
      if (node.tagName === "A" && node.getAttribute("href") !== null) {
        found.push(node);
      }
    });

    return found;
  };

  return element;
}

/**
 * Fake `document`.
 *
 * Tests insert links into `content` themselves, which is the only subtree the
 * view is given, so this object exists only for the elements `tag` and the
 * handlers create.
 */
export function fakeDocument() {
  const doc = createFakeDocument({
    createElement: fakeElement,
  });

  doc.createElementNS = function (_namespace, tagName) {
    const element = fakeElement(tagName);
    element.ownerDocument = doc;
    doc.created.push(element);
    return element;
  };

  // Both the document and the window stand for the page in these tests: a
  // handler registered on either is dispatched through the same `fire`.
  doc.addEventListener = function (type, handler) {
    if (!globalThis.__previewListeners) {
      globalThis.__previewListeners = {};
    }
    const listeners = globalThis.__previewListeners;
    if (!listeners[type]) {
      listeners[type] = [];
    }
    listeners[type].push(handler);
  };

  doc.removeEventListener = function (type, handler) {
    const listeners = globalThis.__previewListeners || {};
    const handlers = listeners[type] || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
  };

  return doc;
}

/** Fake global timers and viewport, installed around `run` and removed after. */
export function withFakeWindow(run) {
  const timers = createFakeTimers();

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

  return withGlobals(
    {
      __previewListeners: {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener(type, handler) {
        const listeners = globalThis.__previewListeners;
        if (!listeners[type]) {
          listeners[type] = [];
        }
        listeners[type].push(handler);
      },
      removeEventListener(type, handler) {
        const handlers = globalThis.__previewListeners[type] || [];
        const index = handlers.indexOf(handler);
        if (index >= 0) {
          handlers.splice(index, 1);
        }
      },
    },
    function () {
      return run({
        /** Delays of the timers still pending, in scheduling order. */
        delays() {
          return timers.delays();
        },
        pending() {
          return timers.pending();
        },
        /** Run every pending timer once. */
        runAll() {
          timers.runAll();
        },
        fire,
      });
    },
  );
}

/** A link as the build writes it for a chapter that exists. */
export function link(href, attributes) {
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
export function brokenLink(href, chapter) {
  const span = fakeElement("span");
  span.setAttribute(MISSING_ANCHOR_ATTRIBUTE, chapter);

  const anchor = link(href);
  anchor.previousElementSibling = span;
  return anchor;
}

/** The payload document the tests route into. */
export function payload() {
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
export function asStore(byId) {
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
export function travellingStore() {
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
export function panelOf(doc) {
  return (
    doc.created
      .filter((element) => element.className === POPOVER_CLASS)
      .pop() || null
  );
}

/** The element with `className`, searched depth first below `root`. */
export function byClass(root, className) {
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
export function buttonOf(panel, className) {
  return byClass(panel, className)[0] || null;
}

/** Press a button the way a reader does: a click that bubbles to the panel. */
export function press(button, event) {
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
export function clickInside(panel, target) {
  panel.fire("click", {
    target: target || panel,
    button: 0,
    preventDefault() {},
    stopPropagation() {},
  });
}

/** Everything the panel reads out, depth first, text included. */
export function textOf(root) {
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
export function setup(body, options) {
  return withFakeWindow(function (window) {
    const doc = fakeDocument();
    const previousDocument = globalThis.document;
    globalThis.document = doc;

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
      // The unlock wiring is the controller's; tests that need it pass their
      // own through `options`, the way they pass a store.
      onUnlock: options && options.onUnlock,
      passwordCandidates: options && options.passwordCandidates,
    });

    const finish = function () {
      view.dispose();
      globalThis.document = previousDocument;
    };

    let result;
    try {
      result = body({
        view,
        content,
        doc,
        clock: window,
        messages,
        navigations,
        fire: window.fire,
      });
    } catch (error) {
      finish();
      throw error;
    }

    // An awaited body keeps the fakes and the view until it settles, the way
    // the window fakes do for the promise answers the unlock attempts are.
    if (result && typeof result.then === "function") {
      return result.then(finish, function (error) {
        finish();
        throw error;
      });
    }

    finish();
    return result;
  });
}

/** Open the ordinary preview of a fresh link and hand the panel back. */
export function openPreview(ctx, href) {
  const anchor = link(href || "#/doc/guide/intro.md#getting-started");
  ctx.content.appendChild(anchor);
  ctx.view.tag(ctx.content);
  ctx.content.fire("pointerover", { target: anchor, relatedTarget: null });
  ctx.clock.runAll();

  return { anchor, panel: panelOf(ctx.doc) };
}

/**
 * Dispatch a click on `anchor` through `content`, reporting whether the view
 * asked the browser to stand down.
 */
export function fireClick(content, anchor, event) {
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
