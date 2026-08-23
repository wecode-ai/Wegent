// In-page find runtime for the embedded browser. wry does not expose a native
// find-in-page API, so search/highlight is implemented with DOM text-node
// walking and <mark> wrapping, mirroring the Codex find bar behavior.

export function browserFindInjectionScript(): string {
  return `(function () {
  if (window.__WEWORK_BROWSER_FIND__) return true;
  var MARK_CLASS = '__wework_find_mark__';
  var ACTIVE_CLASS = '__wework_find_mark_active__';
  var STYLE_ID = '__wework_find_style__';
  var matches = [];
  var activeIndex = -1;
  var query = '';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      'mark.' + MARK_CLASS + ' { background: #fde047; color: inherit; border-radius: 2px; padding: 0; }' +
      'mark.' + MARK_CLASS + '.' + ACTIVE_CLASS + ' { background: #f97316; color: #fff; outline: 1px solid #f97316; }';
    (document.head || document.documentElement).appendChild(style);
  }

  function state() {
    return { query: query, matches: matches.length, active: matches.length > 0 ? activeIndex + 1 : 0 };
  }

  function isSkippableElement(element) {
    if (!element) return true;
    var tag = element.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'IFRAME') return true;
    if (element.isContentEditable) return true;
    return false;
  }

  function isVisibleText(node) {
    var element = node.parentElement;
    if (!element || isSkippableElement(element)) return false;
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    var rects = element.getClientRects();
    return rects.length > 0;
  }

  function unwrapMarks() {
    var marks = document.querySelectorAll('mark.' + MARK_CLASS);
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      var parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
    matches = [];
    activeIndex = -1;
  }

  function wrapMatches(rawQuery) {
    var needle = rawQuery.toLowerCase();
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!isVisibleText(node)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.toLowerCase().indexOf(needle) >= 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    var nodes = [];
    var current;
    while ((current = walker.nextNode())) nodes.push(current);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var text = node.nodeValue;
      var lower = text.toLowerCase();
      var parent = node.parentNode;
      if (!parent) continue;
      var cursor = 0;
      var index = lower.indexOf(needle);
      while (index >= 0) {
        var before = text.slice(cursor, index);
        var hit = text.slice(index, index + rawQuery.length);
        if (before) parent.insertBefore(document.createTextNode(before), node);
        var mark = document.createElement('mark');
        mark.className = MARK_CLASS;
        mark.textContent = hit;
        parent.insertBefore(mark, node);
        matches.push(mark);
        cursor = index + rawQuery.length;
        index = lower.indexOf(needle, cursor);
      }
      if (cursor > 0) {
        node.nodeValue = text.slice(cursor);
        if (!node.nodeValue) parent.removeChild(node);
      }
    }
  }

  function setActive(index) {
    if (matches.length === 0) {
      activeIndex = -1;
      return state();
    }
    activeIndex = ((index % matches.length) + matches.length) % matches.length;
    for (var i = 0; i < matches.length; i++) {
      matches[i].classList.toggle(ACTIVE_CLASS, i === activeIndex);
    }
    var target = matches[activeIndex];
    if (target && target.scrollIntoView) {
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    return state();
  }

  window.__WEWORK_BROWSER_FIND__ = {
    search: function (nextQuery) {
      ensureStyle();
      unwrapMarks();
      query = String(nextQuery || '');
      if (!query || !document.body) return state();
      wrapMatches(query);
      return setActive(matches.length > 0 ? 0 : -1);
    },
    next: function () {
      return setActive(activeIndex + 1);
    },
    prev: function () {
      return setActive(activeIndex - 1);
    },
    clear: function () {
      unwrapMarks();
      query = '';
      return state();
    },
    state: state,
  };
  return true;
})()`
}
