(() => {
  "use strict";

  let DATA = window.VRS_DATA;
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  if (!DATA) {
    app.innerHTML = `
      <div class="content" style="padding-top:80px">
        <div class="panel card">
          <div class="eyebrow">数据缺失</div>
          <h1 style="margin-top:10px">请先构建数据</h1>
          <p class="muted" style="margin-top:10px">运行 <code>python scripts/build_data.py</code> 生成 <code>data.js</code>，然后刷新页面。</p>
        </div>
      </div>`;
    return;
  }

  const REGIONS = ["Global", "Europe", "Americas", "Asia"];
  const REGION_LABELS = {
    Global: "全球",
    Europe: "欧洲",
    Americas: "美洲",
    Asia: "亚洲",
  };
  const REGION_CLASS = {
    Global: "region-global",
    Europe: "region-europe",
    Americas: "region-americas",
    Asia: "region-asia",
  };

  const FACTORS = [
    {
      key: "bountyOffered",
      label: "赏金获取",
      color: "var(--lime)",
      desc: "赛事奖金，按时间衰减，并以全球参照上限进行折算。",
    },
    {
      key: "bountyCollected",
      label: "赏金收集",
      color: "var(--cyan)",
      desc: "击败对手的质量，依据对手的赏金获取值计算。",
    },
    {
      key: "opponentNetwork",
      label: "对手网络",
      color: "var(--violet)",
      desc: "阵容击败过的、有相关性的不同对手数量。",
    },
    {
      key: "lanWins",
      label: "LAN 胜场",
      color: "var(--orange)",
      desc: "LAN 赛事胜场，按时间与赛事级别加权。",
    },
  ];

  const MAX_COMPARE = 4;
  const TEAM_COLORS = ["#c8ff3d", "#6ee7ff", "#b7a6ff", "#ff9f43"];

  let route = parseHash();
  let toastTimer = null;

  // Rank history indexes, built once from the snapshot series.
  const HISTORY = new Map();
  const ORG_HISTORY = new Map();
  function buildHistoryIndex() {
    HISTORY.clear();
    ORG_HISTORY.clear();
    DATA.dates.forEach((date) => {
      const snapshot = DATA.snapshots[date];
      if (!snapshot) return;
      snapshot.standings.forEach((row) => {
        const entry = {
          date,
          globalRank: row.globalRank,
          regionalRank: row.regionalRank,
          points: row.points,
          region: row.region,
          name: row.name,
        };
        if (!HISTORY.has(row.id)) HISTORY.set(row.id, []);
        HISTORY.get(row.id).push(entry);

        const key = String(row.name || "").trim().toLowerCase();
        if (!ORG_HISTORY.has(key)) ORG_HISTORY.set(key, []);
        ORG_HISTORY.get(key).push(entry);
      });
    });
  }
  buildHistoryIndex();

  const latestSnap = DATA.snapshots[DATA.latestDate];
  const state = {
    region: "Global",
    search: "",
    sort: "rank",
    limit: 50,
    snapshotDate: DATA.latestDate,
    compare: latestSnap && latestSnap.standings.length >= 2
      ? [latestSnap.standings[0].id, latestSnap.standings[1].id]
      : [],
    matchFilter: "all",
    historyMode: "globalRank",
  };

  // Live update status, kept outside render() so polling can refresh it in place.
  const live = {
    tone: "checking",
    text: "正在检查更新…",
    title: "正在连接本地更新服务。",
    available: true,
    builtAt: DATA.builtAt || null,
  };
  let liveTimer = null;
  let liveBusy = false;

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function fmt(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtInt(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString("en-US");
  }

  function money(value) {
    if (value === null || value === undefined) return "—";
    return "$" + Number(value).toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  }

  function dateLabel(value) {
    if (!value) return "—";
    const date = new Date(value + "T00:00:00Z");
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  function shortDate(value) {
    if (!value) return "—";
    const date = new Date(value + "T00:00:00Z");
    return date.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  function regionLabel(region) {
    return REGION_LABELS[region] || region || "未知";
  }

  function regionPill(region) {
    const key = REGION_CLASS[region] || "region-global";
    return `<span class="region-pill ${key}">${esc(regionLabel(region))}</span>`;
  }

  function qualStages(region) {
    const q = DATA.qualification;
    if (!q || !q.stages) return null;
    return q.stages[region] || null;
  }

  function qualCutoffs(region) {
    const stages = qualStages(region);
    if (!stages) return [];
    const out = [];
    let cursor = 0;
    let from = 1;
    [["stage3", "第三阶段"], ["stage2", "第二阶段"], ["stage1", "第一阶段"]].forEach(([key, label]) => {
      const size = Number(stages[key]) || 0;
      if (!size) return;
      cursor += size;
      out.push({ key, label, from, to: cursor, size });
      from = cursor + 1;
    });
    return out;
  }

  function qualForRank(region, regionalRank) {
    const rank = Number(regionalRank);
    if (!rank) return null;
    return qualCutoffs(region).find((band) => rank >= band.from && rank <= band.to) || null;
  }

  function qualificationBadge(region, regionalRank) {
    const band = qualForRank(region, regionalRank);
    if (!band) return `<span class="muted-cell">—</span>`;
    return `<span class="qual-badge qual-${band.key}" title="根据 ${esc(DATA.qualification?.asOf || "")} Major 名额分配推算，并非官方邀请。">${band.label}</span>`;
  }

  function deltaClass(value) {
    if (value === null || value === undefined) return "new";
    if (value > 0) return "up";
    if (value < 0) return "down";
    return "flat";
  }

  function deltaText(value) {
    if (value === null || value === undefined) return "新";
    if (value > 0) return `▲ ${value}`;
    if (value < 0) return `▼ ${Math.abs(value)}`;
    return "—";
  }

  function parseHash() {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const [path, query] = raw.split("?");
    const parts = path.split("/").filter(Boolean);
    const params = new URLSearchParams(query || "");

    if (!parts.length) return { view: "rankings" };
    if (parts[0] === "team") return { view: "team", id: parts[1] };
    if (parts[0] === "compare") {
      const teams = (params.get("t") || "").split(",").filter(Boolean).slice(0, MAX_COMPARE);
      return { view: "compare", teams };
    }
    if (parts[0] === "methodology") return { view: "methodology" };
    return { view: "rankings" };
  }

  function navigate(hash) {
    document.getElementById("sidebar")?.classList.remove("open");
    if (window.location.hash === hash) {
      route = parseHash();
      render();
      return;
    }
    window.location.hash = hash;
  }

  function showToast(message, duration = 2200) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), duration);
  }

  function previousDate(date) {
    const index = DATA.dates.indexOf(date);
    return index > 0 ? DATA.dates[index - 1] : null;
  }

  function previousRow(id, date) {
    const index = DATA.dates.indexOf(date);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const row = DATA.snapshots[DATA.dates[cursor]].standings.find((team) => team.id === id);
      if (row) return row;
    }
    return null;
  }

  function historyFor(id) {
    return HISTORY.get(id) || [];
  }

  function orgHistoryFor(name) {
    return ORG_HISTORY.get(String(name || "").trim().toLowerCase()) || [];
  }

  function isTop10(match) {
    return (
      match.bountyAdjusted !== null ||
      match.networkAdjusted !== null ||
      match.lanAdjusted !== null
    );
  }

  /* ------------------------------------------------------------------ */
  /* Shell                                                              */
  /* ------------------------------------------------------------------ */

  function navLink(href, label, icon, view) {
    const active = route.view === view ? "active" : "";
    return `<a class="nav-link ${active}" href="${href}"><span class="nav-icon">${icon}</span>${label}</a>`;
  }

  function topbarTitle() {
    if (route.view === "team") {
      const team = DATA.teams[route.id];
      return team ? team.name : "战队";
    }
    if (route.view === "compare") return "对比";
    if (route.view === "methodology") return "方法说明";
    return "排名";
  }

  function layout(content) {
    return `
      <div class="ambient"></div>
      <div class="shell">
        <aside class="sidebar" id="sidebar">
          <a class="brand" href="#/">
            <span class="brand-mark">V</span>
            <span class="brand-copy">
              <strong>VRS LAB</strong>
              <small>区域排名</small>
            </span>
          </a>

          <nav class="nav">
            ${navLink("#/", "排名", "▦", "rankings")}
            ${navLink("#/compare", "对比", "⇄", "compare")}
            ${navLink("#/methodology", "方法说明", "◇", "methodology")}
          </nav>

          <div class="sidebar-panel">
            <div class="eyebrow">快照</div>
            <div class="snapshot-date">${esc(DATA.latestDate)}</div>
            <div class="muted small">${fmtInt(DATA.snapshots[DATA.latestDate]?.teamCount)} 支战队 · ${DATA.dates.length} 个快照</div>
            <a class="source-link" href="${esc(DATA.source.repo)}" target="_blank" rel="noreferrer">官方数据源 ↗</a>
            <button class="live-status ${live.tone}" data-action="check-updates" title="${esc(live.title)}">
              <span class="live-dot"></span>
              <span class="live-text">${esc(live.text)}</span>
            </button>
          </div>

          <div class="sidebar-footer">
            <span class="status-dot"></span> 非官方原型
          </div>
        </aside>

        <main class="main">
          <header class="topbar">
            <button class="icon-btn" data-action="toggle-menu" aria-label="打开导航">☰</button>
            <div class="topbar-title">${esc(topbarTitle())}</div>
            <div class="topbar-actions">
              <div class="search-wrap">
                <span class="search-icon">⌕</span>
                <input id="global-search" class="search" type="search" placeholder="搜索战队或选手…" value="${esc(state.search)}" autocomplete="off">
              </div>
              <a class="ghost-btn" href="#/methodology">计算方式</a>
            </div>
          </header>
          <div class="content">${content}</div>
        </main>
      </div>
      ${route.view === "compare" ? "" : renderCompareTray()}`;
  }

  function compareSelection() {
    const snapshot = DATA.snapshots[DATA.latestDate];
    const byId = new Map(snapshot.standings.map((team) => [team.id, team]));
    return state.compare.filter((id) => byId.has(id)).map((id) => byId.get(id));
  }

  function renderCompareTray() {
    const teams = compareSelection();
    if (!teams.length) return "";
    return `
      <div class="compare-tray ${teams.length >= 2 ? "ready" : ""}">
        <div class="tray-teams">
          ${teams.map((team) => `
            <span class="tray-chip">
              ${esc(team.name)}
              <button data-action="compare-remove" data-id="${esc(team.id)}" aria-label="移除 ${esc(team.name)}">×</button>
            </span>`).join("")}
          ${teams.length < 2 ? `<span class="tray-hint">再选 ${2 - teams.length} 支即可对比</span>` : ""}
        </div>
        <div class="tray-actions">
          <span class="tray-count mono">${teams.length}/${MAX_COMPARE}</span>
          <button class="ghost-btn" data-action="compare-clear">清空</button>
          <button class="primary-btn" data-action="compare-open" ${teams.length < 2 ? "disabled" : ""}>对比 ${teams.length} 支</button>
        </div>
      </div>`;
  }

  function render() {
    if (route.view === "compare" && Array.isArray(route.teams) && route.teams.length >= 2) {
      state.compare = route.teams.slice(0, MAX_COMPARE);
    }
    let content = "";
    if (route.view === "team") content = renderTeam(route.id);
    else if (route.view === "compare") content = renderCompare();
    else if (route.view === "methodology") content = renderMethodology();
    else content = renderRankings();

    app.innerHTML = layout(content);
  }

  /* ------------------------------------------------------------------ */
  /* Rankings                                                           */
  /* ------------------------------------------------------------------ */

  function renderRankings() {
    const date = state.snapshotDate;
    const snapshot = DATA.snapshots[date] || DATA.snapshots[DATA.latestDate];
    const all = snapshot.standings;
    const prevDate = previousDate(date);
    const prevMap = new Map((DATA.snapshots[prevDate]?.standings || []).map((team) => [team.id, team]));

    let teams = all;
    if (state.region !== "Global") teams = teams.filter((team) => team.region === state.region);

    const query = state.search.trim().toLowerCase();
    if (query) {
      teams = teams.filter((team) =>
        team.name.toLowerCase().includes(query) ||
        team.roster.some((player) => player.toLowerCase().includes(query))
      );
    }

    const sorted = sortTeams(teams, prevMap);
    const visible = sorted.slice(0, state.limit);
    const leader = sorted[0];
    const avgPoints = sorted.length
      ? Math.round(sorted.reduce((sum, team) => sum + team.points, 0) / sorted.length)
      : 0;

    const stats = `
      <div class="hero-stats">
        <div class="stat">
          <div class="stat-value">${fmtInt(sorted.length)}</div>
          <div class="stat-label">${state.region === "Global" ? "参与排名战队" : `${regionLabel(state.region)}战队`}</div>
        </div>
        <div class="stat">
          <div class="stat-value lime">${leader ? esc(leader.name) : "—"}</div>
          <div class="stat-label">当前第一</div>
        </div>
        <div class="stat">
          <div class="stat-value mono">${leader ? fmtInt(leader.points) : "—"}</div>
          <div class="stat-label">榜首积分</div>
        </div>
        <div class="stat">
          <div class="stat-value mono">${fmtInt(avgPoints)}</div>
          <div class="stat-label">平均积分</div>
        </div>
      </div>`;

    return `
      <section class="hero">
        <div>
          <div class="eyebrow"><span class="live-dot"></span> CS2 · Valve 区域排名</div>
          <h1>排名，<em>拆开看。</em></h1>
          <p class="hero-sub">每一分都有来由。查看 Valve 区域排名背后的因子、比赛和交手结果，不必再啃 Markdown 表格。</p>
        </div>
        ${stats}
      </section>

      <div class="toolbar">
        <div class="tabs">
          ${REGIONS.map((region) => `
            <button class="tab ${state.region === region ? "active" : ""}" data-action="set-region" data-region="${region}">${regionLabel(region)}</button>
          `).join("")}
        </div>

        <select class="select" id="snapshot-select" aria-label="快照日期">
          ${DATA.dates.slice().reverse().map((item) => `
            <option value="${item}" ${item === date ? "selected" : ""}>${dateLabel(item)}</option>
          `).join("")}
        </select>

        <select class="select" id="sort-select" aria-label="战队排序">
          <option value="rank" ${state.sort === "rank" ? "selected" : ""}>排序：排名</option>
          <option value="points" ${state.sort === "points" ? "selected" : ""}>排序：积分</option>
          <option value="delta" ${state.sort === "delta" ? "selected" : ""}>排序：变动</option>
          <option value="name" ${state.sort === "name" ? "selected" : ""}>排序：名称</option>
        </select>

        <div class="toolbar-spacer"></div>
        <div class="toolbar-note">官方快照 · ${dateLabel(date)}</div>
      </div>

      <div class="rankings-grid">
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">${regionLabel(state.region)}排名</div>
              <div class="panel-sub">${fmtInt(sorted.length)} 支战队${query ? `，匹配“${esc(state.search)}”` : ""}</div>
            </div>
            <div class="panel-head-right">
              <span class="muted small">点击任意一行查看完整拆解</span>
            </div>
          </div>

          <div class="table-wrap">
            <table class="rankings-table">
              <thead>
                <tr>
                  <th style="width:34px"></th>
                  <th style="width:54px">#</th>
                  <th>战队</th>
                  <th class="col-region">区域</th>
                  <th class="col-factors" title="赏金获取 · 赏金收集 · 对手网络 · LAN 胜场">因子</th>
                  <th style="text-align:right">积分</th>
                  <th style="width:64px">Δ</th>
                  <th class="col-trend" style="width:100px">走势</th>
                </tr>
              </thead>
              <tbody>
                ${visible.length ? visible.map((team) => renderRankingRow(team, prevMap) + qualificationLineAfter(team)).join("") : `
                  <tr>
                    <td colspan="8">
                      <div class="empty">
                        <div class="empty-icon">⌕</div>
                        <div>没有符合条件的战队。</div>
                      </div>
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>

          <div class="table-footer">
            <span>显示 ${fmtInt(visible.length)} / ${fmtInt(sorted.length)} 支战队</span>
            ${state.limit < sorted.length ? `<button class="ghost-btn" data-action="show-all">显示全部</button>` : ""}
          </div>
        </section>

        <aside class="side-stack">
          ${renderMovers(all, prevMap)}
          ${renderRegionPulse(snapshot)}
          ${renderMajorPath()}
          ${renderDataHealth()}
        </aside>
      </div>`;
  }

  function sortTeams(teams, prevMap) {
    const copy = teams.slice();
    if (state.sort === "points") return copy.sort((a, b) => b.points - a.points || a.globalRank - b.globalRank);
    if (state.sort === "name") return copy.sort((a, b) => a.name.localeCompare(b.name));
    if (state.sort === "delta") {
      return copy.sort((a, b) => {
        const da = prevMap.get(a.id) ? prevMap.get(a.id).globalRank - a.globalRank : -999;
        const db = prevMap.get(b.id) ? prevMap.get(b.id).globalRank - b.globalRank : -999;
        return db - da || a.globalRank - b.globalRank;
      });
    }
    return copy.sort((a, b) => a.globalRank - b.globalRank);
  }

  function renderRankingRow(team, prevMap) {
    const previous = prevMap.get(team.id);
    const delta = previous ? previous.globalRank - team.globalRank : null;
    const history = historyFor(team.id).filter((item) => item.date <= state.snapshotDate);
    const checked = state.compare.includes(team.id);
    const rankClass = team.globalRank === 1 ? "top1" : team.globalRank === 2 ? "top2" : team.globalRank === 3 ? "top3" : "";

    return `
      <tr data-team-id="${esc(team.id)}">
        <td>
          <input class="compare-check" type="checkbox" data-action="toggle-compare" data-id="${esc(team.id)}" ${checked ? "checked" : ""} aria-label="对比 ${esc(team.name)}">
        </td>
        <td><span class="rank-badge ${rankClass}">${team.globalRank}</span></td>
        <td>
          <div class="team-cell">
            <span class="team-name">${esc(team.name)}</span>
            <span class="team-roster">${esc(team.roster.join(", "))}</span>
          </div>
        </td>
        <td class="col-region">${regionPill(team.region)}</td>
        <td class="col-factors">${factorProfile(team.id)}</td>
        <td style="text-align:right"><span class="points">${fmtInt(team.points)}</span></td>
        <td><span class="delta ${deltaClass(delta)}">${deltaText(delta)}</span></td>
        <td class="col-trend">${sparkline(history)}</td>
      </tr>`;
  }

  function qualificationLineAfter(team) {
    if (state.region === "Global" || state.sort !== "rank" || state.search.trim()) return "";
    const rank = Number(team.regionalRank);
    const band = qualCutoffs(state.region).find((item) => item.to === rank);
    if (!band) return "";
    const asOf = DATA.qualification?.asOf || "最近公布";
    return `
      <tr class="qual-row">
        <td colspan="8">
          <div class="qual-line">
            <span class="qual-line-label qual-${band.key}">${band.label}晋级线</span>
            <span class="qual-line-rule"></span>
            <span class="qual-line-note">${band.from === band.to ? `第 ${band.to} 名` : `第 ${band.from}–${band.to} 名`} · ${band.size} 个名额 · ${esc(asOf)}</span>
          </div>
        </td>
      </tr>`;
  }

  function factorProfile(id) {
    const team = DATA.teams[id];
    if (!team) return `<span class="muted-cell">—</span>`;
    const factors = team.factors || {};
    return `
      <div class="mini-factors" title="赏金获取、赏金收集、对手网络、LAN 胜场">
        ${FACTORS.map((factor) => {
          const value = Math.max(0.02, Math.min(1, Number(factors[factor.key]) || 0));
          return `<i style="height:${(value * 100).toFixed(0)}%;background:${factor.color}"></i>`;
        }).join("")}
      </div>`;
  }

  function sparkline(history) {
    const points = history.slice(-8);
    if (points.length < 2) return `<span class="muted-cell">—</span>`;

    const width = 82;
    const height = 24;
    const ranks = points.map((item) => item.globalRank);
    const min = Math.min(...ranks);
    const max = Math.max(...ranks);
    const span = Math.max(1, max - min);
    const coords = points.map((item, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = ((item.globalRank - min) / span) * (height - 4) + 2;
      return [x, y];
    });
    const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const area = `0,${height} ${line} ${width},${height}`;
    const improving = points[points.length - 1].globalRank <= points[0].globalRank;
    const color = improving ? "var(--green)" : "var(--red)";
    const first = points[0];
    const last = points[points.length - 1];

    return `
      <svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="排名走势">
        <polygon class="spark-area" points="${area}" fill="${color}"></polygon>
        <polyline points="${line}" stroke="${color}"></polyline>
        <title>${esc(first.date)}: #${first.globalRank} → ${esc(last.date)}: #${last.globalRank}</title>
      </svg>`;
  }

  function renderMovers(all, prevMap) {
    const movers = all
      .map((team) => {
        const previous = prevMap.get(team.id);
        return previous ? { team, delta: previous.globalRank - team.globalRank } : null;
      })
      .filter((item) => item && item.delta !== 0);

    const up = movers.filter((item) => item.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5);
    const down = movers.filter((item) => item.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5);

    const rows = (items, empty) => items.length
      ? items.map((item) => `
          <div class="mover">
            <span class="mover-rank">#${item.team.globalRank}</span>
            <span class="mover-name">${esc(item.team.name)}</span>
            <span class="mover-delta ${item.delta > 0 ? "up" : "down"}">${item.delta > 0 ? "+" : ""}${item.delta}</span>
          </div>`).join("")
      : `<div class="muted small">${empty}</div>`;

    return `
      <section class="panel side-card">
        <div class="eyebrow">变动</div>
        <div class="side-title">上升</div>
        ${rows(up, "该快照中没有排名上升的战队。")}
        <div class="divider"></div>
        <div class="side-title">下降</div>
        ${rows(down, "该快照中没有排名下降的战队。")}
      </section>`;
  }

  function renderRegionPulse(snapshot) {
    const regions = ["Europe", "Americas", "Asia"];
    const rows = regions.map((region) => {
      const teams = snapshot.standings.filter((team) => team.region === region);
      const leader = teams.slice().sort((a, b) => a.globalRank - b.globalRank)[0];
      return `
        <div class="rp-row">
          ${regionPill(region)}
          <span class="rp-name">${leader ? esc(leader.name) : "—"}</span>
          <span class="rp-count">${teams.length}</span>
        </div>`;
    }).join("");

    return `
      <section class="panel side-card">
        <div class="eyebrow">区域概览</div>
        <div class="side-title">${dateLabel(snapshot.date)}</div>
        ${rows}
      </section>`;
  }

  function renderMajorPath() {
    const q = DATA.qualification;
    if (!q) return "";
    const active = state.region === "Global" ? null : state.region;
    const regions = ["Europe", "Americas", "Asia"];
    return `
      <section class="panel side-card">
        <div class="eyebrow">Major 晋级线</div>
        <div class="side-title">各区域邀请线</div>
        ${regions.map((region) => {
          const bands = qualCutoffs(region);
          if (!bands.length) return "";
          return `
            <div class="mp-region ${active === region ? "active" : ""}">
              <div class="mp-head">
                ${regionPill(region)}
                <span class="mono muted small">${bands[bands.length - 1].to} 个名额</span>
              </div>
              ${bands.map((band) => `
                <div class="mp-band">
                  <span class="qual-badge qual-${band.key}">${band.label}</span>
                  <span class="mp-range mono">${band.from === band.to ? `#${band.to}` : `#${band.from}–#${band.to}`}</span>
                </div>`).join("")}
            </div>`;
        }).join("")}
        <div class="mp-note">${esc(q.asOf)} 名额分配 · 累计晋级线，并非实时晋级资格。</div>
      </section>`;
  }

  function renderDataHealth() {
    const detailCount = Object.keys(DATA.teams).length;
    return `
      <section class="panel side-card">
        <div class="eyebrow">数据状态</div>
        <div class="side-title">${fmtInt(detailCount)} 支有完整详情的阵容</div>
        <div class="rp-row"><span class="rp-name">已解析快照</span><span class="rp-count">${DATA.dates.length}</span></div>
        <div class="rp-row"><span class="rp-name">详情失败数</span><span class="rp-count ${DATA.failures.length ? "red" : ""}">${DATA.failures.length}</span></div>
        <div class="rp-row"><span class="rp-name">数据源</span><span class="rp-count">Valve</span></div>
        <div class="rp-row"><span class="rp-name">赛事数据</span><span class="rp-count">HLTV</span></div>
      </section>`;
  }

  /* ------------------------------------------------------------------ */
  /* Team                                                               */
  /* ------------------------------------------------------------------ */

  function renderTeam(id) {
    const team = DATA.teams[id];
    const snapshot = DATA.snapshots[DATA.latestDate];
    const summary = snapshot.standings.find((item) => item.id === id);

    if (!team && !summary) {
      return `
        <div class="empty" style="padding-top:80px">
          <div class="empty-icon">◌</div>
          <h2>未找到该阵容</h2>
          <p class="muted" style="margin-top:8px">当前数据快照中没有这个阵容。</p>
          <a class="ghost-btn" style="margin-top:18px;display:inline-flex" href="#/">返回排名</a>
        </div>`;
    }

    const base = team || summary;
    const history = historyFor(id);
    const previous = previousRow(id, DATA.latestDate);
    const delta = previous ? previous.globalRank - base.globalRank : null;
    const rankClass = base.globalRank === 1 ? "top1" : base.globalRank === 2 ? "top2" : base.globalRank === 3 ? "top3" : "";

    const header = `
      <section class="team-hero">
        <div>
          <a class="back-link" href="#/">← 返回排名</a>
          <div class="team-title-row">
            <span class="team-rank-big">#${base.globalRank}</span>
            <div>
              <h1 class="team-title">${esc(base.name)}</h1>
              <div class="team-meta">
                ${regionPill(base.region)}
                <span>区域排名 <strong class="mono">#${base.regionalRank || "—"}</strong></span>
                ${qualForRank(base.region, base.regionalRank) ? `<span class="team-meta-qual">${qualificationBadge(base.region, base.regionalRank)}</span>` : ""}
                <span>·</span>
                <span>${dateLabel(DATA.latestDate)} 快照</span>
              </div>
            </div>
          </div>
          <div class="roster-chips">
            ${base.roster.map((player) => `<span class="chip">${esc(player)}</span>`).join("")}
          </div>
        </div>
        <div class="team-hero-right">
          <div class="big-points">${fmtInt(base.points)}</div>
          <div class="points-label">VRS 积分</div>
          <div class="hero-delta ${previous ? `delta ${deltaClass(delta)}` : "delta flat"}">${previous ? `${deltaText(delta)}，较上一快照` : "该快照中的新阵容"}</div>
        </div>
      </section>`;

    if (!team) {
      return `
        ${header}
        <div class="notice">
          本原型只为最新快照打包了完整的比赛与因子数据。
          ${base.detailPath ? ` 你仍然可以查看<a href="${esc(DATA.source.repo)}/blob/main/${esc(base.detailPath)}" target="_blank" rel="noreferrer">官方详情文件</a>。` : ""}
        </div>
        <div class="stack" style="margin-top:16px">
          <section class="panel card">
            <div class="card-head">
              <div>
                <div class="eyebrow">历史</div>
                <div class="card-title">排名走势</div>
              </div>
            </div>
            ${renderHistoryChart(historySeries([{ ...base, history }], true), state.historyMode)}
          </section>
        </div>`;
    }

    return `
      ${header}

      <div class="stack">
        <div class="grid-2">
          <section class="panel card">
            <div class="card-head">
              <div>
                <div class="eyebrow">积分拆解</div>
                <div class="card-title">最终分数如何构成</div>
                <div class="card-sub">起始排名分加上交手调整。</div>
              </div>
            </div>
            ${renderWaterfall(team)}
          </section>

          <section class="panel card">
            <div class="card-head">
              <div>
                <div class="eyebrow">四个因子</div>
                <div class="card-title">起始排名分的输入</div>
                <div class="card-sub">每个因子都归一化到 0–1。</div>
              </div>
            </div>
            ${renderFactorCards(team)}
          </section>
        </div>

        <section class="panel card">
          <div class="card-head">
            <div>
              <div class="eyebrow">历史</div>
              <div class="card-title">排名走势</div>
              <div class="card-sub">实线：当前这套阵容（${history.length} 个快照）。虚线：同名战队的所有阵容（${(team.orgHistory || []).length} 个快照）。</div>
            </div>
            <div class="card-head-right">
              <div class="chart-toggle">
                <button class="${state.historyMode === "globalRank" ? "active" : ""}" data-action="set-history-mode" data-mode="globalRank">全球</button>
                <button class="${state.historyMode === "regionalRank" ? "active" : ""}" data-action="set-history-mode" data-mode="regionalRank">区域</button>
              </div>
            </div>
          </div>
          ${renderHistoryChart(historySeries([{ ...team, history }], true), state.historyMode)}
        </section>

        ${renderMatchPanel(team)}
        <div class="grid-2">
          ${renderWinnings(team)}
          ${renderRosterUsage(team)}
        </div>
        ${renderProvenance(team)}
      </div>`;
  }

  function renderWaterfall(team) {
    const start = Number(team.startingRankValue) || 0;
    const final = Number(team.finalRankValue) || 0;
    const h2h = Number(team.h2hAdjustment) || 0;
    const positive = final >= start;
    const width = 760;
    const height = 240;
    const pad = { left: 44, right: 24, top: 42, bottom: 42 };
    const lo = Math.min(start, final) - 40;
    const hi = Math.max(start, final) + 40;
    const plotH = height - pad.top - pad.bottom;
    const y = (value) => pad.top + ((hi - value) / (hi - lo)) * plotH;
    const baseline = y(lo);
    const barWidth = 150;
    const gap = 76;
    const x1 = pad.left + 16;
    const x2 = x1 + barWidth + gap;
    const x3 = x2 + barWidth + gap;
    const startY = y(start);
    const finalY = y(final);
    const deltaTop = Math.min(startY, finalY);
    const deltaHeight = Math.max(4, Math.abs(finalY - startY));
    const deltaColor = positive ? "var(--green)" : "var(--red)";
    const startHeight = Math.max(2, baseline - startY);
    const finalHeight = Math.max(2, baseline - finalY);

    return `
      <svg class="waterfall-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="从起始排名分到最终排名分的积分瀑布图">
        <defs>
          <linearGradient id="startBar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#d7e0ea" stop-opacity="0.95"/>
            <stop offset="100%" stop-color="#8b96a9" stop-opacity="0.35"/>
          </linearGradient>
          <linearGradient id="finalBar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#c8ff3d" stop-opacity="0.95"/>
            <stop offset="100%" stop-color="#c8ff3d" stop-opacity="0.3"/>
          </linearGradient>
        </defs>

        ${[0, 1, 2, 3].map((index) => {
          const value = lo + ((hi - lo) / 3) * index;
          const gy = y(value);
          return `
            <line x1="${pad.left}" y1="${gy}" x2="${width - pad.right}" y2="${gy}" stroke="#222a38" stroke-width="1" stroke-dasharray="3 5" opacity="0.7"/>
            <text x="${pad.left - 10}" y="${gy + 4}" fill="#5e697c" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="end">${Math.round(value)}</text>`;
        }).join("")}

        <rect x="${x1}" y="${startY}" width="${barWidth}" height="${startHeight}" rx="7" fill="url(#startBar)"/>
        <rect x="${x2}" y="${deltaTop}" width="${barWidth}" height="${deltaHeight}" rx="7" fill="${deltaColor}" opacity="0.9"/>
        <rect x="${x3}" y="${finalY}" width="${barWidth}" height="${finalHeight}" rx="7" fill="url(#finalBar)"/>

        <line x1="${x1 + barWidth}" y1="${startY}" x2="${x2}" y2="${startY}" stroke="#5e697c" stroke-width="1" stroke-dasharray="4 4"/>
        <line x1="${x2 + barWidth}" y1="${finalY}" x2="${x3}" y2="${finalY}" stroke="#5e697c" stroke-width="1" stroke-dasharray="4 4"/>

        <text x="${x1 + barWidth / 2}" y="${startY - 14}" fill="#f2f5f9" font-family="JetBrains Mono, monospace" font-size="15" font-weight="600" text-anchor="middle">${fmt(start, 1)}</text>
        <text x="${x2 + barWidth / 2}" y="${deltaTop - 14}" fill="${deltaColor}" font-family="JetBrains Mono, monospace" font-size="15" font-weight="600" text-anchor="middle">${positive ? "+" : ""}${fmt(h2h, 1)}</text>
        <text x="${x3 + barWidth / 2}" y="${finalY - 14}" fill="#c8ff3d" font-family="JetBrains Mono, monospace" font-size="15" font-weight="600" text-anchor="middle">${fmt(final, 1)}</text>

        <text x="${x1 + barWidth / 2}" y="${height - 16}" fill="#8b96a9" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">起始排名分</text>
        <text x="${x2 + barWidth / 2}" y="${height - 16}" fill="#8b96a9" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">交手调整</text>
        <text x="${x3 + barWidth / 2}" y="${height - 16}" fill="#8b96a9" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">最终排名分</text>
      </svg>
      <div class="waterfall-note">坐标轴经过截断，以便看清交手调整的幅度。这里显示的是排名分，不是表格中四舍五入后的积分。</div>`;
  }

  function renderFactorCards(team) {
    const factors = team.factors || {};
    return `
      <div class="factor-grid">
        ${FACTORS.map((factor) => {
          const value = Number(factors[factor.key]) || 0;
          const width = Math.max(2, Math.min(100, value * 100));
          let meta = "";
          if (factor.key === "bountyOffered" && team.top10ScaledWinnings !== null) {
            meta = `${money(team.top10ScaledWinnings)} TOP 10 折算奖金`;
          } else if (factor.key === "bountyCollected") {
            meta = "击败对手的赏金收集";
          } else if (factor.key === "opponentNetwork") {
            meta = "击败的不同对手数";
          } else if (factor.key === "lanWins") {
            meta = "时效加权 LAN 胜场";
          }

          return `
            <div class="factor-card">
              <div class="factor-top">
                <span class="factor-value" style="color:${factor.color}">${fmt(value, 3)}</span>
                <span class="factor-label">${factor.label}</span>
              </div>
              <div class="factor-bar"><i style="width:${width}%;background:${factor.color}"></i></div>
              <div class="factor-desc">${factor.desc}</div>
              ${meta ? `<div class="factor-meta">${meta}</div>` : ""}
            </div>`;
        }).join("")}
      </div>`;
  }

  function historySeries(teams, includeOrg) {
    const series = [];
    teams.forEach((team, index) => {
      const history = team.history || [];
      series.push({
        name: team.name,
        color: index === 0 ? "var(--lime)" : "var(--cyan)",
        history,
        dashed: false,
      });
      const org = team.orgHistory || orgHistoryFor(team.name);
      if (includeOrg && org.length > history.length) {
        series.push({
          name: `${team.name} · 所有阵容`,
          color: "var(--muted-2)",
          history: org,
          dashed: true,
        });
      }
    });
    return series;
  }

  function renderHistoryChart(seriesInput, mode) {
    const series = seriesInput.map((item) => ({ ...item, history: item.history || [] }));
    const dates = Array.from(new Set(series.flatMap((item) => item.history.map((entry) => entry.date)))).sort();
    if (dates.length < 2) {
      return `<div class="empty"><div class="empty-icon">◌</div><div>快照数量不足，无法绘制历史图。</div></div>`;
    }

    const values = series
      .flatMap((item) => dates.map((date) => {
        const entry = item.history.find((row) => row.date === date);
        return entry ? entry[mode] : null;
      }))
      .filter((value) => value !== null && value !== undefined && value > 0);
    if (!values.length) {
      return `<div class="empty"><div class="empty-icon">◌</div><div>当前视图没有排名历史。</div></div>`;
    }

    const width = 920;
    const height = 250;
    const pad = { left: 50, right: 22, top: 24, bottom: 34 };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const x = (index) => pad.left + (index / (dates.length - 1)) * plotW;
    const y = (value) => pad.top + ((value - min) / span) * plotH;

    const grid = [0, 1, 2, 3, 4].map((index) => {
      const value = min + (span / 4) * index;
      const gy = y(value);
      return `
        <line x1="${pad.left}" y1="${gy}" x2="${width - pad.right}" y2="${gy}" stroke="#222a38" stroke-width="1" stroke-dasharray="3 5" opacity="0.65"/>
        <text x="${pad.left - 10}" y="${gy + 4}" fill="#5e697c" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="end">#${Math.round(value)}</text>`;
    }).join("");

    const lines = series.map((item) => {
      const plotted = dates
        .map((date, index) => {
          const entry = item.history.find((row) => row.date === date);
          return entry ? { x: x(index), y: y(entry[mode]), value: entry[mode], date } : null;
        })
        .filter(Boolean);
      if (!plotted.length) return "";
      const path = plotted
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
        .join(" ");
      const dots = plotted
        .map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${item.dashed ? 2 : 2.8}" fill="${item.color}" opacity="${item.dashed ? 0.7 : 0.95}"><title>${esc(item.name)} · ${esc(point.date)} · #${point.value}</title></circle>`)
        .join("");
      return `<path d="${path}" fill="none" stroke="${item.color}" stroke-width="${item.dashed ? 1.6 : 2.4}" stroke-linecap="round" stroke-linejoin="round" ${item.dashed ? 'stroke-dasharray="5 4" opacity="0.7"' : ""}/>${dots}`;
    }).join("");

    const xLabels = [0, Math.floor((dates.length - 1) / 2), dates.length - 1]
      .filter((value, index, array) => array.indexOf(value) === index)
      .map((index) => `
        <text x="${x(index)}" y="${height - 12}" fill="#5e697c" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="${index === 0 ? "start" : index === dates.length - 1 ? "end" : "middle"}">${shortDate(dates[index])}</text>`)
      .join("");

    return `
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="排名历史图">
        ${grid}
        ${lines}
        ${xLabels}
      </svg>
      <div class="chart-legend">
        ${series.map((item) => `<span class="legend-item"><span class="legend-dot" style="background:${item.color}"></span>${esc(item.name)}</span>`).join("")}
      </div>`;
  }

  function renderMatchPanel(team) {
    const matches = (team.matches || []).slice().sort((a, b) => b.matchPlayed - a.matchPlayed);
    let filtered = matches;
    if (state.matchFilter === "wins") filtered = matches.filter((match) => match.result === "W");
    if (state.matchFilter === "losses") filtered = matches.filter((match) => match.result === "L");
    if (state.matchFilter === "top10") filtered = matches.filter(isTop10);

    const rows = filtered.map((match) => {
      const top10 = isTop10(match);
      return `
        <tr class="${top10 ? "top10-row" : ""}">
          <td class="mono muted-cell">${match.matchPlayed}</td>
          <td class="mono">${esc(match.date)}</td>
          <td class="opponent">${esc(match.opponent)}</td>
          <td><span class="wl ${match.result === "W" ? "win" : "loss"}">${match.result}</span></td>
          <td class="mono">${fmt(match.ageWeight, 3)}</td>
          <td class="mono">${match.eventWeight === null ? "—" : fmt(match.eventWeight, 3)}</td>
          <td>${pairCell(match.bountyRaw, match.bountyAdjusted)}</td>
          <td>${pairCell(match.networkRaw, match.networkAdjusted)}</td>
          <td>${lanCell(match)}</td>
          <td class="mono ${match.h2h > 0 ? "h2h-pos" : match.h2h < 0 ? "h2h-neg" : "h2h-zero"}">${match.h2h > 0 ? "+" : ""}${fmt(match.h2h, 2)}</td>
          <td class="roster-cell" title="${esc(match.roster.join(", "))}">${esc(match.roster.join(", "))}</td>
        </tr>`;
    }).join("");

    return `
      <section class="panel match-panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">比赛贡献</div>
            <div class="panel-sub">${matches.length} 场比赛 · 高亮行为进入前十因子的比赛</div>
          </div>
          <div class="panel-head-right">
            <div class="match-filters">
              <button class="filter-btn ${state.matchFilter === "all" ? "active" : ""}" data-action="set-match-filter" data-filter="all">全部</button>
              <button class="filter-btn ${state.matchFilter === "wins" ? "active" : ""}" data-action="set-match-filter" data-filter="wins">胜</button>
              <button class="filter-btn ${state.matchFilter === "losses" ? "active" : ""}" data-action="set-match-filter" data-filter="losses">负</button>
              <button class="filter-btn ${state.matchFilter === "top10" ? "active" : ""}" data-action="set-match-filter" data-filter="top10">TOP 10</button>
            </div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="match-table">
            <thead>
              <tr>
                <th>#</th>
                <th>日期</th>
                <th>对手</th>
                <th>胜/负</th>
                <th>时效</th>
                <th>赛事</th>
                <th>赏金</th>
                <th>对手网络</th>
                <th>LAN</th>
                <th>交手</th>
                <th>使用阵容</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="11"><div class="empty">当前筛选下没有比赛。</div></td></tr>`}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function pairCell(raw, adjusted) {
    if (raw === null || raw === undefined) return `<span class="muted-cell">—</span>`;
    return `<span class="mono">${fmt(raw, 3)}</span> <span class="muted-cell">(${fmt(adjusted, 3)})</span>`;
  }

  function lanCell(match) {
    if (match.lanWin === null || match.lanWin === undefined) return `<span class="muted-cell">—</span>`;
    return `<span class="${match.lanWin ? "green" : "muted-cell"}">${match.lanWin ? "✓" : "✗"} ${fmt(match.lanAdjusted, 3)}</span>`;
  }

  function renderWinnings(team) {
    const winnings = team.winnings || [];
    const total = winnings.reduce((sum, item) => sum + item.scaled, 0);
    return `
      <section class="panel card">
        <div class="card-head">
          <div>
            <div class="eyebrow">赏金获取</div>
            <div class="card-title">TOP 10 折算奖金</div>
            <div class="card-sub">用于种子分的时效加权奖金。</div>
          </div>
        </div>
        ${winnings.length ? `
          <div class="table-wrap">
            <table class="winnings-table">
              <thead>
                <tr><th>比赛日期</th><th>时效</th><th style="text-align:right">奖金</th><th style="text-align:right">折算</th></tr>
              </thead>
              <tbody>
                ${winnings.map((item) => `
                  <tr>
                    <td class="mono">${esc(item.date)}</td>
                    <td class="mono">${fmt(item.ageWeight, 3)}</td>
                    <td class="money">${money(item.prize)}</td>
                    <td class="money">${money(item.scaled)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
          <div class="winnings-total"><span>折算总额</span><strong>${money(total)}</strong></div>
        ` : `<div class="empty">当前时间窗口内没有奖金记录。</div>`}
      </section>`;
  }

  function renderRosterUsage(team) {
    const groups = new Map();
    (team.matches || []).forEach((match) => {
      const key = match.roster.join(", ");
      if (!groups.has(key)) {
        groups.set(key, { players: match.roster, dates: [], wins: 0, losses: 0 });
      }
      const group = groups.get(key);
      group.dates.push(match.date);
      if (match.result === "W") group.wins += 1;
      else group.losses += 1;
    });

    const items = Array.from(groups.values()).sort((a, b) => b.dates.length - a.dates.length).slice(0, 6);

    return `
      <section class="panel card">
        <div class="card-head">
          <div>
            <div class="eyebrow">阵容身份</div>
            <div class="card-title">比赛所用阵容</div>
            <div class="card-sub">VRS 依据阵容，而不只是队名。</div>
          </div>
        </div>
        ${items.length ? `
          <div class="roster-list">
            ${items.map((item) => `
              <div class="roster-item">
                <div class="roster-item-head">
                  <span class="roster-item-players">${esc(item.players.join(", "))}</span>
                  <span class="roster-record">${item.wins}–${item.losses}</span>
                </div>
                <div class="roster-item-meta">${shortDate(item.dates.slice().sort()[0])} – ${shortDate(item.dates.slice().sort().reverse()[0])} · ${item.dates.length} 场比赛</div>
              </div>`).join("")}
          </div>
        ` : `<div class="empty">没有阵容数据。</div>`}
      </section>`;
  }

  function renderProvenance(team) {
    return `
      <section class="panel card">
        <div class="card-head">
          <div>
            <div class="eyebrow">数据来源</div>
            <div class="card-title">这些数据从哪里来</div>
          </div>
        </div>
        <div class="prose" style="margin-top:0">
          <p>本页解析自 Valve 官方区域排名 Markdown，并非 Valve 官方产品。</p>
          <p style="margin-top:8px">
            <a href="${esc(DATA.source.repo)}/blob/main/${esc(team.detailPath)}" target="_blank" rel="noreferrer">打开官方详情文件 ↗</a>
          </p>
          <p style="margin-top:8px">区域排名的赛事数据由 HLTV.org 提供。</p>
        </div>
      </section>`;
  }

  /* ------------------------------------------------------------------ */
  /* Compare                                                            */
  /* ------------------------------------------------------------------ */

  function compareTeams() {
    const snapshot = DATA.snapshots[DATA.latestDate];
    const standings = snapshot.standings.slice().sort((a, b) => a.globalRank - b.globalRank);
    const byId = new Map(standings.map((team) => [team.id, team]));

    let ids = state.compare.filter((id) => byId.has(id));
    ids = ids.slice(0, MAX_COMPARE);

    return ids.map((id, index) => {
      const summary = byId.get(id) || {};
      const detail = DATA.teams[id] || {};
      return {
        ...detail,
        ...summary,
        id,
        name: detail.name || summary.name,
        region: detail.region || summary.region,
        color: TEAM_COLORS[index % TEAM_COLORS.length],
        history: historyFor(id),
      };
    });
  }

  function renderCompare() {
    const teams = compareTeams();
    if (!teams.length) {
      return `
        <div class="empty" style="padding-top:80px">
          <div class="empty-icon">⇄</div>
          <h2>至少选择两支战队</h2>
          <p class="muted" style="margin-top:8px">在排名表中勾选对比框，然后打开对比栏。</p>
          <a class="ghost-btn" style="margin-top:18px;display:inline-flex" href="#/">浏览排名</a>
        </div>`;
    }
    if (teams.length < 2) {
      return `
        ${renderCompareRail(teams)}
        <div class="empty" style="padding:60px 0">
          <div class="empty-icon">⇄</div>
          <div>再加一个阵容即可开始对比。</div>
        </div>`;
    }

    return `
      ${renderCompareRail(teams)}
      <div class="stack">
        ${renderCompareSummary(teams)}
        <div class="compare-grid">
          <section class="panel card">
            <div class="card-head">
              <div>
                <div class="eyebrow">形态</div>
                <div class="card-title">因子雷达图</div>
                <div class="card-sub">每个种子因子一个轴，数值归一化到 0 → 1。</div>
              </div>
            </div>
            ${renderRadar(teams)}
          </section>
          <section class="panel card">
            <div class="card-head">
              <div>
                <div class="eyebrow">因子对比</div>
                <div class="card-title">各阵容的优势</div>
              </div>
            </div>
            ${renderFactorBars(teams)}
          </section>
        </div>
        <section class="panel card">
          <div class="card-head">
            <div>
              <div class="eyebrow">分数公式</div>
              <div class="card-title">起始分 + 交手调整</div>
              <div class="card-sub">起始分是种子分，交手调整在其后叠加。</div>
            </div>
          </div>
          ${renderScoreTable(teams)}
        </section>
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">共同对手</div>
              <div class="panel-sub">所选阵容对同一对手的战绩。</div>
            </div>
          </div>
          ${renderCommonOpponents(teams)}
        </section>
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">交手矩阵</div>
              <div class="panel-sub">所选阵容之间的直接交手。</div>
            </div>
          </div>
          ${renderH2HMatrix(teams)}
        </section>
        <section class="panel card">
          <div class="card-head">
            <div>
              <div class="eyebrow">历史</div>
              <div class="card-title">排名走势</div>
            </div>
          </div>
          ${renderHistoryChart(
            teams.map((team) => ({ name: team.name, color: team.color, history: team.history })),
            "globalRank"
          )}
        </section>
      </div>`;
  }

  function renderCompareRail(teams) {
    const snapshot = DATA.snapshots[DATA.latestDate];
    const selected = new Set(teams.map((team) => team.id));
    const available = snapshot.standings
      .slice()
      .sort((a, b) => a.globalRank - b.globalRank)
      .filter((team) => !selected.has(team.id));

    return `
      <section class="compare-rail">
        ${teams.map((team) => `
          <div class="compare-card" style="--team:${team.color}">
            <button class="compare-card-remove" data-action="compare-remove" data-id="${esc(team.id)}" aria-label="移除 ${esc(team.name)}">×</button>
            <div class="compare-card-rank">#${team.globalRank}</div>
            <div class="compare-card-name">${esc(team.name)}</div>
            <div class="compare-card-meta">${regionPill(team.region)}<span class="mono">${fmtInt(team.points)}</span></div>
            <div class="compare-card-roster">${esc((team.roster || []).join(", "))}</div>
          </div>`).join("")}
        ${teams.length < MAX_COMPARE ? `
          <div class="compare-card compare-card-add">
            <div class="compare-card-rank">+</div>
            <div class="compare-card-name">添加战队</div>
            <select class="select compare-add" data-action="compare-add" aria-label="添加战队到对比">
              <option value="">选择战队…</option>
              ${available.map((team) => `<option value="${esc(team.id)}">#${team.globalRank} · ${esc(team.name)}</option>`).join("")}
            </select>
          </div>` : ""}
      </section>`;
  }

  function renderCompareSummary(teams) {
    const row = (label, valueFor) => `
      <tr>
        <th scope="row">${label}</th>
        ${teams.map((team) => `<td>${valueFor(team)}</td>`).join("")}
      </tr>`;

    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">并排对比</div>
            <div class="panel-sub">${teams.length} 个阵容 · ${esc(DATA.latestDate)} 快照</div>
          </div>
          <div class="panel-head-right">
            <button class="ghost-btn" data-action="compare-clear">清空选择</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="compare-summary">
            <thead>
              <tr>
                <th></th>
                ${teams.map((team) => `<th style="--team:${team.color}"><span class="team-dot" style="background:${team.color}"></span>${esc(team.name)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${row("全球排名", (team) => `<span class="mono">#${team.globalRank}</span>`)}
              ${row("区域", (team) => `${regionPill(team.region)} <span class="muted small mono">#${team.regionalRank || "—"}</span>`)}
              ${row("VRS 积分", (team) => `<span class="mono lime">${fmtInt(team.points)}</span>`)}
              ${row("起始分", (team) => `<span class="mono">${fmt(team.startingRankValue, 1)}</span>`)}
              ${row("交手调整", (team) => `<span class="mono ${team.h2hAdjustment > 0 ? "h2h-pos" : team.h2hAdjustment < 0 ? "h2h-neg" : "h2h-zero"}">${team.h2hAdjustment > 0 ? "+" : ""}${fmt(team.h2hAdjustment, 1)}</span>`)}
              ${row("最终分", (team) => `<span class="mono">${fmt(team.finalRankValue, 1)}</span>`)}
              ${row("已统计比赛", (team) => `<span class="mono">${fmtInt((team.matches || []).length)}</span>`)}
              ${row("Major 晋级线", (team) => qualificationBadge(team.region, team.regionalRank))}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function renderRadar(teams) {
    const width = 420;
    const height = 380;
    const cx = width / 2;
    const cy = height / 2 + 4;
    const maxR = 96;
    const axes = FACTORS;
    const step = (Math.PI * 2) / axes.length;
    const angle = (index) => -Math.PI / 2 + index * step;
    const point = (index, value) => {
      const r = Math.max(0, Math.min(1, value)) * maxR;
      return [cx + Math.cos(angle(index)) * r, cy + Math.sin(angle(index)) * r];
    };

    const ring = (fraction) => axes
      .map((_, index) => {
        const [px, py] = point(index, fraction);
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      })
      .join(" ");

    const grid = [0.25, 0.5, 0.75, 1].map((fraction) => `
      <polygon points="${ring(fraction)}" fill="none" stroke="#222a38" stroke-width="1" opacity="0.9"/>
    `).join("");

    const spokes = axes.map((_, index) => {
      const [px, py] = point(index, 1);
      return `<line x1="${cx}" y1="${cy}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" stroke="#222a38" stroke-width="1"/>`;
    }).join("");

    const labels = axes.map((factor, index) => {
      const [px, py] = point(index, 1.32);
      const anchor = Math.abs(px - cx) < 12 ? "middle" : px > cx ? "start" : "end";
      return `<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" fill="#8b96a9" font-family="Inter, sans-serif" font-size="11" text-anchor="${anchor}" dominant-baseline="middle">${esc(factor.label)}</text>`;
    }).join("");

    const shapes = teams.map((team) => {
      const values = axes.map((factor) => Number(team.factors?.[factor.key]) || 0);
      const points = values.map((value, index) => point(index, value).map((n) => n.toFixed(1)).join(",")).join(" ");
      const dots = values.map((value, index) => {
        const [px, py] = point(index, value);
        return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6" fill="${team.color}"/>`;
      }).join("");
      return `
        <polygon points="${points}" fill="${team.color}" fill-opacity="0.10" stroke="${team.color}" stroke-width="2" stroke-linejoin="round"/>
        ${dots}`;
    }).join("");

    return `
      <svg class="radar-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="因子雷达对比">
        ${grid}
        ${spokes}
        ${shapes}
        ${labels}
      </svg>
      <div class="chart-legend">
        ${teams.map((team) => `<span class="legend-item"><span class="legend-dot" style="background:${team.color}"></span>${esc(team.name)}</span>`).join("")}
      </div>`;
  }

  function renderFactorBars(teams) {
    return `
      <div class="factor-bars">
        ${FACTORS.map((factor) => `
          <div class="factor-bar-group">
            <div class="factor-bar-label">${esc(factor.label)}</div>
            ${teams.map((team) => {
              const value = Number(team.factors?.[factor.key]) || 0;
              return `
                <div class="factor-bar-row">
                  <span class="factor-bar-name">${esc(team.name)}</span>
                  <div class="factor-bar-track"><i style="width:${Math.max(1.5, value * 100)}%;background:${team.color}"></i></div>
                  <span class="factor-bar-value mono">${fmt(value, 3)}</span>
                </div>`;
            }).join("")}
          </div>`).join("")}
      </div>`;
  }

  function renderScoreTable(teams) {
    const max = Math.max(...teams.map((team) => Number(team.finalRankValue) || 0), 1);
    return `
      <div class="table-wrap">
        <table class="score-table">
          <thead>
            <tr>
              <th>阵容</th>
              <th style="text-align:right">起始</th>
              <th style="text-align:right">交手</th>
              <th style="text-align:right">最终</th>
              <th style="width:38%">相对最高值的占比</th>
            </tr>
          </thead>
          <tbody>
            ${teams.map((team) => {
              const final = Number(team.finalRankValue) || 0;
              const h2h = Number(team.h2hAdjustment) || 0;
              return `
                <tr>
                  <td><span class="team-dot" style="background:${team.color}"></span>${esc(team.name)}</td>
                  <td class="mono" style="text-align:right">${fmt(team.startingRankValue, 1)}</td>
                  <td class="mono ${h2h > 0 ? "h2h-pos" : h2h < 0 ? "h2h-neg" : "h2h-zero"}" style="text-align:right">${h2h > 0 ? "+" : ""}${fmt(h2h, 1)}</td>
                  <td class="mono" style="text-align:right">${fmt(final, 1)}</td>
                  <td>
                    <div class="score-track"><i style="width:${Math.max(2, (final / max) * 100)}%;background:${team.color}"></i></div>
                  </td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function opponentMap(team) {
    const map = new Map();
    (team.matches || []).forEach((match) => {
      const key = match.opponent.trim().toLowerCase();
      if (!map.has(key)) map.set(key, { name: match.opponent, wins: 0, losses: 0, total: 0 });
      const record = map.get(key);
      record.total += 1;
      if (match.result === "W") record.wins += 1;
      else record.losses += 1;
    });
    return map;
  }

  function renderCommonOpponents(teams) {
    const maps = teams.map(opponentMap);
    const counts = new Map();
    maps.forEach((map) => {
      map.forEach((_, key) => counts.set(key, (counts.get(key) || 0) + 1));
    });

    const shared = Array.from(counts.entries())
      .filter(([, count]) => count >= 2)
      .map(([key]) => {
        const records = maps.map((map) => map.get(key) || null);
        const name = (records.find(Boolean) || {}).name || key;
        const total = records.reduce((sum, record) => sum + (record ? record.total : 0), 0);
        return { key, name, records, total };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 12);

    if (!shared.length) {
      return `<div class="empty"><div class="empty-icon">◌</div><div>当前时间窗口内没有共同对手。</div></div>`;
    }

    return `
      <div class="table-wrap">
        <table class="compare-table common-table">
          <thead>
            <tr>
              <th>对手</th>
              ${teams.map((team) => `<th><span class="team-dot" style="background:${team.color}"></span>${esc(team.name)}</th>`).join("")}
              <th>场次</th>
            </tr>
          </thead>
          <tbody>
            ${shared.map((item) => `
              <tr>
                <td>${esc(item.name)}</td>
                ${item.records.map((record) => {
                  if (!record) return `<td class="muted-cell mono">—</td>`;
                  const tone = record.wins > record.losses ? "good" : record.losses > record.wins ? "bad" : "";
                  return `<td><span class="compare-record ${tone}">${record.wins}–${record.losses}</span></td>`;
                }).join("")}
                <td class="mono muted-cell">${item.total}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderH2HMatrix(teams) {
    const record = (from, to) => {
      const target = to.name.trim().toLowerCase();
      const rows = (from.matches || []).filter((match) => match.opponent.trim().toLowerCase() === target);
      if (!rows.length) return null;
      const wins = rows.filter((match) => match.result === "W").length;
      return { wins, losses: rows.length - wins, rows };
    };

    const cells = [];
    teams.forEach((row) => {
      teams.forEach((col) => {
        if (row.id === col.id) {
          cells.push({ row, col, self: true });
          return;
        }
        cells.push({ row, col, result: record(row, col) });
      });
    });

    const anyDirect = cells.some((cell) => cell.result);
    if (!anyDirect) {
      return `<div class="empty"><div class="empty-icon">◌</div><div>当前时间窗口内这些阵容没有直接交手。</div></div>`;
    }

    const matchRows = [];
    const seen = new Set();
    teams.forEach((row, index) => {
      teams.slice(index + 1).forEach((col) => {
        const forward = record(row, col);
        const backward = forward ? null : record(col, row);
        const owner = forward ? row : col;
        const other = forward ? col : row;
        (forward || backward || { rows: [] }).rows.forEach((match) => {
          const key = [owner.name, other.name, match.date, match.result, match.h2h, match.eventWeight].join("|");
          if (seen.has(key)) return;
          seen.add(key);
          matchRows.push({ ...match, row: owner, col: other });
        });
      });
    });
    matchRows.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    return `
      <div class="h2h-wrap">
        <div class="table-wrap">
          <table class="h2h-matrix">
            <thead>
              <tr>
                <th></th>
                ${teams.map((team) => `<th><span class="team-dot" style="background:${team.color}"></span>${esc(team.name)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${teams.map((row) => `
                <tr>
                  <th scope="row"><span class="team-dot" style="background:${row.color}"></span>${esc(row.name)}</th>
                  ${teams.map((col) => {
                    if (row.id === col.id) return `<td class="h2h-self mono">—</td>`;
                    const result = record(row, col);
                    if (!result) return `<td class="h2h-empty mono">·</td>`;
                    const tone = result.wins > result.losses ? "good" : result.losses > result.wins ? "bad" : "";
                    return `<td class="mono ${tone}">${result.wins}–${result.losses}</td>`;
                  }).join("")}
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <details class="h2h-details">
          <summary>${matchRows.length} 场直接交手</summary>
          <div class="table-wrap">
            <table class="compare-table">
              <thead>
                <tr><th>日期</th><th>对阵</th><th>结果</th><th>交手调整</th><th>赛事权重</th></tr>
              </thead>
              <tbody>
                ${matchRows.map((match) => `
                  <tr>
                    <td class="mono">${esc(match.date)}</td>
                    <td>${esc(match.row.name)} vs ${esc(match.col.name)}</td>
                    <td><span class="wl ${match.result === "W" ? "win" : "loss"}">${match.result}</span></td>
                    <td class="mono ${match.h2h > 0 ? "h2h-pos" : match.h2h < 0 ? "h2h-neg" : "h2h-zero"}">${match.h2h > 0 ? "+" : ""}${fmt(match.h2h, 2)}</td>
                    <td class="mono muted-cell">${match.eventWeight === null ? "—" : fmt(match.eventWeight, 3)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </details>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Methodology                                                        */
  /* ------------------------------------------------------------------ */

  function renderMethodology() {
    const detailed = Object.keys(DATA.teams).length;
    const total = DATA.snapshots[DATA.latestDate]?.teamCount || 0;
    return `
      <div class="methodology">
        <div class="eyebrow"><span class="live-dot"></span> 方法说明与数据来源</div>
        <h1>这个网站是什么，不是什么。</h1>
        <p class="lead">VRS Lab 是一个非官方的 Valve 区域排名（VRS）浏览器。它把 Valve 公布的 Markdown 转成易读的分数拆解，不重新计算排名，也与 Valve、HLTV 没有隶属关系。</p>

        <div class="method-grid">
          <section class="method-card">
            <h3>我们展示什么</h3>
            <ul>
              <li>Valve 公开仓库中的官方月度排名。</li>
              <li>每个阵容的四个种子因子与交手调整。</li>
              <li>官方详情文件中的每一场比赛，包括时效与赛事权重。</li>
              <li>跨 ${DATA.dates.length} 个已解析快照的排名历史。</li>
            </ul>
          </section>

          <section class="method-card">
            <h3>我们不做什么</h3>
            <ul>
              <li>不重新计算 VRS，也不预测官方积分。</li>
              <li>不抓取 HLTV，也不使用非公开数据。</li>
              <li>不推断赛事名称——官方详情表本身不包含这些信息。</li>
              <li>不把同名阵容当成同一支战队。阵容身份由选手集合决定；虚线只是视觉辅助，不代表身份。</li>
            </ul>
          </section>

          <section class="method-card">
            <h3>分数公式</h3>
            <p>最终排名分 = 起始种子分 + 交手调整。</p>
            <div class="formula">最终 = 起始 + 交手<br><br>起始 = 400 + ((avg − min) / (max − min)) × 1600<br><br>avg = mean(赏金获取, 赏金收集,<br>            对手网络, LAN 胜场)</div>
            <p style="margin-top:10px">四个因子都归一化到 0–1。赏金与对手网络因子取过去六个月中最好的十项成绩，并按时间与赛事级别加权。</p>
          </section>

          <section class="method-card">
            <h3>晋级线</h3>
            <p>排名页可以在区域表上绘制 Major 邀请线。它们使用最近一次公布的名额分配——<strong>${esc(DATA.qualification?.asOf || "未加载名额表")}</strong>——并非实时预测。</p>
            <div class="qual-table-wrap">
              <table class="qual-table">
                <thead>
                  <tr><th>区域</th><th>第三阶段</th><th>第二阶段</th><th>第一阶段</th></tr>
                </thead>
                <tbody>
                  ${["Europe", "Americas", "Asia"].map((region) => {
                    const bands = qualCutoffs(region);
                    if (!bands.length) return "";
                    const byKey = new Map(bands.map((band) => [band.key, band]));
                    const cell = (key) => {
                      const band = byKey.get(key);
                      return band ? `<span class="mono">${band.from === band.to ? `#${band.to}` : `#${band.from}–#${band.to}`}</span>` : `<span class="muted-cell">—</span>`;
                    };
                    return `<tr><td>${regionPill(region)}</td><td>${cell("stage3")}</td><td>${cell("stage2")}</td><td>${cell("stage1")}</td></tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
            <p class="small muted" style="margin-top:10px">Valve 每个 Major 周期都会根据上一届 Major 的各区域成绩重新计算这张表，所以数字可能变化。请把晋级线当作历史参考，而不是邀请资格。</p>
          </section>

          <section class="method-card">
            <h3>数据状态</h3>
            <ul>
              <li>已解析快照：<strong>${DATA.dates.length}</strong></li>
              <li>最新排名战队数：<strong>${fmtInt(total)}</strong></li>
              <li>有完整详情的阵容：<strong>${fmtInt(detailed)}</strong></li>
              <li>详情解析失败：<strong>${DATA.failures.length}</strong></li>
            </ul>
          </section>
        </div>

        <div class="prose">
          <h2>数据源</h2>
          <p>排名与详情文件来自 <a href="${esc(DATA.source.repo)}" target="_blank" rel="noreferrer">ValveSoftware/counter-strike_regional_standings</a>。详情页注明区域排名的赛事数据由 HLTV.org 提供。</p>

          <h2>为什么阵容身份很重要</h2>
          <p>VRS 以阵容为基础。阵容由一起上场比赛的选手决定，而不是由俱乐部名称决定。在本原型中，稳定的 ID 由排序后的选手集合生成，因此阵容变动会产生新的实体和新的历史线。</p>

          <h2>晋级线</h2>
          <p>虚线晋级线只是阅读辅助，不是预测。Valve 根据各区域在上一届 Major 的表现分配 Major 名额，并在每个周期重新发布这张表。本原型内置 Winter 2025 名额表，并在所有使用处标注其 <code>asOf</code> 日期。由于当前快照可能属于另一个周期，排在晋级线之上的战队不一定获得邀请。</p>

          <h2>已知限制</h2>
          <p>官方详情表不包含赛事名称，因此比赛行只能按日期、对手和赛事权重分组。本原型也只为最新快照打包完整比赛详情；更早的快照仅用于排名历史。Valve 可能调整模型，官方仓库也不一定与生产环境完全一致。</p>

          <h2>免责声明</h2>
          <p>这是一个非官方的粉丝原型，未获得 Valve、HLTV 或任何赛事主办方的认可。请勿将其作为官方邀请或参赛资格决策的依据。</p>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Live updates                                                       */
  /* ------------------------------------------------------------------ */

  function setLive(tone, text, title) {
    const changed = live.tone !== tone || live.text !== text || live.title !== title;
    live.tone = tone;
    live.text = text;
    live.title = title;
    if (!changed) return;
    const el = document.querySelector(".live-status");
    if (!el) return;
    el.className = `live-status ${tone}`;
    el.title = title;
    const label = el.querySelector(".live-text");
    if (label) label.textContent = text;
  }

  function schedulePoll(delay) {
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(() => checkForUpdates(false), delay);
  }

  async function fetchMeta() {
    const res = await fetch(`/api/meta?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) throw new Error("响应不是 JSON");
    return res.json();
  }

  async function adoptBundle(version) {
    const res = await fetch(`data.js?v=${encodeURIComponent(version)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`data.js HTTP ${res.status}`);
    const text = await res.text();
    const next = new Function(`${text}\nreturn window.VRS_DATA;`)();
    adoptData(next);
  }

  function adoptData(next) {
    if (!next || !next.snapshots || !next.latestDate) return;
    const previousLatest = DATA.latestDate;
    DATA = next;
    buildHistoryIndex();

    if (!DATA.snapshots[state.snapshotDate] || state.snapshotDate === previousLatest) {
      state.snapshotDate = DATA.latestDate;
    }

    const ids = new Set((DATA.snapshots[DATA.latestDate]?.standings || []).map((team) => team.id));
    state.compare = state.compare.filter((id) => ids.has(id));

    live.builtAt = DATA.builtAt || null;
    live.tone = "synced";
    live.text = `已同步 · ${shortDate(DATA.latestDate)}`;
    live.title = `已与本地更新服务同步。最新官方快照：${DATA.latestDate}。`;
    render();
    showToast(`已载入新的官方快照：${dateLabel(DATA.latestDate)}`, 5000);
  }

  async function checkForUpdates(manual = false) {
    if (liveBusy) {
      if (manual) showToast("正在检查更新，请稍候。");
      return;
    }
    liveBusy = true;
    if (manual) setLive("checking", "正在检查…", "正在向本地服务查询最新快照。");
    try {
      const meta = await fetchMeta();
      live.available = true;

      if (meta.lastError) {
        setLive("warn", "更新失败 · 使用缓存", meta.lastError);
        schedulePoll(120000);
      } else if (meta.building || meta.checking) {
        setLive("building", "正在检查官方数据源…", "本地服务正在检查 Valve 仓库。");
        schedulePoll(8000);
      } else if (meta.builtAt && meta.builtAt !== (live.builtAt || DATA.builtAt)) {
        if (DATA.builtAt === meta.builtAt) {
          live.builtAt = meta.builtAt;
          setLive(
            "synced",
            `已同步 · ${shortDate(DATA.latestDate)}`,
            `已与本地更新服务同步。最新官方快照：${DATA.latestDate}。`,
          );
          schedulePoll(60000);
        } else {
          setLive("building", "发现新快照 · 加载中…", "正在下载重新构建的数据包。");
          try {
            await adoptBundle(meta.builtAt);
          } catch (err) {
            setLive("warn", "请刷新页面更新", `无法加载新数据包：${err.message}`);
          }
          schedulePoll(60000);
        }
      } else {
        setLive(
          "synced",
          `已同步 · ${shortDate(DATA.latestDate)}`,
          `已与本地更新服务同步。最新官方快照：${DATA.latestDate}。`,
        );
        schedulePoll(60000);
        if (manual) showToast("已是最新版本。");
      }
    } catch (err) {
      live.available = false;
      setLive(
        "offline",
        "静态版本",
        "实时更新需要本地 Python 服务（python scripts/dev_server.py）。",
      );
      schedulePoll(300000);
      if (manual) showToast("实时更新需要本地 Python 服务。");
    } finally {
      liveBusy = false;
    }
  }

  function initLiveUpdates() {
    if (window.location.protocol === "file:") {
      setLive("offline", "静态版本", "实时更新需要本地 Python 服务。");
      return;
    }
    window.setTimeout(() => checkForUpdates(false), 1500);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdates(false);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                             */
  /* ------------------------------------------------------------------ */

  function onClick(event) {
    const actionEl = event.target.closest("[data-action]");
    if (actionEl) {
      const action = actionEl.dataset.action;

      if (action === "toggle-menu") {
        document.getElementById("sidebar")?.classList.toggle("open");
        return;
      }
      if (action === "check-updates") {
        event.preventDefault();
        checkForUpdates(true);
        return;
      }
      if (action === "set-region") {
        state.region = actionEl.dataset.region;
        state.limit = 50;
        render();
        return;
      }
      if (action === "toggle-compare") {
        event.stopPropagation();
        toggleCompare(actionEl.dataset.id);
        return;
      }
      if (action === "compare-remove") {
        event.stopPropagation();
        toggleCompare(actionEl.dataset.id);
        return;
      }
      if (action === "compare-clear") {
        state.compare = [];
        syncCompareHash();
        render();
        return;
      }
      if (action === "compare-open") {
        if (state.compare.length < 2) return;
        navigate(`#/compare?t=${state.compare.slice(0, MAX_COMPARE).join(",")}`);
        return;
      }
      if (action === "show-all") {
        state.limit = 1000;
        render();
        return;
      }
      if (action === "set-match-filter") {
        state.matchFilter = actionEl.dataset.filter;
        render();
        return;
      }
      if (action === "set-history-mode") {
        state.historyMode = actionEl.dataset.mode;
        render();
        return;
      }
      if (action === "open-team") {
        navigate(`#/team/${actionEl.dataset.id}`);
        return;
      }
    }

    const row = event.target.closest("tr[data-team-id]");
    if (row && !event.target.closest("input, a, button, select")) {
      navigate(`#/team/${row.dataset.teamId}`);
    }
  }

  function toggleCompare(id) {
    if (!id) return;
    const index = state.compare.indexOf(id);
    if (index >= 0) {
      state.compare.splice(index, 1);
      syncCompareHash();
      render();
      return;
    }
    if (state.compare.length >= MAX_COMPARE) {
      showToast(`最多同时对比 ${MAX_COMPARE} 支战队。`);
      render();
      return;
    }
    state.compare.push(id);
    syncCompareHash();
    render();
  }

  function syncCompareHash() {
    if (route.view !== "compare") return;
    const ids = state.compare.slice(0, MAX_COMPARE);
    const hash = ids.length >= 2 ? `#/compare?t=${ids.join(",")}` : "#/compare";
    window.history.replaceState(null, "", hash);
    route = parseHash();
  }

  function onChange(event) {
    const target = event.target;
    if (target.id === "snapshot-select") {
      state.snapshotDate = target.value;
      state.limit = 50;
      const ids = new Set((DATA.snapshots[state.snapshotDate]?.standings || []).map((team) => team.id));
      const before = state.compare.length;
      state.compare = state.compare.filter((id) => ids.has(id));
      if (state.compare.length !== before) {
        showToast("部分已选阵容不在该快照中。");
      }
      render();
      return;
    }
    if (target.id === "sort-select") {
      state.sort = target.value;
      render();
      return;
    }
    if (target.dataset.action === "compare-add") {
      const value = target.value;
      if (value) toggleCompare(value);
      return;
    }
  }

  function onInput(event) {
    if (event.target.id !== "global-search") return;
    state.search = event.target.value;
    const position = event.target.selectionStart;

    if (route.view !== "rankings") {
      window.history.replaceState(null, "", "#/");
      route = parseHash();
    }
    render();

    const input = document.getElementById("global-search");
    if (input) {
      input.focus();
      input.setSelectionRange(position, position);
    }
  }

  window.addEventListener("hashchange", () => {
    route = parseHash();
    document.getElementById("sidebar")?.classList.remove("open");
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
  });

  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);

  render();
  initLiveUpdates();
})();
