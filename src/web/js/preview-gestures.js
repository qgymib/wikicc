/**
 * The gestures of the hover preview: when it opens, when it goes away, and
 * what a reader's hand can do to it while it is up.
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
 * The head is a handle. Pressing it claims the panel — the same bit a click
 * sets, only earlier, because a drag crosses the empty page between the link
 * and the panel and a delayed close would take the panel away mid-gesture. A
 * press is not yet a drag: the panel only starts to follow once the pointer
 * has travelled `DRAG_THRESHOLD_PX`, which is what keeps a quick click on the
 * head from nudging the panel by the pixel or two a hand always adds. A press
 * on one of the head's buttons is never a drag, since those two clicks already
 * mean something else — the frame's own chrome check keeps them out before
 * this module sees the event.
 *
 * The moves are watched on the page rather than on the head: the panel is small
 * and fixed, so the pointer leaves it constantly during a gesture, and a
 * listener on the element would lose the drag the moment it did. The place the
 * reader leaves the panel in holds for as long as that panel is open — closing
 * it forgets both the pin and the place, so the next hover is anchored to its
 * own link again.
 *
 * The size can be taken in hand too: the right edge, the bottom edge and the
 * bottom-right corner of the frame are handles, each answering one axis — east
 * the width, south the height, the corner both. A press on one claims the
 * panel the way a press on the head does, and past the same threshold the
 * frame follows the hand, bounded by a floor on each dimension and by the edge
 * of the viewport. The size a resize leaves behind holds until the panel is
 * closed, because a size the reader chose belongs to the showing they chose it
 * for. A notice wears no handles: it is a hint about a link, not a window.
 *
 * This module holds pointer and timer state only: it decides *when* and *how
 * the frame moves*, never *what it shows*. The content decision belongs to
 * `preview-roles.js`, the frame and its geometry to `preview-panel.js`; the
 * composer wires the three together and answers the intents raised here — an
 * open that matured, a close whose grace period ran out.
 */
import { MARGIN_PX, PIN_LABEL, UNPIN_LABEL } from "./preview-panel.js";

/** How long the pointer must rest on a link before the preview opens. */
export var HOVER_DELAY_MS = 300;

/** How long the preview survives after the pointer leaves the link. */
export var CLOSE_DELAY_MS = 140;

/**
 * How far the pointer must travel before a press on the head is a drag.
 *
 * A hand on a mouse button is never perfectly still, so a zero threshold would
 * turn every click on the head into a one-pixel move; a browser's sub-pixel
 * noise never reaches three.
 */
export var DRAG_THRESHOLD_PX = 3;

/**
 * Attribute marking the popover as pinned, used by the stylesheet.
 *
 * The panel is the same element pinned or not; this bit is what lets the frame
 * say "held in place" without a second class on the root.
 */
export var PIN_ATTRIBUTE = "data-pinned";

/**
 * Attribute marking the popover as being dragged.
 *
 * The stylesheet reads it for the cursor and to stop a heading from being
 * selected along the way; nothing in the module reads it back.
 */
export var DRAGGING_ATTRIBUTE = "data-dragging";

/**
 * Attribute marking the popover as being resized.
 *
 * The stylesheet reads it for the text-selection suppression a drag gets; as
 * with the dragging mark, nothing in the module reads it back.
 */
export var RESIZE_ATTRIBUTE = "data-resizing";

/** Narrowest the panel may become, on the east edge or at the corner. */
export var MIN_WIDTH_PX = 240;

/** Shortest the panel may become, on the south edge or at the corner. */
export var MIN_HEIGHT_PX = 120;

/**
 * Build the gesture state of one preview: timers, the pin, drag and resize.
 *
 * `session` is the composer-owned pair `{ anchor, pending }` — the link the
 * panel describes and the one it is about to — which the open timer writes
 * and reads. `panel` is the frame's API, for geometry and the pointer moves'
 * attribute writes. `onOpen` answers a matured hover with the link that
 * raised it; `onClose` answers a grace period that ran out.
 */
export function createPreviewGestures(deps) {
  var session = deps.session;
  var panel = deps.panel;
  var stopEvent = deps.stopEvent;
  var onOpen = deps.onOpen;
  var onClose = deps.onClose;

  var openTimer = 0;
  var closeTimer = 0;
  // Whether the reader has claimed the panel. Only a click sets it, and only an
  // explicit act — a button, a second click on `anchor`, Escape — clears it, so
  // every automatic dismissal asks `isPinned()` before it acts.
  var pinned = false;
  // Where the pointer went down on the head, and where the panel was when it
  // did. `null` means no press is in progress. The press is a drag only once
  // the pointer has travelled past the threshold, which the origin decides.
  var press = null;
  var dragging = false;
  // The resize press in progress: which edge went down, where the pointer
  // went down, and the geometry the panel had when it did. `null` means no
  // press is in progress; like a drag, the press becomes a resize only once
  // the pointer has travelled past the threshold.
  var resizing = null;
  // Whether a resize has started applying, so the frame's mark and the
  // hand-placed flag are written once per gesture, not on every move.
  var resizingActive = false;

  /** The page the timers run on. */
  function view() {
    return panel.view();
  }

  /** The page a gesture is watched on. */
  function windowTarget() {
    return panel.windowTarget();
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

  /** Whether the reader holds the panel, so no delay may take it away. */
  function isPinned() {
    return pinned && panel.isBuilt() && !panel.root().hidden;
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

    if (!panel.isBuilt()) {
      return;
    }

    if (pinned) {
      panel.root().setAttribute(PIN_ATTRIBUTE, "true");
    } else {
      panel.root().removeAttribute(PIN_ATTRIBUTE);
    }

    var button = panel.pinButton();
    if (button) {
      button.setAttribute("aria-pressed", pinned ? "true" : "false");
      button.setAttribute("aria-label", pinned ? UNPIN_LABEL : PIN_LABEL);
      button.setAttribute("title", pinned ? UNPIN_LABEL : PIN_LABEL);
    }
  }

  /** The reader reached for the panel: the delays stop applying. */
  function claim() {
    setPinned(true);
  }

  /** Hand the panel back to the delays. */
  function release() {
    setPinned(false);
  }

  /**
   * A press on the head: the reader asks to move the panel.
   *
   * The frame has already kept the buttons out — only a handle press arrives
   * here. The panel is claimed at once, before a single pixel of movement: a
   * drag crosses the gap between the link and the panel, and an unpinned panel
   * would be closed by the pointer leaving on the way. Claiming it here rather
   * than on the first move also means the press is already a promise the panel
   * keeps — a reader who presses and lets go without moving still holds it,
   * which is what a click on the panel did before.
   *
   * The default action is cancelled so the heading is not selected while the
   * panel travels with the hand; the event itself still bubbles, so the click
   * the browser derives from this press reaches the frame's click handler as
   * usual.
   */
  function onHeadPointerDown(event) {
    if (event.preventDefault) {
      event.preventDefault();
    }

    setPinned(true);

    var origin = panel.panelOrigin();
    press = {
      x: event.clientX,
      y: event.clientY,
      left: origin.left,
      top: origin.top,
    };
    dragging = false;
    listenForDrag();
  }

  /**
   * Watch the whole page for the rest of the gesture.
   *
   * The panel is fixed and small, so the pointer regularly leaves it before
   * the drag ends; a move listener on the head would stop following there.
   */
  function listenForDrag() {
    var page = windowTarget();
    if (!page || typeof page.addEventListener !== "function") {
      return;
    }
    page.addEventListener("pointermove", onDragMove);
    page.addEventListener("pointerup", onDragEnd);
    page.addEventListener("pointercancel", onDragEnd);
  }

  function unlistenForDrag() {
    var page = windowTarget();
    if (!page || typeof page.removeEventListener !== "function") {
      return;
    }
    page.removeEventListener("pointermove", onDragMove);
    page.removeEventListener("pointerup", onDragEnd);
    page.removeEventListener("pointercancel", onDragEnd);
  }

  function onDragMove(event) {
    if (!press || !event) {
      return;
    }

    var dx = event.clientX - press.x;
    var dy = event.clientY - press.y;

    if (!dragging) {
      // Below the threshold the panel does not move at all: a click must not
      // nudge it, and the browser's own sub-pixel jitter never gets past here.
      if (
        Math.abs(dx) < DRAG_THRESHOLD_PX &&
        Math.abs(dy) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging = true;
      panel.markMoved();
      panel.root().setAttribute(DRAGGING_ATTRIBUTE, "true");
    }

    panel.place(press.left + dx, press.top + dy);
  }

  /**
   * The gesture is over, wherever the pointer was released.
   *
   * The panel keeps the place it was left in and the pin the press put on it:
   * ending a drag is not a dismissal, and only the acts that always closed the
   * panel — the buttons, Escape, the reference again — still do.
   */
  function onDragEnd() {
    endDrag();
  }

  /**
   * Give up the gesture: drop the origin, stop watching the page and take the
   * dragging mark off. Idempotent, because every path that can end a showing
   * asks for it — a release, a close, a dispose, a new press.
   */
  function endDrag() {
    press = null;
    dragging = false;
    if (panel.isBuilt()) {
      panel.root().removeAttribute(DRAGGING_ATTRIBUTE);
    }
    unlistenForDrag();
  }

  /**
   * A press on a handle: the reader asks to change the panel's size.
   *
   * The panel is claimed at once, before a single pixel of movement, the way
   * a press on the head claims it — a resize crosses the same empty page a
   * drag does, and a panel that closed mid-gesture would take the gesture's
   * meaning with it. The geometry the resize works from is read here, at the
   * press, so every move that follows is a delta against what the panel was,
   * not against wherever a reflow has taken it.
   *
   * The default action is cancelled so the edge of the chapter under the
   * strip is not selected while the frame follows the hand; the event still
   * bubbles, so the click a release derives reaches the frame's click handler
   * as usual.
   */
  function onResizePointerDown(direction, event) {
    if (!event || event.button) {
      return;
    }

    if (event.preventDefault) {
      event.preventDefault();
    }

    setPinned(true);
    // A new press replaces whatever resize was in progress.
    endResize();

    var origin = panel.panelOrigin();
    resizing = {
      dir: direction,
      x: event.clientX,
      y: event.clientY,
      left: origin.left,
      top: origin.top,
      width: panel.root().offsetWidth || MIN_WIDTH_PX,
      height: panel.root().offsetHeight || MIN_HEIGHT_PX,
    };
    listenForResize();
  }

  /**
   * Watch the whole page for the rest of the gesture, the way a drag is
   * watched: the pointer regularly leaves the panel mid-resize, and a
   * listener on the strip would stop following there.
   */
  function listenForResize() {
    var page = windowTarget();
    if (!page || typeof page.addEventListener !== "function") {
      return;
    }
    page.addEventListener("pointermove", onResizeMove);
    page.addEventListener("pointerup", onResizeEnd);
    page.addEventListener("pointercancel", onResizeEnd);
  }

  function unlistenForResize() {
    var page = windowTarget();
    if (!page || typeof page.removeEventListener !== "function") {
      return;
    }
    page.removeEventListener("pointermove", onResizeMove);
    page.removeEventListener("pointerup", onResizeEnd);
    page.removeEventListener("pointercancel", onResizeEnd);
  }

  function onResizeMove(event) {
    if (!resizing || !event) {
      return;
    }

    // Each handle answers one axis: east the width's, south the height's,
    // the corner both. The axis a handle does not answer reads as no movement
    // at all, so its share of the threshold never trips on noise alone.
    var dx = isWidthAxis(resizing.dir) ? event.clientX - resizing.x : 0;
    var dy = isHeightAxis(resizing.dir) ? event.clientY - resizing.y : 0;

    if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) {
      return;
    }

    if (!resizingActive) {
      resizingActive = true;
      // A resized panel is placed by hand too: `position()` must not re-anchor
      // it or rebuild the height a placement capped — not after the open, and
      // not when a document a panel waits for arrives mid-gesture.
      panel.markMoved();
      panel.root().setAttribute(RESIZE_ATTRIBUTE, "true");
    }

    applySize(dx, dy);
  }

  /** Whether `direction` answers the width: east and the corner do. */
  function isWidthAxis(direction) {
    return direction === "e" || direction === "se";
  }

  /** Whether `direction` answers the height: south and the corner do. */
  function isHeightAxis(direction) {
    return direction === "s" || direction === "se";
  }

  /**
   * Write the size the gesture has reached, clamped to a floor on each axis
   * and to the edge of the viewport.
   *
   * Only the axes the pressed handle answers are written: an east resize
   * leaves the height to the content and to the placement that capped it, and
   * a south resize leaves the width alone. The height is written twice, as
   * `height` and as a `max-height` of the same pixel count, because the
   * stylesheet's own share of the window would otherwise cap a panel the
   * reader grew past it — and a chapter shorter than the frame simply ends
   * the panel early, exactly as it would end a window.
   */
  function applySize(dx, dy) {
    if (isWidthAxis(resizing.dir)) {
      var viewportWidth =
        view().innerWidth || document.documentElement.clientWidth;
      var maxWidth = Math.max(
        MIN_WIDTH_PX,
        viewportWidth - resizing.left - MARGIN_PX,
      );
      panel.root().style.width =
        Math.round(
          Math.max(MIN_WIDTH_PX, Math.min(resizing.width + dx, maxWidth)),
        ) + "px";
    }

    if (isHeightAxis(resizing.dir)) {
      var viewportHeight =
        view().innerHeight || document.documentElement.clientHeight;
      var maxHeight = Math.max(
        MIN_HEIGHT_PX,
        viewportHeight - resizing.top - MARGIN_PX,
      );
      var height =
        Math.round(
          Math.max(MIN_HEIGHT_PX, Math.min(resizing.height + dy, maxHeight)),
        ) + "px";
      panel.root().style.height = height;
      panel.root().style.maxHeight = height;
    }
  }

  /**
   * The gesture is over, wherever the pointer was released.
   *
   * The panel keeps the size the gesture left and the pin the press put on
   * it: ending a resize is not a dismissal, exactly as ending a drag is not.
   */
  function onResizeEnd() {
    endResize();
  }

  /**
   * Give up the resize: drop the origin, stop watching the page and take the
   * resizing mark off. Idempotent, because every path that can end a showing
   * asks for it — a release, a close, a dispose, a new press.
   */
  function endResize() {
    resizing = null;
    resizingActive = false;
    if (panel.isBuilt()) {
      panel.root().removeAttribute(RESIZE_ATTRIBUTE);
    }
    unlistenForResize();
  }

  /** Start the open timer for `link`, cancelling any other. */
  function scheduleOpen(link) {
    clearOpenTimer();
    clearCloseTimer();

    if (link === session.anchor) {
      return;
    }

    session.pending = link;
    openTimer = view().setTimeout(function () {
      openTimer = 0;
      if (session.pending === link) {
        onOpen(link);
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

    closeTimer = view().setTimeout(onClose, CLOSE_DELAY_MS);
  }

  /**
   * The pin button: pin an open panel, or hand it back to the delays.
   *
   * A click on the button must not be an ordinary panel click first — that
   * would make "unpin" impossible, since every click would pin again.
   */
  function onPinClick(event) {
    stopEvent(event);

    if (isPinned()) {
      unpin();
      return;
    }

    if (panel.isOpen()) {
      setPinned(true);
    }
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

  /** Drop both timers, the way a close or a dispose does. */
  function cancelTimers() {
    clearOpenTimer();
    clearCloseTimer();
  }

  /** Give up both gestures; every path that ends a showing asks for these. */
  function dispose() {
    endDrag();
    endResize();
  }

  return {
    scheduleOpen: scheduleOpen,
    scheduleClose: scheduleClose,
    clearCloseTimer: clearCloseTimer,
    cancelTimers: cancelTimers,
    isPinned: isPinned,
    claim: claim,
    release: release,
    onPinClick: onPinClick,
    onHeadPointerDown: onHeadPointerDown,
    onResizePointerDown: onResizePointerDown,
    endDrag: endDrag,
    endResize: endResize,
    dispose: dispose,
  };
}
