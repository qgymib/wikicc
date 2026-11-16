/**
 * Tests for the preview's gestures (`src/web/js/preview-gestures.js`): when
 * the panel opens and closes, what a reader's hand can do to it, and what a
 * claim protects it from.
 *
 * The second half of the file covers pinning: a panel the reader clicked on
 * belongs to them, so a pointer leaving it, a click elsewhere, a navigation or
 * a scroll must all leave it alone until it is closed on purpose. The drag and
 * resize sections drive the same claims from the head and the edges: a press
 * pins before it moves a pixel, the threshold keeps a click from nudging
 * anything, and the place and the size a gesture leaves behind survive until
 * the showing ends.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOSE_CLASS,
  CLOSE_DELAY_MS,
  DRAGGING_ATTRIBUTE,
  DRAG_LABEL,
  DRAG_THRESHOLD_PX,
  HEAD_CLASS,
  HOVER_DELAY_MS,
  LOADING_ATTRIBUTE,
  MIN_HEIGHT_PX,
  MIN_WIDTH_PX,
  MISSING_ATTRIBUTE,
  PIN_ATTRIBUTE,
  PIN_CLASS,
  PIN_LABEL,
  RESIZE_ATTRIBUTE,
  RESIZE_CLASS,
  RESIZE_DIRECTION_ATTRIBUTE,
  UNPIN_LABEL,
} from "../../src/web/js/preview-view.js";
import {
  brokenLink,
  byClass,
  buttonOf,
  clickInside,
  fakeElement,
  fireClick,
  link,
  openPreview,
  panelOf,
  payload,
  press,
  setup,
  textOf,
  travellingStore,
} from "./helpers/preview-fixture.js";

test("leaving a broken reference closes the notice", () => {
  setup(function ({ view, content, clock }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    assert.deepEqual(
      clock.delays(),
      [CLOSE_DELAY_MS],
      "leaving waits before closing",
    );
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
  });
});

test("the preview closes once the pointer leaves it", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    assert.deepEqual(
      clock.delays(),
      [CLOSE_DELAY_MS],
      "leaving waits before closing",
    );
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
  });
});

/* ---------- pinning ---------- */

test("clicking inside the panel pins it", () => {
  setup(function (ctx) {
    const { panel } = openPreview(ctx);

    clickInside(panel, byClass(panel, "preview-scroll")[0]);

    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(
      buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      buttonOf(panel, PIN_CLASS).getAttribute("aria-label"),
      UNPIN_LABEL,
    );
  });
});

test("a pinned preview survives the pointer leaving both the link and the panel", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    assert.deepEqual(clock.delays(), [], "a pinned panel arms no close timer");
    clock.runAll();

    panel.fire("pointerleave", {});
    assert.deepEqual(
      clock.delays(),
      [],
      "leaving the panel arms no close timer",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
});

test("a pinned preview survives a click elsewhere on the page", () => {
  setup(function (ctx) {
    const { view, content, doc, clock } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);

    content.fire("click", { target: { closest: () => null }, button: 0 });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panelOf(doc), panel, "the same panel stays on screen");
  });
});

test("a pinned preview survives a scroll", () => {
  setup(function (ctx) {
    const { view, clock, fire } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);

    fire("scroll", {});
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
  });
});

test("a pinned preview survives a navigation to another document", () => {
  setup(function (ctx) {
    const { view, content, clock, navigations } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;

    // Following a second reference: the panel describes the first chapter and
    // stays where it is, while the click still navigates. A sound block
    // reference is followed by the browser, so the navigation happens there
    // rather than through `onNavigate` — either way it is one navigation.
    const other = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(other);
    view.tag(content);
    const prevented = fireClick(content, other);
    clock.runAll();

    assert.equal(prevented, false, "the browser follows the reference");
    assert.deepEqual(navigations, []);
    assert.equal(
      view.isOpen(),
      true,
      "navigating does not dismiss a pinned panel",
    );
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(
      byClass(panel, "preview-scroll")[0].innerHTML,
      shown,
      "the content is unchanged",
    );
  });
});

/* ---------- pointer movement inside a link ---------- */

/**
 * A link as the reader receives it from Markdown, with inline children.
 *
 * `[测试](doc.md#chapter)` may carry `<code>`, `<strong>` or a second `<a>` in
 * its label, and a pointer moving across that label crosses those children
 * without ever leaving the link. The browser then fires `pointerover` on each
 * child it enters, which is the sequence that used to restart the open timer
 * for as long as the hand moved.
 */
function nestedLink(href) {
  const anchor = link(href);
  const inner = fakeElement("code");
  anchor.appendChild(inner);
  return { anchor, inner };
}

/**
 * Move the pointer in the way a browser reports it.
 *
 * Crossing from `from` to `to` fires, in this order: `pointerout` on `from`,
 * `pointerover` on `to`, then the boundary events `pointerleave` on `from` and
 * `pointerenter` on `to` (a browser derives those from the pair and, with an
 * `over`/`out` listener on an ancestor, does dispatch them). A test that fires
 * only the `pointerover` half never reproduces what a hand actually does.
 */
function movePointer(content, from, to) {
  content.fire("pointerout", { target: from, relatedTarget: to });
  content.fire("pointerover", { target: to, relatedTarget: from });
  content.fire("pointerleave", { target: from, relatedTarget: to });
  content.fire("pointerenter", { target: to, relatedTarget: from });
}

/** Move the pointer onto `to` from somewhere outside every link. */
function enterPointer(content, to) {
  movePointer(content, fakeElement("p"), to);
}

test("moving between the children of one link does not restart the open timer", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink(
      "#/doc/guide/intro.md#getting-started",
    );
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "the first hover arms the timer",
    );

    // The pointer is still on the link, it has merely crossed into the code
    // span inside its label: the browser reports an `out` and an `over` pair
    // whose `relatedTarget` sits inside the same link.
    movePointer(content, anchor, inner);
    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "crossing into the link's own child must not arm a second timer",
    );

    clock.runAll();

    assert.equal(
      view.isOpen(),
      true,
      "the preview must still open after the delay",
    );
  });
});

test("crossing a link with nested elements opens its preview", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink(
      "#/doc/guide/intro.md#getting-started",
    );
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    movePointer(content, anchor, inner);
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
});

test("a pointer leaving a link for its own child keeps the preview open", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink(
      "#/doc/guide/intro.md#getting-started",
    );
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    movePointer(content, anchor, inner);
    assert.deepEqual(
      clock.delays(),
      [],
      "moving inside the link arms no close timer",
    );
    clock.runAll();
    assert.equal(view.isOpen(), true);
  });
});

test("a pointer leaving the link for the page starts the close delay", () => {
  setup(function ({ view, content, clock }) {
    const { anchor } = nestedLink("#/doc/guide/intro.md#getting-started");
    const outside = fakeElement("p");
    content.appendChild(anchor);
    content.appendChild(outside);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    movePointer(content, anchor, outside);
    assert.deepEqual(
      clock.delays(),
      [CLOSE_DELAY_MS],
      "leaving the link waits before closing",
    );
    clock.runAll();

    assert.equal(view.isOpen(), false);
  });
});

test("repeated hovers over one link arm exactly one timer", () => {
  setup(function ({ view, content, clock }) {
    const { anchor, inner } = nestedLink(
      "#/doc/guide/intro.md#getting-started",
    );
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    for (let index = 0; index < 4; index += 1) {
      movePointer(content, anchor, inner);
      movePointer(content, inner, anchor);
    }

    assert.deepEqual(
      clock.delays(),
      [HOVER_DELAY_MS],
      "a pointer that keeps moving must not pile up timers",
    );
  });
});

test("a closed preview reopens when the same link is hovered again", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(anchor);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    // Closed by a scroll while the pointer never left the link: the reader is
    // asking to see the chapter again the moment they move back onto it.
    clock.fire("scroll", {});
    assert.equal(view.isOpen(), false);

    enterPointer(content, anchor);
    clock.runAll();

    assert.equal(view.isOpen(), true, "the link must be previewable again");
  });
});

test("a full enter/leave/enter cycle reopens the preview", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    const outside = fakeElement("p");
    content.appendChild(anchor);
    content.appendChild(outside);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    movePointer(content, anchor, outside);
    clock.runAll();
    assert.equal(view.isOpen(), false);

    movePointer(content, outside, anchor);
    clock.runAll();

    assert.equal(
      view.isOpen(),
      true,
      "hovering again after a close must open again",
    );
  });
});

test("a close armed before re-entering the link never fires", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("#/doc/guide/intro.md#getting-started");
    const outside = fakeElement("p");
    content.appendChild(anchor);
    content.appendChild(outside);
    view.tag(content);

    enterPointer(content, anchor);
    clock.runAll();
    assert.equal(view.isOpen(), true);

    // Leaving arms the close delay, and re-entering right after cancels it.
    movePointer(content, anchor, outside);
    movePointer(content, outside, anchor);

    clock.runAll();

    assert.equal(
      view.isOpen(),
      true,
      "the stale close timer must not close the panel",
    );
  });
});

test("a superseded open timer does not open the wrong link", () => {
  setup(function ({ view, content, clock, doc }) {
    const first = link("#/doc/guide/intro.md#getting-started");
    const second = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(first);
    content.appendChild(second);
    view.tag(content);

    enterPointer(content, first);
    movePointer(content, first, second);

    clock.runAll();

    const panel = panelOf(doc);
    assert.equal(view.isOpen(), true);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      "true",
      "the second link is the one shown",
    );
  });
});

test("a pinned panel ignores pointer boundary events", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;

    const other = link("#/doc/guide/intro.md#getting-started");
    content.appendChild(other);
    view.tag(content);

    enterPointer(content, other);
    assert.deepEqual(
      clock.delays(),
      [],
      "no preview is scheduled over a pinned one",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(byClass(panel, "preview-scroll")[0].innerHTML, shown);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
  });
});

test("hovering another reference leaves a pinned preview alone", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;

    const other = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(other);
    ctx.view.tag(content);

    content.fire("pointerover", { target: other, relatedTarget: null });
    assert.deepEqual(
      clock.delays(),
      [],
      "no preview is scheduled over a pinned one",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      null,
      "the pinned role is unchanged",
    );
    assert.equal(byClass(panel, "preview-scroll")[0].innerHTML, shown);
  });
});

test("the pin button pins and unpins an open preview", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { anchor, panel } = openPreview(ctx);
    const pin = buttonOf(panel, PIN_CLASS);

    press(pin);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(pin.getAttribute("aria-pressed"), "true");
    assert.equal(pin.getAttribute("aria-label"), UNPIN_LABEL);

    press(pin);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(pin.getAttribute("aria-pressed"), "false");
    assert.equal(pin.getAttribute("aria-label"), PIN_LABEL);

    // Unpinning hands the panel back to the pointer: leaving closes it.
    assert.equal(
      view.isOpen(),
      true,
      "the panel stays while the click is still on it",
    );
    content.fire("pointerout", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), false);
  });
});

test("the close button closes a pinned preview and clears its state", () => {
  setup(function (ctx) {
    const { view, content, clock, doc } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);

    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      null,
      "no pinned frame is left behind",
    );
    assert.equal(panel.hidden, true);
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
    assert.equal(panelOf(doc), panel, "the panel is still the one instance");

    // The next hover opens an unpinned preview again.
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(
      buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"),
      "false",
    );
  });
});

test("clicking the reference a pinned panel describes unpins and closes it", () => {
  setup(function (ctx) {
    const { view, content, clock, navigations } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);

    let prevented = false;
    content.fire("click", {
      target: anchor,
      button: 0,
      preventDefault() {
        prevented = true;
      },
    });
    clock.runAll();

    assert.equal(
      prevented,
      true,
      "the browser must not follow the link as well",
    );
    assert.equal(view.isOpen(), false);
    assert.deepEqual(navigations, [], "closing the panel is not a navigation");
    assert.equal(anchor.getAttribute("aria-expanded"), "false");
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
  });
});

test("escape still closes a pinned preview", () => {
  setup(function (ctx) {
    const { view, clock, fire } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);

    fire("keydown", { key: "Escape" });
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
  });
});

test("hovering the reference again reopens the preview after it was closed", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);
    press(buttonOf(panel, PIN_CLASS));

    // Closed on purpose while the pointer is elsewhere: the panel forgets both
    // the pin and the link it described, so the next hover is an ordinary
    // first hover rather than one the old anchor could dismiss.
    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();
    assert.equal(view.isOpen(), false);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
});

test("unpinning with the pointer away closes the panel after the delay", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const { anchor, panel } = openPreview(ctx);
    clickInside(panel);

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true, "a pinned panel ignores the pointer");

    press(buttonOf(panel, PIN_CLASS));
    assert.equal(view.isOpen(), true, "the click is still on the panel");
    assert.deepEqual(
      clock.delays(),
      [CLOSE_DELAY_MS],
      "the grace period comes back",
    );

    clock.runAll();
    assert.equal(view.isOpen(), false);
  });
});

test("a notice can be pinned and closed with the same two buttons", () => {
  setup(function (ctx) {
    const { view, content, clock, doc } = ctx;
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    clickInside(panel);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), "true");

    content.fire("pointerout", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true, "a pinned notice stays too");

    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();

    assert.equal(view.isOpen(), false);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
    assert.equal(panel.getAttribute(MISSING_ATTRIBUTE), null);
  });
});

test("switching documents keeps a pinned preview and drops nothing of it", () => {
  setup(function (ctx) {
    const { view, content, clock, doc } = ctx;
    const { panel } = openPreview(ctx);
    clickInside(panel);
    const shown = byClass(panel, "preview-scroll")[0].innerHTML;

    // A render replaces the article and re-tags the new links; the panel lives
    // on `body`, so nothing it holds is touched.
    view.tag(content);
    content.fire("pointerout", { target: content, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(byClass(panel, "preview-scroll")[0].innerHTML, shown);
    assert.equal(panelOf(doc), panel);
  });
});

/* ---------- dragging the panel by its head ---------- */

/** A press on the head, dispatched where the view listens for it. */
function pressHead(_panel, head, x, y) {
  let prevented = false;
  head.fire("pointerdown", {
    target: head,
    button: 0,
    clientX: x,
    clientY: y,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });

  return prevented;
}

/** A pointer move during a drag, dispatched on the page rather than the head. */
function dragTo(fire, x, y) {
  fire("pointermove", { clientX: x, clientY: y });
}

/** A pointer release, wherever the pointer happens to be. */
function releasePointer(fire, x, y) {
  fire("pointerup", { clientX: x, clientY: y });
}

/**
 * Open a preview and hand back its panel and head.
 *
 * The panel is positioned against the link before the first press, which is
 * what a reader always starts from: `left`/`top` are already written.
 */
function openPanel(ctx) {
  const opened = openPreview(ctx);
  return Object.assign(
    { head: byClass(opened.panel, HEAD_CLASS)[0] },
    ctx,
    opened,
  );
}

test("the head is the handle a reader drags the panel by", () => {
  setup(function (ctx) {
    const { panel, head } = openPanel(ctx);

    assert.ok(head, "the head is the element the pointer has to find");
    assert.equal(head.getAttribute("title"), DRAG_LABEL);
    assert.equal(
      panel.getAttribute(DRAGGING_ATTRIBUTE),
      null,
      "nothing is being dragged yet",
    );
  });
});

test("dragging the head moves the panel with the pointer", () => {
  setup(function (ctx) {
    const { panel, head, fire } = openPanel(ctx);
    const left = parseFloat(panel.style.left);
    const top = parseFloat(panel.style.top);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 57, 110 + 40);

    assert.equal(parseFloat(panel.style.left), left + DRAG_THRESHOLD_PX + 57);
    assert.equal(parseFloat(panel.style.top), top + 40);
    assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), "true");

    releasePointer(fire, 160, 150);

    assert.equal(
      panel.getAttribute(DRAGGING_ATTRIBUTE),
      null,
      "the drag is over",
    );
    assert.equal(
      parseFloat(panel.style.left),
      left + DRAG_THRESHOLD_PX + 57,
      "the panel stays where the reader let go",
    );
  });
});

test("a drag pins the panel before it moves a pixel", () => {
  setup(function (ctx) {
    const { view, content, panel, head, clock, fire, anchor } = openPanel(ctx);
    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      null,
      "a hovered preview is unpinned",
    );

    pressHead(panel, head, 100, 110);

    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      "true",
      "the press itself claims the panel",
    );
    assert.equal(
      buttonOf(panel, PIN_CLASS).getAttribute("aria-pressed"),
      "true",
    );

    // The pointer leaves the link on its way out of the panel: a pinned panel
    // must not arm the close delay it is guarded against.
    content.fire("pointerout", { target: anchor, relatedTarget: null });
    panel.fire("pointerleave", {});
    fire("scroll", {});
    assert.deepEqual(
      clock.delays(),
      [],
      "no delay may take a dragged panel away",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
  });
});

test("a press on the head without movement moves nothing", () => {
  setup(function (ctx) {
    const { panel, head, fire } = openPanel(ctx);
    const left = panel.style.left;
    const top = panel.style.top;

    pressHead(panel, head, 100, 110);
    // Sub-threshold jitter: a hand on a mouse button is never perfectly still.
    dragTo(fire, 100 + DRAG_THRESHOLD_PX - 1, 110 + 1);
    releasePointer(fire, 101, 111);

    assert.equal(panel.style.left, left, "a click must not nudge the panel");
    assert.equal(panel.style.top, top);
    assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), null);
  });
});

test("a press on a head button starts no drag", () => {
  setup(function (ctx) {
    const { panel, fire } = openPanel(ctx);
    const left = panel.style.left;

    for (const className of [PIN_CLASS, CLOSE_CLASS]) {
      const button = buttonOf(panel, className);
      pressHead(panel, button, 100, 110);
      dragTo(fire, 100 + DRAG_THRESHOLD_PX + 80, 110);
      releasePointer(fire, 200, 110);

      assert.equal(
        panel.style.left,
        left,
        "the buttons keep their own meaning",
      );
      assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), null);
    }
  });
});

test("the head of a panel the pointer reached by keyboard drags as well", () => {
  setup(function (ctx) {
    const { view, panel, head, fire } = openPanel(ctx);
    // The reader never pressed the panel before: this drag is the first act.
    const left = parseFloat(panel.style.left);

    pressHead(panel, head, 50, 60);
    dragTo(fire, 50 + DRAG_THRESHOLD_PX + 20, 60 + 5);
    releasePointer(fire, 73, 65);

    assert.equal(parseFloat(panel.style.left), left + DRAG_THRESHOLD_PX + 20);
    assert.equal(view.isOpen(), true);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
    assert.equal(panelOf(ctx.doc), panel, "the same panel, in a new place");
  });
});

test("a drag cannot carry the panel out of the viewport", () => {
  setup(function (ctx) {
    const { panel, head, fire } = openPanel(ctx);
    // The stub is 480 wide and 200 tall, in a 1200 x 800 viewport, and the
    // margin the automatic placement already keeps is the one a drag keeps.
    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 - 5000, 110 - 5000);
    releasePointer(fire, 0, 0);

    assert.equal(parseFloat(panel.style.left), 10);
    assert.equal(parseFloat(panel.style.top), 10);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + 5000, 110 + 5000);
    releasePointer(fire, 5200, 5300);

    assert.equal(parseFloat(panel.style.left), 1200 - 480 - 10);
    assert.equal(parseFloat(panel.style.top), 800 - 200 - 10);
  });
});

test("a dragged panel keeps its place until it is closed", () => {
  setup(function (ctx) {
    const { view, content, panel, head, clock, fire } = openPanel(ctx);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 40, 110 + 30);
    releasePointer(fire, 143, 140);
    const left = panel.style.left;
    const top = panel.style.top;

    // A second drag starts from where the first one ended.
    pressHead(panel, head, 200, 200);
    dragTo(fire, 200 + DRAG_THRESHOLD_PX + 10, 200 + 10);
    releasePointer(fire, 213, 213);

    assert.equal(
      parseFloat(panel.style.left),
      parseFloat(left) + DRAG_THRESHOLD_PX + 10,
    );
    assert.equal(parseFloat(panel.style.top), parseFloat(top) + 10);

    // A render, a scroll and the pointer leaving all leave it alone.
    view.tag(content);
    content.fire("pointerout", { target: content, relatedTarget: null });
    fire("scroll", {});
    panel.fire("pointerleave", {});
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(
      panel.style.left,
      String(parseFloat(left) + DRAG_THRESHOLD_PX + 10) + "px",
    );
  });
});

test("closing a dragged panel forgets where the reader put it", () => {
  setup(function (ctx) {
    const { view, content, panel, head, clock, fire, anchor } = openPanel(ctx);
    const original = panel.style.left;

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 200, 110 + 120);
    releasePointer(fire, 303, 230);
    assert.notEqual(panel.style.left, original, "the drag really moved it");

    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();
    assert.equal(view.isOpen(), false);

    // The next preview is an ordinary one, placed against its own link.
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(
      panel.style.left,
      original,
      "the manual place does not outlive the panel",
    );
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
  });
});

test("a notice is dragged by the same head", () => {
  setup(function (ctx) {
    const { view, content, clock, fire, doc } = ctx;
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");

    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    const panel = panelOf(doc);
    const head = byClass(panel, HEAD_CLASS)[0];
    const left = parseFloat(panel.style.left);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 30, 110 + 20);
    releasePointer(fire, 133, 130);

    assert.equal(parseFloat(panel.style.left), left + DRAG_THRESHOLD_PX + 30);
    assert.equal(
      panel.getAttribute(MISSING_ATTRIBUTE),
      "true",
      "the notice keeps its role",
    );
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), "true");
  });
});

test("a release outside the panel ends the drag", () => {
  setup(function (ctx) {
    const { panel, head, fire } = openPanel(ctx);

    pressHead(panel, head, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX + 10, 110);
    releasePointer(fire, 5000, 5000);
    const left = panel.style.left;

    // Nothing listens any more, so a stray move cannot drag a panel nobody holds.
    fire("pointermove", { clientX: 900, clientY: 700 });

    assert.equal(panel.style.left, left);
    assert.equal(panel.getAttribute(DRAGGING_ATTRIBUTE), null);
  });
});

/* ---------- resizing the panel by its edges ---------- */

/** The panel's one handle for `direction`, or `null` when it has none. */
function handleOf(panel, direction) {
  const found = byClass(panel, RESIZE_CLASS).filter(function (handle) {
    return handle.getAttribute(RESIZE_DIRECTION_ATTRIBUTE) === direction;
  });

  return found[0] || null;
}

/** A press on a resize handle, dispatched on the handle itself. */
function pressHandle(handle, x, y) {
  let prevented = false;
  handle.fire("pointerdown", {
    target: handle,
    button: 0,
    clientX: x,
    clientY: y,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });

  return prevented;
}

/** Open the ordinary preview and hand back its three handles with it. */
function openResizable(ctx) {
  const opened = openPreview(ctx);
  // A real element's style properties read "" before anything writes them;
  // the stub's style is a plain object, so the axes the view may leave
  // untouched are seeded to keep the browser's semantics.
  opened.panel.style.width = "";
  opened.panel.style.height = "";
  opened.panel.style.maxHeight = "";
  opened.panel.offsetWidth = 480;
  opened.panel.offsetHeight = 200;

  return Object.assign({}, ctx, opened, {
    east: handleOf(opened.panel, "e"),
    south: handleOf(opened.panel, "s"),
    corner: handleOf(opened.panel, "se"),
  });
}

test("the panel wears one handle per resizable edge", () => {
  setup(function (ctx) {
    const { panel } = openResizable(ctx);

    assert.ok(handleOf(panel, "e"), "the east edge is a handle");
    assert.ok(handleOf(panel, "s"), "the south edge is a handle");
    assert.ok(handleOf(panel, "se"), "the corner is a handle");
    assert.equal(
      panel.getAttribute(RESIZE_ATTRIBUTE),
      null,
      "nothing is being resized yet",
    );
  });
});

test("dragging the east handle changes the width and leaves the height alone", () => {
  setup(function (ctx) {
    const { panel, east, fire } = openResizable(ctx);

    pressHandle(east, 100, 110);
    dragTo(fire, 100 + 57, 110);

    assert.equal(panel.style.width, "537px");
    assert.equal(
      panel.style.height,
      "",
      "an east resize leaves the height to the content and the placement",
    );
    assert.equal(panel.style.maxHeight, "");
    assert.equal(panel.getAttribute(RESIZE_ATTRIBUTE), "true");

    releasePointer(fire, 157, 110);

    assert.equal(
      panel.getAttribute(RESIZE_ATTRIBUTE),
      null,
      "the resize is over",
    );
    assert.equal(
      panel.style.width,
      "537px",
      "the panel keeps the size the gesture left",
    );
  });
});

test("dragging the south handle changes the height and leaves the width alone", () => {
  setup(function (ctx) {
    const { panel, south, fire } = openResizable(ctx);

    pressHandle(south, 100, 110);
    dragTo(fire, 100, 110 + 40);

    assert.equal(panel.style.height, "240px");
    assert.equal(
      panel.style.maxHeight,
      "240px",
      "the stylesheet's own share of the window must not cap the reader's",
    );
    assert.equal(
      panel.style.width,
      "",
      "a south resize leaves the width alone",
    );

    releasePointer(fire, 100, 150);

    assert.equal(panel.style.height, "240px", "the height stays");
  });
});

test("dragging the corner changes both axes at once", () => {
  setup(function (ctx) {
    const { panel, corner, fire } = openResizable(ctx);

    pressHandle(corner, 100, 110);
    dragTo(fire, 100 + 57, 110 + 40);

    assert.equal(panel.style.width, "537px");
    assert.equal(panel.style.height, "240px");
    assert.equal(panel.style.maxHeight, "240px");

    releasePointer(fire, 157, 150);
  });
});

test("a press on a handle without movement changes nothing", () => {
  setup(function (ctx) {
    const { panel, east, fire } = openResizable(ctx);

    pressHandle(east, 100, 110);
    dragTo(fire, 100 + DRAG_THRESHOLD_PX - 1, 110);
    releasePointer(fire, 102, 110);

    assert.equal(panel.style.width, "", "a click must not nudge the frame");
    assert.equal(panel.getAttribute(RESIZE_ATTRIBUTE), null);
  });
});

test("a resize cannot shrink the panel below its floor", () => {
  setup(function (ctx) {
    const { panel, corner, fire } = openResizable(ctx);

    pressHandle(corner, 100, 110);
    dragTo(fire, 100 - 5000, 110 - 5000);

    assert.equal(panel.style.width, MIN_WIDTH_PX + "px");
    assert.equal(panel.style.height, MIN_HEIGHT_PX + "px");

    releasePointer(fire, 0, 0);
  });
});

test("a resize cannot carry the panel out of the viewport", () => {
  setup(function (ctx) {
    const { panel, east, south, fire } = openResizable(ctx);
    // The stub is 480 wide and 200 tall, placed at 40/128, in a 1200 x 800
    // window; the margin the automatic placement keeps is the one a resize
    // keeps too.

    pressHandle(east, 100, 110);
    dragTo(fire, 100 + 5000, 110);
    assert.equal(panel.style.width, "1150px", "1200 - 40 - 10");

    releasePointer(fire, 5100, 110);

    pressHandle(south, 100, 110);
    dragTo(fire, 100, 110 + 5000);
    assert.equal(panel.style.height, "662px", "800 - 128 - 10");
    assert.equal(panel.style.maxHeight, "662px");

    releasePointer(fire, 100, 5100);
  });
});

test("a press on a handle claims the panel before it moves a pixel", () => {
  setup(function (ctx) {
    const { view, content, panel, east, clock, fire, anchor } =
      openResizable(ctx);
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);

    pressHandle(east, 100, 110);

    assert.equal(
      panel.getAttribute(PIN_ATTRIBUTE),
      "true",
      "the press itself claims the panel",
    );

    // The pointer leaves the link on its way out of the panel: a pinned panel
    // must not arm the close delay it is guarded against.
    content.fire("pointerout", { target: anchor, relatedTarget: null });
    panel.fire("pointerleave", {});
    fire("scroll", {});
    assert.deepEqual(
      clock.delays(),
      [],
      "no delay may take a panel mid-resize away",
    );
    clock.runAll();

    assert.equal(view.isOpen(), true);
  });
});

test("a resized panel keeps its size until it is closed", () => {
  setup(function (ctx) {
    const { view, content, panel, corner, clock, fire } = openResizable(ctx);

    pressHandle(corner, 100, 110);
    dragTo(fire, 100 + 57, 110 + 40);
    releasePointer(fire, 157, 150);

    // A render, a scroll and the pointer leaving all leave it alone.
    view.tag(content);
    content.fire("pointerout", { target: content, relatedTarget: null });
    fire("scroll", {});
    panel.fire("pointerleave", {});
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.style.width, "537px");
    assert.equal(panel.style.height, "240px");
  });
});

test("closing a resized panel forgets the size", () => {
  setup(function (ctx) {
    const { view, content, panel, corner, clock, fire, anchor } =
      openResizable(ctx);

    pressHandle(corner, 100, 110);
    dragTo(fire, 100 + 57, 110 + 40);
    releasePointer(fire, 157, 150);
    assert.notEqual(panel.style.width, "", "the resize really took");

    press(buttonOf(panel, CLOSE_CLASS));
    clock.runAll();
    assert.equal(view.isOpen(), false);
    assert.equal(panel.style.width, "");
    assert.equal(panel.style.height, "");
    assert.equal(panel.style.maxHeight, "");

    // The next preview is an ordinary one, opened at the stylesheet's size.
    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), true);
    assert.equal(panel.style.width, "");
    assert.equal(panel.style.height, "");
    assert.equal(panel.style.maxHeight, "");
  });
});

test("a release outside the panel ends the resize", () => {
  setup(function (ctx) {
    const { panel, east, fire } = openResizable(ctx);

    pressHandle(east, 100, 110);
    dragTo(fire, 100 + 10, 110);
    releasePointer(fire, 5000, 5000);

    // Nothing listens any more, so a stray move cannot resize a panel nobody
    // holds.
    fire("pointermove", { clientX: 900, clientY: 700 });

    assert.equal(panel.style.width, "490px");
    assert.equal(panel.getAttribute(RESIZE_ATTRIBUTE), null);
  });
});

test("a resized panel is not re-anchored when its document arrives", () => {
  const travelling = travellingStore();

  setup(
    function ({ view, content, clock, doc, fire }) {
      const anchor = link("#/doc/guide/intro.md#getting-started");
      content.appendChild(anchor);
      view.tag(content);

      content.fire("pointerover", { target: anchor, relatedTarget: null });
      clock.runAll();
      const panel = panelOf(doc);
      assert.equal(
        panel.getAttribute(LOADING_ATTRIBUTE),
        "true",
        "the panel is up before the document is",
      );
      panel.style.width = "";
      panel.style.height = "";
      panel.style.maxHeight = "";
      panel.offsetWidth = 480;
      panel.offsetHeight = 200;

      pressHandle(handleOf(panel, "se"), 100, 110);
      dragTo(fire, 100 + 57, 110 + 40);
      releasePointer(fire, 157, 150);
      assert.equal(panel.style.width, "537px");

      travelling.deliver(payload().get("guide/intro.md"));

      assert.equal(view.isOpen(), true);
      assert.match(textOf(panel), /Getting Started/);
      assert.equal(
        panel.style.width,
        "537px",
        "the fill must not re-anchor a panel placed by hand",
      );
      assert.equal(panel.style.height, "240px");
      assert.equal(panel.style.maxHeight, "240px");
    },
    { documents: travelling.store },
  );
});
