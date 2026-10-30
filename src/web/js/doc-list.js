/**
 * Document list: grouping by folder, active-item highlighting and filtering.
 *
 * `groupDocs` is pure and testable; `createDocList` only builds DOM nodes with
 * `document.createElement` and `textContent`, so document titles can never be
 * interpreted as markup.
 */
import { formatHash } from "./router.js";

/** Group label used for documents that live in the input root. */
export var ROOT_LABEL = "Documents";

/** Folder part of a document id, `""` for the root. */
export function folderOf(id) {
  var value = String(id === null || id === undefined ? "" : id);
  var index = value.lastIndexOf("/");
  return index === -1 ? "" : value.slice(0, index);
}

/**
 * Group documents by folder.
 *
 * The root group always comes first, the remaining groups follow in folder
 * order, and documents keep their payload order inside a group, so the list
 * is deterministic for a given payload.
 */
export function groupDocs(docs) {
  var groups = [];
  var byFolder = {};

  (docs || []).forEach(function (doc) {
    var folder = folderOf(doc.id);
    var group = byFolder[folder];
    if (!group) {
      group = { folder: folder, label: folder || ROOT_LABEL, docs: [] };
      byFolder[folder] = group;
      groups.push(group);
    }
    group.docs.push(doc);
  });

  return groups.sort(function (left, right) {
    if (left.folder === right.folder) {
      return 0;
    }
    if (!left.folder) {
      return -1;
    }
    if (!right.folder) {
      return 1;
    }
    return left.folder < right.folder ? -1 : 1;
  });
}

/** Whether a click should be handled by the router instead of the browser. */
function isPlainLeftClick(event) {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}

/**
 * Render the document list into `options.container`.
 *
 * `render(ids, activeId)` takes `null` for "no filter" and the ids to keep
 * otherwise. `onSelect(id)` is called for a plain left click; modified clicks
 * and middle clicks keep their native behaviour so links stay shareable.
 */
export function createDocList(options) {
  var container = options.container;
  var docs = options.docs || [];
  var onSelect = options.onSelect || function () {};

  function render(ids, activeId) {
    var allowed = ids === null || ids === undefined ? null : new Set(ids);
    var visible = docs.filter(function (doc) {
      return !allowed || allowed.has(doc.id);
    });

    container.textContent = "";

    if (!visible.length) {
      var empty = document.createElement("p");
      empty.className = "doc-empty";
      empty.textContent = "No documents match";
      container.appendChild(empty);
      return;
    }

    groupDocs(visible).forEach(function (group) {
      var section = document.createElement("div");
      section.className = "doc-group";

      var heading = document.createElement("h2");
      heading.className = "doc-group-title";
      heading.textContent = group.label;

      var list = document.createElement("ul");
      group.docs.forEach(function (doc) {
        var item = document.createElement("li");
        var link = document.createElement("a");
        link.className = "doc-link";
        link.href = formatHash(doc.id);
        link.textContent = doc.title || doc.id;
        link.title = doc.id;
        if (doc.id === activeId) {
          link.setAttribute("aria-current", "page");
        }
        link.addEventListener("click", function (event) {
          if (!isPlainLeftClick(event)) {
            return;
          }
          event.preventDefault();
          onSelect(doc.id, null);
        });

        item.appendChild(link);
        list.appendChild(item);
      });

      section.appendChild(heading);
      section.appendChild(list);
      container.appendChild(section);
    });
  }

  return { render: render };
}
