/**
 * The hits of a search query inside a rendered document: marking them, and
 * bringing one of them into view.
 *
 * Two callers share the one mechanism. The search panel's preview marks every
 * place the query occurs in the document a row points at, and scrolls to the
 * place that row describes; the article does the same when the reader opens a
 * result with `Enter` — the list, the preview and the page then all describe
 * the same places. `search-view.js` draws the preview, `app.js` the article;
 * neither repeats what this module owns.
 *
 * The unit of the mechanism is the *slot*: one per occurrence, in reading
 * order. A slot holds the `<mark>` wrapped for a textual hit — or, for a hit
 * the highlight leaves as authored (a code block, a diagram source), the
 * block element containing it, which is what the caller can still scroll to.
 * Exactly one of the two is set, and the slot's index is the very ordinal a
 * result row carries (`hit`, see `search.js`), so the row a reader picks and
 * the place the page lands on stay the same place however many hits the code
 * blocks hold.
 *
 * The work is done on text nodes, never on markup: the document's own HTML
 * carries tags whose names and attributes could match the query, and a string
 * replacement would tear the page apart at exactly the place the reader is
 * looking. Each node is split at its hits and the middle pieces are replaced
 * by `<mark>` elements around the same text.
 *
 * Splitting while walking is the one ordering hazard here: `splitText` leaves
 * the fresh half *after* the node, where a tree walker would visit it again —
 * and its hits begin where the previous node's ended, so they would be found
 * twice. The walk therefore restarts from the last piece, which is past every
 * hit already handled.
 *
 * The module touches `document` — the tree walk and the nodes it creates —
 * so it lives on the view side of the layering rule; the ranges themselves
 * come from the pure `search.js`.
 */
import { matchRanges } from "./search.js";

/** Class of one highlighted hit inside a rendered document. */
export var HIT_CLASS = "search-hit";

/** Class of the one hit the page is scrolled to, the reader's pick. */
export var HIT_ACTIVE_CLASS = "search-hit-active";

/**
 * Elements whose text is never highlighted.
 *
 * A hit inside a code block or a diagram source is real, but marking it would
 * restart the diagram engine's placeholder text and turn a rendered picture
 * back into source, so those subtrees are left as authored. Only the block
 * carriers are listed — the `pre` around fenced code or a diagram's source —
 * while inline `code` is ordinary text set in a different face, and its hits
 * are marked like any other. `mark` is skipped too, which is what keeps a
 * second pass from wrapping a hit it already knows.
 */
var UNHIGHLIGHTED_TAGS = ["PRE", "SCRIPT", "STYLE", "MARK"];

/**
 * Wrap every hit of `query` in `root`'s text, and return what was wrapped.
 *
 * Every text node is measured, wrapped or not: the result list numbers the
 * document's occurrences over its whole text — a code block's text included —
 * so a subtree the highlight leaves as authored still fills the slots its
 * hits own. Skipping the count would leave every ordinal after the skip
 * naming the place before it.
 *
 * A live walker revisits the text a fresh mark holds — the mark was created
 * after the walk passed — and that text is the very hit the walk just
 * counted, so it fills no slot of its own.
 *
 * Returns the slots, one per occurrence in reading order: `{ mark, block }`
 * with exactly one half set, the index of each the ordinal its result row
 * carries.
 */
export function highlightHits(root, query) {
  var slots = [];
  if (!document.createTreeWalker || !root) {
    return slots;
  }

  var walker = document.createTreeWalker(root, textNodes(), null);
  var node = walker.nextNode();

  while (node) {
    if (insideOwnMark(node, root)) {
      // Already counted where the mark was wrapped.
    } else if (skippable(node, root)) {
      if (textOfNode(node).trim()) {
        recordSkipped(node, matchRanges(textOfNode(node), query), slots, root);
      }
    } else {
      var ranges = matchRanges(textOfNode(node), query);
      if (ranges.length) {
        node = wrapHits(node, ranges, slots);
      }
    }
    node = walker.nextNode();
  }

  return slots;
}

/** Whether a text node sits in one of the marks the highlight wrapped. */
function insideOwnMark(node, root) {
  var parent = node.parentNode;

  while (parent && parent !== root) {
    if (
      parent.tagName &&
      String(parent.tagName).toUpperCase() === "MARK" &&
      String(parent.className).split(" ").indexOf(HIT_CLASS) !== -1
    ) {
      return true;
    }
    parent = parent.parentNode;
  }

  return false;
}

/** The text a node carries, read the way both a browser and a DOM stand-in allow. */
function textOfNode(node) {
  if (!node) {
    return "";
  }

  return String(
    node.nodeValue === undefined ? node.textContent : node.nodeValue,
  );
}

/** `NodeFilter.SHOW_TEXT`, without depending on the constant being exposed. */
function textNodes() {
  return typeof NodeFilter === "undefined" || !NodeFilter.SHOW_TEXT
    ? 4
    : NodeFilter.SHOW_TEXT;
}

/** Whether a text node sits in a subtree whose text is left alone. */
function skippable(node, root) {
  if (!textOfNode(node).trim()) {
    return true;
  }

  var parent = node.parentNode;
  while (parent && parent !== root) {
    if (
      parent.tagName &&
      UNHIGHLIGHTED_TAGS.indexOf(String(parent.tagName).toUpperCase()) !== -1
    ) {
      return true;
    }
    parent = parent.parentNode;
  }

  return false;
}

/**
 * The outermost skipped ancestor of a text node, or `null`.
 *
 * A hit the highlight leaves as authored still has to be scrolled to, and
 * the block that holds it — the `<pre>` around the code, say — is the
 * largest element the skip covers: it is the one place the reader can be
 * brought that still says "the hit is in here".
 */
function skippedBlock(node, root) {
  var block = null;
  var parent = node.parentNode;

  while (parent && parent !== root) {
    if (
      parent.tagName &&
      UNHIGHLIGHTED_TAGS.indexOf(String(parent.tagName).toUpperCase()) !== -1
    ) {
      block = parent;
    }
    parent = parent.parentNode;
  }

  return block;
}

/** Fill the slots a skipped subtree's hits own with its block element. */
function recordSkipped(node, ranges, slots, root) {
  var block = skippedBlock(node, root);

  ranges.forEach(function () {
    slots.push({ mark: null, block: block });
  });
}

/**
 * Split `node` at `ranges` and wrap each piece in a `<mark>`.
 *
 * The cuts are made from the right, and always out of the node itself:
 * `splitText` leaves the fresh half *after* the node, so cutting a piece
 * out of a piece cut before would address it by an offset that no longer
 * means anything — while the node, holding everything left of the last
 * cut, keeps every earlier range's start the offset it had in the node's
 * own text. Each `<mark>` replaces the piece that is exactly its own text.
 *
 * The marks are handed back in reading order — the walk runs rightmost
 * first, and both the slots the caller fills and the mark the walk resumes
 * from have to number the hits the way the reader reads them.
 *
 * Returns the first hit's mark, which is where the walk resumes — a tree
 * walker enters a `<mark>` and would otherwise offer the highlighted text
 * again.
 */
function wrapHits(node, ranges, slots) {
  var text = textOfNode(node);
  var marks = [];

  for (var index = ranges.length - 1; index >= 0; index -= 1) {
    var start = ranges[index].start;
    var end = start + ranges[index].length;
    var tail = splitTail(node, start);
    var piece = splitTail(tail, end - start);

    if (!piece || !tail.parentNode) {
      continue;
    }

    var hit = document.createElement("mark");
    hit.className = HIT_CLASS;
    hit.textContent = text.slice(start, end);
    tail.parentNode.replaceChild(hit, tail);

    marks.unshift(hit);
  }

  marks.forEach(function (hit) {
    slots.push({ mark: hit, block: null });
  });

  return marks.length ? marks[0] : node;
}

/**
 * The node holding everything `node` has from `index` onwards.
 *
 * A browser answers with `splitText`; a DOM without it — the fake page the
 * tests drive — cannot cut a node at all, so the node comes back whole and
 * the caller's `<mark>` simply takes its place.
 */
function splitTail(node, index) {
  if (!node) {
    return null;
  }

  if (typeof node.splitText === "function") {
    return node.splitText(index);
  }

  return node;
}

/**
 * Bring the hit the reader picked into view, centred.
 *
 * The caller owns the scroll container — the preview its own column, the
 * article the page — so the scroll lands wherever that container scrolls.
 * `block: "center"` asks for the middle, and the browser clamps what a
 * middle would need against the scrollable range — a hit three lines into
 * a short document keeps the document at its top rather than pulling a gap
 * above it, so centring never invents space that is not there.
 *
 * The picked mark is the one that raises its voice (`HIT_ACTIVE_CLASS`,
 * yellow where the rest keep the quiet wash), and it moves with the
 * selection: the reader's eye lands here, so this and only this hit may
 * stand out.
 *
 * The slots are one per occurrence, in the order the list numbers them —
 * the marks the highlight wrapped, and, for a hit that sits in a code
 * block or a diagram source and is left as authored, the block holding it.
 * The ordinal therefore names its own place whatever the document holds: a
 * code hit scrolls to its block without a standout, and no textual hit
 * after it is displaced. A `-1`, the ordinal of a title-only match, names
 * the first slot, which such a document does not have and so does nothing.
 */
export function scrollToSlot(slots, ordinal) {
  if (!slots || !slots.length) {
    return;
  }

  var index = ordinal >= 0 ? Math.min(ordinal, slots.length - 1) : 0;
  var target = slots[index];
  if (!target) {
    return;
  }

  // String assignment rather than `classList`: the marks are created here
  // and carry no other class, and a plain string is what every DOM stand-in
  // the tests drive can read back.
  slots.forEach(function (slot) {
    if (slot.mark) {
      slot.mark.className = HIT_CLASS;
    }
  });

  // A hit the highlight wrapped takes the standout; one left as authored
  // has no mark to raise, and the block that holds it is where the eye is
  // brought instead.
  if (target.mark) {
    target.mark.className = HIT_CLASS + " " + HIT_ACTIVE_CLASS;
  }

  var node = target.mark || target.block;
  if (node && typeof node.scrollIntoView === "function") {
    node.scrollIntoView({ block: "center" });
  }
}

/**
 * Take `marks` back off the page, restoring each one's plain text.
 *
 * The marks are the ones `highlightHits` wrapped — one text node apiece —
 * so a text node put back where the mark stood restores the document as
 * authored, adjacent text nodes aside. A caller clears before it marks
 * again, because re-running the walk over the original text is what keeps
 * the ordinals honest, and when the reading moves on, because a search's
 * highlights belong to the arrival and not to the reading that follows.
 *
 * `replaceChild` is the one primitive both a browser and every DOM stand-in
 * the tests drive answer, and the text is re-read from the mark rather than
 * moved out of it, because a mark the tests built holds its text without a
 * child node to move. A mark already off the page — a body a render
 * replaced — is simply passed over.
 */
export function clearSlots(marks) {
  var list = Array.isArray(marks) ? marks : [];

  for (var index = 0; index < list.length; index += 1) {
    var mark = list[index];
    var parent = mark && mark.parentNode;
    if (!parent || typeof parent.replaceChild !== "function") {
      continue;
    }
    if (typeof document === "undefined" || !document.createTextNode) {
      return;
    }

    parent.replaceChild(document.createTextNode(textOfNode(mark)), mark);
  }
}
