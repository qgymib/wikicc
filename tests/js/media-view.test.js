/**
 * The media viewer: the providers' matching and mounting, the arming of the
 * wrappers the build rendered, and the click that opens a link's player.
 *
 * The viewer view is created with a recording engine, as the viewer's own
 * tests do, so the lightbox mechanics run the shipped code; the click
 * takeover records its `openFor` instead of the page's viewer, since panzoom
 * needs the layout of a real page. The wrappers and the anchors are fakes
 * with just the members the module under test reads.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createFakeDocument,
  createFakeElement,
  withGlobals,
} from "./helpers/dom.js";

import * as Links from "../../src/web/js/links.js";
import * as Media from "../../src/web/js/media.js";
import * as MediaView from "../../src/web/js/media-view.js";
import { createViewerView } from "../../src/web/js/viewer-view.js";

/** A fake page: a fresh document and a view over it, engines recorded. */
function makePage() {
  const doc = createFakeDocument();
  const view = createViewerView({
    createTransform: function () {
      return {
        zoomIn: function () {},
        zoomOut: function () {},
        reset: function () {},
        destroy: function () {},
        zoom: function () {},
      };
    },
  });
  return { doc: doc, view: view };
}

/** A media wrapper as the build writes it: a span around a player. */
function makeWrapper(kind, src) {
  const player = createFakeElement(kind);
  player.setAttribute("src", src);
  const wrapper = createFakeElement("span");
  wrapper.className = Media.MEDIA_WRAPPER_CLASS;
  wrapper.setAttribute(Media.MEDIA_KIND_ATTRIBUTE, kind);
  wrapper.querySelector = function (selector) {
    return selector === kind ? player : null;
  };
  return { wrapper: wrapper, player: player };
}

/** A link to a media asset, as the build leaves it. */
function makeAnchor(href, attributes) {
  const anchor = createFakeElement("a");
  anchor.setAttribute("href", href);
  Object.keys(attributes || {}).forEach(function (name) {
    anchor.setAttribute(name, attributes[name]);
  });
  return anchor;
}

/** A fake root whose wrapper query answers what a body would. */
function makeBodyWith(wrappers) {
  const body = createFakeElement("div");
  body.querySelectorAll = function (selector) {
    return selector === Media.WRAPPER_SELECTOR ? wrappers.slice() : [];
  };
  return body;
}

/** A click event stand-in over `target`, with a preventDefault counter. */
function clickEvent(target, options) {
  const settings = options || {};
  const state = { prevented: 0 };
  const event = {
    type: settings.type || "click",
    button: settings.button === undefined ? 0 : settings.button,
    ctrlKey: !!settings.ctrlKey,
    metaKey: !!settings.metaKey,
    shiftKey: !!settings.shiftKey,
    altKey: !!settings.altKey,
    detail: settings.detail === undefined ? 1 : settings.detail,
    target: target,
    preventDefault() {
      state.prevented += 1;
    },
  };
  return { event: event, state: state };
}

/** A click target whose `closest` answers the anchor a real page would. */
function targetOf(anchor) {
  return {
    closest(selector) {
      return selector === "a[href]" ? anchor : null;
    },
  };
}

/** Dependency stand-ins recording what the takeover opened. */
function recordingDeps() {
  const calls = { opened: [] };
  return {
    calls,
    deps: {
      openFor(element, event) {
        calls.opened.push({ element: element, event: event });
        return { opened: true };
      },
    },
  };
}

/** The window, header, actions row and stage of an open viewer. */
function partsOf(page) {
  const body = page.doc.body;
  const backdrop = body.children[body.children.length - 1];
  const frame = backdrop.children[0];
  const header = frame.children[0];
  return {
    backdrop: backdrop,
    frame: frame,
    header: header,
    heading: header.children[0],
    actions: header.children[1],
    stage: frame.children[1],
  };
}

/* ---------- arming ---------- */

test("arming a media wrapper hangs one corner button on it", () => {
  const page = makePage();
  const media = makeWrapper("audio", "song.mp3");

  withGlobals({ document: page.doc }, function () {
    assert.equal(MediaView.armMedia(makeBodyWith([media.wrapper])), 1);
  });

  const toolbars = media.wrapper.children.filter(function (child) {
    return child.className === "viewer-hover";
  });
  assert.equal(toolbars.length, 1);

  const button = toolbars[0].children[0];
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("aria-label"), "Open audio in viewer");
  assert.equal(button.getAttribute("title"), "Open audio in viewer");

  // The wrapper takes the focus back on close of a pointer session, like
  // any other host the viewer arms.
  assert.equal(media.wrapper.getAttribute("tabindex"), "-1");
  assert.equal(
    media.wrapper.className,
    Media.MEDIA_WRAPPER_CLASS + " viewer-host",
  );
});

test("a wrapper whose kind the providers do not know is left alone", () => {
  const page = makePage();
  const odd = makeWrapper("score", "sheet.music");

  withGlobals({ document: page.doc }, function () {
    assert.equal(MediaView.armMedia(makeBodyWith([odd.wrapper])), 0);
  });

  assert.equal(odd.wrapper.children.length, 0);
});

test("arming answers nothing for a root without wrappers", () => {
  const page = makePage();

  withGlobals({ document: page.doc }, function () {
    assert.equal(MediaView.armMedia(makeBodyWith([])), 0);
    assert.equal(MediaView.armMedia(null), 0);
  });
});

/* ---------- the providers ---------- */

test("an audio wrapper opens the window with the close button alone", () => {
  const page = makePage();
  const media = makeWrapper("audio", "song.mp3");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([media.wrapper]);
    page.view.openFor(media.wrapper);

    const parts = partsOf(page);
    assert.equal(parts.frame.getAttribute("aria-label"), "Audio");
    assert.equal(parts.heading.textContent, "Audio");

    // An audio player has nothing to zoom: the standard trio is off, the
    // viewer's own close is not.
    assert.deepEqual(
      Array.prototype.map.call(parts.actions.children, function (button) {
        return button.getAttribute("aria-label");
      }),
      ["Close viewer"],
    );

    const content = parts.stage.children[0];
    assert.equal(content.className, "viewer-content");
    const player = content.children[0];
    assert.equal(player.tagName, "AUDIO");
    assert.equal(player.getAttribute("controls"), "");
    assert.equal(player.getAttribute("preload"), "metadata");
    assert.equal(player.getAttribute("src"), "song.mp3");

    parts.actions.children[0].fire("click");
    assert.equal(page.view.isOpen(), false);
  });
});

test("a video wrapper opens the window with the standard actions", () => {
  const page = makePage();
  const media = makeWrapper("video", "clip.mp4");

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([media.wrapper]);
    page.view.openFor(media.wrapper);
  });

  const parts = partsOf(page);
  assert.equal(parts.frame.getAttribute("aria-label"), "Video");
  assert.equal(parts.heading.textContent, "Video");
  assert.deepEqual(
    Array.prototype.map.call(parts.actions.children, function (button) {
      return button.getAttribute("aria-label");
    }),
    ["Zoom in", "Zoom out", "Reset view", "Close viewer"],
  );

  const player = parts.stage.children[0].children[0];
  assert.equal(player.tagName, "VIDEO");
  assert.equal(player.getAttribute("src"), "clip.mp4");
});

test("a wrapper the build emptied opens nothing", () => {
  const page = makePage();
  const empty = createFakeElement("span");
  empty.className = Media.MEDIA_WRAPPER_CLASS;
  empty.setAttribute(Media.MEDIA_KIND_ATTRIBUTE, "audio");
  empty.querySelector = function () {
    return null;
  };

  withGlobals({ document: page.doc }, function () {
    page.view.armHover([empty]);
    assert.equal(page.view.openFor(empty), null);
  });

  assert.equal(page.doc.body.children.length, 0);
});

test("an anchor with a media href matches its provider too", () => {
  const page = makePage();
  const anchor = makeAnchor("assets/1f0c.mp3");

  withGlobals({ document: page.doc }, function () {
    page.view.openFor(anchor);
  });

  assert.equal(page.view.isOpen(), true);
  const player = partsOf(page).stage.children[0].children[0];
  assert.equal(player.tagName, "AUDIO");
  assert.equal(player.getAttribute("src"), "assets/1f0c.mp3");
});

/* ---------- the click takeover ---------- */

test("a plain left click on a media link opens the player in place", () => {
  const anchor = makeAnchor("assets/1f0c.mp3");
  const { deps, calls } = recordingDeps();
  const { event, state } = clickEvent(targetOf(anchor));

  assert.equal(MediaView.handleMediaLinkClick(event, deps), true);
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0].element, anchor);
  assert.equal(state.prevented, 1);
});

test("an inlined media data uri is taken over the same way", () => {
  const anchor = makeAnchor("data:audio/mpeg;base64,AAAA");
  const { deps, calls } = recordingDeps();
  const { event, state } = clickEvent(targetOf(anchor));

  assert.equal(MediaView.handleMediaLinkClick(event, deps), true);
  assert.equal(calls.opened.length, 1);
  assert.equal(state.prevented, 1);
});

test("a modified click, another button and a non-media href stay with the browser", () => {
  for (const settings of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
    { button: 2 },
  ]) {
    const anchor = makeAnchor("assets/1f0c.mp3");
    const { deps, calls } = recordingDeps();
    const { event, state } = clickEvent(targetOf(anchor), settings);

    assert.equal(
      MediaView.handleMediaLinkClick(event, deps),
      false,
      JSON.stringify(settings),
    );
    assert.equal(calls.opened.length, 0);
    assert.equal(state.prevented, 0);
  }

  for (const href of [
    "assets/1f0c.png",
    "assets/1f0c.pdf",
    "#/doc/notes.md",
    "",
  ]) {
    const anchor = makeAnchor(href);
    const { deps, calls } = recordingDeps();
    const { event, state } = clickEvent(targetOf(anchor));

    assert.equal(
      MediaView.handleMediaLinkClick(event, deps),
      false,
      `href: ${href}`,
    );
    assert.equal(calls.opened.length, 0);
    assert.equal(state.prevented, 0);
  }
});

test("a link the build marked as dead is left alone", () => {
  const anchor = makeAnchor("missing.mp3", {
    [Links.INVALID_ATTRIBUTE]: "",
  });
  const { deps, calls } = recordingDeps();
  const { event, state } = clickEvent(targetOf(anchor));

  assert.equal(MediaView.handleMediaLinkClick(event, deps), false);
  assert.equal(calls.opened.length, 0);
  assert.equal(state.prevented, 0);
});

test("a click the viewer cannot serve is not swallowed", () => {
  const anchor = makeAnchor("assets/1f0c.mp3");
  const { event, state } = clickEvent(targetOf(anchor));

  assert.equal(
    MediaView.handleMediaLinkClick(event, {
      openFor: function () {
        return null;
      },
    }),
    false,
  );
  assert.equal(state.prevented, 0);
});

test("a press outside any link, or without a target, is not taken over", () => {
  const { deps, calls } = recordingDeps();

  const stray = clickEvent({
    closest() {
      return null;
    },
  });
  assert.equal(MediaView.handleMediaLinkClick(stray.event, deps), false);

  const bare = clickEvent({});
  assert.equal(MediaView.handleMediaLinkClick(bare.event, deps), false);

  assert.equal(MediaView.handleMediaLinkClick(null, deps), false);
  assert.equal(MediaView.handleMediaLinkClick(stray.event, null), false);
  assert.equal(calls.opened.length, 0);
});

test("the listener routes the page's clicks through the injected viewer", () => {
  const doc = createFakeDocument();
  const anchor = makeAnchor("assets/1f0c.mp3");
  const opened = [];
  MediaView.listenForMediaClicks(doc, {
    openFor(element) {
      opened.push(element);
      return { opened: true };
    },
  });

  const { event, state } = clickEvent(targetOf(anchor));
  doc.fire("click", event);

  assert.deepEqual(opened, [anchor]);
  assert.equal(state.prevented, 1);
});

test("the listener without a viewer is still registered once", () => {
  const doc = createFakeDocument();
  MediaView.listenForMediaClicks(doc);
  MediaView.listenForMediaClicks(doc, {});
  assert.equal(doc.listeners.click.length, 2);

  // A document without listeners is left alone, like any listen call.
  MediaView.listenForMediaClicks(null);
});
