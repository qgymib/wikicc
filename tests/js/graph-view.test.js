/**
 * Tests for `src/web/js/graph-view.js`: what a gesture on a node does.
 *
 * The rule under test is the one a reader notices immediately: a *single* plain
 * left click opens the document the node stands for, a drag only moves it, and a
 * modified click still belongs to the browser so a node can be opened in a new
 * tab. The bug these tests pin down was the first of those — the graph asked for
 * a second click — so the fake DOM here follows the browser's real anatomy
 * instead of inventing one:
 *
 * - `d3-selection` instantiates its own `SVGElement` to tell an SVG document from
 *   an HTML one, so `globalThis.SVGElement` is installed while a graph is built;
 * - a mouse gesture is dispatched from the deepest element up to the window, so a
 *   handler that swallows the press (`stopImmediatePropagation`, which is how
 *   `d3-drag` and `d3-zoom` take an event) really does silence its ancestors, and
 *   a handler that cancels the press (`preventDefault`, which a real browser
 *   answers by not firing `click`) really does eat the click;
 * - a window registered twice for the same type (`d3-drag` and `d3-zoom` both
 *   listen for `mousemove` on the view) is called twice, as the browser would;
 * - a press on a node is `pointerdown`, `mousedown`, `pointerup` and `mouseup`
 *   but *no* `click`, which is what Chrome does once `d3-drag` has taken the
 *   press with pointer capture — the sequence that made one click arrive as
 *   "nothing happened" while the next one worked;
 * - the press, the pointer movement and the release bubble everywhere instead
 *   of only along the target's ancestor chain, because a captured pointer
 *   reports to the window and `d3-drag`/`d3-zoom` park their handlers there;
 * - a press the gesture libraries take is cancelled (`preventDefault`) by them,
 *   and a cancelled press suppresses the `click` the browser would derive from
 *   it — which is the shape a node click really has, and the one that made a
 *   single click vanish entirely when the module vetoed a press that had
 *   already been cancelled by someone else.
 *
 * The real `d3-drag` and `d3-zoom` therefore run: the handlers, the pointer
 * capture on the window and the click suppression after a real drag are all the
 * shipped code paths, not stubs. What a browser adds on top of them — a
 * cancelled press suppresses the `click`, and a press on a link takes the focus
 * away from the element that held it — is written into the fake page where the
 * shipped code can observe it, because a fake that only pretends the browser was
 * polite cannot reproduce what a reader runs into.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createGraph } from "../../src/web/js/graph-view.js";

/** Namespace `d3-selection` gives every SVG child it creates. */
const SVG_NS = "http://www.w3.org/2000/svg";

/** Namespace `d3-selection` expects a real document's root to carry. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** Documents the payload of these tests carries. */
const DOCS = [
  { id: "README.md", title: "Read me" },
  { id: "guide/intro.md", title: "Intro" },
  { id: "guide/setup.md", title: "Setup" },
  { id: "notes.md", title: "Notes" },
];

/** One edge per node pair, so every node has a neighbour to highlight. */
const EDGES = [
  { from: "README.md", to: "guide/intro.md" },
  { from: "guide/intro.md", to: "guide/setup.md" },
];

/** Leaked property on `globalThis` while a fake page is installed. */
const INSTALLED = ["document", "window", "navigator", "SVGElement", "location"];

/**
 * The timers the graph scheduled, while the fake `setTimeout` is installed.
 *
 * It is a module-level slot rather than a parameter because the gesture helpers
 * are file-level functions: a timer armed by `d3-drag` arrives outside the graph
 * code, and only these globals can catch it.
 */
const timerQueue = { current: null };
let timerIds = 0;

function fakeSetTimeout(callback) {
  const queue = timerQueue.current;
  queue.push({ id: ++timerIds, callback: callback });
  return timerIds;
}

function fakeClearTimeout(id) {
  const queue = timerQueue.current;
  const index = queue.findIndex(function (timer) {
    return timer.id === id;
  });
  if (index >= 0) {
    queue.splice(index, 1);
  }
}

/**
 * Run `work` with the fake timers installed, then settle what it scheduled.
 *
 * The runtime's own `setTimeout` is back before this returns. The test runner
 * schedules its own bookkeeping through the same globals, so a replacement that
 * outlived the gesture would swallow it and keep the process alive for ever —
 * which looks exactly like a deadlock and wastes a run every time.
 *
 * Only the timers that already exist run: d3 arms a timeout again from inside
 * some of its timers (the touch "ghost click" window, the wheel idle signal), and
 * draining whatever those add would never end.
 *
 * What those timers add is cancelled rather than left to the real timer queue:
 * a d3 handler that wakes up after the fake page is gone touches an `SVGElement`
 * that no longer exists, and the runtime reports that as an asynchronous failure
 * of whichever test happened to be running. Cancelling is exact — the pending
 * timeouts are the leftovers of the gesture, not work anyone is waiting for.
 */
function withTimers(work) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const queue = [];
  const previous = timerQueue.current;

  timerQueue.current = queue;
  installGlobal("setTimeout", fakeSetTimeout);
  installGlobal("clearTimeout", fakeClearTimeout);
  try {
    return work();
  } finally {
    installGlobal("setTimeout", realSetTimeout);
    installGlobal("clearTimeout", realClearTimeout);
    timerQueue.current = previous;

    const pending = queue.splice(0, queue.length);
    for (const timer of pending) {
      timer.callback();
    }
    for (const timer of queue.splice(0, queue.length)) {
      realClearTimeout(timer.id);
    }
  }
}

/**
 * A fake element.
 *
 * `d3-selection` writes `ownerDocument`, `namespaceURI`, `__data__`, `__on` and
 * `style` properties straight onto a node, so plain objects are enough here — and
 * `createElementNS` deliberately lives on `document` only, as in a browser.
 */
function fakeElement(tagName, namespaceURI) {
  const element = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    namespaceURI: namespaceURI === undefined ? XHTML_NS : namespaceURI,
    children: [],
    attributes: {},
    listeners: {},
    parentNode: null,
    ownerDocument: null,
    ownerSVGElement: null,
    style: {},
    clientLeft: 0,
    clientTop: 0,
    // The canvas starts at the top-left corner of the window, so `clientX` and
    // `clientY` are already the graph's own coordinates.
    getBoundingClientRect() {
      return {
        top: 0,
        left: 0,
        right: 320,
        bottom: 260,
        width: 320,
        height: 260,
      };
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
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
    insertBefore(child, reference) {
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      child.parentNode = this;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[String(name)] = String(value);
    },
    getAttribute(name) {
      const key = String(name);
      return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null;
    },
    hasAttribute(name) {
      return Object.hasOwn(this.attributes, String(name));
    },
    removeAttribute(name) {
      delete this.attributes[String(name)];
    },
    addEventListener(type, handler, options) {
      // `capture` is read the way a browser reads it: a boolean or an options
      // object. Listeners are kept apart so the capture pass can run first.
      const capture = options === true || (options && options.capture === true);
      const bucket = capture ? "capture" : "listeners";
      if (!this[bucket]) {
        this[bucket] = {};
      }
      const list = this[bucket];
      if (!list[type]) {
        list[type] = [];
      }
      list[type].push(handler);
    },
    removeEventListener(type, handler, options) {
      const capture = options === true || (options && options.capture === true);
      const list = (capture ? this.capture : this.listeners) || {};
      const handlers = list[type] || [];
      const index = handlers.indexOf(handler);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    /** Elements of this subtree whose class list carries `name`. */
    findAll(name) {
      const found = [];
      (function walk(node) {
        node.children.forEach(function (child) {
          const className = child.getAttribute("class") || "";
          if (className.split(/\s+/).indexOf(name) !== -1) {
            found.push(child);
          }
          walk(child);
        });
      })(this);
      return found;
    },
    contains(node) {
      if (node === this) {
        return true;
      }
      return this.children.some(function (child) {
        return child.contains(node);
      });
    },
  };

  let text = "";
  Object.defineProperty(element, "textContent", {
    get() {
      return text;
    },
    set(value) {
      text = String(value);
      element.children.length = 0;
    },
  });

  return element;
}

/**
 * Install a fake page and build a graph into it.
 *
 * `options.docs` and `options.edges` replace the payload, and
 * `options.container: null` asks for the no-container case. `run` receives the
 * graph, the pieces a test dispatches on, and the `onSelect` calls it caused.
 */
function withGraph(run, options) {
  // The fake page is a whole world, so nothing of it may leak between two tests.
  const previous = {};
  INSTALLED.forEach(function (key) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  });

  const documentElement = fakeElement("html");
  documentElement.namespaceURI = XHTML_NS;

  const document = {
    documentElement,
    body: fakeElement("body"),
    createElement(tagName) {
      return build(tagName, XHTML_NS);
    },
    createElementNS(namespace, tagName) {
      return build(tagName, namespace);
    },
    createTextNode(value) {
      return { nodeType: 3, textContent: String(value) };
    },
  };
  documentElement.ownerDocument = document;
  document.body.ownerDocument = document;

  /** An element of `document`, with the SVG root bookkeeping d3 relies on. */
  function build(tagName, namespace) {
    const element = fakeElement(tagName, namespace);
    element.ownerDocument = document;
    if (element.namespaceURI === SVG_NS) {
      element.ownerSVGElement = null;
    }
    return element;
  }

  const container = fakeElement("div", XHTML_NS);
  container.ownerDocument = document;
  container.id = "graph";
  document.body.appendChild(container);

  // The window is where `d3-drag` and `d3-zoom` park the pointer capture, so it
  // needs the same listener list an element has. It also carries the page's
  // focus state: a browser that reports a press on one of the page's elements
  // has focused the window, and every element of the page then considers itself
  // focused too — which is what a press on a link changes.
  const window = fakeElement("window", XHTML_NS);
  window.window = window;
  window.document = document;
  window.hasFocus = true;

  installGlobal("document", document);
  installGlobal("window", window);
  installGlobal("navigator", { maxTouchPoints: 0 });
  installGlobal("SVGElement", SVGElementLike);
  installGlobal("location", { hash: "#/doc/README.md" });

  const selected = [];
  const payload = options || {};
  let graph = null;

  try {
    graph = withTimers(function () {
      return createGraph({
        container: payload.container === null ? null : container,
        docs: payload.docs || DOCS,
        edges: payload.edges || EDGES,
        mode: payload.mode,
        onSelect(id) {
          selected.push(id);
          // A real click on a node changes the route, and the render that
          // follows is what marks the open document in the graph. Standing in
          // for it here is what makes the next click on that node a click on the
          // document the reader is already reading.
          graph.setActive(id);
        },
      });
    });

    run({
      graph,
      container,
      document,
      window,
      selected,
      links: container.findAll("graph-edge"),
      nodes: container.findAll("graph-node"),
      /** Dispatch a real mouse press, releasing only when asked to. */
      press: function (target, settings) {
        return dispatchMouse(target, settings);
      },
      /** A whole click: press, then release at the same spot. */
      click: function (target, settings) {
        return dispatchMouse(
          target,
          Object.assign({}, settings, { release: true }),
        );
      },
      /**
       * A whole click as Chrome reports the one on a node: the press is taken by
       * `d3-drag` and the browser never gets to announce the `click`.
       */
      nodeClick: function (target, settings) {
        return dispatchMouse(
          target,
          Object.assign({}, settings, {
            release: true,
            click: false,
            capturedOn: container,
          }),
        );
      },
      /**
       * The same gesture, but the browser withholds the `click` without any
       * handler on this page having cancelled the press.
       *
       * That is the shape a press on a node has after the reader has been
       * elsewhere: the focus is moved onto the link by the browser itself, no
       * `preventDefault` is involved, and `d3-drag` never gets to announce a
       * click either.
       */
      silentNodeClick: function (target, settings) {
        return dispatchMouse(
          target,
          Object.assign({}, settings, {
            release: true,
            suppressClick: true,
            capturedOn: container,
          }),
        );
      },
    });
  } finally {
    INSTALLED.forEach(function (key) {
      if (previous[key]) {
        Object.defineProperty(globalThis, key, previous[key]);
      } else {
        delete globalThis[key];
      }
    });
  }
}

/** Marker class standing in for the browser's `SVGElement`. */
class SVGElementLike {}

/**
 * Dispatch a mouse gesture at `target` the way a browser does.
 *
 * The event travels the whole way a captured pointer makes it: from the target
 * up to its ancestors, then on to `document` and `window`, where `d3-drag` and
 * `d3-zoom` keep their handlers. A handler that calls
 * `stopImmediatePropagation` silences the rest of that node *and* the ancestors,
 * while `stopPropagation` only stops the ancestors — both as in a browser.
 *
 * `options.release` releases the button; `options.moveTo` moves the pointer
 * before releasing, which is what turns a press into a drag; and
 * `options.suppressClick` withholds the `click` even though no handler of this
 * page cancelled the press, which is how a gesture the browser settles on its
 * own — a press on a link that takes the focus, for instance — reaches the
 * graph.
 */
function dispatchMouse(target, options) {
  const settings = options || {};
  const startX = settings.x === undefined ? 160 : settings.x;
  const startY = settings.y === undefined ? 130 : settings.y;

  function mouseEvent(type, x, y, detail) {
    return {
      type,
      target,
      currentTarget: null,
      // A compatibility mouse event is created from the same interface as the
      // pointer event it follows, so it carries the view as well.
      view: globalThis.window,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: type === "mouseup" || type === "click" ? 0 : 1,
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
      screenX: x,
      screenY: y,
      detail: detail,
      ctrlKey: !!settings.ctrlKey,
      metaKey: !!settings.metaKey,
      shiftKey: !!settings.shiftKey,
      altKey: !!settings.altKey,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    };
  }

  /**
   * Deliver `event` from `node` up to the window.
   *
   * The chain is built by hand because a fake tree has no document or window
   * above the container: a real path is element, …, `body`, `html`, `document`,
   * `window`, and d3 needs the last two.
   */
  function propagate(node, event) {
    const path = [];
    for (let current = node; current; current = current.parentNode) {
      path.push(current);
    }
    // `node` is sometimes the container itself (the pointer movement and the
    // release), in which case the chain stops short of the two.
    if (node !== globalThis.window) {
      path.push(globalThis.document, globalThis.window);
    }

    // Capture runs from the window down to the target, then the target's own
    // listeners, then the bubble pass back up — the order a browser uses.
    for (const current of path.slice().reverse()) {
      deliver(current, event, "capture");
    }
    for (const current of path) {
      if (event.propagationStopped) {
        break;
      }
      deliver(current, event, "listeners");
    }
    return event;
  }

  function deliver(node, event, bucket) {
    const listeners = node[bucket] || {};
    const handlers = (listeners[event.type] || []).slice();
    event.currentTarget = node;
    for (const handler of handlers) {
      handler.call(node, event);
      if (event.immediatePropagationStopped) {
        // Silencing the rest of this node silences the ancestors too.
        event.propagationStopped = true;
        return;
      }
    }
  }

  // `detail` counts consecutive presses on the same node, so a test can ask for
  // the second press of a double click the way the browser reports it.
  const detail = settings.detail === undefined ? 1 : settings.detail;

  // The element that holds the pointer capture for the rest of the gesture:
  // `d3-drag` parks it on the window, so that is where the browser reports the
  // pointer once it has left the element it pressed on.
  const captured = settings.capturedOn || globalThis.window;

  // The element the release is reported on. A rule of `d3-drag` disables
  // `pointer-events` on the dragged node for the duration of the gesture, so the
  // button comes up over the container underneath it rather than on the node.
  const releasedOn = settings.releasedOn || globalThis.document.body;

  // The whole gesture runs with the fake timers installed and settles them
  // before returning: a timer `d3-drag` arms belongs to this gesture, and leaving
  // it to the event loop would run it after the test, against a torn-down page.
  const pressed = withTimers(function () {
    // A browser reports the press twice, as a pointer event and as the mouse
    // event derived from it.
    const press = propagate(
      target,
      mouseEvent("pointerdown", startX, startY, detail),
    );
    propagate(target, mouseEvent("mousedown", startX, startY, detail));

    // A press on a link takes the focus: the element that had it announces a
    // `blur`, and the link becomes the active element. The graph sees that
    // `blur` because it watches the page for the reader leaving mid-gesture, and
    // it reports the press as coming from a window that is focused, unlike the
    // first press after the reader was working in another window.
    if (settings.focusMoves !== false) {
      propagate(
        globalThis.document,
        mouseEvent("blur", startX, startY, detail),
      );
      globalThis.document.activeElement = target;
    }

    return press;
  });

  if (settings.release) {
    const endX = settings.moveTo ? settings.moveTo.x : startX;
    const endY = settings.moveTo ? settings.moveTo.y : startY;

    withTimers(function () {
      if (settings.moveTo) {
        // `d3-zoom` pans from the SVG it listens on, `d3-drag` moves the node
        // from the window, so a pointer move has to reach both, as it does in a
        // browser where the window capture does not stop the event from bubbling.
        propagate(captured, mouseEvent("mousemove", endX, endY, detail));
      }

      // The capture sends the pointer events to the window, while the mouse
      // events still report to the element under the pointer.
      propagate(captured, mouseEvent("pointerup", endX, endY, detail));
      propagate(releasedOn, mouseEvent("mouseup", endX, endY, detail));
    });

    withTimers(function () {
      // A cancelled press suppresses the `click` a browser would derive from it,
      // whichever handler cancelled it: `d3-drag`, `d3-zoom`, or the node's own
      // listeners. That is why a node has to be opened without one; when the
      // click does come, it only describes the gesture the release has already
      // decided.
      if (
        !pressed.defaultPrevented &&
        !settings.suppressClick &&
        settings.click !== false
      ) {
        propagate(target, mouseEvent("click", endX, endY, detail));
      }

      // The second press of a double click is followed by `dblclick`, which the
      // graph answers by zooming — never by opening the document again.
      if (detail > 1) {
        propagate(target, mouseEvent("dblclick", endX, endY, detail));
      }
    });
  }

  return pressed.defaultPrevented ? "defaultPrevented" : "ok";
}

/** Define `key` on `globalThis`, replacing whatever is there. */
function installGlobal(key, value) {
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/** The node element standing for `id`. */
function nodeFor(nodes, id) {
  const found = nodes.find(function (node) {
    return (node.getAttribute("href") || "").endsWith(
      encodeURIComponent(id.split("/").pop()),
    );
  });
  assert.ok(found, `missing node ${id}`);
  return found;
}

test("draws one linked node per document", () => {
  withGraph(function (page) {
    assert.equal(page.nodes.length, DOCS.length);
    assert.equal(page.links.length, EDGES.length);
    assert.equal(
      page.container.getAttribute("data-nodes"),
      String(DOCS.length),
    );
    assert.equal(
      page.container.getAttribute("data-links"),
      String(EDGES.length),
    );

    const intro = nodeFor(page.nodes, "guide/intro.md");
    assert.equal(intro.getAttribute("href"), "#/doc/guide/intro.md");
    assert.match(intro.getAttribute("aria-label"), /^Intro, 2 connections$/);
  });
});

test("a single plain left click opens the document", () => {
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");

    page.click(intro);

    assert.deepEqual(
      page.selected,
      ["guide/intro.md"],
      "one click must open the document once",
    );
  });
});

test("a click Chrome reports without a click event still opens the document", () => {
  // The sequence a real press on a node produces: `d3-drag` takes the press
  // with pointer capture and the browser never announces the `click`. A graph
  // that waits for it treats every first click as "nothing happened", and the
  // second one arrives as a click of its own — the bug this pins down. The
  // browser also keeps `detail` at 1 across those presses, because no click ever
  // reaches its click detector.
  withGraph(function (page) {
    page.nodeClick(nodeFor(page.nodes, "README.md"));
    page.nodeClick(nodeFor(page.nodes, "guide/intro.md"));
    page.nodeClick(nodeFor(page.nodes, "guide/setup.md"));

    assert.deepEqual(
      page.selected,
      ["README.md", "guide/intro.md", "guide/setup.md"],
      "every press must open its own document",
    );
  });
});

test("a second press on the same node opens it again once the reader has moved on", () => {
  // The node of the open document is the one case that stays silent, so the
  // reader has to leave it before pressing it again. Two gestures in a row are
  // then two clicks, not one click and its shadow.
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");
    const setup = nodeFor(page.nodes, "guide/setup.md");

    page.nodeClick(intro);
    page.nodeClick(setup);
    page.nodeClick(intro);

    assert.deepEqual(page.selected, [
      "guide/intro.md",
      "guide/setup.md",
      "guide/intro.md",
    ]);
  });
});

test("a click on the node of the open document does nothing", () => {
  // The reader is reading exactly what the node stands for: opening it again
  // would re-render the page under them and throw away their position. The node
  // is pressed the way a reader does when a click seems to be ignored — once,
  // twice, and once more with the click the browser announces — and none of
  // those gestures may navigate. The view is global so the node of the open
  // document is still on screen after the reader has moved away from it: a
  // local view would have redrawn the neighbourhood around the new document.
  withGraph(
    function (page) {
      // Read back from the page: a global view keeps its markup, but the
      // assertion may not depend on that.
      function readme() {
        return nodeFor(page.container.findAll("graph-node"), "README.md");
      }

      // The reader arrives somewhere else first, so the node has a document to
      // stand for that is not the open one.
      page.nodeClick(nodeFor(page.nodes, "guide/intro.md"));
      page.graph.setActive("README.md");

      page.nodeClick(readme());
      page.nodeClick(readme());
      // The announced-click path as well: a browser reports a click this way when
      // `d3-drag` never took the press.
      page.click(readme());

      assert.deepEqual(page.selected, ["guide/intro.md"]);
    },
    { mode: "global" },
  );
});

test("a suppressed click does not open a document twice", () => {
  // When the browser *does* announce the click after the press, the release
  // has already opened the document: one gesture, one navigation.
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");

    page.click(intro);

    assert.deepEqual(page.selected, ["guide/intro.md"]);
  });
});

test("the press on a child of the node is still a press on the node", () => {
  // The circle and the label sit inside the link; the press starts on them, so
  // the drag has to keep the node rather than fall back to "no subject".
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");
    const circle = intro.children[0];

    page.nodeClick(circle);

    assert.deepEqual(page.selected, ["guide/intro.md"]);
    assert.ok(
      circle.getAttribute("class") === null ||
        !circle.getAttribute("class").includes("is-dragging"),
      "a press is not a drag",
    );
  });
});

test("a click on the circle or on the label opens the document", () => {
  // Both halves of the link are pressable, and a press on either is a press on
  // the node. The reader moves away between them, because a second click on the
  // document already open is deliberately ignored.
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");
    const circle = intro.children[0];
    const label = intro.children.find(function (child) {
      return (child.getAttribute("class") || "") === "graph-label";
    });

    page.click(circle);
    page.graph.setActive("notes.md");
    page.click(label);

    assert.deepEqual(page.selected, ["guide/intro.md", "guide/intro.md"]);
  });
});

test("every node opens its own document", () => {
  withGraph(
    function (page) {
      page.nodes.forEach(function (node) {
        page.click(node);
      });

      assert.deepEqual(
        page.selected,
        DOCS.map((doc) => doc.id),
      );
    },
    { mode: "global" },
  );
});

test("a double click opens the document exactly once", () => {
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");

    // Two presses in a row: the browser counts the second as `detail: 2`, and
    // the navigation the first one caused has already made that document the
    // active one by the time the second press is released.
    page.click(intro);
    page.click(intro, { detail: 2 });

    assert.deepEqual(
      page.selected,
      ["guide/intro.md"],
      "a double click must not navigate twice",
    );
  });
});

test("a click on a node opens its document after a click somewhere else", () => {
  // The reader presses somewhere outside the graph — the article, the document
  // list, anything — and then single-clicks a node. That is the report this test
  // pins down: the first press on the graph moved the focus, and a second click
  // was needed to open the document. One press and one release have to be
  // enough, wherever the reader was before.
  withGraph(function (page) {
    page.nodeClick(nodeFor(page.nodes, "guide/intro.md"));
    page.silentNodeClick(nodeFor(page.nodes, "guide/setup.md"));

    assert.deepEqual(
      page.selected,
      ["guide/intro.md", "guide/setup.md"],
      "one press and one release must be enough, wherever the reader was before",
    );
  });
});

test("the focus the press reports does not drop the press", () => {
  // A press the browser makes on one of the page's own elements reports the
  // window as focused, and the graph watches `blur` to tell that the reader has
  // left the page mid-gesture. A `focus` is the opposite of `blur` and must not
  // end the gesture: a graph that drops the press here opens nothing until the
  // reader clicks a second time.
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");

    page.nodeClick(intro);

    assert.deepEqual(page.selected, ["guide/intro.md"]);
  });
});

test("a cancelled press is still a press the node has to judge", () => {
  // `d3-zoom` and `d3-drag` both cancel the press they take, and so does the
  // browser for a link it is about to follow. A cancellation says nothing about
  // *whose* gesture this is: vetoing a press because someone else already
  // cancelled it swallows the whole click, since the release then has no press
  // to settle and no `click` ever arrives. The node records the gesture either
  // way and lets the travel distance decide.
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");

    page.click(intro, { cancelPress: true });

    assert.deepEqual(page.selected, ["guide/intro.md"]);
  });
});

test("a modified click stays with the browser", () => {
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");

    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      const outcome = page.click(intro, { [modifier]: true });
      assert.notEqual(
        outcome,
        "prevented",
        `${modifier} must keep the native behaviour`,
      );
    }

    assert.deepEqual(
      page.selected,
      [],
      "the reader must not take over a new-tab click",
    );
  });
});

test("a drag moves the node without opening the document", () => {
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");
    const before = intro.getAttribute("transform");

    page.press(intro, { release: true, moveTo: { x: 260, y: 40 } });

    assert.deepEqual(page.selected, [], "a drag must not navigate");
    assert.notEqual(
      intro.getAttribute("transform"),
      before,
      "the node must follow the pointer",
    );
  });
});

test("the press that ends a drag does not open the document", () => {
  withGraph(function (page) {
    const intro = nodeFor(page.nodes, "guide/intro.md");

    // Drag, then click once: only the second gesture is a click.
    page.press(intro, { release: true, moveTo: { x: 40, y: 230 } });
    page.click(intro);

    assert.deepEqual(page.selected, ["guide/intro.md"]);
  });
});

test("highlighting follows the pointer", () => {
  withGraph(
    function (page) {
      const intro = nodeFor(page.nodes, "guide/intro.md");

      intro.listeners.mouseenter.forEach(function (handler) {
        handler.call(intro, { type: "mouseenter" });
      });

      assert.ok(intro.getAttribute("class").split(" ").includes("is-hot"));
      assert.ok(
        nodeFor(page.nodes, "notes.md")
          .getAttribute("class")
          .split(" ")
          .includes("is-dim"),
        "the unrelated node must be dimmed",
      );

      intro.listeners.mouseleave.forEach(function (handler) {
        handler.call(intro, { type: "mouseleave" });
      });

      assert.ok(!intro.getAttribute("class").split(" ").includes("is-hot"));
      assert.ok(
        !nodeFor(page.nodes, "notes.md")
          .getAttribute("class")
          .split(" ")
          .includes("is-dim"),
      );
    },
    { mode: "global" },
  );
});

test("setActive marks the open document and leaves the rest alone", () => {
  withGraph(
    function (page) {
      // Read the nodes back from the page each time: a global view keeps its
      // markup, but nothing here may depend on that.
      const nodes = function () {
        return page.container.findAll("graph-node");
      };

      page.graph.setActive("guide/setup.md");

      assert.ok(
        nodeFor(nodes(), "guide/setup.md")
          .getAttribute("class")
          .includes("is-active"),
      );
      assert.equal(
        nodeFor(nodes(), "guide/setup.md").getAttribute("aria-current"),
        "true",
      );
      assert.equal(
        nodeFor(nodes(), "notes.md").getAttribute("aria-current"),
        null,
      );

      page.graph.setActive(null);
      assert.ok(
        !nodeFor(nodes(), "guide/setup.md")
          .getAttribute("class")
          .includes("is-active"),
      );
    },
    { mode: "global" },
  );
});

test("fit resets the viewport without opening anything", () => {
  withGraph(
    function (page) {
      assert.doesNotThrow(function () {
        page.graph.fit();
      });
      assert.deepEqual(page.selected, []);
    },
    { mode: "global" },
  );
});

test("a missing container yields a no-op graph", () => {
  const graph = createGraph({ docs: DOCS, edges: EDGES, onSelect() {} });

  assert.deepEqual(Object.keys(graph).sort(), [
    "fit",
    "getMode",
    "setActive",
    "setMode",
  ]);
  assert.doesNotThrow(function () {
    graph.setActive("README.md");
    graph.fit();
    graph.setMode("global");
  });
});

test("a site without documents shows a hint and never navigates", () => {
  withGraph(
    function (page) {
      assert.equal(page.container.getAttribute("data-nodes"), null);
      assert.equal(page.container.children.length, 1);

      // `renderHint` sets `className`, which in a browser also writes the
      // attribute the assertion below reads.
      const hint = page.container.children[0];
      assert.equal(hint.tagName, "P");
      assert.equal(hint.className, "panel-hint");
      assert.equal(hint.textContent, "No documents");
    },
    { docs: [], edges: [] },
  );
});

/** The ids the graph is drawing right now, read back from the page. */
function drawnIds(container) {
  return container
    .findAll("graph-node")
    .map(function (node) {
      return decodeURIComponent(
        node.getAttribute("href").replace(/^#\/doc\//, ""),
      );
    })
    .sort();
}

test("a graph opens on the local view of the document it is given", () => {
  withGraph(function (page) {
    page.graph.setActive("guide/intro.md");

    assert.equal(page.graph.getMode(), "local");
    assert.equal(page.container.getAttribute("data-mode"), "local");
    assert.deepEqual(drawnIds(page.container), [
      "README.md",
      "guide/intro.md",
      "guide/setup.md",
    ]);
    assert.equal(
      page.container.getAttribute("data-nodes"),
      "3",
      "the document two hops away is not part of its neighbourhood",
    );
    assert.equal(page.container.getAttribute("data-links"), "2");
  });
});

test("the local view follows the document the reader opens", () => {
  withGraph(function (page) {
    page.graph.setActive("guide/setup.md");

    assert.deepEqual(drawnIds(page.container), [
      "guide/intro.md",
      "guide/setup.md",
    ]);
    assert.equal(
      nodeFor(
        page.container.findAll("graph-node"),
        "guide/setup.md",
      ).getAttribute("aria-current"),
      "true",
    );

    page.graph.setActive("notes.md");
    assert.deepEqual(
      drawnIds(page.container),
      ["notes.md"],
      "a document with no links stands alone",
    );
    assert.equal(page.container.getAttribute("data-links"), "0");
    assert.equal(
      page.graph.getMode(),
      "local",
      "the mode belongs to the panel, not to the document",
    );
  });
});

test("a local view of a lone document is a readable single node", () => {
  withGraph(function (page) {
    page.graph.setActive("notes.md");

    const node = nodeFor(page.container.findAll("graph-node"), "notes.md");
    assert.equal(
      node.getAttribute("aria-label"),
      "Notes, 0 connections",
      "the only node still says what it is and that it links nowhere",
    );
    assert.equal(page.container.findAll("graph-edge").length, 0);
    assert.equal(
      page.container.getAttribute("class"),
      null,
      "no hint takes the place of the graph",
    );
  });
});

test("switching to the global view draws the whole site", () => {
  withGraph(function (page) {
    page.graph.setActive("guide/setup.md");
    assert.equal(drawnIds(page.container).length, 2);

    page.graph.setMode("global");

    assert.equal(page.graph.getMode(), "global");
    assert.equal(page.container.getAttribute("data-mode"), "global");
    assert.deepEqual(
      drawnIds(page.container),
      DOCS.map((doc) => doc.id).sort(),
    );
    assert.equal(
      page.container.getAttribute("data-links"),
      String(EDGES.length),
    );
    assert.equal(
      nodeFor(
        page.container.findAll("graph-node"),
        "guide/setup.md",
      ).getAttribute("aria-current"),
      "true",
      "the document being read stays marked after the switch",
    );
  });
});

test("switching back to the local view narrows the picture again", () => {
  withGraph(
    function (page) {
      page.graph.setActive("guide/setup.md");
      assert.equal(drawnIds(page.container).length, DOCS.length);

      page.graph.setMode("local");

      assert.equal(page.graph.getMode(), "local");
      assert.deepEqual(drawnIds(page.container), [
        "guide/intro.md",
        "guide/setup.md",
      ]);
    },
    { mode: "global" },
  );
});

test("a local view is redrawn only when the neighbourhood really changes", () => {
  withGraph(function (page) {
    page.graph.setActive("guide/intro.md");
    const first = nodeFor(
      page.container.findAll("graph-node"),
      "guide/intro.md",
    );

    // The same document again, as walking to another chapter of it does: the
    // picture has nothing new to show, so it keeps the arrangement the reader
    // may have given it.
    page.graph.setActive("guide/intro.md");
    assert.equal(
      nodeFor(page.container.findAll("graph-node"), "guide/intro.md"),
      first,
    );
  });
});

test("a global view is not rebuilt when the document changes", () => {
  withGraph(
    function (page) {
      const before = page.container.findAll("graph-node");

      page.graph.setActive("guide/setup.md");

      const after = page.container.findAll("graph-node");
      assert.equal(after.length, before.length);
      after.forEach(function (node, index) {
        assert.equal(node, before[index], "the markup is the same objects");
      });
    },
    { mode: "global" },
  );
});

test("a mode the graph does not know is ignored", () => {
  withGraph(function (page) {
    page.graph.setActive("guide/intro.md");
    const before = drawnIds(page.container);

    page.graph.setMode("everything");
    page.graph.setMode(null);
    page.graph.setMode(undefined);

    assert.equal(page.graph.getMode(), "local");
    assert.deepEqual(drawnIds(page.container), before);
  });
});

test("a local view emphasises the pointer without dimming its neighbours", () => {
  withGraph(function (page) {
    page.graph.setActive("guide/intro.md");
    const intro = nodeFor(
      page.container.findAll("graph-node"),
      "guide/intro.md",
    );

    intro.listeners.mouseenter.forEach(function (handler) {
      handler.call(intro, { type: "mouseenter" });
    });

    assert.ok(intro.getAttribute("class").split(" ").includes("is-hot"));
    assert.equal(
      page.container.findAll("is-dim").length,
      0,
      "nothing in the picture is outside the neighbourhood, so nothing may be greyed out",
    );
  });
});

test("a document the site does not have leaves the graph without a picture", () => {
  withGraph(function (page) {
    page.graph.setActive("ghost.md");

    assert.equal(page.container.getAttribute("data-nodes"), "0");
    assert.equal(page.container.findAll("graph-node").length, 0);
    assert.equal(
      page.container.children[0].textContent,
      "No documents",
      "there is nothing to draw, and the panel says so",
    );
  });
});

test("the first local view before any document is known shows the whole site", () => {
  // `createGraph` runs before the first render names a document; drawing only
  // its neighbourhood would draw nothing at all for that moment.
  withGraph(function (page) {
    assert.deepEqual(
      drawnIds(page.container),
      DOCS.map((doc) => doc.id).sort(),
    );

    page.graph.setActive("notes.md");
    assert.deepEqual(drawnIds(page.container), ["notes.md"]);
  });
});

test("the mode survives a switch of document and a switch of mode", () => {
  withGraph(function (page) {
    page.graph.setMode("global");
    page.graph.setActive("notes.md");
    assert.equal(page.graph.getMode(), "global");
    assert.equal(drawnIds(page.container).length, DOCS.length);

    page.graph.setMode("local");
    page.graph.setActive("guide/intro.md");
    assert.equal(page.graph.getMode(), "local");
    assert.deepEqual(drawnIds(page.container), [
      "README.md",
      "guide/intro.md",
      "guide/setup.md",
    ]);
  });
});

test("a click on the node of the open document does nothing in a local view either", () => {
  withGraph(function (page) {
    page.graph.setActive("guide/intro.md");

    page.nodeClick(
      nodeFor(page.container.findAll("graph-node"), "guide/intro.md"),
    );

    assert.deepEqual(page.selected, []);
  });
});
