/**
 * Taking over the clicks of links whose destination is a `data:` URI.
 *
 * The single-file build inlines every asset — a chapter's PDF, an archive,
 * anything that is not an image — as a `data:` URI in the `href` of an
 * ordinary `<a>`. A browser refuses to *navigate* the top frame to a `data:`
 * URL (Chromium since version 60): the click dies, the address bar ends up
 * at `about:blank#blocked`, and the reader sees nothing. Images are
 * untouched — an `<img src="data:…">` is a resource load, not a navigation —
 * so this is only about links.
 *
 * The fix does what the browser refuses to do by other means, entirely
 * inside the click's user gesture: decode the data URI into a `Blob`
 * synchronously, hand it to `URL.createObjectURL`, and open the resulting
 * `blob:` URL in a new tab. A `blob:` URL's top-frame navigation is allowed,
 * and a PDF opens in the browser's own viewer, so the reader keeps its page.
 *
 * Synchronous is the point: `open` called after an `await` — say,
 * `fetch(href).then(...)` for the bytes — has lost the gesture and is
 * treated as a popup. Decoding is one `atob` pass over the payload, at most
 * a few hundred milliseconds for a large attachment, and the copies become
 * garbage the moment the open returns.
 *
 * Recognition and conversion are pure; the effects (`createObjectURL`,
 * `open`) arrive as `deps`, so `node --test` can observe the handover
 * without a DOM. Registration lives in `app.js`, which owns the page's
 * listeners.
 */

/** Selector matching any anchor that carries an `href`. */
export var INLINE_LINK_SELECTOR = "a[href]";

/** Whether `href` addresses an inlined `data:` resource. */
export function isInlineDataUri(href) {
  return typeof href === "string" && /^data:/i.test(href);
}

/**
 * Split a data URI into its MIME type, encoding and payload.
 *
 * Returns `null` for anything without the `data:`/`,` shape. A missing media
 * type is the RFC's `text/plain`; the `;base64` flag is recognised where it
 * ends the header, as the build and every mainstream encoder write it.
 */
export function parseDataUri(href) {
  if (typeof href !== "string") {
    return null;
  }

  var match = /^data:([^,]*),([\s\S]*)$/i.exec(href);
  if (!match) {
    return null;
  }

  var header = match[1];
  var isBase64 = /;base64$/i.test(header);
  var mime = isBase64 ? header.slice(0, -";base64".length) : header;

  return {
    mime: mime || "text/plain",
    isBase64: isBase64,
    payload: match[2],
  };
}

/**
 * Decode a data URI into a Blob holding the original bytes.
 *
 * A base64 payload goes through `atob`; a text payload is percent-decoded,
 * keeping the raw spelling when it is not valid escaping. Any failure — an
 * unparseable URI, malformed base64, an environment without `Blob` — returns
 * `null` instead of throwing, so the caller can leave the event to the
 * browser.
 */
export function dataUriToBlob(href) {
  var parsed = parseDataUri(href);
  if (!parsed || typeof Blob !== "function") {
    return null;
  }

  if (parsed.isBase64) {
    var bytes = base64Bytes(parsed.payload);
    return bytes ? new Blob([bytes], { type: parsed.mime }) : null;
  }

  var text;
  try {
    text = decodeURIComponent(parsed.payload);
  } catch (_error) {
    text = parsed.payload;
  }
  return new Blob([text], { type: parsed.mime });
}

/** UTF-8 byte array of `payload`, or `null` when it is not valid base64. */
function base64Bytes(payload) {
  try {
    var binary = atob(payload);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (_error) {
    return null;
  }
}

/**
 * Answer a click on an inlined link by opening its bytes in a new tab.
 *
 * Returns whether the click was taken over; `false` means the event is
 * untouched and stays with the browser, or with the reader's own routing of
 * document links.
 *
 * A right click never claims anything: the context menu is the browser's and
 * it still works on a `data:` link. A middle click and every left-click
 * variant — modifier combos included — are taken over, because the browser's
 * own answer to each of them for a `data:` URL is the same refused
 * navigation. The default is cancelled only after the blob exists: a click
 * the reader cannot serve is a click it does not swallow.
 */
export function handleInlineDataClick(event, deps) {
  if (!event || !deps) {
    return false;
  }
  if (event.type === "auxclick" && event.button !== 1) {
    return false;
  }

  var target = event.target;
  if (!target || typeof target.closest !== "function") {
    return false;
  }

  var anchor = target.closest(INLINE_LINK_SELECTOR);
  if (!anchor) {
    return false;
  }

  var blob = dataUriToBlob(anchor.getAttribute("href"));
  if (!blob) {
    return false;
  }

  var url = deps.createBlobUrl(blob);
  if (!url) {
    return false;
  }

  deps.open(url, "_blank");
  event.preventDefault();
  return true;
}

/**
 * Listen on `doc` for the clicks of inlined links.
 *
 * One delegated pair covers every body the reader renders — the article, the
 * hover preview and the search preview — wherever those are inserted.
 * `deps` defaults to the page's own `URL.createObjectURL` and `open`; the
 * tests pass their own recording pair instead.
 */
export function listenForInlineDataLinks(doc, deps) {
  if (!doc || typeof doc.addEventListener !== "function") {
    return;
  }

  var effects = deps || {
    createBlobUrl(blob) {
      return URL.createObjectURL(blob);
    },
    open(url, target) {
      return globalThis.open(url, target);
    },
  };

  doc.addEventListener("click", function (event) {
    handleInlineDataClick(event, effects);
  });
  doc.addEventListener("auxclick", function (event) {
    handleInlineDataClick(event, effects);
  });
}
