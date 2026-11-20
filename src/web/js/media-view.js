/**
 * The media viewer: providers for sound and film, and the click that opens
 * them.
 *
 * Two shapes of media reach the page. The build wraps the media it rendered
 * — an image or an embed of a sound or a film — in a `.doc-media` span, and
 * that wrapper is armed with the hover toolbar exactly like a diagram: the
 * wrapper, not the element inside it, is what a toolbar can hang on and
 * what the reader can hover. A link to a media asset — `[listen](song.mp3)`
 * — keeps its plain shape, and the click is its gesture: one delegated
 * listener opens the player in the viewer instead of handing the bytes to a
 * new tab. Only a plain left click is claimed; a modified click, another
 * button and a dead link stay with the browser.
 *
 * The providers mount a *fresh* element onto the stage, not a clone of the
 * page's: the page's own player keeps its playback state, and the viewer's
 * copy is a second performance of the same source, starting where a player
 * starts. An audio player has nothing to zoom, so its provider answers the
 * standard-actions question with `false` and the window carries the close
 * button alone; a video keeps the zoom, pan and reset the diagrams have.
 *
 * `media.js` holds the policy (which hrefs are media) without a DOM; this
 * module owns the page, and `app.js` registers the click listener beside
 * the inlined-asset takeover, which steps aside for media.
 */

import * as Links from "./links.js";
import * as Media from "./media.js";
import * as Viewer from "./viewer.js";
import { t } from "./i18n.js";
import { viewerView } from "./viewer-view.js";

/**
 * The kind of media `element` carries, or `null`.
 *
 * A wrapper answers through the attribute the build wrote; a link answers
 * through its `href`, by the same lookup the click takeover uses. Any other
 * element carries nothing the viewer plays.
 */
function kindOf(element) {
  if (!element) {
    return null;
  }
  if (
    element.classList &&
    typeof element.classList.contains === "function" &&
    element.classList.contains(Media.MEDIA_WRAPPER_CLASS)
  ) {
    var kind = element.getAttribute(Media.MEDIA_KIND_ATTRIBUTE);
    return kind === "audio" || kind === "video" ? kind : null;
  }
  var href =
    typeof element.getAttribute === "function"
      ? element.getAttribute("href")
      : null;
  return Media.mediaKindOfHref(href);
}

/** The address a wrapper's own player or a link's `href` points at. */
function sourceOf(element, tag) {
  var href =
    typeof element.getAttribute === "function"
      ? element.getAttribute("href")
      : null;
  if (href) {
    return href;
  }
  var player =
    typeof element.querySelector === "function"
      ? element.querySelector(tag)
      : null;
  return player && typeof player.getAttribute === "function"
    ? player.getAttribute("src")
    : null;
}

/**
 * Build the player the viewer shows, detached.
 *
 * `null` when there is no source to play — a wrapper the build emptied, an
 * anchor without an `href` — so the viewer leaves the page exactly as it
 * was rather than open on nothing.
 */
function mountPlayer(element, tag) {
  var source = sourceOf(element, tag);
  if (
    !source ||
    typeof document === "undefined" ||
    typeof document.createElement !== "function"
  ) {
    return null;
  }

  var player = document.createElement(tag);
  player.setAttribute("controls", "");
  player.setAttribute("preload", "metadata");
  player.setAttribute("src", source);

  var content = document.createElement("div");
  content.className = Viewer.CONTENT_CLASS;
  content.appendChild(player);
  return content;
}

/** The provider for a sound: the window carries the close button alone. */
var audioProvider = {
  type: "audio",
  matches: function (element) {
    return kindOf(element) === "audio";
  },
  hoverLabel: function () {
    return t("viewer.openAudio");
  },
  title: function () {
    return t("viewer.audioTitle");
  },
  standardActions: function () {
    return false;
  },
  mount: function (element) {
    var kind = kindOf(element);
    return kind ? mountPlayer(element, kind) : null;
  },
};

/** The provider for a film: the standard zoom, pan and reset stay. */
var videoProvider = {
  type: "video",
  matches: function (element) {
    return kindOf(element) === "video";
  },
  hoverLabel: function () {
    return t("viewer.openVideo");
  },
  title: function () {
    return t("viewer.videoTitle");
  },
  mount: function (element) {
    var kind = kindOf(element);
    return kind ? mountPlayer(element, kind) : null;
  },
};

Viewer.registerProvider(audioProvider);
Viewer.registerProvider(videoProvider);

/**
 * Hang the hover toolbar on every media wrapper in `root`.
 *
 * Answers how many were armed. Runs after each render, like the diagrams':
 * the wrappers are fresh markup every time, so the toolbars are too. Links
 * are deliberately not armed — the click itself is their gesture — and a
 * wrapper whose kind the providers do not know is left alone.
 */
export function armMedia(root) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return 0;
  }
  var wrappers = root.querySelectorAll(Media.WRAPPER_SELECTOR);
  if (!wrappers || typeof wrappers.length !== "number") {
    return 0;
  }
  return viewerView.armHover(Array.prototype.slice.call(wrappers));
}

/**
 * Answer a click on a link to a media asset by opening the viewer's player.
 *
 * Returns whether the click was taken over; `false` leaves the event with
 * the browser, or with the reader's own routing of document links. Only a
 * plain left click is claimed — a modified click, another button and the
 * context menu keep the platform's gesture — and a link the build marked as
 * dead is left alone too, because a dead destination has no bytes to play.
 * The default is cancelled only after the viewer really opened: a click the
 * reader cannot serve is a click it does not swallow.
 */
export function handleMediaLinkClick(event, deps) {
  if (!event || !deps || typeof deps.openFor !== "function") {
    return false;
  }
  if (!Links.isPlainLeftClick(event)) {
    return false;
  }

  var target = event.target;
  if (!target || typeof target.closest !== "function") {
    return false;
  }
  var anchor = target.closest("a[href]");
  if (!anchor) {
    return false;
  }
  if (
    typeof anchor.getAttribute === "function" &&
    anchor.getAttribute(Links.INVALID_ATTRIBUTE) !== null
  ) {
    return false;
  }

  var href =
    typeof anchor.getAttribute === "function"
      ? anchor.getAttribute("href")
      : null;
  if (!Media.mediaKindOfHref(href)) {
    return false;
  }

  var opened = deps.openFor(anchor, event);
  if (!opened) {
    return false;
  }
  event.preventDefault();
  return true;
}

/**
 * Listen on `doc` for the clicks of links to media assets.
 *
 * One delegated listener covers every body the reader renders — the
 * article, the hover preview and the search preview — wherever those are
 * inserted. `deps` defaults to the page's own viewer; the tests pass a
 * recording one instead.
 */
export function listenForMediaClicks(doc, deps) {
  if (!doc || typeof doc.addEventListener !== "function") {
    return;
  }

  var effects =
    deps && typeof deps.openFor === "function"
      ? deps
      : {
          openFor: function (element, event) {
            return viewerView.openFor(element, event);
          },
        };

  doc.addEventListener("click", function (event) {
    handleMediaLinkClick(event, effects);
  });
}
