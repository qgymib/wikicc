/**
 * The viewer policy: the provider registry, the standard action model, the
 * fit arithmetic and the wheel arithmetic.
 *
 * Nothing here touches a page, so the tests run against plain values: the
 * registry answers with the providers it was handed, the fit answers with
 * the scale a stage and a picture decide together, and the wheel answers
 * with the notch and the focal that pin the cursor's point in place. The
 * names these modules and the stylesheet share are pinned here — a rename
 * that forgot the CSS or the Rust build fails here first, with the old name
 * in hand.
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
  wheelZoom,
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

/**
 * Geometry for an 800x400 picture whose rest centre — the transform origin
 * — sits at (500, 350), whatever its scale and pan are: the rect centre is
 * the rest centre plus `scale * pan`, exactly what the page reports.
 */
function wheelGeometry(scale, pan) {
  return {
    rect: {
      left: 500 + scale * pan.x - 400 * scale,
      top: 350 + scale * pan.y - 200 * scale,
      width: 800 * scale,
      height: 400 * scale,
    },
    pan: pan,
    scale: scale,
    step: 0.3,
    minScale: 0.05,
    maxScale: 8,
  };
}

test("wheelZoom anchors a notch at the cursor over a centred picture", () => {
  const move = wheelZoom(wheelGeometry(1, { x: 0, y: 0 }), {
    clientX: 200,
    clientY: 200,
    deltaY: -120,
  });
  const toScale = Math.exp(0.3 / 3);
  assert.equal(move.scale, toScale);
  // The focal is the cursor offset from the rest centre, in new-scale units:
  // the point at (200, 200) is 300 left of and 150 above the origin.
  assert.ok(Math.abs(move.focal.x - (200 - 500) * toScale) < 1e-9);
  assert.ok(Math.abs(move.focal.y - (200 - 350) * toScale) < 1e-9);
});

test("wheelZoom reconstructs the origin through a pan and a scale", () => {
  // The picture was dragged: pan (-40, 25) at scale 0.5 puts the rect
  // centre at (480, 362.5), and the anchor must still be the rest centre.
  const move = wheelZoom(wheelGeometry(0.5, { x: -40, y: 25 }), {
    clientX: 237.5,
    clientY: 462.5,
    deltaY: -120,
  });
  const toScale = 0.5 * Math.exp(0.3 / 3);
  assert.ok(Math.abs(move.focal.x - (237.5 - 500) * toScale) < 1e-9);
  assert.ok(Math.abs(move.focal.y - (462.5 - 350) * toScale) < 1e-9);
});

test("wheelZoom's focal pins the cursor through panzoom's own formula", () => {
  // panzoom's zoom() turns a focal into a translation by
  //   toX = (focal.x / toScale - focal.x / scale + x * toScale) / toScale.
  // With wheelZoom's focal that must come out as exactly the anchored one,
  // x + d * (1/toScale - 1/scale), or the cursor's point would move.
  const geometry = wheelGeometry(0.5, { x: -40, y: 25 });
  const move = wheelZoom(geometry, {
    clientX: 237.5,
    clientY: 462.5,
    deltaY: -120,
  });
  const toScale = 0.5 * Math.exp(0.3 / 3);
  const anchored = {
    x: geometry.pan.x + (237.5 - 500) * (1 / toScale - 1 / geometry.scale),
    y: geometry.pan.y + (462.5 - 350) * (1 / toScale - 1 / geometry.scale),
  };
  const panzoom = {
    x:
      (move.focal.x / toScale -
        move.focal.x / geometry.scale +
        geometry.pan.x * toScale) /
      toScale,
    y:
      (move.focal.y / toScale -
        move.focal.y / geometry.scale +
        geometry.pan.y * toScale) /
      toScale,
  };
  assert.ok(Math.abs(panzoom.x - anchored.x) < 1e-9);
  assert.ok(Math.abs(panzoom.y - anchored.y) < 1e-9);
});

test("wheelZoom reads the notch the way panzoom does", () => {
  const geometry = wheelGeometry(1, { x: 0, y: 0 });
  assert.equal(
    wheelZoom(geometry, { clientX: 0, clientY: 0, deltaY: -120 }).scale,
    Math.exp(0.3 / 3),
  );
  assert.equal(
    wheelZoom(geometry, { clientX: 0, clientY: 0, deltaY: 240 }).scale,
    Math.exp(-0.3 / 3),
  );
  // A shift-wheel on a Mac reports the gesture on deltaX when deltaY is 0.
  assert.equal(
    wheelZoom(geometry, { clientX: 0, clientY: 0, deltaY: 0, deltaX: -90 })
      .scale,
    Math.exp(0.3 / 3),
  );
  // A zero delta steps out, exactly as panzoom's own handler does.
  assert.equal(
    wheelZoom(geometry, { clientX: 0, clientY: 0, deltaY: 0, deltaX: 0 }).scale,
    Math.exp(-0.3 / 3),
  );
});

test("wheelZoom clamps at the engine's bounds and holds the anchor there", () => {
  const top = wheelZoom(wheelGeometry(8, { x: 12, y: -4 }), {
    clientX: 0,
    clientY: 0,
    deltaY: -120,
  });
  assert.equal(top.scale, 8);
  assert.ok(Math.abs(top.focal.x - (0 - 500) * 8) < 1e-9);

  const bottom = wheelZoom(wheelGeometry(0.05, { x: 12, y: -4 }), {
    clientX: 0,
    clientY: 0,
    deltaY: 120,
  });
  assert.equal(bottom.scale, 0.05);
  assert.ok(Math.abs(bottom.focal.x - (0 - 500) * 0.05) < 1e-9);
});

test("wheelZoom refuses a notch it cannot anchor", () => {
  const geometry = wheelGeometry(1, { x: 0, y: 0 });
  const wheel = { clientX: 0, clientY: 0, deltaY: -120 };

  const unmeasured = wheelGeometry(1, { x: 0, y: 0 });
  unmeasured.rect = null;
  const halfMeasured = wheelGeometry(1, { x: 0, y: 0 });
  halfMeasured.rect.width = NaN;
  const unpanned = wheelGeometry(1, { x: 0, y: 0 });
  unpanned.pan = null;

  assert.equal(wheelZoom(unmeasured, wheel), null);
  assert.equal(wheelZoom(halfMeasured, wheel), null);
  assert.equal(wheelZoom(unpanned, wheel), null);
  assert.equal(wheelZoom(wheelGeometry(0, { x: 0, y: 0 }), wheel), null);
  assert.equal(wheelZoom(wheelGeometry(NaN, { x: 0, y: 0 }), wheel), null);
  assert.equal(wheelZoom(wheelGeometry(-1, { x: 0, y: 0 }), wheel), null);
  assert.equal(wheelZoom(geometry, { clientX: 0, clientY: 0 }), null);
  assert.equal(wheelZoom(geometry, null), null);
  assert.equal(wheelZoom(null, wheel), null);
});

test("wheelZoom degrades to a centre zoom when the cursor is unknown", () => {
  const move = wheelZoom(wheelGeometry(1, { x: 0, y: 0 }), { deltaY: -120 });
  assert.equal(move.scale, Math.exp(0.3 / 3));
  assert.equal(move.focal, null);

  // An engine without a step falls back to panzoom's own default.
  const unstepped = wheelGeometry(1, { x: 0, y: 0 });
  unstepped.step = undefined;
  assert.equal(
    wheelZoom(unstepped, { clientX: 0, clientY: 0, deltaY: -120 }).scale,
    Math.exp(0.3 / 3),
  );

  // Without bounds the notch is not clamped.
  const unbounded = wheelGeometry(100, { x: 0, y: 0 });
  unbounded.minScale = undefined;
  unbounded.maxScale = undefined;
  assert.equal(
    wheelZoom(unbounded, { clientX: 0, clientY: 0, deltaY: 120 }).scale,
    100 * Math.exp(-0.3 / 3),
  );
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
