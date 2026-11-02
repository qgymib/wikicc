/**
 * The banner shown when a block reference names a chapter a document does not
 * have.
 *
 * Such a reference is still a valid link to its document, so the reader opens
 * the document from the top and explains *why* it did not jump. The message is
 * a banner rather than a paragraph: it sits above the document, is as wide as
 * the article, goes away on its own and can be dismissed from the button on its
 * right.
 *
 * Only a *navigation* raises it. Hovering the same reference is answered by the
 * preview panel's notice (`preview-view.js`), which is a hint about the link
 * under the pointer rather than an explanation of where the reader just went.
 *
 * The banner never competes with the document for space. The element is
 * inserted once, when the reader starts, and is only toggled afterwards, so
 * showing and hiding it cannot reflow the page: `[hidden]` removes it from the
 * layout entirely and the stylesheet slides it in as an overlay.
 *
 * Timeouts are delegated to an injected `setTimeout`/`clearTimeout` pair so the
 * countdown is testable without waiting, and the DOM is touched only through
 * the `document` passed in.
 */
import { BANNER_TIMEOUT_MS } from "./banner-config.js";

/** Class of the banner root. */
export var BANNER_CLASS = "doc-alert";

/** Class of the dismiss button. */
export var CLOSE_CLASS = "doc-alert-close";

/** Attribute marking the banner as visible, used by the stylesheet. */
export var OPEN_ATTRIBUTE = "data-open";

/** How long the banner stays on screen unless dismissed first. */
export { BANNER_TIMEOUT_MS };

/** Prefix of the message, so the wording has one home. */
var MESSAGE_LEAD = "Chapter not found in ";
/** Separator between the document path and the chapter. */
var MESSAGE_SEPARATOR = ": ";

/**
 * Create the banner controller.
 *
 * `container` is the element the banner is appended to when `host` is absent —
 * the reader's content column, so its width is the article's width. `host` is
 * the banner slot the page template already carries; reusing it keeps the
 * element in the document from the first paint, so showing a message never
 * inserts anything and never reflows the article.
 *
 * `timeoutMs` overrides [`BANNER_TIMEOUT_MS`]; `document` and `timers` exist
 * for tests.
 */
export function createBanner(options) {
  var container = options.container;
  var host = options.host || null;
  var doc = options.document || globalThis.document;
  var timers = options.timers || globalThis;
  var timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : BANNER_TIMEOUT_MS;

  var timer = 0;
  var root = null;
  var text = null;
  var path = null;
  var chapter = null;
  var close = null;

  /** Build the banner once; every later call only fills it in. */
  function ensure() {
    if (root) {
      return root;
    }

    root = host || doc.createElement("div");
    root.className = BANNER_CLASS;
    // `status` rather than `alert`: the message explains a navigation the
    // reader just made, so it must not interrupt what a screen reader is
    // already saying.
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-hidden", "true");
    root.hidden = true;

    // A slot from the page template is already in `container`, so swapping the
    // article must put it back; a banner built here is appended once, below.
    if (host && container && typeof container.appendChild === "function") {
      container.appendChild(host);
    }

    var icon = doc.createElement("span");
    icon.className = "doc-alert-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.appendChild(iconSvg(doc));

    text = doc.createElement("p");
    text.className = "doc-alert-text";
    text.appendChild(doc.createTextNode(MESSAGE_LEAD));

    // The two facts are their own elements, filled with `textContent`: a
    // document path and a heading may both contain markup characters.
    path = doc.createElement("code");
    path.className = "doc-alert-code";
    chapter = doc.createElement("code");
    chapter.className = "doc-alert-code";

    text.appendChild(path);
    text.appendChild(doc.createTextNode(MESSAGE_SEPARATOR));
    text.appendChild(chapter);

    close = doc.createElement("button");
    close.className = CLOSE_CLASS;
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", "Dismiss");
    close.setAttribute("title", "Dismiss");
    close.appendChild(closeSvg(doc));
    close.addEventListener("click", onCloseClick);

    root.appendChild(icon);
    root.appendChild(text);
    root.appendChild(close);

    // A slot from the page template is already attached; a banner built here
    // has to be placed, once, so later messages only toggle it.
    if (!host && container && typeof container.appendChild === "function") {
      container.appendChild(root);
    }

    return root;
  }

  /** A small warning triangle, drawn inline so the page loads nothing. */
  function iconSvg(parent) {
    var svg = parent.createElementNS
      ? parent.createElementNS("http://www.w3.org/2000/svg", "svg")
      : parent.createElement("svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.appendChild(svgPath(parent, "M12 4 2.5 20h19L12 4Z"));
    svg.appendChild(svgPath(parent, "M12 10v4"));
    svg.appendChild(svgPath(parent, "M12 17.2v.1"));

    return svg;
  }

  /** The dismiss cross. */
  function closeSvg(parent) {
    var svg = parent.createElementNS
      ? parent.createElementNS("http://www.w3.org/2000/svg", "svg")
      : parent.createElement("svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.appendChild(svgPath(parent, "M6 6l12 12"));
    svg.appendChild(svgPath(parent, "M18 6 6 18"));

    return svg;
  }

  function svgPath(parent, data) {
    var element = parent.createElementNS
      ? parent.createElementNS("http://www.w3.org/2000/svg", "path")
      : parent.createElement("path");
    element.setAttribute("d", data);

    return element;
  }

  function clearTimer() {
    if (timer) {
      timers.clearTimeout(timer);
      timer = 0;
    }
  }

  function onCloseClick(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (event && typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
    hide();
  }

  /**
   * Show `message` — `{ docId, anchor }` — and start its countdown.
   *
   * A second message reuses the same banner and restarts the countdown, so
   * repeated broken references cannot stack messages or leave a stale one on
   * screen.
   */
  function show(message) {
    var details = message || {};

    ensure();
    clearTimer();

    path.textContent = details.docId ? String(details.docId) : "";
    chapter.textContent = details.anchor ? String(details.anchor) : "";

    root.hidden = false;
    root.removeAttribute("aria-hidden");
    root.setAttribute(OPEN_ATTRIBUTE, "true");
    timer = timers.setTimeout(onTimeout, timeoutMs);

    return root;
  }

  function onTimeout() {
    timer = 0;
    hide();
  }

  /** Hide the banner and stop the countdown; safe to call at any time. */
  function hide() {
    clearTimer();

    if (!root) {
      return;
    }

    if (root.hidden) {
      return;
    }

    root.hidden = true;
    root.removeAttribute(OPEN_ATTRIBUTE);
    root.setAttribute("aria-hidden", "true");
  }

  /** Drop the banner and its timer, for a reader that tears itself down. */
  function dispose() {
    clearTimer();

    if (close) {
      close.removeEventListener("click", onCloseClick);
    }
    if (root && root.parentNode) {
      root.parentNode.removeChild(root);
    }

    root = null;
    text = null;
    path = null;
    chapter = null;
    close = null;
  }

  // Built on creation, not on first use: the banner is toggled only, so a
  // document can never be reflowed by a message appearing or going away.
  if (container || host) {
    ensure();
  }

  return {
    show: show,
    hide: hide,
    dispose: dispose,
    /** The banner element, so the reader can leave it in place while it swaps documents. */
    element: function () {
      return root;
    },
    /** Whether the banner is on screen, for tests and for `app.js`. */
    isOpen: function () {
      return !!root && !root.hidden;
    },
  };
}
