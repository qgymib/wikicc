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
  isSameRoute,
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
    parseDocLink(
      "#/doc/%E4%B8%AD%E6%96%87/%E8%AF%B4%E6%98%8E.md#%E7%AC%AC%E4%B8%80%E7%AB%A0",
    ),
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
  assert.equal(
    missingAnchorOf(" spaced "),
    " spaced ",
    "the authored spelling is kept",
  );
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

test("a link that addresses the current route is recognised as the same route", () => {
  assert.equal(isSameRoute("#/doc/a.md", "#/doc/a.md"), true);
  assert.equal(isSameRoute("#/doc/a.md#chapter", "#/doc/a.md#chapter"), true);

  assert.equal(
    isSameRoute("#/doc/a.md#chapter", "#/doc/a.md"),
    false,
    "another chapter of the same document is a different route",
  );
  assert.equal(isSameRoute("#/doc/a.md", "#/doc/b.md"), false);
  assert.equal(isSameRoute("#/doc/a.md#x", "#/doc/b.md#x"), false);
});

test("the same route is recognised whatever the percent encoding", () => {
  // The build escapes non-ASCII anchors; an address bar, a hand-written href or
  // an older artifact may carry the decoded spelling instead.
  assert.equal(
    isSameRoute("#/doc/a.md#第一章", "#/doc/a.md#%E7%AC%AC%E4%B8%80%E7%AB%A0"),
    true,
  );
  assert.equal(
    isSameRoute(
      "#/doc/%E4%B8%AD%E6%96%87.md#34-%E6%8A%80%E6%9C%AF",
      "#/doc/中文.md#34-技术",
    ),
    true,
  );
});

test("an empty current address or a foreign href is never the same route", () => {
  for (const current of ["", "#", "#/doc/", null, undefined]) {
    assert.equal(
      isSameRoute(current, "#/doc/a.md"),
      false,
      `current: ${String(current)}`,
    );
  }
  for (const href of [
    "https://example.com",
    "#anchor",
    "a.md",
    null,
    undefined,
  ]) {
    assert.equal(
      isSameRoute("#/doc/a.md", href),
      false,
      `href: ${String(href)}`,
    );
  }
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
