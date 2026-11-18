/**
 * The hover preview for a reference to a chapter or a whole document: the
 * composer that wires the frame, the gestures and the content states into one
 * controller.
 *
 * `preview-panel.js` owns the frame — one popover, built once, placed beside
 * the link it describes and kept inside the viewport. `preview-gestures.js`
 * owns the pointer and timer state — when the panel opens, when it goes away,
 * and what a reader's hand can do to it while it is up. `preview-roles.js`
 * owns the content states — which of the five a link deserves and what each
 * fills in. This module is the wiring and the click; it holds no state of its
 * own except the showing, the pair of links both other sides gate on.
 *
 * The listeners live here because they are the seams. Pointer and focus
 * events on the article feed the gesture scheduler, which opens the panel
 * after the hover delay and closes it after the grace period; a scroll or an
 * Escape dismisses an unpinned panel at once; and a click is where the
 * preview hands over.
 *
 * A click is where this module hands over. A sound block reference is already a
 * hash route, so the browser follows it: it writes the history entry, fires
 * `hashchange` and scrolls to the chapter without a second render racing the
 * scroll. Only a reference the build marked as broken is routed from here,
 * because its route carries no anchor to scroll to and its message has to be
 * queued for the render the click causes.
 *
 * The constants each module defines are re-exported here, so the module's
 * public surface — the factory and every vocabulary word the stylesheet and
 * the tests spell — stays exactly what it was.
 */
import * as Links from "./links.js";
import * as DiagramView from "./diagram-view.js";
import { createPreviewGestures } from "./preview-gestures.js";
import { createPreviewPanel } from "./preview-panel.js";
import { createPreviewRoles } from "./preview-roles.js";

export {
  ACTIONS_CLASS,
  BODY_CLASS,
  CLOSE_CLASS,
  CLOSE_LABEL,
  DRAG_LABEL,
  ERROR_CLASS,
  ERROR_TEXT,
  ERROR_TITLE,
  GAP_PX,
  HEAD_CLASS,
  HEAD_TEXT_CLASS,
  LOCKED_CLASS,
  LOCKED_TEXT,
  LOCKED_TITLE,
  MISSING_SEPARATOR,
  MISSING_TAIL,
  MISSING_TITLE,
  OPEN_ATTRIBUTE,
  PIN_CLASS,
  PIN_LABEL,
  POPOVER_CLASS,
  PREVIEW_LABEL,
  RESIZE_CLASS,
  RESIZE_DIRECTION_ATTRIBUTE,
  UNLOCK_ERROR_CLASS,
  UNLOCK_ERROR_TEXT,
  UNLOCK_FORM_CLASS,
  UNLOCK_INPUT_CLASS,
  UNLOCK_INPUT_LABEL,
  UNLOCK_SUBMIT_CLASS,
  UNLOCK_SUBMIT_TEXT,
  UNPIN_LABEL,
  LOADING_CLASS,
  LOADING_TEXT,
  LOADING_TEXT_CLASS,
} from "./preview-panel.js";

export {
  CLOSE_DELAY_MS,
  DRAG_THRESHOLD_PX,
  DRAGGING_ATTRIBUTE,
  HOVER_DELAY_MS,
  MIN_HEIGHT_PX,
  MIN_WIDTH_PX,
  PIN_ATTRIBUTE,
  RESIZE_ATTRIBUTE,
} from "./preview-gestures.js";

export {
  ERROR_ATTRIBUTE,
  FAILED_LABEL,
  LOCKED_ATTRIBUTE,
  LOCKED_LABEL,
  LOADING_ATTRIBUTE,
  LOADING_LABEL,
  MISSING_ATTRIBUTE,
  MISSING_LABEL,
  UNLOCK_BUSY_TEXT,
} from "./preview-roles.js";

/**
 * Create the preview controller for one reader instance.
 *
 * `content` is the element whose links are watched; `documents` is the
 * reader's document store — `peek(id)` answers with the model already on hand
 * or `null`, `get(id)` promises it, fetching first when the build split the
 * site into files; `theme` returns the theme currently in effect, because
 * diagrams bake their colours into the SVG; `onNavigate` takes over a click on
 * a link the browser cannot finish on its own — a broken reference, or a
 * document link without a chapter — so the preview and the click share one
 * route. A sound block reference is left to the browser, which routes and
 * scrolls it in one step.
 */
export function createPreviewView(options) {
  var content = options.content;
  var documents = options.documents || null;
  var theme =
    options.theme ||
    function () {
      return null;
    };
  var onNavigate = options.onNavigate || null;
  // Called instead of opening a preview when the build already knows the
  // chapter does not exist. Injected rather than imported so this module stays
  // a view over the preview model and never reaches for the banner itself.
  var onMissingChapter = options.onMissingChapter || null;

  // The showing: the link the panel currently describes, and the one it is
  // about to. The open timer writes the second and reads both; a content
  // answer for a link nobody points at any more is dropped by the same pair.
  // The composer owns it and hands the same object to both modules, so the
  // two sides can never disagree about what the panel is for.
  var session = { anchor: null, pending: null };
  var listening = false;

  var panel = createPreviewPanel({
    // A press that survived the frame's chrome checks is a handle press.
    onHeadPress: function (event) {
      return gestures.onHeadPointerDown(event);
    },
    onPinClick: function (event) {
      return gestures.onPinClick(event);
    },
    onCloseClick: function (event) {
      stopEvent(event);
      close();
    },
    // Entering the panel cancels a pending close; leaving it starts one.
    onEnterPanel: function () {
      return gestures.clearCloseTimer();
    },
    onLeavePanel: function () {
      return gestures.scheduleClose();
    },
    // A click inside the panel, on anything but its own buttons, claims it.
    onClaim: function () {
      return gestures.claim();
    },
    onUnlockSubmit: function (event) {
      return roles.onUnlockSubmit(event);
    },
    onUnlockInput: function () {
      return roles.onUnlockInput();
    },
    onResizePress: function (direction, event) {
      return gestures.onResizePointerDown(direction, event);
    },
  });

  var gestures = createPreviewGestures({
    session: session,
    panel: panel,
    stopEvent: stopEvent,
    // A matured hover opens the panel for the link that raised it; a grace
    // period that ran out closes it, unless the reader pinned it meanwhile.
    onOpen: function (link) {
      return roles.open(link);
    },
    onClose: function () {
      return close();
    },
  });

  var roles = createPreviewRoles({
    session: session,
    panel: panel,
    gestures: gestures,
    documents: documents,
    theme: theme,
    onUnlock: options.onUnlock || null,
    passwordCandidates: options.passwordCandidates || null,
  });

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
    if (gestures.isPinned()) {
      return;
    }

    var link = linkFrom(event);
    if (link) {
      gestures.scheduleOpen(link);
    }
  }

  function onPointerOut(event) {
    var link = linkFrom(event);
    if (!link || (link !== session.pending && link !== session.anchor)) {
      return;
    }

    // Moving between two children of the same link is not leaving it.
    var to = event.relatedTarget;
    if (to && typeof link.contains === "function" && link.contains(to)) {
      return;
    }

    gestures.scheduleClose();
  }

  function onFocusIn(event) {
    var link = linkFrom(event);
    if (link) {
      gestures.scheduleOpen(link);
    }
  }

  function onFocusOut() {
    gestures.scheduleClose();
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && panel.isOpen()) {
      close();
    }
  }

  function onScroll() {
    // A pinned panel was placed by the reader and stays where they left it; an
    // unpinned one is a hint about the paragraph under the pointer, and the
    // panel is positioned against the viewport rather than following the
    // document, so scrolling would leave it pointing at the wrong paragraph.
    if (gestures.isPinned()) {
      return;
    }

    close();
  }

  function onClick(event) {
    // A link the build marked as dead has nowhere to go: no document and no
    // asset was compiled under its address, so following the href can only
    // end in a browser error. Any click on one is stopped, however it was
    // clicked — no plain-click check, because a modified click would open
    // the same dead end elsewhere. It still dismisses an unpinned preview,
    // like any other click on the document.
    var dead =
      event.target &&
      typeof event.target.closest === "function" &&
      event.target.closest(Links.INVALID_SELECTOR);
    if (dead) {
      event.preventDefault();
      if (panel.isOpen() && !gestures.isPinned()) {
        close();
      }
      return;
    }

    // A click inside the panel is the reader reading it, not dismissing it; the
    // panel's own handler turns that click into the pin.
    if (panel.isOpen() && event.target && panel.root().contains(event.target)) {
      return;
    }

    var link = linkFrom(event);
    if (!link) {
      // A click anywhere else is the reader dismissing the preview — unless the
      // preview is pinned, which only an explicit act may end.
      if (panel.isOpen() && !gestures.isPinned()) {
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
    if (gestures.isPinned() && link === session.anchor) {
      event.preventDefault();
      close();
      return;
    }

    // Everything else is a navigation, and a navigation is not a reason to take
    // away a panel the reader holds: it keeps the chapter it opened with while
    // the document behind it changes.
    if (!gestures.isPinned()) {
      close();
    }

    // The route of a broken reference carries no anchor, so a plain navigation
    // would open the document at its top with nothing to explain why. The
    // `onMissingChapter` hook carries the authored chapter into the navigation
    // instead, which keeps the message valid for exactly one render.
    var broken = roles.taggedMissing(link);
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
    if (
      listening ||
      !content ||
      typeof content.addEventListener !== "function"
    ) {
      return;
    }
    listening = true;
    content.addEventListener("pointerover", onPointerOver);
    content.addEventListener("pointerout", onPointerOut);
    content.addEventListener("focusin", onFocusIn);
    content.addEventListener("focusout", onFocusOut);
    content.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    panel.view().addEventListener("scroll", onScroll, { passive: true });
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
    panel.view().removeEventListener("scroll", onScroll);
  }

  /**
   * Tag every internal document link in `root`, so the handlers can find them
   * with one selector instead of re-parsing every href on each pointer move.
   *
   * Every tagged link opens the popover now: a chapter reference shows the
   * chapter, a document reference shows the whole document, and a reference
   * the build marked as broken shows the notice — so each announces the same
   * collapsed state its hover expands.
   */
  function tag(root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }

    var anchors = root.querySelectorAll("a[href]");
    Array.prototype.forEach.call(anchors, function (link) {
      var href = link.getAttribute("href");
      if (
        typeof href !== "string" ||
        href.indexOf(Links.ROUTE_HREF_PREFIX) !== 0
      ) {
        return;
      }

      link.setAttribute(Links.DOC_LINK_ATTRIBUTE, "");
      roles.taggedMissing(link);
      link.setAttribute("aria-expanded", "false");
    });
  }

  /** Hide the panel and drop what it showed. */
  function close() {
    gestures.cancelTimers();
    session.pending = null;
    // A closed panel is nobody's: the pin goes with the content, and so do
    // the place the reader dragged it to and the size a resize gave it — the
    // next hover is anchored to its own link at the stylesheet's size.
    gestures.endDrag();
    gestures.endResize();
    panel.forgetPlacement();
    gestures.release();

    if (!panel.isBuilt()) {
      session.anchor = null;
      return;
    }

    if (session.anchor) {
      session.anchor.setAttribute("aria-expanded", "false");
    }

    session.anchor = null;
    panel.dismiss();
    roles.reset();
    // The size a resize gave the panel belongs to that showing, as the place
    // a drag gave it does: the next hover opens at the stylesheet's size.
    panel.clearFrame();
  }

  /** Drop the panel, its timers and its listeners. */
  function dispose() {
    close();
    unlisten();
    gestures.dispose();
    panel.dispose();
    roles.dispose();
  }

  /** Re-render the open preview's diagrams after a theme change. */
  function refreshDiagrams() {
    if (!panel.isOpen() || !panel.body()) {
      return;
    }
    DiagramView.resetDiagrams(panel.body());
    DiagramView.renderDiagrams(panel.body(), theme());
  }

  listen();

  return {
    tag: tag,
    dispose: dispose,
    close: close,
    refreshDiagrams: refreshDiagrams,
    /** Whether the panel is on screen, for tests and for `app.js`. */
    isOpen: function () {
      return panel.isOpen();
    },
    /** Whether the reader holds the panel, for tests. */
    isPinned: gestures.isPinned,
  };
}
