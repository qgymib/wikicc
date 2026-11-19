/**
 * Tests for `src/web/js/i18n.js`: the reader's copy dictionaries and the
 * lookup every module answers through.
 *
 * The contract the tests pin: English entries are verbatim the copy the
 * reader shipped with (a site that names no language must render exactly
 * what it always did), an unknown language code falls back to English, the
 * lookup falls back through the current dictionary to the English one, and
 * placeholders fill from the params while an unfilled name stays visible.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LANGUAGE,
  DICTIONARIES,
  currentLanguage,
  setLanguage,
  t,
} from "../../src/web/js/i18n.js";

test("the default language is English", () => {
  assert.equal(DEFAULT_LANGUAGE, "en");
  assert.equal(currentLanguage(), "en");
});

test("the bundle carries the two dictionaries with the same keys", () => {
  assert.deepEqual(Object.keys(DICTIONARIES).sort(), ["en", "zh"]);

  const enKeys = Object.keys(DICTIONARIES.en).sort();
  assert.equal(enKeys.length > 0, true, "the English table is not empty");
  assert.deepEqual(
    Object.keys(DICTIONARIES.zh).sort(),
    enKeys,
    "the zh table mirrors the en table entry for entry",
  );
});

test("english copy stays verbatim at a few pinned slots", () => {
  assert.equal(t("shell.skipLink"), "Skip to content");
  assert.equal(t("shell.tocHeading"), "Outline");
  assert.equal(t("lock.submit"), "Unlock");
  assert.equal(t("copy.code"), "Copy code");
  assert.equal(t("stats.documents.other"), "{n} documents");
});

test("setting zh switches the copy", () => {
  setLanguage("zh");
  assert.equal(currentLanguage(), "zh");
  assert.equal(t("shell.skipLink"), "跳到正文");
  assert.equal(t("shell.tocHeading"), "大纲");
  assert.equal(t("lock.submit"), "解锁");

  setLanguage(DEFAULT_LANGUAGE);
  assert.equal(
    t("lock.submit"),
    "Unlock",
    "setting the default restores English",
  );
});

test("an unknown language code keeps the English copy", () => {
  for (const code of ["fr", "", null, undefined, 42]) {
    setLanguage(code);
    assert.equal(currentLanguage(), "en", `code ${String(code)} falls back`);
    assert.equal(t("lock.submit"), "Unlock");
  }
});

test("a key the current dictionary misses falls back to English", () => {
  setLanguage("zh");
  DICTIONARIES.zh["i18n.test.probe"] = undefined;
  delete DICTIONARIES.zh["i18n.test.probe"];

  // The probe key exists only in English, so the zh lookup rides the
  // fallback and the English text comes back.
  DICTIONARIES.en["i18n.test.probe"] = "Probe text";
  assert.equal(t("i18n.test.probe"), "Probe text");
  delete DICTIONARIES.en["i18n.test.probe"];

  setLanguage(DEFAULT_LANGUAGE);
});

test("a key no dictionary carries answers the key itself", () => {
  assert.equal(t("i18n.test.missing"), "i18n.test.missing");
});

test("placeholders fill from the params", () => {
  assert.equal(
    t("docRender.loading", { id: "guide/intro.md" }),
    "Loading guide/intro.md …",
  );
  assert.equal(t("stats.documents.other", { n: 3 }), "3 documents");
  assert.equal(t("stats.documents.one", { n: 1 }), "1 document");
});

test("a placeholder without a param stays visible", () => {
  assert.equal(t("stats.documents.other"), "{n} documents");
  assert.equal(
    t("docRender.loading", { other: "x" }),
    "Loading {id} …",
    "a name the params do not carry is left as written",
  );
});

test("params stringify non-string values", () => {
  assert.equal(t("stats.documents.other", { n: 12 }), "12 documents");
});

test("setLanguage answers the language now in effect", () => {
  assert.equal(setLanguage("zh"), "zh");
  assert.equal(setLanguage("nope"), "en");
  setLanguage(DEFAULT_LANGUAGE);
});
