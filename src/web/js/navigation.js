/**
 * The navigation controller: the hash route and the cycle that answers it.
 *
 * Every navigation ends in `render`: the route is resolved against the
 * site's ids, the document on hand is placed at once and one that has to
 * travel shows the wait first, and the chapter — or the search passage — the
 * reader asked for is walked to once the markup has settled. The route still
 * names the document, so the address bar keeps its say; the store decrypts,
 * and an unlock re-renders the page the reader is looking at.
 *
 * `router.js` is the pure adapter this cycle rides on, `doc-render.js`
 * decides what the article carries, and the search's marks are handed their
 * turn at every arrival through `onArrive`.
 */
import * as Anchor from "./anchor.js";
import * as DocBody from "./doc-body.js";
import * as Links from "./links.js";
import * as Router from "./router.js";

export function createNavigation(deps) {
  var store = deps.store;
  var ids = deps.ids;
  var home = deps.home;
  var docList = deps.docList;
  var localGraph = deps.localGraph;
  var globalGraph = deps.globalGraph;
  var toc = deps.toc;
  // The backlinks panel answers the document on screen: every navigation
  // that changes the document refreshes it, whether or not its view of the
  // floating window is the one showing.
  var backlinks = deps.backlinks;
  var banner = deps.banner;
  var article = deps.article;
  var content = deps.content;
  var siteTitle = deps.siteTitle;
  var session = deps.session;
  var docRender = deps.docRender;
  // Every arrival hands the search's marks their turn. The search
  // controller is built after this one — the two answer each other — so
  // the composition root hands the call through while it is being wired.
  var onArrive = deps.onArrive;
  // A navigation starts by putting the drawer away, wherever the reader
  // reached it from.
  var onCloseDrawer = deps.onCloseDrawer;

  var currentId = null;
  var firstRender = true;

  /**
   * Chapter a pending navigation has to report even though its route cannot.
   *
   * A broken block reference routes to its document without an anchor, so the
   * href the browser would have followed carries no hint at all. Clicking such
   * a link stores the authored chapter here, and `render` — which every
   * navigation ends up in, whether it came from a hash change or a direct
   * call — shows it once the document is on screen.
   */
  var pendingMissing = null;

  /**
   * The passage a pending navigation has to open at, or `null`.
   *
   * A search result names a place no route can carry: the hits live in the
   * body's text, and an address holds only a chapter. Opening one with
   * `Enter` therefore navigates by id alone and queues the place here — the
   * query to mark the article with and the ordinal to walk to — for the
   * render the navigation causes to consume. One navigation, one queue: like
   * `pendingMissing` it is taken once and never replayed, so a later
   * navigation can never inherit a jump that was not its own.
   */
  var pendingJump = null;

  /**
   * Queue the chapter a click on a broken reference asked for, and say so at
   * once.
   *
   * Only a click reports a broken reference this way. Hovering one opens the
   * preview panel with a notice instead, because a hint about the link under
   * the pointer belongs beside it. A click navigates, so its message is
   * queued for the render it triggers — shown now, it would be dismissed by
   * the navigation that follows it.
   */
  function queueMissingChapter(message) {
    pendingMissing = { docId: message.docId, anchor: message.anchor };
    showMissingChapter(message);
  }

  /** Queue the passage a search result names for the render it causes. */
  function queueJump(jump) {
    pendingJump = jump || null;
  }

  /**
   * An unlock anywhere in the reader re-renders the document the reader is
   * looking at: the sealed placeholder they saw is the full body now. The
   * route still names the document, so the address bar keeps its say — an
   * arrival that carried a chapter finally reaches it here. A navigation
   * away leaves the other document untouched, and the unlock still stands:
   * its password is in the session, so coming back is a quiet success.
   */
  function revealUnlocked(id) {
    if (!currentId || currentId !== id) {
      return;
    }
    // The route has not moved, so a plain render would see no change;
    // dropping the id makes the next render rebuild the article from the
    // model the password just opened.
    currentId = null;
    render();
  }

  /** Whether `id` is the document on screen — the session's silent guard. */
  function isCurrent(id) {
    return currentId === id;
  }

  /** The document the reader is looking at, or `null`. */
  function currentDoc() {
    return currentId ? store.peek(currentId) : null;
  }

  /**
   * Walk the reader to `route`'s chapter without rebuilding the document.
   *
   * Used when the requested address is the one already showing: the browser
   * fires no `hashchange` for it, and a render here would tear the article down
   * and put a fresh copy back — losing the very scroll position it had just
   * been asked to reach. The document is already the right one, so only the
   * chapter is resolved. An unknown document or chapter is not an error: the
   * reader stays where they are, exactly as a navigation to nothing would.
   */
  function scrollToAnchorOnly(route) {
    var jump = pendingJump;
    pendingJump = null;

    var doc = route && route.id ? store.peek(route.id) : null;
    if (!doc) {
      return;
    }

    docList.render(null, doc.id);
    localGraph.setActive(doc.id);
    globalGraph.setActive(doc.id);

    if (!route.anchor) {
      if (typeof globalThis.scrollTo === "function") {
        globalThis.scrollTo(0, 0);
      }
    } else {
      scrollToAnchor(findAnchor(doc, route.anchor));
    }

    // The document is already the right one, so a jump is a marking and a
    // walk, not a render: the marks a previous arrival left go first, and
    // the passage the reader just asked for is applied to the body on
    // screen. A navigation that is not a jump takes the page back as
    // authored.
    onArrive(jump);
  }

  /**
   * Scroll to `anchor` once more after the document has settled.
   *
   * A render inserts markup whose height keeps changing for a moment: diagrams
   * replace their source blocks asynchronously, images arrive, fonts reflow.
   * The scroll a render performs is therefore only the first attempt, and it
   * can leave the reader short of the chapter. Two frames later the layout is
   * stable enough to correct it. Environments without
   * `requestAnimationFrame` — the node tests — get the single attempt.
   */
  function settleAtAnchor(doc, anchor, frames) {
    if (!anchor) {
      return;
    }

    var remaining = typeof frames === "number" ? frames : 2;
    if (
      remaining <= 0 ||
      typeof globalThis.requestAnimationFrame !== "function"
    ) {
      scrollToAnchor(findAnchor(doc, anchor));
      return;
    }

    globalThis.requestAnimationFrame(function () {
      scrollToAnchor(findAnchor(doc, anchor));
      settleAtAnchor(doc, anchor, remaining - 1);
    });
  }

  function navigate(id, anchor) {
    onCloseDrawer();
    var hash = Router.formatHash(id, anchor);
    // Compared as routes, not as strings: the address bar may hold either
    // spelling of the same chapter, and only a *different* route makes the
    // browser fire `hashchange`.
    if (Links.isSameRoute(globalThis.location.hash, hash)) {
      // The address already says this: setting it again would fire nothing, so
      // the chapter is walked to directly instead of through a render.
      scrollToAnchorOnly(Router.resolveRoute(hash, ids, home));
      return;
    }

    globalThis.location.hash = hash;
  }

  /**
   * Say that the document of `message` has no chapter `message.anchor`.
   *
   * Only a navigation calls this: a click on a broken reference, whose queued
   * message `render` replays once the document is on screen. Hovering the same
   * reference never gets here — it is answered by the preview panel's notice.
   */
  function showMissingChapter(message) {
    banner.show({
      docId: message && message.docId ? String(message.docId) : "",
      anchor: message && message.anchor ? String(message.anchor) : "",
    });
  }

  /**
   * Resolve `anchor` against `doc` and the live document.
   *
   * The route normally carries the anchor the build wrote, which is the heading
   * id itself; an artifact from an older build may still carry the author's
   * spelling, so the payload's outline is consulted as well. `null` means the
   * document really has no such chapter.
   */
  function findAnchor(doc, anchor) {
    return Anchor.resolveDocAnchor(doc, anchor, function (id) {
      return document.getElementById(id);
    });
  }

  /**
   * Park the document at `anchor`, which `findAnchor` has already resolved.
   *
   * A chapter the reader folded away is `hidden`, and nothing scrolls to a
   * hidden element: a deep link, an outline entry or a block reference pointing
   * inside a folded chapter would open the document at the top and say
   * nothing. Reopening the chapters that hold it first is what keeps every
   * route working, and it is the reader's own request that reopens them.
   */
  function scrollToAnchor(found) {
    if (!found || !found.element) {
      return;
    }

    var body = content.querySelector("." + DocBody.BODY_CLASS);
    if (body) {
      DocBody.expandTo(body, found.element);
    }

    if (found.element.scrollIntoView) {
      found.element.scrollIntoView({ block: "start" });
    }
  }

  /**
   * Place the document `route` names, already fetched, and walk to its chapter.
   *
   * Everything a navigation ends with happens here: the body, the outline, the
   * title, the anchor scroll, the address canonicalisation and the focus. The
   * parts that belong to a document change are guarded by `changed`, so a
   * re-anchor of the document on screen keeps its scroll position, its table
   * sorts and its fold states.
   */
  function place(route, doc, wanted, changed, jump) {
    var locked = docRender.isLocked(doc);
    if (changed) {
      if (locked) {
        docRender.renderLocked(doc);
        // A password the session already holds is tried before the reader
        // has to ask: one that fits re-renders through the notification.
        session.attemptSilentUnlock(doc);
      } else {
        docRender.renderDocument(doc);
      }
      toc.render(doc.toc, doc.id);
      // The reverse references are public build data — the links were
      // resolved before any body was sealed — so a locked document lists
      // what points at it the same as an open one.
      backlinks.render(doc.id);
      document.title = doc.title ? doc.title + " · " + siteTitle : siteTitle;
    }

    // A block reference whose chapter the document does not have still opens
    // the document, at the top, and says what was asked for. A click on such a
    // reference leaves no anchor in the route — the build cannot address a
    // chapter that has no element — so the queued message stands in for it.
    // A sealed document resolves no anchor either, but the lock is the
    // reason its outline is empty, so the missing-chapter message would be a
    // lie about why nothing was reached.
    var found = locked ? null : findAnchor(doc, route.anchor);
    if (found) {
      scrollToAnchor(found);
      // Fresh markup changes height while it settles — that is what diagrams
      // and images do — so the chapter is walked to again once it has.
      settleAtAnchor(doc, route.anchor);
    } else if (!locked && wanted && wanted.anchor) {
      showMissingChapter(wanted);
      // The document is opened from its top: there is no chapter to scroll to.
      if (typeof globalThis.scrollTo === "function") {
        globalThis.scrollTo(0, 0);
      } else {
        var scrolling = document.scrollingElement || document.documentElement;
        scrolling.scrollTop = 0;
      }
    }

    // The jump lands last: the body is on screen, an anchor walk above has
    // had its say, and the reader's newest request is the passage the search
    // named. Without a jump the page is taken back as authored — the marks
    // of an arrival do not follow the reader into the reading.
    onArrive(jump);

    if (!route.known) {
      // Canonicalise the address bar without adding a history entry. Some
      // browsers refuse `replaceState` on `file://`; the page still works.
      try {
        globalThis.history.replaceState(null, "", Router.formatHash(route.id));
      } catch (_error) {
        /* Keep the hash the user arrived with. */
      }
    }

    if (changed && !firstRender) {
      content.focus({ preventScroll: true });
    }
    firstRender = false;
  }

  function render() {
    var route = Router.resolveRoute(globalThis.location.hash, ids, home);

    // A message queued by a click is only valid for the render it triggered:
    // take it now, so a later navigation can never replay it.
    var queued = pendingMissing;
    pendingMissing = null;

    // A search jump rides the navigation it asked for: taken once, here, so
    // the render that follows is the only one that can apply it.
    var jump = pendingJump;
    pendingJump = null;

    if (!route.id) {
      banner.hide();
      article.textContent = "";
      var empty = document.createElement("p");
      empty.className = "doc-empty";
      empty.textContent = "This site has no documents.";
      article.appendChild(empty);
      docList.render(null, null);
      // No document is on screen, so the panel answers nothing: the empty
      // panel is a cleared one, without a message about a document that
      // does not exist.
      backlinks.render(null);
      return;
    }

    docList.render(null, route.id);
    localGraph.setActive(route.id);
    globalGraph.setActive(route.id);

    // A banner explains the *previous* navigation, so it never outlives it.
    banner.hide();

    var wanted = route.anchor
      ? { docId: route.id, anchor: route.anchor }
      : queued;
    var changed = route.id !== currentId;
    currentId = route.id;

    // The document on hand is placed at once — every navigation in the
    // embedded formats, and any revisit in the split one. A document that has
    // to travel first shows the wait, and the answer is dropped when a newer
    // navigation has taken the article over by the time it lands.
    var doc = store.peek(route.id);
    if (doc) {
      place(route, doc, wanted, changed, jump);
      return;
    }

    if (changed) {
      docRender.renderLoading(route.id);
    }

    store.get(route.id).then(function (loaded) {
      // A navigation that happened while the chunk was in flight owns the
      // article now; this one is out of date.
      if (currentId !== route.id) {
        return;
      }
      if (!loaded) {
        docRender.renderLoadError(route);
        return;
      }

      place(route, loaded, wanted, changed, jump);
    });
  }

  return {
    navigate: navigate,
    render: render,
    queueMissingChapter: queueMissingChapter,
    queueJump: queueJump,
    revealUnlocked: revealUnlocked,
    isCurrent: isCurrent,
    currentDoc: currentDoc,
  };
}
