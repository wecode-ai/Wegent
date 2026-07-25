// "我的工作" view switcher: renders the list / calendar / timeline views from one
// shared mock task list and toggles sections via the bottom switcher.
(function () {
  'use strict';

  var STATUS = {
    todo: { label: '需要我处理', color: '#6366f1' },
    doing: { label: '正在执行', color: '#f59e0b' },
    review: { label: '等待确认', color: '#8b5cf6' },
    done: { label: '已完成', color: '#10b981' }
  };

  var PRIORITY = {
    high: { label: '高', cls: 'priority-high' },
    mid: { label: '中', cls: 'priority-mid' },
    low: { label: '低', cls: 'priority-low' }
  };

  // Dates are relative to "today" so the demo always looks alive.
  function day(offset) {
    var d = new Date();
    d.setDate(d.getDate() + offset);
    return d;
  }
  function iso(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  var TASKS = [
    { id: 'A2C41F0-3', title: '看板页视觉方案初稿', project: 'Wegent V4', status: 'done', priority: 'mid', due: day(-2) },
    { id: '1FFD6B9-2', title: '整理项目需求文档', project: '看板项目', status: 'review', priority: 'low', due: day(-1) },
    { id: '1FFD6B9-3', title: '设计评审与走查', project: '看板项目', status: 'todo', priority: 'high', due: day(0) },
    { id: '1FFD6B9-4', title: '核对看板列的拖拽排序', project: '看板项目', status: 'doing', priority: 'mid', due: day(0) },
    { id: 'A2C41F0-1', title: '梳理 V4 版本的里程碑拆分', project: 'Wegent V4', status: 'todo', priority: 'high', due: day(1) },
    { id: 'A2C41F0-2', title: '多页面静态 demo 搭建', project: 'Wegent V4', status: 'doing', priority: 'mid', due: day(2) },
    { id: 'A2C41F0-5', title: '共享文件权限模型评审', project: 'Wegent V4', status: 'review', priority: 'mid', due: day(3) },
    { id: 'A2C41F0-7', title: '确认执行器镜像的发布清单', project: 'Wegent V4', status: 'todo', priority: 'low', due: day(5) }
  ];

  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function fmtDate(d) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function dayLabel(d) {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var target = new Date(d); target.setHours(0, 0, 0, 0);
    var diff = Math.round((target - today) / 86400000);
    var rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : null;
    return (rel ? rel + ' · ' : '') + fmtDate(d) + ' ' + WEEKDAYS[d.getDay()];
  }

  /* ---------- List view ---------- */
  function renderList() {
    var body = document.getElementById('work-list-body');
    if (!body) return;
    var rows = TASKS.slice()
      .sort(function (a, b) { return a.due - b.due; })
      .map(function (t) {
        var s = STATUS[t.status];
        var p = PRIORITY[t.priority];
        return '<div class="trow cols-work clickable">' +
          '<div class="cell name-cell">' +
            '<span class="task-id">' + t.id + '</span>' +
            '<span class="cell-title">' + t.title + '</span>' +
          '</div>' +
          '<div class="cell cell-muted">' + t.project + '</div>' +
          '<div class="cell"><span class="status-pill" style="--pill:' + s.color + '">' +
            '<span class="status-dot" style="background:' + s.color + '"></span>' + s.label +
          '</span></div>' +
          '<div class="cell"><span class="badge ' + p.cls + '">' + p.label + '</span></div>' +
          '<div class="cell cell-muted">' + fmtDate(t.due) + '</div>' +
        '</div>';
      });
    body.innerHTML = rows.join('');
  }

  /* ---------- Calendar view (FullCalendar) ---------- */
  var calendar = null;
  function renderCalendar() {
    var el = document.getElementById('work-calendar');
    if (!el || typeof FullCalendar === 'undefined') return;
    if (!calendar) {
      calendar = new FullCalendar.Calendar(el, {
        initialView: 'dayGridMonth',
        locale: 'zh-cn',
        height: 'auto',
        headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,dayGridWeek' },
        buttonText: { today: '今天', month: '月', week: '周' },
        events: TASKS.map(function (t) {
          return {
            title: t.title,
            start: iso(t.due),
            color: STATUS[t.status].color,
            extendedProps: { taskId: t.id, project: t.project }
          };
        }),
        eventContent: function (arg) {
          return {
            html: '<span class="fc-task-id">' + arg.event.extendedProps.taskId + '</span> ' +
                  '<span class="fc-task-title">' + arg.event.title + '</span>'
          };
        }
      });
      calendar.render();
    } else {
      // The container was hidden; recalculate sizes when it becomes visible.
      calendar.updateSize();
    }
  }

  /* ---------- Timeline view ---------- */
  function renderTimeline() {
    var host = document.getElementById('work-timeline');
    if (!host) return;
    var byDay = {};
    TASKS.forEach(function (t) {
      var key = iso(t.due);
      (byDay[key] = byDay[key] || []).push(t);
    });
    var keys = Object.keys(byDay).sort();
    host.innerHTML = keys.map(function (key) {
      var items = byDay[key].map(function (t) {
        var s = STATUS[t.status];
        return '<div class="tl-item">' +
          '<span class="tl-dot" style="background:' + s.color + '"></span>' +
          '<div class="tl-card">' +
            '<div class="tl-card-top">' +
              '<span class="task-id">' + t.id + '</span>' +
              '<span class="tl-title">' + t.title + '</span>' +
              '<span class="badge ' + PRIORITY[t.priority].cls + '">' + PRIORITY[t.priority].label + '</span>' +
            '</div>' +
            '<div class="tl-card-meta">' + t.project + ' · ' + s.label + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
      var d = byDay[key][0].due;
      return '<div class="tl-day">' +
        '<div class="tl-day-label">' + dayLabel(d) + '</div>' +
        items +
      '</div>';
    }).join('');
  }

  /* ---------- Switcher ---------- */
  var rendered = { group: true };
  function switchView(name) {
    document.querySelectorAll('.work-view').forEach(function (v) {
      v.classList.toggle('active', v.getAttribute('data-view') === name);
    });
    document.querySelectorAll('.view-tab').forEach(function (b) {
      var on = b.getAttribute('data-switch') === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!rendered[name]) {
      rendered[name] = true;
      if (name === 'list') renderList();
      if (name === 'calendar') renderCalendar();
      if (name === 'timeline') renderTimeline();
    } else if (name === 'calendar') {
      renderCalendar(); // refresh size after being hidden
    }
  }

  document.querySelectorAll('.view-tab').forEach(function (b) {
    b.addEventListener('click', function () {
      switchView(b.getAttribute('data-switch'));
    });
  });

  // Pre-render list & timeline so they animate in instantly on first switch;
  // the calendar renders lazily because FullCalendar needs a visible container.
  renderList();
  renderTimeline();
  rendered.list = true;
  rendered.timeline = true;
})();
