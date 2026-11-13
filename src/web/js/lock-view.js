/**
 * The unlock dialog: one modal asking for the password of a sealed document.
 *
 * The lock page shows a sealed document's title and nothing else; selecting
 * the title opens this dialog. It is a plain modal — a backdrop over the
 * page, a panel with a password field, a cancel and an unlock action — and
 * it owns nothing about decryption: whether a password opens the document
 * is `onSubmit`'s answer, so the dialog stays a view and the session state
 * (the password table, the store) stays with the controller.
 *
 * The contract with the reader: `open` names the document and takes the
 * element to hand focus back to; the field starts empty and focused; a
 * wrong password is a red line above the actions and the reader can retry
 * where they stood; a success closes and returns the focus; Escape and
 * Cancel close without any attempt. While an attempt runs the actions are
 * disabled and the field is left alone — a key derivation cannot be
 * interrupted, so the dialog says what it is doing instead of pretending.
 *
 * The field is cleared whenever the dialog closes: a password typed for one
 * document must not linger in the DOM for the next reader of the same page,
 * and the session table that would remember it is memory-only by design.
 *
 * Built once when the reader starts and only toggled afterwards, like the
 * banner: showing it never reflows the article. The DOM is touched only
 * through the `document` passed in, which is what keeps the view testable
 * without a browser.
 */

/** Class of the backdrop that covers the page while the dialog is open. */
export var OVERLAY_CLASS = "unlock-overlay";

/** Class of the dialog panel. */
export var DIALOG_CLASS = "unlock-dialog";

/** Class of the line that names the document being unlocked. */
export var LEDE_CLASS = "unlock-lede";

/** Class of the line that reports a failed attempt. */
export var ERROR_CLASS = "unlock-error";

/** Id of the password field, shared by its label. */
export var INPUT_ID = "unlock-password";

/** What the error line says when the password does not authenticate. */
var WRONG_PASSWORD_MESSAGE = "That password did not unlock this document.";

/** What the error line says when an attempt failed for any other reason. */
var UNAVAILABLE_MESSAGE = "The document could not be unlocked.";

/**
 * Create the unlock dialog.
 *
 * `host` is the element the dialog mounts to — the page body, so the
 * backdrop can cover the whole reader. `onSubmit(password, doc)` carries
 * the attempt: it resolves `true` when the document opened, `false` when
 * the password did not authenticate, and rejects when the attempt failed
 * for a reason no password can fix. `document` exists for tests.
 */
export function createUnlockDialog(options) {
  var host = options.host;
  var doc = options.document || globalThis.document;
  var onSubmit = options.onSubmit;

  var currentDoc = null;
  var openerElement = null;
  var busy = false;

  var root = doc.createElement("div");
  root.className = OVERLAY_CLASS;
  root.hidden = true;

  var dialog = doc.createElement("div");
  dialog.className = DIALOG_CLASS;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "unlock-heading");

  var heading = doc.createElement("h2");
  heading.className = "unlock-heading";
  heading.setAttribute("id", "unlock-heading");
  heading.textContent = "Unlock this document";

  var lede = doc.createElement("p");
  lede.className = LEDE_CLASS;

  var form = doc.createElement("form");
  form.className = "unlock-form";

  var label = doc.createElement("label");
  label.className = "unlock-label";
  label.setAttribute("for", INPUT_ID);
  label.textContent = "Password";

  var input = doc.createElement("input");
  input.className = "unlock-input";
  input.setAttribute("id", INPUT_ID);
  input.setAttribute("type", "password");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  var error = doc.createElement("p");
  error.className = ERROR_CLASS;
  error.setAttribute("role", "alert");
  error.hidden = true;

  var actions = doc.createElement("div");
  actions.className = "unlock-actions";

  var cancel = doc.createElement("button");
  cancel.className = "unlock-cancel";
  cancel.setAttribute("type", "button");
  cancel.textContent = "Cancel";

  var submit = doc.createElement("button");
  submit.className = "unlock-submit";
  submit.setAttribute("type", "submit");
  submit.textContent = "Unlock";

  form.appendChild(label);
  form.appendChild(input);
  form.appendChild(error);
  actions.appendChild(cancel);
  actions.appendChild(submit);
  form.appendChild(actions);
  dialog.appendChild(heading);
  dialog.appendChild(lede);
  dialog.appendChild(form);
  root.appendChild(dialog);
  host.appendChild(root);

  /** Say the attempt failed, and put the reader back where they typed. */
  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    if (typeof input.focus === "function") {
      input.focus();
    }
    if (typeof input.select === "function") {
      input.select();
    }
  }

  /** Flip the actions into (or out of) their waiting state. */
  function setBusy(waiting) {
    submit.disabled = waiting;
    cancel.disabled = waiting;
    submit.textContent = waiting ? "Unlocking\u2026" : "Unlock";
  }

  /** Leave the dialog: the field and the error are emptied with it. */
  function close() {
    if (root.hidden) {
      return;
    }

    root.hidden = true;
    input.value = "";
    error.hidden = true;
    error.textContent = "";
    currentDoc = null;
    busy = false;
    setBusy(false);
    if (openerElement && typeof openerElement.focus === "function") {
      openerElement.focus();
    }
    openerElement = null;
  }

  function onCancelClick(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    close();
  }

  function onSubmitEvent(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (busy) {
      return;
    }

    var password = typeof input.value === "string" ? input.value : "";
    busy = true;
    setBusy(true);
    Promise.resolve()
      .then(function () {
        return onSubmit(password, currentDoc);
      })
      .then(function (unlocked) {
        busy = false;
        setBusy(false);
        if (unlocked) {
          close();
          return;
        }
        // The reader may have closed the dialog while the attempt was
        // running — an escape during a derivation cannot be undone. A
        // verdict for nobody must not reopen anything or steal the focus.
        if (root.hidden) {
          return;
        }
        fail(WRONG_PASSWORD_MESSAGE);
      })
      .catch(function (_error) {
        busy = false;
        setBusy(false);
        if (root.hidden) {
          return;
        }
        fail(UNAVAILABLE_MESSAGE);
      });
  }

  function onFieldInput() {
    // The error described the last attempt; typing is a new one.
    error.hidden = true;
  }

  function onRootKeydown(event) {
    if (event && event.key === "Escape") {
      close();
    }
  }

  form.addEventListener("submit", onSubmitEvent);
  cancel.addEventListener("click", onCancelClick);
  input.addEventListener("input", onFieldInput);
  root.addEventListener("keydown", onRootKeydown);

  return {
    /**
     * Ask for the password of the sealed document `doc`.
     *
     * `opener` is the element the reader used — the lock page's title —
     * and takes the focus back when the dialog goes away, whichever way it
     * goes. Opening an open dialog is a no-op: one modal, not a stack.
     */
    open: function (doc_, opener) {
      if (!root.hidden) {
        return;
      }

      currentDoc = doc_ || null;
      openerElement = opener || null;
      input.value = "";
      error.hidden = true;
      error.textContent = "";
      lede.textContent =
        currentDoc && currentDoc.title
          ? '"' +
            currentDoc.title +
            '" is encrypted. Enter its password to read it.'
          : "This document is encrypted. Enter its password to read it.";
      root.hidden = false;
      if (typeof input.focus === "function") {
        input.focus();
      }
    },
    close: close,
    isOpen: function () {
      return !root.hidden;
    },
    /** The dialog element, for tests and for the reader's teardown. */
    element: function () {
      return root;
    },
  };
}
