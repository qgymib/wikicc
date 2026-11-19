/**
 * Article rendering: what the reading column shows for each state of a
 * document.
 *
 * The navigation cycle decides *when* a document is placed; this module
 * decides *what* the article carries while it is — the wait while a chunk
 * travels, the failure when it never arrives, the sealed document's lock
 * page, and the document body itself, enhanced and drawn. Whatever a render
 * writes, it writes into the article only: the banner slot beside it
 * survives every document change (see `mountArticle`).
 *
 * The diagrams and the formulas are drawn at insertion time, in the contract
 * `doc-body.js` documents; the diagrams are drawn again when the theme
 * changes, because their colours are baked into the SVG.
 */
import * as Diagrams from "./diagrams.js";
import * as DiagramView from "./diagram-view.js";
import * as DocBody from "./doc-body.js";
import * as LockView from "./lock-view.js";

/** Class of the paragraph shown while a document is being fetched. */
export var LOADING_CLASS = "doc-loading";

/** Class of the paragraph shown for a document whose body is sealed. */
export var LOCKED_CLASS = "doc-locked";

/** Class the article wears while it shows a sealed document's lock page. */
var LOCKED_PAGE_CLASS = "doc-locked-page";

/**
 * Build the article renderer for one page.
 *
 * `deps.currentDoc` answers the document the reader is looking at; the
 * navigation controller owns that answer and is built after this factory
 * runs, so the composition root hands the call through a holder.
 */
export function createDocRender(deps) {
  var content = deps.content;
  var article = deps.article;
  var banner = deps.banner;
  var toc = deps.toc;
  var siteTitle = deps.siteTitle;
  var tryPassword = deps.tryPassword;
  var preview = deps.preview;
  var currentTheme = deps.currentTheme;
  var currentDoc = deps.currentDoc;

  /**
   * Empty the content column and put the banner and the article back.
   *
   * The banner slot sits beside the article for the whole session, so a
   * document change can neither remove it nor rebuild it; whatever a document
   * render, a loading note or a failure message writes, it writes into the
   * article only.
   */
  function mountArticle() {
    content.textContent = "";
    content.appendChild(banner.element());
    content.appendChild(article);
    article.textContent = "";
    // Whatever the last render wore — the lock page's centered layout, for
    // one — comes off with its children.
    article.className = "doc-article";
  }

  /** Name the wait where the document will appear. */
  function renderLoading(id) {
    var loading = document.createElement("p");
    loading.className = LOADING_CLASS;
    loading.textContent = "Loading " + id + " \u2026";

    mountArticle();
    article.appendChild(loading);
    // The previous document's outline would be a lie about what is open.
    toc.render([], id);
    document.title = siteTitle;
  }

  /** Say that the document never arrived, and why that can happen. */
  function renderLoadError(route) {
    var failed = document.createElement("p");
    failed.className = "doc-empty";
    failed.textContent = "This document could not be loaded.";

    mountArticle();
    article.appendChild(failed);
    toc.render([], route.id);
    document.title = siteTitle;
    banner.showMessage(
      "Could not load " +
        route.id +
        " \u2014 the file is missing, or the site is not being served over HTTP.",
    );
  }

  /** Whether the document's body is sealed and only its title is public. */
  function isLocked(doc) {
    return !!doc && !!doc.enc;
  }

  /**
   * Show the title of a sealed document and the one field its page answers
   * in.
   *
   * A sealed document has no markup to render: its html, outline, blocks
   * and text are emptied by the build, and the ciphertext they became is
   * what a password opens, not what this page shows. The page therefore
   * holds four facts — the path and the title exactly where every
   * document's are, one line that says the contents are hidden, and the
   * password field itself, so the door needs no opening: the reader types
   * where they stand, and a password that opens the document re-renders it
   * through the store's notification. No diagrams, no formulas, no preview
   * tagging: there is no markup to enhance, and a placeholder that
   * pretended otherwise would be a blank page in disguise.
   */
  function renderLocked(doc) {
    var path = document.createElement("p");
    path.className = "doc-path";
    path.textContent = doc.id;

    var title = document.createElement("h1");
    title.className = "doc-locked-title";
    title.textContent = doc.title;

    var note = document.createElement("p");
    note.className = LOCKED_CLASS;
    note.textContent =
      "This document is encrypted. Its contents stay hidden until it is unlocked.";

    mountArticle();
    // The lock page is a centered composition, not a column of prose: the
    // class lets the stylesheet place the field at the middle of the
    // reading column, left to right and top to bottom.
    article.className = "doc-article " + LOCKED_PAGE_CLASS;
    article.appendChild(path);
    article.appendChild(title);
    article.appendChild(note);
    LockView.createUnlockForm({
      host: article,
      doc: doc,
      onSubmit: tryPassword,
    });
  }

  function renderDocument(doc) {
    var path = document.createElement("p");
    path.className = "doc-path";
    path.textContent = doc.id;

    // The shared document-body render: markup in, tables enhanced in the same
    // breath and still before insertion, so the first paint already carries
    // the sortable headers, filter buttons, code copy buttons and chapter
    // fold arrows. Folding is asked for here and nowhere else: the search
    // preview would read the arrow as a press outside its dialog, and the
    // hover preview is a window onto a chapter rather than a place to read
    // one.
    var body = DocBody.createDocBody(doc.html, {
      enhanceTables: true,
      collapsible: true,
      codeCopy: true,
    });

    mountArticle();
    article.appendChild(path);
    article.appendChild(body);

    // Diagrams are drawn after insertion — the one step the body module defers
    // to its caller, because the engine measures label sizes with the DOM,
    // which is impossible for a detached subtree. The call is asynchronous and
    // swallows its own failures, so the document is already readable when the
    // SVGs replace their source blocks. `void` says the drop is deliberate.
    void DocBody.drawDiagrams(body, currentTheme());

    // Formulas are typeset in the same insertion-time contract; the call is
    // synchronous and swallows its own failures.
    DocBody.drawMath(body);

    // The links this document carries are the ones the hover preview watches.
    preview.tag(body);
  }

  /** Re-render the current document's diagrams for the theme now in effect. */
  function refreshDiagrams() {
    var doc = currentDoc();
    if (!doc || !Diagrams.hasDiagramSource(doc.html)) {
      return;
    }

    var body = content.querySelector(".doc-body");
    if (!body) {
      return;
    }

    // Diagram colours are baked into the SVG, so the rendered diagram has to be
    // reset to its source and drawn again. Only the diagrams are touched: the
    // rest of the document keeps its scroll position, table sort and filters.
    DiagramView.resetDiagrams(body);
    void DiagramView.renderDiagrams(body, currentTheme());
  }

  return {
    mountArticle: mountArticle,
    renderLoading: renderLoading,
    renderLoadError: renderLoadError,
    isLocked: isLocked,
    renderLocked: renderLocked,
    renderDocument: renderDocument,
    refreshDiagrams: refreshDiagrams,
  };
}
