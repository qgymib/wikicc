/**
 * The lock page's password form: the field a sealed document's page carries.
 *
 * The reader lands on the locked page and the field is already there — no
 * title to select, no dialog to open; the password is the only thing between
 * them and the document, so the page puts it in front of them. The form is a
 * plain inline shape — a labelled field, an unlock action, a line for a
 * failed attempt — and it owns nothing about decryption: whether a password
 * opens the document is `onSubmit`'s answer, so the form stays a view and
 * the session state (the password table, the store) stays with the
 * controller.
 *
 * A fresh form is built for every locked render and dropped with the article
 * the next render replaces. That makes an attempt that outlives its page — a
 * navigation during a key derivation — harmless by construction: its verdict
 * writes to nodes nothing shows, and a success answers through the store's
 * notification regardless. The field starts empty and focused; a wrong
 * password is a line the reader can retry where they typed, and typing
 * clears it. While an attempt runs the form is disabled — a key derivation
 * cannot be interrupted, so the form says what it is doing instead of
 * pretending.
 *
 * The DOM is touched only through the `document` passed in, which is what
 * keeps the view testable without a browser.
 */
import { t } from "./i18n.js";

/** Class of the form the lock page answers in. */
export var FORM_CLASS = "doc-locked-form";

/** Class of the text that names the field for the reader who cannot see it. */
export var LABEL_TEXT_CLASS = "doc-locked-label-text";

/** Class of the password field. */
export var INPUT_CLASS = "doc-locked-input";

/**
 * What the field's label says, in the English copy.
 *
 * The constants below are the English text, kept for the tests that import
 * them; the form resolves its copy through the dictionaries at build time,
 * so a site built in another language renders that language's words.
 */
export var INPUT_LABEL = "Password";

/** Class of the button that submits the password. */
export var SUBMIT_CLASS = "doc-locked-submit";

/** Class of the line that reports a failed attempt. */
export var ERROR_CLASS = "doc-locked-error";

/** What the error line says when the password does not authenticate. */
export var WRONG_PASSWORD_MESSAGE =
  "That password did not unlock this document.";

/** What the error line says when an attempt failed for any other reason. */
export var UNAVAILABLE_MESSAGE = "The document could not be unlocked.";

/** What the unlock action says while the page is idle. */
export var SUBMIT_TEXT = "Unlock";

/** What the unlock action says while an attempt is running. */
export var BUSY_TEXT = "Unlocking\u2026";

/**
 * Build the lock page's password form and mount it in `host`.
 *
 * `doc` is the sealed document the form belongs to — it travels with the
 * attempt so the controller knows which ciphertext to open.
 * `onSubmit(password, doc)` resolves `true` when the document opened,
 * `false` when the password did not authenticate, and rejects when the
 * attempt failed for a reason no password can fix. `document` exists for
 * tests.
 */
export function createUnlockForm(options) {
  var host = options.host;
  var doc = options.doc;
  var onSubmit = options.onSubmit;
  var d = options.document || globalThis.document;

  var busy = false;

  var form = d.createElement("form");
  form.className = FORM_CLASS;

  // The label wraps its field, so no shared id is needed: the lock page and
  // the hover preview's own password form can stand on one page without
  // colliding.
  var label = d.createElement("label");
  label.className = "doc-locked-label";

  var labelText = d.createElement("span");
  labelText.className = LABEL_TEXT_CLASS;
  labelText.textContent = t("lock.label");

  var input = d.createElement("input");
  input.className = INPUT_CLASS;
  input.setAttribute("type", "password");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  // The field starts empty by construction, not by the DOM's mood: no
  // password typed anywhere else may linger here.
  input.value = "";

  var submit = d.createElement("button");
  submit.className = SUBMIT_CLASS;
  submit.setAttribute("type", "submit");
  submit.textContent = t("lock.submit");

  var error = d.createElement("p");
  error.className = ERROR_CLASS;
  error.setAttribute("role", "alert");
  error.hidden = true;

  label.appendChild(labelText);
  label.appendChild(input);
  form.appendChild(label);
  form.appendChild(submit);
  form.appendChild(error);

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

  /** Flip the form into (or out of) its waiting state. */
  function setBusy(waiting) {
    busy = waiting;
    submit.disabled = waiting;
    input.disabled = waiting;
    submit.textContent = waiting ? t("lock.busy") : t("lock.submit");
  }

  function onSubmitEvent(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (busy) {
      return;
    }

    var password = typeof input.value === "string" ? input.value : "";
    setBusy(true);
    Promise.resolve()
      .then(function () {
        return onSubmit(password, doc);
      })
      .then(function (unlocked) {
        setBusy(false);
        // A success re-renders the page through the store's notification,
        // and this form goes with the article it stood in. A "no" finds the
        // reader still here, and the line names the failure while they
        // retype.
        if (!unlocked) {
          fail(t("lock.wrongPassword"));
        }
      })
      .catch(function (_error) {
        setBusy(false);
        fail(t("lock.unavailable"));
      });
  }

  function onFieldInput() {
    // The error described the last attempt; typing is a new one.
    error.hidden = true;
  }

  form.addEventListener("submit", onSubmitEvent);
  input.addEventListener("input", onFieldInput);

  host.appendChild(form);
  if (typeof input.focus === "function") {
    input.focus();
  }

  return form;
}
