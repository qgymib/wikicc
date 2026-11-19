/**
 * Backlinks: the documents that link to the one being read.
 *
 * The payload carries the site's resolved link graph (`SiteBundle::edges` —
 * one `{from, to}` pair per successfully resolved internal link, deduplicated,
 * self-loops dropped, sorted by `(from, to)`), so the reverse references of a
 * document are a filter away: the build has already resolved every link, and
 * nothing here resolves one again. The titles come from the same payload —
 * the pages format's manifest carries them beside the graph, before any chunk
 * is fetched — so the panel can name a source document the reader has not
 * opened yet.
 *
 * `backlinksOf` is pure and testable; `createBacklinks` only builds DOM nodes
 * with `document.createElement` and `textContent`, so document titles can
 * never be interpreted as markup.
 */
import { formatHash } from "./router.js";
import { t } from "./i18n.js";

/** Whether a click should be handled by the router instead of the browser. */
function isPlainLeftClick(event) {
  return (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.button === 0
  );
}

/**
 * Ids of the documents that link to `id`, in the payload's edge order.
 *
 * The edges arrive sorted by `(from, to)`, so the sources of one document
 * come out sorted by id without another pass. The build also guarantees no
 * duplicates and no self-loops, but the filter does not lean on what it
 * cannot see: a payload that carries either is answered the same way.
 */
export function backlinksOf(edges, id) {
  var found = [];
  var seen = {};

  (edges || []).forEach(function (edge) {
    if (!edge || edge.to !== id || edge.from === id) {
      return;
    }
    if (seen[edge.from]) {
      return;
    }
    seen[edge.from] = true;
    found.push(edge.from);
  });

  return found;
}

/**
 * Render the backlinks of one document into `options.container`.
 *
 * `render(id)` rebuilds the list for the document `id`; `render(null)` —
 * what an empty site's arrival calls — empties the panel without a message,
 * because there is no document left to describe. `onNavigate(id, anchor)` is
 * called for a plain left click; modified clicks and middle clicks keep
 * their native behaviour so links stay shareable, exactly as the document
 * list treats them.
 */
export function createBacklinks(options) {
  var container = options.container;
  var edges = options.edges || [];
  var onNavigate = options.onNavigate || function () {};

  // Titles by id, so a source document is named the way every other view
  // names it. A document whose title the payload does not carry — a manifest
  // entry without one, say — falls back to its id.
  var titles = {};
  (options.docs || []).forEach(function (doc) {
    if (doc && doc.id) {
      titles[doc.id] = doc.title || doc.id;
    }
  });

  function render(id) {
    if (!container) {
      return;
    }

    container.textContent = "";
    if (!id) {
      return;
    }

    var sources = backlinksOf(edges, id);
    if (!sources.length) {
      var empty = document.createElement("p");
      empty.className = "backlinks-empty";
      empty.textContent = t("backlinks.empty");
      container.appendChild(empty);
      return;
    }

    var list = document.createElement("ul");
    sources.forEach(function (source) {
      var item = document.createElement("li");
      var link = document.createElement("a");
      link.className = "backlink";
      link.href = formatHash(source);
      link.textContent = titles[source] || source;
      link.title = source;
      link.addEventListener("click", function (event) {
        if (!isPlainLeftClick(event)) {
          return;
        }
        event.preventDefault();
        onNavigate(source, null);
      });

      item.appendChild(link);
      list.appendChild(item);
    });

    container.appendChild(list);
  }

  return { render: render };
}
