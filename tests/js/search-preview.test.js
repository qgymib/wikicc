/**
 * Tests for the search preview (`src/web/js/search-preview.js`): the whole
 * document behind the selected result, drawn in the dialog's bottom half.
 *
 * The rules under test are about what the half shows: the excerpt while the
 * document is on its way, the whole body once it lands, a mark on every place
 * the query occurs, the standout on the one the reader picked, and the notice
 * that explains a sealed document's emptiness. The list that drives it is
 * `search-panel.test.js`'s subject.
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as search from "../../src/web/js/search.js";
import {
  DOCUMENT_CLASS,
  EMPTY_CLASS,
  HIT_ACTIVE_CLASS,
  HIT_CLASS,
  LOCKED_NOTICE,
  RESULT_CLASS,
  SEARCH_LOCKED_CLASS,
} from "../../src/web/js/search-view.js";
import { textOf } from "./helpers/dom.js";
import {
  build,
  documentModel,
  documentOf,
  entry,
  lockedEntry,
  previewOf,
  type,
  withPage,
} from "./helpers/search-fixture.js";

test("the preview shows the passage of the selected match, with the hit marked", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "beta");

    // The engine's ranking decides the order, and the first entry is the one
    // selected; the preview is the passage of that entry.
    var preview = previewOf(page);
    var passage = preview.children[0];
    assert.equal(passage.className, "search-passage");
    assert.deepEqual(
      passage.children.map(function (node) {
        assert.ok(
          !node.children.length,
          "a passage is text and one mark, never markup",
        );
        return node.tagName === "MARK"
          ? "[" + textOf(node) + "]"
          : textOf(node);
      }),
      ["\u2026or ", "[alpha]", " and more\u2026"],
    );
  });
});

test("the preview shows the whole document, not just the passage", () => {
  withPage(function (page) {
    var html =
      '<h1 id="alpha">Alpha</h1>\n<p>alpha one</p>\n<p>alpha two</p>\n<p>alpha three</p>\n';
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var body = documentOf(page);
    assert.ok(body, "the document body is on screen");
    assert.equal(body.className, DOCUMENT_CLASS + " doc-body");
    assert.equal(
      textOf(body).replace(/\n/g, ""),
      "Alphaalpha onealpha twoalpha three",
      "every paragraph arrived, not a cut-out one",
    );
    assert.equal(
      page.container.findAll("search-passage").length,
      0,
      "the excerpt is only the fallback",
    );
    assert.equal(
      page.container.findAll("search-doc-head").length,
      0,
      "no banner sits between the panel and the document",
    );
    assert.equal(
      page.container.findAll("search-doc-title").length,
      0,
      "no title line repeats what the reader picked",
    );
    assert.equal(
      page.container.findAll("search-doc-path").length,
      0,
      "no path line above the body",
    );
  });
});

test("every hit in the whole document is marked, not only the first", () => {
  withPage(function (page) {
    var html =
      "<h1>A</h1>\n<p>alpha here</p>\n<p>nothing</p>\n<p>alpha again</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2, "each paragraph's hit is marked");
    assert.deepEqual(
      marks.map(textOf),
      ["alpha", "alpha"],
      "a hit keeps the text the reader sees",
    );
  });
});

test("a hit inside a code block is not marked", () => {
  withPage(function (page) {
    var html = "<p>alpha text</p>\n<pre><code>alpha</code></pre>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 1, "the code block is left as written");
    assert.equal(marks[0].parentNode.tagName, "P");
  });
});

test("the list's ordinals name the same places the preview's slots do", () => {
  withPage(function (page) {
    // A document whose prefix hits ("reader") sit in front of a whole word
    // ("read"): the enumeration must keep all of them, and the list must
    // number exactly the places the preview marked — one row per place, the
    // row's snippet and the slot behind its ordinal naming the same word.
    // A whole-first pick of the next occurrence once dropped the prefix hits
    // in between, and the list then numbered fewer places than the preview
    // held, so a picked row scrolled the preview to a different place.
    var html =
      "<p>the reader opens the reader</p>\n<p>then read the rest</p>\n";
    // The document's searchable text, as the build writes it: the paragraphs
    // joined with one space.
    var text = "the reader opens the reader then read the rest";
    var siteDocs = [{ id: "a.md", title: "A", text: text, toc: [] }];
    var engine = search.createSearch(siteDocs);
    var rows = search.occurrences(
      siteDocs,
      search.search(engine, "read"),
      "read",
    );

    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "A", html) },
      answer() {
        return rows;
      },
    });
    built.view.open();
    type(built.view, page, "read");

    assert.equal(rows.length, 3, "every occurrence is its own row");
    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(
      marks.length,
      rows.length,
      "the preview holds one slot per row",
    );
    rows.forEach(function (row, ordinal) {
      assert.equal(
        textOf(marks[ordinal]),
        row.snippet.hit,
        "row " + ordinal + " and slot " + ordinal + " are the same place",
      );
    });
  });
});

test("the preview is scrolled to the first hit", () => {
  var scrolled = [];

  withPage(function (page) {
    // Every element the page creates learns to report its own reveal, so the
    // assertion can see which node the view asked the browser to bring in.
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ text: textOf(element), options: options });
      };
    });

    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha first</p>\n<p>alpha second</p>\n",
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    // The list reveals its rows with `nearest`; these assertions hear only
    // the preview's own asks, which ask for the middle of the document.
    var previews = scrolled.filter(function (call) {
      return call.options && call.options.block === "center";
    });

    assert.equal(previews.length, 1, "one hit is revealed, not every hit");
    assert.equal(previews[0].text, "alpha");
    assert.equal(
      previews[0].options.block,
      "center",
      "the picked hit is asked for the middle of the preview",
    );
  });
});

test("the hit the preview scrolled to is the one that stands out", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha first</p>\n<p>filler</p>\n<p>alpha second</p>\n",
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha", 1)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2);
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS],
      "the second occurrence is the reader's pick and carries the active class alone",
    );
  });
});

test("the standout follows the selection to another occurrence", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha first</p>\n<p>alpha second</p>\n",
        ),
      },
      answer() {
        return [
          entry("a.md", "Alpha", "alpha", 0),
          entry("a.md", "Alpha", "alpha", 1),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(
      marks[0].className,
      HIT_CLASS + " " + HIT_ACTIVE_CLASS,
      "the first row's hit stands out first",
    );

    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });

    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS],
      "the second row's hit takes the standout from the first",
    );
  });
});

test("a document drawn without a mark leaves no standout behind", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel("a.md", "Alpha", "<p>alpha text</p>\n"),
        "b.md": documentModel("b.md", "Beta", "<p>plain text</p>\n"),
      },
      answer() {
        return [entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "beta");

    // `b.md` matched on its title alone, so the preview shows it with no hit
    // of the query anywhere: no mark exists, and none may claim the standout.
    assert.equal(page.container.findAll(HIT_CLASS).length, 0);
    assert.equal(page.container.findAll(HIT_ACTIVE_CLASS).length, 0);
  });
});

test("a code block's occurrence is brought to its block, not a textual stand-in", () => {
  var scrolled = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      documents: {
        // A hit inside the code block is counted by the list but never marked,
        // so a row can name an occurrence the preview holds no mark for.
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha here</p>\n<pre><code>alpha</code></pre>\n",
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha", 1)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 1, "the code block's hit is not marked");
    assert.equal(
      marks[0].className,
      HIT_CLASS,
      "no textual hit is made to stand in for the code block's own",
    );

    // Only the preview's asks are read here; the list's `nearest` reveal of
    // its own row is the row navigation's business.
    var revealed = scrolled
      .filter(function (call) {
        return call.options && call.options.block === "center";
      })
      .map(function (call) {
        return call.element;
      });

    assert.deepEqual(
      revealed,
      [previewOf(page).findAllByTag("PRE")[0]],
      "the eye is brought to the block the hit sits in",
    );
  });
});

test("a hit inside inline code is marked like any other text", () => {
  withPage(function (page) {
    var html = "<p>plain <code>alpha</code> tail</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 1, "the inline code's hit is marked");
    assert.equal(
      marks[0].parentNode.tagName,
      "CODE",
      "the mark sits inside the code element it highlights",
    );
    assert.equal(textOf(marks[0]), "alpha");
  });
});

test("the inline-code hit takes the standout when picked", () => {
  withPage(function (page) {
    var html = "<p>alpha first</p>\n<p>see <code>alpha</code> code</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "alpha", 1)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2);
    assert.equal(marks[1].parentNode.tagName, "CODE");
    assert.equal(
      marks[1].className,
      HIT_CLASS + " " + HIT_ACTIVE_CLASS,
      "the picked inline-code hit raises its voice like a textual one",
    );
  });
});

test("inline code and code blocks keep their own places in the slot order", () => {
  var scrolled = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha one</p>\n<p>see <code>alpha</code> code</p>\n<pre><code>alpha</code></pre>\n<p>alpha two</p>\n",
        ),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha", 2)];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 3, "inline code is marked, the block is not");
    assert.equal(marks[1].parentNode.tagName, "CODE");
    assert.equal(
      marks[2].className,
      HIT_CLASS,
      "no textual hit stands in for the block's own occurrence",
    );

    // Only the preview's asks are read here; the list's `nearest` reveal of
    // its own row is the row navigation's business.
    var revealed = scrolled
      .filter(function (call) {
        return call.options && call.options.block === "center";
      })
      .map(function (call) {
        return call.element;
      });

    assert.deepEqual(
      revealed,
      [previewOf(page).findAllByTag("PRE")[0]],
      "the block's occurrence still scrolls to its block",
    );
  });
});

test("picking another occurrence of one document scrolls, and does not redraw", () => {
  var scrolled = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ element: element, options: options });
      };
    });

    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel(
          "a.md",
          "Alpha",
          "<p>alpha first</p>\n<p>alpha second</p>\n",
        ),
      },
      answer() {
        return [
          entry("a.md", "Alpha", "alpha", 0),
          entry("a.md", "Alpha", "alpha", 1),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2);
    var drawn = built.calls.asked.length;
    scrolled.length = 0;

    // The second row names the second occurrence of the document already on
    // screen: the marks stand where they stood, and only the eye moves.
    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });

    assert.equal(
      built.calls.asked.length,
      drawn,
      "the same document is not drawn twice",
    );

    // The click also reveals the row itself with `nearest`; the asks read
    // here are the preview's, which move the eye inside the document.
    var revealed = scrolled
      .filter(function (call) {
        return call.options && call.options.block === "center";
      })
      .map(function (call) {
        return call.element;
      });

    assert.deepEqual(
      revealed,
      [marks[1]],
      "the scroll lands on the occurrence the row names",
    );
    assert.equal(built.view.isOpen(), true);
  });
});

test("the preview is drawn again for a new query, and not for the same row", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: {
        "a.md": documentModel("a.md", "Alpha", "<p>alpha one</p>"),
        "b.md": documentModel("b.md", "Beta", "<p>beta</p>"),
      },
      answer() {
        return [entry("a.md", "Alpha", "alpha"), entry("b.md", "Beta", "beta")];
      },
    });
    built.view.open();
    type(built.view, page, "a");

    var first = built.calls.asked.length;
    var input = built.view.input();

    // Moving inside the row already selected is not a new document.
    input.fire("keydown", { key: "ArrowUp" });
    assert.equal(
      built.calls.asked.length,
      first,
      "the same row is not asked for twice",
    );

    input.fire("keydown", { key: "ArrowDown" });
    assert.equal(built.calls.asked[built.calls.asked.length - 1], "b.md");
    assert.equal(
      textOf(documentOf(page)),
      "beta",
      "the second document is on screen",
    );
  });
});

test("a payload that cannot answer falls back to the excerpt", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      answer() {
        return [entry("a.md", "Alpha", "alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    assert.equal(documentOf(page), null);
    var passage = page.container.findAll("search-passage");
    assert.equal(
      passage.length,
      1,
      "the reader still sees where the query was found",
    );
    assert.equal(textOf(passage[0]), "\u2026or alpha and more\u2026");
  });
});

test("the document's own text is never turned into markup", () => {
  withPage(function (page) {
    // The body is the build's own HTML; the query is a tag name, which must
    // not be able to cut the markup it is looking for.
    var html = "<p>about &lt;b&gt;bold&lt;/b&gt; text</p>";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [entry("a.md", "Alpha", "bold")];
      },
    });
    built.view.open();
    type(built.view, page, "bold");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 1);
    assert.equal(textOf(marks[0]), "bold");
    assert.equal(
      marks[0].children.length,
      0,
      "a mark holds text, never elements",
    );
  });
});

test("the preview of a sealed document says the lock is the reason", () => {
  withPage(function (page) {
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", "") },
      answer() {
        return [lockedEntry("a.md", "Alpha")];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var notices = page.container.findAll(SEARCH_LOCKED_CLASS);
    assert.equal(notices.length, 1, "the preview speaks instead of idling");
    assert.equal(textOf(notices[0]), LOCKED_NOTICE);
    assert.equal(
      documentOf(page),
      null,
      "no body is drawn for a document the page cannot show",
    );
    assert.equal(page.container.findAll(EMPTY_CLASS).length, 0);
  });
});

/**
 * The list numbers occurrences over the document's whole text — a code block's
 * text included — while the highlight leaves code as authored, so the row an
 * ordinal names and the mark the preview addresses must stay paired even when
 * the code block's own occurrences hold no mark at all.
 */
test("every occurrence addresses its own mark, even past a code block", () => {
  var scrolled = [];

  withPage(function (page) {
    page.decorate(function (element) {
      element.scrollIntoView = function (options) {
        scrolled.push({ text: textOf(element), options: options });
      };
    });

    // The engine's `occurrences` reads "… one … two … three … four …" — the
    // code block's hit is the second of four, and carries no mark below.
    var html =
      "<p>alpha one</p>\n<pre><code>alpha two</code></pre>\n" +
      "<p>alpha three</p>\n<p>alpha four</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [
          entry("a.md", "Alpha", "alpha one", 0),
          entry("a.md", "Alpha", "alpha two", 1),
          entry("a.md", "Alpha", "alpha three", 2),
          entry("a.md", "Alpha", "alpha four", 3),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 3, "the code block alone stays unwrapped");

    /** The preview's own asks since `scrolled.length` was last reset. */
    function revealed() {
      return scrolled
        .filter(function (call) {
          return call.options && call.options.block === "center";
        })
        .map(function (call) {
          return call.text;
        });
    }

    // The code block's own row: nothing pretends to highlight it, and the
    // block that holds the hit is where the eye is brought.
    scrolled.length = 0;
    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS, HIT_CLASS],
      "a hit inside the code block is addressed without a standout",
    );
    assert.deepEqual(
      revealed(),
      ["alpha two"],
      "the code block's row is brought to the code block itself",
    );

    // The row after it names the next paragraph, not the one the code block
    // just displaced.
    scrolled.length = 0;
    page.container
      .findAll(RESULT_CLASS)[2]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS, HIT_CLASS],
      "the third occurrence stands out where its paragraph says",
    );
    assert.deepEqual(
      revealed(),
      ["alpha"],
      "the third occurrence's own mark is the one brought to the middle",
    );

    // The last row keeps its pairing too.
    page.container
      .findAll(RESULT_CLASS)[3]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS],
      "the fourth occurrence stands out where its paragraph says",
    );
  });
});

/** Two hits sharing one text node must be addressed in the order read. */
test("two hits of one paragraph are addressed in reading order", () => {
  withPage(function (page) {
    var html = "<p>alpha and alpha again</p>\n";
    var built = build({
      container: page.container,
      documents: { "a.md": documentModel("a.md", "Alpha", html) },
      answer() {
        return [
          entry("a.md", "Alpha", "alpha", 0),
          entry("a.md", "Alpha", "alpha", 1),
        ];
      },
    });
    built.view.open();
    type(built.view, page, "alpha");

    var marks = page.container.findAll(HIT_CLASS);
    assert.equal(marks.length, 2, "both hits of the paragraph are marked");
    assert.equal(
      documentOf(page).textContent,
      "alpha and alpha again\n",
      "wrapping two hits of one node keeps the paragraph's text whole",
    );

    page.container
      .findAll(RESULT_CLASS)[0]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS + " " + HIT_ACTIVE_CLASS, HIT_CLASS],
      "the first hit of the paragraph is the first one addressed",
    );

    page.container
      .findAll(RESULT_CLASS)[1]
      .fire("click", { preventDefault() {} });
    assert.deepEqual(
      marks.map(function (mark) {
        return mark.className;
      }),
      [HIT_CLASS, HIT_CLASS + " " + HIT_ACTIVE_CLASS],
      "the second hit of the paragraph is the second one addressed",
    );
  });
});

/* ---------- the pages format: documents and answers that travel ---------- */

test("a document that travels in replaces the excerpt when it lands", () => {
  withPage(function (page) {
    var deliver = null;
    var built = build({
      container: page.container,
      travelling() {
        return {
          // biome-ignore lint/suspicious/noThenProperty: a deliberately synchronous thenable, so the test needs no microtask flush
          then(callback) {
            deliver = callback;
          },
        };
      },
    });

    built.view.setResults([entry("a.md", "Alpha", "alpha")], 0);

    assert.match(
      textOf(previewOf(page)),
      /alpha/,
      "the excerpt answers while the document is on its way",
    );

    deliver({
      id: "a.md",
      html: "<p>the whole document</p>",
      toc: [],
      blocks: [],
    });

    assert.match(
      textOf(previewOf(page)),
      /the whole document/,
      "the fetched document takes the excerpt's place",
    );
    assert.doesNotMatch(textOf(previewOf(page)), /alpha/);
  });
});

test("an answer for a selection the reader has left behind draws nothing", () => {
  withPage(function (page) {
    // One callback per request, like the promises the store really returns:
    // the older answer still lands, it just finds a newer row drawn.
    const deliveries = [];
    var built = build({
      container: page.container,
      travelling() {
        return {
          // biome-ignore lint/suspicious/noThenProperty: a deliberately synchronous thenable, so the test needs no microtask flush
          then(callback) {
            deliveries.push(callback);
          },
        };
      },
    });

    built.view.setResults([entry("a.md", "Alpha", "alpha")], 0);
    built.view.setResults([entry("b.md", "Beta", "beta")], 0);
    assert.equal(deliveries.length, 2, "each row asked for its own document");

    deliveries[0]({
      id: "a.md",
      html: "<p>stale document</p>",
      toc: [],
      blocks: [],
    });

    assert.doesNotMatch(
      textOf(previewOf(page)),
      /stale/,
      "the newer row owns the preview",
    );
    assert.match(textOf(previewOf(page)), /beta/);
  });
});
