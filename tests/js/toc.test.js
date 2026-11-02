import test from "node:test";
import assert from "node:assert/strict";

import * as toc from "../../src/web/js/toc.js";

/**
 * Absolute tops of a document whose headings are far apart, which is where the
 * old viewport-intersection spy used to lose track of the current section.
 */
const OFFSETS = [0, 1200, 1500, 4000, 4200];

test("reports no section for an empty outline", () => {
  assert.equal(toc.pickActive([], 500, false), -1);
  assert.equal(toc.pickActive(null, 500, false), -1);
  assert.equal(toc.pickActive(undefined, 0, true), -1);
});

test("keeps the first section while the reading line is above it", () => {
  // The introduction: a heading may start below the line on a short document,
  // and the outline must still point at something.
  assert.equal(toc.pickActive(OFFSETS, 0, false), 0);
  assert.equal(toc.pickActive([400], 0, false), 0);
});

test("selects the heading the reading line sits exactly on", () => {
  assert.equal(toc.pickActive(OFFSETS, 1200, false), 1);
  assert.equal(toc.pickActive(OFFSETS, 4000, false), 3);
});

test("stays inside the section when no heading is anywhere near the screen", () => {
  // A long table between two headings: the line is 1000px past the heading at
  // 1500 and 1500px above the one at 4000. The answer must follow the heading
  // that was passed, not fall back to the top entry.
  assert.equal(toc.pickActive(OFFSETS, 2500, false), 2);
  assert.equal(toc.pickActive(OFFSETS, 3999, false), 2);
  assert.equal(toc.pickActive(OFFSETS, 1600, false), 2);
});

test("picks the closest preceding heading for every position", () => {
  for (let line = 0; line <= 5000; line += 25) {
    const index = toc.pickActive(OFFSETS, line, false);
    assert.ok(OFFSETS[index] <= line, `line ${line} must not point below itself`);
    if (index + 1 < OFFSETS.length) {
      assert.ok(OFFSETS[index + 1] > line, `line ${line} must not skip a section`);
    }
  }
});

test("never moves backwards while the reading line advances", () => {
  let previous = -1;
  for (let line = 0; line <= 5000; line += 7) {
    const index = toc.pickActive(OFFSETS, line, false);
    assert.ok(index >= previous, `line ${line} went back from ${previous} to ${index}`);
    previous = index;
  }
});

test("chooses the closing section once the document is scrolled to its end", () => {
  // The last heading is 800px above the line, so only the bottom rule can
  // reach it: this is what used to appear stuck one entry above the end.
  assert.equal(toc.pickActive(OFFSETS, 5000, true), OFFSETS.length - 1);
  assert.equal(toc.pickActive([10, 20], -100, true), 1);
});

test("a single heading is current everywhere", () => {
  for (const line of [-1000, 0, 42, 1e6]) {
    assert.equal(toc.pickActive([42], line, false), 0);
  }
});

test("the reading line sits high in the viewport but not at its edge", () => {
  assert.ok(toc.READING_LINE_RATIO > 0);
  assert.ok(toc.READING_LINE_RATIO < 0.5);
});

test("the lock outlives a single frame but cannot freeze the outline", () => {
  assert.ok(toc.LOCK_IDLE_MS > 16, "a lock must survive more than one frame");
  assert.ok(toc.LOCK_MAX_MS >= toc.LOCK_IDLE_MS);
});
