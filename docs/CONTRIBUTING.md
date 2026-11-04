# wikicc — Development rules

These rules bind every commit, not just the ones that change behaviour. They are
kept here rather than in `README.md` so that the product description stays a
description of the product: the architecture lives in
[`design.md`](design.md), the test suite in [`../tests/README.md`](../tests/README.md),
and the obligations a change has to meet live in this document.

## Quality gates

Every commit is expected to leave the quality gates green — run them locally
before committing, and again in CI, where
[`../.github/workflows/lint.yml`](../.github/workflows/lint.yml) runs them on
every push and pull request:

```sh
cargo fmt --check                          # Rust formatting
cargo clippy --all-targets -- -D warnings  # Rust lint
npm run check                              # JS formatting and lint (Biome)
cargo test                                 # the whole suite
```

`npm run check` covers the reader's own JavaScript — the modules in
`src/web/js`, the tests in `tests/js` and the scripts in `tools`, as scoped by
`biome.jsonc` — and fails on a formatting difference or a lint violation;
third-party code under `node_modules` is never touched. `npm run format`
rewrites the formatting in place and `npm run lint` runs only the lint half.
The gates and the suite they protect are described further in
[`../tests/README.md`](../tests/README.md).

A gate that has to be skipped is a reason not to commit, not a reason to commit
with a warning.

## The Windows icon

`docs/logo.svg` is the design source of the executable icon;
`docs/logo.ico` is a derived asset, rendered from it and committed, so that
the build needs no image toolchain. **After changing the design source, the
icon has to be rendered again:**

1. Render `docs/logo.svg` to square PNGs named `logo-<size>.png`, with
   `<size>` in 16, 24, 32, 48, 64, 128 and 256. Any renderer will do; the
   sizes have to match exactly.
2. Pack them into the icon:

   ```sh
   node tools/make-icon.mjs <png-dir> docs/logo.ico
   ```

3. Rebuild. `tools/make-icon.mjs` refuses a PNG whose size does not match its
   name, so an incomplete set is caught before the icon is written.

The source and the derived asset must never be committed out of step: a change
to `docs/logo.svg` carries the regenerated `docs/logo.ico` in the same commit.
