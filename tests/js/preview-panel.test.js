/**
 * Tests for the preview's frame (`src/web/js/preview-panel.js`): the popover's
 * structure and the placement rules that keep it from crossing the link it
 * describes.
 *
 * The placement invariant is the heart of the file. Below the link by default;
 * above it when there is no room; on the roomier side, shrunk, when neither
 * side holds the whole panel; and always capped by a `max-height` so content
 * that grows after the measurement cannot push the bottom edge over the link.
 * A shrink belongs to the showing that asked for it, so the next hover measures
 * afresh.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS_CLASS,
  BODY_CLASS,
  CLOSE_CLASS,
  CLOSE_LABEL,
  HEAD_CLASS,
  HEAD_TEXT_CLASS,
  PIN_ATTRIBUTE,
  PIN_CLASS,
  PIN_LABEL,
} from "../../src/web/js/preview-view.js";
import {
  brokenLink,
  byClass,
  buttonOf,
  link,
  openPreview,
  panelOf,
  setup,
} from "./helpers/preview-fixture.js";

/**
 * Open the panel against a link placed at `rect`, with the panel standing
 * `panelHeight` pixels tall in a window `innerHeight` pixels high.
 *
 * The panel is created by a first, ordinary hover; its geometry is then given
 * the numbers under test and the panel is closed and reopened on the placed
 * link, because `position` reads the panel's height while it places it. The
 * window height is restored by `withFakeWindow` when the test ends.
 */
function openPlaced(ctx, rect, panelHeight, innerHeight) {
  const seed = link("#/doc/guide/intro.md#getting-started");
  ctx.content.appendChild(seed);
  ctx.view.tag(ctx.content);
  ctx.content.fire("pointerover", { target: seed, relatedTarget: null });
  ctx.clock.runAll();

  const panel = panelOf(ctx.doc);
  panel.offsetHeight = panelHeight;
  globalThis.innerHeight = innerHeight;

  ctx.content.fire("pointerout", { target: seed, relatedTarget: null });
  ctx.clock.runAll();

  const anchor = link("#/doc/guide/intro.md#getting-started");
  anchor.getBoundingClientRect = function () {
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    };
  };
  ctx.content.appendChild(anchor);
  ctx.view.tag(ctx.content);
  ctx.content.fire("pointerover", { target: anchor, relatedTarget: null });
  ctx.clock.runAll();

  return { anchor, panel };
}

test("a panel with room on neither side shrinks onto the roomier side above", () => {
  setup(function (ctx) {
    const { anchor, panel } = openPlaced(
      ctx,
      { top: 275, bottom: 296, left: 40, right: 160 },
      312,
      520,
    );

    // roomBelow = 520 - 10 - 304 = 206; roomAbove = 275 - 8 - 10 = 257.
    assert.equal(panel.style.maxHeight, "257px");
    assert.equal(parseFloat(panel.style.top), 10);
    assert.ok(
      10 + parseInt(panel.style.maxHeight, 10) <= 275,
      "the panel must end before the link it describes",
    );
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
});

test("a panel with room on neither side shrinks onto the roomier side below", () => {
  setup(function (ctx) {
    const { panel } = openPlaced(
      ctx,
      { top: 200, bottom: 221, left: 40, right: 160 },
      312,
      520,
    );

    // roomBelow = 510 - 229 = 281; roomAbove = 200 - 8 - 10 = 182.
    assert.equal(panel.style.maxHeight, "281px");
    assert.ok(
      parseFloat(panel.style.top) >= 221 + 8,
      "the panel must start one gap below the link it describes",
    );
    assert.equal(parseFloat(panel.style.top), 229);
  });
});

test("a panel the window holds below the link keeps its natural height", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);

    // below = 128; 128 + 200 fits inside 800 - 10: no shrink at all.
    assert.equal(panel.style.maxHeight, "");
    assert.equal(parseFloat(panel.style.top), 128);
  });
});

test("a panel that flips above the link is capped at its measured height", () => {
  setup(function (ctx) {
    // above = 230 - 8 - 200 = 22 >= 10: the whole panel fits above, and the
    // cap the placement writes equals the measured height, so nothing is
    // cut — but content that grows later cannot cross the link either.
    const { panel } = openPlaced(
      ctx,
      { top: 230, bottom: 250, left: 40, right: 160 },
      200,
      300,
    );

    assert.equal(panel.style.maxHeight, "200px");
    assert.equal(parseFloat(panel.style.top), 22);
  });
});

test("a panel placed above a bottom link never crosses it when it grows", () => {
  setup(function (ctx) {
    // The reported geometry: a link at 886/907 in a 1305-high window, the
    // panel measuring 753 — under the 60vh the stylesheet applies, so only
    // the placement's own cap stands between it and the link.
    const { anchor, panel } = openPlaced(
      ctx,
      { top: 886, bottom: 907, left: 40, right: 160 },
      753,
      1305,
    );

    assert.equal(parseFloat(panel.style.top), 125);
    assert.equal(panel.style.maxHeight, "753px");
    assert.ok(
      125 + 753 <= 886 - 8,
      "the panel must end one gap above the link it describes",
    );

    // The layout then disagrees with the measurement and the panel grows
    // past the cap. The cap holds — the body scrolls, the bottom edge stays
    // where the placement put it — and the next placement measures the
    // taller panel and still lands short of the link.
    panel.offsetHeight = 783;
    assert.equal(parseInt(panel.style.maxHeight, 10), 753);
    assert.ok(
      parseFloat(panel.style.top) + parseInt(panel.style.maxHeight, 10) <=
        886 - 8,
      "growth after the measurement must not push the panel over the link",
    );

    ctx.content.fire("pointerout", { target: anchor, relatedTarget: null });
    ctx.clock.runAll();
    ctx.content.fire("pointerover", { target: anchor, relatedTarget: null });
    ctx.clock.runAll();

    // above = 886 - 8 - 783 = 95; the cap follows the new measurement.
    assert.equal(parseFloat(panel.style.top), 95);
    assert.equal(panel.style.maxHeight, "783px");
    assert.ok(
      95 + 783 <= 886 - 8,
      "the replaced panel still ends one gap above the link",
    );
  });
});

test("a shrunk panel returns to its natural height on the next hover", () => {
  setup(function (ctx) {
    const { anchor, panel } = openPlaced(
      ctx,
      { top: 275, bottom: 296, left: 40, right: 160 },
      312,
      520,
    );
    assert.equal(panel.style.maxHeight, "257px");

    // The shrink belonged to the previous showing, not to the panel: reopened
    // against a link the window holds below, the panel measures afresh.
    ctx.content.fire("pointerout", { target: anchor, relatedTarget: null });
    ctx.clock.runAll();

    const other = link("#/doc/guide/intro.md#getting-started");
    ctx.content.appendChild(other);
    ctx.view.tag(ctx.content);
    ctx.content.fire("pointerover", { target: other, relatedTarget: null });
    ctx.clock.runAll();

    assert.equal(panel.style.maxHeight, "");
    assert.equal(parseFloat(panel.style.top), 128);
  });
});

test("the panel offers a pin and a close button", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);
    const actions = byClass(panel, ACTIONS_CLASS)[0];

    assert.ok(actions, "the buttons sit in their own group");
    assert.ok(
      byClass(panel, HEAD_TEXT_CLASS)[0],
      "the head keeps its text column",
    );

    const pin = buttonOf(panel, PIN_CLASS);
    assert.equal(pin.getAttribute("type"), "button");
    assert.equal(pin.getAttribute("aria-pressed"), "false");
    assert.equal(pin.getAttribute("aria-label"), PIN_LABEL);

    const close = buttonOf(panel, CLOSE_CLASS);
    assert.equal(close.getAttribute("type"), "button");
    assert.equal(close.getAttribute("aria-label"), CLOSE_LABEL);
    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      null,
      "a preview opens unpinned",
    );
  });
});

test("the panel builds its icons through the document, not through the svg", () => {
  setup(function (ctx) {
    const { view, doc, content, clock } = ctx;
    const anchor = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    // A real `SVGElement` has no `createElementNS`, so an icon that builds its
    // own `<path>` throws and the panel never appears — the defect that made
    // hovering do nothing in a browser while this file stayed green. Every SVG
    // node must therefore be created by the document.
    const panel = panelOf(doc);
    assert.ok(panel, "the panel must exist");
    const paths = [];
    (function walk(node) {
      (node.children || []).forEach(function (child) {
        if (child.tagName === "PATH") {
          paths.push(child);
        }
        walk(child);
      });
    })(panel);

    assert.equal(paths.length, 5, "the pin and the cross draw five strokes");
    const createdByDocument = doc.created.filter(
      (element) => element.tagName === "PATH",
    );
    assert.equal(
      createdByDocument.length,
      paths.length,
      "every path must come from `document.createElementNS`",
    );
  });
});

/* ---------- wheel over the panel ---------- */

test("a wheel over the panel outside its body is answered with nothing", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);
    const head = byClass(panel, HEAD_CLASS)[0];

    let prevented = false;
    panel.fire("wheel", {
      target: head,
      deltaY: 120,
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(
      prevented,
      true,
      "nothing in the head scrolls, so the default would reach the article",
    );
  });

  setup(function ({ view, content, clock, doc }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    const notice = byClass(panel, "preview-missing")[0];

    let prevented = false;
    panel.fire("wheel", {
      target: notice,
      deltaY: 120,
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(
      prevented,
      true,
      "the notice has no scroller either — the wheel must not leave the panel",
    );
    assert.equal(
      view.isOpen(),
      true,
      "a wheel the panel answered is not a scroll of the article",
    );
  });
});

test("a wheel over the scroll body keeps the browser's own scrolling", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);
    const scroll = byClass(panel, "preview-scroll")[0];
    // A target inside the body answers `closest` the way a real element does:
    // the guard asks it once, and the body it names keeps its default.
    const inside = {
      closest(selector) {
        return selector === "." + BODY_CLASS ? scroll : null;
      },
    };

    let prevented = false;
    panel.fire("wheel", {
      target: inside,
      deltaY: 120,
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(
      prevented,
      false,
      "the body scrolls the chapter; the stylesheet keeps the rest from chaining",
    );
  });
});
