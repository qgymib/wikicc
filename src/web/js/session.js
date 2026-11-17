/**
 * The reader's session: what this visit has unlocked and what it prefers.
 *
 * Everything here is the session-owned half of the reader's memory. The
 * passwords a reader has entered are kept in a plain `Map` — never in
 * `localStorage`, `sessionStorage` or a cookie — so a refresh forgets them
 * all, and the documents those passwords opened are remembered by id for
 * the page's lifetime, with everyone watching hearing about each one
 * through the change notification. The reader's preferences are the
 * exception: the theme, the sidebar's visibility and the sidebar's view are
 * written to `localStorage` so they survive a reload, through the one safe
 * door this module owns — storage can be disabled, and a preference that
 * cannot be remembered must not take the reading down with it.
 *
 * The decryption itself belongs to the store (`doc-store.js`): the door is
 * injected here as `decrypt`, and the session adds only the memory around
 * it — a password that opened a document is filed, the document is
 * recorded, and the silent attempt for the next sealed page reads the same
 * table. `isActive` is the navigation guard the silent attempts honor: the
 * reader having moved on stops the queue from spending key derivations on
 * a page nobody is looking at.
 *
 * Pure: no DOM. `node --test` drives the whole session with a stub door.
 */

/** `localStorage` key holding the explicit theme choice. */
var THEME_KEY = "wikicc.theme";

/** `localStorage` key holding the sidebar's visibility. */
var SIDEBAR_KEY = "wikicc.sidebar";

/**
 * `localStorage` key holding which sidebar view is showing: the document
 * list or the chapter outline.
 */
var SIDE_VIEW_KEY = "wikicc.side-view";

/**
 * Read `key` from `localStorage`, or `null` when storage says nothing or
 * cannot be reached — the one reading door the preferences go through.
 */
function readStored(key) {
  try {
    return globalThis.localStorage.getItem(key);
  } catch (_error) {
    return null;
  }
}

/**
 * Write `key` to `localStorage`, or let it go when storage cannot be
 * reached: the preference still applies for this page.
 */
function writeStored(key, value) {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch (_error) {
    /* Storage can be disabled; the preference still holds for this page. */
  }
}

/**
 * The passwords of one reading session, remembered in memory alone.
 *
 * `remember` files the password that opened a document; `passwordFor` reads
 * it back; `candidates` lists what a silent attempt should try for `id` —
 * its own password first, then every other password of the session, newest
 * first, so a site whose articles share one password asks for it once. The
 * table answers to nothing outside the page: a refresh starts empty.
 */
export function createSessionPasswords() {
  var byId = new Map();
  var recent = [];

  return {
    remember: function (id, password) {
      byId.set(String(id), String(password));
      var index = recent.indexOf(password);
      if (index !== -1) {
        recent.splice(index, 1);
      }
      recent.unshift(password);
    },
    passwordFor: function (id) {
      return byId.has(String(id)) ? byId.get(String(id)) : null;
    },
    candidates: function (id) {
      var own = byId.has(String(id)) ? [byId.get(String(id))] : [];
      var rest = recent.filter(function (value) {
        return own.indexOf(value) === -1;
      });
      return own.concat(rest);
    },
  };
}

/**
 * Create the session for one page visit.
 *
 * `deps.decrypt` is the one door a password goes through — the store's
 * `decrypt`, handed in by the controller — and `deps.isActive` is the
 * navigation guard the silent attempts honor. Everything the session keeps
 * lives in this closure alone: the password table, the map of decrypted
 * documents, the one attempt per document at a time, and the three
 * preferences.
 */
export function createSession(deps) {
  var passwords = createSessionPasswords();
  var decrypted = new Map();
  var listeners = [];
  var silent = new Map();

  /**
   * Open the sealed body of `id` with `password` through the store's door,
   * and remember the password when it authenticates — so the next sealed
   * page, or this one again, never asks twice.
   */
  function unlock(id, password) {
    return deps.decrypt(id, password).then(function (model) {
      if (model) {
        passwords.remember(id, password);
      }
      return model;
    });
  }

  /** Hand a decrypted document to every listener still registered. */
  function notifyDecrypted(doc) {
    listeners.slice().forEach(function (listener) {
      listener(doc);
    });
  }

  return {
    /** File the password that opened `id` (the table's own door). */
    remember: function (id, password) {
      passwords.remember(id, password);
    },
    /** The password that opened `id`, or `null`. */
    passwordFor: function (id) {
      return passwords.passwordFor(id);
    },
    /** What a silent attempt should try for `id`, newest first. */
    candidates: function (id) {
      return passwords.candidates(id);
    },
    /** Open `id` with `password`, remembering it when it authenticates. */
    unlock: unlock,
    /**
     * Record the model a password just opened, and let every listener hear
     * about it.
     */
    recordDecrypted: function (doc) {
      decrypted.set(doc.id, doc);
      notifyDecrypted(doc);
    },
    /**
     * Hear about every successful decryption, until the returned function
     * is called.
     */
    onDecrypted: function (listener) {
      listeners.push(listener);
      return function () {
        var index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    },
    /** The model a password has opened for `id`, or `null`. */
    decryptedDoc: function (id) {
      return decrypted.has(id) ? decrypted.get(id) : null;
    },
    /**
     * Try the passwords the session holds on the sealed `doc`, quietly, one
     * attempt at a time.
     *
     * A sealed document whose password the reader already entered — for
     * this document, or for any other the site seals under the same one —
     * opens without the reader typing a word. One attempt per document runs
     * at a time; a navigation away abandons the rest of the queue; and
     * nothing here ever writes the passwords anywhere but memory.
     */
    attemptSilentUnlock: function (doc) {
      if (!doc || !doc.id || silent.has(doc.id)) {
        return;
      }
      var candidates = passwords.candidates(doc.id);
      if (!candidates.length) {
        return;
      }

      var attempt = candidates.reduce(function (chain, password) {
        return chain.then(function (opened) {
          if (opened || (deps.isActive && !deps.isActive(doc.id))) {
            return opened;
          }
          return unlock(doc.id, password);
        });
      }, Promise.resolve(null));

      silent.set(doc.id, attempt);
      var forget = function () {
        silent.delete(doc.id);
      };
      attempt.then(forget, forget);
    },
    /** The explicit theme choice, or `null` to follow the OS. */
    theme: function () {
      var value = readStored(THEME_KEY);
      return value === "light" || value === "dark" ? value : null;
    },
    setTheme: function (theme) {
      writeStored(THEME_KEY, theme);
    },
    /** Whether the sidebar was put away on an earlier visit. */
    sidebarHidden: function () {
      return readStored(SIDEBAR_KEY) === "hidden";
    },
    setSidebarHidden: function (hidden) {
      writeStored(SIDEBAR_KEY, hidden ? "hidden" : "visible");
    },
    /** The sidebar view that was left showing on an earlier visit. */
    sideView: function () {
      return readStored(SIDE_VIEW_KEY) === "outline" ? "outline" : "docs";
    },
    setSideView: function (view) {
      writeStored(SIDE_VIEW_KEY, view);
    },
  };
}
