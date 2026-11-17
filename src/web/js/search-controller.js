/**
 * The search controller: the two scopes, their indexes, and the answers.
 *
 * A search reads the document being read — the local scope, whose index is
 * rebuilt only when the reader turns the page — or every document the site
 * holds. The embedded formats build the whole-site index once, at startup,
 * from the payload; the pages format fetches its corpus the first time the
 * scope widens, and while it travels the global scope answers "loading"
 * instead of pretending there is nothing to find. The records the answers
 * are cut from are this controller's own copy: a decryption swaps its
 * document's record for the full model, and the list and the graph hold the
 * payload's array untouched.
 *
 * The controller also owns the marks a search jump leaves on the article:
 * every arrival hands the marks their turn, a jump is marked and walked to
 * once the markup has settled, and the next navigation takes the page back
 * as authored.
 *
 * `search.js` is the engine, `search-view.js` the dialog this controller is
 * wired to; the composition root builds the view and hands it in.
 */
import * as DocBody from "./doc-body.js";
import * as Search from "./search.js";
import * as SearchHighlight from "./search-highlight.js";
import * as SearchView from "./search-view.js";

export function createSearchController(deps) {
  var view = deps.view;
  var button = deps.button;
  var panel = deps.panel;
  var store = deps.store;
  var docs = deps.docs;
  var session = deps.session;
  var content = deps.content;
  var currentDoc = deps.currentDoc;

  /**
   * The index over the whole site, and the records its answers are cut from.
   *
   * The embedded formats build both once, at startup, from the payload. The
   * pages format builds neither: its corpus is a file the reader fetches
   * the first time the scope widens past the document in view, and while it
   * travels the global scope answers "loading" instead of pretending there is
   * nothing to find.
   */
  var index = store.isLazy() ? null : Search.createSearch(docs);
  // The records `occurrences` cuts its passages from are the controller's own
  // copy: a decryption swaps its document's record for the full model, and
  // the list and the graph hold the payload's array untouched.
  var corpusDocs = store.isLazy() ? null : docs.slice();
  var globalIndexPromise = null;

  /** The whole-site index, fetching the corpus first when it is separate. */
  function ensureGlobalIndex() {
    if (index) {
      return Promise.resolve(index);
    }
    if (globalIndexPromise) {
      return globalIndexPromise;
    }

    globalIndexPromise = store.corpus().then(function (records) {
      if (records && records.length) {
        // A document decrypted before its corpus arrived still sits in the
        // file as its public title alone; the model the password opened
        // stands in for it here.
        corpusDocs = records.map(function (record) {
          return session.decryptedDoc(record.id) || record;
        });
        index = Search.createSearch(corpusDocs);
      }
      return index;
    });

    return globalIndexPromise;
  }

  /**
   * The `<mark>` elements the article currently carries for a search jump.
   *
   * The marks are the article's until the next navigation: a reader who
   * arrived at a passage wants to see where they are, and a reader who moves
   * on wants the page back as authored. Clearing unwraps each mark back into
   * its text, which also restores the original text the next jump's walk has
   * to count over.
   */
  var searchMarks = [];

  /**
   * A search over one document, and the index built for it.
   *
   * The local scope never needs the whole site: the document in view carries
   * its own text, so its index is rebuilt only when the reader turns the page.
   * In the pages format this is what makes the default scope cost
   * nothing — the document is already in hand, having been fetched to be read.
   */
  var localIndex = null;
  var localIndexId = null;

  /**
   * A password that opened a document puts its full text where search reads.
   *
   * The global index and the corpus were built with the sealed shape — a
   * title, and nothing else — so the model the password returned is written
   * over its record in both, and the local index is dropped outright: it is
   * cached by id, and the id did not change, so the empty body it indexed
   * would keep answering after the unlock. The session's map of what a
   * password has opened keeps the two orders honest when the file arrives
   * after the password did. Nothing here touches storage: the passwords and
   * the plaintext live in memory alone.
   */
  function onUnlocked(unlocked) {
    if (corpusDocs) {
      var at = -1;
      for (var i = 0; i < corpusDocs.length; i += 1) {
        if (corpusDocs[i].id === unlocked.id) {
          at = i;
          break;
        }
      }
      if (at === -1) {
        corpusDocs.push(unlocked);
      } else {
        corpusDocs[at] = unlocked;
      }
    }

    if (index) {
      // `replace` is the engine's one idempotent write: the sealed record is
      // already in the index, so re-adding through it can never duplicate.
      index.replace(Search.recordOf(unlocked));
    }

    localIndex = null;
    localIndexId = null;
  }

  function localSearch() {
    var doc = currentDoc();
    if (!doc || typeof doc.text !== "string") {
      return null;
    }
    if (localIndexId !== doc.id || !localIndex) {
      localIndex = Search.createSearch([doc]);
      localIndexId = doc.id;
    }

    return localIndex;
  }

  /**
   * One past the newest query the panel asked for.
   *
   * A corpus that travels over the network answers late, and a query typed
   * while it was in flight must not have its list overwritten by the older
   * one that triggered the fetch.
   */
  var querySequence = 0;

  /**
   * The tail budget the result rows render into, in display-width units.
   *
   * One unit is one em of the context line, so the budget is the column
   * width over the font size. An already-rendered row is the exact measure —
   * its context column is the space a tail fills beside the path column —
   * and before the first row exists, the panel's width stands in for one,
   * less the row's padding, the column gap and the widest path column the
   * stylesheet gives. Anything that cannot be read — a shell without a
   * panel, a test DOM with no layout — hands back nothing, and the engine
   * cuts with its own default.
   */
  function snippetTailUnits() {
    if (!panel || !panel.querySelector) {
      return null;
    }

    var context = panel.querySelector("." + SearchView.CONTEXT_CLASS);
    var width = context
      ? context.clientWidth
      : panel.clientWidth - 34 - 14 - 260;
    if (!width || width <= 0 || !Number.isFinite(width)) {
      return null;
    }

    var fontSize = 12.5;
    if (context && typeof getComputedStyle === "function") {
      var parsed = parseFloat(getComputedStyle(context).fontSize);
      if (parsed > 0 && Number.isFinite(parsed)) {
        fontSize = parsed;
      }
    }

    var units = Math.round(width / fontSize);
    return units > 0 ? units : null;
  }

  /**
   * Name the entries whose document is still sealed.
   *
   * A sealed document reaches the list through its title alone: the row has
   * no passage to quote and the preview no body to show, and the lock is the
   * reason. The flag rides the entry, which is what the view draws — it
   * never asks the store itself — and it is read when the answer is built,
   * so the same query after an unlock comes back without it.
   */
  function markLocked(entries) {
    return entries.map(function (entry) {
      return store.isEncrypted(entry.id)
        ? Object.assign({}, entry, { locked: true })
        : entry;
    });
  }

  /**
   * The matches `query` finds in the scope `mode` names, one per place.
   *
   * The ranking is the engine's: `search` decides which documents and in what
   * order, and `occurrences` only enumerates the places inside them, so the
   * list a reader sees is the one the index scored — the hits of one document
   * together, each with the passage it was found in. The local scope is the
   * same query over the document being read, which leaves an empty list when
   * no document is open or it holds no hit. The global scope is `null` while
   * the corpus of the pages format is still on its way, which the caller
   * shows as a wait rather than as an empty answer.
   */
  function searchResults(query, mode) {
    // The tail is cut to the line the list actually renders: the budget is
    // read off the panel on every query, so a resize or a typeface change
    // follows on the next answer. No budget keeps the engine's default.
    var tailUnits = snippetTailUnits();
    var cuts = tailUnits ? { tailUnits: tailUnits } : undefined;

    if (mode === SearchView.GLOBAL_MODE) {
      if (!index) {
        return null;
      }

      var everywhere = Search.search(index, query);
      if (!everywhere) {
        return [];
      }

      return markLocked(
        Search.occurrences(corpusDocs || docs, everywhere, query, cuts),
      );
    }

    var local = localSearch();
    if (!local) {
      return [];
    }

    var here = Search.search(local, query);
    if (!here) {
      return [];
    }

    return markLocked(Search.occurrences([currentDoc()], here, query, cuts));
  }

  /**
   * Mark the article with `jump`'s query and bring `jump`'s hit into view.
   *
   * The reader pressed `Enter` on a result row: the document is open, and
   * the place the row described is the only thing left to do. Every
   * occurrence of the query is wrapped in the same marks the preview wore —
   * the list, the preview and the article now name the same places — and
   * the occurrence the row numbered is the one that stands out and takes
   * the viewport. The marks are remembered so the next navigation can take
   * them back off: a search's highlights belong to the arrival, not to the
   * reading that follows.
   *
   * Anything that cannot be honoured — a body that never rendered, an
   * ordinal without a place — is quietly skipped: the document is open and
   * readable either way.
   */
  function applySearchJump(jump) {
    if (!jump || !jump.query || typeof jump.hit !== "number" || jump.hit < 0) {
      return;
    }

    var body = content.querySelector("." + DocBody.BODY_CLASS);
    if (!body) {
      return;
    }

    var slots = SearchHighlight.highlightHits(body, jump.query);
    slots.forEach(function (slot) {
      if (slot.mark) {
        searchMarks.push(slot.mark);
      }
    });

    SearchHighlight.scrollToSlot(slots, jump.hit);
    settleAtHit(slots, jump.hit);
  }

  /**
   * Walk to `jump`'s hit once more after the document has settled.
   *
   * The same settling every anchor scroll faces: diagrams replace their
   * source blocks, images arrive, fonts reflow, and the first scroll can
   * leave the reader short of the passage. Two frames later the layout is
   * stable enough to correct it. Environments without
   * `requestAnimationFrame` — the node tests — keep the single attempt the
   * jump itself made.
   */
  function settleAtHit(slots, ordinal, frames) {
    var remaining = typeof frames === "number" ? frames : 2;
    if (
      remaining <= 0 ||
      typeof globalThis.requestAnimationFrame !== "function"
    ) {
      return;
    }

    globalThis.requestAnimationFrame(function () {
      SearchHighlight.scrollToSlot(slots, ordinal);
      settleAtHit(slots, ordinal, remaining - 1);
    });
  }

  /**
   * Take the marks of the last arrival back off, and open `jump`'s passage
   * when the arrival carries one. The navigation cycle hands every arrival
   * here: with a jump the article is marked and walked to, without one the
   * page is taken back as authored.
   */
  function arrive(jump) {
    SearchHighlight.clearSlots(searchMarks);
    searchMarks = [];
    if (jump) {
      applySearchJump(jump);
    }
  }

  /**
   * Answer the panel's query in the scope it names.
   *
   * A global query in the pages format waits for the corpus the first time;
   * every other query is answered at once. The sequence guards the wait: a
   * newer query owns the list by the time a late corpus lands.
   */
  function handleQuery(query, mode) {
    var sequence = ++querySequence;
    if (mode === SearchView.GLOBAL_MODE && !index) {
      // The corpus is a separate file in the pages format and this is
      // the first global search: name the wait, then answer when it lands.
      view.setLoading();
      ensureGlobalIndex().then(function (loaded) {
        if (sequence !== querySequence) {
          return; // A newer query owns the list now.
        }
        if (!loaded) {
          // The corpus never arrived: an empty answer is honest, and a
          // loading note forever is not.
          view.setResults([], 0);
          return;
        }
        view.setResults(searchResults(query, mode), 0);
      });
      return;
    }

    view.setResults(searchResults(query, mode), 0);
  }

  /** Show the panel and say so on the button that asked for it. */
  function openSearch() {
    view.open();
    if (button) {
      button.setAttribute("aria-expanded", "true");
    }
  }

  function closeSearch() {
    view.close();
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
  }

  if (button) {
    // The button describes the panel from the start, so a reader arriving with
    // a screen reader hears a control that is closed rather than one that says
    // nothing about what it controls.
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", function () {
      if (view.isOpen()) {
        closeSearch();
        return;
      }
      openSearch();
    });
  }

  return {
    arrive: arrive,
    onUnlocked: onUnlocked,
    handleQuery: handleQuery,
    openSearch: openSearch,
    closeSearch: closeSearch,
    isOpen: view.isOpen,
  };
}
