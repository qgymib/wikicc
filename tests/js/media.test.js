/**
 * Tests for `src/web/js/media.js`: which hrefs the reader plays.
 *
 * The extension tables are the reader-side mirror of `media_kind` in
 * `src/assets.rs` — the build renders exactly the assets these tables name,
 * so the two must agree entry for entry. A `data:` URI needs no table: its
 * MIME type says what it inlines.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isMediaDataUri,
  mediaKindFromPath,
  mediaKindOfHref,
} from "../../src/web/js/media.js";

test("every pinned audio extension names sound", () => {
  for (const href of [
    "song.mp3",
    "voice.m4a",
    "talk.ogg",
    "talk.oga",
    "take.opus",
    "tone.wav",
    "album.flac",
    "book.aac",
  ]) {
    assert.equal(mediaKindFromPath(href), "audio", `href: ${href}`);
  }
});

test("every pinned video extension names film", () => {
  for (const href of [
    "film.mp4",
    "clip.m4v",
    "recording.webm",
    "takes.mov",
    "clip.ogv",
    "movie.mkv",
  ]) {
    assert.equal(mediaKindFromPath(href), "video", `href: ${href}`);
  }
});

test("the extension lookup is case-insensitive", () => {
  assert.equal(mediaKindFromPath("SONG.MP3"), "audio");
  assert.equal(mediaKindFromPath("Film.Mp4"), "video");
});

test("a path-shaped href keeps its last segment only", () => {
  assert.equal(mediaKindFromPath("assets/1f0cabcd12ef.mp3"), "audio");
  assert.equal(mediaKindFromPath("media/a/song.mp3"), "audio");
  assert.equal(mediaKindFromPath("song.mp3#t=10"), "audio");
  assert.equal(mediaKindFromPath("song.mp3?x=1"), "audio");
  assert.equal(mediaKindFromPath("assets/"), null);
});

test("an extension the tables do not list names nothing", () => {
  for (const href of [
    "photo.png",
    "notes.pdf",
    "logo.svg",
    "archive.zip",
    "readme",
    "song.",
    "a.b.c",
  ]) {
    assert.equal(mediaKindFromPath(href), null, `href: ${href}`);
  }
});

test("a name without an extension, or not a string, names nothing", () => {
  assert.equal(mediaKindFromPath("mp3"), null);
  assert.equal(mediaKindFromPath(null), null);
  assert.equal(mediaKindFromPath(undefined), null);
  assert.equal(mediaKindFromPath(42), null);
});

test("only a data uri whose mime is audio or video is media", () => {
  assert.equal(isMediaDataUri("data:audio/mpeg;base64,AAAA"), true);
  assert.equal(isMediaDataUri("data:video/mp4;base64,AAAA"), true);
  assert.equal(isMediaDataUri("DATA:VIDEO/WEBM;base64,AAAA"), true);

  for (const href of [
    "data:application/pdf;base64,AAAA",
    "data:text/plain,hello",
    "data:,hello",
    "data:;base64,aGVsbG8=",
    "#/doc/notes.md",
    "assets/1f0c.mp3",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isMediaDataUri(href), false, `href: ${String(href)}`);
  }
});

test("an href answers by its scheme: mime for data, extension for a path", () => {
  assert.equal(mediaKindOfHref("data:audio/mpeg;base64,AAAA"), "audio");
  assert.equal(mediaKindOfHref("data:video/webm;base64,AAAA"), "video");
  assert.equal(mediaKindOfHref("data:application/pdf;base64,AAAA"), null);
  assert.equal(mediaKindOfHref("assets/1f0c.mp3"), "audio");
  assert.equal(mediaKindOfHref("assets/1f0c.mp4"), "video");
  assert.equal(mediaKindOfHref("assets/1f0c.pdf"), null);
  assert.equal(mediaKindOfHref(null), null);
});
