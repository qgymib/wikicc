/**
 * Chapter outline for the current document.
 *
 * The tree comes from the payload (`DocModel::toc`), not from scanning the
 * rendered headings, so the outline can be rendered before the document body
 * and links can carry the full `#/doc/<id>#<anchor>` route. Those route-aware
 * hrefs are the reason this module is hand-written instead of delegating to a
 * table-of-contents library: such libraries emit `#<anchor>` links and match
 * scroll-spy state by that href, which would break deep links.
 */
import { formatHash } from "./router.js";

/** Whether a click should be handled by the router instead of the browser. */
function isPlainLeftClick(event) {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}

/**
 * Render an outline and keep the current section highlighted.
 *
 * `onNavigate(docId, anchor)` is optional: without it the links keep their
 * native `#/doc/...` behaviour, which the router already handles.
 */
export function createToc(options) {
  var container = options.container;
  var onNavigate = options.onNavigate || null;
  var observer = null;
  var links = [];
  var visible = new Map();

  function clear() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    links = [];
    visible = new Map();
    container.textContent = "";
  }

  function build(entries, docId, parent) {
    if (!Array.isArray(entries) || !entries.length) {
      return;
    }

    var list = document.createElement("ul");
    entries.forEach(function (entry) {
      if (!entry) {
        return;
      }

      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = formatHash(docId, entry.id);
      link.textContent = entry.text || entry.id;
      link.setAttribute("data-anchor", entry.id);
      link.addEventListener("click", function (event) {
        if (!onNavigate || !isPlainLeftClick(event)) {
          return;
        }
        event.preventDefault();
        onNavigate(docId, entry.id);
      });

      item.appendChild(link);
      build(entry.children, docId, item);
      list.appendChild(item);
    });

    parent.appendChild(list);
  }

  function highlight(anchor) {
    links.forEach(function (link) {
      if (link.getAttribute("data-anchor") === anchor) {
        link.setAttribute("aria-current", "true");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function updateHighlight() {
    var best = null;
    var bestTop = Infinity;

    visible.forEach(function (top, anchor) {
      if (top < bestTop) {
        bestTop = top;
        best = anchor;
      }
    });

    if (!best && links.length) {
      best = links[0].getAttribute("data-anchor");
    }

    highlight(best);
  }

  function observe() {
    if (typeof IntersectionObserver !== "function") {
      return;
    }

    observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            visible.set(entry.target.id, entry.boundingClientRect.top);
          } else {
            visible.delete(entry.target.id);
          }
        });
        updateHighlight();
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );

    links.forEach(function (link) {
      var heading = document.getElementById(link.getAttribute("data-anchor"));
      if (heading) {
        observer.observe(heading);
      }
    });
  }

  function render(toc, docId) {
    clear();

    if (!Array.isArray(toc) || !toc.length) {
      var empty = document.createElement("p");
      empty.className = "toc-empty";
      empty.textContent = "This document has no headings.";
      container.appendChild(empty);
      return;
    }

    build(toc, docId, container);
    links = Array.prototype.slice.call(container.querySelectorAll("a[data-anchor]"));
    highlight(links.length ? links[0].getAttribute("data-anchor") : null);
    observe();
  }

  return { render: render };
}
