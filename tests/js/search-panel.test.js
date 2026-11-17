/**
 * Tests for the search dialog's frame (`src/web/js/search-panel.js`): the
 * field and its buttons, the result rows, the keys that move through the
 * list, and the open/close choreography.
 *
 * The rules under test are about *when* things happen: typing debounces into
 * one question per pause, the selection moves only when the reader asks, and
 * the panel goes away on Escape or on a press outside it. The document the
 * preview draws is `search-preview.test.js`'s subject; here the preview is
 * only ever the half that answers the row the reader picked.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLEAR_LABEL,
  EMPTY_CLASS,
  GLOBAL_MODE,
  LOCAL_MODE,
  LOCKED_CLASS,
  LOCKED_LABEL,
  LOCKED_TITLE,
  MODE_CLASS,
  MODE_GLOBAL_LABEL,
  MODE_LOCAL_LABEL,
  OPEN_ATTRIBUTE,
  RESULT_CLASS,
  RESULTS_IDLE_LABEL,
  isSearchShortcut,
} from "../../src/web/js/search-view.js";
import { textOf } from "./helpers/dom.js";
import {
  build,
  entry,
  fakeElement,
  lockedEntry,
  previewOf,
  type,
  withPage,
} from "./helpers/search-fixture.js";

test("opening shows the panel and focuses the field", () => {
  withPage(function (page) {
    var built = build({ container: page.container });

    built.view.open();

    assert.equal(built.view.isOpen(), true);
    assert.equal(page.container.hidden, false);
    assert.equal(page.container.getAttribute(OPEN_ATTRIBUTE), "true");
    assert.equal(built.view.input().focused, true);
    assert.equal(built.view.input().selected, true);
  });
});

test("closing empties the query and hides the panel", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });

    built.view.open();
    type(built.view, page, "alpha");
    assert.equal(built.view.query(), "alpha");

    built.view.close();

    assert.equal(built.view.isOpen(), false);
    assert.equal(built.view.query(), "");
    assert.equal(page.container.hidden, true);
    assert.equal(page.container.hasAttribute(OPEN_ATTRIBUTE), false);
    assert.equal(page.container.findAll(RESULT_CLASS).length, 0);
  });
});

test("typing asks one question per pause, not one per keystroke", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer(query) {
        return [entry("a.md", "Alpha", query)];
      },
    });
    built.view.open();

    var input = built.view.input();
    input.value = "a";
    input.fire("input", { target: input });
    input.value = "al";
    input.fire("input", { target: input });
    input.value = "alp";
    input.fire("input", { target: input });

    assert.equal(
      built.calls.queries.length,
      0,
      "nothing is asked while the hand is still moving",
    );

    page.settle();

    assert.deepEqual(built.calls.queries, ["alp"]);
  });
});

test("every match is a row of the context it was found in and the file holding it", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "alp");

    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].getAttribute("role"), "option");
    assert.equal(rows[0].getAttribute("aria-selected"), "true");
    assert.equal(rows[1].getAttribute("aria-selected"), "false");

    // The passage leads the row and the file closes it, which is the order
    // the two columns are drawn in.
    var cells = rows[0].children;
    assert.equal(cells.length, 2);
    assert.equal(cells[0].className, "search-result-context");
    assert.equal(cells[1].className, "search-result-path");

    assert.equal(textOf(cells[0]), "\u2026or alpha and more\u2026");
    assert.equal(
      cells[1].textContent,
      "a.md",
      "the trailing column names the file, and nothing else",
    );
    assert.equal(
      cells[1].children.length,
      0,
      "the file cell holds its text and no title above it",
    );
    assert.equal(
      cells[1].getAttribute("title"),
      "a.md",
      "the whole path is offered on hover, for a cell too narrow to show it",
    );

    assert.equal(
      page.container
        .findAll("search-result-context")[1]
        .parentNode.getAttribute("aria-selected"),
      "false",
    );
  });
});

test("the context of a match never arrives as markup", () => {
  withPage(function (page) {
    // The file's path is plain data, and the passage is the document's own
    // text; both are printed as written, so a document containing markup
    // cannot become markup on this page.
    var path = "<img src=x onerror=alert(1)>";
    var hit = "<b>bold</b>";
    var built = build({
      container: page.container,
      answer() {
        return [entry(path, "Alpha", hit)];
      },
    });
    built.view.open();
    type(built.view, page, "bold");

    assert.equal(
      page.container.findAll("search-result-path")[0].textContent,
      path,
    );

    var marks = page.container.findAllByTag("mark");
    assert.ok(
      marks.length > 0,
      "the hit is marked in the list and in the preview: " + marks.length,
    );
    assert.ok(
      marks.every(function (node) {
        return node.children.length === 0;
      }),
      "the text is set as text, not parsed",
    );
    assert.equal(
      page.container.findAll("search-result-context")[0].children[1]
        .textContent,
      hit,
    );
  });
});

test("the scope button starts local, and every query names the scope it was asked in", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var mode = page.container.findAll(MODE_CLASS)[0];
    assert.ok(mode, "the field carries a scope button");
    assert.equal(
      mode.textContent,
      MODE_LOCAL_LABEL,
      "the default reads the document in view",
    );
    assert.equal(mode.getAttribute("aria-pressed"), "false");
    assert.deepEqual(built.calls.modes, [LOCAL_MODE]);
    assert.equal(built.view.mode(), LOCAL_MODE);
  });
});

test("pressing the scope button re-asks at once, in the scope just chosen", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    // A keystroke is still pending when the reader presses the button: the
    // switch must not leave that older query to be answered in the old scope.
    var input = built.view.input();
    input.value = "alph";
    input.fire("input", { target: input });
    assert.equal(page.pending(), 1, "a debounce is scheduled");

    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });

    assert.deepEqual(
      built.calls.modes,
      [LOCAL_MODE, GLOBAL_MODE],
      "the press re-asks in the new scope",
    );
    assert.deepEqual(
      built.calls.queries,
      ["alpha", "alph"],
      "the field's own words are asked",
    );
    assert.equal(
      page.pending(),
      0,
      "the old scope's debounce is cancelled, not kept",
    );
    assert.equal(built.view.mode(), GLOBAL_MODE);

    var mode = page.container.findAll(MODE_CLASS)[0];
    assert.equal(mode.textContent, MODE_GLOBAL_LABEL);
    assert.equal(mode.getAttribute("aria-pressed"), "true");
  });
});

test("pressing the scope button again returns to the local scope", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var mode = page.container.findAll(MODE_CLASS)[0];
    mode.fire("click", { preventDefault() {} });
    mode.fire("click", { preventDefault() {} });

    // The first entry is the typed query's own, asked in the scope it started in.
    assert.deepEqual(built.calls.modes, [LOCAL_MODE, GLOBAL_MODE, LOCAL_MODE]);
    assert.equal(mode.textContent, MODE_LOCAL_LABEL);
    assert.equal(mode.getAttribute("aria-pressed"), "false");
    assert.equal(built.view.mode(), LOCAL_MODE);
  });
});

// Regression: a press on the scope button left the focus on the button, so
// the arrow keys — bound to the field — no longer moved the selection and the
// browser scrolled the page behind the fixed dialog instead. The field hands
// the reader back after the press, the way the clear button already does.
test("pressing the scope button hands the focus back to the field, so the arrows still answer", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    // The browser hands the focus to the button on the press, taking it from
    // the field; the fake page does not move the focus by itself, so the
    // gesture is modelled here — exactly the state the panel is asked to mend.
    var input = built.view.input();
    input.focused = false;

    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });

    assert.ok(input.focused, "the field holds the focus again after the press");

    input.fire("keydown", { key: "ArrowDown" });
    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(
      rows[1].getAttribute("aria-selected"),
      "true",
      "the arrows still move the selection in the scope just chosen",
    );
  });
});

test("an empty field makes the switch a change of mind, not a question", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });

    assert.deepEqual(
      built.calls.queries,
      [],
      "nothing is asked of an empty field",
    );
    assert.equal(built.view.mode(), GLOBAL_MODE);
  });
});

test("a query typed after the switch is asked in the scope in force", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });
    type(built.view, page, "alpha");

    assert.deepEqual(built.calls.modes, [GLOBAL_MODE]);
  });
});

test("the scope survives closing and reopening the panel", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();
    page.container
      .findAll(MODE_CLASS)[0]
      .fire("click", { preventDefault() {} });
    built.view.close();
    built.view.open();

    assert.equal(
      built.view.mode(),
      GLOBAL_MODE,
      "the reader was probably not done looking",
    );
    assert.equal(
      page.container.findAll(MODE_CLASS)[0].textContent,
      MODE_GLOBAL_LABEL,
    );
  });
});

test("the arrow keys stay inside the list", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    var input = built.view.input();
    input.fire("keydown", { key: "ArrowUp" });
    assert.equal(
      page.container.findAll(RESULT_CLASS)[0].getAttribute("aria-selected"),
      "true",
    );

    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[1].getAttribute("aria-selected"), "true");
    assert.equal(rows[0].getAttribute("aria-selected"), "false");
  });
});

test("arrow navigation brings each chosen row into sight", () => {
  var revealed = [];

  withPage(function (page) {
    // Every element the page creates learns to report the reveal the view
    // asks for, so the assertions can read which row was handed to the
    // browser and with what alignment. The preview reveals its own marks
    // with `center`, so the row asks are told apart by `nearest`.
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        revealed.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      answer() {
        return [
          entry("a.md", "Alpha", "alpha"),
          entry("b.md", "Beta", "beta"),
          entry("c.md", "Gamma", "gamma"),
          entry("d.md", "Delta", "delta"),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    revealed.length = 0;
    var rows = page.container.findAll(RESULT_CLASS);
    var input = built.view.input();

    /** The reveals that asked for a row of the list, not a mark of a document. */
    var rowReveals = function () {
      return revealed.filter(function (call) {
        return call.options && call.options.block === "nearest";
      });
    };

    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(rowReveals().length, 1, "the row the arrow chose is revealed");
    assert.equal(rowReveals()[0].element, rows[1]);
    assert.deepEqual(rowReveals()[0].options, { block: "nearest" });

    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(rowReveals().length, 3, "every step reveals its row");
    assert.equal(rowReveals()[2].element, rows[3]);

    input.fire("keydown", { key: "ArrowUp" });
    assert.equal(rowReveals().length, 4, "the upward step reveals too");
    assert.equal(rowReveals()[3].element, rows[2]);
    assert.deepEqual(rowReveals()[3].options, { block: "nearest" });
  });
});

test("Home and End bring the first and the last row into sight", () => {
  var revealed = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        revealed.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      answer() {
        return [
          entry("a.md", "Alpha", "alpha"),
          entry("b.md", "Beta", "beta"),
          entry("c.md", "Gamma", "gamma"),
          entry("d.md", "Delta", "delta"),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    revealed.length = 0;
    var rows = page.container.findAll(RESULT_CLASS);
    var input = built.view.input();

    input.fire("keydown", { key: "End" });
    assert.equal(revealed.length, 1);
    assert.equal(revealed[0].element, rows[3]);
    assert.deepEqual(revealed[0].options, { block: "nearest" });

    input.fire("keydown", { key: "Home" });
    assert.equal(revealed.length, 2);
    assert.equal(revealed[1].element, rows[0]);
  });
});

test("a fresh answer brings its own first row into sight", () => {
  var revealed = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        revealed.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      answer(query) {
        return query === "a"
          ? [entry("a.md", "Alpha", "alpha")]
          : [entry("b.md", "Beta", "beta"), entry("c.md", "Gamma", "gamma")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    // The list of the first answer opens at its head, so a reader who typed
    // with the list scrolled away still lands on the top of the new one.
    var first = page.container.findAll(RESULT_CLASS)[0];
    assert.equal(revealed.length, 1);
    assert.equal(revealed[0].element, first);
    assert.deepEqual(revealed[0].options, { block: "nearest" });

    type(built.view, page, "b");
    var second = page.container.findAll(RESULT_CLASS)[0];
    assert.equal(revealed.length, 2, "the replaced list is revealed again");
    assert.equal(
      revealed[1].element,
      second,
      "the new list's head, not the old",
    );
  });
});

test("staying on the selected row asks for no reveal", () => {
  var revealed = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        revealed.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    assert.equal(revealed.length, 1, "the only row was revealed once");

    var input = built.view.input();
    input.fire("keydown", { key: "ArrowUp" });
    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(
      revealed.length,
      1,
      "clamped steps change nothing, so they scroll nothing",
    );
  });
});

test("Enter opens the selected document and closes the panel", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    var input = built.view.input();
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "Enter" });

    // Moving to the second entry is what picks it: `Enter` settles only a
    // query that has not been asked yet, and this one has been. The rows
    // carry no occurrence, so there is no passage to open at.
    assert.deepEqual(built.calls.selections, [
      { id: "b.md", anchor: null, jump: null },
    ]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("Enter asks for what was typed even when the pause has not come yet", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer(query) {
        return [entry("a.md", "Alpha", query, 0)];
      },
    });
    built.view.open();

    var input = built.view.input();
    input.value = "alp";
    input.fire("input", { target: input });
    input.fire("keydown", { key: "Enter" });

    assert.deepEqual(
      built.calls.queries,
      ["alp"],
      "a query still pending is asked now",
    );
    // The jump names the settled answer, not the older list: the passage
    // that opens is the one the just-landed row described.
    assert.deepEqual(built.calls.selections, [
      { id: "a.md", anchor: null, jump: { query: "alp", hit: 0 } },
    ]);
  });
});

test("clicking a result selects it and keeps the panel open", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });

    var rows = page.container.findAll(RESULT_CLASS);
    assert.equal(rows[0].getAttribute("aria-selected"), "false");
    assert.equal(rows[1].getAttribute("aria-selected"), "true");
    assert.equal(previewOf(page).children[0].children[1].textContent, "beta");
    assert.deepEqual(
      built.calls.selections,
      [],
      "choosing which row to read is not yet choosing to leave",
    );
    assert.equal(built.view.isOpen(), true);
  });
});

test("double-clicking a result opens it", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    // The browser's own double click is two clicks and then a `dblclick`;
    // the clicks only select, so the last event alone does the leaving.
    var row = page.container.findAll(RESULT_CLASS)[1];
    row.fire("click", { preventDefault() {} });
    row.fire("click", { preventDefault() {} });
    row.fire("dblclick", { preventDefault() {} });

    assert.deepEqual(built.calls.selections, [
      { id: "b.md", anchor: null, jump: null },
    ]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("Enter opens the passage the selected row names", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [
          entry("a.md", "Alpha", "alpha one", 0),
          entry("a.md", "Alpha", "alpha two", 1),
          entry("a.md", "Alpha", "alpha three", 2),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var input = built.view.input();
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "ArrowDown" });
    input.fire("keydown", { key: "Enter" });

    assert.deepEqual(
      built.calls.selections,
      [{ id: "a.md", anchor: null, jump: { query: "alpha", hit: 2 } }],
      "the row the arrows chose is the passage the jump names",
    );
    assert.equal(built.view.isOpen(), false);
  });
});

test("double-clicking a result opens the passage it names too", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [
          entry("a.md", "Alpha", "alpha", 0),
          entry("b.md", "Beta", "beta", 1),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    var row = page.container.findAll(RESULT_CLASS)[1];
    row.fire("click", { preventDefault() {} });
    row.fire("click", { preventDefault() {} });
    row.fire("dblclick", { preventDefault() {} });

    assert.deepEqual(built.calls.selections, [
      { id: "b.md", anchor: null, jump: { query: "a", hit: 1 } },
    ]);
    assert.equal(built.view.isOpen(), false);
  });
});

test("a match with no place in the body opens without a passage to land on", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", null, -1)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    built.view.input().fire("keydown", { key: "Enter" });

    assert.deepEqual(
      built.calls.selections,
      [{ id: "a.md", anchor: null, jump: null }],
      "a title-only match has no occurrence for the article to open at",
    );
    assert.equal(built.view.isOpen(), false);
  });
});

test("a press inside the panel leaves it open", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    page.press(built.view.input());

    assert.equal(built.view.isOpen(), true);
  });
});

test("a press anywhere else closes the panel", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    page.press({ tagName: "ARTICLE" });

    assert.equal(built.view.isOpen(), false);
  });
});

test("a press on the toggle is left to the button that opens the panel", () => {
  withPage(function (page) {
    var button = fakeElement("button");
    var built = build({ container: page.container, toggle: button });
    built.view.open();

    page.press(button);

    assert.equal(built.view.isOpen(), true);
  });
});

test("a press outside the panel closes it even when a toggle is given", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      toggle: fakeElement("button"),
    });
    built.view.open();

    page.press({ tagName: "ARTICLE" });

    assert.equal(built.view.isOpen(), false);
  });
});

test("the toggle describes the panel however it closes", () => {
  withPage(function (page) {
    var button = fakeElement("button");
    var built = build({ container: page.container, toggle: button });

    built.view.open();
    assert.equal(button.getAttribute("aria-expanded"), "true");

    built.view.close();
    assert.equal(button.getAttribute("aria-expanded"), "false");
  });
});

test("opening a result says the panel closed on the toggle", () => {
  withPage(function (page) {
    var button = fakeElement("button");
    var built = build({
      container: page.container,
      toggle: button,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    built.view.input().fire("keydown", { key: "Enter" });

    assert.equal(built.view.isOpen(), false);
    assert.equal(button.getAttribute("aria-expanded"), "false");
  });
});

test("Escape closes the panel", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    var prevented = false;
    built.view.input().fire("keydown", {
      key: "Escape",
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(built.view.isOpen(), false);
    assert.equal(
      prevented,
      true,
      "the key must not also close the preview behind it",
    );
    assert.equal(page.container.hidden, true);
  });
});

test("a sealed document's row names the lock where the passage would read", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [lockedEntry("a.md", "Alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var markers = page.container.findAll(LOCKED_CLASS);
    assert.equal(markers.length, 1, "the row carries one lock marker");
    assert.equal(markers[0].textContent, LOCKED_LABEL);
    assert.equal(
      markers[0].getAttribute("title"),
      LOCKED_TITLE,
      "hover says what the lock means",
    );
    assert.equal(
      page.container.findAll("search-result-context")[0].children[0],
      markers[0],
      "the marker sits in the cell the passage would fill",
    );
    assert.equal(
      page.container.findAllByTag("mark").length,
      0,
      "a sealed body holds nothing to highlight",
    );
  });
});

test("an empty query empties the panel again", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");
    assert.equal(page.container.findAll(RESULT_CLASS).length, 1);

    type(built.view, page, "   ");

    assert.equal(page.container.findAll(RESULT_CLASS).length, 0);
    assert.equal(
      page.container.findAll(EMPTY_CLASS)[0].textContent,
      RESULTS_IDLE_LABEL,
    );
    assert.deepEqual(
      built.calls.queries,
      ["alpha"],
      "a blank query is not asked about",
    );
  });
});

test("the clear button empties the field and the list", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var clear = page.container.findAll("search-clear")[0];
    assert.equal(clear.getAttribute("aria-label"), CLEAR_LABEL);
    assert.equal(clear.hidden, false);

    clear.fire("click", { preventDefault() {} });

    assert.equal(built.view.query(), "");
    assert.equal(clear.hidden, true);
    assert.equal(page.container.findAll(RESULT_CLASS).length, 0);
  });
});

test("reopening a panel with a query asks about it again", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer(query) {
        return [entry("a.md", "Alpha", query)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    built.view.close();
    built.view.open();

    assert.deepEqual(built.calls.queries, ["alpha"]);
    assert.equal(built.view.input().focused, true);
    assert.equal(
      page.container.findAll(RESULT_CLASS).length,
      0,
      "a closed panel forgets its list",
    );
  });
});

test("disposing takes the panel and its page listener away", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    assert.equal(page.documentListenerCount(), 1);

    built.view.dispose();

    assert.equal(page.documentListenerCount(), 0);
    assert.equal(page.container.children.length, 0);
    assert.equal(built.view.isOpen(), false);
  });
});

test("the shortcut is Ctrl+F or Cmd+F, and nothing else", () => {
  assert.equal(isSearchShortcut({ key: "f", ctrlKey: true }), true);
  assert.equal(isSearchShortcut({ key: "F", ctrlKey: true }), true);
  assert.equal(isSearchShortcut({ key: "f", metaKey: true }), true);
  assert.equal(isSearchShortcut({ key: "f" }), false);
  assert.equal(
    isSearchShortcut({ key: "f", ctrlKey: true, altKey: true }),
    false,
  );
  assert.equal(isSearchShortcut({ key: "g", ctrlKey: true }), false);
  assert.equal(isSearchShortcut(null), false);
});

test("loading names the wait where the rows will appear", () => {
  withPage(function (page) {
    var built = build({ container: page.container });
    built.view.open();

    built.view.setLoading();

    var results = page.container.children[1];
    assert.match(textOf(results), /Loading/);
    assert.equal(
      page.container.findAll(RESULT_CLASS).length,
      0,
      "no row pretends there is an answer yet",
    );

    built.view.setResults([entry("a.md", "Alpha", "alpha")], 0);
    assert.doesNotMatch(
      textOf(page.container.children[1]),
      /Loading/,
      "the answer replaces the wait",
    );
  });
});
