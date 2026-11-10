/**
 * Tests for `src/web/js/table-view.js`: the measured column-width pin.
 *
 * A table's columns are measured under the auto layout at the last
 * layout-affecting moment — the table landing on screen, a window resize, a
 * first filter on a table that was enhanced offscreen — and pinned into a
 * colgroup of pixel widths plus a `table-layout: fixed` marker, so that
 * hiding rows for a filter can never renegotiate the columns.
 *
 * Driven with a minimal fake DOM that follows the browser's semantics where
 * the pin reads them: `offsetWidth` is a number a layout would have flushed
 * (zero while a table is offscreen), writing `textContent` replaces the
 * children, appending a fragment inserts its children, `rows`/`cells` are
 * live collections of the section elements only, and `isConnected` walks the
 * parent chain to the document. Measurement itself is fake layout — a test
 * hands the stub the widths a browser would report and asserts on what the
 * pin wrote, which is the contract under test.
 *
 * What the fake cannot model — the real redistribution a browser performs
 * when rows leave the layout — is confirmed headlessly against a built site;
 * here the dance is observed directly: a header's `offsetWidth` getter
 * snapshots the hidden states it sees at the moment the pin reads it.
 *
 * The reader arms its shared resize listener on `globalThis`, which in a
 * browser is the page itself. Node's global carries no listener registry, so
 * `withDocument` installs one backed by a store that outlives a single test —
 * the module's wiring flag is once-per-process, exactly like the registry it
 * mirrors — and `firePage` delivers a resize to it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  FILTER_BUTTON_CLASS,
  FILTER_CONFIRM_CLASS,
  LOCK_ATTRIBUTE,
  enhanceTable,
  relayoutLockedTables,
} from "../../src/web/js/table-view.js";

const MARKER = "data-wikicc-table";

/**
 * Element stub: live children, a class list shared with `className`,
 * listeners recorded per type, and the geometry members the pin reads.
 */
function fakeElement(tagName, owner) {
  const classNames = new Set();
  const element = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    listeners: {},
    style: {},
    ownerDocument: owner || null,
    offsetWidth: 0,
    offsetHeight: 0,
    value: "",
    type: "",
    checked: false,
    rect: { left: 100, top: 50, right: 120, bottom: 70, width: 20, height: 20 },
    appendChild(child) {
      if (child && child.isFragment) {
        child.children.slice().forEach(function (moving) {
          element.appendChild(moving);
        });
        return child;
      }
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      element.children.push(child);
      child.parentNode = element;
      return child;
    },
    removeChild(child) {
      const index = element.children.indexOf(child);
      if (index >= 0) {
        element.children.splice(index, 1);
      }
      child.parentNode = null;
      return child;
    },
    insertBefore(child, reference) {
      if (child && child.isFragment) {
        child.children.slice().forEach(function (moving) {
          element.insertBefore(moving, reference);
        });
        return child;
      }
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      const index = reference ? element.children.indexOf(reference) : -1;
      if (index < 0) {
        element.children.push(child);
      } else {
        element.children.splice(index, 0, child);
      }
      child.parentNode = element;
      return child;
    },
    remove() {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(element.attributes, name)
        ? element.attributes[name]
        : null;
    },
    hasAttribute(name) {
      return Object.hasOwn(element.attributes, name);
    },
    removeAttribute(name) {
      delete element.attributes[name];
    },
    addEventListener(type, listener) {
      if (!element.listeners[type]) {
        element.listeners[type] = [];
      }
      element.listeners[type].push(listener);
    },
    removeEventListener(type, listener) {
      element.listeners[type] = (element.listeners[type] || []).filter(
        function (held) {
          return held !== listener;
        },
      );
    },
    focus() {},
    getBoundingClientRect() {
      return element.rect;
    },
    /** The browser's live collections hold the section elements only. */
    get cells() {
      return element.children.filter(function (child) {
        return child.tagName === "TD" || child.tagName === "TH";
      });
    },
    get rows() {
      return element.children.filter(function (child) {
        return child.tagName === "TR";
      });
    },
    get tBodies() {
      return element.children.filter(function (child) {
        return child.tagName === "TBODY";
      });
    },
    get tHead() {
      return (
        element.children.find(function (child) {
          return child.tagName === "THEAD";
        }) || null
      );
    },
    get firstChild() {
      return element.children[0] || null;
    },
    get isConnected() {
      let node = element;
      while (node) {
        if (node.isDocumentRoot) {
          return true;
        }
        node = node.parentNode;
      }
      return false;
    },
  };

  Object.defineProperty(element, "className", {
    get() {
      return [...classNames].join(" ");
    },
    set(value) {
      classNames.clear();
      String(value)
        .split(/\s+/)
        .filter(Boolean)
        .forEach(function (name) {
          classNames.add(name);
        });
    },
  });
  element.classList = {
    contains(name) {
      return classNames.has(name);
    },
    add(name) {
      classNames.add(name);
    },
    remove(name) {
      classNames.delete(name);
    },
  };

  // Writing text replaces the children with a text node, exactly as the
  // browser does; reading it walks them back.
  Object.defineProperty(element, "textContent", {
    get() {
      return element.children
        .map(function (child) {
          return child.textContent;
        })
        .join("");
    },
    set(value) {
      element.children = value === "" ? [] : [{ textContent: String(value) }];
    },
  });

  return element;
}

/** Document stub: the factories the view calls, and one live table query. */
function fakeDocument() {
  const doc = {
    isDocumentRoot: true,
    listeners: {},
    createElement(tag) {
      return fakeElement(tag, doc);
    },
    createElementNS() {
      return fakeElement("svg", doc);
    },
    createDocumentFragment() {
      const fragment = fakeElement("#document-fragment", doc);
      fragment.isFragment = true;
      return fragment;
    },
    addEventListener(type, listener) {
      if (!doc.listeners[type]) {
        doc.listeners[type] = [];
      }
      doc.listeners[type].push(listener);
    },
    removeEventListener(type, listener) {
      doc.listeners[type] = (doc.listeners[type] || []).filter(function (held) {
        return held !== listener;
      });
    },
    querySelectorAll(selector) {
      const found = [];
      const tag = selector.toUpperCase();
      const walk = function (node) {
        node.children.forEach(function (child) {
          if (child.tagName === tag) {
            found.push(child);
          }
          walk(child);
        });
      };
      walk(doc.documentElement);
      return found;
    },
  };

  doc.documentElement = fakeElement("html", doc);
  doc.documentElement.parentNode = doc;
  doc.documentElement.clientWidth = 1200;
  doc.documentElement.clientHeight = 800;
  doc.body = fakeElement("body", doc);
  doc.body.parentNode = doc.documentElement;

  return doc;
}

/**
 * The page listener registry the reader arms its resize listener on. It is
 * shared by every `withDocument` call, because the module's wiring flag is
 * once-per-process: the registration the first pinning test makes has to
 * stay reachable for the later burst test.
 */
const pageListeners = {};

/** Install a fake `document`, `window` and page registry, run, restore. */
function withDocument(work) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousAdd = globalThis.addEventListener;
  const previousRemove = globalThis.removeEventListener;
  const doc = fakeDocument();
  globalThis.document = doc;
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    listeners: {},
    addEventListener(type, listener) {
      if (!globalThis.window.listeners[type]) {
        globalThis.window.listeners[type] = [];
      }
      globalThis.window.listeners[type].push(listener);
    },
    removeEventListener(type, listener) {
      globalThis.window.listeners[type] = (
        globalThis.window.listeners[type] || []
      ).filter(function (held) {
        return held !== listener;
      });
    },
  };
  globalThis.addEventListener = function (type, listener) {
    if (!pageListeners[type]) {
      pageListeners[type] = [];
    }
    pageListeners[type].push(listener);
  };
  globalThis.removeEventListener = function (type, listener) {
    pageListeners[type] = (pageListeners[type] || []).filter(function (held) {
      return held !== listener;
    });
  };

  try {
    work(doc);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.addEventListener = previousAdd;
    globalThis.removeEventListener = previousRemove;
  }
}

/** Deliver a page-level event, a window resize above all, to the registry. */
function firePage(type, extra) {
  const event = Object.assign({ type: type }, extra);
  (pageListeners[type] || []).slice().forEach(function (listener) {
    listener(event);
  });
}

/** Fire `type` at `element`: its own listeners, with the fields they touch. */
function fire(element, type, extra) {
  const event = Object.assign(
    {
      type: type,
      target: element,
      key: "",
      isComposing: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    },
    extra,
  );
  (element.listeners[type] || []).slice().forEach(function (listener) {
    listener.call(element, event);
  });
  return event;
}

/**
 * A four-row table as the build emits it: two columns, one row whose long
 * note is what keeps the second column wide.
 */
function buildTable(doc, headerWidths) {
  const table = fakeElement("table", doc);
  const head = fakeElement("thead", doc);
  const headerRow = fakeElement("tr", doc);

  ["Name", "Note"].forEach(function (text) {
    const th = fakeElement("th", doc);
    th.textContent = text;
    headerRow.appendChild(th);
  });
  head.appendChild(headerRow);
  table.appendChild(head);

  const body = fakeElement("tbody", doc);
  [
    ["alpha", "short remark"],
    [
      "beta",
      "a particularly long remark that keeps this column comfortably wide",
    ],
    ["gamma", "short remark"],
    ["delta", "short remark"],
  ].forEach(function (cells) {
    const row = fakeElement("tr", doc);
    cells.forEach(function (text) {
      const td = fakeElement("td", doc);
      td.textContent = text;
      row.appendChild(td);
    });
    body.appendChild(row);
  });
  table.appendChild(body);

  doc.body.appendChild(table);

  table.offsetWidth = 600;
  headerRow.cells.forEach(function (th, index) {
    th.offsetWidth = headerWidths[index];
  });

  return table;
}

/** Column widths as the pin wrote them: one `col` style per header. */
function pinnedWidths(table) {
  const colgroup = table.firstChild;
  return {
    attributeName: colgroup.tagName,
    widths: colgroup.children.map(function (col) {
      return col.style.width;
    }),
    locked: table.hasAttribute(LOCK_ATTRIBUTE),
  };
}

/** Open the filter panel of the first column the way a reader's press does. */
function openFilterPanel(table) {
  const button = table.tHead.rows[0].cells[0].children.find(function (child) {
    // An active filter adds its own class, so the match is by membership.
    return child.classList && child.classList.contains(FILTER_BUTTON_CLASS);
  });
  fire(button, "click", {});
  return button;
}

/** The panel last appended to the body, with its option rows and actions. */
function openPanel(doc) {
  const panel = doc.body.children[doc.body.children.length - 1];
  const footer = panel.children[3];
  return {
    panel: panel,
    options: panel.children[2].children,
    confirm: footer.children.find(function (child) {
      return child.className === FILTER_CONFIRM_CLASS;
    }),
    clear: footer.children[0],
  };
}

/** Apply the panel draft with one candidate unticked, as a reader would. */
function untickAndApply(doc, value) {
  const opened = openPanel(doc);
  // The row's own text carries its occurrence count; the value span is exact.
  const option = opened.options.find(function (row) {
    return row.children[1].textContent === value;
  });
  option.children[0].checked = false;
  fire(option.children[0], "change", {});
  fire(opened.confirm, "click", {});
}

/** Leave an open panel the way `Escape` does, so no test leaks one. */
function closePanel(doc) {
  const panel = doc.body.children[doc.body.children.length - 1];
  if (panel.className === "table-filter-panel") {
    fire(panel, "keydown", { key: "Escape" });
  }
}

test("pins the measured auto-layout widths when enhanced on screen", () => {
  withDocument((doc) => {
    const table = buildTable(doc, [107, 479]);

    assert.equal(enhanceTable(table), true);
    assert.equal(table.hasAttribute(MARKER), true);

    const pin = pinnedWidths(table);
    assert.equal(pin.attributeName, "COLGROUP");
    assert.deepEqual(pin.widths, ["107px", "479px"]);
    assert.equal(pin.locked, true);

    // The pin rides ahead of the header, not among the body rows.
    assert.equal(table.children[0].tagName, "COLGROUP");
    assert.equal(table.children[1].tagName, "THEAD");

    // A second pass is a no-op: one colgroup, the same widths.
    assert.equal(enhanceTable(table), false);
    assert.equal(
      table.children.filter((child) => child.tagName === "COLGROUP").length,
      1,
    );
    assert.deepEqual(pinnedWidths(table).widths, ["107px", "479px"]);
  });
});

test("a table enhanced offscreen pins at its first filter, at the load baseline", () => {
  withDocument((doc) => {
    const table = buildTable(doc, [107, 479]);
    table.offsetWidth = 0; // filled before its panel is shown

    assert.equal(enhanceTable(table), true);
    assert.equal(table.hasAttribute(LOCK_ATTRIBUTE), false, "not pinned yet");

    // A re-measure sweep cannot pin it either: there is no layout to read.
    relayoutLockedTables();
    assert.equal(table.hasAttribute(LOCK_ATTRIBUTE), false);

    // The panel appears, the table is on screen, the reader narrows the rows.
    table.offsetWidth = 600;
    openFilterPanel(table);
    untickAndApply(doc, "beta");

    const pin = pinnedWidths(table);
    assert.deepEqual(
      pin.widths,
      ["107px", "479px"],
      "the pin is the whole-table baseline, measured before any row hid",
    );
    assert.equal(pin.locked, true);
    assert.equal(table.tBodies[0].rows[1].hasAttribute("hidden"), true);
    assert.equal(table.tBodies[0].rows[0].hasAttribute("hidden"), false);

    table.remove();
  });
});

test("filtering a pinned table leaves the pin and the widths untouched", () => {
  withDocument((doc) => {
    const table = buildTable(doc, [107, 479]);
    enhanceTable(table);
    const before = pinnedWidths(table);

    openFilterPanel(table);
    untickAndApply(doc, "beta");

    assert.deepEqual(
      pinnedWidths(table),
      before,
      "the pin survived the filter",
    );
    assert.equal(table.tBodies[0].rows[1].hasAttribute("hidden"), true);

    // Clearing the filter goes through the same path and the same pin.
    openFilterPanel(table);
    fire(openPanel(doc).clear, "click", {});

    assert.deepEqual(pinnedWidths(table), before, "the pin survived the clear");
    assert.equal(
      table.tBodies[0].rows
        .filter((row) => row.className !== "table-empty-row")
        .every((row) => !row.hasAttribute("hidden")),
      true,
    );
    table.remove();
  });
});

test("sorting reorders the body and never touches the pin", () => {
  withDocument((doc) => {
    const table = buildTable(doc, [107, 479]);
    enhanceTable(table);
    const before = pinnedWidths(table);

    const header = table.tHead.rows[0].cells[0];
    fire(header, "click", {}); // ascending
    fire(header, "click", {}); // descending
    fire(header, "click", {}); // cleared

    assert.deepEqual(pinnedWidths(table), before);
    const notes = table.tBodies[0].rows
      .filter((row) => row.className !== "table-empty-row")
      .map((row) => row.textContent);
    assert.deepEqual(notes, [
      "alphashort remark",
      "betaa particularly long remark that keeps this column comfortably wide",
      "gammashort remark",
      "deltashort remark",
    ]);
    table.remove();
  });
});

test("relayout re-measures with every row visible and restores what the filter hid", () => {
  withDocument((doc) => {
    const table = buildTable(doc, [107, 479]);
    enhanceTable(table);

    openFilterPanel(table);
    untickAndApply(doc, "beta");
    closePanel(doc);

    // What the auto layout would report after the window grew, with the whole
    // table visible. The getter also snapshots the states the measure saw.
    const measure = { rowsHidden: null, emptyVisible: null };
    const emptyRow = table.tBodies[0].children.find(function (child) {
      return child.tagName === "TR" && child.className === "table-empty-row";
    });
    const headers = table.tHead.rows[0].cells;
    Object.defineProperty(headers[1], "offsetWidth", {
      get() {
        measure.rowsHidden = table.tBodies[0].rows
          .filter((row) => row.className !== "table-empty-row")
          .some((row) => row.hasAttribute("hidden"));
        measure.emptyVisible = !emptyRow.hasAttribute("hidden");
        return 560;
      },
    });
    headers[0].offsetWidth = 150;

    relayoutLockedTables();

    assert.deepEqual(
      pinnedWidths(table).widths,
      ["150px", "560px"],
      "the re-measure rewrote the pin from the new layout",
    );
    assert.deepEqual(
      measure,
      { rowsHidden: false, emptyVisible: false },
      "the measure saw the full table: no row hidden, no colspan placeholder",
    );
    assert.equal(table.tBodies[0].rows[1].hasAttribute("hidden"), true);
    assert.equal(emptyRow.hasAttribute("hidden"), true);
    table.remove();
  });
});

test("a table that left the document is dropped from the re-measure sweep", () => {
  withDocument((doc) => {
    const table = buildTable(doc, [107, 479]);
    enhanceTable(table);
    const before = pinnedWidths(table);

    table.remove();
    table.tHead.rows[0].cells[0].offsetWidth = 300;
    table.tHead.rows[0].cells[1].offsetWidth = 700;

    relayoutLockedTables();

    assert.deepEqual(
      pinnedWidths(table),
      before,
      "a detached table is not re-measured",
    );
  });
});

test("a window resize burst settles into exactly one re-measure", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  withDocument((doc) => {
    const table = buildTable(doc, [107, 479]);
    enhanceTable(table);

    let measures = 0;
    const headers = table.tHead.rows[0].cells;
    Object.defineProperty(headers[1], "offsetWidth", {
      get() {
        measures += 1;
        return 560;
      },
    });
    headers[0].offsetWidth = 150;

    firePage("resize");
    firePage("resize");
    firePage("resize");

    t.mock.timers.tick(100);
    assert.equal(measures, 0, "the burst has not settled yet");
    assert.deepEqual(pinnedWidths(table).widths, ["107px", "479px"]);

    t.mock.timers.tick(50);
    assert.equal(measures, 1, "one sweep for the whole burst");
    assert.deepEqual(pinnedWidths(table).widths, ["150px", "560px"]);

    table.remove();
  });
});

test("the open filter panel rides its anchor after a re-measure", () => {
  withDocument((doc) => {
    const table = buildTable(doc, [107, 479]);
    enhanceTable(table);

    const button = openFilterPanel(table);
    const panel = doc.body.children[doc.body.children.length - 1];
    assert.equal(panel.style.left, "100px", "placed at the anchor's old rect");

    button.rect.left = 300;
    relayoutLockedTables();

    assert.equal(panel.style.left, "300px", "re-placed at the new rect");

    closePanel(doc);
    table.remove();
  });
});

test("a table without a header and body rows is left untouched", () => {
  withDocument((doc) => {
    const table = fakeElement("table", doc);
    const head = fakeElement("thead", doc);
    head.appendChild(fakeElement("tr", doc));
    table.appendChild(head);
    const body = fakeElement("tbody", doc);
    table.appendChild(body);
    doc.body.appendChild(table);

    assert.equal(enhanceTable(table), false);
    assert.equal(table.hasAttribute(LOCK_ATTRIBUTE), false);
    assert.equal(table.children[0].tagName, "THEAD");
  });
});
