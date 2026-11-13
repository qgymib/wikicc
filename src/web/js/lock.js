/**
 * Unlocking sealed documents with the Web Crypto the browser already has.
 *
 * The build seals a document's body with PBKDF2-HMAC-SHA256 (the iteration
 * count the artifact carries) and AES-256-GCM, binding the document id into
 * the tag as the additional data. Everything the reader needs travels in the
 * artifact: `{v, kdf, iters, salt, nonce, ct}`, all base64 but the version,
 * where `ct` is `ciphertext || tag` — the same byte order Web Crypto's
 * AES-GCM produces, so no rearrangement happens on this side.
 *
 * `unlock` is the one decrypting door. It answers `null` when the password
 * does not authenticate — the same single answer the build side gives for a
 * wrong password, a mismatched document id and altered bytes — and rejects
 * for everything the reader cannot fix by retyping: a version or KDF it does
 * not speak, parameters that do not fit the format, or a context without
 * Web Crypto. The salt, the nonce and the iteration count are public by
 * nature; the security of a sealed document rests on the password alone.
 *
 * Two pieces of session state live here, both memory-only. Derived keys are
 * remembered by the exact inputs that produced them, so unlocking the same
 * document twice (a silent retry, a re-render) does not pay for another
 * key-derivation pass; the per-document salt of the build means a shared
 * password still derives once per document, which is the price the
 * unlinkability of two sealed documents asks. And the passwords a reader has
 * entered are kept in a plain `Map` — never in `localStorage`,
 * `sessionStorage` or a cookie — so a refresh forgets them all.
 *
 * Pure: no DOM. Node's own Web Crypto answers `node --test`, which is what
 * keeps the interop with the build side tested without a browser.
 */

/** The format version this reader opens, as the artifact carries it. */
export var FORMAT_VERSION = 1;

/** The key-derivation function identifier this reader opens. */
export var KDF_NAME = "pbkdf2-sha256";

/** Length of the derived AES-256 key, in bits. */
var KEY_BITS = 256;

/** Length of the AES-GCM authentication tag, in bits. */
var TAG_BITS = 128;

/** Length of the per-document salt the key is derived with, in bytes. */
export var SALT_BYTES = 16;

/** Length of the AES-GCM nonce, in bytes. */
export var NONCE_BYTES = 12;

/** Length of the authentication tag that trails every ciphertext, in bytes. */
var TAG_BYTES = 16;

/** The derived keys, remembered by the exact inputs that produced them. */
var keyCache = new Map();

/** The UTF-8 spelling of passwords and plaintexts, and the only one. */
var textEncoder = new TextEncoder();

/** The engine the reader decrypts with, or `null` where Web Crypto is not. */
function subtle() {
  return typeof globalThis.crypto === "object" &&
    globalThis.crypto !== null &&
    globalThis.crypto.subtle
    ? globalThis.crypto.subtle
    : null;
}

/** Encode `bytes` as base64, for the cache key of a derived key. */
function encodeBase64(bytes) {
  var binary = "";
  for (var index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

/** Decode `encoded` base64 into bytes, or `null` when it does not decode. */
function decodeBase64(encoded) {
  try {
    var binary = atob(String(encoded));
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
 * Derive the AES-256 key `password` opens `salt` with, in `iters` rounds.
 *
 * The derivation runs on the engine's thread and blocks nothing the reader
 * does, but it is not cheap — hundreds of milliseconds at the shipped count
 * — so the answer is remembered by the exact inputs: the same password over
 * the same salt at the same count hands back the derivation it started, and
 * callers awaiting the same parameters share one pass.
 */
export function deriveKey(password, salt, iters) {
  var cacheKey = password + "\u0000" + iters + "\u0000" + encodeBase64(salt);
  if (keyCache.has(cacheKey)) {
    return keyCache.get(cacheKey);
  }

  var engine = subtle();
  if (!engine) {
    var unavailable = Promise.reject(
      new Error("Web Crypto is not available in this context"),
    );
    keyCache.set(cacheKey, unavailable);
    return unavailable;
  }

  var key = engine
    .importKey("raw", textEncoder.encode(password), "PBKDF2", false, [
      "deriveKey",
    ])
    .then(function (baseKey) {
      return engine.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iters },
        baseKey,
        { name: "AES-GCM", length: KEY_BITS },
        false,
        ["decrypt"],
      );
    });
  keyCache.set(cacheKey, key);
  return key;
}

/**
 * Open the sealed body `blob` with `password`.
 *
 * `blob` is the artifact's `enc` field: `{v, kdf, iters, salt, nonce, ct}`.
 * The tag is expected to authenticate under the key `password` derives and
 * the additional data `docId` — the document id the build bound in — and
 * the plaintext that authenticates is the canonical JSON body, returned
 * parsed: `{html, toc, blocks, text}`. A password that does not
 * authenticate answers `null`, whatever the reason; everything else is a
 * rejection naming the problem.
 */
export function unlock(blob, password, docId) {
  if (!blob || typeof blob !== "object") {
    return Promise.reject(new Error("the sealed blob is missing"));
  }
  if (blob.v !== FORMAT_VERSION) {
    return Promise.reject(
      new Error("sealed format version " + blob.v + " is not supported"),
    );
  }
  if (blob.kdf !== KDF_NAME) {
    return Promise.reject(
      new Error("key-derivation function " + blob.kdf + " is not supported"),
    );
  }
  var iters = blob.iters;
  if (typeof iters !== "number" || !Number.isInteger(iters) || iters <= 0) {
    return Promise.reject(new Error("the sealed iteration count is not valid"));
  }

  var salt = decodeBase64(blob.salt);
  var nonce = decodeBase64(blob.nonce);
  var ct = decodeBase64(blob.ct);
  if (!salt || !nonce || !ct) {
    return Promise.reject(new Error("the sealed parameters are not base64"));
  }
  if (
    salt.length !== SALT_BYTES ||
    nonce.length !== NONCE_BYTES ||
    ct.length < TAG_BYTES
  ) {
    return Promise.reject(
      new Error("the sealed parameters do not fit the format"),
    );
  }

  var engine = subtle();
  if (!engine) {
    return Promise.reject(
      new Error("Web Crypto is not available in this context"),
    );
  }

  return deriveKey(password, salt, iters)
    .then(function (key) {
      return engine.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: textEncoder.encode(String(docId)),
          tagLength: TAG_BITS,
        },
        key,
        ct,
      );
    })
    .catch(function (_error) {
      // Authentication failed: a wrong password, a mismatched document id
      // and altered bytes are one answer here, exactly as the build side
      // treats them — and one answer is all a reader can act on.
      return null;
    })
    .then(function (plaintext) {
      if (plaintext === null) {
        return null;
      }
      return JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext)));
    });
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
