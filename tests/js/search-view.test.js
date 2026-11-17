/**
 * Tests for the search panel's composer (`src/web/js/search-view.js`): the
 * seams where the dialog's frame and its document preview meet.
 *
 * The frame's own rules live in `search-panel.test.js` and the preview's in
 * `search-preview.test.js`; what stays here is what crosses between them —
 * the panel that starts hidden with each half naming itself, the selection
 * the preview follows, the link in a previewed document that navigates and
 * closes, the two halves an empty answer empties together, and a shell
 * without a panel that stays inert rather than fatal.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_CLASS,
  LOCKED_CLASS,
  PANEL_LABEL,
  PREVIEW_IDLE_LABEL,
  RESULT_CLASS,
  RESULTS_IDLE_LABEL,
  SEARCH_LOCKED_CLASS,
  createSearchView,
} from "../../src/web/js/search-view.js";
import { textOf } from "./helpers/dom.js";
import {
  build,
  documentModel,
  entry,
  previewOf,
  type,
  withPage,
} from "./helpers/search-fixture.js";

test("the panel starts hidden, each half naming itself", () => {
  withPage(function (page) {
    var built = build({ container: page.container });

    assert.equal(built.view.isOpen(), false);
    assert.equal(page.container.hidden, true);
    assert.equal(page.container.getAttribute("role"), "dialog");
    assert.equal(page.container.getAttribute("aria-label"), PANEL_LABEL);

    var empties = page.container.findAll(EMPTY_CLASS);
    assert.equal(empties.length, 2, "neither half is left blank");
    assert.equal(empties[0].textContent, RESULTS_IDLE_LABEL);
    assert.equal(previewOf(page).children[0].textContent, PREVIEW_IDLE_LABEL);
  });
});

test("a link in the previewed document navigates and closes the panel", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          '<p>see <a href="#/doc/b.md#details">details</a></p>',
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var link = page.container.findAllByTag("a")[0];
    assert.ok(link, "the document contributes its links");
    assert.equal(link.getAttribute("href"), "#/doc/b.md#details");

    var prevented = false;
    previewOf(page).fire("click", {
      target: link,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });

    assert.equal(prevented, true);
    assert.deepEqual(built.calls.selections, [
      { id: "b.md", anchor: "details" },
    ]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("an external link in the preview is left to the browser", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          '<p><a href="https://example.com">out</a></p>',
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var link = page.container.findAllByTag("a")[0];
    previewOf(page).fire("click", { target: link, preventDefault() {} });

    assert.deepEqual(
      built.calls.selections,
      [],
      "the panel is not a router for the web",
    );
    assert.equal(built.view.isOpen(), true);
  });
});

test("moving the selection moves the preview with it", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    // The preview is the last child of the panel, past the list it follows.
    var preview = previewOf(page);
    var input = built.view.input();
    assert.equal(preview.children[0].children[1].textContent, "alpha");

    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(preview.children[0].children[1].textContent, "beta");

    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[0].getAttribute("aria-selected"), "false");
    assert.equal(rows[1].getAttribute("aria-selected"), "true");

    input.fire("keydown", { key: "ArrowUp" });
    assert.equal(preview.children[0].children[1].textContent, "alpha");
  });
});

test("the pointer crossing a result leaves the selection alone", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    page.container.findAll(RESULT_CLASS)[1].fire("pointermove", {});

    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[0].getAttribute("aria-selected"), "true");
    assert.equal(rows[1].getAttribute("aria-selected"), "false");
    assert.equal(
      previewOf(page).children[0].children[1].textContent,
      "alpha",
      "the preview still describes the row the reader chose",
    );
  });
});

test("a query that matches nothing empties both halves, each naming itself", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [];
      },
    });
    built.view.open();
    type(built.view, page, "zzz");

    var empties = page.container.findAll(EMPTY_CLASS);
    assert.equal(page.container.findAll(RESULT_CLASS).length, 0);
    assert.equal(
      empties.length,
      2,
      "the list and the preview both have nothing",
    );
    assert.deepEqual(
      empties.map(textOf),
      [RESULTS_IDLE_LABEL, PREVIEW_IDLE_LABEL],
      "a half with nothing says which half it is, not what went wrong",
    );
  });
});

test("a document matched on its title alone has no passage to preview", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", null)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    assert.equal(
      page.container.findAll("search-result-context")[0].textContent,
      "",
      "there is no passage to quote, so the leading column stays empty",
    );
    assert.equal(
      page.container.findAll("search-result-path")[0].textContent,
      "a.md",
      "the path names the document in the trailing column",
    );
    assert.equal(
      page.container.findAll(EMPTY_CLASS)[0].textContent,
      PREVIEW_IDLE_LABEL,
    );
    assert.equal(page.container.findAll("mark").length, 0);
  });
});

test("an unlocked title-only match still leaves its passage cell empty", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", null)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    assert.equal(
      page.container.findAll(LOCKED_CLASS).length,
      0,
      "a public document's rows carry no lock marker",
    );
    assert.equal(page.container.findAll(SEARCH_LOCKED_CLASS).length, 0);
    assert.equal(
      page.container.findAll(EMPTY_CLASS)[0].textContent,
      PREVIEW_IDLE_LABEL,
      "the preview idles as it always did",
    );
  });
});

test("a shell without a panel is inert rather than fatal", () => {
  var view = createSearchView({ container: null });

  view.open();
  assert.equal(view.isOpen(), false);
  assert.equal(view.query(), "");
  view.setResults([entry("a.md", "Alpha", "alpha")], 0);
  view.close();
  view.dispose();
});
