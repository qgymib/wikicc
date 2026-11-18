/**
 * Tests for the layout panels the reader switches
 * (`src/web/js/panels.js` through the composed `app.js`).
 *
 * The rules under test are the ones the switches answer for: the drawer on
 * the narrow widths, the document list and the outline trading the sidebar's
 * single view, the graph's two views and their fold, and the two of the
 * reader's choices — the sidebar's view and its visibility — that a reload
 * remembers.
 *
 * The page itself comes from `./helpers/app-fixture.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeElement } from "./helpers/dom.js";
import { withSession, startSession } from "./helpers/app-fixture.js";

test("the toggle puts the document list away and brings it back", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const toggle = session.shell.get("sidebar-collapse");

    assert.equal(
      body.getAttribute("data-sidebar"),
      null,
      "the list starts showing on a wide screen",
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Hide document list");

    toggle.fire("click");
    assert.equal(body.getAttribute("data-sidebar"), "hidden");
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      "false",
      "the toggle answers for the list it hid",
    );
    assert.equal(
      toggle.getAttribute("aria-label"),
      "Show document list",
      "the rail's switch now offers to bring the list back",
    );

    toggle.fire("click");
    assert.equal(body.getAttribute("data-sidebar"), null);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Hide document list");
  });
});

test("a navigation keeps the document list put away", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();
    session.shell.get("sidebar-collapse").fire("click");
    assert.equal(session.doc.body.getAttribute("data-sidebar"), "hidden");

    // Following a document closes only the drawer's state: the wide layout's
    // hidden column is the reader's choice, not a navigation side effect.
    session.follow("#/doc/guide/intro.md#getting-started");
    assert.equal(session.doc.body.getAttribute("data-sidebar"), "hidden");
    assert.equal(session.doc.body.getAttribute("data-drawer"), "closed");
  });
});

test("the narrow screen's toggle still drives the drawer", async () => {
  withSession({ hash: "#/doc/index.md", drawer: true }, (session) => {
    startSession();

    const body = session.doc.body;
    const toggle = session.shell.get("sidebar-toggle");

    assert.equal(body.getAttribute("data-drawer"), "closed");

    toggle.fire("click");
    assert.equal(body.getAttribute("data-drawer"), "open");
    assert.equal(
      body.getAttribute("data-sidebar"),
      null,
      "the drawer's switch never touches the wide layout's attribute",
    );

    toggle.fire("click");
    assert.equal(body.getAttribute("data-drawer"), "closed");
  });
});

test("the phone's switches trade the drawer's contents", async () => {
  withSession({ hash: "#/doc/index.md", drawer: true }, (session) => {
    startSession();

    const body = session.doc.body;
    const drawer = session.shell.get("sidebar-toggle");
    const outline = session.shell.get("outline-toggle");

    assert.equal(body.getAttribute("data-drawer"), "closed");

    outline.fire("click");
    assert.equal(
      body.getAttribute("data-drawer"),
      "open",
      "the outline's switch opens the drawer with the outline in it",
    );
    assert.equal(body.getAttribute("data-side-view"), "outline");
    assert.equal(
      body.getAttribute("data-sidebar"),
      null,
      "the drawer's switches never touch the wide layout's attribute",
    );

    drawer.fire("click");
    assert.equal(
      body.getAttribute("data-side-view"),
      "docs",
      "the drawer's toggle trades the outline for the list without closing",
    );
    assert.equal(body.getAttribute("data-drawer"), "open");

    drawer.fire("click");
    assert.equal(
      body.getAttribute("data-drawer"),
      "closed",
      "the toggle pressed again closes the drawer it opened",
    );

    outline.fire("click");
    assert.equal(body.getAttribute("data-drawer"), "open");
    assert.equal(body.getAttribute("data-side-view"), "outline");
  });
});

test("putting the list away writes the choice down", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const toggle = session.shell.get("sidebar-collapse");
    toggle.fire("click");
    assert.equal(session.storage["wikicc.sidebar"], "hidden");

    toggle.fire("click");
    assert.equal(session.storage["wikicc.sidebar"], "visible");
  });
});

test("the reader remembers the list was put away", async () => {
  withSession(
    { hash: "#/doc/index.md", storage: { "wikicc.sidebar": "hidden" } },
    (session) => {
      startSession();

      assert.equal(
        session.doc.body.getAttribute("data-sidebar"),
        "hidden",
        "the stored choice is applied when the session starts",
      );
      assert.equal(
        session.shell.get("sidebar-collapse").getAttribute("aria-expanded"),
        "false",
      );
    },
  );
});

test("the outline switch trades the list for the outline", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const outline = session.shell.get("outline-toggle");
    const collapse = session.shell.get("sidebar-collapse");

    assert.equal(
      body.getAttribute("data-side-view"),
      "docs",
      "the list is the view a page starts with",
    );
    assert.equal(outline.getAttribute("aria-expanded"), "false");
    assert.equal(outline.getAttribute("aria-label"), "Show outline panel");

    outline.fire("click");
    assert.equal(body.getAttribute("data-side-view"), "outline");
    assert.equal(
      body.getAttribute("data-sidebar"),
      null,
      "bringing the outline up never folds the column",
    );
    assert.equal(
      outline.getAttribute("aria-expanded"),
      "true",
      "the switch answers for the view it brought up",
    );
    assert.equal(outline.getAttribute("aria-label"), "Hide outline panel");
    assert.equal(
      collapse.getAttribute("aria-expanded"),
      "false",
      "the list's own switch now offers the list back",
    );
    assert.equal(collapse.getAttribute("aria-label"), "Show document list");

    outline.fire("click");
    assert.equal(
      body.getAttribute("data-sidebar"),
      "hidden",
      "the switch pressed again folds the whole column",
    );
    assert.equal(
      body.getAttribute("data-side-view"),
      "outline",
      "the view the reader chose is remembered while the column is away",
    );
    assert.equal(outline.getAttribute("aria-expanded"), "false");
    assert.equal(outline.getAttribute("aria-label"), "Show outline panel");

    outline.fire("click");
    assert.equal(body.getAttribute("data-sidebar"), null);
    assert.equal(
      body.getAttribute("data-side-view"),
      "outline",
      "the column comes back with the view it was folded in",
    );

    collapse.fire("click");
    assert.equal(
      body.getAttribute("data-side-view"),
      "docs",
      "the list's switch trades the outline for the list",
    );
    assert.equal(body.getAttribute("data-sidebar"), null);
    assert.equal(collapse.getAttribute("aria-expanded"), "true");
    assert.equal(collapse.getAttribute("aria-label"), "Hide document list");
    assert.equal(
      outline.getAttribute("aria-expanded"),
      "false",
      "the two switches never answer for the same view at once",
    );
  });
});

test("the side switches write their choices down", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const outline = session.shell.get("outline-toggle");
    const collapse = session.shell.get("sidebar-collapse");

    outline.fire("click");
    assert.equal(session.storage["wikicc.side-view"], "outline");

    outline.fire("click");
    assert.equal(
      session.storage["wikicc.sidebar"],
      "hidden",
      "folding the column is the sidebar's own choice, written where it always was",
    );
    assert.equal(
      session.storage["wikicc.side-view"],
      "outline",
      "the view survives the fold",
    );

    collapse.fire("click");
    assert.equal(session.storage["wikicc.side-view"], "docs");
    assert.equal(session.storage["wikicc.sidebar"], "visible");
  });
});

test("the reader remembers which side view was showing", async () => {
  withSession(
    { hash: "#/doc/index.md", storage: { "wikicc.side-view": "outline" } },
    (session) => {
      startSession();

      assert.equal(
        session.doc.body.getAttribute("data-side-view"),
        "outline",
        "the stored view is applied when the session starts",
      );
      assert.equal(
        session.shell.get("outline-toggle").getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(
        session.shell.get("sidebar-collapse").getAttribute("aria-expanded"),
        "false",
      );
    },
  );
});

test("the graph starts folded away and its switches say so", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const local = session.shell.get("graph-local-toggle");
    const global = session.shell.get("graph-global-toggle");
    const outline = session.shell.get("outline-toggle");

    // The floating window waits for a switch: the local view is the one
    // selected, but nothing shows until the reader asks for it.
    assert.equal(body.getAttribute("data-graph-view"), "local");
    assert.equal(body.getAttribute("data-graph"), "hidden");
    assert.equal(local.getAttribute("aria-expanded"), "false");
    assert.equal(local.getAttribute("aria-label"), "Show local graph");
    assert.equal(global.getAttribute("aria-expanded"), "false");
    assert.equal(global.getAttribute("aria-label"), "Show global graph");
    assert.equal(
      outline.getAttribute("aria-label"),
      "Show outline panel",
      "the side switches keep their own answer",
    );
  });
});

test("the graph's switches trade the views and fold the column", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const local = session.shell.get("graph-local-toggle");
    const global = session.shell.get("graph-global-toggle");

    // The other switch brings its view up and puts the first one away.
    global.fire("click");
    assert.equal(body.getAttribute("data-graph-view"), "global");
    assert.equal(body.getAttribute("data-graph"), null);
    assert.equal(global.getAttribute("aria-expanded"), "true");
    assert.equal(global.getAttribute("aria-label"), "Hide global graph");
    assert.equal(local.getAttribute("aria-expanded"), "false");
    assert.equal(local.getAttribute("aria-label"), "Show local graph");
    assert.equal(
      body.getAttribute("data-side-view"),
      "docs",
      "the graph's switches never touch the sidebar's view",
    );

    // The switch whose view is showing puts the column away.
    global.fire("click");
    assert.equal(body.getAttribute("data-graph"), "hidden");
    assert.equal(body.getAttribute("data-graph-view"), "global");
    assert.equal(global.getAttribute("aria-expanded"), "false");
    assert.equal(global.getAttribute("aria-label"), "Show global graph");
    assert.equal(local.getAttribute("aria-expanded"), "false");

    // A switch of the folded column brings its own view back.
    local.fire("click");
    assert.equal(body.getAttribute("data-graph"), null);
    assert.equal(body.getAttribute("data-graph-view"), "local");
    assert.equal(local.getAttribute("aria-expanded"), "true");
    assert.equal(local.getAttribute("aria-label"), "Hide local graph");

    // And its own switch folds it again.
    local.fire("click");
    assert.equal(body.getAttribute("data-graph"), "hidden");
    assert.equal(local.getAttribute("aria-expanded"), "false");
  });
});

test("the graph's switches keep no record of the fold", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    session.shell.get("graph-global-toggle").fire("click");
    session.shell.get("graph-global-toggle").fire("click");

    assert.equal(
      session.storage["wikicc.panels"],
      undefined,
      "no storage key is written for the graph's state",
    );
    assert.equal(
      session.doc.body.getAttribute("data-graph"),
      "hidden",
      "the fold holds for this visit only",
    );
  });
});

test("a press outside the graph's window folds it", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const local = session.shell.get("graph-local-toggle");
    const global = session.shell.get("graph-global-toggle");

    local.fire("click");
    assert.equal(body.getAttribute("data-graph"), null);

    // The article sits nowhere near the floating window, so a press there is
    // the reader moving on: the press is what folds the window, and the
    // switches follow the fold they did not drive.
    session.doc.fireEvent("pointerdown", {
      target: session.shell.get("doc-article"),
    });

    assert.equal(body.getAttribute("data-graph"), "hidden");
    assert.equal(
      body.getAttribute("data-graph-view"),
      "local",
      "the selected view stays selected while the window is away",
    );
    assert.equal(local.getAttribute("aria-expanded"), "false");
    assert.equal(local.getAttribute("aria-label"), "Show local graph");
    assert.equal(global.getAttribute("aria-expanded"), "false");
    assert.equal(global.getAttribute("aria-label"), "Show global graph");
  });
});

test("a press inside the graph's window is the window's own", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const local = session.shell.get("graph-local-toggle");
    const inspector = session.shell.get("inspector");

    local.fire("click");

    // A press on something the window carries — a control of its header, a
    // node of the graph — is the graph's own gesture, not a press outside
    // the window, and it must not fold what the reader is using.
    const inside = createFakeElement("button");
    inspector.appendChild(inside);
    session.doc.fireEvent("pointerdown", { target: inside });

    assert.equal(body.getAttribute("data-graph"), null, "the window stays up");
    assert.equal(local.getAttribute("aria-expanded"), "true");
  });
});

test("a press on a graph switch is left to the switch's own click", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const local = session.shell.get("graph-local-toggle");

    local.fire("click");
    assert.equal(body.getAttribute("data-graph"), null);

    // Folding on the press would race the switch's own click, which would
    // then find a folded window and bring it straight back.
    session.doc.fireEvent("pointerdown", { target: local });
    assert.equal(
      body.getAttribute("data-graph"),
      null,
      "the press alone does nothing",
    );

    local.fire("click");
    assert.equal(
      body.getAttribute("data-graph"),
      "hidden",
      "the click folds it",
    );
  });
});

test("a press outside changes nothing while the window is folded", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;

    // The session starts with the window folded away; a press outside it is
    // one the folded window never sees.
    session.doc.fireEvent("pointerdown", {
      target: session.shell.get("doc-article"),
    });

    assert.equal(body.getAttribute("data-graph"), "hidden");
    assert.equal(
      session.shell.get("graph-local-toggle").getAttribute("aria-expanded"),
      "false",
    );
  });
});

test("the global view's window folds on a press outside it too", async () => {
  withSession({ hash: "#/doc/index.md" }, (session) => {
    startSession();

    const body = session.doc.body;
    const global = session.shell.get("graph-global-toggle");

    global.fire("click");
    assert.equal(body.getAttribute("data-graph"), null);

    session.doc.fireEvent("pointerdown", {
      target: session.shell.get("doc-article"),
    });

    assert.equal(body.getAttribute("data-graph"), "hidden");
    assert.equal(
      body.getAttribute("data-graph-view"),
      "global",
      "the view stays selected",
    );
    assert.equal(global.getAttribute("aria-expanded"), "false");
    assert.equal(global.getAttribute("aria-label"), "Show global graph");
  });
});
