# Search — how to find things in the reader

The reader ships a search panel that looks through the titles, the chapter
outlines and the body text of every document in the folder. This page describes
how to use it and what a query means; `docs/design.md` describes how the reader
is built.

## Opening the panel

The panel is not on the page by default. Ask for it with the **Search
documents** button in the toolbar, or press <kbd>Ctrl</kbd>+<kbd>F</kbd>
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

## Reading the results

The list shows **one row per place** the query is found, not one row per
document: each row carries the passage around a hit, with the hit emphasised,
and the file it was found in. Rows are ordered by relevance — a hit in a
document's title outranks one in a chapter heading, which outranks one in the
body — and the hits of one document stay together.

Selecting is deliberate: click a row (or move with <kbd>↑</kbd>/<kbd>↓</kbd>,
<kbd>Home</kbd>/<kbd>End</kbd>) and the preview below the list shows the whole
document with **every place the query occurs** marked, the selected one
standing out. Opening the document is a firmer gesture: **double-click** the
row, or press <kbd>Enter</kbd>, and the reader navigates to that document at
that passage.

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

## What the panel never does

- It does not rank by position or count only: a hit in a title always leads,
  however early or late it sits in the body.
- It does not search code blocks or diagram sources for highlighting: a hit
  inside one is still a real result in the list, but the preview leaves those
  subtrees as authored so a rendered diagram is never turned back into source.
- It does not hold on to your query: clearing the field (the clear button at
  the left of the scope button, or deleting the text) empties the list and the
  preview, and closing the panel forgets the query.
