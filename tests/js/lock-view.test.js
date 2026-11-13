/**
 * Tests for `src/web/js/lock-view.js`: the modal asking for a sealed
 * document's password.
 *
 * The dialog is driven with a minimal fake DOM — plain objects with the few
 * members the view touches — because the rules under test are the open/close
 * contract, not the rendering: the field starts empty and focused, a wrong
 * password is reported where the reader can retry it, Escape and Cancel
 * close without an attempt, the field is emptied on every close, and an
 * attempt that outlives the dialog (an escape during a key derivation)
 * leaves nothing behind.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createUnlockDialog,
  DIALOG_CLASS,
  ERROR_CLASS,
  INPUT_ID,
  LEDE_CLASS,
  OVERLAY_CLASS,
} from "../../src/web/js/lock-view.js";

/** Element stub: records children, attributes, listeners and focus. */
function fakeElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    children: [],
    attributes: {},
    listeners: {},
    hidden: false,
    textContent: "",
    value: "",
    disabled: false,
    focusCalls: 0,
    selectCalls: 0,
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
    },
    fire(type, event) {
      (this.listeners[type] || []).slice().forEach(function (handler) {
        handler(event || {});
      });
    },
    focus() {
      this.focusCalls += 1;
    },
    select() {
      this.selectCalls += 1;
    },
  };

  return element;
}

/** A fake `document` that hands out stubs for everything the view builds. */
function fakeDocument() {
  return {
    createElement(tagName) {
      return fakeElement(tagName);
    },
  };
}

/** Drain the microtasks an attempt's promise chain travels through. */
async function settle() {
  await new Promise(function (resolve) {
    setImmediate(resolve);
  });
  await new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

/**
 * One dialog over a controllable verdict: `next` decides what the next
 * attempt resolves with, `attempts` records the passwords it was given,
 * and `controller` exposes the pending attempt so a test can resolve it
 * late.
 */
function setup() {
  const host = fakeElement("body");
  const doc = fakeDocument();
  const attempts = [];
  let next = { resolve: true };
  let controller = null;

  const dialog = createUnlockDialog({
    host,
    document: doc,
    onSubmit(password, openedDoc) {
      attempts.push({ password, openedDoc });
      if (next.defer) {
        return new Promise(function (resolve, reject) {
          controller = { resolve, reject };
        });
      }
      if (next.reject) {
        return Promise.reject(new Error("no Web Crypto here"));
      }
      return Promise.resolve(next.resolve);
    },
  });

  const overlay = host.children.find(function (child) {
    return child.className === OVERLAY_CLASS;
  });
  const panel = overlay.children[0];
  const form = panel.children[2];
  const input = form.children[1];
  const error = form.children[2];
  const actions = form.children[3];
  const cancel = actions.children[0];
  const submit = actions.children[1];

  return {
    host,
    doc,
    dialog,
    overlay,
    panel,
    form,
    input,
    error,
    cancel,
    submit,
    attempts,
    get next() {
      return next;
    },
    set next(value) {
      next = value;
    },
    get controller() {
      return controller;
    },
    /** Fire a submit with `password` in the field, the way a form does. */
    submitPassword(password) {
      input.value = password;
      form.fire("submit", { preventDefault() {} });
    },
  };
}

test("the dialog mounts hidden once and only opens on demand", () => {
  const view = setup();

  assert.equal(view.dialog.isOpen(), false);
  assert.equal(view.overlay.hidden, true, "the page starts without the modal");
  assert.equal(
    view.host.children.length,
    1,
    "the dialog mounts when the reader starts",
  );
});

test("opening names the document and puts the reader in the field", () => {
  const view = setup();
  const opener = fakeElement("button");
  view.dialog.open({ title: "Intro" }, opener);

  assert.equal(view.dialog.isOpen(), true);
  assert.equal(view.overlay.hidden, false);
  const lede = view.panel.children[1];
  assert.equal(lede.className, LEDE_CLASS);
  assert.match(lede.textContent, /Intro/);
  assert.equal(view.input.focusCalls, 1, "the field takes the focus");
  assert.equal(view.input.value, "", "the field starts empty");
  assert.equal(view.error.hidden, true, "no error before any attempt");
});

test("opening an open dialog is a no-op", () => {
  const view = setup();
  const opener = fakeElement("button");
  view.dialog.open({ title: "Intro" }, opener);
  const focusCalls = view.input.focusCalls;
  view.dialog.open({ title: "Other" }, opener);

  const lede = view.panel.children[1];
  assert.match(lede.textContent, /Intro/, "the first document keeps the modal");
  assert.equal(view.input.focusCalls, focusCalls, "the focus did not move");
});

test("the markup answers to the accessibility contract", () => {
  const view = setup();

  assert.equal(view.overlay.className, OVERLAY_CLASS);
  assert.equal(view.panel.className, DIALOG_CLASS);
  assert.equal(view.panel.getAttribute("role"), "dialog");
  assert.equal(view.panel.getAttribute("aria-modal"), "true");
  const heading = view.panel.children[0];
  assert.equal(heading.getAttribute("id"), "unlock-heading");
  assert.equal(
    view.panel.getAttribute("aria-labelledby"),
    "unlock-heading",
    "the dialog is named by its heading",
  );
  const lede = view.panel.children[1];
  assert.equal(lede.className, LEDE_CLASS);
  const label = view.form.children[0];
  assert.equal(label.getAttribute("for"), INPUT_ID);
  assert.equal(view.input.getAttribute("id"), INPUT_ID);
  assert.equal(view.input.getAttribute("type"), "password");
  assert.equal(view.input.getAttribute("autocomplete"), "off");
  assert.equal(view.error.className, ERROR_CLASS);
  assert.equal(view.error.getAttribute("role"), "alert");
  assert.equal(view.cancel.getAttribute("type"), "button");
  assert.equal(view.submit.getAttribute("type"), "submit");
});

test("a correct password closes, empties the field and restores the focus", async () => {
  const view = setup();
  const opener = fakeElement("button");
  view.dialog.open({ title: "Intro" }, opener);

  view.submitPassword("the password");
  await settle();

  assert.equal(view.attempts.length, 1);
  assert.equal(view.attempts[0].password, "the password");
  assert.equal(view.attempts[0].openedDoc.title, "Intro");
  assert.equal(view.dialog.isOpen(), false, "the success closes the dialog");
  assert.equal(view.input.value, "", "the password does not linger");
  assert.equal(opener.focusCalls, 1, "the opener takes the focus back");
  assert.equal(view.submit.textContent, "Unlock", "the actions settle again");
});

test("a wrong password reports itself where the reader can retry", async () => {
  const view = setup();
  const opener = fakeElement("button");
  view.dialog.open({ title: "Intro" }, opener);
  view.next = { resolve: false };

  view.submitPassword("nope");
  await settle();

  assert.equal(view.dialog.isOpen(), true, "the reader can retry");
  assert.equal(view.error.hidden, false);
  assert.match(view.error.textContent, /did not unlock/);
  assert.equal(
    view.input.focusCalls,
    2,
    "the field takes the focus back for the retry",
  );
  assert.equal(view.input.selectCalls, 1, "the wrong attempt is selected");
  assert.equal(view.submit.disabled, false, "the actions settle again");
});

test("typing clears the error of the last attempt", async () => {
  const view = setup();
  view.dialog.open({ title: "Intro" }, fakeElement("button"));
  view.next = { resolve: false };
  view.submitPassword("nope");
  await settle();

  assert.equal(view.error.hidden, false);
  view.input.fire("input");
  assert.equal(view.error.hidden, true, "a new attempt starts clean");
});

test("an attempt that cannot run reports it in the same place", async () => {
  const view = setup();
  view.dialog.open({ title: "Intro" }, fakeElement("button"));
  view.next = { reject: true };

  view.submitPassword("whatever");
  await settle();

  assert.equal(view.dialog.isOpen(), true, "the dialog stays for a retry");
  assert.equal(view.error.hidden, false);
  assert.match(view.error.textContent, /could not be unlocked/);
});

test("escape closes without an attempt and empties the field", () => {
  const view = setup();
  const opener = fakeElement("button");
  view.dialog.open({ title: "Intro" }, opener);
  view.input.value = "half-typed";

  view.overlay.fire("keydown", { key: "Escape" });

  assert.equal(view.dialog.isOpen(), false);
  assert.equal(view.input.value, "", "the half-typed password is gone");
  assert.equal(view.attempts.length, 0, "escape is not an attempt");
  assert.equal(opener.focusCalls, 1);
});

test("cancel closes without an attempt", () => {
  const view = setup();
  view.dialog.open({ title: "Intro" }, fakeElement("button"));

  view.cancel.fire("click", { preventDefault() {} });

  assert.equal(view.dialog.isOpen(), false);
  assert.equal(view.attempts.length, 0);
});

test("a running attempt disables the actions", async () => {
  const view = setup();
  view.dialog.open({ title: "Intro" }, fakeElement("button"));
  view.next = { defer: true };

  view.submitPassword("the password");
  // The attempt starts one microtask after the submit event.
  await Promise.resolve();

  assert.equal(view.submit.disabled, true, "the unlock action waits");
  assert.equal(view.cancel.disabled, true, "so does the cancel");
  assert.match(view.submit.textContent, /Unlocking/);

  // A late success closes the dialog it outlived.
  view.controller.resolve(true);
  await settle();

  assert.equal(view.dialog.isOpen(), false);
  assert.equal(view.submit.disabled, false);
  assert.equal(view.submit.textContent, "Unlock");
});

test("a verdict that outlives the dialog leaves it closed", async () => {
  const view = setup();
  const opener = fakeElement("button");
  view.dialog.open({ title: "Intro" }, opener);
  view.next = { defer: true };

  view.submitPassword("nope");
  // The attempt starts one microtask after the submit event.
  await Promise.resolve();
  // The reader escapes while the derivation runs — the dialog is gone
  // before the attempt can answer.
  view.overlay.fire("keydown", { key: "Escape" });
  assert.equal(view.dialog.isOpen(), false);

  view.controller.resolve(false);
  await settle();

  assert.equal(view.dialog.isOpen(), false, "the verdict opens nothing");
  assert.equal(view.error.hidden, true, "and reports to nobody");
  assert.equal(opener.focusCalls, 1, "the focus stays where escape left it");
});
