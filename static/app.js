(() => {
  const app = document.getElementById("app");
  const PAGE_SIZE = 30;
  const DRAFT_KEY = "simple-memos-draft";
  const THEME_KEY = "simple-memos-theme";
  const SIDEBAR_W_KEY = "simple-memos-sidebar-w";

  const state = {
    status: null,
    user: null,
    memos: [],
    filter: { archived: false, tag: "", q: "", date: "" },
    pendingFiles: [],
    editingId: null,
    sidebarOpen: false,
    calMonth: (() => {
      const n = new Date();
      return { year: n.getFullYear(), month: n.getMonth() };
    })(),
    offset: 0,
    hasMore: false,
    loadingMore: false,
    tagSuggest: { open: false, items: [], active: 0, start: -1 },
  };

  // Apply theme early
  (function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const preferDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = saved === "dark" || (!saved && preferDark);
    document.documentElement.classList.toggle("dark", dark);
  })();
  (function initSidebarW() {
    const w = parseInt(localStorage.getItem(SIDEBAR_W_KEY) || "260", 10);
    if (w >= 200 && w <= 400) {
      document.documentElement.style.setProperty("--sidebar-w", w + "px");
    }
  })();

  const icons = {
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>`,
    archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l1 7a4 4 0 0 1-4 4 4 4 0 0 1-4-4l1-7z"/><path d="M8 10h8"/></svg>`,
    edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`,
    paperclip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.5 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78"/></svg>`,
    menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
    chevLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
    chevRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z"/></svg>`,
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      ...opts,
      headers: {
        ...(opts.body && !(opts.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...opts.headers,
      },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relativeTime(ts) {
    const d = new Date(ts * 1000);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + " 天前";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function initial(name) {
    return ((name || "?").trim()[0] || "?").toUpperCase();
  }

  function isDark() {
    return document.documentElement.classList.contains("dark");
  }

  function toggleTheme() {
    const next = !isDark();
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem(THEME_KEY, next ? "dark" : "light");
  }

  
  function highlightCode(code, lang) {
    let s = escapeHtml(code);
    s = s.replace(/(\/\/.*$|\/\*[\s\S]*?\*\/|#(?!!).*$)/gm, '<span class="hl-cmt">$1</span>');
    s = s.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g, '<span class="hl-str">$1</span>');
    s = s.replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-num">$1</span>');
    const kws =
      "const let var function return if else for while do switch case break continue class new this typeof async await import export from default try catch throw finally true false null undefined interface type package struct map go def self None True False and or not in is";
    const re = new RegExp("\\b(" + kws.split(" ").join("|") + ")\\b", "g");
    s = s.replace(re, '<span class="hl-kw">$1</span>');
    return s;
  }

  function renderTable(block) {
    const lines = block.trim().split("\n").filter((l) => l.trim());
    if (lines.length < 2) return escapeHtml(block);
    const splitRow = (line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
    const header = splitRow(lines[0]);
    let start = 1;
    if (/^\|?[\s:|-]+\|/.test(lines[1])) start = 2;
    const rows = lines.slice(start).map(splitRow);
    let html = "<table><thead><tr>";
    header.forEach((h) => {
      html += `<th>${inlineMd(h)}</th>`;
    });
    html += "</tr></thead><tbody>";
    rows.forEach((row) => {
      html += "<tr>";
      header.forEach((_, i) => {
        html += `<td>${inlineMd(row[i] || "")}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    return html;
  }

  function inlineMd(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    s = s.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    );
    s = s.replace(
      /(^|[\s([{])#([\w\u4e00-\u9fff\/.-]+)/g,
      (_, pre, tag) =>
        `${pre}<span class="md-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`
    );
    return s;
  }

  function renderMarkdown(src) {
    if (!src) return "";
    const blocks = [];
    let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const id = blocks.length;
      blocks.push(
        `<pre><code class="lang-${escapeHtml(lang)}">${highlightCode(code.replace(/\n$/, ""), lang)}</code></pre>`
      );
      return `\n\x00BLK${id}\x00\n`;
    });

    const parts = text.split(/\n{2,}/);
    return parts
      .map((part) => {
        part = part.trim();
        if (!part) return "";
        const blk = part.match(/^\x00BLK(\d+)\x00$/);
        if (blk) return blocks[Number(blk[1])];

        // table
        if (/^\|.+\|/.test(part) && part.includes("\n")) {
          return renderTable(part);
        }

        // task list / unordered list
        if (/^[-*] \[([ xX])\] /.test(part) || /^[-*] /.test(part)) {
          const lines = part.split("\n");
          const isTask = lines.some((l) => /^[-*] \[([ xX])\] /.test(l));
          if (isTask) {
            const items = lines
              .map((l) => {
                const m = l.match(/^[-*] \[([ xX])\] (.*)$/);
                if (m) {
                  const done = m[1].toLowerCase() === "x";
                  return `<li><input type="checkbox" disabled ${done ? "checked" : ""}/><span class="${done ? "task-done" : ""}">${inlineMd(m[2])}</span></li>`;
                }
                const m2 = l.match(/^[-*] (.*)$/);
                if (m2) return `<li>${inlineMd(m2[1])}</li>`;
                return `<li>${inlineMd(l)}</li>`;
              })
              .join("");
            return `<ul class="task-list">${items}</ul>`;
          }
          const items = lines
            .map((l) => {
              const m = l.match(/^[-*] (.*)$/);
              return m ? `<li>${inlineMd(m[1])}</li>` : `<li>${inlineMd(l)}</li>`;
            })
            .join("");
          return `<ul>${items}</ul>`;
        }

        // ordered list
        if (/^\d+\. /.test(part)) {
          const items = part
            .split("\n")
            .map((l) => {
              const m = l.match(/^\d+\. (.*)$/);
              return m ? `<li>${inlineMd(m[1])}</li>` : `<li>${inlineMd(l)}</li>`;
            })
            .join("");
          return `<ol>${items}</ol>`;
        }

        // blockquote
        if (/^> /.test(part)) {
          const body = part
            .split("\n")
            .map((l) => l.replace(/^>\s?/, ""))
            .join("<br/>");
          return `<blockquote>${inlineMd(body)}</blockquote>`;
        }

        // headings
        const hm = part.match(/^(#{1,3}) (.+)$/);
        if (hm && !part.includes("\n")) {
          const level = hm[1].length;
          return `<h${level + 2} style="margin:0.4em 0;font-size:${1.15 - level * 0.08}em">${inlineMd(hm[2])}</h${level + 2}>`;
        }

        return `<p>${inlineMd(part).replace(/\n/g, "<br/>")}</p>`;
      })
      .join("");
  }

  
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function dateKeyFromTs(ts) {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function buildActivityMap() {
    const map = {};
    for (const m of state.memos) {
      if (!m.created_at) continue;
      const k = dateKeyFromTs(m.created_at);
      map[k] = (map[k] || 0) + 1;
    }
    return map;
  }
  function activityLevel(count, maxCount) {
    if (count <= 0) return 0;
    const ratio = count / Math.max(1, maxCount);
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  }
  function monthLabel(year, month) {
    return new Date(year, month, 1).toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
    });
  }
  function buildMonthCells(year, month, activity) {
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevDays = new Date(year, month, 0).getDate();
    const maxCount = Math.max(1, ...Object.values(activity), 1);
    const today = todayKey();
    const cells = [];
    for (let i = 0; i < startPad; i++) {
      cells.push({ outside: true, day: prevDays - startPad + 1 + i });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${year}-${pad2(month + 1)}-${pad2(day)}`;
      const count = activity[key] || 0;
      cells.push({
        outside: false,
        day,
        key,
        count,
        level: activityLevel(count, maxCount),
        isToday: key === today,
        selected: state.filter.date === key,
      });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ outside: true, day: cells.length - startPad - daysInMonth + 1 });
    }
    return cells;
  }
  function renderCalendarHtml() {
    const { year, month } = state.calMonth;
    const activity = buildActivityMap();
    const cells = buildMonthCells(year, month, activity);
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    return `
      <div class="cal-wrap">
        <div class="cal-header">
          <button type="button" class="cal-nav" id="cal-prev" title="上一月">${icons.chevLeft}</button>
          <div class="cal-title">${escapeHtml(monthLabel(year, month))}</div>
          <button type="button" class="cal-nav" id="cal-next" title="下一月">${icons.chevRight}</button>
        </div>
        <div class="cal-weekdays">${weekdays.map((w) => `<div class="cal-weekday">${w}</div>`).join("")}</div>
        <div class="cal-grid">
          ${cells
            .map((c) => {
              if (c.outside) return `<span class="cal-day outside">${c.day}</span>`;
              const cls = ["cal-day", c.count ? `lvl-${c.level}` : "empty", c.selected ? "selected" : "", c.isToday ? "today" : ""]
                .filter(Boolean)
                .join(" ");
              const title = c.count ? `${c.key} · ${c.count} 条` : c.key;
              return `<button type="button" class="${cls}" data-date="${c.key}" title="${escapeHtml(title)}">${c.day}</button>`;
            })
            .join("")}
        </div>
        <div class="cal-legend">
          <span>少</span>
          <span class="swatch"></span><span class="swatch l1"></span><span class="swatch l2"></span>
          <span class="swatch l3"></span><span class="swatch l4"></span>
          <span>多</span>
        </div>
      </div>`;
  }

  function collectTags() {
    const map = new Map();
    for (const m of state.memos) {
      for (const t of m.tags || []) map.set(t, (map.get(t) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function allTagNames() {
    return collectTags().map(([t]) => t);
  }

  function filteredMemos() {
    let list = state.memos;
    if (state.filter.date) {
      list = list.filter((m) => dateKeyFromTs(m.created_at) === state.filter.date);
    }
    if (state.filter.q) {
      const q = state.filter.q.toLowerCase();
      list = list.filter(
        (m) =>
          (m.content || "").toLowerCase().includes(q) ||
          (m.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return list;
  }

  function render() {
    if (!state.status) {
      app.innerHTML = `<div class="empty">加载中…</div>`;
      return;
    }
    if (state.status.needs_setup) {
      renderSetup();
      return;
    }
    if (!state.user) {
      renderLogin();
      return;
    }
    renderHome();
  }

  function renderSetup() {
    app.innerHTML = `
      <div class="auth-page"><div class="auth-card">
        <div class="brand"><div class="logo">M</div><div><h2 style="margin:0;font-size:1.15rem">初始化 Memos</h2></div></div>
        <p class="hint">首次使用，创建唯一管理员账号。</p>
        <form id="setup-form">
          <label>用户名</label><input name="username" required autocomplete="username" />
          <label>显示名称（可选）</label><input name="display_name" autocomplete="nickname" />
          <label>密码（至少 4 位）</label><input name="password" type="password" required minlength="4" autocomplete="new-password" />
          <div class="btn-row"><button class="btn" type="submit">完成设置并进入</button></div>
          <div class="error" id="err"></div>
        </form>
      </div></div>`;
    document.getElementById("setup-form").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById("err");
      errEl.textContent = "";
      try {
        const data = await api("/api/setup", {
          method: "POST",
          body: JSON.stringify({
            username: fd.get("username"),
            password: fd.get("password"),
            display_name: fd.get("display_name"),
          }),
        });
        state.user = data.user;
        state.status.needs_setup = false;
        await loadMemos(true);
        render();
      } catch (err) {
        errEl.textContent = err.message;
      }
    };
  }

  function renderLogin() {
    app.innerHTML = `
      <div class="auth-page"><div class="auth-card">
        <div class="brand"><div class="logo">M</div><div><h2 style="margin:0;font-size:1.15rem">登录</h2></div></div>
        <p class="hint">单用户本地日记 · Simple Memos</p>
        <form id="login-form">
          <label>用户名</label><input name="username" required autocomplete="username" />
          <label>密码</label><input name="password" type="password" required autocomplete="current-password" />
          <div class="btn-row"><button class="btn" type="submit">登录</button></div>
          <div class="error" id="err"></div>
        </form>
      </div></div>`;
    document.getElementById("login-form").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById("err");
      errEl.textContent = "";
      try {
        const data = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            username: fd.get("username"),
            password: fd.get("password"),
          }),
        });
        state.user = data.user;
        await loadMemos(true);
        render();
      } catch (err) {
        errEl.textContent = err.message;
      }
    };
  }

  function renderHome() {
    const displayName = state.user.display_name || state.user.username;
    const tags = collectTags();
    const themeIcon = isDark() ? icons.sun : icons.moon;

    app.innerHTML = `
      <div class="sidebar-backdrop ${state.sidebarOpen ? "open" : ""}" id="backdrop"></div>
      <div class="app-shell">
        <aside class="sidebar ${state.sidebarOpen ? "open" : ""}" id="sidebar">
          <div class="sidebar-resize" id="sidebar-resize" title="拖拽调整宽度"></div>
          <div class="sidebar-inner">
            <div class="sidebar-brand">
              <div class="logo">M</div>
              <div class="name">Memos</div>
              <button type="button" class="theme-toggle" id="theme-toggle" title="切换主题">${themeIcon}</button>
            </div>
            <nav class="sidebar-nav">
              <button class="nav-item ${!state.filter.archived ? "active" : ""}" data-view="active">${icons.home}<span>Timeline</span></button>
              <button class="nav-item ${state.filter.archived ? "active" : ""}" data-view="archived">${icons.archive}<span>Archived</span></button>
            </nav>
            <div class="sidebar-section">
              ${renderCalendarHtml()}
              <div class="sidebar-section-label">Tags</div>
              ${
                tags.length
                  ? tags
                      .map(
                        ([t, c]) => `
                <button class="tag-row ${state.filter.tag === t ? "active" : ""}" data-tag="${escapeHtml(t)}">
                  <span class="tag-name">#${escapeHtml(t)}</span>
                  <span class="tag-count">${c || ""}</span>
                </button>`
                      )
                      .join("")
                  : `<div style="padding:8px 10px;color:var(--muted);font-size:13px">暂无标签</div>`
              }
            </div>
            <div class="sidebar-footer">
              <div class="user-chip">
                <div class="avatar">${escapeHtml(initial(displayName))}</div>
                <div class="meta"><div class="uname">${escapeHtml(displayName)}</div></div>
                <button class="logout" id="logout" title="退出">退出</button>
              </div>
            </div>
          </div>
        </aside>

        <div class="main" id="main">
          <div class="mobile-bar">
            <button class="menu-btn" id="menu-btn" aria-label="菜单">${icons.menu}</button>
            <div class="title">${state.filter.archived ? "Archived" : "Timeline"}</div>
            <button type="button" class="theme-toggle" id="theme-toggle-m" title="切换主题">${themeIcon}</button>
          </div>
          <div class="main-inner">
            ${
              !state.filter.archived
                ? `
            <div class="composer" id="composer">
              <div class="composer-wrap">
                <textarea id="content" placeholder="写点什么… 支持 Markdown、#标签、任务列表" rows="3"></textarea>
                <div class="tag-suggest" id="tag-suggest"></div>
              </div>
              <div class="pending" id="pending"></div>
              <div class="composer-toolbar">
                <input type="file" id="file" multiple accept="image*" hidden />
                <button type="button" class="btn icon" id="pick-file" title="添加附件">${icons.paperclip}</button>
                <span class="composer-hint">Ctrl+Enter 发布 · 可粘贴/拖入图片</span>
                <span class="spacer"></span>
                <span class="error" id="c-err" style="margin:0;font-size:12.5px"></span>
                <button type="button" class="btn" id="submit">发布</button>
              </div>
            </div>`
                : ""
            }

            <div class="filter-bar">
              <div class="search-box">
                ${icons.search}
                <input id="search" type="search" placeholder="搜索…" value="${escapeHtml(state.filter.q)}" />
              </div>
              ${
                state.filter.date
                  ? `<span class="filter-chip">${escapeHtml(state.filter.date)} <button type="button" data-clear-date>×</button></span>`
                  : ""
              }
              ${
                state.filter.tag
                  ? `<span class="filter-chip">#${escapeHtml(state.filter.tag)} <button type="button" data-clear-tag>×</button></span>`
                  : ""
              }
            </div>
            <div id="list"></div>
            <div class="load-more" id="load-more"></div>
          </div>
        </div>
      </div>
    `;

    bindHomeEvents();
    if (!state.filter.archived) {
      restoreDraft();
      setupComposer();
      renderPending();
    }
    renderList();
    renderLoadMore();
  }

  function bindHomeEvents() {
    const closeSidebar = () => {
      state.sidebarOpen = false;
      document.getElementById("sidebar")?.classList.remove("open");
      document.getElementById("backdrop")?.classList.remove("open");
    };

    document.getElementById("menu-btn")?.addEventListener("click", () => {
      state.sidebarOpen = true;
      document.getElementById("sidebar")?.classList.add("open");
      document.getElementById("backdrop")?.classList.add("open");
    });
    document.getElementById("backdrop")?.addEventListener("click", closeSidebar);
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      toggleTheme();
      render();
    });
    document.getElementById("theme-toggle-m")?.addEventListener("click", () => {
      toggleTheme();
      render();
    });

    document.getElementById("logout").onclick = async () => {
      await api("/api/auth/logout", { method: "POST" });
      state.user = null;
      state.memos = [];
      render();
    };

    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.onclick = async () => {
        state.filter.archived = btn.dataset.view === "archived";
        state.filter.tag = "";
        state.filter.q = "";
        state.filter.date = "";
        closeSidebar();
        await loadMemos(true);
        render();
      };
    });

    document.querySelectorAll("[data-tag]").forEach((el) => {
      el.onclick = async () => {
        const t = el.dataset.tag;
        state.filter.tag = state.filter.tag === t ? "" : t;
        state.filter.archived = false;
        closeSidebar();
        await loadMemos(true);
        render();
      };
    });

    document.querySelector("[data-clear-tag]")?.addEventListener("click", async () => {
      state.filter.tag = "";
      await loadMemos(true);
      render();
    });
    document.querySelector("[data-clear-date]")?.addEventListener("click", () => {
      state.filter.date = "";
      render();
    });

    document.getElementById("cal-prev")?.addEventListener("click", () => {
      let { year, month } = state.calMonth;
      month -= 1;
      if (month < 0) {
        month = 11;
        year -= 1;
      }
      state.calMonth = { year, month };
      render();
    });
    document.getElementById("cal-next")?.addEventListener("click", () => {
      let { year, month } = state.calMonth;
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      state.calMonth = { year, month };
      render();
    });
    document.querySelectorAll(".cal-day[data-date]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const d = btn.dataset.date;
        const wasArchived = state.filter.archived;
        state.filter.date = state.filter.date === d ? "" : d;
        state.filter.archived = false;
        closeSidebar();
        if (wasArchived) await loadMemos(true);
        render();
      });
    });

    const searchInput = document.getElementById("search");
    if (searchInput) {
      let timer;
      searchInput.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.filter.q = searchInput.value.trim();
          renderList();
        }, 150);
      };
    }

    // Sidebar resize
    setupSidebarResize();
  }

  function setupSidebarResize() {
    const handle = document.getElementById("sidebar-resize");
    const sidebar = document.getElementById("sidebar");
    const main = document.getElementById("main");
    if (!handle || !sidebar) return;
    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
      const dx = e.clientX - startX;
      let w = Math.min(400, Math.max(200, startW + dx));
      document.documentElement.style.setProperty("--sidebar-w", w + "px");
      if (main) main.style.marginLeft = w + "px";
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"), 10);
      if (w) localStorage.setItem(SIDEBAR_W_KEY, String(w));
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function setupComposer() {
    const ta = document.getElementById("content");
    const composer = document.getElementById("composer");
    const fileInput = document.getElementById("file");
    if (!ta) return;

    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 320) + "px";
      localStorage.setItem(DRAFT_KEY, ta.value);
      updateTagSuggest(ta);
    });

    ta.addEventListener("keydown", async (e) => {
      const sug = state.tagSuggest;
      if (sug.open && sug.items.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          sug.active = (sug.active + 1) % sug.items.length;
          renderTagSuggest();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          sug.active = (sug.active - 1 + sug.items.length) % sug.items.length;
          renderTagSuggest();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applyTagSuggest(ta, sug.items[sug.active]);
          return;
        }
        if (e.key === "Escape") {
          sug.open = false;
          renderTagSuggest();
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        await submitMemo();
      }
    });

    document.getElementById("pick-file").onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      await uploadFiles(fileInput.files);
      fileInput.value = "";
    };
    document.getElementById("submit").onclick = () => submitMemo();

    // Paste images
    ta.addEventListener("paste", async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        await uploadFiles(files);
      }
    });

    // Drag & drop
    ["dragenter", "dragover"].forEach((ev) => {
      composer.addEventListener(ev, (e) => {
        e.preventDefault();
        composer.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      composer.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === "dragleave" && composer.contains(e.relatedTarget)) return;
        composer.classList.remove("dragover");
      });
    });
    composer.addEventListener("drop", async (e) => {
      e.preventDefault();
      composer.classList.remove("dragover");
      const files = e.dataTransfer?.files;
      if (files?.length) await uploadFiles(files);
    });
  }

  function updateTagSuggest(ta) {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = before.match(/#([\w\u4e00-\u9fff\/.-]*)$/);
    if (!m) {
      state.tagSuggest.open = false;
      renderTagSuggest();
      return;
    }
    const q = m[1].toLowerCase();
    const tags = allTagNames().filter((t) => t.toLowerCase().startsWith(q) && t.toLowerCase() !== q);
    if (!tags.length) {
      state.tagSuggest.open = false;
      renderTagSuggest();
      return;
    }
    state.tagSuggest = { open: true, items: tags.slice(0, 8), active: 0, start: pos - m[0].length };
    renderTagSuggest();
  }

  function renderTagSuggest() {
    const el = document.getElementById("tag-suggest");
    if (!el) return;
    const sug = state.tagSuggest;
    if (!sug.open || !sug.items.length) {
      el.classList.remove("open");
      el.innerHTML = "";
      return;
    }
    el.classList.add("open");
    el.innerHTML = sug.items
      .map(
        (t, i) =>
          `<button type="button" class="${i === sug.active ? "active" : ""}" data-i="${i}">#${escapeHtml(t)}</button>`
      )
      .join("");
    el.querySelectorAll("button").forEach((btn) => {
      btn.onmousedown = (e) => {
        e.preventDefault();
        const ta = document.getElementById("content");
        applyTagSuggest(ta, sug.items[Number(btn.dataset.i)]);
      };
    });
  }

  function applyTagSuggest(ta, tag) {
    const sug = state.tagSuggest;
    if (!ta || sug.start < 0) return;
    const before = ta.value.slice(0, sug.start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = before + "#" + tag + " " + after;
    const newPos = before.length + tag.length + 2;
    ta.setSelectionRange(newPos, newPos);
    ta.focus();
    localStorage.setItem(DRAFT_KEY, ta.value);
    sug.open = false;
    renderTagSuggest();
  }

  function restoreDraft() {
    const ta = document.getElementById("content");
    if (!ta) return;
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) {
      ta.value = draft;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 320) + "px";
    }
  }

  async function uploadFiles(fileList) {
    const errEl = document.getElementById("c-err");
    if (errEl) errEl.textContent = "";
    for (const f of fileList) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        const a = await api("/api/attachments", { method: "POST", body: fd });
        state.pendingFiles.push(a);
        renderPending();
      } catch (err) {
        if (errEl) errEl.textContent = err.message;
      }
    }
  }

  async function submitMemo() {
    const ta = document.getElementById("content");
    const errEl = document.getElementById("c-err");
    if (!ta) return;
    const content = ta.value;
    if (errEl) errEl.textContent = "";
    try {
      await api("/api/memos", {
        method: "POST",
        body: JSON.stringify({
          content,
          attachment_ids: state.pendingFiles.map((x) => x.id),
        }),
      });
      state.pendingFiles = [];
      ta.value = "";
      ta.style.height = "";
      localStorage.removeItem(DRAFT_KEY);
      await loadMemos(true);
      render();
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
  }

  function renderPending() {
    const el = document.getElementById("pending");
    if (!el) return;
    el.innerHTML = state.pendingFiles
      .map(
        (f, i) =>
          `<span class="pending-item">${escapeHtml(f.filename)} <button type="button" data-rm="${i}">×</button></span>`
      )
      .join("");
    el.querySelectorAll("[data-rm]").forEach((btn) => {
      btn.onclick = () => {
        state.pendingFiles.splice(Number(btn.dataset.rm), 1);
        renderPending();
      };
    });
  }

  function renderList() {
    const list = document.getElementById("list");
    if (!list) return;
    const memos = filteredMemos();
    if (!memos.length) {
      list.innerHTML = `<div class="empty">还没有内容</div>`;
      return;
    }
    const displayName = state.user.display_name || state.user.username;

    list.innerHTML = memos
      .map((m) => {
        if (state.editingId === m.id) {
          return `
          <article class="memo ${m.pinned ? "pinned" : ""}" data-id="${m.id}">
            <div class="memo-header">
              <div class="avatar">${escapeHtml(initial(displayName))}</div>
              <div class="who"><span class="name">${escapeHtml(displayName)}</span><span class="time">编辑中</span></div>
            </div>
            <div class="memo-edit-area">
              <textarea id="edit-${m.id}">${escapeHtml(m.content)}</textarea>
              <div class="memo-edit-actions">
                <button class="btn secondary sm" data-act="cancel-edit">取消</button>
                <button class="btn sm" data-act="save-edit">保存</button>
              </div>
            </div>
          </article>`;
        }
        const tags = (m.tags || [])
          .map((t) => `<button class="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`)
          .join("");
        const atts = (m.attachments || [])
          .map((a) => {
            if ((a.mime || "").startsWith("image/")) {
              return `<a href="${a.url}" target="_blank" rel="noopener"><img src="${a.url}" alt="${escapeHtml(a.filename)}" loading="lazy" /></a>`;
            }
            return `<a class="file" href="${a.url}" target="_blank" rel="noopener">📎 ${escapeHtml(a.filename)}</a>`;
          })
          .join("");
        return `
        <article class="memo ${m.pinned ? "pinned" : ""}" data-id="${m.id}">
          <div class="memo-header">
            <div class="avatar">${escapeHtml(initial(displayName))}</div>
            <div class="who">
              <span class="name">${escapeHtml(displayName)}</span>
              <span class="time">· ${relativeTime(m.created_at)}</span>
              ${m.pinned ? '<span class="pin-badge">置顶</span>' : ""}
            </div>
            <div class="memo-actions">
              <button title="${m.pinned ? "取消置顶" : "置顶"}" data-act="pin">${icons.pin}</button>
              <button title="${m.archived ? "取消归档" : "归档"}" data-act="archive">${icons.archive}</button>
              <button title="编辑" data-act="edit">${icons.edit}</button>
              <button class="danger" title="删除" data-act="del">${icons.trash}</button>
            </div>
          </div>
          <div class="memo-content">${renderMarkdown(m.content || "")}</div>
          ${tags ? `<div class="memo-tags">${tags}</div>` : ""}
          ${atts ? `<div class="memo-attachments">${atts}</div>` : ""}
        </article>`;
      })
      .join("");

    list.querySelectorAll("[data-tag]").forEach((el) => {
      el.onclick = async (e) => {
        e.preventDefault();
        state.filter.tag = el.dataset.tag;
        state.filter.archived = false;
        await loadMemos(true);
        render();
      };
    });

    list.querySelectorAll("article.memo").forEach((art) => {
      const id = art.dataset.id;
      art.querySelectorAll("[data-act]").forEach((btn) => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          try {
            if (act === "del") {
              if (!confirm("删除这条日记？")) return;
              await api(`/api/memos/${id}`, { method: "DELETE" });
              state.editingId = null;
            } else if (act === "pin") {
              const m = state.memos.find((x) => x.id === id);
              await api(`/api/memos/${id}`, {
                method: "PATCH",
                body: JSON.stringify({ pinned: !m.pinned }),
              });
            } else if (act === "archive") {
              const m = state.memos.find((x) => x.id === id);
              await api(`/api/memos/${id}`, {
                method: "PATCH",
                body: JSON.stringify({ archived: !m.archived }),
              });
            } else if (act === "edit") {
              state.editingId = id;
              renderList();
              return;
            } else if (act === "cancel-edit") {
              state.editingId = null;
              renderList();
              return;
            } else if (act === "save-edit") {
              const ta = document.getElementById(`edit-${id}`);
              await api(`/api/memos/${id}`, {
                method: "PATCH",
                body: JSON.stringify({ content: ta.value }),
              });
              state.editingId = null;
            }
            await loadMemos(true);
            render();
          } catch (err) {
            alert(err.message);
          }
        };
      });
    });
  }

  function renderLoadMore() {
    const el = document.getElementById("load-more");
    if (!el) return;
    if (!state.hasMore) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `<button type="button" class="btn secondary" id="btn-more" ${state.loadingMore ? "disabled" : ""}>${state.loadingMore ? "加载中…" : "加载更多"}</button>`;
    document.getElementById("btn-more")?.addEventListener("click", async () => {
      await loadMemos(false);
      renderList();
      renderLoadMore();
    });
  }

  async function loadMemos(reset) {
    if (reset) {
      state.offset = 0;
      state.memos = [];
    }
    const q = new URLSearchParams();
    if (state.filter.archived) q.set("archived", "1");
    if (state.filter.tag) q.set("tag", state.filter.tag);
    q.set("limit", String(PAGE_SIZE));
    q.set("offset", String(state.offset));
    state.loadingMore = true;
    try {
      const data = await api("/api/memos?" + q.toString());
      const batch = data.memos || [];
      if (reset) state.memos = batch;
      else state.memos = state.memos.concat(batch);
      state.hasMore = batch.length >= PAGE_SIZE;
      state.offset = state.memos.length;
    } finally {
      state.loadingMore = false;
    }
  }

  async function boot() {
    try {
      state.status = await api("/api/status");
      if (!state.status.needs_setup && state.status.logged_in) {
        state.user = await api("/api/auth/me");
        await loadMemos(true);
      }
    } catch (err) {
      app.innerHTML = `<div class="empty error">${escapeHtml(err.message)}</div>`;
      return;
    }
    render();
  }

  boot();
})();
