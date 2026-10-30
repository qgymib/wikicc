/**
 * Table sorting and filtering for the reader.
 *
 * The build emits plain GFM tables (`<table><thead>…<tbody>…`), so everything
 * here runs in the browser: no build-time cost, no payload change and no
 * dependency. The module follows the same split as `doc-list.js` — the pure
 * core (`parseCell`, `compareCells`, `sortRows`, `filterRows`,
 * `buildTableModel`, `nextSortState`) never touches the DOM and is covered by
 * `node --test`, while `enhanceTable`/`enhanceTables` only build and reorder
 * nodes.
 *
 * Semantics worth knowing:
 *
 * - Cells are typed once, when the table is enhanced, and the parsed model is
 *   reused for every sort and filter, so a keystroke never re-parses the table.
 * - A column may mix kinds; `number` sorts before `date`, which sorts before
 *   `text`, and empty cells always sort last, in both directions.
 * - `12%` compares as the written magnitude (12), not as 0.12: a column that
 *   mixes percentages with fractions is pathological input, and ordering the
 *   percentages among themselves is what readers expect.
 * - Sorting is stable in both directions: equal values keep their original
 *   order, because the original row index is the tie-breaker.
 * - Filtering never reorders rows, it only toggles the `hidden` attribute, so
 *   clearing a filter restores whatever order is currently displayed.
 */

/** Attribute marking a table as already enhanced (also the integration hook). */
export var TABLE_MARKER = "data-wikicc-table";

/** Class added to clickable header cells. */
export var SORTABLE_CLASS = "table-sortable";

/** Class of the injected filter row inside `<thead>`. */
export var FILTER_ROW_CLASS = "table-filter-row";

/** Class of the filter inputs. */
export var FILTER_INPUT_CLASS = "table-filter";

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
 * Keep the rows that match every column filter.
 *
 * `filters` holds one query per column index; `null`, `undefined` and blank
 * queries do not constrain their column. Matching is a case-insensitive
 * substring test on the displayed cell text, so a numeric query such as `12`
 * matches `1,234` the way a reader would expect from what is on screen.
 */
export function filterRows(rows, filters) {
  var queries = (filters || []).map(function (filter) {
    return filter === null || filter === undefined ? "" : String(filter).trim().toLowerCase();
  });
  var list = (rows || []).slice();

  if (!queries.some(Boolean)) {
    return list;
  }

  return list.filter(function (row) {
    return queries.every(function (query, column) {
      if (!query) {
        return true;
      }
      var cell = cellAt(row, column);
      return cell.text === undefined
        ? String(cell.value === null ? "" : cell.value).toLowerCase().indexOf(query) !== -1
        : String(cell.text).toLowerCase().indexOf(query) !== -1;
    });
  });
}

/**
 * Build the parsed model of a table from its text matrix.
 *
 * `headers` and `rows` are plain strings, which keeps the model builder free of
 * the DOM and testable under `node --test`; `enhanceTable` is the adapter that
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

/** Header text of a cell, falling back to the column number for the label. */
function headerLabel(cell, index) {
  var text = cell && typeof cell.textContent === "string" ? cell.textContent.trim() : "";
  return text || "column " + (index + 1);
}

/** Create the filter row that is injected into `<thead>`. */
function createFilterRow(headerCells, onChange) {
  var row = document.createElement("tr");
  row.className = FILTER_ROW_CLASS;

  headerCells.forEach(function (header, index) {
    var cell = document.createElement("th");
    var input = document.createElement("input");

    input.type = "search";
    input.className = FILTER_INPUT_CLASS;
    input.placeholder = "Filter";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Filter column " + headerLabel(header, index));
    input.addEventListener("input", onChange);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && input.value) {
        input.value = "";
        onChange();
      }
    });

    cell.appendChild(input);
    row.appendChild(cell);
  });

  return row;
}

/** Create the placeholder row shown when every row is filtered out. */
function createEmptyRow(columns) {
  var row = document.createElement("tr");
  var cell = document.createElement("td");

  row.className = EMPTY_ROW_CLASS;
  row.setAttribute("hidden", "");

  cell.colSpan = columns > 0 ? columns : 1;
  cell.textContent = NO_MATCH_TEXT;

  row.appendChild(cell);
  return row;
}

/**
 * Make one table sortable and filterable.
 *
 * Returns `false` when the element is not a table with a header and at least
 * one body row, or when it was enhanced before, which keeps the function
 * idempotent and leaves exotic tables (raw HTML without `<thead>`) untouched.
 */
export function enhanceTable(table) {
  if (!table || typeof table.hasAttribute !== "function" || table.hasAttribute(TABLE_MARKER)) {
    return false;
  }

  var head = table.tHead;
  var body = table.tBodies && table.tBodies.length ? table.tBodies[0] : null;
  var headerRow = head && head.rows && head.rows.length ? head.rows[0] : null;

  if (!headerRow || !headerRow.cells.length || !body || !body.rows.length) {
    return false;
  }

  var headers = Array.prototype.slice.call(headerRow.cells);
  var rows = Array.prototype.slice.call(body.rows);
  var model = buildTableModel(
    headers.map(function (cell) {
      return cell.textContent;
    }),
    rows.map(function (row) {
      return Array.prototype.slice.call(row.cells).map(function (cell) {
        return cell.textContent;
      });
    }),
  );

  var state = { column: null, direction: "none" };
  var emptyRow = createEmptyRow(headers.length);

  function applyFilter() {
    var visible = new Set(
      filterRows(
        model.rows,
        filterRow.cells
          ? Array.prototype.map.call(filterRow.cells, function (cell) {
              var input = cell.querySelector("input");
              return input ? input.value : "";
            })
          : [],
      ).map(function (row) {
        return row.index;
      }),
    );

    model.rows.forEach(function (row) {
      var element = rows[row.index];
      if (visible.has(row.index)) {
        element.removeAttribute("hidden");
      } else {
        element.setAttribute("hidden", "");
      }
    });

    if (visible.size === 0) {
      emptyRow.removeAttribute("hidden");
    } else {
      emptyRow.setAttribute("hidden", "");
    }
  }

  function applySort() {
    sortRows(model.rows, state.column, state.direction).forEach(function (row) {
      body.appendChild(rows[row.index]);
    });

    // The placeholder is not part of the model, so it is re-appended to stay
    // the last row after every reorder.
    body.appendChild(emptyRow);

    headers.forEach(function (header, index) {
      var sorted = state.direction !== "none" && index === state.column;
      header.setAttribute(
        "aria-sort",
        sorted ? (state.direction === "asc" ? "ascending" : "descending") : "none",
      );
      if (sorted) {
        header.setAttribute("data-sort", state.direction);
      } else {
        header.removeAttribute("data-sort");
      }
    });
  }

  function sortBy(index) {
    state = nextSortState(state, index);
    applySort();
  }

  var filterRow = createFilterRow(headers, applyFilter);

  table.setAttribute(TABLE_MARKER, "");

  headers.forEach(function (header, index) {
    header.classList.add(SORTABLE_CLASS);
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-sort", "none");
    header.addEventListener("click", function () {
      sortBy(index);
    });
    header.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        sortBy(index);
      }
    });
  });

  head.appendChild(filterRow);
  body.appendChild(emptyRow);

  return true;
}

/**
 * Enhance every table under `root`, including tables inside block quotes and
 * footnote definitions, because the walk is a plain descendant query.
 *
 * Returns the number of tables that were enhanced by this call.
 */
export function enhanceTables(root) {
  var scope = root && typeof root.querySelectorAll === "function" ? root : document;
  var count = 0;

  Array.prototype.forEach.call(scope.querySelectorAll("table"), function (table) {
    if (enhanceTable(table)) {
      count += 1;
    }
  });

  return count;
}
