/**
 * Chapter outline for the current document.
 *
 * The tree comes from the payload (`DocModel::toc`), not from scanning the
 * rendered headings, so the outline can be rendered before the document body
 * and links can carry the full `#/doc/<id>#<anchor>` route. Those route-aware
 * hrefs are the reason this module is hand-written instead of delegating to a
 * table-of-contents library: such libraries emit `#<anchor>` links and match
 * scroll-spy state by that href, which would break deep links.
 */
import { formatHash, parseHash } from "./router.js";

/**
 * Where the reading line sits, as a fraction of the viewport height.
 *
 * A heading is "current" once it has scrolled past this line, which keeps a
 * section highlighted while the reader is still inside it instead of switching
 * as soon as the next heading enters the screen.
 */
export var READING_LINE_RATIO = 0.25;

/**
 * Reading line used once the document can no longer scroll.
 *
 * The line cannot sit near the top there: a short document renders its whole
 * outline at once, and any scrollable amount would highlight the last heading
 * from the start. Half the viewport keeps the entry the reader is looking at.
 */
var STILL_READING_LINE_RATIO = 0.5;

/** How long a lock survives without a `scroll` event before it releases. */
export var LOCK_IDLE_MS = 160;

/** Cap for a jump whose scrolling never pauses (a long smooth scroll). */
export var LOCK_MAX_MS = 2000;

/** Whether a click should be handled by the router instead of the browser. */
function isPlainLeftClick(event) {
  return (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.button === 0
  );
}

/**
 * Index of the heading that owns `readingLine`, or -1 for an empty outline.
 *
 * `offsets` holds the absolute top of every heading in document order. The
 * answer is the last heading at or above the reading line, which is the
 * section being read even when the screen shows no heading at all (between two
 * long tables, say). The first entry is the fallback when the reading line is
 * still above every heading, so the introduction never leaves the outline
 * unhighlighted. `atBottom` overrides both rules: the closing section is the
 * current one once the document is scrolled to its end, however little content
 * follows its heading.
 */
export function pickActive(offsets, readingLine, atBottom) {
  if (!Array.isArray(offsets) || !offsets.length) {
    return -1;
  }
  if (atBottom) {
    return offsets.length - 1;
  }

  var low = 0;
  var high = offsets.length - 1;
  var found = 0;

  while (low <= high) {
    var middle = (low + high) >> 1;
    if (offsets[middle] <= readingLine) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
}

/**
 * Render an outline and keep the current section highlighted.
 *
 * `onNavigate(docId, anchor)` is optional: without it the links keep their
 * native `#/doc/...` behaviour, which the router already handles.
 */
export function createToc(options) {
  var container = options.container;
  var onNavigate = options.onNavigate || null;
  var docId = null;
  var links = [];
  var anchors = [];
  // Absolute top of each heading, ascending, filled by `measure()`.
  var offsets = [];
  var active = null;
  var frame = 0;
  // A jump in progress: its anchor wins until the scrolling has settled.
  var lock = null;
  var lockTimer = 0;
  var listening = false;

  var view = globalThis;

  function scrollingElement() {
    var doc = globalThis.document;
    return (doc && (doc.scrollingElement || doc.documentElement)) || null;
  }

  function scrollTop() {
    var element = scrollingElement();
    return element ? element.scrollTop : view.pageYOffset || 0;
  }

  function viewportHeight() {
    var element = scrollingElement();
    return element ? element.clientHeight : 0;
  }

  function scrollHeight() {
    var element = scrollingElement();
    return element ? element.scrollHeight : 0;
  }

  /**
   * Where the reading line sits in the viewport.
   *
   * Once the document can no longer scroll, the line moves to the middle: a
   * short document renders its whole outline at once, and a line near the top
   * would highlight the final heading from the very first frame.
   */
  function readingLine() {
    // One pixel of slack absorbs sub-pixel rounding at fractional zoom levels.
    var scrollable = scrollHeight() - viewportHeight() > 1;
    var ratio = scrollable ? READING_LINE_RATIO : STILL_READING_LINE_RATIO;
    return scrollTop() + viewportHeight() * ratio;
  }

  function atBottom() {
    return scrollTop() + viewportHeight() >= scrollHeight() - 1;
  }

  /**
   * Absolute top of every heading.
   *
   * `offsetTop` is not usable: an `offsetParent` without `position` climbs all
   * the way to `body`, which silently drops the top padding of `.content` and
   * shifts every offset. Measuring the viewport rectangle and adding the
   * scroll offset is correct regardless of any ancestor's positioning.
   */
  function measure() {
    if (!links.length) {
      offsets = [];
      return;
    }

    var scroll = scrollTop();
    offsets = links.map(function (link) {
      var heading = globalThis.document.getElementById(
        link.getAttribute("data-anchor"),
      );
      if (!heading) {
        return Infinity;
      }
      return heading.getBoundingClientRect().top + scroll;
    });
  }

  function highlight(anchor) {
    if (anchor === active) {
      return;
    }
    active = anchor;

    links.forEach(function (link) {
      if (link.getAttribute("data-anchor") === anchor) {
        link.setAttribute("aria-current", "true");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  /** Highlight whatever the reading line points at right now. */
  function apply() {
    if (!links.length) {
      return;
    }
    if (lock) {
      // Keep the clicked entry until the jump comes to rest, otherwise a
      // smooth scroll would light up every section it passes through.
      highlight(lock);
      return;
    }

    var index = pickActive(offsets, readingLine(), atBottom());
    if (index < 0) {
      return;
    }
    highlight(anchors[index]);
  }

  /** Coalesce scroll and resize bursts into at most one update per frame. */
  function schedule() {
    if (frame) {
      return;
    }
    if (typeof view.requestAnimationFrame !== "function") {
      apply();
      return;
    }
    frame = view.requestAnimationFrame(function () {
      frame = 0;
      apply();
    });
  }

  function cancelFrame() {
    if (frame) {
      if (typeof view.cancelAnimationFrame === "function") {
        view.cancelAnimationFrame(frame);
      }
      frame = 0;
    }
  }

  function releaseLock() {
    lock = null;
    if (lockTimer) {
      view.clearTimeout(lockTimer);
      lockTimer = 0;
    }
  }

  /**
   * Hold `anchor` highlighted until the jump it triggered has finished.
   *
   * `scrollend` is the precise signal but is still missing from older engines,
   * so the lock also expires: `LOCK_IDLE_MS` without a scroll event means the
   * document has come to rest, and `LOCK_MAX_MS` caps a scroll that never
   * pauses. Releasing before the first scroll event arrives is what keeps a
   * jump that needs no scrolling (the entry is already on the line) from
   * freezing the outline.
   */
  function engageLock(anchor) {
    releaseLock();
    lock = anchor;
    lockAt = Date.now();
    lockTimer = view.setTimeout(releaseLock, LOCK_IDLE_MS);
    highlight(anchor);
  }

  /**
   * Extend an active lock, and drop it once the jump has settled.
   *
   * Because the outline is never scrolled by the jump itself, only the
   * document stops emitting `scroll` events while both a smooth scroll and a
   * drag pause between mouse moves. A pause therefore ends the lock only when
   * the pointer is not mid-gesture and the reading line already agrees with
   * the locked entry; a drag the reader started meanwhile keeps the lock
   * alive until the pointer comes to rest.
   */
  function holdLock() {
    view.clearTimeout(lockTimer);
    lockTimer = view.setTimeout(function () {
      if (Date.now() - lockAt >= LOCK_MAX_MS) {
        releaseLock();
        apply();
        return;
      }
      if (pointerHeld() || !lockMatchesLine()) {
        holdLock();
        return;
      }
      releaseLock();
      apply();
    }, LOCK_IDLE_MS);
  }

  /**
   * Whether a pointer gesture may still be driving the page.
   *
   * A drag needs the button held down; a wheel leaves no state to inspect, so
   * a pause is only trusted when the pointer is not over the document body
   * (the outline links do not scroll anything, so a click there has landed
   * already). This is the asymmetry that keeps a wheel scroll from being
   * mistaken for the end of a jump.
   */
  function pointerHeld() {
    if (pointerDown) {
      return true;
    }
    if (!pointerPresent) {
      return false;
    }
    var height = viewportHeight();
    return (
      pointerY >= 0 &&
      pointerY <= height &&
      pointerX >= 0 &&
      pointerX <= (view.innerWidth || 0)
    );
  }

  /** Whether the locked entry is the one the reading line points at now. */
  function lockMatchesLine() {
    var index = anchors.indexOf(lock);
    if (index < 0) {
      return true;
    }
    var current = pickActive(offsets, readingLine(), atBottom());
    // A deep link scrolls a tall heading into view at the top of the screen,
    // so its anchor sits above the reading line: accept the neighbouring
    // section as "settled" instead of holding the lock forever.
    return Math.abs(current - index) <= 1;
  }

  function onPointerDown() {
    pointerDown = true;
  }

  function onPointerUp() {
    pointerDown = false;
  }

  function onPointerMove(event) {
    pointerPresent = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
  }

  var lockAt = 0;
  var pointerDown = false;
  var pointerPresent = false;
  var pointerX = -1;
  var pointerY = -1;

  function onScroll() {
    if (lock) {
      // The jump is still travelling: the locked entry stays lit.
      highlight(lock);
      holdLock();
      return;
    }
    schedule();
  }

  function onScrollEnd() {
    if (!lock) {
      return;
    }
    releaseLock();
    apply();
  }

  function onResize() {
    // The viewport height feeds the reading line, and a reflow moves the
    // headings, so both have to be re-read.
    measure();
    if (lock) {
      holdLock();
      return;
    }
    schedule();
  }

  function listen() {
    if (listening || typeof view.addEventListener !== "function") {
      return;
    }
    listening = true;
    view.addEventListener("scroll", onScroll, { passive: true });
    view.addEventListener("scrollend", onScrollEnd);
    view.addEventListener("resize", onResize);
    view.addEventListener("pointermove", onPointerMove, { passive: true });
    view.addEventListener("pointerdown", onPointerDown);
    view.addEventListener("pointerup", onPointerUp);
    view.addEventListener("pointercancel", onPointerUp);
  }

  function unlisten() {
    if (!listening) {
      return;
    }
    listening = false;
    view.removeEventListener("scroll", onScroll);
    view.removeEventListener("scrollend", onScrollEnd);
    view.removeEventListener("resize", onResize);
    view.removeEventListener("pointermove", onPointerMove);
    view.removeEventListener("pointerdown", onPointerDown);
    view.removeEventListener("pointerup", onPointerUp);
    view.removeEventListener("pointercancel", onPointerUp);
  }

  function clear() {
    releaseLock();
    cancelFrame();
    unlisten();

    docId = null;
    links = [];
    anchors = [];
    offsets = [];
    active = null;
    container.textContent = "";
  }

  function build(entries, parent) {
    if (!Array.isArray(entries) || !entries.length) {
      return;
    }

    var list = globalThis.document.createElement("ul");
    entries.forEach(function (entry) {
      if (!entry) {
        return;
      }

      var item = globalThis.document.createElement("li");
      var link = globalThis.document.createElement("a");
      link.href = formatHash(docId, entry.id);
      link.textContent = entry.text || entry.id;
      link.setAttribute("data-anchor", entry.id);
      link.addEventListener("click", function (event) {
        if (!onNavigate || !isPlainLeftClick(event)) {
          return;
        }
        event.preventDefault();
        engageLock(entry.id);
        onNavigate(docId, entry.id);
      });

      item.appendChild(link);
      build(entry.children, item);
      list.appendChild(item);
    });

    parent.appendChild(list);
  }

  function render(toc, id) {
    clear();

    docId = id || null;

    if (!Array.isArray(toc) || !toc.length) {
      var empty = globalThis.document.createElement("p");
      empty.className = "toc-empty";
      empty.textContent = "This document has no headings.";
      container.appendChild(empty);
      return;
    }

    build(toc, container);
    links = Array.prototype.slice.call(
      container.querySelectorAll("a[data-anchor]"),
    );
    anchors = links.map(function (link) {
      return link.getAttribute("data-anchor");
    });

    measure();
    listen();

    // A deep link arrives as `#/doc/<id>#<anchor>` and the router scrolls to
    // that anchor right after this call. Locking it now keeps the outline on
    // the linked section while the jump is in flight.
    var route = parseHash(view.location.hash);
    var linked =
      route.id === docId && route.anchor ? anchors.indexOf(route.anchor) : -1;
    if (linked >= 0) {
      engageLock(anchors[linked]);
    } else {
      apply();
    }
  }

  return { render: render };
}
