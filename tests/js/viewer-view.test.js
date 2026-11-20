/**
 * The viewer view: the hover toolbar, the lightbox and the gestures around
 * them.
 *
 * The transform engine is injected — a recording fake that answers how it
 * was built and what it was told — because panzoom needs the layout and the
 * pointer plumbing of a real page. Everything else runs the shipped code:
 * the arming, the mermaid provider's clone, the actions, the Escape taken on
 * the capture phase, the body attribute that locks the scroll and the focus
 * that returns to where the session came from. The fit arithmetic itself is
 * the pure
 * module's to prove; here the page's fakes carry no geometry, so the open
 * viewer starts at scale 1 — which is what the shipped fallback answers when
 * nothing has been laid out yet.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createFakeDocument,
  createFakeElement,
  withGlobals,
} from "./helpers/dom.js";

import * as Viewer from "../../src/web/js/viewer.js";
import { createViewerView } from "../../src/web/js/viewer-view.js";

/** A recording fake of the transform engine panzoom returns. */
function makeEngine() {
  const calls = [];
  const engine = {
    zoomIn: function () {
      calls.push("zoomIn");
    },
    zoomOut: function () {
      calls.push("zoomOut");
    },
    reset: function () {
      calls.push("reset");
    },
    destroy: function () {
      calls.push("destroy");
    },
    zoom: function (scale, options) {
      calls.push({ gesture: "zoom", scale: scale, focal: options.focal });
    },
    getScale: function () {
      return 1;
    },
    getPan: function () {
      return { x: 0, y: 0 };
    },
  };
  return { calls: calls, engine: engine };
}

/** A fake page: a fresh document, a view over it, the engines it built. */
function makePage(makeEngine_) {
  const doc = createFakeDocument();
  const engines = [];
  const view = createViewerView({
    createTransform: function (content, initial) {
      const made = (makeEngine_ || makeEngine)();
      engines.push({
        content: content,
        initial: initial,
        engine: made.engine,
        calls: made.calls,
      });
      return made.engine;
    },
  });
  return { doc: doc, view: view, engines: engines };
}

/** A rendered diagram: a `pre.mermaid` the way the build leaves it. */
function makeDiagram(viewBox) {
  const svg = createFakeElement("svg");
  if (viewBox !== undefined) {
    svg.setAttribute("viewBox", viewBox);
  }
  svg.cloneNode = function () {
    const clone = createFakeElement("svg");
    if (viewBox !== undefined) {
      clone.setAttribute("viewBox", viewBox);
    }
    clone.setAttribute("style", "max-width: 480px;");
    return clone;
  };
  const pre = createFakeElement("pre");
  pre.className = "mermaid";
  pre.setAttribute("data-processed", "true");
  pre.querySelector = function (selector) {
    return selector === "svg" ? svg : null;
  };
  return { pre: pre, svg: svg };
}

/** The backdrop the viewer mounted on the body, as the tests reach it. */
function backdropOf(page) {
  const body = page.doc.body;
  return body.children[body.children.length - 1];
}

/** The window, header, actions row and stage of an open viewer. */
function partsOf(page) {
  const backdrop = backdropOf(page);
  const frame = backdrop.children[0];
  const header = frame.children[0];
  return {
    backdrop: backdrop,
    frame: frame,
    header: header,
    heading: header.children[0],
    actions: header.children[1],
    stage: frame.children[1],
  };
}

test("arming a rendered diagram hangs one corner button on it", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    assert.equal(page.view.armHover([diagram.pre]), 1);
  });

  const toolbars = diagram.pre.children.filter(function (child) {
    return child.className === "viewer-hover";
  });
  assert.equal(toolbars.length, 1);

  const button = toolbars[0].children[0];
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.type, "button");
  assert.equal(button.getAttribute("aria-label"), "Open diagram in viewer");
  assert.equal(button.getAttribute("title"), "Open diagram in viewer");
  assert.equal(button.children.length, 1);
  assert.equal(button.children[0].tagName, "SVG");
  assert.ok(button.children[0].children[0].getAttribute("d").length > 0);

  // The block itself takes the focus back on close of a pointer session,
  // so arming makes it focusable without joining the tab order, and marks
  // it as the viewer's host for the stylesheet to quiet.
  assert.equal(diagram.pre.getAttribute("tabindex"), "-1");
  assert.equal(diagram.pre.className, "mermaid viewer-host");
});

test("arming again replaces the toolbar instead of stacking one", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    page.view.armHover([diagram.pre]);
  });

  assert.equal(diagram.pre.children.length, 1);
  assert.equal(diagram.pre.children[0].className, "viewer-hover");
});

test("a block no provider matches is not armed", () => {
  const page = makePage();
  const plain = createFakeElement("pre");

  withGlobals({ document: page.doc }, function () {
    assert.equal(page.view.armHover([plain]), 0);
    assert.equal(page.view.armHover([]), 0);
    assert.equal(page.view.armHover(null), 0);
  });

  assert.equal(plain.children.length, 0);
});

test("the corner button opens the lightbox with the diagram inside", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    diagram.pre.children[0].children[0].fire("click");
  });

  assert.equal(page.doc.body.children.length, 1);
  const parts = partsOf(page);

  assert.equal(parts.backdrop.className, "viewer-backdrop");
  assert.equal(parts.frame.className, "viewer-window");
  assert.equal(parts.frame.getAttribute("role"), "dialog");
  assert.equal(parts.frame.getAttribute("aria-modal"), "true");
  assert.equal(parts.frame.getAttribute("aria-label"), "Diagram");

  assert.equal(parts.heading.tagName, "H2");
  assert.equal(parts.heading.textContent, "Diagram");

  assert.deepEqual(
    Array.prototype.map.call(parts.actions.children, function (button) {
      return button.getAttribute("aria-label");
    }),
    ["Zoom in", "Zoom out", "Reset view", "Close viewer"],
  );
  parts.actions.children.forEach(function (button) {
    assert.equal(button.className, "icon-button viewer-action");
    assert.equal(button.type, "button");
    assert.equal(button.children.length, 1);
  });

  assert.equal(parts.stage.className, "viewer-stage");
  const content = parts.stage.children[0];
  assert.equal(content.className, "viewer-content");
  const clone = content.children[0];
  assert.equal(clone.tagName, "SVG");
  assert.equal(clone.getAttribute("width"), "800");
  assert.equal(clone.getAttribute("height"), "400");
  assert.equal(clone.getAttribute("style"), null);

  assert.equal(page.doc.body.getAttribute("data-viewer"), "open");

  assert.equal(page.engines.length, 1);
  assert.equal(page.engines[0].content, content);
  assert.deepEqual(page.engines[0].initial, { scale: 1, x: 0, y: 0 });
  assert.equal(parts.actions.children[3].focused, true);

  assert.equal(page.doc.listeners.keydown.length, 1);
  assert.equal(parts.stage.listeners.wheel.length, 1);
});

test("a wheel notch on the stage zooms anchored at the cursor", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    diagram.pre.children[0].children[0].fire("click");

    const parts = partsOf(page);
    const content = parts.stage.children[0];
    // An 800x400 picture at scale 1 whose rest centre sits at (400, 200) —
    // what a stage laid out at the page's top-left reports.
    content.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 800, height: 400 };
    };
    const prevented = [];
    parts.stage.fire("wheel", {
      clientX: 200,
      clientY: 150,
      deltaY: -120,
      preventDefault: function () {
        prevented.push("wheel");
      },
    });

    assert.equal(page.engines[0].calls.length, 1);
    const call = page.engines[0].calls[0];
    assert.equal(call.gesture, "zoom");
    const toScale = Math.exp(0.3 / 3);
    assert.equal(call.scale, toScale);
    // The focal pins the point under the cursor: the cursor sits 300 left
    // of and 50 above the picture's centre, in new-scale units.
    assert.ok(Math.abs(call.focal.x - (200 - 400) * toScale) < 1e-9);
    assert.ok(Math.abs(call.focal.y - (150 - 200) * toScale) < 1e-9);
    assert.deepEqual(prevented, ["wheel"]);

    // A notch the geometry cannot anchor leaves the engine alone.
    delete content.getBoundingClientRect;
    parts.stage.fire("wheel", { clientX: 0, clientY: 0, deltaY: -120 });
    assert.equal(page.engines[0].calls.length, 1);
  });
});

test("an engine without zoom takes no wheel listener", () => {
  const page = makePage(function () {
    return {
      calls: [],
      engine: {
        zoomIn: function () {},
        zoomOut: function () {},
        reset: function () {},
        destroy: function () {},
      },
    };
  });
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    diagram.pre.children[0].children[0].fire("click");
    assert.equal(page.view.isOpen(), true);
    assert.equal(partsOf(page).stage.listeners.wheel, undefined);
  });
});

test("the standard actions drive the engine, and close drives the viewer", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    diagram.pre.children[0].children[0].fire("click");

    const parts = partsOf(page);
    parts.actions.children[0].fire("click");
    parts.actions.children[1].fire("click");
    parts.actions.children[2].fire("click");
    assert.deepEqual(page.engines[0].calls, ["zoomIn", "zoomOut", "reset"]);

    parts.actions.children[3].fire("click");
    assert.equal(page.view.isOpen(), false);
    assert.deepEqual(page.engines[0].calls, [
      "zoomIn",
      "zoomOut",
      "reset",
      "destroy",
    ]);
    assert.equal(page.doc.body.getAttribute("data-viewer"), null);
    assert.equal(page.doc.body.children.length, 0);
  });
});

test("Escape closes the viewer and hands the focus back to the trigger", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    const trigger = diagram.pre.children[0].children[0];
    page.doc.activeElement = trigger;
    trigger.fire("click");
    assert.equal(page.view.isOpen(), true);

    page.doc.fire("keydown", {
      key: "Escape",
      stopPropagation: function () {},
    });

    assert.equal(page.view.isOpen(), false);
    assert.equal(page.doc.body.getAttribute("data-viewer"), null);
    assert.equal(page.doc.body.children.length, 0);
    assert.deepEqual(page.engines[0].calls, ["destroy"]);
    assert.equal(trigger.focused, true);
    assert.deepEqual(page.doc.listeners.keydown, []);
  });
});

test("a pointer session hands the focus back to the block, not the button", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    const trigger = diagram.pre.children[0].children[0];
    page.doc.activeElement = trigger;
    // A pointer press answers detail 1; a keyboard Enter answers 0.
    trigger.fire("click", { detail: 1 });
    assert.equal(page.view.isOpen(), true);

    page.doc.fire("keydown", {
      key: "Escape",
      stopPropagation: function () {},
    });

    // The button would keep a visible focus indicator no pointer gesture
    // can clear: the lit frame and the highlighted corner button an
    // Escape press leaves behind. The block holds the focus quietly.
    assert.equal(page.view.isOpen(), false);
    assert.equal(diagram.pre.focused, true);
    assert.ok(!trigger.focused, "the button is not focused");
    assert.equal(page.doc.body.children.length, 0);
  });
});

test("a key that is not Escape leaves the viewer alone", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    diagram.pre.children[0].children[0].fire("click");

    page.doc.fire("keydown", { key: "Tab" });
    page.doc.fire("keydown", {});

    assert.equal(page.view.isOpen(), true);
    assert.equal(page.doc.body.getAttribute("data-viewer"), "open");

    page.view.close();
    assert.equal(page.view.isOpen(), false);
    assert.equal(page.doc.body.children.length, 0);
  });
});

test("a press on the backdrop closes the viewer, a press on the window does not", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    diagram.pre.children[0].children[0].fire("click");

    const parts = partsOf(page);
    parts.backdrop.fire("click", { target: parts.frame });
    assert.equal(page.view.isOpen(), true);

    parts.backdrop.fire("click", { target: parts.backdrop });
    assert.equal(page.view.isOpen(), false);
    assert.equal(page.doc.body.children.length, 0);
  });
});

test("a mount that yields nothing leaves the page as it was", () => {
  const page = makePage();
  const svg = createFakeElement("svg");
  svg.setAttribute("viewBox", "0 0 800 400");
  // No `cloneNode`: the provider cannot build the stage's content.
  const pre = createFakeElement("pre");
  pre.className = "mermaid";
  pre.setAttribute("data-processed", "true");
  pre.querySelector = function () {
    return svg;
  };

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([pre]);
    page.pre = pre;
    pre.children[0].children[0].fire("click");
    assert.equal(page.view.openFor(pre), null);
    assert.equal(page.view.isOpen(), false);
    assert.equal(page.doc.body.children.length, 0);
    assert.equal(page.doc.body.getAttribute("data-viewer"), null);
    assert.equal(page.engines.length, 0);
  });
});

test("an open viewer ignores a second open", () => {
  const page = makePage();
  const diagram = makeDiagram("0 0 800 400");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    diagram.pre.children[0].children[0].fire("click");
    page.view.openFor(diagram.pre);
  });

  assert.equal(page.view.isOpen(), true);
  assert.equal(page.doc.body.children.length, 1);
  assert.equal(page.engines.length, 1);
});

test("an element no provider matches does not open the viewer", () => {
  const page = makePage();

  withGlobals({ document: page.doc }, function () {
    assert.equal(page.view.openFor(createFakeElement("pre")), null);
    assert.equal(page.view.openFor(null), null);
  });

  assert.equal(page.view.isOpen(), false);
  assert.equal(page.doc.body.children.length, 0);
});

test("a clone without a usable viewBox keeps the engine at scale 1", () => {
  const page = makePage();
  const diagram = makeDiagram("not four numbers");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([diagram.pre]);
    diagram.pre.children[0].children[0].fire("click");
  });

  assert.equal(page.view.isOpen(), true);
  const clone = partsOf(page).stage.children[0].children[0];
  assert.equal(clone.getAttribute("width"), null);
  assert.equal(clone.getAttribute("height"), null);
  assert.equal(page.engines[0].initial.scale, 1);
});

test("a provider's extra actions ride the same engine", () => {
  const page = makePage();
  const runWith = [];
  Viewer.registerProvider({
    type: "test-extra",
    matches: function (element) {
      return element.tagName === "CUSTOM";
    },
    hoverLabel: "Open custom content",
    title: function () {
      return "Custom";
    },
    mount: function () {
      return page.doc.createElement("div");
    },
    extraActions: function () {
      return [
        {
          id: "spin",
          label: "Spin the picture",
          icon: "M12 12h1",
          run: function (engine) {
            runWith.push(engine);
          },
        },
      ];
    },
  });

  const custom = createFakeElement("custom");
  withGlobals({ document: page.doc }, function () {
    assert.equal(page.view.armHover([custom]), 1);
    const trigger = custom.children[0].children[0];
    assert.equal(trigger.getAttribute("aria-label"), "Open custom content");
    trigger.fire("click");

    const actions = partsOf(page).actions;
    assert.equal(actions.children.length, 5);
    assert.equal(
      actions.children[4].getAttribute("aria-label"),
      "Spin the picture",
    );
    actions.children[4].fire("click");
    assert.deepEqual(runWith, [page.engines[0].engine]);

    page.view.close();
    assert.equal(page.doc.body.children.length, 0);
  });
  // The extra provider stays registered: it matches CUSTOM elements only,
  // so it cannot shadow the diagram provider, and the registry has no way
  // to restore the built-in one a reset would take away.
});

test("a provider may carry the close button alone, and close always stays", () => {
  const page = makePage();
  const block = createFakeElement("div");
  block.className = "plain-block";
  Viewer.registerProvider({
    type: "test-plain",
    matches: function (element) {
      return element.classList.contains("plain-block");
    },
    title: function () {
      return "Plain";
    },
    standardActions: function () {
      return false;
    },
    mount: function () {
      return page.doc.createElement("div");
    },
  });

  withGlobals({ document: page.doc }, function () {
    page.view.openFor(block);

    const parts = partsOf(page);
    assert.deepEqual(
      Array.prototype.map.call(parts.actions.children, function (button) {
        return button.getAttribute("aria-label");
      }),
      ["Close viewer"],
    );

    // The close is the viewer's own gesture: the focus starts on it and
    // the window goes away with it, whatever the provider answered.
    assert.equal(parts.actions.children[0].focused, true);
    parts.actions.children[0].fire("click");
    assert.equal(page.view.isOpen(), false);
    assert.equal(page.doc.body.children.length, 0);
  });
});
