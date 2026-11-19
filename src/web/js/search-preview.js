/**
 * The search preview: the whole document behind the selected result, drawn in
 * the dialog's bottom half.
 *
 * **The preview shows the document, not a quotation from it.** A reader who
 * picked a result is asking to read it, and a paragraph cut out of the middle
 * answers the wrong question: it says "this is the one" where the reader wants
 * to know what it says. So the payload's body is inserted whole — by the same
 * shared document-body render the article uses — scrolls in the preview's own
 * column, and carries a `<mark>` on every place the query occurs — the same
 * words `search.js` found, so the list and the page agree. Diagrams are drawn
 * there because their source would otherwise sit on screen as code; tables
 * are deliberately *not* enhanced, because the sort and filter buttons belong
 * to the article and not to a dialog.
 *
 * Document text reaches the page as text, never as markup: a passage that
 * falls back to the excerpt is assembled from three nodes. Highlighting works
 * on text nodes for the same reason — the query may as well name a tag as a
 * word, and replacing inside the markup string would tear the document apart
 * at the place the reader is looking. The search engine's `match` data would
 * have been a more direct source for the offsets, but it addresses its own
 * token stream — the words are found in `search.js` instead, in the text the
 * reader sees.
 */
import { ELLIPSIS } from "./search.js";
import * as SearchHighlight from "./search-highlight.js";
import * as DocBody from "./doc-body.js";
import { EMPTY_CLASS, markNode } from "./search-panel.js";
import { t } from "./i18n.js";

/** Class of the whole-document body inside the preview. */
export var DOCUMENT_CLASS = "search-document";

/** Class of the preview's notice for a result whose document is sealed. */
export var SEARCH_LOCKED_CLASS = "search-locked";

/** Text of that notice. */
export var LOCKED_NOTICE =
  "This document is encrypted. Open it to unlock its contents.";

/** Shown in the middle of the preview while it has no passage to show. */
export var PREVIEW_IDLE_LABEL = "Preview";

/**
 * Create the dialog's bottom half for one reader instance.
 *
 * `options.panel` is the frame the preview lives in — the host element is
 * `panel.preview()`, built when the dialog's shell is. `options.query` reads
 * the query on screen, as typed, because the signature below decides between
 * a redraw and a scroll. `options.documents` is the reader's document store —
 * `peek(id)` answers with the model already on hand or `null`, `get(id)`
 * promises it, fetching first when the build split the site into files.
 * `options.theme` returns the theme currently in effect, because diagrams
 * bake their colours into the SVG.
 *
 * Returns `{ render, dispose }`: `render(entry)` draws what the selected row
 * describes — `null` for the idle half — and `dispose` forgets what was
 * drawn, so the next opening starts from nothing.
 */
export function createSearchPreview(options) {
  var panel = (options && options.panel) || null;
  var query =
    (options && options.query) ||
    function () {
      return "";
    };
  var documents = (options && options.documents) || null;
  // Diagram colours are baked into the SVG, so the preview has to be drawn for
  // the theme in effect — the same callback the article is rendered with.
  var theme =
    (options && options.theme) ||
    function () {
      return null;
    };

  /** The element the preview draws into, resolved afresh on every render. */
  var preview = null;

  /**
   * What the preview currently shows, as `id + "\u0000" + query`.
   *
   * The list marks a row on every pointer move and every arrow key, and almost
   * all of those land on the row already selected. Rebuilding a whole document
   * — with its highlights and its diagrams — on each of them would make the
   * reader's own pointer stutter, so the signature decides whether there is
   * anything to draw.
   */
  var drawn = null;

  /**
   * The occurrence the drawn document is scrolled to.
   *
   * Rows of one document differ only in the place they name, and rebuilding a
   * whole document to move within it would make the reader's own pointer
   * stutter; this is what tells a scroll from a redraw.
   */
  var drawnHit = null;

  /**
   * One slot per occurrence, in the order `occurrences` numbers them.
   *
   * A slot holds the `<mark>` wrapped for a textual hit — or, for a hit the
   * highlight leaves as authored (a code block, a diagram source), the block
   * element containing it, which is what the preview can still scroll to.
   * Exactly one of the two is set, and the slot's index is the very ordinal
   * the result list gave the occurrence, so the row a reader picks and the
   * place the preview lands on stay the same place however many hits the
   * code blocks hold.
   */
  var slots = [];

  /** The element the preview draws into, or `null` before the shell is built. */
  function host() {
    return panel ? panel.preview() : null;
  }

  /**
   * Show the document `entry` was found in — the whole of it.
   *
   * A reader who picked a result is asking to read, not to peek: a paragraph
   * cut out of the middle answers "is this the one" but never "what does it
   * say", and the dialog is large enough to hold the article itself. The body
   * is therefore inserted as authored, scrolled on its own, and every hit of
   * the query is marked in place so the eye lands where the list said.
   *
   * Two things the article's own render does and this one must not: enhancing
   * the tables, which injects sort and filter buttons into a panel that is not
   * the reader's page, and nothing else. Diagrams *are* drawn, because their
   * source would otherwise sit on screen as code.
   *
   * A shell with no payload to ask — or a query whose answer landed on a
   * document the payload does not hold — falls back to the excerpt the entry
   * carries, so the half is never blank where it could say something.
   */
  function render(entry) {
    preview = host();
    if (!preview) {
      return;
    }

    if (!entry) {
      // Nothing selected is not a state worth remembering: the panel draws it
      // on build, on every empty answer and again after a close, and a
      // signature for "nothing" would only ever skip one of those.
      drawn = null;
      drawnHit = null;
      slots = [];
      preview.textContent = "";
      preview.scrollTop = 0;
      renderIdle();
      return;
    }

    var signature = entry.id + "\u0000" + query();
    if (signature === drawn) {
      // The document on screen is the one the reader picked again; only the
      // place they picked may have moved, and moving within it is a scroll,
      // never a rebuild — the marks are already where they belong.
      if (entry.hit !== drawnHit) {
        drawnHit = entry.hit;
        SearchHighlight.scrollToSlot(slots, entry.hit);
      }
      return;
    }
    drawn = signature;
    drawnHit = entry.hit;
    slots = [];

    preview.textContent = "";
    preview.scrollTop = 0;

    if (entry.locked) {
      renderLockedNotice();
      return;
    }

    var doc = documentFor(entry.id);
    if (doc && typeof doc.then === "function") {
      // The document travels over the network in the pages format: the
      // excerpt answers at once, and the whole document takes its place when
      // it arrives — unless the reader has picked another row or closed the
      // panel by then, which the drawn signature notices.
      renderExcerpt(entry);
      doc.then(function (loaded) {
        if (drawn !== signature || !loaded) {
          return;
        }
        if (typeof loaded.html !== "string" || !loaded.html) {
          return;
        }
        preview.textContent = "";
        preview.scrollTop = 0;
        slots = [];
        renderDocument(loaded, entry);
      });
      return;
    }

    if (doc && typeof doc.html === "string" && doc.html) {
      renderDocument(doc, entry);
      return;
    }

    renderExcerpt(entry);
  }

  /**
   * The document `id` when it is on hand, its promise when it must travel,
   * `null` when the reader cannot say.
   *
   * A document already fetched — every document of the embedded formats, and
   * anything the reader has opened in the split one — answers synchronously,
   * which is what keeps the preview instant; only a first visit waits.
   */
  function documentFor(id) {
    if (!documents) {
      return null;
    }

    try {
      var onHand = documents.peek ? documents.peek(id) : null;
      if (onHand) {
        return onHand;
      }
      return documents.get ? documents.get(id) || null : null;
    } catch (_error) {
      // The preview is built from whatever the page hands over; a store that
      // throws is the page's problem to log, not a reason the panel stops
      // answering.
      return null;
    }
  }

  /** Name the half, in its middle, and say nothing else. */
  function renderIdle() {
    var idle = document.createElement("p");
    idle.className = EMPTY_CLASS;
    idle.textContent = t("search.previewIdle");
    preview.appendChild(idle);
  }

  /**
   * Say why the preview of a sealed document holds nothing.
   *
   * A sealed document's body is the ciphertext: there is no markup to show,
   * and a blank half would read as a broken panel rather than a lock. The
   * notice names the lock and points at the one action a row carries —
   * opening the document, which lands on the lock page where the password
   * goes.
   */
  function renderLockedNotice() {
    var notice = document.createElement("p");
    notice.className = SEARCH_LOCKED_CLASS;
    notice.textContent = t("search.lockedNotice");
    preview.appendChild(notice);
  }

  /** The fallback: the passage `search.js` cut for the list. */
  function renderExcerpt(entry) {
    var cut = entry && entry.snippet;
    if (!cut) {
      renderIdle();
      return;
    }

    var passage = document.createElement("p");
    passage.className = "search-passage";
    passage.appendChild(
      document.createTextNode((cut.trimmedStart ? ELLIPSIS : "") + cut.before),
    );
    passage.appendChild(markNode(cut.hit));
    passage.appendChild(
      document.createTextNode(cut.after + (cut.trimmedEnd ? ELLIPSIS : "")),
    );
    preview.appendChild(passage);
  }

  /**
   * Insert the whole document, mark every hit, and scroll to the first one.
   *
   * The preview is the document alone: no banner names it above the body,
   * because the row the reader picked already said which file this is, and
   * a dialog that repeats what the list just read out says nothing new.
   */
  function renderDocument(doc, entry) {
    // The body is the article's own render — the shared document-body module —
    // with the dialog's one declared difference: its tables stay untouched,
    // because the sort and filter buttons belong to the article and the filter
    // panel they open is parented outside this one.
    var body = DocBody.createDocBody(doc.html, {
      extraClass: DOCUMENT_CLASS,
      enhanceTables: false,
    });

    preview.appendChild(body);

    slots = SearchHighlight.highlightHits(body, query());
    // Diagrams are drawn after insertion — the body module's one deferred
    // step, because the engine measures its labels with the layout — and
    // asynchronously, so the text is readable while the pictures arrive.
    void DocBody.drawDiagrams(body, theme());

    SearchHighlight.scrollToSlot(slots, entry.hit);
  }

  /** Forget what was drawn; the next opening starts from nothing. */
  function dispose() {
    drawn = null;
    drawnHit = null;
    slots = [];
    preview = null;
  }

  return {
    render: render,
    dispose: dispose,
  };
}
