/**
 * Tests for `src/web/js/asset-links.js`: taking over the clicks of links
 * whose `href` is a `data:` URI.
 *
 * The single-file build inlines every asset as a `data:` URI. A browser
 * refuses to *navigate* the top frame to one (Chromium has since version 60),
 * so a link to an inlined PDF dies silently — the address bar shows
 * `about:blank#blocked` and nothing opens. The reader takes such clicks over:
 * the data URI is decoded into a Blob synchronously, inside the click's user
 * gesture, and a `blob:` URL — whose top-frame navigation is allowed — opens in
 * a new tab where the browser's own viewer shows the file.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  dataUriToBlob,
  handleInlineDataClick,
  isInlineDataUri,
  parseDataUri,
} from "../../src/web/js/asset-links.js";

/** An anchor stand-in that only answers for its `href`. */
function anchorStub(href) {
  return {
    getAttribute(name) {
      return name === "href" ? href : null;
    },
  };
}

/** A click event stand-in over `anchor`, with a preventDefault counter. */
function clickEvent(anchor, options) {
  var settings = options || {};
  var state = { prevented: 0 };
  var event = {
    type: settings.type || "click",
    button: settings.button === undefined ? 0 : settings.button,
    ctrlKey: !!settings.ctrlKey,
    target: {
      closest(selector) {
        return selector === "a[href]" ? anchor : null;
      },
    },
    preventDefault() {
      state.prevented += 1;
    },
  };
  return { event, state };
}

/** Dependency stand-ins recording what the handler did with the blob. */
function recordingDeps(blobUrl) {
  var calls = { blob: null, opened: [] };
  return {
    calls,
    deps: {
      createBlobUrl(blob) {
        calls.blob = blob;
        return blobUrl;
      },
      open(url, target) {
        calls.opened.push([url, target]);
        return null;
      },
    },
  };
}

test("only a data: href is an inlined link", () => {
  assert.equal(isInlineDataUri("data:application/pdf;base64,AAAA"), true);
  assert.equal(isInlineDataUri("DATA:text/plain,hello"), true);
  assert.equal(isInlineDataUri("data:,hello"), true);

  for (const href of [
    "#/doc/notes.md",
    "https://example.com/manual.pdf",
    "manual.pdf",
    "assets/1f0c.svg",
    "mailto:reader@example.com",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isInlineDataUri(href), false, `href: ${String(href)}`);
  }
});

test("a base64 data uri splits into mime, encoding and payload", () => {
  assert.deepEqual(parseDataUri("data:application/pdf;base64,aGVsbG8="), {
    mime: "application/pdf",
    isBase64: true,
    payload: "aGVsbG8=",
  });
});

test("a data uri without a mime defaults to plain text", () => {
  assert.deepEqual(parseDataUri("data:,hello"), {
    mime: "text/plain",
    isBase64: false,
    payload: "hello",
  });
});

test("a base64 flag without a mime is recognised", () => {
  assert.deepEqual(parseDataUri("data:;base64,aGVsbG8="), {
    mime: "text/plain",
    isBase64: true,
    payload: "aGVsbG8=",
  });
});

test("anything without a comma separating meta from payload is rejected", () => {
  for (const href of ["data:application/pdf", "data:", "data:;base64"]) {
    assert.equal(parseDataUri(href), null, `href: ${href}`);
  }
  assert.equal(parseDataUri("https://example.com"), null);
  assert.equal(parseDataUri(null), null);
});

test("base64 bytes survive the round trip, including multibyte text", async () => {
  const pdf = await dataUriToBlob("data:application/pdf;base64,aGVsbG8=");
  assert.ok(pdf instanceof Blob, "a Blob is built");
  assert.equal(pdf.type, "application/pdf");
  assert.equal(await pdf.text(), "hello");

  const chinese = await dataUriToBlob("data:text/plain;base64,5L2g5aW9");
  assert.equal(await chinese.text(), "你好", "UTF-8 bytes stay intact");
});

test("a url-encoded text payload decodes to its text", async () => {
  const blob = await dataUriToBlob("data:text/plain,hello%20there");
  assert.equal(blob.type, "text/plain");
  assert.equal(await blob.text(), "hello there");
});

test("an undecodable payload declines instead of throwing", () => {
  assert.equal(dataUriToBlob("data:application/pdf;base64,!!!"), null);
  assert.equal(dataUriToBlob("data:application/pdf"), null);
  assert.equal(dataUriToBlob("https://example.com/manual.pdf"), null);
});

test("a click on a data link opens a blob url in a new tab", () => {
  const anchor = anchorStub("data:application/pdf;base64,aGVsbG8=");
  const { event, state } = clickEvent(anchor);
  const { calls, deps } = recordingDeps("blob:reader/1");

  assert.equal(
    handleInlineDataClick(event, deps),
    true,
    "the click is taken over",
  );
  assert.equal(
    state.prevented,
    1,
    "the browser's blocked navigation is cancelled",
  );
  assert.equal(
    calls.blob instanceof Blob,
    true,
    "the decoded bytes reach the deps",
  );
  assert.deepEqual(calls.opened, [["blob:reader/1", "_blank"]]);
});

test("a modified click is taken over too", () => {
  // The browser's own answers are all broken for a data: href — plain,
  // ctrl-, shift- and middle-clicks alike end in a refused navigation — so
  // the reader claims every button variant and opens the blob itself.
  const anchor = anchorStub("data:application/pdf;base64,aGVsbG8=");
  for (const settings of [{ ctrlKey: true }, { shiftKey: true }, {}]) {
    const { event, state } = clickEvent(anchor, settings);
    const { calls, deps } = recordingDeps("blob:reader/2");

    assert.equal(
      handleInlineDataClick(event, deps),
      true,
      `settings: ${JSON.stringify(settings)}`,
    );
    assert.equal(state.prevented, 1);
    assert.equal(calls.opened.length, 1);
  }
});

test("a middle click is taken over, a right click is not", () => {
  const anchor = anchorStub("data:application/pdf;base64,aGVsbG8=");

  const middle = clickEvent(anchor, { type: "auxclick", button: 1 });
  const { calls, deps } = recordingDeps("blob:reader/3");
  assert.equal(handleInlineDataClick(middle.event, deps), true);
  assert.equal(middle.state.prevented, 1);
  assert.equal(calls.opened.length, 1);

  const right = clickEvent(anchor, { type: "auxclick", button: 2 });
  assert.equal(handleInlineDataClick(right.event, deps), false);
  assert.equal(right.state.prevented, 0, "the context menu keeps the event");
  assert.equal(calls.opened.length, 1, "no second open happened");
});

test("a link that is not inlined stays with the browser and the router", () => {
  for (const href of [
    "#/doc/notes.md",
    "https://example.com/manual.pdf",
    "manual.pdf",
  ]) {
    const anchor = anchorStub(href);
    const { event, state } = clickEvent(anchor);
    const { calls, deps } = recordingDeps("blob:reader/4");

    assert.equal(handleInlineDataClick(event, deps), false, `href: ${href}`);
    assert.equal(state.prevented, 0, `href: ${href}`);
    assert.equal(calls.opened.length, 0, `href: ${href}`);
  }
});

test("a click outside any link is untouched", () => {
  const { event, state } = clickEvent(null);
  const { deps } = recordingDeps("blob:reader/5");

  assert.equal(handleInlineDataClick(event, deps), false);
  assert.equal(state.prevented, 0);
});

test("an undecodable payload leaves the event alone", () => {
  const anchor = anchorStub("data:application/pdf;base64,!!!");
  const { event, state } = clickEvent(anchor);
  const { calls, deps } = recordingDeps("blob:reader/6");

  assert.equal(handleInlineDataClick(event, deps), false);
  assert.equal(state.prevented, 0, "the browser keeps its default behaviour");
  assert.equal(calls.opened.length, 0);
});

test("an anchor without an href is untouched", () => {
  const anchor = anchorStub(null);
  const { event, state } = clickEvent(anchor);
  const { deps } = recordingDeps("blob:reader/7");

  assert.equal(handleInlineDataClick(event, deps), false);
  assert.equal(state.prevented, 0);
});
