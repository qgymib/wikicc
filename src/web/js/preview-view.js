/**
 * The hover preview for a block reference.
 *
 * `preview.js` decides *what* to show; this module owns the popover: when it
 * appears, where it sits and when it goes away.
 *
 * The same popover serves two moments. A reference whose chapter exists shows
 * the chapter's content; a reference the build already marked as broken shows a
 * notice naming the chapter that is missing instead. The notice is a hint
 * about the link under the pointer, so it is shaped like a tooltip and never
 * like the banner: that one explains a navigation, and is raised on click.
 *
 * Timing is deliberately split in two. Opening waits `HOVER_DELAY_MS`, so
 * moving the pointer across a paragraph never flashes a panel. Closing waits
 * `CLOSE_DELAY_MS` and is cancelled as soon as the pointer enters the popover,
 * because the gap between the link and the panel is a place the pointer has to
 * cross — without the grace period the panel would close under the hand that is
 * about to scroll it.
 *
 * A preview can also be *pinned*. Every delay above is a guess at what the
 * pointer meant; a click on the panel is not a guess, it is the reader saying
 * they want the chapter at hand while they read something else. So a click
 * inside the panel, or on its pin button, turns every automatic dismissal off:
 * the pointer may leave, the reader may click elsewhere, follow another
 * reference, or land in another document, and the panel keeps the chapter it
 * opened with. Only an explicit act ends it — the close button, the pin button
 * again, a second click on the reference it describes, or Escape.
 *
 * Pinned means *held in place*, not *following*: the panel is positioned once,
 * against the link it describes, and `position: fixed` does not move with the
 * document. Re-anchoring it on scroll or on a navigation would either drag it
 * away from the chapter it shows or park it at a paragraph the reader is no
 * longer looking at, so the panel stays where the reader put it instead.
 *
 * The panel is appended to `document.body` and positioned with `position:
 * fixed`, the same way the table filter panel works: the document body clips
 * overflow in places, and a panel nested inside it would be cut off. Only one
 * panel exists at a time, so every document the reader opens shares it: a
 * document change does not dispose of it, and a pinned panel therefore survives
 * one untouched.
 *
 * Building the panel must never fail: it is built lazily inside the open
 * timer, so an exception here does not surface as an error a reader can see —
 * it surfaces as *nothing happening*, which is the hardest failure to diagnose.
 * Every node the panel owns is therefore created the way the DOM requires:
 * an SVG child comes from `document.createElementNS` and is appended to its
 * parent, because an `SVGElement` carries no `createElementNS` of its own.
 *
 * A click is where this module hands over. A sound block reference is already a
 * hash route, so the browser follows it: it writes the history entry, fires
 * `hashchange` and scrolls to the chapter without a second render racing the
 * scroll. Only a reference the build marked as broken is routed from here,
 * because its route carries no anchor to scroll to and its message has to be
 * queued for the render the click causes.
 */
import * as Links from "./links.js";
import * as Preview from "./preview.js";
import * as TableView from "./table-view.js";
import * as DiagramView from "./diagram-view.js";

/** How long the pointer must rest on a link before the preview opens. */
export var HOVER_DELAY_MS = 300;

/** How long the preview survives after the pointer leaves the link. */
export var CLOSE_DELAY_MS = 140;

/** Gap between the link and the panel, in pixels. */
export var GAP_PX = 8;

/**
 * Namespace of the inline icons in the panel's head.
 *
 * An SVG child must be created in this namespace by `document`; the icons are
 * drawn inline so the page loads no asset and no icon font.
 */
var SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Smallest distance from the viewport edge the panel keeps. */
var MARGIN_PX = 10;

/** Class of the popover root. */
export var POPOVER_CLASS = "preview-popover";

/** Class of the scrolling body inside the popover. */
export var BODY_CLASS = "preview-scroll";

/** Attribute marking the popover as open, used by the stylesheet. */
export var OPEN_ATTRIBUTE = "data-open";

/**
 * Attribute marking the popover as a notice rather than a preview.
 *
 * The element is the same one in both roles — one popover, built once — so the
 * stylesheet needs one bit to know which of the two it is drawing. The reader
 * sets it before showing a notice and removes it before showing a preview, so
 * a reference followed by a sound one never leaves a warning frame behind.
 */
export var MISSING_ATTRIBUTE = "data-missing";

/** Accessible name of the popover while it shows a preview. */
export var PREVIEW_LABEL = "Chapter preview";

/** Accessible name of the popover while it shows a notice. */
export var MISSING_LABEL = "Broken reference";

/**
 * Attribute marking the popover as pinned, used by the stylesheet.
 *
 * The panel is the same element pinned or not; this bit is what lets the frame
 * say "held in place" without a second class on the root.
 */
export var PIN_ATTRIBUTE = "data-pinned";

/** Class of the pin button in the head. */
export var PIN_CLASS = "preview-pin";

/** Class of the close button in the head. */
export var CLOSE_CLASS = "preview-close";

/** Class of the group holding the head's buttons, kept apart from the title. */
export var ACTIONS_CLASS = "preview-actions";

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

/**
 * Create the preview controller for one reader instance.
 *
 * `content` is the element whose links are watched; `byId` maps a document id to
 * its payload model; `theme` returns the theme currently in effect, because
 * diagrams bake their colours into the SVG; `onNavigate` takes over a click on a
 * link the browser cannot finish on its own — a broken reference, or a document
 * link without a chapter — so the preview and the click share one route. A
 * sound block reference is left to the browser, which routes and scrolls it in
 * one step.
 */
export function createPreviewView(options) {
  var content = options.content;
  var byId = options.byId;
  var theme = options.theme || function () {
    return null;
  };
  var onNavigate = options.onNavigate || null;
  // Called instead of opening a preview when the build already knows the
  // chapter does not exist. Injected rather than imported so this module stays
  // a view over the preview model and never reaches for the banner itself.
  var onMissingChapter = options.onMissingChapter || null;

  var panel = null;
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
  // The head's two buttons, so their state can follow the pin without a query.
  var pinButton = null;
  var closeButton = null;
  var openTimer = 0;
  var closeTimer = 0;
  // The link the panel currently describes, and the one it is about to.
  var anchor = null;
  var pending = null;
  var listening = false;
  // Whether the reader has claimed the panel. Only a click sets it, and only an
  // explicit act — a button, a second click on `anchor`, Escape — clears it, so
  // every automatic dismissal asks `isPinned()` before it acts.
  var pinned = false;

  function view() {
    return globalThis;
  }

  function clearOpenTimer() {
    if (openTimer) {
      view().clearTimeout(openTimer);
      openTimer = 0;
    }
  }

  function clearCloseTimer() {
    if (closeTimer) {
      view().clearTimeout(closeTimer);
      closeTimer = 0;
    }
  }

  /** Build the empty popover once, on first use. */
  function ensurePanel() {
    if (panel) {
      return panel;
    }

    panel = document.createElement("div");
    panel.className = POPOVER_CLASS;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", PREVIEW_LABEL);
    panel.hidden = true;

    var head = document.createElement("div");
    head.className = "preview-head";

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

    pinButton = iconButton("pin", PIN_CLASS, PIN_LABEL, pinSvg);
    pinButton.setAttribute("aria-pressed", "false");
    pinButton.addEventListener("click", onPinClick);

    // The reader already holds this panel when they reach for its buttons, so a
    // close here must not be read as "a click inside the panel" and pin it.
    closeButton = iconButton("close", CLOSE_CLASS, CLOSE_LABEL, closeSvg);
    closeButton.addEventListener("click", onCloseClick);

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
    noticeTitle.textContent = MISSING_TITLE;

    noticeText = document.createElement("p");
    noticeText.className = "preview-missing-text";

    noticeDoc = document.createElement("code");
    noticeDoc.className = "preview-missing-code";

    noticeChapter = document.createElement("code");
    noticeChapter.className = "preview-missing-code";

    noticeText.appendChild(document.createTextNode(MISSING_SEPARATOR));
    noticeText.appendChild(noticeChapter);
    noticeText.appendChild(document.createTextNode(MISSING_TAIL));
    noticeText.appendChild(noticeDoc);

    notice.appendChild(noticeTitle);
    notice.appendChild(noticeText);

    body = document.createElement("div");
    body.className = BODY_CLASS;

    panel.appendChild(head);
    panel.appendChild(notice);
    panel.appendChild(body);
    document.body.appendChild(panel);

    // Entering the panel cancels a pending close; leaving it starts one.
    panel.addEventListener("pointerenter", clearCloseTimer);
    panel.addEventListener("pointerleave", function () {
      scheduleClose();
    });

    // Reading the panel is reaching for it: a click anywhere inside it says the
    // reader wants this chapter at hand, and the delays stop applying.
    panel.addEventListener("click", onPanelClick);

    return panel;
  }

  /** Whether the reader holds the panel, so no delay may take it away. */
  function isPinned() {
    return pinned && !!panel && !panel.hidden;
  }

  /**
   * Write the pin state through every place that shows it.
   *
   * One function owns the field, the frame's attribute and the button's state,
   * so the three can never disagree — a frame that says "pinned" over a button
   * that says otherwise is the one bug this state invites.
   */
  function setPinned(value) {
    pinned = !!value;

    if (!panel) {
      return;
    }

    if (pinned) {
      panel.setAttribute(PIN_ATTRIBUTE, "true");
    } else {
      panel.removeAttribute(PIN_ATTRIBUTE);
    }

    if (pinButton) {
      pinButton.setAttribute("aria-pressed", pinned ? "true" : "false");
      pinButton.setAttribute("aria-label", pinned ? UNPIN_LABEL : PIN_LABEL);
      pinButton.setAttribute("title", pinned ? UNPIN_LABEL : PIN_LABEL);
    }
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
   * common case for a link near the bottom of a long paragraph.
   */
  function position(link) {
    var rect = link.getBoundingClientRect();
    var width = panel.offsetWidth || 480;
    var height = panel.offsetHeight || 0;
    var viewportWidth = view().innerWidth || document.documentElement.clientWidth;
    var viewportHeight = view().innerHeight || document.documentElement.clientHeight;

    var below = rect.bottom + GAP_PX;
    var above = rect.top - GAP_PX - height;
    var top = below;
    if (height && below + height > viewportHeight - MARGIN_PX) {
      top = above >= MARGIN_PX ? above : Math.max(MARGIN_PX, viewportHeight - height - MARGIN_PX);
    }

    var left = Math.min(
      Math.max(MARGIN_PX, rect.left),
      Math.max(MARGIN_PX, viewportWidth - width - MARGIN_PX),
    );

    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
  }

  /** Whether `link` still has a chapter to preview. */
  function previewFor(link) {
    var destination = Links.parseDocLink(link.getAttribute("href"));
    if (!destination || !destination.anchor) {
      return null;
    }

    var doc = byId ? byId.get(destination.id) : null;
    return Preview.createPreview(doc, destination.anchor);
  }

  /**
   * What `link` addresses: `{ kind: "missing", docId, anchor }`,
   * `{ kind: "none" }` or the preview itself.
   *
   * A reference the build could not resolve is recognised from its mark rather
   * than from the `href`: the route deliberately carries no anchor (no element
   * emits one), so re-parsing it would only ever say "the whole document".
   */
  function resolveLink(link) {
    var destination = Links.parseDocLink(link.getAttribute("href"));
    if (!destination) {
      return { kind: "none" };
    }

    if (taggedMissing(link)) {
      return {
        kind: "missing",
        docId: destination.id,
        anchor: Links.missingAnchorOf(
          link.getAttribute(Links.MISSING_ANCHOR_ATTRIBUTE),
        ),
      };
    }

    var preview = previewFor(link);
    return preview ? { kind: "preview", preview: preview } : { kind: "none" };
  }

  function open(link) {
    var resolved = resolveLink(link);
    if (resolved.kind === "missing") {
      openNotice(link, resolved);
      return;
    }

    if (resolved.kind !== "preview") {
      return;
    }

    var preview = resolved.preview;
    ensurePanel();
    // The panel wears one of two roles; a preview must not inherit the notice
    // frame a previous hover left on it.
    setKind(false);
    title.textContent = preview.title;
    path.textContent = preview.path;

    body.innerHTML = preview.html;
    // Tables and diagrams are enhanced after the markup exists: the sortable
    // headers are plain DOM, the diagram engine needs measured layout.
    TableView.enhanceTables(body);
    DiagramView.renderDiagrams(body, theme());

    show(link);
  }

  /**
   * Show the notice for a reference whose chapter the document does not have.
   *
   * Nothing is reported to the reader's banner: the build already marked this
   * link, so hovering it is the reader asking what is wrong with it, and a
   * tooltip answers that where the pointer already is. The banner belongs to
   * the click, which navigates and therefore needs to explain the navigation.
   */
  function openNotice(link, resolved) {
    ensurePanel();
    setKind(true);
    // Nothing of a previous preview may survive: the notice owns the panel.
    body.textContent = "";
    title.textContent = MISSING_TITLE;
    path.textContent = resolved.docId ? String(resolved.docId) : "";
    noticeChapter.textContent = resolved.anchor ? String(resolved.anchor) : "";
    noticeDoc.textContent = resolved.docId ? String(resolved.docId) : "";

    show(link);
  }

  /**
   * Switch the panel between the two roles it can play.
   *
   * Only attributes and visible text change, so the element the page already
   * holds is reused and neither role can leave a mark on the other.
   */
  function setKind(missing) {
    if (missing) {
      panel.setAttribute(MISSING_ATTRIBUTE, "true");
      panel.setAttribute("aria-label", MISSING_LABEL);
      return;
    }

    panel.removeAttribute(MISSING_ATTRIBUTE);
    panel.setAttribute("aria-label", PREVIEW_LABEL);
  }

  /**
   * Put the panel on screen beside `link`, whatever it currently shows.
   *
   * The panel describes one link at a time, so the link it described before is
   * released first: moving the pointer from a sound reference to a broken one
   * must not leave the first announcing an expanded popover it no longer has.
   */
  function show(link) {
    if (anchor && anchor !== link) {
      anchor.setAttribute("aria-expanded", "false");
    }

    anchor = link;
    panel.hidden = false;
    panel.setAttribute(OPEN_ATTRIBUTE, "true");
    // Position after insertion, so `offsetWidth`/`offsetHeight` are known.
    position(link);

    if (link) {
      link.setAttribute("aria-expanded", "true");
    }
  }

  /** Start the open timer for `link`, cancelling any other. */
  function scheduleOpen(link) {
    clearOpenTimer();
    clearCloseTimer();

    if (link === anchor) {
      return;
    }

    pending = link;
    openTimer = view().setTimeout(function () {
      openTimer = 0;
      if (pending === link) {
        open(link);
      }
    }, HOVER_DELAY_MS);
  }

  /**
   * Start the close timer, cancelled when the pointer comes back.
   *
   * Every automatic dismissal ends up here — the pointer leaving the link or
   * the panel, focus moving on — so a pinned panel is guarded in one place
   * rather than in each of the handlers that ask for the timer.
   */
  function scheduleClose() {
    clearOpenTimer();
    clearCloseTimer();

    if (isPinned()) {
      return;
    }

    closeTimer = view().setTimeout(close, CLOSE_DELAY_MS);
  }

  /**
   * A click inside the panel: the reader claims it.
   *
   * The buttons are the exception. Close throws the panel away; the pin has its
   * own handler, and a click on it must not be an ordinary click first — that
   * would make "unpin" impossible, since every click would pin again.
   */
  function onPanelClick(event) {
    var target = event && event.target;
    if (!target || target === pinButton || target === closeButton) {
      return;
    }

    setPinned(true);
  }

  function onPinClick(event) {
    stopEvent(event);

    if (isPinned()) {
      unpin();
      return;
    }

    if (panel && !panel.hidden) {
      setPinned(true);
    }
  }

  function onCloseClick(event) {
    stopEvent(event);
    close();
  }

  /**
   * Release the panel back to the delays.
   *
   * The pointer may already be somewhere else — the click that unpinned came
   * from either place — so the panel is kept only while it is still under the
   * pointer, which `scheduleClose` decides on the usual grace period.
   */
  function unpin() {
    setPinned(false);
    scheduleClose();
  }

  /** Keep a button press from reaching the panel, the document and the link. */
  function stopEvent(event) {
    if (!event) {
      return;
    }
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
  }

  /** Hide the panel and drop what it showed. */
  function close() {
    clearOpenTimer();
    clearCloseTimer();
    pending = null;
    // A closed panel is nobody's: the pin goes with the content, or the next
    // hover would inherit a frame that claims to be held in place.
    setPinned(false);

    if (!panel) {
      anchor = null;
      return;
    }

    if (anchor) {
      anchor.setAttribute("aria-expanded", "false");
    }

    anchor = null;
    panel.hidden = true;
    panel.removeAttribute(OPEN_ATTRIBUTE);
    // Both roles are cleared, not just the one that was showing: the next
    // hover fills in what it needs, and a closed panel holds a stale message
    // whether or not it is visible.
    setKind(false);
    body.textContent = "";
    title.textContent = "";
    path.textContent = "";
    noticeChapter.textContent = "";
    noticeDoc.textContent = "";
  }

  /** The document link an event started on, or `null`. */
  function linkFrom(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== "function") {
      return null;
    }
    return target.closest(Links.DOC_LINK_SELECTOR);
  }

  function onPointerOver(event) {
    // The reader has claimed the panel; a pointer crossing the document is not
    // an instruction to replace what it shows.
    if (isPinned()) {
      return;
    }

    var link = linkFrom(event);
    if (link) {
      scheduleOpen(link);
    }
  }

  function onPointerOut(event) {
    var link = linkFrom(event);
    if (!link || link !== pending && link !== anchor) {
      return;
    }

    // Moving between two children of the same link is not leaving it.
    var to = event.relatedTarget;
    if (to && typeof link.contains === "function" && link.contains(to)) {
      return;
    }

    scheduleClose();
  }

  function onFocusIn(event) {
    var link = linkFrom(event);
    if (link) {
      scheduleOpen(link);
    }
  }

  function onFocusOut() {
    scheduleClose();
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && panel && !panel.hidden) {
      close();
    }
  }

  function onScroll() {
    // A pinned panel was placed by the reader and stays where they left it; an
    // unpinned one is a hint about the paragraph under the pointer, and the
    // panel is positioned against the viewport rather than following the
    // document, so scrolling would leave it pointing at the wrong paragraph.
    if (isPinned()) {
      return;
    }

    close();
  }

  function onClick(event) {
    // A click inside the panel is the reader reading it, not dismissing it; the
    // panel's own handler turns that click into the pin.
    if (panel && !panel.hidden && event.target && panel.contains(event.target)) {
      return;
    }

    var link = linkFrom(event);
    if (!link) {
      // A click anywhere else is the reader dismissing the preview — unless the
      // preview is pinned, which only an explicit act may end.
      if (panel && !panel.hidden && !isPinned()) {
        close();
      }
      return;
    }

    if (!onNavigate || !Links.isPlainLeftClick(event)) {
      return;
    }

    var href = link.getAttribute("href");
    var destination = Links.parseDocLink(href);
    if (!destination) {
      return;
    }

    // The reference a pinned panel describes is where the reader already is:
    // clicking it again is how they let go, so it closes instead of navigating
    // them to the chapter they are looking at.
    if (isPinned() && link === anchor) {
      event.preventDefault();
      close();
      return;
    }

    // Everything else is a navigation, and a navigation is not a reason to take
    // away a panel the reader holds: it keeps the chapter it opened with while
    // the document behind it changes.
    if (!isPinned()) {
      close();
    }

    // The route of a broken reference carries no anchor, so a plain navigation
    // would open the document at its top with nothing to explain why. The
    // `onMissingChapter` hook carries the authored chapter into the navigation
    // instead, which keeps the message valid for exactly one render.
    var broken = taggedMissing(link);
    if (broken && onMissingChapter) {
      onMissingChapter({
        docId: destination.id,
        anchor: Links.missingAnchorOf(
          link.getAttribute(Links.MISSING_ANCHOR_ATTRIBUTE),
        ),
      });
    }

    // A sound block reference is a plain hash route, so the browser is the best
    // reader available: it writes the history entry, fires `hashchange` and
    // scrolls to the chapter in one go. Routing it again here would replace
    // that with a second render, whose fresh markup arrives *after* the scroll
    // and leaves the reader at the top of the document. A broken reference has
    // no anchor to hand the browser, so only that one stays routed by hand.
    if (!broken && Links.isBlockReference(href)) {
      return;
    }

    event.preventDefault();
    onNavigate(destination.id, destination.anchor);
  }

  function listen() {
    if (listening || !content || typeof content.addEventListener !== "function") {
      return;
    }
    listening = true;
    content.addEventListener("pointerover", onPointerOver);
    content.addEventListener("pointerout", onPointerOut);
    content.addEventListener("focusin", onFocusIn);
    content.addEventListener("focusout", onFocusOut);
    content.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    view().addEventListener("scroll", onScroll, { passive: true });
  }

  function unlisten() {
    if (!listening) {
      return;
    }
    listening = false;
    content.removeEventListener("pointerover", onPointerOver);
    content.removeEventListener("pointerout", onPointerOut);
    content.removeEventListener("focusin", onFocusIn);
    content.removeEventListener("focusout", onFocusOut);
    content.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKeyDown);
    view().removeEventListener("scroll", onScroll);
  }

  /**
   * Tag every internal document link in `root`, so the handlers can find them
   * with one selector instead of re-parsing every href on each pointer move.
   *
   * A reference the build marked as broken is tagged too: hovering it opens the
   * notice, so it does expose a popover and announces the same collapsed state
   * a sound reference does.
   */
  function tag(root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }

    var anchors = root.querySelectorAll("a[href]");
    Array.prototype.forEach.call(anchors, function (link) {
      var href = link.getAttribute("href");
      if (typeof href !== "string" || href.indexOf(Links.ROUTE_HREF_PREFIX) !== 0) {
        return;
      }

      link.setAttribute(Links.DOC_LINK_ATTRIBUTE, "");

      if (taggedMissing(link)) {
        link.setAttribute("aria-expanded", "false");
        return;
      }

      if (Links.isBlockReference(href)) {
        link.setAttribute("aria-expanded", "false");
      }
    });
  }

  /**
   * Tag the broken references of `root` themselves.
   *
   * The build writes the mark on a `<span>` right before the link, because
   * `pulldown-cmark`'s serialiser owns the anchor's attributes; copying it
   * here leaves the markup in the document free of reader-only state and lets
   * every handler read one attribute from the anchor it already has.
   *
   * Returns whether `link` carries — or was just given — the mark.
   */
  function taggedMissing(link) {
    if (Links.missingAnchorOf(link.getAttribute(Links.MISSING_ANCHOR_ATTRIBUTE))) {
      if (link.classList) {
        link.classList.add(Links.MISSING_CLASS);
      }
      return true;
    }

    var sibling = link.previousElementSibling;
    if (!sibling) {
      return false;
    }

    var anchor = Links.missingAnchorOf(
      sibling.getAttribute(Links.MISSING_ANCHOR_ATTRIBUTE),
    );
    if (!anchor) {
      return false;
    }

    link.setAttribute(Links.MISSING_ANCHOR_ATTRIBUTE, anchor);
    link.classList.add(Links.MISSING_CLASS);
    return true;
  }

  /** Drop the panel, its timers and its listeners. */
  function dispose() {
    close();
    unlisten();

    if (panel && panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
    panel = null;
    body = null;
    title = null;
    path = null;
    notice = null;
    noticeText = null;
    noticeDoc = null;
    noticeChapter = null;
    pinButton = null;
    closeButton = null;
  }

  /** Re-render the open preview's diagrams after a theme change. */
  function refreshDiagrams() {
    if (!panel || panel.hidden || !body) {
      return;
    }
    DiagramView.resetDiagrams(body);
    DiagramView.renderDiagrams(body, theme());
  }

  listen();

  return {
    tag: tag,
    dispose: dispose,
    close: close,
    refreshDiagrams: refreshDiagrams,
    /** Whether the panel is on screen, for tests and for `app.js`. */
    isOpen: function () {
      return !!panel && !panel.hidden;
    },
    /** Whether the reader holds the panel, for tests. */
    isPinned: isPinned,
  };
}
