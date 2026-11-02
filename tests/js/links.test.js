/**
 * Tests for `src/web/js/links.js`: recognising the reader's own links.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DOC_LINK_ATTRIBUTE,
  MISSING_ANCHOR_ATTRIBUTE,
  MISSING_CLASS,
  isBlockReference,
  isPlainLeftClick,
  missingAnchorOf,
  parseDocLink,
} from "../../src/web/js/links.js";

test("a document route yields its id and chapter", () => {
  assert.deepEqual(parseDocLink("#/doc/guide/intro.md#getting-started"), {
    id: "guide/intro.md",
    anchor: "getting-started",
  });
});

test("a route without a chapter has no anchor", () => {
  assert.deepEqual(parseDocLink("#/doc/guide/intro.md"), {
    id: "guide/intro.md",
    anchor: null,
  });
});

test("percent-encoded ids and chapters are decoded", () => {
  assert.deepEqual(
    parseDocLink("#/doc/%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md#%E7%AC%AC%E4%B8%80%E7%AB%A0"),
    { id: "中文/说明.md", anchor: "第一章" },
  );
  assert.deepEqual(parseDocLink("#/doc/my%20notes.md#A%20B"), {
    id: "my notes.md",
    anchor: "A B",
  });
});

test("anything that is not a document route is rejected", () => {
  for (const href of [
    "",
    "#",
    "#section",
    "https://example.com/doc/a.md",
    "mailto:docs@example.com",
    "missing.md",
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseDocLink(href), null, `href: ${String(href)}`);
  }
});

test("only links with a chapter are block references", () => {
  assert.equal(isBlockReference("#/doc/a.md#chapter"), true);
  assert.equal(isBlockReference("#/doc/a.md"), false);
  assert.equal(isBlockReference("#anchor"), false);
  assert.equal(isBlockReference("https://example.com"), false);
});

test("the doc-link attribute is a stable hook for the selector", () => {
  assert.equal(DOC_LINK_ATTRIBUTE, "data-wikicc-doc-link");
});

test("the missing-anchor attribute is the build's contract with the reader", () => {
  assert.equal(MISSING_ANCHOR_ATTRIBUTE, "data-wikicc-missing-anchor");
});

test("the missing class matches what the build writes", () => {
  assert.equal(MISSING_CLASS, "doc-link-missing");
});

test("a link the build marked missing reports the chapter the author wrote", () => {
  assert.equal(missingAnchorOf("1.4 配色与字体1"), "1.4 配色与字体1");
  assert.equal(missingAnchorOf("no-such-chapter"), "no-such-chapter");
  assert.equal(missingAnchorOf(" spaced "), " spaced ", "the authored spelling is kept");
});

test("a link without the mark is not missing", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(missingAnchorOf(value), null, `value: ${String(value)}`);
  }
});

test("a marked link still reads as a block reference only with a chapter", () => {
  // The build drops the anchor from the route, so `isBlockReference` stays
  // false: the reader must key the *navigation* off the route and the
  // *message* off the mark, not conflate the two.
  assert.equal(isBlockReference("#/doc/a.md"), false);
  assert.equal(missingAnchorOf("gone"), "gone");
});

test("only an unmodified left click is handled by the reader", () => {
  assert.equal(isPlainLeftClick({ button: 0 }), true);

  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
    assert.equal(
      isPlainLeftClick({ button: 0, [modifier]: true }),
      false,
      `${modifier} must stay with the browser`,
    );
  }

  assert.equal(isPlainLeftClick({ button: 1 }), false);
  assert.equal(isPlainLeftClick(null), false);
});
