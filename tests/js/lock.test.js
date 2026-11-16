/**
 * Tests for `src/web/js/lock.js`: the reader's decrypting door.
 *
 * The heart of the file is the committed interop vectors: sealings whose
 * bytes `src/crypto.rs` hardcodes too (`interop_vectors()` in its test
 * module). The Rust suite opens them with the build-side implementation,
 * this suite opens the very same constants with the Web Crypto the reader
 * ships — so a parameter that drifts on either side (the hash, the
 * iteration count, the tag order, the UTF-8 spelling of passwords) fails
 * its own suite, and the two implementations stay byte-compatible without
 * either depending on the other's runtime.
 *
 * Everything around them is the reader's own contract: a wrong password,
 * a mismatched document id and altered bytes answer `null` — one answer,
 * the same one the build side gives — while parameters the reader cannot
 * fix by retyping are rejections that name the problem. The derived-key
 * cache hands back the derivation it already started, and the session
 * password table is a plain in-memory map that never touches storage.
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as Lock from "../../src/web/js/lock.js";

/**
 * The id the first two vectors are bound to — the build seals with the
 * document id as the AES-GCM additional data, and the front-end fixtures
 * reuse this id so the same constants serve every layer.
 */
const INTRO_ID = "guide/intro.md";

/** The id the third vector is bound to. */
const OTHER_ID = "guide/other.md";

/** The ASCII-password vector: the shipped iteration count, an English body. */
const ASCII_VECTOR = {
  v: 1,
  kdf: "pbkdf2-sha256",
  iters: 600000,
  salt: "AAECAwQFBgcICQoLDA0ODw==",
  nonce: "oKGio6Slpqeoqaqr",
  ct: "Ot7jawfrLAgrtf9BzAo4ToeFtOQhRqosE6+NwQ+xpHKqnVdyzIOv/NfjzoCnKpHC+WPp4Cz1RkYxSUHalQR/lvIbXvOm6+eIDQuTQR6uSs91CCHv3xw0",
};
const ASCII_PASSWORD = "reader unlock";
const ASCII_BODY = {
  html: "<p>sealed body</p>",
  toc: [],
  blocks: [],
  text: "sealed body",
};

/** The UTF-8-password vector bound to `INTRO_ID`. */
const UTF8_INTRO_VECTOR = {
  v: 1,
  kdf: "pbkdf2-sha256",
  iters: 600000,
  salt: "EBESExQVFhcYGRobHB0eHw==",
  nonce: "sLGys7S1tre4ubq7",
  ct: "FdagYCNSGn2CfXUj43AcxGe/uvxMLy0VH4U/18evqxKAIAcqJPR1NabxtlrnYoUnGJefjCc/TROQPdMXpo/eVe5UoWQ7K26y9P+/pSWha4gzM5bA+GF8xRSXnA1x4auaYpG4OMQJZm3cZ3+bfWV+G7/p9Yc2s0shQb16Amq8yeJMwos8Uj/uIfxkjTS1FH9PshBkceKsQ46A73b2wvGyLcjJekcz2Pi7gndVRJVs73pszogDQk8iQbiSz/ISVb/wV8r0cQH8vlfHQFqyLtLFRfZSGeB8vEKGrQlAj00EiMWkx9NnhwzwqrnvuHy4GFte0fJhmUieET7Jnvkm3wjEFi0Y/F9HaI+IbzUv7gxDhYbNVrKBRp/ji2OPb+NVUMN4vXgNPBpb/mnrWRFD4Gc9EGZxGX1ULQ==",
};
/** The UTF-8-password vector bound to `OTHER_ID` — the same password. */
const UTF8_OTHER_VECTOR = {
  v: 1,
  kdf: "pbkdf2-sha256",
  iters: 600000,
  salt: "ICEiIyQlJicoKSorLC0uLw==",
  nonce: "wMHCw8TFxsfIycrL",
  ct: "OH0yPKUuQm3nBjfjjxk27eenmLO5yntFrYoZc2X508M0aVGiD7n5djyHsLg4ozn8WpYOduZNxGruKOS6/E239D+h7zKJkC8oDlDIRaOuceMC0FJrfdI/GLc5K5axNHdGJnkiXH7SRg==",
};
const UTF8_PASSWORD = "密码 secret";
const UTF8_INTRO_BODY = {
  html: '<h2 id="getting-started">Getting Started</h2><p>intro body</p>',
  toc: [
    {
      id: "getting-started",
      text: "Getting Started",
      level: 2,
      children: [],
    },
  ],
  blocks: [
    {
      id: "getting-started",
      level: 2,
      parent: null,
      html: "<p>intro body</p>",
      subtree: [0],
    },
  ],
  text: "getting started intro body",
};
const UTF8_OTHER_BODY = {
  html: "<p>另一篇 已密封</p>",
  toc: [],
  blocks: [],
  text: "另一篇 已密封",
};

test("the committed ASCII vector opens to the canonical JSON body", async () => {
  const body = await Lock.unlock(ASCII_VECTOR, ASCII_PASSWORD, INTRO_ID);

  assert.deepEqual(body, ASCII_BODY);
});

test("the committed UTF-8 vectors pin the encoding of passwords and content", async () => {
  const intro = await Lock.unlock(UTF8_INTRO_VECTOR, UTF8_PASSWORD, INTRO_ID);
  const other = await Lock.unlock(UTF8_OTHER_VECTOR, UTF8_PASSWORD, OTHER_ID);

  assert.deepEqual(intro, UTF8_INTRO_BODY);
  assert.deepEqual(other, UTF8_OTHER_BODY);
});

test("a wrong password resolves null", async () => {
  const body = await Lock.unlock(UTF8_INTRO_VECTOR, "wrong password", INTRO_ID);

  assert.equal(
    body,
    null,
    "authentication failure is one answer, whatever the reason",
  );
});

test("a mismatched document id resolves null", async () => {
  const body = await Lock.unlock(UTF8_INTRO_VECTOR, UTF8_PASSWORD, OTHER_ID);

  assert.equal(
    body,
    null,
    "the tag binds the ciphertext to the document it was sealed for",
  );
});

/** Flip the byte at `index` of a base64 payload, keeping it valid base64. */
function flipBase64Byte(encoded, index) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let position = 0; position < binary.length; position += 1) {
    bytes[position] = binary.charCodeAt(position);
  }
  bytes[index] ^= 0x01;
  let flipped = "";
  for (let position = 0; position < bytes.length; position += 1) {
    flipped += String.fromCharCode(bytes[position]);
  }
  return btoa(flipped);
}

test("altered bytes resolve null", async () => {
  // One byte off the ciphertext body and one off the tag: both stay valid
  // base64, both must fail to authenticate.
  const ct = UTF8_INTRO_VECTOR.ct;
  const decoded = atob(ct);
  const flippedBody = Object.assign({}, UTF8_INTRO_VECTOR, {
    ct: flipBase64Byte(ct, 0),
  });
  const flippedTag = Object.assign({}, UTF8_INTRO_VECTOR, {
    ct: flipBase64Byte(ct, decoded.length - 1),
  });

  assert.equal(await Lock.unlock(flippedBody, UTF8_PASSWORD, INTRO_ID), null);
  assert.equal(await Lock.unlock(flippedTag, UTF8_PASSWORD, INTRO_ID), null);
});

test("parameters the reader cannot fix by retyping are rejections", async () => {
  const cases = [
    {
      blob: null,
      pattern: /missing/,
    },
    {
      blob: Object.assign({}, UTF8_INTRO_VECTOR, { v: 2 }),
      pattern: /version/,
    },
    {
      blob: Object.assign({}, UTF8_INTRO_VECTOR, { kdf: "argon2" }),
      pattern: /key-derivation/,
    },
    {
      blob: Object.assign({}, UTF8_INTRO_VECTOR, { iters: 0 }),
      pattern: /iteration count/,
    },
    {
      blob: Object.assign({}, UTF8_INTRO_VECTOR, { iters: "many" }),
      pattern: /iteration count/,
    },
    {
      blob: Object.assign({}, UTF8_INTRO_VECTOR, { salt: "not base64!" }),
      pattern: /not base64/,
    },
    {
      blob: Object.assign({}, UTF8_INTRO_VECTOR, {
        salt: "EBESExQVFhcYGRobHB0e",
      }),
      pattern: /do not fit the format/,
    },
    {
      blob: Object.assign({}, UTF8_INTRO_VECTOR, {
        nonce: "sLGys7S1tre4ubq",
      }),
      pattern: /do not fit the format/,
    },
    {
      blob: Object.assign({}, UTF8_INTRO_VECTOR, {
        ct: "AAAA",
      }),
      pattern: /do not fit the format/,
    },
  ];

  for (const { blob, pattern } of cases) {
    await assert.rejects(
      Lock.unlock(blob, UTF8_PASSWORD, INTRO_ID),
      pattern,
      JSON.stringify(blob),
    );
  }
});

test("a derivation is shared by the inputs that asked for it", async () => {
  const salt = new Uint8Array([1, 2, 3]);
  const first = Lock.deriveKey("same password", salt, 1000);
  const second = Lock.deriveKey("same password", salt, 1000);
  const otherSalt = Lock.deriveKey(
    "same password",
    new Uint8Array([4, 5]),
    1000,
  );

  assert.equal(
    first,
    second,
    "one derivation per password, salt and iteration count",
  );
  assert.notEqual(first, otherSalt, "a different salt derives on its own");

  const key = await first;
  const again = await Lock.deriveKey("same password", salt, 1000);
  assert.equal(key, again, "the resolved key is remembered too");
});

test("the session password table answers to the document and the order", () => {
  const session = Lock.createSessionPasswords();

  assert.equal(session.passwordFor("a.md"), null, "the session starts empty");
  assert.deepEqual(session.candidates("a.md"), [], "nothing to try silently");

  session.remember("a.md", "first");
  session.remember("b.md", "second");
  session.remember("a.md", "revised");

  assert.equal(session.passwordFor("a.md"), "revised");
  assert.equal(session.passwordFor("b.md"), "second");
  assert.deepEqual(
    session.candidates("b.md"),
    ["second", "revised", "first"],
    "its own password first, then the others newest first",
  );
  assert.deepEqual(
    session.candidates("c.md"),
    ["revised", "second", "first"],
    "a stranger document tries the session newest first",
  );
  assert.deepEqual(
    session.candidates("a.md"),
    ["revised", "second", "first"],
    "the document's own password is never tried twice",
  );
});
