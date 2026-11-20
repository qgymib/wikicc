/**
 * Media policy: which assets the build renders as playable elements, and
 * which hrefs the reader answers with a player.
 *
 * The build decides by extension (`media_kind` in `src/assets.rs`): an image
 * or an embed whose destination names a sound or a film renders as a native
 * `<audio>`/`<video>` element wrapped in a `.doc-media` span, so the markup
 * plays with or without the reader. This module mirrors that decision for
 * the reader side, where a link's `href` is all there is: a link to a media
 * asset is the one the reader takes over, opening the player in the viewer
 * instead of handing the bytes to a new tab.
 *
 * Two addressing schemes reach the reader. The `pages` format writes a
 * relative `assets/<hash>.<ext>` URL, whose extension decides; the
 * `single-html` format inlines the bytes as a `data:` URI, whose MIME type
 * decides. One lookup answers for both.
 *
 * The extension tables are a pinned mirror of `media_kind` in
 * `src/assets.rs`: the build renders exactly what the reader takes over, and
 * a file one side knows and the other does not would render as media but
 * behave as a link, or the reverse. An extension added to the Rust table
 * must be added here in the same change.
 *
 * Pure: no DOM and no `document`, so `node --test` covers the tables without
 * a page. `media-view.js` owns the page.
 */

/** Class of the wrapper span the build puts a native media element in. */
export var MEDIA_WRAPPER_CLASS = "doc-media";

/** Attribute carrying the kind the build rendered: `audio` or `video`. */
export var MEDIA_KIND_ATTRIBUTE = "data-wikicc-media";

/** Selector of the media wrappers inside a rendered document. */
export var WRAPPER_SELECTOR = "." + MEDIA_WRAPPER_CLASS;

/** Extensions the build renders as sound, pinned against `src/assets.rs`. */
var AUDIO_EXTENSIONS = {
  mp3: true,
  m4a: true,
  ogg: true,
  oga: true,
  opus: true,
  wav: true,
  flac: true,
  aac: true,
};

/** Extensions the build renders as film, pinned against `src/assets.rs`. */
var VIDEO_EXTENSIONS = {
  mp4: true,
  m4v: true,
  webm: true,
  mov: true,
  ogv: true,
  mkv: true,
};

/** A `data:` URI whose MIME type names a sound or a film. */
var MEDIA_DATA_URI = /^data:(audio|video)\//i;

/** Whether `href` inlines a sound or a film. */
export function isMediaDataUri(href) {
  return typeof href === "string" && MEDIA_DATA_URI.test(href);
}

/**
 * The media kind a path-shaped `href` names, or `null`.
 *
 * The last path segment's extension decides, after the fragment and the
 * query are dropped, and the lookup is case-insensitive. A name without an
 * extension — and any extension the pinned tables do not list — names
 * nothing the reader plays.
 */
export function mediaKindFromPath(href) {
  if (typeof href !== "string") {
    return null;
  }

  var path = href.split("#", 1)[0].split("?", 1)[0];
  var name = path.slice(path.lastIndexOf("/") + 1);
  var dot = name.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }

  var extension = name.slice(dot + 1).toLowerCase();
  if (AUDIO_EXTENSIONS[extension]) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS[extension]) {
    return "video";
  }
  return null;
}

/**
 * The media kind an `href` names, by whatever the two schemes say.
 *
 * A `data:` URI answers through its MIME type (`audio/*` or `video/*`); a
 * path answers through its extension. `null` for everything else — an
 * `href` the reader does not play stays the browser's.
 */
export function mediaKindOfHref(href) {
  if (typeof href !== "string") {
    return null;
  }
  if (/^data:/i.test(href)) {
    var match = MEDIA_DATA_URI.exec(href);
    return match ? match[1].toLowerCase() : null;
  }
  return mediaKindFromPath(href);
}
