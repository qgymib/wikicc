/**
 * Tags: the aggregation the build collected from the bodies.
 *
 * The payload carries the site's tag aggregation (`SiteBundle::tags` — one
 * `{tag, docs}` entry per collected tag, sorted by tag, each entry's
 * documents in payload order), so browsing the site by tag is a filter away:
 * the build has already read every body, and nothing here re-reads one. The
 * titles come from the same payload, so the panel can name a document the
 * reader has not opened yet.
 *
 * A row answers with the tag it carries — selecting one filters the
 * document list, and the same selection unfolds the tag's documents here;
 * the composition root owns the selection, the panel only draws it.
 *
 * `docsOfTag` is pure and testable; `createTagsPanel` only builds DOM nodes
 * with `document.createElement` and `textContent`, so tags and titles can
 * never be interpreted as markup.
 */
import { formatHash } from "./router.js";
import { t } from "./i18n.js";

/** The attribute every tag chip carries — the tag the reader filters through. */
export var TAG_CHIP_ATTRIBUTE = "data-tag";

/** Selector for a chip the reader answers clicks on. */
export var TAG_CHIP_SELECTOR = ".doc-tag[" + TAG_CHIP_ATTRIBUTE + "]";

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
 * The documents of `tag`, in the payload's order.
 *
 * An entry the payload carries half of — a tag without its documents, or a
 * documents field that is not a list — contributes nothing, the same way a
 * broken edge answers nothing in the backlinks panel.
 */
export function docsOfTag(tags, tag) {
  var found = [];

  (tags || []).forEach(function (entry) {
    if (!entry || entry.tag !== tag || !Array.isArray(entry.docs)) {
      return;
    }
    found = entry.docs.slice();
  });

  return found;
}

/**
 * Render the site's tags into `options.container`.
 *
 * `render(activeTag)` draws every tag as one row — name and document count —
 * and, under the selected row, the list of its documents. The rows answer
 * `onSelect(tag)`; the document links answer `onNavigate(id)`. An empty
 * aggregation renders the empty message: the panel exists, there is just
 * nothing in it.
 */
export function createTagsPanel(options) {
  var container = options.container;
  var tags = options.tags || [];
  var onSelect = options.onSelect || function () {};
  var onNavigate = options.onNavigate || function () {};

  // Titles by id, so a document is named the way every other view names it.
  var titles = {};
  (options.docs || []).forEach(function (doc) {
    if (doc && doc.id) {
      titles[doc.id] = doc.title || doc.id;
    }
  });

  function render(activeTag) {
    if (!container) {
      return;
    }

    container.textContent = "";

    if (!tags.length) {
      var empty = document.createElement("p");
      empty.className = "tags-empty";
      empty.textContent = t("tags.empty");
      container.appendChild(empty);
      return;
    }

    var list = document.createElement("ul");
    list.className = "tags-list";

    tags.forEach(function (entry) {
      if (!entry || !entry.tag) {
        return;
      }
      var docs = Array.isArray(entry.docs) ? entry.docs : [];
      var selected = entry.tag === activeTag;

      var item = document.createElement("li");
      item.className = "tag-item";

      var row = document.createElement("button");
      row.type = "button";
      row.className = "tag-name";
      row.setAttribute("aria-expanded", selected ? "true" : "false");
      row.title = t("tags.browseTitle");

      var label = document.createElement("span");
      label.className = "tag-label";
      label.textContent = "#" + entry.tag;
      row.appendChild(label);

      var count = document.createElement("span");
      count.className = "tag-count";
      count.textContent = String(docs.length);
      row.appendChild(count);

      row.addEventListener("click", function (event) {
        if (!isPlainLeftClick(event)) {
          return;
        }
        event.preventDefault();
        onSelect(entry.tag);
      });

      item.appendChild(row);

      if (selected) {
        var docsList = document.createElement("ul");
        docsList.className = "tag-docs";
        docs.forEach(function (id) {
          var docItem = document.createElement("li");
          var link = document.createElement("a");
          link.className = "tag-doc";
          link.href = formatHash(id);
          link.textContent = titles[id] || id;
          link.title = id;
          link.addEventListener("click", function (event) {
            if (!isPlainLeftClick(event)) {
              return;
            }
            event.preventDefault();
            onNavigate(id);
          });

          docItem.appendChild(link);
          docsList.appendChild(docItem);
        });
        item.appendChild(docsList);
      }

      list.appendChild(item);
    });

    container.appendChild(list);
  }

  return { render: render };
}
