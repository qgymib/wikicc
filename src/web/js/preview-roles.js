/**
 * The content states of the hover preview: what the panel shows for the link
 * under the pointer.
 *
 * The same frame serves the states. A reference whose chapter exists shows
 * the chapter's content; one without a chapter shows the document it names
 * whole; a reference the build already marked as broken shows a notice naming
 * the chapter that is missing instead. The notice is a hint about the link
 * under the pointer, so it is shaped like a tooltip and never like the banner:
 * that one explains a navigation, and is raised on click.
 *
 * In the split format the document a reference names may not be on the page
 * yet, and waiting for its file before showing anything would put the network
 * between the pointer and the panel. So the panel opens at once with a loading
 * state — a spinner and the document's name, which the manifest carries before
 * any chunk travels — and the answer fills it when it arrives. An answer that
 * is not a preview is not silence either: a fetch that failed turns the panel
 * into an error notice that invites another hover, which retries, and a
 * document without the hovered chapter says so the way a reference the build
 * marked as broken does.
 *
 * One more state answers the encrypted site: a reference into a document the
 * build sealed opens the panel with a password form instead of a preview or a
 * notice. The head still names the document — the one thing the payload says
 * in public — and the body is the form the reader answers in place. A
 * password the session already holds is tried quietly before anything is
 * typed; one that fits fills the panel with the chapter, and one that does
 * not says so where the typing was. The chapter that follows is the ordinary
 * preview, built from the model the password opened, so unlocking here shows
 * what a hover on a public reference would have shown.
 *
 * A role is one attribute on the frame's root — `data-missing`, `data-loading`
 * or `data-error`, and none of them for a preview — plus the accessible name
 * that goes with it and `aria-busy` while a document is on its way. Only
 * attributes and visible text change, so the element the page already holds
 * is reused and no role can leave a mark on another: every entry writes the
 * whole role, which is what keeps a loading mark from surviving into the
 * notice that replaced it.
 *
 * The attempt a password makes belongs to the controller: the store decrypts
 * and the session's memory keeps what opened a document, which is the same
 * door the lock page's dialog answers through. The panel only reports what a
 * password did. `passwordCandidates` reads the same session's table, so a
 * password the reader typed anywhere is tried quietly here before the panel
 * asks for one.
 *
 * This module decides *what the panel shows* and nothing else: when the frame
 * appears, moves or is held is `preview-gestures.js`'s business, the frame
 * and its geometry are `preview-panel.js`'s, and the composer
 * (`preview-view.js`) hands this module the store, the theme and the unlock
 * door it reports through.
 */
import * as Links from "./links.js";
import * as Preview from "./preview.js";
import * as DocBody from "./doc-body.js";
import {
  MISSING_TITLE,
  PREVIEW_LABEL,
  UNLOCK_SUBMIT_TEXT,
} from "./preview-panel.js";

/**
 * Attribute marking the popover as a notice rather than a preview.
 *
 * The element is the same one in both roles — one popover, built once — so the
 * stylesheet needs one bit to know which of the two it is drawing. The reader
 * sets it before showing a notice and removes it before showing a preview, so
 * a reference followed by a sound one never leaves a warning frame behind.
 */
export var MISSING_ATTRIBUTE = "data-missing";

/** Accessible name of the popover while it shows a notice. */
export var MISSING_LABEL = "Broken reference";

/** Attribute marking the popover as loading, used by the stylesheet. */
export var LOADING_ATTRIBUTE = "data-loading";

/** Accessible name of the popover while it loads a document. */
export var LOADING_LABEL = "Loading preview";

/** Attribute marking the popover as showing the error state. */
export var ERROR_ATTRIBUTE = "data-error";

/** Accessible name of the popover while it shows the error state. */
export var FAILED_LABEL = "Preview failed";

/** Attribute marking the popover as showing the locked state. */
export var LOCKED_ATTRIBUTE = "data-locked";

/** Accessible name of the popover while it shows the locked state. */
export var LOCKED_LABEL = "Locked chapter";

/** Text of the unlock button while an attempt is running. */
export var UNLOCK_BUSY_TEXT = "Unlocking\u2026";

/**
 * Fill one preview with its content.
 *
 * `session` is the composer-owned pair `{ anchor, pending }` the answers gate
 * on, `panel` the frame API the states fill, `gestures` the claim an answered
 * form puts on the panel. `documents` is the reader's store, `theme` the
 * theme in effect, `onUnlock` the door a password goes through and
 * `passwordCandidates` the session's table of what already opened a document.
 */
export function createPreviewRoles(deps) {
  var session = deps.session;
  var panel = deps.panel;
  var gestures = deps.gestures;
  var documents = deps.documents || null;
  var theme =
    deps.theme ||
    function () {
      return null;
    };
  var onUnlock = deps.onUnlock || null;
  var passwordCandidates = deps.passwordCandidates || null;

  // Whether an unlock attempt is running: the form is busy — no second
  // submit, no retype — until the answer arrives.
  var unlocking = false;
  // The quiet attempts in flight, by document id: one per document at a
  // time, so a panel that reopens mid-attempt never stacks a second one.
  var quietUnlocks = new Map();

  /** The destination `link` addresses, or `null` when it is no document link. */
  function destinationOf(link) {
    return Links.parseDocLink(link.getAttribute("href"));
  }

  /** The notice `link` was marked with by the build, or `null`. */
  function missingOf(link, destination) {
    if (!taggedMissing(link)) {
      return null;
    }

    return {
      kind: "missing",
      docId: destination.id,
      anchor: Links.missingAnchorOf(
        link.getAttribute(Links.MISSING_ANCHOR_ATTRIBUTE),
      ),
    };
  }

  /**
   * Tag the broken references of `root` themselves.
   *
   * The build writes the mark on a `<span>` right before the link, keeping
   * it out of the anchor itself; copying it here leaves the markup in the
   * document free of reader-only state and lets every handler read one
   * attribute from the anchor it already has.
   *
   * Returns whether `link` carries — or was just given — the mark.
   */
  function taggedMissing(link) {
    if (
      Links.missingAnchorOf(link.getAttribute(Links.MISSING_ANCHOR_ATTRIBUTE))
    ) {
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

  /** Fill the panel with `preview` and put it beside `link`. */
  function showPreview(preview, link) {
    panel.ensure();
    // The panel wears one of four roles; a preview must not inherit the
    // notice frame, the loading mark or the error frame a previous hover
    // left on it.
    setRole("preview");
    panel.title().textContent = preview.title;
    panel.path().textContent = preview.path;

    // The chapter reaches the page the way the article does — the shared
    // document-body render fills the panel's standing body and enhances the
    // tables right after the markup exists — and the diagrams are drawn for
    // the theme in effect, the step that measures against the layout.
    DocBody.fillDocBody(panel.body(), preview.html, { enhanceTables: true });
    DocBody.drawDiagrams(panel.body(), theme());
    DocBody.drawMath(panel.body());

    show(link);
  }

  function open(link) {
    var destination = destinationOf(link);
    if (!destination) {
      return;
    }

    // A reference the build could not resolve is recognised from its mark
    // rather than from the `href`: the route deliberately carries no anchor
    // (no element emits one), so re-parsing it would only ever say "the whole
    // document". The mark is read before the anchor is consulted for the
    // same reason — a broken reference's route also carries none, and the
    // notice it owes must not be mistaken for a request for the document.
    var missing = missingOf(link, destination);
    if (missing) {
      openNotice(link, missing);
      return;
    }

    // A reference into a sealed document has no markup to preview yet: the
    // panel opens in its locked state and the password form decides what it
    // becomes. The store knows the seal from the payload alone — the
    // embedded entry carries the blob, the pages manifest carries the mark —
    // so the answer needs no fetch first, whatever the format.
    if (
      documents &&
      typeof documents.isEncrypted === "function" &&
      documents.isEncrypted(destination.id)
    ) {
      openLocked(destination, link);
      return;
    }

    if (!destination.anchor) {
      // A reference without a chapter names the whole document, and the panel
      // shows it whole: the same window a chapter reference opens, opened
      // onto the document instead of onto one chapter of it.
      whenArrived(destination, link, Preview.createDocumentPreview);
      return;
    }

    whenArrived(destination, link, function (doc) {
      return Preview.createPreview(doc, destination.anchor);
    });
  }

  /**
   * Answer `link` with the preview `build` makes of the document it names.
   *
   * The document on hand answers at once, which is every hover in the
   * embedded formats and every revisit in the split one. Otherwise — and only
   * in the split format, where the file can still arrive — the panel opens at
   * once with its loading state, and the answer fills it when the file gets
   * here. The answer re-checks the link it belongs to, because the pointer
   * may have moved on while it travelled — a close or a newer hover clears
   * the pending link, and an answer for a link nobody points at any more
   * would be a surprise, not a preview.
   *
   * The answers that are not previews are handled, not swallowed: a fetch
   * that failed turns the panel into its error state, which a later hover
   * retries because the store keeps no failed request; a document without
   * the hovered chapter says so through the notice a broken reference wears.
   * In the embedded formats a document the payload does not hold does not
   * exist — no request could produce it — and the panel stays closed, the
   * silence it has always been.
   */
  function whenArrived(destination, link, build) {
    var doc = documents ? documents.peek(destination.id) : null;
    var preview = build(doc);
    if (preview) {
      // A sealed model answers a locked shape instead of markup: the panel
      // asks for the password rather than pretending the chapter is missing.
      // The entry the store holds is the payload's own word, so this stays
      // the answer even where the manifest said nothing.
      if (preview.locked) {
        openLocked(destination, link);
        return;
      }
      showPreview(preview, link);
      return;
    }

    if (!documents || typeof documents.get !== "function") {
      return;
    }

    // A document already in hand whose chapter does not build is a final
    // answer — the chapter is not there — and stays silent, whatever the
    // format: the panel has never opened for it and does not start now.
    var lazy = typeof documents.isLazy === "function" && documents.isLazy();
    if (doc) {
      return;
    }

    var travelling = documents.get(destination.id);
    if (!travelling || typeof travelling.then !== "function") {
      return;
    }

    if (lazy) {
      showLoading(destination, link);
    }

    travelling.then(function (loaded) {
      if (session.pending !== link && session.anchor !== link) {
        return;
      }

      var arrived = loaded ? build(loaded) : null;
      if (arrived) {
        if (arrived.locked) {
          openLocked(destination, link);
          return;
        }
        showPreview(arrived, link);
        return;
      }

      if (!lazy) {
        return;
      }

      if (!loaded) {
        showError(link);
        return;
      }

      openNotice(link, {
        docId: destination.id,
        anchor: destination.anchor,
      });
    });
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
    panel.ensure();
    setRole("missing");
    // Nothing of a previous preview, loading mark or error may survive: the
    // notice owns the panel.
    panel.body().textContent = "";
    panel.title().textContent = MISSING_TITLE;
    panel.path().textContent = resolved.docId ? String(resolved.docId) : "";
    panel.noticeChapter().textContent = resolved.anchor
      ? String(resolved.anchor)
      : "";
    panel.noticeDoc().textContent = resolved.docId
      ? String(resolved.docId)
      : "";

    show(link);
  }

  /**
   * Show the panel beside `link` with its loading state, for a document the
   * split build has not put on the page yet.
   *
   * The head names the document from the manifest — the one thing about it the
   * page already holds — and the body is the spinner, so the panel is on
   * screen the moment the hover matures instead of after the chunk travels.
   */
  function showLoading(destination, link) {
    panel.ensure();
    setRole("loading");
    // Nothing of a previous preview, notice or error may survive: the loading
    // state owns the panel until the document arrives.
    panel.body().textContent = "";
    panel.title().textContent = titleOf(destination.id);
    panel.path().textContent = destination.id;

    show(link);
  }

  /**
   * Turn the panel's loading state into its error state.
   *
   * The panel is already on screen for this link — the answer only reaches
   * here through the guard that says so — so the head keeps the document's
   * name and only the body changes: the spinner gives way to what went wrong
   * and what the reader can do about it.
   */
  function showError(link) {
    panel.ensure();
    setRole("error");
    panel.body().textContent = "";

    show(link);
  }

  /**
   * Show the panel beside `link` in its locked state, for a document the
   * build sealed.
   *
   * The head names the document the reference points at — the one thing the
   * payload still says in public — and the body is the password form. A
   * password the session already holds is tried quietly before the reader
   * has to type: one that fits replaces this state with the chapter itself.
   */
  function openLocked(destination, link) {
    panel.ensure();
    setRole("locked");
    // Nothing of a previous preview, notice, loading mark or error may
    // survive: the locked state owns the panel.
    panel.body().textContent = "";
    panel.title().textContent = titleOf(destination.id);
    panel.path().textContent = destination.id;
    resetUnlockForm();

    show(link);
    attemptQuietUnlock(destination, link);
  }

  /** Clear the locked state's form: no text, no error, no running attempt. */
  function resetUnlockForm() {
    unlocking = false;
    var input = panel.unlockInput();
    var submit = panel.unlockSubmit();
    var errorLine = panel.unlockError();
    if (!input || !submit || !errorLine) {
      return;
    }

    input.value = "";
    input.disabled = false;
    submit.disabled = false;
    submit.textContent = UNLOCK_SUBMIT_TEXT;
    errorLine.hidden = true;
  }

  /** Turn the form's busy state on and off: no retype while an attempt runs. */
  function setUnlocking(value) {
    unlocking = !!value;
    var input = panel.unlockInput();
    var submit = panel.unlockSubmit();
    if (!input || !submit) {
      return;
    }

    input.disabled = unlocking;
    submit.disabled = unlocking;
    submit.textContent = unlocking ? UNLOCK_BUSY_TEXT : UNLOCK_SUBMIT_TEXT;
  }

  /** The reader is retyping: a failed attempt's answer stops applying. */
  function onUnlockInput() {
    var errorLine = panel.unlockError();
    if (errorLine) {
      errorLine.hidden = true;
    }
  }

  /**
   * The password form's answer: unlock the document where the panel stands.
   *
   * The attempt belongs to the controller's `onUnlock`, the same door the
   * lock page's dialog answers through, so a password that opened its
   * document is remembered for the session by the same hand. The answer is
   * one of two: the chapter takes the panel, or the error line asks for
   * another password. A "no" from a document that is no longer sealed is the
   * race a quiet attempt won while the reader was still typing — the
   * document opened elsewhere, and no error may claim the password failed.
   */
  function onUnlockSubmit(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }

    var input = panel.unlockInput();
    if (
      !panel.isBuilt() ||
      panel.root().hidden ||
      !session.anchor ||
      unlocking ||
      typeof onUnlock !== "function" ||
      !input
    ) {
      return;
    }

    var password = input.value;
    var destination = destinationOf(session.anchor);
    if (!destination || !password) {
      return;
    }

    // An answered form is a claimed panel: the attempt runs where the reader
    // left it, and the delays stop applying while it does.
    gestures.claim();
    var link = session.anchor;
    setUnlocking(true);
    Promise.resolve()
      .then(function () {
        return onUnlock(destination.id, password);
      })
      .then(function (unlocked) {
        setUnlocking(false);
        if (
          !unlocked &&
          (!documents ||
            typeof documents.isEncrypted !== "function" ||
            documents.isEncrypted(destination.id))
        ) {
          // Still sealed, and the password did not open it: the reader's to
          // retype, and the line names the failure while they do.
          var errorLine = panel.unlockError();
          if (errorLine) {
            errorLine.hidden = false;
          }
          return;
        }

        resetUnlockForm();
        showUnlockedChapter(destination, link);
      })
      .catch(function (_error) {
        // A failed attempt is a retryable one: the panel does not close for
        // an answer the store could not give.
        setUnlocking(false);
        var errorLine = panel.unlockError();
        if (errorLine) {
          errorLine.hidden = false;
        }
      });
  }

  /**
   * Try the passwords the session already holds, quietly, in order.
   *
   * A site whose articles share one password asks for it once — on whatever
   * document the reader unlocked first — so the attempt starts as soon as
   * the locked panel paints and answers into the panel it belongs to: a
   * pointer that has moved on cancels the answer, the way a travelling
   * document's does. One attempt per document runs at a time; nothing here
   * writes the passwords anywhere but the session's own memory.
   */
  function attemptQuietUnlock(destination, link) {
    var id = destination.id;
    if (
      typeof onUnlock !== "function" ||
      typeof passwordCandidates !== "function"
    ) {
      return;
    }

    if (quietUnlocks.has(id)) {
      return;
    }

    var passwords = passwordCandidates(id);
    if (!passwords || !passwords.length) {
      return;
    }

    var attempt = passwords.reduce(function (chain, password) {
      return chain.then(function (opened) {
        if (opened) {
          return true;
        }
        return Promise.resolve()
          .then(function () {
            return onUnlock(id, password);
          })
          .then(function (unlocked) {
            return !!unlocked;
          });
      });
    }, Promise.resolve(false));

    quietUnlocks.set(id, attempt);
    var forget = function () {
      quietUnlocks.delete(id);
    };
    attempt.then(forget, forget);

    attempt.then(function (opened) {
      if (opened && (session.pending === link || session.anchor === link)) {
        showUnlockedChapter(destination, link);
      }
    });
  }

  /**
   * Replace the locked state with the chapter the password opened.
   *
   * The document is the full model now, so the same selection the hover
   * asked for at first answers with real markup: a chapter reference shows
   * its chapter, a document reference shows the document whole. A pointer
   * that has moved on cancels the answer, and a model that still fails to
   * build leaves the locked state up rather than flashing an empty panel.
   */
  function showUnlockedChapter(destination, link) {
    if (session.pending !== link && session.anchor !== link) {
      return;
    }

    var doc =
      documents && typeof documents.peek === "function"
        ? documents.peek(destination.id)
        : null;
    var preview = destination.anchor
      ? Preview.createPreview(doc, destination.anchor)
      : Preview.createDocumentPreview(doc);
    if (preview && !preview.locked) {
      showPreview(preview, link);
    }
  }

  /** The name the payload gives `id`, or the id itself when it does not. */
  function titleOf(id) {
    if (documents && typeof documents.title === "function") {
      var named = documents.title(id);
      if (named) {
        return String(named);
      }
    }

    return id;
  }

  /**
   * Switch the panel between the four roles it can play.
   *
   * A role is one attribute on the panel root — `data-missing`, `data-loading`
   * or `data-error`, and none of them for a preview — plus the accessible name
   * that goes with it and `aria-busy` while a document is on its way. Only
   * attributes and visible text change, so the element the page already holds
   * is reused and no role can leave a mark on another: every entry writes the
   * whole role, which is what keeps a loading mark from surviving into the
   * notice that replaced it.
   */
  function setRole(role) {
    var root = panel.root();

    if (role === "missing") {
      root.setAttribute(MISSING_ATTRIBUTE, "true");
    } else {
      root.removeAttribute(MISSING_ATTRIBUTE);
    }

    if (role === "loading") {
      root.setAttribute(LOADING_ATTRIBUTE, "true");
      root.setAttribute("aria-busy", "true");
    } else {
      root.removeAttribute(LOADING_ATTRIBUTE);
      root.removeAttribute("aria-busy");
    }

    if (role === "error") {
      root.setAttribute(ERROR_ATTRIBUTE, "true");
    } else {
      root.removeAttribute(ERROR_ATTRIBUTE);
    }

    if (role === "locked") {
      root.setAttribute(LOCKED_ATTRIBUTE, "true");
    } else {
      root.removeAttribute(LOCKED_ATTRIBUTE);
    }

    var label = PREVIEW_LABEL;
    if (role === "missing") {
      label = MISSING_LABEL;
    } else if (role === "loading") {
      label = LOADING_LABEL;
    } else if (role === "error") {
      label = FAILED_LABEL;
    } else if (role === "locked") {
      label = LOCKED_LABEL;
    }
    root.setAttribute("aria-label", label);
  }

  /**
   * Put the panel on screen beside `link`, whatever it currently shows.
   *
   * The panel describes one link at a time, so the link it described before is
   * released first: moving the pointer from a sound reference to a broken one
   * must not leave the first announcing an expanded popover it no longer has.
   */
  function show(link) {
    if (session.anchor && session.anchor !== link) {
      session.anchor.setAttribute("aria-expanded", "false");
    }

    session.anchor = link;
    panel.present();
    // Position after insertion, so `offsetWidth`/`offsetHeight` are known.
    panel.position(link);

    if (link) {
      link.setAttribute("aria-expanded", "true");
    }
  }

  /**
   * Empty the panel back to its rest state, the way a close leaves it.
   *
   * Every role is cleared, not just the one that was showing: the next
   * hover fills in what it needs, and a closed panel holds a stale message
   * whether or not it is visible. The locked state's form is a closed
   * panel's business too: a password half-typed belongs to the showing it
   * was typed for, and no field of this one survives into the next.
   */
  function reset() {
    setRole("preview");
    panel.body().textContent = "";
    panel.title().textContent = "";
    panel.path().textContent = "";
    panel.noticeChapter().textContent = "";
    panel.noticeDoc().textContent = "";
    resetUnlockForm();
  }

  /** Forget the running attempts; the frame's nodes are the panel's to drop. */
  function dispose() {
    unlocking = false;
    quietUnlocks.clear();
  }

  return {
    /** Open the panel for `link`, as the gesture timers' matured hovers do. */
    open: open,
    /** Whether `link` carries — or was just given — the broken mark. */
    taggedMissing: taggedMissing,
    /** The locked state's form answers, wired to the frame by the composer. */
    onUnlockSubmit: onUnlockSubmit,
    onUnlockInput: onUnlockInput,
    /** Empty the panel back to its rest state, the way a close leaves it. */
    reset: reset,
    dispose: dispose,
  };
}
