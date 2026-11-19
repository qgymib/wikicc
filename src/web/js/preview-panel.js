/**
 * The frame the hover preview shows in: one popover, built once, placed
 * beside the link it describes, kept inside the viewport.
 *
 * This module owns the panel's bones and its geometry and nothing else. The
 * skeleton is built up front — head, the content states' standing nodes, the
 * scrolling body and the resize handles — so showing a state writes text into
 * nodes that already exist: a hover never grows the panel and never reflows
 * it, and no state can leave a mark on the one that replaced it. What the
 * states fill in is `preview-roles.js`'s business; when the frame opens,
 * moves or is held is `preview-gestures.js`'s. Both reach this module through
 * the composer (`preview-view.js`), which hands each the handles and the
 * callbacks it needs, so nothing here knows a role by name.
 *
 * The panel is appended to `document.body` and positioned with `position:
 * fixed`, the same way the table filter panel works: the document body clips
 * overflow in places, and a panel nested inside it would be cut off. Only one
 * panel exists at a time, so every document the reader opens shares it: a
 * document change does not dispose of it, and a pinned panel therefore
 * survives one untouched.
 *
 * Building the panel must never fail: it is built lazily inside the open
 * timer, so an exception here does not surface as an error a reader can see —
 * it surfaces as *nothing happening*, which is the hardest failure to
 * diagnose. Every node the panel owns is therefore created the way the DOM
 * requires: an SVG child comes from `document.createElementNS` and is appended
 * to its parent, because an `SVGElement` carries no `createElementNS` of its
 * own.
 *
 * A placement decides where the frame sits and how tall it may be, never what
 * it shows. Below the link by default; above it when there is no room, which
 * is the common case for a link near the bottom of a long paragraph. When
 * neither side holds the whole panel — a link near the middle of a short
 * window — the panel lays itself on the roomier side and shrinks to the space
 * there, so the link it describes stays on screen beside it rather than under
 * it.
 *
 * Every placement writes the same invariant with a `max-height`: the panel
 * never crosses the link it describes. The height was measured a moment ago
 * and the layout may disagree later — a late font, a table's controls,
 * anything the panel gains after this read — so each branch caps the panel at
 * the space its own placement leaves, and content that grows after the
 * measurement scrolls inside the body instead of pushing the bottom edge over
 * the link.
 *
 * Pinned means *held in place*, not *following*: the panel is positioned once,
 * against the link it describes, and `position: fixed` does not move with the
 * document. Re-anchoring it on scroll or on a navigation would either drag it
 * away from the chapter it shows or park it at a paragraph the reader is no
 * longer looking at, so the panel stays where the reader put it instead. A
 * panel the reader moved or resized is theirs: `position` leaves it alone
 * until the showing ends, and the place and the size are forgotten with it.
 *
 * The wheel over the panel belongs to the panel. The scrollable body consumes
 * its own wheel, and `overscroll-behavior` keeps a delta it cannot take — past
 * either end of the chapter, or when the chapter fits — from chaining to the
 * article behind the panel. But every other part of the panel owns no
 * scroller at all, so there the browser's default action would reach the
 * article itself: the reader scrolling over the head or a notice would find
 * the document moving under their hand. Only a wheel aimed at the body keeps
 * its default; everywhere else the event is answered with nothing.
 */

/**
 * Namespace of the inline icons in the panel's head.
 *
 * An SVG child must be created in this namespace by `document`; the icons are
 * drawn inline so the page loads no asset and no icon font.
 */
var SVG_NAMESPACE = "http://www.w3.org/2000/svg";

import { t } from "./i18n.js";

/** Smallest distance from the viewport edge the panel keeps. */
export var MARGIN_PX = 10;

/** Gap between the link and the panel, in pixels. */
export var GAP_PX = 8;

/**
 * Shortest height the panel keeps when no side of the viewport can hold it.
 *
 * A link near the middle of a short window leaves the panel no side tall
 * enough for its whole self; the panel then lays itself on the roomier side
 * and shrinks to the space there. Below this floor a shrink would produce a
 * sliver no reader could use, so the panel keeps this height instead — a
 * window that cramped is the one case where covering the link is accepted,
 * because a panel too small to read helps nobody.
 */
var MIN_SHRUNK_HEIGHT_PX = 120;

/** Class of the popover root. */
export var POPOVER_CLASS = "preview-popover";

/** Class of the head, which is the handle the panel is dragged by. */
export var HEAD_CLASS = "preview-head";

/** Class of the scrolling body inside the popover. */
export var BODY_CLASS = "preview-scroll";

/** Attribute marking the popover as open, used by the stylesheet. */
export var OPEN_ATTRIBUTE = "data-open";

/** Accessible name of the popover while it shows a preview. */
export var PREVIEW_LABEL = "Chapter preview";

/** Class of the pin button in the head. */
export var PIN_CLASS = "preview-pin";

/** Class of the close button in the head. */
export var CLOSE_CLASS = "preview-close";

/** Class of the group holding the head's buttons, kept apart from the title. */
export var ACTIONS_CLASS = "preview-actions";

/** Accessible name of the head, which is what the reader grabs. */
export var DRAG_LABEL = "Drag to move";

/** Class of the three strips the panel is resized by. */
export var RESIZE_CLASS = "preview-resize";

/** Attribute naming the axis one strip resizes: `e`, `s` or `se`. */
export var RESIZE_DIRECTION_ATTRIBUTE = "data-dir";

/** The directions the handles resize, in the order the panel builds them. */
var RESIZE_DIRECTIONS = ["e", "s", "se"];

/** Class of the column holding the title and the path. */
export var HEAD_TEXT_CLASS = "preview-head-text";

/** Accessible name of the pin button while the panel is not pinned. */
export var PIN_LABEL = "Pin preview";

/** Accessible name of the pin button while the panel is pinned. */
export var UNPIN_LABEL = "Unpin preview";

/** Accessible name of the close button. */
export var CLOSE_LABEL = "Close preview";

/** Heading of a notice: what went wrong, in three words. */
export var MISSING_TITLE = "Chapter not found";

/** Text between the document and the chapter of a notice. */
export var MISSING_SEPARATOR = "No chapter named ";
/** Text after the chapter of a notice, once the document is named. */
export var MISSING_TAIL = " exists in this document.";

/** Class of the loading state shown while a document is on its way. */
export var LOADING_CLASS = "preview-loading";

/** Class of the loading state's one line of text. */
export var LOADING_TEXT_CLASS = "preview-loading-text";

/** Text of the loading state. */
export var LOADING_TEXT = "Loading…";

/** Class of the error state shown when a document fails to arrive. */
export var ERROR_CLASS = "preview-error";

/** Heading of the error state: what went wrong. */
export var ERROR_TITLE = "Preview failed to load.";

/** Text of the error state: what the reader can do about it. */
export var ERROR_TEXT =
  "The document did not arrive. Hover the link again to retry.";

/** Class of the locked state shown for a reference into a sealed document. */
export var LOCKED_CLASS = "preview-locked";

/** Heading of the locked state: what the reference points at. */
export var LOCKED_TITLE = "Chapter locked";

/** Text of the locked state: what the reader can do about it. */
export var LOCKED_TEXT =
  "This chapter is in an encrypted document. Enter its password to read it here.";

/** Class of the password form the locked state answers in place. */
export var UNLOCK_FORM_CLASS = "preview-unlock";

/** Class of the password field of that form. */
export var UNLOCK_INPUT_CLASS = "preview-unlock-input";

/** Accessible name of the password field. */
export var UNLOCK_INPUT_LABEL = "Document password";

/** Class of the button that submits the password. */
export var UNLOCK_SUBMIT_CLASS = "preview-unlock-submit";

/** Text of the unlock button while the panel is idle. */
export var UNLOCK_SUBMIT_TEXT = "Unlock";

/** Class of the line that reports a password that did not open the document. */
export var UNLOCK_ERROR_CLASS = "preview-unlock-error";

/** Text of that line, offered again whatever the next try answers. */
export var UNLOCK_ERROR_TEXT =
  "That password did not unlock this document. Try again.";

/**
 * The dictionary keys the panel's copy resolves through.
 *
 * The exported constants above are the English text the tests import; the
 * panel itself resolves every slot through the dictionaries at the moment
 * it builds the DOM, so a site built in another language renders that
 * language's words.
 */
var COPY_KEYS = {
  panelLabel: "preview.panelLabel",
  drag: "preview.drag",
  pin: "preview.pin",
  unpin: "preview.unpin",
  close: "preview.close",
  missingTitle: "preview.missingTitle",
  missingSeparator: "preview.missingSeparator",
  missingTail: "preview.missingTail",
  loading: "preview.loading",
  errorTitle: "preview.errorTitle",
  errorText: "preview.errorText",
  lockedTitle: "preview.lockedTitle",
  lockedText: "preview.lockedText",
  unlockInputLabel: "preview.unlockInputLabel",
  unlockSubmit: "preview.unlockSubmit",
  unlockError: "preview.unlockError",
};

/**
 * Build one preview panel and hand back its frame and geometry.
 *
 * The `handlers` are the decisions the frame cannot make on its own, wired in
 * by the composer: what a qualifying press, a click or a form answer means.
 * The chrome checks — a press on a head button is not a handle press, a click
 * on one is not a claim — stay here, because only the frame knows which
 * elements are its own buttons.
 */
export function createPreviewPanel(handlers) {
  var panel = null;
  var head = null;
  var body = null;
  var title = null;
  var path = null;
  // The notice is part of the panel from the start, hidden behind
  // `MISSING_ATTRIBUTE`: showing it writes text into nodes that already exist,
  // so a hover never grows the panel and never reflows it.
  var notice = null;
  var noticeText = null;
  var noticeDoc = null;
  var noticeChapter = null;
  // The loading and error states are part of the panel from the start too, on
  // the same terms as the notice: the split format's first hover on a document
  // happens while its chunk is still travelling, and the states it turns
  // through must not grow or reflow the panel as they replace one another.
  var loading = null;
  var error = null;
  // The locked state and its form are part of the panel from the start too,
  // on the same terms as the notice: a reference into a sealed document
  // opens the panel with its password form, and the states the panel turns
  // through must not grow or reflow it as they replace one another.
  var locked = null;
  var unlockForm = null;
  var unlockInput = null;
  var unlockSubmit = null;
  var unlockError = null;
  // The head's two buttons, so their state can follow the pin without a query.
  var pinButton = null;
  var closeButton = null;
  // Whether this showing of the panel has been placed by hand. `position()`
  // leaves it alone from then on; the composer's close forgets it, so the
  // next hover is anchored to its own link again.
  var moved = false;
  // The three handles, each kept with the listener it was built with, because
  // `dispose` takes both off the page.
  var resizeHandles = [];
  // The listeners the frame attached to nodes it may outlive, for `dispose`.
  var headListener = null;
  var panelClickListener = null;

  /**
   * The page the panel floats over.
   *
   * Geometry reads the viewport from the window when there is one and falls
   * back to `globalThis` in a DOM without one, the same degradation every
   * listener in the preview relies on.
   */
  function view() {
    return globalThis;
  }

  /**
   * The page a gesture is watched on.
   *
   * A drag starts below the head and continues over the document, so the moves
   * are read from the window when there is one — which is what makes the panel
   * follow a pointer that has left it — and from `globalThis` in a DOM without
   * one, the same degradation every other listener here relies on.
   */
  function windowTarget() {
    return typeof window === "undefined" ? view() : window;
  }

  /** Build the empty popover once, on first use. */
  function ensurePanel() {
    if (panel) {
      return panel;
    }

    panel = document.createElement("div");
    panel.className = POPOVER_CLASS;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t(COPY_KEYS.panelLabel));
    panel.hidden = true;

    // The head is also the handle: it says so, and it is where a drag starts.
    head = document.createElement("div");
    head.className = HEAD_CLASS;
    head.setAttribute("title", t(COPY_KEYS.drag));
    headListener = function (event) {
      // A press on one of the head's buttons is never a handle press, since
      // those two clicks already mean something else; a widget inside a
      // preview is not a handle either. Everything else is the gesture's.
      if (!event || event.button) {
        return;
      }

      var target = event.target;
      if (target === pinButton || target === closeButton) {
        return;
      }
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest("button")
      ) {
        return;
      }

      handlers.onHeadPress(event);
    };
    head.addEventListener("pointerdown", headListener);

    // The head is two columns: the chapter's name, which may be long and is
    // therefore the one allowed to shrink, and the buttons, which must not.
    var headText = document.createElement("div");
    headText.className = HEAD_TEXT_CLASS;

    title = document.createElement("p");
    title.className = "preview-title";

    path = document.createElement("p");
    path.className = "preview-path";

    headText.appendChild(title);
    headText.appendChild(path);

    var actions = document.createElement("div");
    actions.className = ACTIONS_CLASS;

    pinButton = iconButton("pin", PIN_CLASS, t(COPY_KEYS.pin), pinSvg);
    pinButton.setAttribute("aria-pressed", "false");
    pinButton.addEventListener("click", function (event) {
      handlers.onPinClick(event);
    });

    // The reader already holds this panel when they reach for its buttons, so a
    // close here must not be read as "a click inside the panel" and pin it.
    closeButton = iconButton(
      "close",
      CLOSE_CLASS,
      t(COPY_KEYS.close),
      closeSvg,
    );
    closeButton.addEventListener("click", function (event) {
      handlers.onCloseClick(event);
    });

    actions.appendChild(pinButton);
    actions.appendChild(closeButton);

    head.appendChild(headText);
    head.appendChild(actions);

    // The notice: a heading and one sentence. The document and the chapter are
    // their own `<code>` elements filled with `textContent`, because a path and
    // a heading may both contain markup characters and are shown as written.
    notice = document.createElement("div");
    notice.className = "preview-missing";

    var noticeTitle = document.createElement("p");
    noticeTitle.className = "preview-missing-title";
    noticeTitle.textContent = t(COPY_KEYS.missingTitle);

    noticeText = document.createElement("p");
    noticeText.className = "preview-missing-text";

    noticeDoc = document.createElement("code");
    noticeDoc.className = "preview-missing-code";

    noticeChapter = document.createElement("code");
    noticeChapter.className = "preview-missing-code";

    noticeText.appendChild(
      document.createTextNode(t(COPY_KEYS.missingSeparator)),
    );
    noticeText.appendChild(noticeChapter);
    noticeText.appendChild(document.createTextNode(t(COPY_KEYS.missingTail)));
    noticeText.appendChild(noticeDoc);

    notice.appendChild(noticeTitle);
    notice.appendChild(noticeText);

    // The loading state: the spinner is the stylesheet's, drawn on the
    // element's own `::before`, so the panel loads nothing and animates
    // nothing until a document is actually on its way.
    loading = document.createElement("div");
    loading.className = LOADING_CLASS;

    var loadingText = document.createElement("p");
    loadingText.className = LOADING_TEXT_CLASS;
    loadingText.textContent = t(COPY_KEYS.loading);
    loading.appendChild(loadingText);

    // The error state: a heading and one sentence, the notice's shape again.
    // The document's name stays in the head, where the loading state left it.
    error = document.createElement("div");
    error.className = ERROR_CLASS;

    var errorTitle = document.createElement("p");
    errorTitle.className = "preview-error-title";
    errorTitle.textContent = t(COPY_KEYS.errorTitle);

    var errorText = document.createElement("p");
    errorText.className = "preview-error-text";
    errorText.textContent = t(COPY_KEYS.errorText);

    error.appendChild(errorTitle);
    error.appendChild(errorText);

    // The locked state: a heading, one sentence and the form the reader
    // answers in place. The error line is hidden until an attempt fails and
    // clears itself the moment the reader types again.
    locked = document.createElement("div");
    locked.className = LOCKED_CLASS;

    var lockedTitle = document.createElement("p");
    lockedTitle.className = "preview-locked-title";
    lockedTitle.textContent = t(COPY_KEYS.lockedTitle);

    var lockedText = document.createElement("p");
    lockedText.className = "preview-locked-text";
    lockedText.textContent = t(COPY_KEYS.lockedText);

    unlockForm = document.createElement("form");
    unlockForm.className = UNLOCK_FORM_CLASS;
    unlockForm.addEventListener("submit", function (event) {
      handlers.onUnlockSubmit(event);
    });

    unlockInput = document.createElement("input");
    unlockInput.className = UNLOCK_INPUT_CLASS;
    unlockInput.setAttribute("type", "password");
    unlockInput.setAttribute("aria-label", t(COPY_KEYS.unlockInputLabel));
    unlockInput.setAttribute("autocomplete", "off");
    unlockInput.addEventListener("input", function () {
      handlers.onUnlockInput();
    });

    unlockSubmit = document.createElement("button");
    unlockSubmit.className = UNLOCK_SUBMIT_CLASS;
    unlockSubmit.setAttribute("type", "submit");
    unlockSubmit.textContent = t(COPY_KEYS.unlockSubmit);

    unlockForm.appendChild(unlockInput);
    unlockForm.appendChild(unlockSubmit);

    unlockError = document.createElement("p");
    unlockError.className = UNLOCK_ERROR_CLASS;
    unlockError.setAttribute("role", "alert");
    unlockError.textContent = t(COPY_KEYS.unlockError);
    unlockError.hidden = true;

    locked.appendChild(lockedTitle);
    locked.appendChild(lockedText);
    locked.appendChild(unlockForm);
    locked.appendChild(unlockError);

    body = document.createElement("div");
    body.className = BODY_CLASS;

    panel.appendChild(head);
    panel.appendChild(notice);
    panel.appendChild(loading);
    panel.appendChild(error);
    panel.appendChild(locked);
    panel.appendChild(body);
    // The handles go on last: they are absolutely positioned strips over the
    // panel's own edges and must paint above the body's content, or the edge
    // of a wide table would take the grip away.
    RESIZE_DIRECTIONS.forEach(function (direction) {
      panel.appendChild(resizeHandle(direction));
    });
    document.body.appendChild(panel);

    // Entering the panel cancels a pending close; leaving it starts one.
    panel.addEventListener("pointerenter", function () {
      handlers.onEnterPanel();
    });
    panel.addEventListener("pointerleave", function () {
      handlers.onLeavePanel();
    });

    // The wheel over the panel belongs to the panel: scrolling the chapter in
    // the body must never move the article behind it, and over the head or a
    // notice — where nothing in the panel scrolls — the browser's default
    // action would reach the article itself. Non-passive, because the answer
    // to those events is preventDefault.
    panel.addEventListener("wheel", onPanelWheel, { passive: false });

    // Reading the panel is reaching for it: a click anywhere inside it says the
    // reader wants this chapter at hand, and the delays stop applying. The
    // head's buttons keep their own meaning — a close is not a claim.
    panelClickListener = function (event) {
      var target = event && event.target;
      if (!target || target === pinButton || target === closeButton) {
        return;
      }

      handlers.onClaim();
    };
    panel.addEventListener("click", panelClickListener);

    return panel;
  }

  /** A head button: an icon, a name and the button semantics it needs. */
  function iconButton(kind, className, label, draw) {
    var button = document.createElement("button");
    button.className = className;
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("data-icon", kind);
    button.appendChild(draw());

    return button;
  }

  /**
   * Create a node in the SVG namespace.
   *
   * `createElementNS` belongs to `document` alone: an `SVGElement` does not
   * carry it, so asking the element to create its own children throws
   * `createElementNS is not a function` and takes the whole panel down with it.
   * Every SVG node is therefore built by the document and appended to its
   * parent. The fallback keeps a DOM without `createElementNS` working, the
   * same way the panel itself degrades.
   */
  function svgNode(name) {
    var node = document.createElementNS
      ? document.createElementNS(SVG_NAMESPACE, name)
      : document.createElement(name);

    return node;
  }

  /** A button's drawing surface. */
  function svgRoot() {
    var svg = svgNode("svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");

    return svg;
  }

  /** One stroke of a button's drawing, appended to its `svg`. */
  function svgPath(parent, data) {
    var element = svgNode("path");
    element.setAttribute("d", data);
    parent.appendChild(element);

    return element;
  }

  /** The pin: a head and a needle, drawn inline so the page loads nothing. */
  function pinSvg() {
    var svg = svgRoot();
    svgPath(svg, "M9 4h6");
    svgPath(svg, "M10 4v6l-2.5 3h9L14 10V4");
    svgPath(svg, "M12 13v7");

    return svg;
  }

  /** The cross that closes the panel. */
  function closeSvg() {
    var svg = svgRoot();
    svgPath(svg, "M6 6l12 12");
    svgPath(svg, "M18 6 6 18");

    return svg;
  }

  /**
   * Place the panel next to `link` and keep it inside the viewport.
   *
   * Below the link by default; above it when there is no room, which is the
   * common case for a link near the bottom of a long paragraph. When neither
   * side holds the whole panel — a link near the middle of a short window —
   * the panel lays itself on the roomier side and shrinks to the space there,
   * so the link it describes stays on screen beside it rather than under it.
   *
   * Every placement writes the same invariant with a `max-height`: the panel
   * never crosses the link it describes. The height was measured a moment
   * ago and the layout may disagree later — a late font, a table's controls,
   * anything the panel gains after this read — so each branch caps the panel
   * at the space its own placement leaves, and content that grows after the
   * measurement scrolls inside the body instead of pushing the bottom edge
   * over the link.
   */
  function position(link) {
    // A panel the reader has moved is theirs: anchoring it again would undo
    // the one thing they did to it.
    if (moved) {
      return;
    }

    // Measure at the panel's natural height. A height a previous showing was
    // shrunk to belongs to that showing; this one decides afresh, and the
    // cleanup here is what keeps consecutive placings from compounding.
    panel.style.maxHeight = "";

    var rect = link.getBoundingClientRect();
    var width = panel.offsetWidth || 480;
    var height = panel.offsetHeight || 0;
    var viewportWidth =
      view().innerWidth || document.documentElement.clientWidth;
    var viewportHeight =
      view().innerHeight || document.documentElement.clientHeight;

    var below = rect.bottom + GAP_PX;
    var above = rect.top - GAP_PX - height;
    var top = below;
    if (height && below + height > viewportHeight - MARGIN_PX) {
      if (above >= MARGIN_PX) {
        top = above;
        // The panel fits above as measured; the cap below keeps it there if
        // it grows afterwards. It is the measured height exactly — a floor
        // would let the bottom edge cross the link, which is the one thing
        // this placement may never do.
        panel.style.maxHeight = Math.max(0, rect.top - GAP_PX - top) + "px";
      } else {
        // Neither side holds the whole panel. The old fallback pinned the
        // panel to the bottom edge, which could park it right over the link
        // the reader is pointing at. The panel takes the roomier side
        // instead and shrinks to the space there; the body scrolls, so the
        // chapter stays reachable at the reduced height.
        var roomBelow = viewportHeight - MARGIN_PX - below;
        var roomAbove = rect.top - GAP_PX - MARGIN_PX;
        if (roomAbove >= roomBelow) {
          top = MARGIN_PX;
          panel.style.maxHeight =
            Math.max(MIN_SHRUNK_HEIGHT_PX, roomAbove) + "px";
        } else {
          top = below;
          panel.style.maxHeight =
            Math.max(MIN_SHRUNK_HEIGHT_PX, roomBelow) + "px";
        }
      }
    }

    var left = Math.min(
      Math.max(MARGIN_PX, rect.left),
      Math.max(MARGIN_PX, viewportWidth - width - MARGIN_PX),
    );

    place(left, top);
  }

  /**
   * Write a position, keeping the whole panel in the viewport.
   *
   * A panel taller than the window is pinned to the top margin instead of
   * being pushed to a negative top: the range would otherwise be empty and the
   * panel would jump between two impossible corners.
   */
  function place(left, top) {
    var width = panel.offsetWidth || 0;
    var height = panel.offsetHeight || 0;
    var viewportWidth =
      view().innerWidth || document.documentElement.clientWidth;
    var viewportHeight =
      view().innerHeight || document.documentElement.clientHeight;

    panel.style.left =
      Math.round(clampPosition(left, width, viewportWidth)) + "px";
    panel.style.top =
      Math.round(clampPosition(top, height, viewportHeight)) + "px";
  }

  /** `value` kept inside `[MARGIN_PX, viewport - size - MARGIN_PX]`. */
  function clampPosition(value, size, viewport) {
    var limit = viewport - size - MARGIN_PX;
    if (limit < MARGIN_PX) {
      return MARGIN_PX;
    }

    return Math.min(Math.max(MARGIN_PX, value), limit);
  }

  /** Where the panel currently is, as the browser lays it out. */
  function panelOrigin() {
    var left = parseFloat(panel.style.left);
    var top = parseFloat(panel.style.top);
    var rect = panel.getBoundingClientRect
      ? panel.getBoundingClientRect()
      : null;

    return {
      left: Number.isNaN(left) ? (rect ? rect.left : 0) : left,
      top: Number.isNaN(top) ? (rect ? rect.top : 0) : top,
    };
  }

  /**
   * One handle: a strip the panel is resized by, wired to the direction it
   * was built for.
   *
   * The direction travels in a closure rather than being read back off the
   * element: a listener is invoked with `this` unset under a module and the
   * event's target is the handle only by convention, so the factory is what
   * keeps the wiring honest. Element and listener are kept on `resizeHandles`
   * together, because `dispose` takes both off the page.
   */
  function resizeHandle(direction) {
    var element = document.createElement("div");
    element.className = RESIZE_CLASS;
    element.setAttribute(RESIZE_DIRECTION_ATTRIBUTE, direction);

    var listener = function (event) {
      handlers.onResizePress(direction, event);
    };
    element.addEventListener("pointerdown", listener);

    resizeHandles.push({ element: element, listener: listener });

    return element;
  }

  /**
   * A wheel over the panel belongs to the panel.
   *
   * The scrollable body consumes its own wheel, and `overscroll-behavior`
   * keeps a delta it cannot take — past either end of the chapter, or when
   * the chapter fits — from chaining to the article behind the panel. But
   * every other part of the panel owns no scroller at all, so there the
   * browser's default action would reach the article itself: the reader
   * scrolling over the head or a notice would find the document moving
   * under their hand. Only a wheel aimed at the body keeps its default;
   * everywhere else the event is answered with nothing.
   */
  function onPanelWheel(event) {
    if (!event) {
      return;
    }

    var target = event.target;
    if (
      target &&
      typeof target.closest === "function" &&
      target.closest("." + BODY_CLASS)
    ) {
      return;
    }

    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  }

  /** Take the frame off the page and forget every node it built. */
  function dispose() {
    if (head && typeof head.removeEventListener === "function") {
      head.removeEventListener("pointerdown", headListener);
    }
    resizeHandles.forEach(function (handle) {
      if (
        handle.element &&
        typeof handle.element.removeEventListener === "function"
      ) {
        handle.element.removeEventListener("pointerdown", handle.listener);
      }
    });
    resizeHandles = [];
    if (panel && panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
    panel = null;
    head = null;
    body = null;
    title = null;
    path = null;
    notice = null;
    noticeText = null;
    noticeDoc = null;
    noticeChapter = null;
    loading = null;
    error = null;
    locked = null;
    unlockForm = null;
    unlockInput = null;
    unlockSubmit = null;
    unlockError = null;
    pinButton = null;
    closeButton = null;
    headListener = null;
    panelClickListener = null;
  }

  return {
    /** The page the panel floats over, for the viewport reads and timers. */
    view: view,
    /** The page a gesture is watched on, for the pointer listeners. */
    windowTarget: windowTarget,
    /** Build the frame once and put it on the page. */
    ensure: ensurePanel,
    /** Put the frame on screen for the link `position` then places it by. */
    present: function () {
      panel.hidden = false;
      panel.setAttribute(OPEN_ATTRIBUTE, "true");
    },
    /** Hide the frame and clear the open mark. */
    dismiss: function () {
      panel.hidden = true;
      panel.removeAttribute(OPEN_ATTRIBUTE);
    },
    /** Place the panel beside `link`, clamped to the viewport. */
    position: position,
    /** Write a position, keeping the whole panel in the viewport. */
    place: place,
    /** Where the panel currently is, as the browser lays it out. */
    panelOrigin: panelOrigin,
    /** Record that the reader placed this showing by hand. */
    markMoved: function () {
      moved = true;
    },
    /** Forget the hand placement, so the next hover anchors afresh. */
    forgetPlacement: function () {
      moved = false;
    },
    /** Clear the size a resize left, so the next showing opens natural. */
    clearFrame: function () {
      if (panel) {
        panel.style.width = "";
        panel.style.height = "";
        panel.style.maxHeight = "";
      }
    },
    /** Whether the frame has been built. */
    isBuilt: function () {
      return !!panel;
    },
    /** Whether the frame is on screen. */
    isOpen: function () {
      return !!panel && !panel.hidden;
    },
    /** The frame's nodes, for the roles that fill them and the composer. */
    root: function () {
      return panel;
    },
    body: function () {
      return body;
    },
    title: function () {
      return title;
    },
    path: function () {
      return path;
    },
    noticeChapter: function () {
      return noticeChapter;
    },
    noticeDoc: function () {
      return noticeDoc;
    },
    unlockInput: function () {
      return unlockInput;
    },
    unlockSubmit: function () {
      return unlockSubmit;
    },
    unlockError: function () {
      return unlockError;
    },
    pinButton: function () {
      return pinButton;
    },
    closeButton: function () {
      return closeButton;
    },
    /** Take the frame off the page and forget every node it built. */
    dispose: dispose,
  };
}
