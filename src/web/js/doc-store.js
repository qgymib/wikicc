/**
 * The documents of a site, fetched on demand when the build split them into
 * files (`pages`), or served straight from the payload when it did not.
 *
 * The two output families hand the reader their documents differently. The
 * shell formats embed every document in the payload, so reading is a lookup.
 * The pages format embeds only a manifest — one `{id, title, hash}`
 * reference per document — and writes each document's model to its own JSON
 * file under `pages/`; this store turns that split into one interface, `get`,
 * which resolves with the document whether it was already on the page or had
 * to travel over the network.
 *
 * Loaded documents are cached in place, so a navigation back to a document the
 * reader has seen costs nothing, and a request that is already in flight is
 * shared rather than duplicated. A fetch that fails — a missing file, or the
 * site opened from `file://`, where browsers refuse every request — resolves
 * with `null` rather than rejecting, so the caller answers with a message
 * instead of an unhandled rejection.
 *
 * The chunk URL is the same percent-encoding the router uses for document
 * routes, one `encodeURIComponent` per `/`-separated segment, which is what
 * the build used for the file names. The manifest's per-document hash rides
 * along as a `?v=` query: a static host ignores the query and serves the file,
 * while a browser that still holds a cached chunk sees a different URL and
 * refetches after a redeploy.
 *
 * The search corpus of the pages format lives in one file as well; it is
 * fetched once, on the first global search, through the same cache-once rule.
 *
 * Encrypted documents travel sealed. Their payload entry carries an `enc`
 * blob instead of a body — the html, outline, blocks and plain text are
 * emptied by the build — and `decrypt` is the one door that opens one: the
 * password derives the key with the reader's own Web Crypto (`lock.js`),
 * the plaintext that authenticates replaces the sealed model in place, and
 * every listener registered through `onDecrypted` hears about it. A
 * password that does not authenticate answers `null` and leaves the cache
 * sealed; a `null` is also what a document that is not encrypted answers,
 * so a caller cannot be tricked into treating a public document as a
 * locked one.
 *
 * Pure: no DOM. The fetcher is injected, so `node --test` can drive it.
 */
import { encodeId } from "./router.js";
import * as Lock from "./lock.js";

/** Where the search corpus lives, relative to the page. */
export var SEARCH_CORPUS_PATH = "search.json";

/**
 * URL of the chunk of the document `id`.
 *
 * `hash` is the manifest's content hash for the document; without one the URL
 * is the bare path, which is what a caller that only wants the address needs.
 */
export function chunkPath(id, hash) {
  var url = "pages/" + encodeId(id) + ".json";
  if (hash) {
    url += "?v=" + hash;
  }
  return url;
}

/**
 * Create the document store for one payload.
 *
 * `bundle` is the payload the page carries: either the full site (documents
 * with their `html`) or the pages manifest (`mode` set to
 * `"pages"`, documents carrying `{id, title, hash}`). `fetchImpl` is the
 * function that retrieves a URL; it defaults to `globalThis.fetch` where one
 * exists and is required in the lazy mode, because without a way to fetch a
 * chunk no document beyond the first could ever appear.
 */
export function createDocStore(bundle, fetchImpl) {
  var lazy = !!bundle && bundle.mode === "pages";
  var fetch_ = fetchImpl || globalThis.fetch;
  var docs = Array.isArray(bundle && bundle.docs) ? bundle.docs : [];
  var byId = new Map(
    docs.map(function (doc) {
      return [doc.id, doc];
    }),
  );
  var inflight = new Map();
  var corpus = null;
  var decryptedListeners = [];

  /** The document `id`, or `null` when the payload does not hold it. */
  function embedded(id) {
    var doc = byId.get(id);
    return doc && typeof doc.html === "string" ? doc : null;
  }

  /**
   * The title the payload records for `id`, or `null` when it does not.
   *
   * In the pages format the manifest carries one `{id, title, hash}` entry per
   * document long before its chunk is fetched, so the preview panel can name a
   * document it is still loading instead of showing an empty head.
   */
  function titleOf(id) {
    var entry = byId.get(id);
    return entry && typeof entry.title === "string" && entry.title
      ? entry.title
      : null;
  }

  /** Fetch, parse and cache the chunk of `id`; resolves `null` on failure. */
  function load(id) {
    var known = embedded(id);
    if (known) {
      return Promise.resolve(known);
    }

    if (!lazy) {
      // A document the embedded payload does not hold does not exist; no
      // request could produce it.
      return Promise.resolve(null);
    }

    var running = inflight.get(id);
    if (running) {
      return running;
    }

    var entry = byId.get(id) || {};
    var request = Promise.resolve()
      .then(function () {
        return fetch_(chunkPath(id, entry.hash));
      })
      .then(function (response) {
        if (!response || !response.ok) {
          return null;
        }
        return response.json();
      })
      .then(function (chunk) {
        if (chunk && typeof chunk.html === "string" && chunk.id) {
          byId.set(id, chunk);
          return chunk;
        }
        return null;
      })
      .catch(function (_error) {
        // A failed navigation answers "not loaded", which the caller turns
        // into a message; the next attempt may try again.
        return null;
      })
      .then(function (result) {
        inflight.delete(id);
        return result;
      });
    inflight.set(id, request);

    return request;
  }

  /**
   * Open the sealed body of `id` with `password`.
   *
   * The chunk travels first when the build split the site — a sealed
   * document is no different from any other until it is on hand. The
   * plaintext that authenticates becomes the document's full model in
   * place of the sealed one, and the listeners hear about it; a password
   * that does not authenticate answers `null` and the cache stays sealed.
   * A document that is not encrypted, or is unknown, answers `null` too.
   */
  function decryptDoc(id, password) {
    return Promise.resolve()
      .then(function () {
        return load(id);
      })
      .then(function (doc) {
        if (!doc || !doc.enc) {
          return null;
        }
        return Lock.unlock(doc.enc, password, id);
      })
      .then(function (body) {
        if (body === null) {
          return null;
        }

        var entry = byId.get(id) || {};
        var full = {
          id: id,
          path: typeof entry.path === "string" ? entry.path : id,
          title: typeof entry.title === "string" ? entry.title : "",
          html: typeof body.html === "string" ? body.html : "",
          toc: Array.isArray(body.toc) ? body.toc : [],
          blocks: Array.isArray(body.blocks) ? body.blocks : [],
          text: typeof body.text === "string" ? body.text : "",
        };
        byId.set(id, full);
        notifyDecrypted(full);
        return full;
      });
  }

  /** Hand a decrypted document to every listener still registered. */
  function notifyDecrypted(doc) {
    decryptedListeners.slice().forEach(function (listener) {
      listener(doc);
    });
  }

  /** Fetch, parse and cache the search corpus; resolves `null` on failure. */
  function fetchCorpus() {
    if (!lazy) {
      // The embedded payload is its own corpus.
      return Promise.resolve(null);
    }

    if (corpus) {
      return corpus;
    }

    corpus = Promise.resolve()
      .then(function () {
        return fetch_(SEARCH_CORPUS_PATH);
      })
      .then(function (response) {
        if (!response || !response.ok) {
          return null;
        }
        return response.json();
      })
      .then(function (parsed) {
        return parsed && Array.isArray(parsed.docs) ? parsed.docs : null;
      })
      .catch(function (_error) {
        return null;
      });

    return corpus;
  }

  return {
    /** Whether the documents are separate files fetched on demand. */
    isLazy: function () {
      return lazy;
    },
    /** The document `id` when it is already on hand, `null` otherwise. */
    peek: function (id) {
      return embedded(id);
    },
    /** The manifest's title for `id`, `null` when the payload does not name it. */
    title: function (id) {
      return titleOf(id);
    },
    /** The document `id`, fetched first when the build split the site. */
    get: function (id) {
      return load(id);
    },
    /** Whether `id`'s body is sealed: the payload carries no plaintext for it. */
    isEncrypted: function (id) {
      var entry = byId.get(id);
      return !!entry && !!entry.enc;
    },
    /**
     * Open the sealed body of `id` with `password`.
     *
     * Resolves the full model when the password authenticates — from then
     * on the document reads like a never-encrypted one — and `null` when
     * it does not. Everything the reader cannot fix by retyping (a format
     * it does not speak, a context without Web Crypto) rejects.
     */
    decrypt: function (id, password) {
      return decryptDoc(id, password);
    },
    /**
     * Hear about every successful decryption, until the returned function
     * is called.
     */
    onDecrypted: function (listener) {
      decryptedListeners.push(listener);
      return function () {
        var index = decryptedListeners.indexOf(listener);
        if (index !== -1) {
          decryptedListeners.splice(index, 1);
        }
      };
    },
    /** The search corpus records, fetched once; `null` for the embedded payload. */
    corpus: function () {
      return fetchCorpus();
    },
  };
}
