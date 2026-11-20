# TODO

Candidate features for future releases, arranged as a roadmap: the work
gathered for the next release, the items queued behind it, and the sketches
held without a date. An item starts as a sketch of its own and moves between
the lanes as its scope is judged; it leaves the list when it ships — the
commit history records what was built, so completed work never rests here.
The lanes pace the list against the release cycle; they are not a promise
about any version.

## Next release

- **Image lightbox.** The content viewer carries Mermaid diagrams alone —
  `diagram-view.js` is its only provider — while images render as plain
  elements. Give images the same hover frame and lightbox (zoom, pan, reset),
  reusing the panzoom machinery the viewer already embeds.
- **Search hit navigation.** The article marks every occurrence of the query
  the arrival carried; controls to walk those marks — next, previous, a
  counter — would close the loop inside long documents.
- **Reading position memory.** `session.js` keeps the session state; returning
  to a document through back and forward could restore the scroll position it
  was left at.

## Later releases

- **Generated index page.** Without `home` the reader falls back to the first
  document; a generated table-of-contents page could greet the reader instead.

## Unscheduled

- **`--watch` incremental rebuild.** Every run rebuilds the whole folder —
  `docs/design.md` records this as the "no incremental build" constraint. A
  watch mode that rebuilds on file changes (optionally with live reload)
  would close the writer's loop.
- **Optional HTML sanitizer.** Raw HTML passes through unchanged because the
  input is trusted; an opt-in sanitizer would widen what inputs are safe to
  compile.
- **Custom stylesheet.** A `.wikicc.json` key that injects site CSS into the
  page, travelling through the same shell as the theme.
