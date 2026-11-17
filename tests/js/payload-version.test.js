/**
 * Tests for `src/web/js/payload-version.js`: the one version check every
 * reader entry point runs.
 *
 * The helper is the reader's refusal speech: it accepts the version this
 * reader speaks, and answers anything else — an older number, a newer one,
 * a surface that carries no version at all — with the sentence an
 * incompatible artifact deserves, naming the version it found and the fix.
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as versions from "../../src/web/js/payload-version.js";

test("the reader speaks payload format version 1", () => {
  assert.equal(versions.PAYLOAD_VERSION, 1);
});

test("the version this reader speaks is accepted", () => {
  assert.equal(
    versions.versionProblem(1, "The site payload"),
    null,
    "the current format is the one the reader opens",
  );
});

test("a version the reader does not speak is refused, naming it", () => {
  for (const value of [0, 2, "1"]) {
    const problem = versions.versionProblem(value, "The site payload");

    assert.ok(problem, `refuses ${JSON.stringify(value)}`);
    assert.match(problem, /payload format version/);
    assert.match(problem, /rebuild/, "the message says what to do about it");
    assert.ok(
      problem.includes(String(value)),
      `the message names the version it found: ${problem}`,
    );
  }
});

test("a surface that carries no version is refused", () => {
  for (const value of [undefined, null]) {
    const problem = versions.versionProblem(value, "The site payload");

    assert.ok(problem, `refuses ${String(value)}`);
    assert.match(problem, /no payload format version/);
    assert.match(problem, /rebuild/, "the message says what to do about it");
  }
});

test("the refusal names the surface it came from", () => {
  const problem = versions.versionProblem(2, "The document chunk");

  assert.ok(
    problem.startsWith("The document chunk"),
    `the message names the surface: ${problem}`,
  );
  assert.equal(
    versions.versionProblem(2),
    versions.versionProblem(2, ""),
    "an unnamed surface falls back to the plain subject",
  );
});
