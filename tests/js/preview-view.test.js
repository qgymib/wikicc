/**
 * Tests for the preview's composer (`src/web/js/preview-view.js`): the wiring
 * that tags the article's links, routes their clicks, and dismisses the panel
 * on the reader's explicit acts.
 *
 * A click is where the preview hands over. A sound block reference is already
 * a hash route, so the browser follows it; only a broken reference — whose
 * route carries no anchor to scroll to — is routed by hand, with its message
 * queued for the render the click causes. Escape and a scroll are the other
 * dismissals the composer owns; everything timing-shaped is the gestures'
 * business and lives in its own file.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PIN_ATTRIBUTE } from "../../src/web/js/preview-view.js";
import {
  DOC_LINK_ATTRIBUTE,
  INVALID_ATTRIBUTE,
  MISSING_CLASS,
} from "../../src/web/js/links.js";
import {
  brokenLink,
  clickInside,
  fireClick,
  link,
  openPreview,
  setup,
} from "./helpers/preview-fixture.js";

test("escape and scrolling close the notice", () => {
  setup(function ({ view, content, clock, fire }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    fire("keydown", { key: "Escape" });
    assert.equal(view.isOpen(), false, "escape dismisses the notice");
  });

  setup(function ({ view, content, clock, fire }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    fire("scroll", {});
    assert.equal(view.isOpen(), false, "a scroll dismisses the notice");
  });
});

test("a broken reference is tagged with its class and an expandable state", () => {
  setup(function ({ view, content }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(anchor.getAttribute(DOC_LINK_ATTRIBUTE), "");
    assert.ok(anchor.classList.contains(MISSING_CLASS));
    assert.equal(
      anchor.getAttribute("aria-expanded"),
      "false",
      "there is a notice to expand, so the state is announced",
    );
  });
});

test("a document reference is tagged with an expandable state", () => {
  setup(function ({ view, content }) {
    const anchor = link("#/doc/guide/intro.md");
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(anchor.getAttribute(DOC_LINK_ATTRIBUTE), "");
    assert.equal(
      anchor.getAttribute("aria-expanded"),
      "false",
      "there is a preview to expand, so the state is announced",
    );
  });
});

test("an external link is never tagged and never previews", () => {
  setup(function ({ view, content, clock }) {
    const anchor = link("https://example.com/page");
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(
      anchor.getAttribute(DOC_LINK_ATTRIBUTE),
      null,
      "only a route is a document link",
    );

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();

    assert.equal(view.isOpen(), false, "a network resource has no preview");
  });
});

test("clicking the document reference a pinned panel describes closes it", () => {
  setup(function (ctx) {
    const { view, content, clock, navigations } = ctx;
    const { anchor, panel } = openPreview(ctx, "#/doc/guide/intro.md");
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
    assert.equal(panel.getAttribute(PIN_ATTRIBUTE), null);
  });
});

test("clicking a broken reference still reports the chapter once", () => {
  setup(function ({ view, content, clock, messages, navigations }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    clock.runAll();
    content.fire("click", { target: anchor, button: 0, preventDefault() {} });

    assert.deepEqual(messages, [
      { docId: "guide/intro.md", anchor: "1.4 配色与字体" },
    ]);
    assert.deepEqual(navigations, [{ id: "guide/intro.md", anchor: null }]);
  });
});

test("a click closes the notice before navigating", () => {
  setup(function ({ view, content, clock, navigations }) {
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    content.fire("click", { target: anchor, button: 0, preventDefault() {} });

    assert.equal(view.isOpen(), false);
    assert.deepEqual(navigations, [{ id: "guide/intro.md", anchor: null }]);
  });
});

/* ---------- clicking a block reference ---------- */

/**
 * Click `anchor` and report whether the handler kept the browser out.
 *
 * The browser's own navigation is what makes a hash route work at all — it
 * writes the entry, fires `hashchange` and scrolls — so a click the reader
 * "helps" with has to be judged by whether it asked the browser to stand down.
 */
function click(anchor, event) {
  return fireClick(anchor.__content, anchor, event);
}

test("clicking a block reference leaves the navigation to the browser", () => {
  setup(function (ctx) {
    const { view, content, navigations } = ctx;
    const anchor = link("#/doc/guide/intro.md#getting-started");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    const prevented = click(anchor);

    assert.equal(
      prevented,
      false,
      "the browser must follow the href, which is what routes and scrolls",
    );
    assert.deepEqual(
      navigations,
      [],
      "the reader must not navigate a second time",
    );
  });
});

test("a modified click on a block reference is left alone as well", () => {
  setup(function (ctx) {
    const { view, content, navigations } = ctx;
    const anchor = link("#/doc/guide/intro.md#getting-started");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(click(anchor, { metaKey: true }), false);
    assert.equal(
      click(anchor, { button: 1 }),
      false,
      "a middle click opens a tab",
    );
    assert.deepEqual(navigations, []);
  });
});

test("clicking a link without a chapter still routes through the reader", () => {
  setup(function (ctx) {
    const { view, content, navigations } = ctx;
    const anchor = link("#/doc/guide/intro.md");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    const prevented = click(anchor);

    assert.equal(prevented, true, "the reader owns this navigation");
    assert.deepEqual(navigations, [{ id: "guide/intro.md", anchor: null }]);
  });
});

test("clicking a block reference closes the preview it opened", () => {
  setup(function (ctx) {
    const { view, content, clock } = ctx;
    const anchor = link("#/doc/guide/intro.md#getting-started");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    content.fire("pointerover", { target: anchor, relatedTarget: null });
    clock.runAll();
    assert.equal(view.isOpen(), true);

    click(anchor);

    assert.equal(
      view.isOpen(),
      false,
      "the panel must not survive the navigation",
    );
  });
});

test("a broken reference still reports its chapter and keeps the route in the reader", () => {
  setup(function (ctx) {
    const { view, content, messages, navigations } = ctx;
    const anchor = brokenLink("#/doc/guide/intro.md", "1.4 配色与字体");
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    const prevented = click(anchor);

    assert.equal(prevented, true, "the document has no anchor to scroll to");
    assert.deepEqual(messages, [
      { docId: "guide/intro.md", anchor: "1.4 配色与字体" },
    ]);
    assert.deepEqual(navigations, [{ id: "guide/intro.md", anchor: null }]);
  });
});

/* ---------- clicking a link the build marked as dead ---------- */

/* A dead link is one whose destination names nothing the site compiled — a
   missing document, a missing asset, a path out of the input folder. The
   build marks it; the reader's only job is to keep the click from leaving
   the page, because following the href can only end in a browser error. */

test("clicking a link with no target never navigates", () => {
  setup(function ({ view, content, navigations }) {
    const anchor = link("missing.md", { [INVALID_ATTRIBUTE]: "" });
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    const prevented = click(anchor);

    assert.equal(
      prevented,
      true,
      "the browser must not follow the href of a dead link",
    );
    assert.deepEqual(navigations, [], "the dead end stays where the reader is");
    assert.equal(view.isOpen(), false);
  });
});

test("a modified click on a dead link is stopped as well", () => {
  setup(function ({ view, content, navigations }) {
    const anchor = link("missing.md", { [INVALID_ATTRIBUTE]: "" });
    anchor.__content = content;
    content.appendChild(anchor);
    view.tag(content);

    assert.equal(click(anchor, { metaKey: true }), true);
    assert.equal(
      click(anchor, { button: 1 }),
      true,
      "a middle click would open the same dead end elsewhere",
    );
    assert.deepEqual(navigations, []);
  });
});

test("clicking a dead link dismisses an unpinned preview", () => {
  setup(function (ctx) {
    const { view, content } = ctx;
    openPreview(ctx);
    assert.equal(view.isOpen(), true);

    const dead = link("missing.md", { [INVALID_ATTRIBUTE]: "" });
    dead.__content = content;
    content.appendChild(dead);

    assert.equal(click(dead), true);
    assert.equal(
      view.isOpen(),
      false,
      "a dead link is still a click on the document, so the notice goes",
    );
  });
});
