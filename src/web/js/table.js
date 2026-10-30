/**
 * Table model, sorting and filtering for the reader.
 *
 * The build emits plain GFM tables (`<table><thead>…<tbody>…`), so everything
 * here runs in the browser: no build-time cost, no payload change and no
 * dependency. This module is deliberately DOM-free — `table-view.js` owns the
 * header buttons, the filter panel and the row toggling — so the whole model is
 * covered by `node --test`, which runs without a document.
 *
 * Semantics worth knowing:
 *
 * - Cells are typed once, when the table is enhanced, and the parsed model is
 *   reused for every sort and filter, so a click never re-parses the table.
 * - A column may mix kinds; `number` sorts before `date`, which sorts before
 *   `text`, and empty cells always sort last, in both directions.
 * - `12%` compares as the written magnitude (12), not as 0.12: a column that
 *   mixes percentages with fractions is pathological input, and ordering the
 *   percentages among themselves is what readers expect.
 * - Sorting is stable in both directions: equal values keep their original
 *   order, because the original row index is the tie-breaker.
 * - Filtering is Excel-style: one set of exact cell values per column, `OR`
 *   inside a column and `AND` across columns. A column without a set, or with
 *   every candidate selected, does not constrain anything.
 * - Filtering never reorders rows, it only toggles the `hidden` attribute, so
 *   clearing a filter restores whatever order is currently displayed.
 */

/** Attribute marking a table as already enhanced (also the integration hook). */
export var TABLE_MARKER = "data-wikicc-table";

/** Class added to clickable header cells. */
export var SORTABLE_CLASS = "table-sortable";

/** Class of the placeholder row shown when nothing matches. */
export var EMPTY_ROW_CLASS = "table-empty-row";

/** Text of the placeholder row. */
export var NO_MATCH_TEXT = "No matching rows";

/** Kind order for columns that mix value types. */
var KIND_RANK = { number: 0, date: 1, text: 2, empty: 3 };

/** Cell used when a row is shorter than the column being sorted. */
var EMPTY_CELL = { kind: "empty", value: null };

/** Integers and decimals, with optional thousands separators and percent. */
var NUMBER_PATTERN = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;

/** Strict ISO calendar date. */
var DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Return `-1`, `0` or `1`, so callers never see `-0` or fractional noise. */
function sign(value) {
  if (value < 0) {
    return -1;
  }
  return value > 0 ? 1 : 0;
}

/**
 * Parse an ISO `YYYY-MM-DD` date into UTC milliseconds.
 *
 * `Date.UTC` alone silently rolls impossible dates over (`2024-02-31` becomes
 * March 2nd), so the value is only accepted when it round-trips. UTC keeps the
 * comparison independent of the reader's time zone.
 */
function parseIsoDate(text) {
  var match = DATE_PATTERN.exec(text);
  if (!match) {
    return null;
  }

  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var stamp = Date.UTC(year, month - 1, day);
  var date = new Date(stamp);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return stamp;
}

/**
 * Classify one cell.
 *
 * Returns `{ kind, value }` where `kind` is `"number"`, `"date"`, `"text"` or
 * `"empty"`; `value` is a number for numbers and dates, the trimmed text for
 * text and `null` for empty cells.
 */
export function parseCell(text) {
  var value = text === null || text === undefined ? "" : String(text).trim();

  if (!value) {
    return { kind: "empty", value: null };
  }

  if (NUMBER_PATTERN.test(value)) {
    var number = Number(value.replace(/%$/, "").replace(/,/g, ""));
    if (Number.isFinite(number)) {
      return { kind: "number", value: number };
    }
  }

  var date = parseIsoDate(value);
  if (date !== null) {
    return { kind: "date", value: date };
  }

  return { kind: "text", value: value };
}

/** Coerce anything that is not a parsed cell into the empty cell. */
function asCell(cell) {
  return cell && typeof cell.kind === "string" && KIND_RANK[cell.kind] !== undefined
    ? cell
    : EMPTY_CELL;
}

/** The parsed cell at `column`, or the empty cell when the row is short. */
function cellAt(row, column) {
  var cells = row && row.cells;
  return cells && column >= 0 && column < cells.length ? asCell(cells[column]) : EMPTY_CELL;
}

/** Original position of a model row, used as the stable tie-breaker. */
function rowIndex(row) {
  return row && typeof row.index === "number" ? row.index : 0;
}

/**
 * Compare two parsed cells.
 *
 * Empty cells always sort last, so the comparator is a total order with
 * `number < date < text < empty`. The result is normalised to `-1`/`0`/`1`, so
 * `sign(compareCells(a, b)) === -sign(compareCells(b, a))` holds for every
 * pair.
 */
export function compareCells(a, b) {
  var left = asCell(a);
  var right = asCell(b);

  if (left.kind !== right.kind) {
    if (left.kind === "empty") {
      return 1;
    }
    if (right.kind === "empty") {
      return -1;
    }
    return KIND_RANK[left.kind] < KIND_RANK[right.kind] ? -1 : 1;
  }

  if (left.kind === "empty") {
    return 0;
  }

  if (left.kind === "text") {
    return sign(String(left.value).localeCompare(String(right.value), undefined, {
      numeric: true,
      sensitivity: "base",
    }));
  }

  return sign(left.value - right.value);
}

/** Sort direction as a multiplier; `0` means "no sorting". */
function directionSign(direction) {
  if (direction === "asc") {
    return 1;
  }
  return direction === "desc" ? -1 : 0;
}

/**
 * Sort model rows by one column.
 *
 * Returns a new array and leaves the input untouched. `direction` is `"asc"`,
 * `"desc"` or anything else for "no sorting", which restores the original row
 * order. Empty cells stay last in both directions, and ties keep their original
 * order in both directions.
 */
export function sortRows(rows, column, direction) {
  var list = (rows || []).slice();
  var order = directionSign(direction);

  return list.sort(function (left, right) {
    if (order !== 0) {
      var a = cellAt(left, column);
      var b = cellAt(right, column);
      var result = compareCells(a, b);

      // Empties sort last regardless of the direction, so the direction only
      // flips comparisons where both sides carry a value.
      if (a.kind !== "empty" && b.kind !== "empty") {
        result *= order;
      }

      if (result !== 0) {
        return result;
      }
    }

    return rowIndex(left) - rowIndex(right);
  });
}

/**
 * Identity of a cell inside its column.
 *
 * The displayed text, trimmed, is what the filter panel lists; an empty cell is
 * the empty string, which is also the `(Blanks)` candidate. Cells that differ
 * only in surrounding whitespace are one candidate, and a selection matches by
 * exact string, not by substring.
 */
export function cellKey(cell) {
  var value = asCell(cell);

  if (value.kind === "empty") {
    return "";
  }

  return String(value.text === undefined ? value.value : value.text).trim();
}

/**
 * Candidate values of one column, in the order the filter panel lists them.
 *
 * Every distinct key appears once with its occurrence count. The list is
 * ordered by the sorting comparator (`number` < `date` < `text`, empty last), so
 * the panel reads like a sorted column; cells that parse to the same value but
 * are written differently (`1,234` and `1234`) stay separate entries because
 * the panel shows what is on screen, and the text tie-breaker keeps their order
 * deterministic.
 */
export function distinctValues(rows, column) {
  var byKey = new Map();

  (rows || []).forEach(function (row) {
    var cell = cellAt(row, column);
    var key = cellKey(cell);
    var entry = byKey.get(key);

    if (entry) {
      entry.count += 1;
      return;
    }

    byKey.set(key, {
      text: key,
      key: key,
      kind: cell.kind,
      value: cell.value,
      count: 1,
    });
  });

  return Array.from(byKey.values()).sort(function (left, right) {
    var result = compareCells(
      { kind: left.kind, value: left.value },
      { kind: right.kind, value: right.value },
    );

    if (result !== 0) {
      return result;
    }

    return sign(
      String(left.text).localeCompare(String(right.text), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  });
}

/**
 * Collapse a selection that covers every candidate to `null`.
 *
 * `null` means "this column does not constrain anything", which is what the
 * filter button's idle state and the header's active marker both key off. An
 * empty selection is *not* collapsed: unchecking every value is a real filter
 * that hides the whole column, exactly like Excel.
 */
export function normalizeSelection(selectedKeys, allKeys) {
  var selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  var all = allKeys || [];

  if (!all.length) {
    return selected.size ? Array.from(selected) : null;
  }

  if (selected.size !== all.length) {
    return Array.from(selected);
  }

  for (var index = 0; index < all.length; index += 1) {
    var key = all[index] && all[index].key !== undefined ? all[index].key : all[index];
    if (!selected.has(key)) {
      return Array.from(selected);
    }
  }

  return null;
}

/**
 * Keep the rows that survive every column selection.
 *
 * `selections` holds one entry per column: `null`/`undefined` (no constraint)
 * or an array of exact keys (see `cellKey`) that are allowed through. Values
 * inside a column are combined with `OR`, columns with `AND`. Each selection is
 * turned into a `Set` once, so a click costs one lookup per cell instead of a
 * scan of the selection.
 */
export function filterRows(rows, selections) {
  var allowed = (selections || []).map(function (selection) {
    if (selection === null || selection === undefined) {
      return null;
    }
    return selection instanceof Set ? selection : new Set(selection);
  });
  var list = (rows || []).slice();

  if (!allowed.some(Boolean)) {
    return list;
  }

  return list.filter(function (row) {
    return allowed.every(function (keys, column) {
      if (!keys) {
        return true;
      }
      return keys.has(cellKey(cellAt(row, column)));
    });
  });
}

/**
 * Build the parsed model of a table from its text matrix.
 *
 * `headers` and `rows` are plain strings, which keeps the model builder free of
 * the DOM and testable under `node --test`; `table-view.js` is the adapter that
 * reads them out of the `<table>` element.
 */
export function buildTableModel(headers, rows) {
  var headerList = (headers || []).map(function (header) {
    return { text: header === null || header === undefined ? "" : String(header) };
  });

  var body = (rows || []).map(function (cells, index) {
    return {
      index: index,
      cells: (cells || []).map(function (text) {
        var value = text === null || text === undefined ? "" : String(text);
        var parsed = parseCell(value);
        return { text: value, kind: parsed.kind, value: parsed.value };
      }),
    };
  });

  return { headers: headerList, rows: body };
}

/**
 * Next state of the three-way sort cycle for a header click.
 *
 * Another column starts a fresh ascending sort, the same column toggles to
 * descending, and a second click on a descending column clears the sort.
 */
export function nextSortState(current, column) {
  var state = current || {};

  if (state.column !== column || !state.direction || state.direction === "none") {
    return { column: column, direction: "asc" };
  }

  if (state.direction === "asc") {
    return { column: column, direction: "desc" };
  }

  return { column: null, direction: "none" };
}
