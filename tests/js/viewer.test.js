/**
 * The viewer policy: the provider registry, the standard action model and
 * the fit arithmetic.
 *
 * Nothing here touches a page, so the tests run against plain values: the
 * registry answers with the providers it was handed, and the fit answers
 * with the scale a stage and a picture decide together. The names these
 * modules and the stylesheet share are pinned here — a rename that forgot
 * the CSS or the Rust build fails here first, with the old name in hand.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_BUTTON_CLASS,
  ACTIONS_CLASS,
  BACKDROP_CLASS,
  CONTENT_CLASS,
  FIT_PORTION,
  HEADER_CLASS,
  HOVER_TOOLBAR_CLASS,
  OPEN_ATTRIBUTE,
  OPEN_BUTTON_CLASS,
  OPEN_VALUE,
  STAGE_CLASS,
  STANDARD_ACTIONS,
  TITLE_CLASS,
  WINDOW_CLASS,
  fitScale,
  providerFor,
  registerProvider,
  resetProviders,
} from "../../src/web/js/viewer.js";

/** A provider with the full required shape, matching what `matches` says. */
function providerMatching(matches) {
  return {
    type: "test",
    matches: matches,
    hoverLabel: "Open test",
    title: function () {
      return "Test";
    },
    mount: function () {
      return null;
    },
  };
}

test("a provider without matches or mount is refused", () => {
  resetProviders();

  assert.throws(function () {
    registerProvider({ type: "broken", mount: function () {} });
  }, TypeError);
  assert.throws(function () {
    registerProvider({ type: "broken", matches: function () {} });
  }, TypeError);
  assert.throws(function () {
    registerProvider(null);
  }, TypeError);
  assert.equal(providerFor("anything"), null);
});

test("the first provider whose matches accepts the element wins", () => {
  resetProviders();
  const first = providerMatching(function (element) {
    return element === "known";
  });
  const second = providerMatching(function () {
    return true;
  });
  registerProvider(first);
  registerProvider(second);

  assert.equal(providerFor("known"), first);
  assert.equal(providerFor("anything"), second);
});

test("a provider whose matches throws is skipped, not fatal", () => {
  resetProviders();
  registerProvider(
    providerMatching(function () {
      throw new Error("a broken provider");
    }),
  );
  const working = providerMatching(function () {
    return true;
  });
  registerProvider(working);

  assert.equal(providerFor("element"), working);
});

test("resetProviders empties the registry", () => {
  resetProviders();
  registerProvider(
    providerMatching(function () {
      return true;
    }),
  );

  resetProviders();
  assert.equal(providerFor("element"), null);
});

test("fitScale answers the smaller axis ratio, capped at one", () => {
  assert.equal(
    fitScale(1000, 800, 2000, 1000, FIT_PORTION),
    Math.min((FIT_PORTION * 1000) / 2000, (FIT_PORTION * 800) / 1000, 1),
  );
  assert.equal(fitScale(1000, 800, 500, 400, FIT_PORTION), 1);
  assert.ok(fitScale(1000, 800, 1090, 100, FIT_PORTION) < 1);
});

test("fitScale answers one when a box cannot be measured", () => {
  assert.equal(fitScale(0, 800, 100, 100, FIT_PORTION), 1);
  assert.equal(fitScale(1000, 0, 100, 100, FIT_PORTION), 1);
  assert.equal(fitScale(-5, 800, 100, 100, FIT_PORTION), 1);
  assert.equal(fitScale(1000, 800, undefined, 100, FIT_PORTION), 1);
  assert.equal(fitScale(1000, 800, 100, 0, FIT_PORTION), 1);
});

test("the standard actions are the four the window always carries", () => {
  assert.deepEqual(
    STANDARD_ACTIONS.map(function (action) {
      return action.id;
    }),
    ["zoom-in", "zoom-out", "reset", "close"],
  );
  STANDARD_ACTIONS.forEach(function (action) {
    assert.ok(action.label, "the " + action.id + " action needs a label");
    assert.match(
      action.icon,
      /^M/,
      "the " + action.id + " action needs an icon path",
    );
  });
});

test("the class and attribute names the stylesheet answers to are pinned", () => {
  assert.equal(HOVER_TOOLBAR_CLASS, "viewer-hover");
  assert.equal(OPEN_BUTTON_CLASS, "viewer-open");
  assert.equal(BACKDROP_CLASS, "viewer-backdrop");
  assert.equal(WINDOW_CLASS, "viewer-window");
  assert.equal(HEADER_CLASS, "viewer-header");
  assert.equal(TITLE_CLASS, "viewer-title");
  assert.equal(ACTIONS_CLASS, "viewer-actions");
  assert.equal(ACTION_BUTTON_CLASS, "viewer-action");
  assert.equal(STAGE_CLASS, "viewer-stage");
  assert.equal(CONTENT_CLASS, "viewer-content");
  assert.equal(OPEN_ATTRIBUTE, "data-viewer");
  assert.equal(OPEN_VALUE, "open");
});
