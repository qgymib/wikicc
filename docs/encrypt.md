# Encrypted documents — how sealing works

A document can ask the build to seal it: the artifact carries the body as
authenticated ciphertext, and the reader locks the article behind a password.
This page describes how to mark a document, how the password travels from a
build to a reader, and what stays public; the algorithm, the build-side
mechanics and the boundaries of the scheme follow for reference. The product
summary lives in `README.md`, the architecture in `docs/design.md`.

## Marking a document

A document's front matter can ask the build to seal it. The key is `encrypt`:

| Front matter | Meaning |
| --- | --- |
| *(no key)*, `encrypt: false`, `encrypt:` | Build the document as usual |
| `encrypt: true` | Seal it with the global password |
| `encrypt: "secret"` | Seal it with this document's own password |
| anything else (`encrypt: ""`, a number, a list, invalid YAML) | Fail the build with an error naming the document |

```markdown
---
title: Private notes
encrypt: true
---

Nobody reads this without the password.
```

A document with a password of its own unlocks independently of every other
sealed document; `encrypt: true` documents share one password, so the reader
never asks for the same one twice in a session.

## Providing the password

The global password takes the same three sources as every setting, in the
same order — `--password` over `WIKICC_PASSWORD` over the configuration
file's `password` key.

```sh
WIKICC_PASSWORD="opensesame" wikicc path/to/docs
wikicc path/to/docs --password "opensesame" # works, but the password lands in the shell history
```

A document that asks for encryption and finds no password anywhere fails the
build: exit code 1, the error names the document on stderr, and nothing is
written, whatever `--strict` says. There is no plaintext fallback — a build
never ships a sealed declaration unsealed.

Two details about the sources:

- A command line `--password` stays in the shell history and the process
  list, so prefer `WIKICC_PASSWORD`.
- The variable's value is trimmed, which makes the configuration file the
  only source that can carry a password with leading or trailing whitespace
  (its values are read verbatim).

## What stays public

**The title stays public.** The lock page, the sidebar, the link graph and
search all show the title; search reaches the body only after the reader
unlocks the document — before that, a query matching the title finds a row
marked *Locked*, and afterwards the document is ordinary
([search](search.md) describes the two halves). What the lock page shows is
exactly what the artifact leaks: the id and the title, the same metadata the
reader uses everywhere.

## The reader

The reader shows a locked document on a lock page that carries the password
field itself — the reader types where they stand, and a correct password
renders the article in place. The form answers only after the reader has
silently tried the passwords the session already holds, so documents sealed
with one password never ask twice within a session. A reference to a sealed
chapter offers the same field inside its hover preview, so the unlock happens
where the reading happens.

Unlocked passwords live in the session's memory alone — nothing is written
to `localStorage`, `sessionStorage` or a cookie — so reloading the page
relocks every document, and a fresh session asks again.

## Threat model

The scheme protects artifacts at rest: a copied `single-html` file, a
published `pages` folder, an `html-dir` archive — opened in a text editor
they show no body, no chapter structure and no password. It does not protect
the source folder — the Markdown files and the password a build was handed
live in the clear on the machine that builds — and it does not protect
anything against a reader who holds the password.

**The password is the security.** The salt, the nonce and the iteration
count are public parameters that weaken nothing; a short password does.

## Algorithm and parameters

- **AES-256-GCM** seals the body. The cipher is authenticated, so a wrong
  password, a wrong document binding and a tampered byte are one and the
  same failure, and the ciphertext layout is `ciphertext || 16-byte tag` —
  what both the RustCrypto crate and the Web Crypto API emit.
- **PBKDF2-HMAC-SHA256** derives the 256-bit key from the password and the
  salt, at 600,000 iterations (the OWASP recommendation).
- **Per-document parameters.** Every sealed document gets a fresh random
  16-byte salt and 12-byte nonce at build time, so the derivation input never
  repeats across documents or builds.
- **AAD binding.** The document id travels as the AES-GCM `additionalData`,
  so a ciphertext cannot be transplanted into another document's blob.
- **Plaintext shape.** The sealed plaintext is the whole document model —
  canonical JSON `{html, toc, blocks, text}` — so a sealed article leaks
  neither body nor chapter structure; the title stays public metadata.
- **Format version.** The sealed blob leads with its own `v`, the crypto
  format's version, checked where the blob is opened.

The two ends interoperate over one parameter set, pinned by fixed interop
vectors committed to both test suites (`src/crypto.rs` and
`tests/js/lock.test.js`): either side drifting fails both at once. `file://`
pages are a trustworthy context in Chrome, Edge and Firefox, so
`crypto.subtle` is available and the scheme needs no JavaScript fallback.

## The build side

`encrypt.rs` reads the `encrypt` field out of the raw front-matter text the
markdown AST carries — extracted during the one markdown parse, no second
pass — against the strict matrix above. The global password comes from the
three sources in their precedence.

The sealing pass runs on the assembled bundle, after the favicon
registration and before the diagnostics are reported. It empties the four
content fields of a sealed `DocModel`, writes the blob into its `enc` field,
and leaves `edges` and every public metadata alone. The payload shapes stay
optional: `DocModel.enc`, `ManifestDoc.enc` and `ChunkPayload.enc` are
skipped when unset, so a site without encryption serialises byte-identically
to a build that never heard of the feature, and the `search.json` entry of a
sealed document carries `{id, title}` alone, so no body text reaches the
browser before an unlock.

## The asset boundary

A sealed document is self-contained. Before the body is encrypted, its own
asset placeholders — in the body and in every chapter block — are expanded
into `data:` URIs built from the asset table's MIME type and bytes, the
construction the `single-html` writer inlines with, so the sealed body is
self-contained and renders its images natively once unlocked. After all
documents are sealed, the asset table is pruned to what the public documents
and the favicon still address, and `stats.assets` and `stats.asset_bytes`
are decremented to match:

- an asset referenced only by sealed documents travels inside the ciphertext
  and is not written to the artifact at all;
- an asset shared with a public document is written once, for the public
  reference, and the decrypted body carries its own embedded copy besides.

## Performance

The 600,000-iteration PBKDF2 runs once per sealed document. Derivation takes
seconds under an unoptimized profile, so `sha2` and `pbkdf2` compile at
opt-level 3 in the dev and test profiles — a release build derives in
milliseconds.
