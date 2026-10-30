import test from "node:test";
import assert from "node:assert/strict";

import * as table from "../../src/web/js/table.js";

/** `-1`/`0`/`1`, so comparisons never trip over `-0`. */
function sign(value) {
  if (value < 0) {
    return -1;
  }
  return value > 0 ? 1 : 0;
}

/** Model rows as their original indexes, which is what ordering assertions use. */
function order(rows) {
  return rows.map((row) => row.index);
}

function model(headers, rows) {
  return table.buildTableModel(headers, rows);
}

test("detects integers, decimals, thousands separators and percents", () => {
  assert.deepEqual(table.parseCell("42"), { kind: "number", value: 42 });
  assert.deepEqual(table.parseCell("-3.5"), { kind: "number", value: -3.5 });
  assert.deepEqual(table.parseCell("1,234"), { kind: "number", value: 1234 });
  assert.deepEqual(table.parseCell("12%"), { kind: "number", value: 12 });
  assert.deepEqual(table.parseCell("  7  "), { kind: "number", value: 7 });
});

test("detects ISO dates and rejects impossible ones", () => {
  assert.deepEqual(table.parseCell("2024-05-06"), {
    kind: "date",
    value: Date.UTC(2024, 4, 6),
  });
  assert.equal(table.parseCell("2024-13-01").kind, "text");
  assert.equal(table.parseCell("2024-02-31").kind, "text");
  assert.equal(table.parseCell("2024-5-6").kind, "text");
});

test("keeps text and empty cells apart from values", () => {
  assert.deepEqual(table.parseCell("N/A"), { kind: "text", value: "N/A" });
  assert.deepEqual(table.parseCell(""), { kind: "empty", value: null });
  assert.deepEqual(table.parseCell("   "), { kind: "empty", value: null });
  assert.deepEqual(table.parseCell(null), { kind: "empty", value: null });
  assert.deepEqual(table.parseCell(undefined), { kind: "empty", value: null });
});

test("does not mistake malformed numbers for values", () => {
  for (const text of ["1,23", "12px", "1.2.3", "--5", "1e5"]) {
    assert.equal(table.parseCell(text).kind, "text", `text: ${text}`);
  }
});

test("compares every pair of cells antisymmetrically", () => {
  const samples = [
    "10",
    "9",
    "1,234",
    "-3.5",
    "12%",
    "2024-05-06",
    "2023-12-31",
    "Apple",
    "apple",
    "item 2",
    "item 10",
    "",
    "   ",
    "N/A",
  ];

  for (const left of samples) {
    for (const right of samples) {
      const forward = sign(table.compareCells(table.parseCell(left), table.parseCell(right)));
      const backward = sign(table.compareCells(table.parseCell(right), table.parseCell(left)));

      assert.equal(forward, backward === 0 ? 0 : -backward, `${left} vs ${right}`);
    }
  }
});

test("sorts empty cells last in both directions", () => {
  const rows = model(["n"], [["5"], [""], ["2"]]).rows;

  assert.deepEqual(order(table.sortRows(rows, 0, "asc")), [2, 0, 1]);
  assert.deepEqual(order(table.sortRows(rows, 0, "desc")), [0, 2, 1]);
});

test("sorts numbers numerically instead of lexically", () => {
  const rows = model(["n"], [["10"], ["9"]]).rows;

  assert.deepEqual(order(table.sortRows(rows, 0, "asc")), [1, 0]);
  assert.deepEqual(order(table.sortRows(rows, 0, "desc")), [0, 1]);
});

test("sorts ISO dates chronologically", () => {
  const rows = model(["d"], [["2024-05-06"], ["2023-12-31"], [""]]).rows;

  assert.deepEqual(order(table.sortRows(rows, 0, "asc")), [1, 0, 2]);
});

test("compares text case-insensitively and number-aware", () => {
  const rows = model(["t"], [["item 10"], ["Item 2"], ["apple"]]).rows;

  assert.deepEqual(order(table.sortRows(rows, 0, "asc")), [2, 1, 0]);
});

test("keeps ties in their original order in both directions", () => {
  const rows = model(["n"], [["2"], ["1"], ["2"]]).rows;

  assert.deepEqual(order(table.sortRows(rows, 0, "asc")), [1, 0, 2]);
  assert.deepEqual(order(table.sortRows(rows, 0, "desc")), [0, 2, 1]);
});

test("clearing the sort restores the original row order without mutating input", () => {
  const rows = model(["n"], [["3"], ["1"], ["2"]]).rows;

  table.sortRows(rows, 0, "desc");
  assert.deepEqual(order(rows), [0, 1, 2], "the input array keeps its order");
  assert.deepEqual(order(table.sortRows(rows, 0, "none")), [0, 1, 2]);
  assert.deepEqual(order(table.sortRows(rows, 0, undefined)), [0, 1, 2]);
});

test("filters case-insensitively on a substring", () => {
  const rows = model(
    ["name", "kind"],
    [
      ["alpha", "abc"],
      ["beta", "xyz"],
      ["Gamma", "abc"],
    ],
  ).rows;

  assert.deepEqual(order(table.filterRows(rows, ["", "abc"])), [0, 2]);
  assert.deepEqual(order(table.filterRows(rows, ["GAM"])), [2]);
  assert.deepEqual(order(table.filterRows(rows, ["A", "abc"])), [0, 2]);
});

test("combines column filters with AND and ignores blank ones", () => {
  const rows = model(
    ["name", "kind"],
    [
      ["alpha", "abc"],
      ["beta", "xyz"],
      ["Gamma", "abc"],
    ],
  ).rows;

  assert.deepEqual(order(table.filterRows(rows, ["a", "xyz"])), [1]);
  assert.deepEqual(order(table.filterRows(rows, ["", ""])), [0, 1, 2]);
  assert.deepEqual(order(table.filterRows(rows, [])), [0, 1, 2]);
  assert.deepEqual(order(table.filterRows(rows, ["a", "abc", ""])), [0, 2]);
});

test("returns nothing when every row is filtered out", () => {
  const rows = model(["name"], [["alpha"], ["beta"]]).rows;

  assert.deepEqual(table.filterRows(rows, ["zzz"]), []);
});

test("keeps the sorted order while filtering", () => {
  const rows = model(
    ["n", "kind"],
    [
      ["10", "x"],
      ["9", "y"],
      ["2", "x"],
    ],
  ).rows;
  const sorted = table.sortRows(rows, 0, "asc");

  assert.deepEqual(order(sorted), [2, 1, 0]);
  assert.deepEqual(order(table.filterRows(sorted, ["", "x"])), [2, 0]);
});

test("builds a typed model that preserves the header text", () => {
  const built = model(
    ["Name", ""],
    [
      ["a", "1"],
      ["b", ""],
    ],
  );

  assert.deepEqual(built.headers, [{ text: "Name" }, { text: "" }]);
  assert.equal(built.rows.length, 2);
  assert.equal(built.rows[1].index, 1);
  assert.deepEqual(built.rows[0].cells[1], { text: "1", kind: "number", value: 1 });
  assert.deepEqual(built.rows[1].cells[1], { text: "", kind: "empty", value: null });
});

test("cycles a header click through ascending, descending and off", () => {
  let state = { column: null, direction: "none" };

  state = table.nextSortState(state, 1);
  assert.deepEqual(state, { column: 1, direction: "asc" });

  state = table.nextSortState(state, 1);
  assert.deepEqual(state, { column: 1, direction: "desc" });

  state = table.nextSortState(state, 1);
  assert.deepEqual(state, { column: null, direction: "none" });

  state = table.nextSortState({ column: 0, direction: "asc" }, 1);
  assert.deepEqual(state, { column: 1, direction: "asc" });
});

test("exposes the enhancement hook the integration test looks for", () => {
  assert.equal(table.TABLE_MARKER, "data-wikicc-table");
  assert.equal(table.NO_MATCH_TEXT, "No matching rows");
});
