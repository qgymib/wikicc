/**
 * The body of one document, shared by every surface that shows a whole one.
 *
 * A document's markup reaches the page in three places — the article column
 * (`app.js`), the search dialog's full-text preview (`search-view.js`) and the
 * hover preview of a block reference (`preview-view.js`) — and all three do
 * the same two-step dance with it. This module is that dance, written once:
 *
 * - the markup goes into an element *before* the element is on screen, and
 *   the enhancements inside it — the tables' sort and filter controls, the
 *   chapters' collapse arrows — are applied in the same breath, so the first
 *   paint already carries them;
 * - the diagrams are drawn only *after* the element is in the document,
 *   because the engine measures its labels with the layout, which a detached
 *   subtree does not have. The math is typeset in the same step: its engine
 *   needs no layout, but one shared insertion-time contract keeps the three
 *   callers symmetrical.
 *
 * Which enhancements a body gets is the caller's declaration, not this
 * module's guess: the article enhances both, the hover preview enhances the
 * tables and folds nothing, and the search preview deliberately enhances
 * neither — the filter panel its buttons open is parented to `document.body`,
 * outside the dialog, which the search panel would read as a press outside
 * itself, and a collapse arrow inside the dialog would answer a click that is
 * already the list's. The options keep those decisions where they belong, at
 * the call site, instead of hiding special cases in here.
 *
 * Insertion itself stays with the caller — the article replaces a column,
 * the search preview appends under a banner, the hover preview refills a
 * body it keeps for its whole session — because a shared insert would be a
 * callback-shaped API for three lines apiece.
 */
import * as TableView from "./table-view.js";
import * as DiagramView from "./diagram-view.js";
import * as MathView from "./math-view.js";

/** Class every document body carries; the stylesheet keys the typography off it. */
export var BODY_CLASS = "doc-body";

/** Class added to a body whose chapters can be folded away. */
export var COLLAPSIBLE_CLASS = "chapter-collapsible";

/** Class of the arrow that folds one chapter, and the attribute the DOM uses. */
export var TOGGLE_CLASS = "chapter-toggle";

/** Heading tags a chapter can be carried by, in document order. */
var HEADING_TAGS = ["H1", "H2", "H3", "H4", "H5", "H6"];

/** Selector for those headings; the DOM layer queries with it. */
var HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

/**
 * The arrow's outline, as a path of an SVG in a 24-unit box.
 *
 * It is a chevron pointing at the right, which the stylesheet rotates a
 * quarter turn when the chapter is open, so one shape serves both states
 * instead of two glyphs that could drift apart.
 */
var CHEVRON_PATH = "M9 5l7 7-7 7";

/**
 * Ranges a heading owns, as `[start, end)` over `levels`.
 *
 * A range runs up to the next heading of the same or a higher level, which is
 * what "the whole chapter" means: everything nested below the heading is
 * inside its range, and the following sibling — however deep — is not. The
 * input is the level of every heading in document order, over all the
 * headings of the document at once, so one pass answers for every depth.
 *
 * Returns one entry per heading, in the same order. A range always holds its
 * own heading, so the last one is never empty.
 */
export function chapterRanges(levels) {
  var ranges = [];

  if (!Array.isArray(levels)) {
    return ranges;
  }

  for (var index = 0; index < levels.length; index += 1) {
    ranges.push({ start: index, end: index + 1 });
  }

  for (var start = 0; start < levels.length; start += 1) {
    var level = levels[start];

    var end = levels.length;
    for (var next = start + 1; next < levels.length; next += 1) {
      if (levels[next] <= level) {
        end = next;
        break;
      }
    }
    ranges[start].end = end;
  }

  return ranges;
}

/**
 * Add the fold arrows to the chapters of `body`.
 *
 * Every heading the body itself carries that owns something gets a button as
 * its *first* child — inside the heading, ahead of its text. The arrow is the
 * heading's own, so the stylesheet reveals it from the heading's hover with
 * one descendant selector, and hover follows the DOM tree rather than the
 * geometry: a pointer that moves from the heading onto the arrow is still
 * hovering the heading, which is what keeps the arrow reachable instead of
 * fading away under the pointer. The chapter's own elements are remembered as
 * index ranges into the body, so folding one is a walk over its own range and
 * nothing else: no wrapper element, no re-query, no listener on the page.
 *
 * Folding hides the elements with the `hidden` attribute rather than by
 * moving them: the heading, its type, its rule and its spacing therefore look
 * exactly as they do when the chapter is open, and the payoff is the arrow
 * alone. A heading hidden inside another chapter stays folded where it is, so
 * reopening the outer one puts the document back as it was.
 *
 * The state lives in the DOM alone — `aria-expanded` on the button,
 * `hidden` on the chapter — so a body rebuilt for another document starts
 * fully open, which is what a reading session wants.
 *
 * Chapters are taken from the DOM, not from the payload's outline: a heading
 * an author wrote as raw HTML is a chapter a reader can see, and this is the
 * module that sees the rendered document.
 */
export function enhanceChapters(body) {
  if (!body || typeof body.querySelectorAll !== "function") {
    return [];
  }

  var chapters = chaptersOf(body);
  if (!chapters.length) {
    return [];
  }

  chapters.forEach(function (chapter) {
    var doc = chapter.heading.ownerDocument || globalThis.document;
    chapter.button = createToggle(doc);
    chapter.heading.insertBefore(chapter.button, chapter.heading.firstChild);
  });

  body.classList.add(COLLAPSIBLE_CLASS);

  body.addEventListener("click", function (event) {
    var button = toggleOf(event);
    if (!button) {
      return;
    }

    for (var index = 0; index < chapters.length; index += 1) {
      if (chapters[index].button === button) {
        fold(body, chapters[index], button);
        return;
      }
    }
  });

  return chapters;
}

/**
 * The chapters of `body`'s own headings, described by what they contain.
 *
 * A chapter is a heading the body carries directly — one wrapped in a list or
 * a quote is not a chapter the body can fold — and it owns every sibling
 * after it up to the heading that opens the next chapter of the same or a
 * higher level, which is its own paragraphs, the headings below it and the
 * content trailing the deepest of those alike.
 *
 * A heading gets an arrow when its chapter holds at least one element beyond
 * the heading itself. The rule is the heading's own, read off the body's
 * children — never its level's: an empty section and a document that ends on
 * a heading get no arrow, because folding them would hide nothing, and one
 * foldable heading does not hand arrows to the empty ones beside it. The
 * heading that ends a chapter is the next one the body itself carries, so a
 * heading nested inside a quote or a list never ends one: the fold hides the
 * element that holds it together with it.
 */
function chaptersOf(body) {
  var headings = Array.prototype.filter.call(
    body.querySelectorAll(HEADING_SELECTOR),
    function (heading) {
      return HEADING_TAGS.indexOf(heading.tagName) !== -1;
    },
  );

  var levels = headings.map(function (heading) {
    return Number(heading.tagName.slice(1));
  });
  var ranges = chapterRanges(levels);
  var children = body.children ? Array.prototype.slice.call(body.children) : [];

  var chapters = [];

  headings.forEach(function (heading, index) {
    var begin = children.indexOf(heading);
    if (begin < 0) {
      return;
    }

    // The first heading of the same or a higher level ends the chapter — but
    // only the body's own headings end it, so the search starts where the
    // level model says and walks until one is a child of the body itself.
    var stop = children.length;
    for (var next = ranges[index].end; next < headings.length; next += 1) {
      var candidate = children.indexOf(headings[next]);
      if (candidate >= 0) {
        stop = candidate;
        break;
      }
    }

    // The chapter is the range between its heading and the one that ends it;
    // a chapter with nothing in that range holds nothing a fold could hide.
    if (stop - begin < 2) {
      return;
    }

    chapters.push({
      heading: heading,
      begin: begin + 1,
      stop: stop,
      button: null,
    });
  });

  return chapters;
}

/**
 * Expand every folded chapter that contains `element`, outermost first.
 *
 * A folded chapter is `hidden`, and a hidden element cannot be scrolled to:
 * a deep link, an outline entry or a block reference that points inside one
 * would open the document at the top with nothing to say why. Expanding the
 * ancestors before the scroll is what keeps those routes working, and it is
 * the reader's own act — they asked for that chapter — that reopens it.
 *
 * `body` has to be the body `enhanceChapters` was given. Returns whether
 * anything was reopened.
 */
export function expandTo(body, element) {
  if (!body || !element || typeof element !== "object") {
    return false;
  }

  var chapters = body.__wikiccChapters || [];
  var expanded = false;

  // An outer chapter hides the arrows of the chapters inside it, so those are
  // reopened only once their own container is showing again: the walk goes
  // down the nesting, not along the document.
  chapters.forEach(function (chapter) {
    if (!chapter.button || !isWithin(chapter, body, element)) {
      return;
    }
    if (chapter.button.getAttribute("aria-expanded") === "false") {
      fold(body, chapter, chapter.button);
      expanded = true;
    }
  });

  return expanded;
}

/** Whether `element` sits inside `chapter`'s range of `body`. */
function isWithin(chapter, body, element) {
  var node = element;
  var children = body.children ? Array.prototype.slice.call(body.children) : [];

  while (node) {
    var index = children.indexOf(node);
    if (index >= 0) {
      return index >= chapter.begin && index < chapter.stop;
    }
    node = node.parentNode;
  }

  return false;
}

/**
 * Fold or unfold `chapter`, exactly as its button asks.
 *
 * Everything the body holds between the chapter's heading and the heading
 * that ends it is hidden. The arrow is not among them: it lives inside the
 * heading, so the control that undoes the fold never hides with the chapter.
 */
function fold(body, chapter, button) {
  var hidden = button.getAttribute("aria-expanded") !== "false";
  var list = body.children ? Array.prototype.slice.call(body.children) : [];

  for (var index = chapter.begin; index < chapter.stop; index += 1) {
    var element = list[index];
    if (!element) {
      continue;
    }
    if (hidden) {
      element.setAttribute("hidden", "");
    } else {
      element.removeAttribute("hidden");
    }
  }

  button.setAttribute("aria-expanded", hidden ? "false" : "true");
  button.setAttribute("aria-label", hidden ? EXPAND_LABEL : COLLAPSE_LABEL);
  button.setAttribute("title", hidden ? EXPAND_LABEL : COLLAPSE_LABEL);
  if (hidden) {
    chapter.heading.setAttribute("data-collapsed", "");
  } else {
    chapter.heading.removeAttribute("data-collapsed");
  }
}

/** Labels the arrow wears, in the language the rest of the reader is written in. */
var COLLAPSE_LABEL = "Collapse section";
var EXPAND_LABEL = "Expand section";

/** Build the arrow of one chapter. */
function createToggle(doc) {
  var button = doc.createElement("button");
  button.className = TOGGLE_CLASS;
  button.setAttribute("type", "button");
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-label", COLLAPSE_LABEL);
  button.setAttribute("title", COLLAPSE_LABEL);

  var svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  var path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", CHEVRON_PATH);
  svg.appendChild(path);
  button.appendChild(svg);

  return button;
}

/** The fold arrow `event` landed on, if it landed on one. */
function toggleOf(event) {
  var target = event && event.target;
  if (!target) {
    return null;
  }
  if (typeof target.closest === "function") {
    return target.closest("." + TOGGLE_CLASS) || null;
  }
  return String(target.className || "")
    .split(" ")
    .indexOf(TOGGLE_CLASS) !== -1
    ? target
    : null;
}

/**
 * Fill an existing element with a document's markup.
 *
 * `options.enhanceTables` says whether the tables in the markup gain the sort
 * and filter controls of the article, and `options.collapsible` whether its
 * chapters gain the arrow that folds them. The work happens here, right after
 * the markup exists and — for a caller that has not inserted the element yet —
 * before it is on screen.
 *
 * Returns `body`, so a call can sit at the head of an expression.
 */
export function fillDocBody(body, html, options) {
  body.innerHTML = html;

  if (options && options.enhanceTables) {
    TableView.enhanceTables(body);
  }

  if (options && options.collapsible) {
    body.__wikiccChapters = enhanceChapters(body);
  }

  return body;
}

/**
 * Build the body element of one document.
 *
 * `options.extraClass` names what the container is — the search preview's
 * `search-document`, for one — and goes in front, so the class string reads
 * "what it is, and that it typesets like the article". `options.enhanceTables`
 * and `options.collapsible` are handed to `fillDocBody` untouched.
 */
export function createDocBody(html, options) {
  var body = document.createElement("div");
  body.className =
    options && options.extraClass
      ? options.extraClass + " " + BODY_CLASS
      : BODY_CLASS;

  return fillDocBody(body, html, options);
}

/**
 * Draw the diagrams of a body that is already in the document.
 *
 * This is the one step a caller must not do early: the engine measures its
 * labels with the layout, which a detached subtree does not have. The call
 * is asynchronous and swallows its own failures, so the text around the
 * diagrams is readable while the pictures arrive.
 */
export function drawDiagrams(body, theme) {
  return DiagramView.renderDiagrams(body, theme);
}

/**
 * Typeset the math of a body that is already in the document.
 *
 * The engine needs no layout — KaTeX derives everything from the formula
 * itself — but the call keeps the insertion-time contract of `drawDiagrams`
 * so every caller does the same dance in the same order. The call is
 * synchronous and swallows its own failures, so a formula that cannot be
 * typeset leaves its source text behind and the document stays readable.
 */
export function drawMath(body) {
  return MathView.renderMath(body);
}
