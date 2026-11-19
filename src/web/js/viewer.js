/**
 * Content viewer policy: who may open the viewer, and what it shows.
 *
 * The viewer is the lightbox behind the hover toolbar: it lifts one piece of
 * the page — today a rendered diagram, tomorrow a picture, a table or any
 * other kind of content — onto a large canvas where it can be zoomed, panned
 * and reset. The feature is built for more kinds of content than the one it
 * ships with, so *what can be opened* is a registry, not a hard-wired list:
 * every kind of content registers a provider, and the first provider whose
 * `matches` accepts an element is the one the viewer opens.
 *
 * A provider describes one kind of content:
 *
 * - `type` — a stable name, for diagnostics and the tests;
 * - `matches(element)` — whether the viewer can show this element;
 * - `hoverLabel` — what the toolbar's button announces;
 * - `title(element)` — the heading the lightbox carries;
 * - `mount(element)` — build the content the viewer shows, detached; the
 *   viewer puts it on the stage and hands it to the transform engine;
 * - `extraActions()` — optional buttons beyond the standard ones, each
 *   `{ id, label, icon, run(engine) }`; `run` receives the live transform
 *   engine, so an extra action drives the same picture the standard ones do.
 *
 * The standard operations belong to the viewer itself: zoom in, zoom out,
 * reset and close. This module is deliberately free of `document`, so
 * `node --test` covers the registry and the fit arithmetic without a DOM;
 * `viewer-view.js` owns the page, and `diagram-view.js` arms the hover
 * toolbar once a render has put a diagram on it.
 */

/** Class of the hover toolbar the viewer hangs on a renderable block. */
export var HOVER_TOOLBAR_CLASS = "viewer-hover";

/** Extra class of the hover button that opens the viewer. */
export var OPEN_BUTTON_CLASS = "viewer-open";

/**
 * Class of the block a pointer session leaves the focus on: focusable
 * without joining the tab order, and carrying no focus indicator of its
 * own — the stylesheet answers to it.
 */
export var HOST_CLASS = "viewer-host";

/** Class of the lightbox backdrop the viewer mounts on the body. */
export var BACKDROP_CLASS = "viewer-backdrop";

/** Class of the centered window inside the backdrop. */
export var WINDOW_CLASS = "viewer-window";

/** Class of the window's heading row. */
export var HEADER_CLASS = "viewer-header";

/** Class of the window's title. */
export var TITLE_CLASS = "viewer-title";

/** Class of the row holding the window's action buttons. */
export var ACTIONS_CLASS = "viewer-actions";

/** Extra class of one action button in the window. */
export var ACTION_BUTTON_CLASS = "viewer-action";

/** Class of the canvas area the provider's content lands in. */
export var STAGE_CLASS = "viewer-stage";

/** Class of the element the transform engine moves inside the stage. */
export var CONTENT_CLASS = "viewer-content";

/** Body attribute set while the viewer is open; the stylesheet answers to it. */
export var OPEN_ATTRIBUTE = "data-viewer";

/** Value the body attribute carries while the viewer is open. */
export var OPEN_VALUE = "open";

/**
 * How much of the stage a fitted picture may fill on either axis.
 *
 * The margin keeps a fitted picture off the window's very edge, the same
 * breathing room the panels keep from theirs.
 */
export var FIT_PORTION = 0.92;

/**
 * The standard actions of the viewer's window, in display order.
 *
 * `run` is resolved by the view against the live transform engine; `close`
 * is the viewer's own gesture and never reaches an engine. Each action
 * names its label twice: `labelKey` is the dictionary entry the view
 * resolves in the language in effect, and `label` is the English copy the
 * tests and a fallback read. The icons are single stroke paths in the
 * site's 24-unit box, drawn by the shared `.icon-button` styling.
 */
export var STANDARD_ACTIONS = [
  {
    id: "zoom-in",
    labelKey: "viewer.zoomIn",
    label: "Zoom in",
    icon: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M16.5 16.5 21 21M8 11h6M11 8v6",
  },
  {
    id: "zoom-out",
    labelKey: "viewer.zoomOut",
    label: "Zoom out",
    icon: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M16.5 16.5 21 21M8 11h6",
  },
  {
    id: "reset",
    labelKey: "viewer.reset",
    label: "Reset view",
    icon: "M1 4v6h6M3.51 15a9 9 0 1 0 2.13-9.36L1 10",
  },
  {
    id: "close",
    labelKey: "viewer.close",
    label: "Close viewer",
    icon: "M6 6l12 12M18 6 6 18",
  },
];

/** The providers registered so far; the first match wins. */
var providers = [];

/**
 * Register a provider for one kind of content.
 *
 * A provider without `matches` or `mount` cannot answer either of the two
 * questions the viewer asks — can this element be shown, and what should the
 * stage hold — so registering one is a programming error and is refused
 * outright rather than discovered as a crash at open time.
 */
export function registerProvider(provider) {
  if (
    !provider ||
    typeof provider.matches !== "function" ||
    typeof provider.mount !== "function"
  ) {
    throw new TypeError(
      "a viewer provider needs both matches and mount functions",
    );
  }
  providers.push(provider);
}

/** Forget every registered provider. Tests re-seed the registry with it. */
export function resetProviders() {
  providers = [];
}

/**
 * The first provider that can show `element`, or null.
 *
 * Registration order is priority: an earlier provider's answer is final. A
 * provider whose `matches` throws is skipped rather than allowed to take the
 * page down — the viewer is an enhancement, and one broken provider must not
 * cost the reader the rest of it.
 */
export function providerFor(element) {
  for (var index = 0; index < providers.length; index += 1) {
    var provider = providers[index];
    try {
      if (provider.matches(element)) {
        return provider;
      }
    } catch (error) {
      if (typeof console === "object" && typeof console.error === "function") {
        console.error("wikicc: a viewer provider failed to match", error);
      }
    }
  }
  return null;
}

/**
 * The scale that fits a content box inside a stage box.
 *
 * The answer is the smaller of the two axis ratios — one axis decides, the
 * other follows — capped at 1: a small picture is shown at its natural size,
 * never blown up by the fit. A box that has not been laid out reports no
 * usable size, and a picture that cannot be measured simply starts at scale
 * 1 instead of a wrong guess.
 */
export function fitScale(
  stageWidth,
  stageHeight,
  contentWidth,
  contentHeight,
  portion,
) {
  if (
    !(stageWidth > 0) ||
    !(stageHeight > 0) ||
    !(contentWidth > 0) ||
    !(contentHeight > 0)
  ) {
    return 1;
  }
  return Math.min(
    (portion * stageWidth) / contentWidth,
    (portion * stageHeight) / contentHeight,
    1,
  );
}

/**
 * Which way one `wheel` event steps the scale, as panzoom's own handler
 * reads it.
 *
 * A shift-wheel on a Mac reports the gesture on `deltaX`; a plain wheel or a
 * touchpad reports `deltaY`. panzoom takes the horizontal axis only when the
 * vertical one is zero and reads the sign — up zooms in — so the same rule
 * gives the two paths an identical feel. A gesture without a usable delta
 * answers 0: nothing to step.
 */
function wheelDirection(event) {
  if (!event) {
    return 0;
  }
  var delta = event.deltaY === 0 && event.deltaX ? event.deltaX : event.deltaY;
  if (!Number.isFinite(delta)) {
    return 0;
  }
  return delta < 0 ? 1 : -1;
}

/**
 * One wheel notch of the transform engine, as pure arithmetic.
 *
 * The wheel listener cannot simply hand the event to panzoom's own
 * `zoomWithWheel`: its focal arithmetic assumes the transformed element rests
 * against the top-left of its parent, while the stage centres the picture
 * with flexbox — the anchor then drifts off the cursor by half the slack
 * between the two boxes on every notch, which the headless repro measured at
 * tens of pixels. This function derives the anchor from what is actually
 * true on the page instead. The element's rect centre is its rest centre
 * `O` — the transform origin — plus `scale * pan`, so
 * `O = centre - scale * pan` holds whatever the stage's padding, margins or
 * centering are; and the zoom that pins the point under the cursor is the
 * one whose focal, in panzoom's `zoom` convention, is the cursor offset from
 * `O` times the new scale.
 *
 * `geometry` carries `rect` (the content's laid-out-and-transformed box),
 * `pan` and `scale` (the engine's live state), and the `step`, `minScale`
 * and `maxScale` the engine itself was configured with; `event` carries the
 * cursor and the wheel deltas. Anything the anchor cannot be derived from —
 * an unmeasured box, a state the engine does not report, a gesture without
 * a delta — answers null, so the caller leaves the engine alone rather than
 * move it on a wrong guess. A cursor that is not on the page still answers
 * a scale, with `focal` null, for the caller to degrade to a centre zoom.
 */
export function wheelZoom(geometry, event) {
  var box = geometry && geometry.rect;
  var pan = geometry && geometry.pan;
  var scale = geometry && geometry.scale;
  if (
    !box ||
    !pan ||
    !Number.isFinite(box.left) ||
    !Number.isFinite(box.top) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    !Number.isFinite(pan.x) ||
    !Number.isFinite(pan.y) ||
    !Number.isFinite(scale) ||
    !(scale > 0)
  ) {
    return null;
  }
  var direction = wheelDirection(event);
  if (direction === 0) {
    return null;
  }
  var step = Number.isFinite(geometry.step) ? geometry.step : 0.3;
  var lower = Number.isFinite(geometry.minScale)
    ? geometry.minScale
    : -Infinity;
  var upper = Number.isFinite(geometry.maxScale) ? geometry.maxScale : Infinity;
  var toScale = Math.min(
    Math.max(scale * Math.exp((direction * step) / 3), lower),
    upper,
  );
  var origin = {
    x: box.left + box.width / 2 - scale * pan.x,
    y: box.top + box.height / 2 - scale * pan.y,
  };
  var focal = null;
  if (
    event &&
    Number.isFinite(event.clientX) &&
    Number.isFinite(event.clientY)
  ) {
    focal = {
      x: (event.clientX - origin.x) * toScale,
      y: (event.clientY - origin.y) * toScale,
    };
  }
  return { scale: toScale, focal: focal };
}
