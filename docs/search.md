# Search — how to find things in the reader

The reader ships a search panel that looks through the titles, the chapter
outlines, the front matter descriptions and the body text of every document
in the folder. This page describes
how to use it and what a query means; `docs/design.md` describes how the reader
is built.

## Opening the panel

The panel is not on the page by default. Ask for it with the **Search
documents** button at the top of the right-hand rail, or press
<kbd>Ctrl</kbd>+<kbd>F</kbd>
(<kbd>Cmd</kbd>+<kbd>F</kbd> on macOS). It goes away again on
<kbd>Escape</kbd>, on a click anywhere outside it, or when you pick a result
with the field's open gesture.

## Typing a query

Every pause in typing is a query: the results list updates as you type, about
a tenth of a second after your hand stops. There is no search button to press.

The **scope button** at the right edge of the field names the scope in force.
A search starts in **Local** scope — the document you are reading. Pressing
the button switches to **Global** scope, which reads every document the site
holds; the choice lasts as long as the panel does. Switching the scope runs
the query again at once.

In the pages format the whole-site text lives in one `search.json` next
to the page, and the first global search fetches it — once; after that the
answers are as instant as they are in the other formats. Searching the
document you are reading never waits: that text arrived with the document
itself. The first global search shows *Loading…* where the results will
appear, and the answer replaces it when the corpus lands.

## Reading the results

The list shows **one row per place** the query is found, not one row per
document: each row carries the passage around a hit, with the hit emphasised,
and the file it was found in. Rows are ordered by relevance — a hit in a
document's title outranks one in a chapter heading or the front matter
description, which outrank one in the body — and the hits of one document stay
together.

Selecting is deliberate: click a row (or move with <kbd>↑</kbd>/<kbd>↓</kbd>,
<kbd>Home</kbd>/<kbd>End</kbd>) and the preview below the list shows the whole
document with **every place the query occurs** marked, the selected one
standing out. Opening the document is a firmer gesture: **double-click** the
row, or press <kbd>Enter</kbd>, and the reader navigates to that document at
that passage — the article opens with the query's occurrences marked the same
way, the passage you picked standing out. A mark covers what you typed and no
more: query `instal` and "installation" is marked over its first six letters
alone, the tail of the word left unmarked. The marks are the arrival's, not
the reading's: they go when you navigate on. A row whose match is in the title,
the outline or the description alone has no passage in the body to land on;
that document opens at its top. The row's passage itself falls back the same
way: a document that declares a front matter `description` shows it as the row
summary when the body holds no hit, then the outline, then just the file path.

## Query syntax

| You type | What it finds |
| --- | --- |
| `bearing` | The whole word "bearing" and any word that begins with it ("bearings", "bearing housing"), in any case. |
| `gear ratio` | Documents where **both** words appear. Spaces separate words, and every word has to be found. |
| `齿轮箱` | The three characters **consecutively**, as written. A text that holds only "齿轮" elsewhere and "箱" elsewhere is not a hit. |
| `齿` | Any text holding the character — a single character is matched on its own. |

The rules behind the table:

- **Case does not matter.** `Bearing`, `bearing` and `BEARING` are the same
  query.
- **A word matches whole words and their prefixes.** `instal` finds
  "install", "installation" and "instalment". This applies to words written in
  letters and digits; there is no fuzzy matching and no wildcards.
- **A multi-character CJK query is a phrase.** Chinese (and the other Han
  scripts) is written without spaces, so the reader takes the characters you
  typed as the phrase you meant: what is found is where they appear together,
  in the order you typed them. To look for two separate ideas, put a space
  between them — `齿轮 箱体` — and each part is then matched on its own.
- **A single CJK character is its own query.** One character has no phrase to
  preserve, so it is found wherever it occurs, inside longer words included.
- **Punctuation separates.** Spaces, punctuation and symbols between two runs
  of characters break the phrase the same way a space does: `gear.ratio` is
  the two-word query `gear ratio`.

## Encrypted documents

A document whose front matter asks for encryption is sealed in the artifact,
and the search respects that seal:

- **Before the unlock, only the title is searchable.** The title is public —
  the lock page shows it — so a query that matches it produces a row marked
  **Locked**, and the preview below the list explains that the document is
  encrypted instead of showing a passage. Opening the row navigates to the
  document, which arrives on its lock page, and entering the password there
  renders the article. A word from the body finds nothing until the unlock.
- **After the unlock, the document is ordinary.** The same query now reaches
  the chapter headings and the body: rows carry their passages, the preview
  marks the hits, and Enter lands on the passage as always. The unlocked
  state lasts for the page session only — reloading the page relocks the
  document, and search falls back to titles alone.

The build keeps the body out of the corpus entirely: in the `pages` format
the fetched `search.json` names a sealed document by its title alone, so no
body text reaches the browser before an unlock.

## What the panel never does

- It does not rank by position or count only: a hit in a title always leads,
  however early or late it sits in the body.
- It does not search code blocks or diagram sources for highlighting: a hit
  inside one is still a real result in the list, and selecting it scrolls the
  preview to the block that holds it, but the preview leaves those subtrees
  as authored so a rendered diagram is never turned back into source. Inline
  code — a `code` span inside a line of prose — is ordinary text to the
  highlight, and its hits are marked like any other. Rows after an unmarked
  hit still land on their own places — the block holds the hit's place in
  the order, whether or not it is marked.
- It does not hold on to your query: clearing the field (the clear button at
  the left of the scope button, or deleting the text) empties the list and the
  preview, and closing the panel forgets the query.
