/**
 * Tests for `src/web/js/lock-view.js`: the password form a sealed
 * document's page carries.
 *
 * The form is driven with a minimal fake DOM — plain objects with the few
 * members the view touches — because the rules under test are the mount and
 * answer contract, not the rendering: the field starts empty and focused, a
 * wrong password is reported where the reader can retry it, one attempt
 * runs at a time, and each locked render builds its own form so a verdict
 * for one page never lands on the next.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createUnlockForm,
  ERROR_CLASS,
  FORM_CLASS,
  INPUT_CLASS,
  LABEL_TEXT_CLASS,
  SUBMIT_CLASS,
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
 * One form over a controllable verdict: `next` decides what the next
 * attempt resolves with, `attempts` records the passwords it was given,
 * and `controller` exposes the pending attempt so a test can resolve it
 * late.
 */
function setup() {
  const host = fakeElement("article");
  const doc = fakeDocument();
  const attempts = [];
  let next = { resolve: true };
  let controller = null;

  const form = createUnlockForm({
    host,
    document: doc,
    doc: { id: "guide/intro.md", title: "Intro" },
    onSubmit(password, sealedDoc) {
      attempts.push({ password, sealedDoc });
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

  const label = form.children[0];
  const input = label.children[1];
  const submit = form.children[1];
  const error = form.children[2];

  return {
    host,
    doc,
    form,
    label,
    input,
    submit,
    error,
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

test("the form mounts ready to answer: field empty, focused, no error", () => {
  const view = setup();

  assert.equal(view.host.children.length, 1, "the form mounts where it lands");
  assert.equal(view.form.className, FORM_CLASS);
  assert.equal(view.label.className, "doc-locked-label");
  const labelText = view.label.children[0];
  assert.equal(labelText.className, LABEL_TEXT_CLASS);
  assert.equal(
    labelText.textContent,
    "Password",
    "the label names the field for the reader who cannot see it",
  );
  assert.equal(view.input.className, INPUT_CLASS);
  assert.equal(view.input.getAttribute("type"), "password");
  assert.equal(view.input.getAttribute("autocomplete"), "off");
  assert.equal(view.input.value, "", "the field starts empty");
  assert.equal(view.input.focusCalls, 1, "the field takes the focus");
  assert.equal(view.error.className, ERROR_CLASS);
  assert.equal(view.error.getAttribute("role"), "alert");
  assert.equal(view.error.hidden, true, "no error before any attempt");
  assert.equal(view.submit.className, SUBMIT_CLASS);
  assert.equal(view.submit.getAttribute("type"), "submit");
  assert.equal(view.submit.textContent, "Unlock");
});

test("a correct password reaches the handler with the document it belongs to", async () => {
  const view = setup();

  view.submitPassword("the password");
  await settle();

  assert.equal(view.attempts.length, 1);
  assert.equal(view.attempts[0].password, "the password");
  assert.equal(
    view.attempts[0].sealedDoc.id,
    "guide/intro.md",
    "the attempt knows which ciphertext to open",
  );
  assert.equal(view.submit.disabled, false, "the form settles again");
  assert.equal(view.submit.textContent, "Unlock");
  assert.equal(view.error.hidden, true, "a success says nothing");
});

test("a wrong password reports itself where the reader can retry", async () => {
  const view = setup();
  view.next = { resolve: false };

  view.submitPassword("nope");
  await settle();

  assert.equal(view.error.hidden, false);
  assert.match(view.error.textContent, /did not unlock/);
  assert.equal(
    view.input.focusCalls,
    2,
    "the field takes the focus back for the retry",
  );
  assert.equal(view.input.selectCalls, 1, "the wrong attempt is selected");
  assert.equal(view.submit.disabled, false, "the form settles again");
  assert.equal(view.input.disabled, false, "so does the field");
});

test("typing clears the error of the last attempt", async () => {
  const view = setup();
  view.next = { resolve: false };
  view.submitPassword("nope");
  await settle();

  assert.equal(view.error.hidden, false);
  view.input.fire("input");
  assert.equal(view.error.hidden, true, "a new attempt starts clean");
});

test("an attempt that cannot run reports it in the same place", async () => {
  const view = setup();
  view.next = { reject: true };

  view.submitPassword("whatever");
  await settle();

  assert.equal(view.error.hidden, false);
  assert.match(view.error.textContent, /could not be unlocked/);
});

test("a running attempt disables the form and answers only once", async () => {
  const view = setup();
  view.next = { defer: true };

  view.submitPassword("the password");
  // The attempt starts one microtask after the submit event.
  await Promise.resolve();

  assert.equal(view.submit.disabled, true, "the unlock action waits");
  assert.equal(view.input.disabled, true, "so does the field");
  assert.match(view.submit.textContent, /Unlocking/);

  // A second press while the derivation runs is not a second attempt.
  view.submitPassword("the password again");
  await settle();
  assert.equal(view.attempts.length, 1, "one attempt at a time");

  // A late success settles the form it outlived.
  view.controller.resolve(true);
  await settle();

  assert.equal(view.submit.disabled, false);
  assert.equal(view.input.disabled, false);
  assert.equal(view.submit.textContent, "Unlock");
  assert.equal(view.error.hidden, true, "a success says nothing");
});

test("a late failure lands on its own form, never on the next render's", async () => {
  const view = setup();
  view.next = { defer: true };
  view.submitPassword("nope");
  // The attempt starts one microtask after the submit event.
  await Promise.resolve();

  // The next locked render builds its own form; the first one is gone with
  // the article it stood in.
  const fresh = setup();
  assert.equal(fresh.error.hidden, true, "the fresh form starts clean");

  view.controller.resolve(false);
  await settle();

  assert.equal(view.error.hidden, false, "the verdict finds its own form");
  assert.match(view.error.textContent, /did not unlock/);
  assert.equal(
    fresh.error.hidden,
    true,
    "the next render's form stays out of it",
  );
  assert.equal(fresh.input.focusCalls, 1, "the fresh field keeps its focus");
});
