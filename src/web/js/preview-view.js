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
 * The panel is appended to `document.body` and positioned with `position:
 * fixed`, the same way the table filter panel works: the document body clips
 * overflow in places, and a panel nested inside it would be cut off. Only one
 * panel exists at a time, and it is disposed whenever a new document is
 * rendered.
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
 * diagrams bake their colours into the SVG; `onNavigate` is called instead of
 * letting the browser follow a link, so the preview and the click share one
 * route.
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
  var openTimer = 0;
  var closeTimer = 0;
  // The link the panel currently describes, and the one it is about to.
  var anchor = null;
  var pending = null;
  var listening = false;

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

    title = document.createElement("p");
    title.className = "preview-title";

    path = document.createElement("p");
    path.className = "preview-path";

    head.appendChild(title);
    head.appendChild(path);

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

    return panel;
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

  /** Start the close timer, cancelled when the pointer comes back. */
  function scheduleClose() {
    clearOpenTimer();
    clearCloseTimer();
    closeTimer = view().setTimeout(close, CLOSE_DELAY_MS);
  }

  /** Hide the panel and drop what it showed. */
  function close() {
    clearOpenTimer();
    clearCloseTimer();
    pending = null;

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
    // The panel is positioned against the viewport and does not follow the
    // document, so scrolling would leave it pointing at the wrong paragraph.
    close();
  }

  function onClick(event) {
    var link = linkFrom(event);
    if (!link) {
      // A click anywhere else is the reader dismissing the preview.
      if (panel && !panel.hidden && !(event.target && panel.contains(event.target))) {
        close();
      }
      return;
    }

    if (!onNavigate || !Links.isPlainLeftClick(event)) {
      return;
    }

    var destination = Links.parseDocLink(link.getAttribute("href"));
    if (!destination) {
      return;
    }

    event.preventDefault();
    close();

    // The route of a broken reference carries no anchor, so a plain navigation
    // would open the document at its top with nothing to explain why. The
    // `onMissingChapter` hook carries the authored chapter into the navigation
    // instead, which keeps the message valid for exactly one render.
    if (taggedMissing(link) && onMissingChapter) {
      onMissingChapter({
        docId: destination.id,
        anchor: Links.missingAnchorOf(
          link.getAttribute(Links.MISSING_ANCHOR_ATTRIBUTE),
        ),
      });
    }

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
  };
}
