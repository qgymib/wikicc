/**
 * The content viewer: the hover toolbar on a rendered block, and the lightbox
 * that opens from it.
 *
 * Two halves live here. `armHover` hangs the open-in-viewer toolbar on every
 * element a provider can show; it runs after each render, because restoring a
 * diagram to its source goes through `textContent` and takes an earlier
 * toolbar with it — rebuilding on every render is the only safe shape, and a
 * cheap one at diagram counts a document has. `openFor` mounts the lightbox:
 * a backdrop over the page, a centered window whose header carries the
 * standard actions plus whatever the provider adds, and a stage where the
 * provider's clone lands. The transform engine moves the clone; panzoom is
 * the default engine, and a caller — or a test — hands a different one in
 * through `createViewerView`.
 *
 * Opening is measured, not assumed: the backdrop is shown first, the content
 * is measured on the live stage, and the engine starts at the scale that
 * fits the picture with the FIT_PORTION margin. `startScale`/`startX`/
 * `startY` carry that fit into the engine, so reset returns the picture to
 * exactly the state the reader opened — not to a bare identity transform
 * that would leave a wide diagram cropped.
 *
 * Opening remembers how it was driven and where the focus came from, so
 * closing can hand the focus back: the toolbar's button after a keyboard
 * session, the block itself after a pointer one — a button focus the
 * pointer did not earn would keep the frame lit and the button highlighted
 * with nothing for the reader to clear it with. The scroll locks through
 * one body attribute the stylesheet answers to. Escape is taken on the
 * capture phase while the viewer is up: the topmost surface answers first,
 * ahead of the search dialog and the drawer.
 *
 * The mermaid provider is registered here, beside the view that hosts it: it
 * clones the rendered SVG — with its baked theme colours and its internal
 * styles — so closing the viewer leaves the document's own picture exactly
 * as it was.
 */

// The package's `main` field points at a UMD build and it declares no
// `exports` map, so a bare specifier cannot be imported: node resolves the
// UMD file, which offers no default export, and the `node --test` suite
// fails before any test runs. The ESM build behind the `module` field is
// what the bundler would pick anyway; naming it keeps both consumers — the
// bundle and the tests — on the same file.
import Panzoom from "@panzoom/panzoom/dist/panzoom.es.js";

import * as Diagrams from "./diagrams.js";
import * as Viewer from "./viewer.js";

/** Zoom bounds the engine is given; the fitted start scale is clamped in. */
var MIN_SCALE = 0.05;
var MAX_SCALE = 8;

/** Animation speed of the engine's zoom buttons, in milliseconds. */
var TRANSITION_MS = 160;

/** SVG namespace the icons are built in, as the page's own markup uses. */
var SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The expand icon of the hover button, in the 24-unit box. */
var OPEN_ICON = "M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5";

/**
 * The built-in provider for rendered diagrams.
 *
 * `matches` looks at what the renderer leaves behind — the block's class and
 * the `data-processed` marker — rather than at the engine, so the registry
 * stays decoupled from mermaid. A clone, not the original, travels to the
 * stage: mermaid caps its picture with an inline `max-width`, which the
 * stylesheet overrides on the viewer's content and which the clone drops
 * anyway; the viewBox then becomes explicit width and height, the natural
 * size the fit and the engine need. The id stays: the engine's generated
 * styles inside the SVG may scope themselves by it.
 */
var diagramProvider = {
  type: "mermaid",
  matches: function (element) {
    return (
      Boolean(element) &&
      Boolean(element.classList) &&
      typeof element.classList.contains === "function" &&
      element.classList.contains(Diagrams.CLASS) &&
      element.getAttribute("data-processed") === "true"
    );
  },
  hoverLabel: "Open diagram in viewer",
  title: function () {
    return "Diagram";
  },
  mount: function (element) {
    var svg = element.querySelector("svg");
    if (!svg || typeof svg.cloneNode !== "function") {
      return null;
    }
    var clone = svg.cloneNode(true);
    clone.removeAttribute("style");
    applyNaturalSize(clone);
    var content = document.createElement("div");
    content.className = Viewer.CONTENT_CLASS;
    content.appendChild(clone);
    return content;
  },
};

Viewer.registerProvider(diagramProvider);

/**
 * Give a cloned SVG its natural size.
 *
 * mermaid draws with a viewBox and no width or height, sizing itself against
 * its container through the stylesheet; on the stage that container is the
 * content element, and the picture must report the size the diagram engine
 * laid out rather than whatever the flex stage stretches it to. The viewBox
 * is exactly that layout, in user units that mermaid keeps at one per pixel.
 */
function applyNaturalSize(svg) {
  var viewBox = svg.getAttribute && svg.getAttribute("viewBox");
  if (typeof viewBox !== "string") {
    return;
  }
  var units = viewBox.split(/[\s,]+/).map(Number);
  if (
    units.length !== 4 ||
    units.some(function (unit) {
      return !Number.isFinite(unit);
    })
  ) {
    return;
  }
  svg.setAttribute("width", String(units[2]));
  svg.setAttribute("height", String(units[3]));
}

/** Whether the current theme motion should be reduced. */
function prefersReducedMotion() {
  return (
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The default transform engine: panzoom over the content element. */
function defaultCreateTransform(content, initial) {
  return Panzoom(content, {
    animate: !prefersReducedMotion(),
    duration: TRANSITION_MS,
    easing: "ease-in-out",
    startScale: initial.scale,
    startX: initial.x,
    startY: initial.y,
    minScale: MIN_SCALE,
    maxScale: MAX_SCALE,
    // The stage is the canvas: a drag anywhere on it moves the picture,
    // not only a drag that starts on the picture itself.
    canvas: true,
  });
}

/**
 * One wheel notch on the stage, anchored at the cursor.
 *
 * panzoom's own wheel handler cannot be used as-is: its focal arithmetic
 * assumes the transformed element rests against the top-left of its parent,
 * while the stage centres the picture with flexbox — handing the event over
 * anchors the zoom half a box of slack away from the cursor, which the
 * headless repro measured at tens of pixels. The pure `wheelZoom` derives
 * the anchor from the live rect and the engine's own state instead. A notch
 * it cannot anchor — no geometry, no state to read — leaves the engine
 * untouched, and a cursor the event does not carry degrades to a centre
 * zoom.
 */
function wheelToScale(content, engine, event) {
  if (typeof event.preventDefault === "function") {
    event.preventDefault();
  }
  var options =
    typeof engine.getOptions === "function" ? engine.getOptions() : null;
  var move = Viewer.wheelZoom(
    {
      rect:
        content && typeof content.getBoundingClientRect === "function"
          ? content.getBoundingClientRect()
          : null,
      pan: typeof engine.getPan === "function" ? engine.getPan() : null,
      scale: typeof engine.getScale === "function" ? engine.getScale() : null,
      step: options && Number.isFinite(options.step) ? options.step : undefined,
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
    },
    event,
  );
  if (!move) {
    return;
  }
  engine.zoom(move.scale, {
    animate: false,
    force: true,
    focal: move.focal || undefined,
  });
}

/**
 * Build one viewer, with its transform engine injectable.
 *
 * The page uses the module-level `viewerView` below; a test hands a
 * recording engine in through `options.createTransform`, and every other
 * path — the arming, the mounting, the actions, the focus — runs the shipped
 * code either way.
 */
export function createViewerView(options) {
  var createTransform =
    options && typeof options.createTransform === "function"
      ? options.createTransform
      : defaultCreateTransform;

  /** The open viewer's state, or null while it is closed. */
  var active = null;

  /**
   * Escape belongs to the topmost surface. The viewer registers this on the
   * capture phase while it is open, so a press that would close the search
   * dialog or the drawer closes the viewer instead — and only the viewer,
   * since the event stops here.
   */
  function onKeyDown(event) {
    if (!active || !event || event.key !== "Escape") {
      return;
    }
    if (typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
    close();
  }

  /** A press on the backdrop — not on the window it carries — puts it away. */
  function onBackdropClick(event) {
    if (!active) {
      return;
    }
    var target = event && event.target;
    if (target === active.backdrop) {
      close();
    }
  }

  /**
   * Hang the hover toolbar on every element a provider can show.
   *
   * Answers how many were armed. A fresh toolbar every call is deliberate:
   * the render that preceded this call may have restored the block's source
   * text, and that replacement takes any earlier toolbar with it.
   */
  function armHover(nodes) {
    if (!nodes || typeof nodes.length !== "number") {
      return 0;
    }
    var armed = 0;
    for (var index = 0; index < nodes.length; index += 1) {
      if (armOne(nodes[index])) {
        armed += 1;
      }
    }
    return armed;
  }

  /** Arm one element: a corner toolbar whose button opens the viewer. */
  function armOne(element) {
    if (!element || typeof element.appendChild !== "function") {
      return false;
    }
    var provider = Viewer.providerFor(element);
    if (!provider) {
      return false;
    }
    removeExistingToolbar(element);

    // A mouse-driven session hands the focus back to the block itself on
    // close, so the block must be able to take it: focusable without
    // joining the tab order, and carrying no focus indicator of its own —
    // the stylesheet answers to the host class for that.
    element.setAttribute("tabindex", "-1");
    element.classList.add(Viewer.HOST_CLASS);

    var toolbar = document.createElement("div");
    toolbar.className = Viewer.HOVER_TOOLBAR_CLASS;
    toolbar.appendChild(makeOpenButton(provider, element));
    element.appendChild(toolbar);
    return true;
  }

  /** Take an earlier toolbar off, so re-arming never stacks them. */
  function removeExistingToolbar(element) {
    var children = element.children || [];
    for (var index = children.length - 1; index >= 0; index -= 1) {
      var child = children[index];
      var classes = String(child && child.className);
      if (classes.split(" ").indexOf(Viewer.HOVER_TOOLBAR_CLASS) !== -1) {
        element.removeChild(child);
      }
    }
  }

  /** The corner button of one armed block. */
  function makeOpenButton(provider, element) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button " + Viewer.OPEN_BUTTON_CLASS;
    var label = provider.hoverLabel || "Open in viewer";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    var icon = makeIcon(OPEN_ICON);
    if (icon) {
      button.appendChild(icon);
    }
    button.addEventListener("click", function (event) {
      openFor(element, event);
    });
    return button;
  }

  /**
   * Open the viewer for `element`, or answer null when nothing opens.
   *
   * The provider is looked up again at open time: the toolbar was armed at
   * render time, and between the two the block may have been replaced by a
   * navigation. One viewer at a time — an open call while one is up does
   * nothing. A provider whose mount yields nothing leaves the page exactly
   * as it was; the viewer is an enhancement, and must never break a page
   * because one clone could not be made.
   *
   * `event` is the click that opened the viewer, when it came from the
   * toolbar's button. Its `detail` tells the two ways a reader opens this:
   * a pointer press answers 1 or more, a keyboard Enter answers 0. The
   * session remembers which it was, because the browser cannot later tell
   * a pointer reader who pressed Escape from a keyboard reader — and where
   * the focus goes on close depends on exactly that.
   */
  function openFor(element, event) {
    if (active) {
      return null;
    }
    var provider = Viewer.providerFor(element);
    if (!provider) {
      return null;
    }

    var mouseDriven = Boolean(event) && Number(event.detail) > 0;
    var trigger = document.activeElement || null;
    var lightbox = buildLightbox(provider, element);
    var content = provider.mount(element);
    if (!content) {
      return null;
    }
    lightbox.stage.appendChild(content);

    document.body.appendChild(lightbox.backdrop);
    document.body.setAttribute(Viewer.OPEN_ATTRIBUTE, Viewer.OPEN_VALUE);

    var initial = fitToStage(lightbox.stage, content);
    var engine = createTransform(content, initial);

    active = {
      backdrop: lightbox.backdrop,
      engine: engine,
      trigger: trigger,
      container: element,
      mouseDriven: mouseDriven,
    };

    lightbox.backdrop.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onKeyDown, true);
    if (
      typeof lightbox.stage.addEventListener === "function" &&
      typeof engine.zoom === "function"
    ) {
      lightbox.stage.addEventListener("wheel", function (event) {
        wheelToScale(content, engine, event);
      });
    }
    if (
      lightbox.closeButton &&
      typeof lightbox.closeButton.focus === "function"
    ) {
      lightbox.closeButton.focus();
    }
    return active;
  }

  /** The backdrop, the window, the stage and the button focus starts on. */
  function buildLightbox(provider, element) {
    var backdrop = document.createElement("div");
    backdrop.className = Viewer.BACKDROP_CLASS;

    var frame = document.createElement("div");
    frame.className = Viewer.WINDOW_CLASS;
    frame.setAttribute("role", "dialog");
    frame.setAttribute("aria-modal", "true");
    var title = provider.title ? provider.title(element) : "";
    if (title) {
      frame.setAttribute("aria-label", title);
    }

    var header = document.createElement("div");
    header.className = Viewer.HEADER_CLASS;
    var heading = document.createElement("h2");
    heading.className = Viewer.TITLE_CLASS;
    heading.textContent = title || "";
    var actions = document.createElement("div");
    actions.className = Viewer.ACTIONS_CLASS;
    header.appendChild(heading);
    header.appendChild(actions);

    var stage = document.createElement("div");
    stage.className = Viewer.STAGE_CLASS;

    frame.appendChild(header);
    frame.appendChild(stage);
    backdrop.appendChild(frame);

    var closeButton = buildActions(actions, provider);
    return {
      backdrop: backdrop,
      frame: frame,
      stage: stage,
      closeButton: closeButton,
    };
  }

  /** The standard actions, then the provider's extras, if it has any. */
  function buildActions(actions, provider) {
    var closeButton = null;
    Viewer.STANDARD_ACTIONS.forEach(function (action) {
      var button = makeActionButton(
        action.label,
        action.icon,
        standardAction(action.id),
      );
      if (action.id === "close") {
        closeButton = button;
      }
      actions.appendChild(button);
    });
    if (provider && typeof provider.extraActions === "function") {
      provider.extraActions().forEach(function (extra) {
        actions.appendChild(
          makeActionButton(extra.label, extra.icon, function () {
            if (active && typeof extra.run === "function") {
              extra.run(active.engine);
            }
          }),
        );
      });
    }
    return closeButton;
  }

  /** The gesture one standard action performs on the live engine. */
  function standardAction(id) {
    if (id === "zoom-in") {
      return function () {
        if (active) {
          active.engine.zoomIn();
        }
      };
    }
    if (id === "zoom-out") {
      return function () {
        if (active) {
          active.engine.zoomOut();
        }
      };
    }
    if (id === "reset") {
      return function () {
        if (active) {
          active.engine.reset();
        }
      };
    }
    return function () {
      close();
    };
  }

  /** One labelled icon button of the window's header. */
  function makeActionButton(label, iconPath, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button " + Viewer.ACTION_BUTTON_CLASS;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    var icon = makeIcon(iconPath);
    if (icon) {
      button.appendChild(icon);
    }
    if (onClick) {
      button.addEventListener("click", onClick);
    }
    return button;
  }

  /** One stroke icon in the site's 24-unit box. */
  function makeIcon(pathData) {
    if (typeof document.createElementNS !== "function") {
      return null;
    }
    var svg = document.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }

  /** The transform the picture starts at: fitted, and centered. */
  function fitToStage(stage, content) {
    var contentBox =
      typeof content.getBoundingClientRect === "function"
        ? content.getBoundingClientRect()
        : null;
    var scale = Viewer.fitScale(
      stage.clientWidth,
      stage.clientHeight,
      contentBox && contentBox.width,
      contentBox && contentBox.height,
      Viewer.FIT_PORTION,
    );
    return {
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)),
      x: 0,
      y: 0,
    };
  }

  /** Whether the viewer is showing. */
  function isOpen() {
    return active !== null;
  }

  /**
   * Put the viewer away: the engine's listeners go with it, the body
   * attribute releases the scroll, and the focus returns to where the
   * session came from — the toolbar's button when the reader opened the
   * viewer from the keyboard, the diagram block itself when they opened it
   * with the pointer — if it is still in the document.
   */
  function close() {
    if (!active) {
      return;
    }
    var current = active;
    active = null;

    document.removeEventListener("keydown", onKeyDown, true);
    if (current.engine && typeof current.engine.destroy === "function") {
      current.engine.destroy();
    }
    if (current.backdrop.parentNode) {
      current.backdrop.parentNode.removeChild(current.backdrop);
    }
    document.body.removeAttribute(Viewer.OPEN_ATTRIBUTE);
    restoreFocus(current);
  }

  /**
   * Give the focus back to where the session came from, if it can still
   * take it.
   *
   * A pointer session returns the focus to the block itself: the button
   * would keep a visible focus indicator no pointer gesture can clear —
   * the lit frame and the highlighted button the Escape press left behind.
   * The block holds the focus quietly instead, so the reader's place is
   * not lost and nothing on the page stays lit. A keyboard session returns
   * the focus to the button, whose indicator is then the reader's only
   * landmark — the dialog pattern's own gesture.
   */
  function restoreFocus(session) {
    var target = session.mouseDriven ? session.container : session.trigger;
    if (!target || typeof target.focus !== "function") {
      return;
    }
    if (typeof document.contains === "function" && !document.contains(target)) {
      return;
    }
    target.focus();
  }

  return {
    armHover: armHover,
    openFor: openFor,
    close: close,
    isOpen: isOpen,
  };
}

/**
 * The viewer the page uses: one instance, the default engine, the registry
 * every provider contributes to. `diagram-view.js` arms its hover toolbars
 * through this instance once a render has finished.
 */
export var viewerView = createViewerView();
