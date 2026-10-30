/**
 * DOM layer for reader tables: sortable headers and an Excel-style filter.
 *
 * `table.js` owns the model (parsing, sorting, candidate values, matching);
 * this module only builds and moves nodes. Every table gets a funnel button in
 * each header cell; clicking it opens a panel with a value search box, a
 * tri-state "select all" row and one checkbox per distinct value.
 *
 * The panel is appended to `document.body` and positioned with
 * `position: fixed`, because `.doc-body table` sets `overflow: hidden` and would
 * clip any popover rendered inside a header cell. Only one panel exists at a
 * time: it closes on an outside click, on `Escape`, when its anchor scrolls out
 * of the document, and whenever a new document is rendered (`enhanceTables`
 * runs again and disposes the previous panel).
 */
import * as Table from "./table.js";

/** Class of the funnel button inside a header cell. */
export var FILTER_BUTTON_CLASS = "table-filter-toggle";

/** Class added to the funnel button of a column whose filter is active. */
export var FILTER_ACTIVE_CLASS = "is-filtered";

/** Class of the portal panel. */
export var FILTER_PANEL_CLASS = "table-filter-panel";

/** Class of the panel's value search input. */
export var FILTER_SEARCH_CLASS = "table-filter-search";

/** Class of the "select all" row. */
export var FILTER_ALL_CLASS = "table-filter-all";

/** Class of one candidate row. */
export var FILTER_OPTION_CLASS = "table-filter-option";

/** Class of the panel's footer action. */
export var FILTER_CLEAR_CLASS = "table-filter-clear";

/** Class of the hint shown when the candidate cap is reached. */
export var FILTER_MORE_CLASS = "table-filter-more";

/** Label of the empty-value candidate. */
export var BLANKS_LABEL = "(Blanks)";

/** Placeholder of the panel's search box. */
export var SEARCH_PLACEHOLDER = "Search values";

/** Hint appended when a column has more candidates than the cap. */
export var MORE_VALUES_TEXT = "more values, type to narrow";

/**
 * Candidates rendered at most.
 *
 * The whole candidate list still drives matching and "select all"; the cap only
 * bounds the DOM, so a column with thousands of distinct values cannot stall
 * the panel. Typing narrows the list and brings the rest into reach.
 */
export var MAX_RENDERED_VALUES = 200;

/** The panel currently in the document, or `null`. */
var activePanel = null;

/** Header text, falling back to the column number for labels. */
function headerLabel(cell, index) {
  var text = cell && typeof cell.textContent === "string" ? cell.textContent.trim() : "";
  return text || "column " + (index + 1);
}

/** Inline funnel icon: no external asset, no icon font, inherits `currentColor`. */
function createFunnelIcon() {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");

  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", "M2 3h12l-4.4 5v4.4L6.4 11V8z");
  svg.appendChild(path);

  return svg;
}

/** Create the placeholder row shown when every row is filtered out. */
function createEmptyRow(columns) {
  var row = document.createElement("tr");
  var cell = document.createElement("td");

  row.className = Table.EMPTY_ROW_CLASS;
  row.setAttribute("hidden", "");

  cell.colSpan = columns > 0 ? columns : 1;
  cell.textContent = Table.NO_MATCH_TEXT;

  row.appendChild(cell);
  return row;
}

/** Keep the panel inside the viewport, below the button or above it. */
function positionPanel(panel, anchor) {
  var rect = anchor.getBoundingClientRect();
  var width = panel.offsetWidth || 240;
  var height = panel.offsetHeight || 0;
  var margin = 8;
  var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  var viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  // Align with the button's left edge like Excel does, then pull the panel back
  // inside the viewport when the column sits near an edge.
  var left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, viewportWidth - width - margin),
  );
  var top = rect.bottom + 6;

  if (height && top + height > viewportHeight - margin) {
    var above = rect.top - height - 6;
    top = above >= margin ? above : Math.max(margin, viewportHeight - height - margin);
  }

  panel.style.left = Math.round(left) + "px";
  panel.style.top = Math.round(top) + "px";
}

/** Close the open panel, if any. Safe to call at any time. */
function closeActivePanel() {
  if (activePanel) {
    activePanel.close();
  }
}

/**
 * Open the filter panel for one column.
 *
 * `options` carries the anchor button, the column label, the candidate values
 * (`table.distinctValues`), the current selection (`null` or an array of keys)
 * and the `onChange` callback. The returned handle is also what
 * `closeActivePanel` operates on.
 */
function openFilterPanel(options) {
  var values = options.values || [];
  var selected = new Set(
    options.selected
      ? options.selected
      : values.map(function (value) {
          return value.key;
        }),
  );

  var panel = document.createElement("div");
  panel.className = FILTER_PANEL_CLASS;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Filter column " + options.label);

  var search = document.createElement("input");
  search.type = "search";
  search.className = FILTER_SEARCH_CLASS;
  search.placeholder = SEARCH_PLACEHOLDER;
  search.setAttribute("aria-label", "Search values in column " + options.label);
  search.autocomplete = "off";
  search.spellcheck = false;

  var allRow = document.createElement("label");
  allRow.className = FILTER_ALL_CLASS;
  var allInput = document.createElement("input");
  allInput.type = "checkbox";
  var allText = document.createElement("span");
  allText.className = "table-filter-value";
  allText.textContent = "Select all";
  var allCount = document.createElement("span");
  allCount.className = "table-filter-count";
  allRow.appendChild(allInput);
  allRow.appendChild(allText);
  allRow.appendChild(allCount);

  var list = document.createElement("div");
  list.className = "table-filter-list";

  var footer = document.createElement("div");
  footer.className = "table-filter-footer";
  var clear = document.createElement("button");
  clear.type = "button";
  clear.className = FILTER_CLEAR_CLASS;
  clear.textContent = "Clear filter";
  footer.appendChild(clear);

  panel.appendChild(search);
  panel.appendChild(allRow);
  panel.appendChild(list);
  panel.appendChild(footer);

  var visible = [];
  var api = { anchor: options.anchor, close: close };

  /** Push the selection back to the table, normalised against every candidate. */
  function commit() {
    options.onChange(Table.normalizeSelection(selected, values));
  }

  /** Refresh the tri-state "select all" box from the visible candidates. */
  function refreshAll() {
    var shown = visible.slice(0, MAX_RENDERED_VALUES);
    var picked = shown.filter(function (value) {
      return selected.has(value.key);
    }).length;

    allInput.checked = shown.length > 0 && picked === shown.length;
    allInput.indeterminate = picked > 0 && picked < shown.length;
    allCount.textContent = String(visible.length);
  }

  /** Rebuild the candidate list for the current search text. */
  function renderList() {
    var query = search.value.trim().toLowerCase();

    visible = values.filter(function (value) {
      return !query || value.text.toLowerCase().indexOf(query) !== -1;
    });

    list.textContent = "";

    var fragment = document.createDocumentFragment();

    visible.slice(0, MAX_RENDERED_VALUES).forEach(function (value) {
      var option = document.createElement("label");
      option.className = FILTER_OPTION_CLASS;

      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(value.key);

      var text = document.createElement("span");
      text.className = "table-filter-value";
      if (value.kind === "empty") {
        text.classList.add("is-blank");
        text.textContent = BLANKS_LABEL;
      } else {
        text.textContent = value.text;
      }

      var count = document.createElement("span");
      count.className = "table-filter-count";
      count.textContent = String(value.count);

      input.addEventListener("change", function () {
        if (input.checked) {
          selected.add(value.key);
        } else {
          selected.delete(value.key);
        }
        commit();
        refreshAll();
      });

      option.appendChild(input);
      option.appendChild(text);
      option.appendChild(count);
      fragment.appendChild(option);
    });

    if (visible.length > MAX_RENDERED_VALUES) {
      var more = document.createElement("p");
      more.className = FILTER_MORE_CLASS;
      more.textContent = visible.length - MAX_RENDERED_VALUES + " " + MORE_VALUES_TEXT;
      fragment.appendChild(more);
    }

    list.appendChild(fragment);
    refreshAll();
  }

  function onSearch() {
    renderList();
  }

  function onAllChange() {
    var keys = visible.map(function (value) {
      return value.key;
    });

    if (allInput.checked) {
      keys.forEach(function (key) {
        selected.add(key);
      });
    } else {
      keys.forEach(function (key) {
        selected.delete(key);
      });
    }

    commit();
    renderList();
  }

  function onClear() {
    selected = new Set(
      values.map(function (value) {
        return value.key;
      }),
    );
    options.onChange(null);
    api.close();
  }

  function onPanelKeydown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      api.close();
    }
  }

  function onDocumentPointer(event) {
    if (
      panel.contains(event.target) ||
      options.anchor === event.target ||
      options.anchor.contains(event.target)
    ) {
      return;
    }
    api.close();
  }

  function onViewportChange(event) {
    // Scrolling the candidate list must not reposition the panel.
    if (event && event.target && event.target.nodeType && panel.contains(event.target)) {
      return;
    }
    if (!options.anchor.isConnected) {
      api.close();
      return;
    }
    positionPanel(panel, options.anchor);
  }

  function close() {
    if (activePanel === api) {
      activePanel = null;
    }

    document.removeEventListener("mousedown", onDocumentPointer, true);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onViewportChange, true);

    panel.remove();
    options.anchor.setAttribute("aria-expanded", "false");

    if (options.anchor.isConnected) {
      // `preventScroll`: closing on a document switch must not scroll the page
      // to a header that is about to be replaced.
      options.anchor.focus({ preventScroll: true });
    }
  }

  search.addEventListener("input", onSearch);
  allInput.addEventListener("change", onAllChange);
  clear.addEventListener("click", onClear);
  panel.addEventListener("keydown", onPanelKeydown);

  document.body.appendChild(panel);
  renderList();
  positionPanel(panel, options.anchor);

  document.addEventListener("mousedown", onDocumentPointer, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  options.anchor.setAttribute("aria-expanded", "true");
  activePanel = api;

  search.focus();

  return api;
}

/**
 * Make one table sortable and filterable.
 *
 * Returns `false` when the element is not a table with a header and at least
 * one body row, or when it was enhanced before, which keeps the function
 * idempotent and leaves exotic tables (raw HTML without `<thead>`) untouched.
 */
export function enhanceTable(table) {
  if (!table || typeof table.hasAttribute !== "function" || table.hasAttribute(Table.TABLE_MARKER)) {
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
  var model = Table.buildTableModel(
    headers.map(function (cell) {
      return cell.textContent;
    }),
    rows.map(function (row) {
      return Array.prototype.slice.call(row.cells).map(function (cell) {
        return cell.textContent;
      });
    }),
  );

  var values = headers.map(function (cell, index) {
    return Table.distinctValues(model.rows, index);
  });
  var selections = headers.map(function () {
    return null;
  });
  var buttons = [];
  var sortState = { column: null, direction: "none" };
  var emptyRow = createEmptyRow(headers.length);

  function applyFilter() {
    var visible = new Set(
      Table.filterRows(model.rows, selections).map(function (row) {
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
    Table.sortRows(model.rows, sortState.column, sortState.direction).forEach(function (row) {
      body.appendChild(rows[row.index]);
    });

    // The placeholder is not part of the model, so it is re-appended to stay
    // the last row after every reorder.
    body.appendChild(emptyRow);

    headers.forEach(function (header, index) {
      var sorted = sortState.direction !== "none" && index === sortState.column;
      header.setAttribute(
        "aria-sort",
        sorted ? (sortState.direction === "asc" ? "ascending" : "descending") : "none",
      );
      if (sorted) {
        header.setAttribute("data-sort", sortState.direction);
      } else {
        header.removeAttribute("data-sort");
      }
    });
  }

  function sortBy(index) {
    sortState = Table.nextSortState(sortState, index);
    applySort();
  }

  function setSelection(index, selection) {
    selections[index] = selection;

    var button = buttons[index];
    if (button) {
      if (selection === null) {
        button.classList.remove(FILTER_ACTIVE_CLASS);
      } else {
        button.classList.add(FILTER_ACTIVE_CLASS);
      }
    }

    applyFilter();
  }

  function togglePanel(index, button) {
    if (activePanel && activePanel.anchor === button) {
      closeActivePanel();
      return;
    }

    closeActivePanel();

    openFilterPanel({
      anchor: button,
      label: headerLabel(headers[index], index),
      values: values[index],
      selected: selections[index],
      onChange: function (selection) {
        setSelection(index, selection);
      },
    });
  }

  function createFilterButton(header, index) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = FILTER_BUTTON_CLASS;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Filter column " + headerLabel(header, index));
    button.title = "Filter " + headerLabel(header, index);
    button.appendChild(createFunnelIcon());

    // The header sorts on click, so the button must not let its own events
    // bubble: opening a filter panel is not a sort request.
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      togglePanel(index, button);
    });

    button.addEventListener("keydown", function (event) {
      if (
        event.key === "Enter" ||
        event.key === " " ||
        event.key === "Spacebar" ||
        event.key === "ArrowDown"
      ) {
        event.preventDefault();
        event.stopPropagation();
        togglePanel(index, button);
      } else if (event.key === "Escape") {
        event.stopPropagation();
        closeActivePanel();
      }
    });

    return button;
  }

  table.setAttribute(Table.TABLE_MARKER, "");

  headers.forEach(function (header, index) {
    header.classList.add(Table.SORTABLE_CLASS);
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

    var button = createFilterButton(header, index);
    buttons[index] = button;
    header.appendChild(button);
  });

  body.appendChild(emptyRow);

  return true;
}

/**
 * Enhance every table under `root`, including tables inside block quotes and
 * footnote definitions, because the walk is a plain descendant query.
 *
 * Returns the number of tables that were enhanced by this call. A panel left
 * open by the previous document is closed first: its anchor is about to be
 * detached, and a panel parented to `body` would otherwise survive the swap.
 */
export function enhanceTables(root) {
  closeActivePanel();

  var scope = root && typeof root.querySelectorAll === "function" ? root : document;
  var count = 0;

  Array.prototype.forEach.call(scope.querySelectorAll("table"), function (table) {
    if (enhanceTable(table)) {
      count += 1;
    }
  });

  return count;
}
