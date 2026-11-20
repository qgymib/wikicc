/**
 * Reader copy: the language dictionaries and the one lookup every module
 * answers in.
 *
 * The build names the interface language in the payload's `language` field
 * (`src/options/language.rs`); the composition root (`app.js`) calls
 * `setLanguage` once, before any view is built, and every module resolves its
 * copy through `t` from then on. A code the bundle carries no dictionary for —
 * or none at all — keeps the English copy, which is also what the template
 * ships as the no-script fallback.
 *
 * The dictionaries are flat tables keyed by dotted names, one entry per slot
 * the reader shows: visible text, `aria-label`s, `title` tooltips, field
 * placeholders and the sentences errors are answered with. English entries are
 * verbatim the copy the reader shipped with, so a site that names no language
 * renders exactly what it always did. Pluralized slots answer two keys —
 * `.one` for a count of one, `.other` for every other count — because English
 * needs the distinction and the other dictionaries mirror the shape.
 *
 * `t` substitutes `{name}` placeholders from its second argument and falls
 * back through the current dictionary to the English one to the key itself,
 * so a missing translation is visible instead of silently blank.
 *
 * Pure: data and one lookup, no DOM. `node --test` drives it directly.
 */

/** The English copy: verbatim what the reader shipped with. */
var EN = {
  /* The shell's static copy, localized once at start. */
  "shell.skipLink": "Skip to content",
  "shell.sidebarAria": "Document navigation",
  "shell.toggleList": "Toggle document list",
  "shell.docListAria": "Documents",
  "shell.tocHeading": "Outline",
  "shell.tocAria": "Chapter outline",
  "shell.inspectorAria": "Graph",
  "shell.graphLocalHeading": "Local graph",
  "shell.graphGlobalHeading": "Global graph",
  "shell.fit": "Fit graph to view",
  "shell.fitShort": "Fit",
  "shell.backlinksHeading": "Backlinks",
  "shell.backlinksAria": "Backlinks",
  "shell.tagsHeading": "Tags",
  "shell.tagsAria": "Tags",
  "shell.search": "Search documents",
  "shell.searchTitle": "Search documents (Ctrl+F)",
  "shell.theme": "Switch colour theme",
  "shell.showGlobalGraph": "Show global graph",
  "shell.showLocalGraph": "Show local graph",
  "shell.showBacklinks": "Show backlinks",
  "shell.showTags": "Show tags",

  /* The composition root: theme, the pages-format banner, the stats line. */
  "theme.dark": "Switch to dark theme",
  "theme.light": "Switch to light theme",
  "banner.pagesFileProtocol":
    "This site is built in the pages format and needs to be served over HTTP(S); opening it from a file:// page cannot load its documents.",
  "stats.documents.one": "{n} document",
  "stats.documents.other": "{n} documents",
  "stats.assets.one": "{n} asset",
  "stats.assets.other": "{n} assets",

  /* Payload format refusals; the subject names the surface that spoke. */
  "payload.subject.site": "The site payload",
  "payload.subject.chunk": "The document chunk",
  "payload.subject.corpus": "The search corpus",
  "payload.subject.fallback": "The payload",
  "payload.noVersion":
    "{subject} carries no payload format version; rebuild the site with wikicc to read it.",
  "payload.versionMismatch":
    "{subject} was built for payload format version {found}, and this reader speaks version {expected}; rebuild the site with a matching version of wikicc to read it.",

  /* The layout panels' switches. */
  "panels.outline.show": "Show outline panel",
  "panels.outline.hide": "Hide outline panel",
  "panels.list.show": "Show document list",
  "panels.list.hide": "Hide document list",
  "panels.graphLocal.show": "Show local graph",
  "panels.graphLocal.hide": "Hide local graph",
  "panels.graphGlobal.show": "Show global graph",
  "panels.graphGlobal.hide": "Hide global graph",
  "panels.backlinks.show": "Show backlinks",
  "panels.backlinks.hide": "Hide backlinks",
  "panels.tags.show": "Show tags",
  "panels.tags.hide": "Hide tags",

  /* Document list, navigation and outline. */
  "docList.rootGroup": "Documents",
  "docList.empty": "No documents match",
  "navigation.emptySite": "This site has no documents.",
  "toc.empty": "This document has no headings.",

  /* What the article column shows while a document arrives. */
  "docRender.loading": "Loading {id} …",
  "docRender.failed": "This document could not be loaded.",
  "docRender.loadFailedBanner":
    "Could not load {id} — the file is missing, or the site is not being served over HTTP.",
  "docRender.lockedNote":
    "This document is encrypted. Its contents stay hidden until it is unlocked.",

  /* The panel bodies' empty states. */
  "backlinks.empty": "No documents link to this one.",
  "tags.empty": "No tags yet.",
  "tags.browseTitle": "Browse this tag",

  /* The missing-chapter banner. */
  "banner.dismiss": "Dismiss",
  "banner.chapterLead": "Chapter not found in ",
  "banner.chapterSeparator": ": ",

  /* The lock page's form. */
  "lock.label": "Password",
  "lock.wrongPassword": "That password did not unlock this document.",
  "lock.unavailable": "The document could not be unlocked.",
  "lock.submit": "Unlock",
  "lock.busy": "Unlocking…",

  /* The article body's own controls. */
  "fold.collapse": "Collapse section",
  "fold.expand": "Expand section",
  "copy.code": "Copy code",
  "copy.copied": "Copied",

  /* The link-graph views. */
  "graph.empty": "No documents",
  "graph.aria": "Link graph",
  "graph.summary": "Link graph: {nodes}, {links}",
  "graph.summaryNodes.one": "{n} document",
  "graph.summaryNodes.other": "{n} documents",
  "graph.summaryLinks.one": "{n} link",
  "graph.summaryLinks.other": "{n} links",
  "graph.node": "{label}, {connections}",
  "graph.connections.one": "1 connection",
  "graph.connections.other": "{n} connections",

  /* The hover preview's panel and its states. */
  "preview.panelLabel": "Chapter preview",
  "preview.drag": "Drag to move",
  "preview.pin": "Pin preview",
  "preview.unpin": "Unpin preview",
  "preview.close": "Close preview",
  "preview.missingTitle": "Chapter not found",
  "preview.missingSeparator": "No chapter named ",
  "preview.missingTail": " exists in this document.",
  "preview.loading": "Loading…",
  "preview.errorTitle": "Preview failed to load.",
  "preview.errorText":
    "The document did not arrive. Hover the link again to retry.",
  "preview.lockedTitle": "Chapter locked",
  "preview.lockedText":
    "This chapter is in an encrypted document. Enter its password to read it here.",
  "preview.unlockInputLabel": "Document password",
  "preview.unlockSubmit": "Unlock",
  "preview.unlockError":
    "That password did not unlock this document. Try again.",

  /* The roles a tagged link announces. */
  "roles.missing": "Broken reference",
  "roles.loading": "Loading preview",
  "roles.failed": "Preview failed",
  "roles.locked": "Locked chapter",
  "roles.unlockBusy": "Unlocking…",

  /* The search panel and its results. */
  "search.placeholder": "Search documents",
  "search.panelLabel": "Search documents",
  "search.clear": "Clear the search",
  "search.modeLocal": "Local",
  "search.modeGlobal": "Global",
  "search.modeLocalTitle": "Search every document",
  "search.modeGlobalTitle": "Search only this document",
  "search.resultsIdle": "Results",
  "search.resultsLoading": "Loading…",
  "search.matchingAria": "Matching passages",
  "search.lockedLabel": "Locked",
  "search.lockedTitle": "This document is encrypted",
  "search.lockedNotice":
    "This document is encrypted. Open it to unlock its contents.",
  "search.previewIdle": "Preview",

  /* The content viewer's lightbox. */
  "viewer.zoomIn": "Zoom in",
  "viewer.zoomOut": "Zoom out",
  "viewer.reset": "Reset view",
  "viewer.close": "Close viewer",
  "viewer.openDefault": "Open in viewer",
  "viewer.openDiagram": "Open diagram in viewer",
  "viewer.diagramTitle": "Diagram",
  "viewer.openAudio": "Open audio in viewer",
  "viewer.openVideo": "Open video in viewer",
  "viewer.audioTitle": "Audio",
  "viewer.videoTitle": "Video",

  /* Reader tables: sorting headers and the column filter. */
  "table.apply": "Apply",
  "table.blanks": "(Blanks)",
  "table.searchValues": "Search values",
  "table.moreValues": "{n} more values, type to narrow",
  "table.columnFallback": "column {n}",
  "table.filterColumn": "Filter column {column}",
  "table.searchColumn": "Search values in column {column}",
  "table.selectAll": "Select all",
  "table.clearFilter": "Clear filter",
  "table.noMatchingRows": "No matching rows",

  /* Dead links: the reasons the build rejects a destination, keyed by the
     stable codes the build writes into `data-wikicc-invalid-reason`. The
     English entries are verbatim the build warning the `title` attribute
     quotes as the no-script fallback. */
  "links.invalid.not-relative":
    "link target is not relative to the input directory: '{destination}'",
  "links.invalid.escapes-root":
    "link target escapes the input directory: '{destination}'",
  "links.invalid.unknown-document": "link target not found: '{destination}'",
  "links.invalid.unknown-anchor":
    "link target section not found: '{destination}'",
  "links.invalid.unknown-asset": "asset not found: '{destination}'",
  "links.invalid.unreadable-asset": "cannot read asset '{destination}'",
};

/** The simplified Chinese copy. */
var ZH = {
  "shell.skipLink": "跳到正文",
  "shell.sidebarAria": "文档导航",
  "shell.toggleList": "切换文档列表",
  "shell.docListAria": "文档",
  "shell.tocHeading": "大纲",
  "shell.tocAria": "章节大纲",
  "shell.inspectorAria": "关系图",
  "shell.graphLocalHeading": "本篇关系图",
  "shell.graphGlobalHeading": "全站关系图",
  "shell.fit": "缩放至完整视图",
  "shell.fitShort": "适应",
  "shell.backlinksHeading": "反向链接",
  "shell.backlinksAria": "反向链接",
  "shell.tagsHeading": "标签",
  "shell.tagsAria": "标签",
  "shell.search": "搜索文档",
  "shell.searchTitle": "搜索文档（Ctrl+F）",
  "shell.theme": "切换颜色主题",
  "shell.showGlobalGraph": "显示全站关系图",
  "shell.showLocalGraph": "显示本篇关系图",
  "shell.showBacklinks": "显示反向链接",
  "shell.showTags": "显示标签",

  "theme.dark": "切换到深色主题",
  "theme.light": "切换到浅色主题",
  "banner.pagesFileProtocol":
    "本站以 pages 格式构建，需要通过 HTTP(S) 访问；从 file:// 页面打开时无法加载其文档。",
  "stats.documents.one": "{n} 篇文档",
  "stats.documents.other": "{n} 篇文档",
  "stats.assets.one": "{n} 个资产",
  "stats.assets.other": "{n} 个资产",

  "payload.subject.site": "站点数据",
  "payload.subject.chunk": "文档分块",
  "payload.subject.corpus": "搜索语料",
  "payload.subject.fallback": "站点数据",
  "payload.noVersion":
    "{subject}没有携带数据格式版本号；请用 wikicc 重新构建站点后阅读。",
  "payload.versionMismatch":
    "{subject}按数据格式版本 {found} 构建，而当前阅读器支持版本 {expected}；请用配套版本的 wikicc 重新构建站点后阅读。",

  "panels.outline.show": "显示大纲面板",
  "panels.outline.hide": "隐藏大纲面板",
  "panels.list.show": "显示文档列表",
  "panels.list.hide": "隐藏文档列表",
  "panels.graphLocal.show": "显示本篇关系图",
  "panels.graphLocal.hide": "隐藏本篇关系图",
  "panels.graphGlobal.show": "显示全站关系图",
  "panels.graphGlobal.hide": "隐藏全站关系图",
  "panels.backlinks.show": "显示反向链接",
  "panels.backlinks.hide": "隐藏反向链接",
  "panels.tags.show": "显示标签",
  "panels.tags.hide": "隐藏标签",

  "docList.rootGroup": "文档",
  "docList.empty": "没有匹配的文档",
  "navigation.emptySite": "本站没有任何文档。",
  "toc.empty": "此文档没有标题。",

  "docRender.loading": "正在加载 {id} …",
  "docRender.failed": "无法加载此文档。",
  "docRender.loadFailedBanner":
    "无法加载 {id}——文件缺失，或站点未通过 HTTP 提供服务。",
  "docRender.lockedNote": "此文档已加密。解锁后才能查看其内容。",

  "backlinks.empty": "没有文档链接到此文档。",
  "tags.empty": "暂无标签。",
  "tags.browseTitle": "浏览此标签",

  "banner.dismiss": "关闭",
  "banner.chapterLead": "未找到章节：",
  "banner.chapterSeparator": "",

  "lock.label": "密码",
  "lock.wrongPassword": "该密码未能解锁此文档。",
  "lock.unavailable": "此文档无法解锁。",
  "lock.submit": "解锁",
  "lock.busy": "正在解锁…",

  "fold.collapse": "折叠章节",
  "fold.expand": "展开章节",
  "copy.code": "复制代码",
  "copy.copied": "已复制",

  "graph.empty": "暂无文档",
  "graph.aria": "链接关系图",
  "graph.summary": "链接关系图：{nodes}，{links}",
  "graph.summaryNodes.one": "{n} 篇文档",
  "graph.summaryNodes.other": "{n} 篇文档",
  "graph.summaryLinks.one": "{n} 条链接",
  "graph.summaryLinks.other": "{n} 条链接",
  "graph.node": "{label}，{connections}",
  "graph.connections.one": "1 个连接",
  "graph.connections.other": "{n} 个连接",

  "preview.panelLabel": "章节预览",
  "preview.drag": "拖动以移动",
  "preview.pin": "固定预览",
  "preview.unpin": "取消固定预览",
  "preview.close": "关闭预览",
  "preview.missingTitle": "未找到章节",
  "preview.missingSeparator": "本文档中不存在名为 “",
  "preview.missingTail": "” 的章节。",
  "preview.loading": "加载中…",
  "preview.errorTitle": "预览加载失败。",
  "preview.errorText": "文档未能到达。再次悬停链接即可重试。",
  "preview.lockedTitle": "章节已锁定",
  "preview.lockedText": "此章节位于加密文档中。在此输入其密码即可阅读。",
  "preview.unlockInputLabel": "文档密码",
  "preview.unlockSubmit": "解锁",
  "preview.unlockError": "该密码未能解锁此文档，请重试。",

  "roles.missing": "失效引用",
  "roles.loading": "正在加载预览",
  "roles.failed": "预览失败",
  "roles.locked": "已锁定章节",
  "roles.unlockBusy": "正在解锁…",

  "search.placeholder": "搜索文档",
  "search.panelLabel": "搜索文档",
  "search.clear": "清空搜索",
  "search.modeLocal": "本篇",
  "search.modeGlobal": "全站",
  "search.modeLocalTitle": "搜索全部文档",
  "search.modeGlobalTitle": "仅搜索当前文档",
  "search.resultsIdle": "结果",
  "search.resultsLoading": "加载中…",
  "search.matchingAria": "匹配段落",
  "search.lockedLabel": "已锁定",
  "search.lockedTitle": "此文档已加密",
  "search.lockedNotice": "此文档已加密。打开它以解锁其内容。",
  "search.previewIdle": "预览",

  "viewer.zoomIn": "放大",
  "viewer.zoomOut": "缩小",
  "viewer.reset": "重置视图",
  "viewer.close": "关闭查看器",
  "viewer.openDefault": "在查看器中打开",
  "viewer.openDiagram": "在查看器中打开图表",
  "viewer.diagramTitle": "图表",
  "viewer.openAudio": "在查看器中打开音频",
  "viewer.openVideo": "在查看器中打开视频",
  "viewer.audioTitle": "音频",
  "viewer.videoTitle": "视频",

  "table.apply": "应用",
  "table.blanks": "（空白）",
  "table.searchValues": "搜索值",
  "table.moreValues": "还有 {n} 个值，输入以缩小范围",
  "table.columnFallback": "第 {n} 列",
  "table.filterColumn": "筛选列：{column}",
  "table.searchColumn": "在列 {column} 中搜索值",
  "table.selectAll": "全选",
  "table.clearFilter": "清除筛选",
  "table.noMatchingRows": "没有匹配的行",

  "links.invalid.not-relative":
    "链接目标不是输入目录的相对路径：'{destination}'",
  "links.invalid.escapes-root": "链接目标逃出输入目录：'{destination}'",
  "links.invalid.unknown-document": "找不到链接目标：'{destination}'",
  "links.invalid.unknown-anchor": "找不到链接目标的章节：'{destination}'",
  "links.invalid.unknown-asset": "找不到资源文件：'{destination}'",
  "links.invalid.unreadable-asset": "无法读取资源文件 '{destination}'",
};

/** Every language the bundle carries, keyed by its code. */
export var DICTIONARIES = { en: EN, zh: ZH };

/** The language a reader falls back to. */
export var DEFAULT_LANGUAGE = "en";

/** The language in effect; only `setLanguage` writes it. */
var current = DEFAULT_LANGUAGE;

/**
 * Make `code` the language every following `t` call answers in.
 *
 * A code the bundle carries no dictionary for — or anything that is not a
 * string — keeps the English copy instead of failing: a payload from an
 * unknown future build renders rather than stops. Returns the language now
 * in effect.
 */
export function setLanguage(code) {
  current =
    typeof code === "string" && Object.hasOwn(DICTIONARIES, code)
      ? code
      : DEFAULT_LANGUAGE;
  return current;
}

/** The language currently in effect. */
export function currentLanguage() {
  return current;
}

/**
 * The copy `key` names, in the language in effect.
 *
 * The lookup falls back through the current dictionary to the English one,
 * and to the key itself when neither carries the entry, so a missing
 * translation is visible on screen instead of silently blank. `params` fills
 * `{name}` placeholders — a name the caller did not pass is left as written,
 * which keeps a broken interpolation easy to spot.
 */
export function t(key, params) {
  var table = DICTIONARIES[current];
  var value = table && Object.hasOwn(table, key) ? table[key] : EN[key];
  if (typeof value !== "string") {
    return key;
  }
  if (!params) {
    return value;
  }
  return value.replace(/\{(\w+)\}/g, function (placeholder, name) {
    return Object.hasOwn(params, name) ? String(params[name]) : placeholder;
  });
}
