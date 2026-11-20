/**
 * Tests for the reader's tag aggregation wiring (`src/web/js/app.js` and
 * the composed shell).
 *
 * The tags panel is the floating window's fourth view, and one selection
 * answers everywhere: a row in the panel filters the document list and
 * unfolds the tag's documents, a chip in the article answers the same way
 * and brings both surfaces into view, and a navigation keeps the filter the
 * reader chose. The page itself comes from `./helpers/app-fixture.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  activeEntry,
  countLinks,
  startSession,
  withSession,
} from "./helpers/app-fixture.js";

const TAGS = [
  { tag: "rust", docs: ["guide/intro.md"] },
  { tag: "solo", docs: ["index.md"] },
];

/** The documents for a site whose index declares one tag. */
const taggedDocs = [
  {
    id: "index.md",
    title: "Index",
    html: "<p>tagged here</p>",
    text: "tagged here",
    toc: [],
    blocks: [],
    tags: ["solo"],
  },
  {
    id: "guide/intro.md",
    title: "Intro",
    html: "<p>body</p>",
    text: "intro",
    toc: [
      {
        id: "getting-started",
        text: "Getting Started",
        level: 2,
        children: [],
      },
    ],
    blocks: [
      {
        id: "getting-started",
        level: 2,
        parent: null,
        html: "<p>body</p>",
        subtree: [0],
      },
    ],
  },
];

/** Every `.tag-name` row of the tags panel, in document order. */
function tagRows(shell) {
  const rows = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.tagName === "BUTTON" && child.className === "tag-name") {
        rows.push(child);
      }
      walk(child);
    });
  })(shell.get("tags"));
  return rows;
}

/** The tag chip the article carries, or `null`. */
function chipIn(shell) {
  const found = [];
  (function walk(node) {
    (node.children || []).forEach(function (child) {
      if (child.className === "doc-tag") {
        found.push(child);
      }
      walk(child);
    });
  })(shell.get("doc-article"));
  return found[0] || null;
}

function plainClick() {
  return { button: 0, preventDefault() {} };
}

test("the panel lists the payload's tags and starts with nothing unfolded", () => {
  withSession({ hash: "#/doc/index.md", tags: TAGS }, (session) => {
    startSession();

    const rows = tagRows(session.shell);
    assert.equal(rows.length, 2, "one row per tag, in payload order");
    assert.equal(
      rows.every(function (row) {
        return row.getAttribute("aria-expanded") === "false";
      }),
      true,
    );
    assert.equal(
      countLinks(session.shell.get("tags")),
      0,
      "nothing is unfolded before a selection",
    );
    assert.equal(
      countLinks(session.shell.get("doc-list")),
      2,
      "no filter is applied before a selection",
    );
    assert.equal(
      session.doc.body.getAttribute("data-graph-view"),
      "local",
      "the window starts in the local view, as before",
    );
  });
});

test("a payload without tags renders the empty message", () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const panel = session.shell.get("tags");
    assert.equal(panel.children.length, 1);
    assert.equal(panel.children[0].className, "tags-empty");
    assert.equal(
      countLinks(session.shell.get("doc-list")),
      2,
      "the list is whole when the site carries no tags",
    );
  });
});

test("selecting a tag filters the document list and unfolds it in the panel", () => {
  withSession({ hash: "#/doc/index.md", tags: TAGS }, (session) => {
    startSession();

    tagRows(session.shell)[0].fire("click", plainClick());

    let rows = tagRows(session.shell);
    assert.equal(
      countLinks(session.shell.get("doc-list")),
      1,
      "only the document the tag names survives the filter",
    );
    assert.equal(rows[0].getAttribute("aria-expanded"), "true");
    assert.equal(
      countLinks(session.shell.get("tags")),
      1,
      "the tag's documents unfold beneath it",
    );

    rows[0].fire("click", plainClick());

    rows = tagRows(session.shell);
    assert.equal(
      countLinks(session.shell.get("doc-list")),
      2,
      "selecting the selected tag puts the filter away",
    );
    assert.equal(countLinks(session.shell.get("tags")), 0);
    assert.equal(rows[0].getAttribute("aria-expanded"), "false");
  });
});

test("a navigation keeps the filter the reader chose", () => {
  withSession({ hash: "#/doc/index.md", tags: TAGS }, (session) => {
    startSession();

    tagRows(session.shell)[0].fire("click", plainClick());
    session.follow("#/doc/guide/intro.md#getting-started");

    assert.equal(
      countLinks(session.shell.get("doc-list")),
      1,
      "the filter survives the navigation",
    );
    assert.equal(
      activeEntry(session.shell).textContent,
      "Intro",
      "the document the reader reached is the one the filter keeps",
    );
  });
});

test("a chip in the article answers like the panel's row", () => {
  withSession(
    { hash: "#/doc/index.md", docs: taggedDocs, tags: TAGS },
    (session) => {
      startSession();

      const chip = chipIn(session.shell);
      assert.ok(chip, "the render carries the chip the declared tags built");

      // The surfaces the answer brings up start folded away.
      session.doc.body.setAttribute("data-sidebar", "hidden");
      session.doc.body.setAttribute("data-graph", "hidden");

      session.shell
        .get("doc-article")
        .fire("click", Object.assign(plainClick(), { target: chip }));

      assert.equal(
        countLinks(session.shell.get("doc-list")),
        1,
        "the chip selected its tag",
      );
      assert.equal(
        session.doc.body.getAttribute("data-graph-view"),
        "tags",
        "the tags view came up",
      );
      assert.equal(
        session.doc.body.getAttribute("data-graph"),
        null,
        "the folded window unfolded for the answer",
      );
      assert.equal(
        session.doc.body.getAttribute("data-sidebar"),
        null,
        "the document list came back to show the filter",
      );
      assert.equal(
        session.shell.get("tags-toggle").getAttribute("aria-expanded"),
        "true",
        "the switch speaks for the view it brought up",
      );
    },
  );
});

test("a keyboard press answers the chip the same way a click does", () => {
  withSession(
    { hash: "#/doc/index.md", docs: taggedDocs, tags: TAGS },
    (session) => {
      startSession();

      const chip = chipIn(session.shell);
      session.shell
        .get("doc-article")
        .fire("keydown", { key: "Enter", target: chip, preventDefault() {} });

      assert.equal(
        countLinks(session.shell.get("doc-list")),
        1,
        "the keyboard selected the chip's tag",
      );
      assert.equal(session.doc.body.getAttribute("data-graph-view"), "tags");
    },
  );
});

test("a press that does not start on a chip leaves everything alone", () => {
  withSession(
    { hash: "#/doc/index.md", docs: taggedDocs, tags: TAGS },
    (session) => {
      startSession();

      const article = session.shell.get("doc-article");
      article.fire("click", {
        button: 0,
        target: article,
        preventDefault() {
          assert.fail("a press outside the chips must not be cancelled");
        },
      });

      assert.equal(
        countLinks(session.shell.get("doc-list")),
        2,
        "no filter was applied",
      );
      assert.equal(
        session.doc.body.getAttribute("data-graph-view"),
        "local",
        "no view was traded",
      );
    },
  );
});

test("the rail's switch trades the window's tags view", () => {
  withSession({ hash: "#/doc/index.md", tags: TAGS }, (session) => {
    startSession();

    const toggle = session.shell.get("tags-toggle");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    toggle.fire("click");
    assert.equal(session.doc.body.getAttribute("data-graph-view"), "tags");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Hide tags");

    toggle.fire("click");
    assert.equal(
      session.doc.body.getAttribute("data-graph"),
      "hidden",
      "the switch pressed again folds the window",
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-label"), "Show tags");
  });
});
