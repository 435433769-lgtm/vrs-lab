(() => {
  "use strict";

  const LANG_KEY = "vrs-lang";

  function detectLang() {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("lang");
      if (fromUrl === "zh" || fromUrl === "en") return fromUrl;
    } catch (err) {
      // URLSearchParams is unavailable in very old browsers.
    }
    try {
      const saved = window.localStorage.getItem(LANG_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch (err) {
      // localStorage can be blocked in private mode.
    }
    return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  let lang = detectLang();

  function isZh() {
    return lang === "zh";
  }

  function L(zh, en) {
    return isZh() ? zh : en;
  }

  function locale() {
    return isZh() ? "zh-CN" : "en-US";
  }

  function applyDocumentLang() {
    document.documentElement.lang = isZh() ? "zh-CN" : "en";
    document.title = L(
      "VRS Lab — Valve 区域排名，拆开看",
      "VRS Lab — Valve Regional Standings, explained",
    );
    const description = document.querySelector('meta[name="description"]');
    if (description) {
      description.setAttribute(
        "content",
        L(
          "一个非官方的 CS2 Valve 区域排名（VRS）交互浏览器。查看每一分、每个因子和每一场交手记录。",
          "An unofficial, interactive explorer for Counter-Strike 2 Valve Regional Standings. Every point, factor, and head-to-head result.",
        ),
      );
    }
  }

  function setLang(next) {
    lang = next === "en" ? "en" : "zh";
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch (err) {
      // Ignore storage failures; the current page still switches.
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("lang", lang);
      window.history.replaceState(null, "", url.toString());
    } catch (err) {
      // Keep the old URL if the browser cannot build one.
    }
    applyDocumentLang();
    if (live && live.tone === "synced") {
      live.text = syncedText();
      live.title = syncedTitle();
    }
    render();
  }

  let DATA = window.VRS_DATA;
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  if (!DATA) {
    app.innerHTML = `
      <div class="content" style="padding-top:80px">
        <div class="panel card">
          <div class="eyebrow">${L("数据缺失", "Data missing")}</div>
          <h1 style="margin-top:10px">${L("请先构建数据", "Run the data build first")}</h1>
          <p class="muted" style="margin-top:10px">${L(
            "运行 <code>python scripts/build_data.py</code> 生成 <code>data.js</code>，然后刷新页面。",
            "Run <code>python scripts/build_data.py</code> to generate <code>data.js</code>, then reload this page.",
          )}</p>
        </div>
      </div>`;
    return;
  }

  const REGIONS = ["Global", "Europe", "Americas", "Asia"];
  const REGION_CLASS = {
    Global: "region-global",
    Europe: "region-europe",
    Americas: "region-americas",
    Asia: "region-asia",
  };

  function factorList() {
    return [
      {
        key: "bountyOffered",
        label: L("赏金获取", "Bounty Offered"),
        color: "var(--lime)",
        desc: L(
          "赛事奖金，按时间衰减，并以全球参照上限进行折算。",
          "Prize money earned, age-weighted and capped against the global reference.",
        ),
      },
      {
        key: "bountyCollected",
        label: L("赏金收集", "Bounty Collected"),
        color: "var(--cyan)",
        desc: L(
          "击败对手的质量，依据对手的赏金获取值计算。",
          "Quality of opponents beaten, based on their Bounty Offered.",
        ),
      },
      {
        key: "opponentNetwork",
        label: L("对手网络", "Opponent Network"),
        color: "var(--violet)",
        desc: L(
          "阵容击败过的、有相关性的不同对手数量。",
          "How many distinct, relevant opponents a roster has defeated.",
        ),
      },
      {
        key: "lanWins",
        label: L("LAN 胜场", "LAN Wins"),
        color: "var(--orange)",
        desc: L(
          "LAN 赛事胜场，按时间与赛事级别加权。",
          "LAN victories, weighted by recency and event stakes.",
        ),
      },
    ];
  }

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
    text: L("正在检查更新…", "Checking for updates…"),
    title: L("正在连接更新服务。", "Contacting the update service."),
    available: true,
    staticMode: false,
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
    return date.toLocaleDateString(locale(), {
      year: "numeric",
      month: isZh() ? "long" : "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  function shortDate(value) {
    if (!value) return "—";
    const date = new Date(value + "T00:00:00Z");
    return date.toLocaleDateString(locale(), {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  function regionLabel(region) {
    const labels = {
      Global: L("全球", "Global"),
      Europe: L("欧洲", "Europe"),
      Americas: L("美洲", "Americas"),
      Asia: L("亚洲", "Asia"),
    };
    return labels[region] || region || L("未知", "Unknown");
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
    [["stage3", L("第三阶段", "Stage 3")], ["stage2", L("第二阶段", "Stage 2")], ["stage1", L("第一阶段", "Stage 1")]].forEach(([key, label]) => {
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
    const asOf = esc(DATA.qualification?.asOf || "");
    const title = L(
      `根据 ${asOf} Major 名额分配推算，并非官方邀请。`,
      `Projected from the ${asOf} Major invite allocation. Not an official invitation.`,
    );
    return `<span class="qual-badge qual-${band.key}" title="${title}">${band.label}</span>`;
  }

  function deltaClass(value) {
    if (value === null || value === undefined) return "new";
    if (value > 0) return "up";
    if (value < 0) return "down";
    return "flat";
  }

  function deltaText(value) {
    if (value === null || value === undefined) return L("新", "NEW");
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
      return team ? team.name : L("战队", "Team");
    }
    if (route.view === "compare") return L("对比", "Compare");
    if (route.view === "methodology") return L("方法说明", "Methodology");
    return L("排名", "Rankings");
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
              <small>${L("区域排名", "Regional Standings")}</small>
            </span>
          </a>

          <nav class="nav">
            ${navLink("#/", L("排名", "Rankings"), "▦", "rankings")}
            ${navLink("#/compare", L("对比", "Compare"), "⇄", "compare")}
            ${navLink("#/methodology", L("方法说明", "Methodology"), "◇", "methodology")}
          </nav>

          <div class="sidebar-panel">
            <div class="eyebrow">${L("快照", "Snapshot")}</div>
            <div class="snapshot-date">${esc(DATA.latestDate)}</div>
            <div class="muted small">${fmtInt(DATA.snapshots[DATA.latestDate]?.teamCount)} ${L("支战队", "teams")} · ${DATA.dates.length} ${L("个快照", "snapshots")}</div>
            <a class="source-link" href="${esc(DATA.source.repo)}" target="_blank" rel="noreferrer">${L("官方数据源", "Official source")} ↗</a>
            <button class="live-status ${live.tone}" data-action="check-updates" title="${esc(live.title)}">
              <span class="live-dot"></span>
              <span class="live-text">${esc(live.text)}</span>
            </button>
          </div>

          <div class="sidebar-footer">
            <span class="status-dot"></span> ${L("非官方原型", "Unofficial prototype")}
          </div>
        </aside>

        <main class="main">
          <header class="topbar">
            <button class="icon-btn" data-action="toggle-menu" aria-label="${L("打开导航", "Open navigation")}">☰</button>
            <div class="topbar-title">${esc(topbarTitle())}</div>
            <div class="topbar-actions">
              <div class="search-wrap">
                <span class="search-icon">⌕</span>
                <input id="global-search" class="search" type="search" placeholder="${L("搜索战队或选手…", "Search team or player…")}" value="${esc(state.search)}" autocomplete="off">
              </div>
              <a class="ghost-btn" href="#/methodology">${L("计算方式", "How it works")}</a>
              <button class="ghost-btn lang-btn" data-action="toggle-lang" title="${L("切换到英文", "Switch to Chinese")}" aria-label="${L("切换到英文", "Switch to Chinese")}">${L("EN", "中文")}</button>
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
              <button data-action="compare-remove" data-id="${esc(team.id)}" aria-label="${L("移除", "Remove")} ${esc(team.name)}">×</button>
            </span>`).join("")}
          ${teams.length < 2 ? `<span class="tray-hint">${L(`再选 ${2 - teams.length} 支即可对比`, `Pick ${2 - teams.length} more to compare`)}</span>` : ""}
        </div>
        <div class="tray-actions">
          <span class="tray-count mono">${teams.length}/${MAX_COMPARE}</span>
          <button class="ghost-btn" data-action="compare-clear">${L("清空", "Clear")}</button>
          <button class="primary-btn" data-action="compare-open" ${teams.length < 2 ? "disabled" : ""}>${L(`对比 ${teams.length} 支`, `Compare ${teams.length}`)}</button>
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
          <div class="stat-label">${state.region === "Global" ? L("参与排名战队", "Teams ranked") : L(`${regionLabel(state.region)}战队`, `${regionLabel(state.region)} teams`)}</div>
        </div>
        <div class="stat">
          <div class="stat-value lime">${leader ? esc(leader.name) : "—"}</div>
          <div class="stat-label">${L("当前第一", "Current leader")}</div>
        </div>
        <div class="stat">
          <div class="stat-value mono">${leader ? fmtInt(leader.points) : "—"}</div>
          <div class="stat-label">${L("榜首积分", "Leader points")}</div>
        </div>
        <div class="stat">
          <div class="stat-value mono">${fmtInt(avgPoints)}</div>
          <div class="stat-label">${L("平均积分", "Average points")}</div>
        </div>
      </div>`;

    return `
      <section class="hero">
        <div>
          <div class="eyebrow"><span class="live-dot"></span> ${L("CS2 · Valve 区域排名", "CS2 · Valve Regional Standings")}</div>
          <h1>${L("排名，<em>拆开看。</em>", "The ranking, <em>explained.</em>")}</h1>
          <p class="hero-sub">${L("每一分都有来由。查看 Valve 区域排名背后的因子、比赛和交手结果，不必再啃 Markdown 表格。", "Every point has a story. Explore the factors, matches, and head-to-head results behind the Valve Regional Standings — without digging through markdown tables.")}</p>
        </div>
        ${stats}
      </section>

      <div class="toolbar">
        <div class="tabs">
          ${REGIONS.map((region) => `
            <button class="tab ${state.region === region ? "active" : ""}" data-action="set-region" data-region="${region}">${regionLabel(region)}</button>
          `).join("")}
        </div>

        <select class="select" id="snapshot-select" aria-label="${L("快照日期", "Snapshot date")}">
          ${DATA.dates.slice().reverse().map((item) => `
            <option value="${item}" ${item === date ? "selected" : ""}>${dateLabel(item)}</option>
          `).join("")}
        </select>

        <select class="select" id="sort-select" aria-label="${L("战队排序", "Sort teams")}">
          <option value="rank" ${state.sort === "rank" ? "selected" : ""}>${L("排序：排名", "Sort: Rank")}</option>
          <option value="points" ${state.sort === "points" ? "selected" : ""}>${L("排序：积分", "Sort: Points")}</option>
          <option value="delta" ${state.sort === "delta" ? "selected" : ""}>${L("排序：变动", "Sort: Movement")}</option>
          <option value="name" ${state.sort === "name" ? "selected" : ""}>${L("排序：名称", "Sort: Name")}</option>
        </select>

        <div class="toolbar-spacer"></div>
        <div class="toolbar-note">${L("官方快照", "Official snapshot")} · ${dateLabel(date)}</div>
      </div>

      <div class="rankings-grid">
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">${L(`${regionLabel(state.region)}排名`, `${regionLabel(state.region)} standings`)}</div>
              <div class="panel-sub">${L(
                `${fmtInt(sorted.length)} 支战队${query ? `，匹配“${esc(state.search)}”` : ""}`,
                `${fmtInt(sorted.length)} teams${query ? ` matching “${esc(state.search)}”` : ""}`,
              )}</div>
            </div>
            <div class="panel-head-right">
              <span class="muted small">${L("点击任意一行查看完整拆解", "Click a row for the full breakdown")}</span>
            </div>
          </div>

          <div class="table-wrap">
            <table class="rankings-table">
              <thead>
                <tr>
                  <th style="width:34px"></th>
                  <th style="width:54px">#</th>
                  <th>${L("战队", "Team")}</th>
                  <th class="col-region">${L("区域", "Region")}</th>
                  <th class="col-factors" title="${L("赏金获取 · 赏金收集 · 对手网络 · LAN 胜场", "Bounty offered · bounty collected · opponent network · LAN wins")}">${L("因子", "Profile")}</th>
                  <th style="text-align:right">${L("积分", "Points")}</th>
                  <th style="width:64px">Δ</th>
                  <th class="col-trend" style="width:100px">${L("走势", "Trend")}</th>
                </tr>
              </thead>
              <tbody>
                ${visible.length ? visible.map((team) => renderRankingRow(team, prevMap) + qualificationLineAfter(team)).join("") : `
                  <tr>
                    <td colspan="8">
                      <div class="empty">
                        <div class="empty-icon">⌕</div>
                        <div>${L("没有符合条件的战队。", "No teams match that search.")}</div>
                      </div>
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>

          <div class="table-footer">
            <span>${L(`显示 ${fmtInt(visible.length)} / ${fmtInt(sorted.length)} 支战队`, `Showing ${fmtInt(visible.length)} of ${fmtInt(sorted.length)} teams`)}</span>
            ${state.limit < sorted.length ? `<button class="ghost-btn" data-action="show-all">${L("显示全部", "Show all")}</button>` : ""}
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
          <input class="compare-check" type="checkbox" data-action="toggle-compare" data-id="${esc(team.id)}" ${checked ? "checked" : ""} aria-label="${L("对比", "Compare")} ${esc(team.name)}">
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
    const asOf = DATA.qualification?.asOf || L("最近公布", "latest published");
    const rankNote = band.from === band.to
      ? L(`第 ${band.to} 名`, `Rank ${band.to}`)
      : L(`第 ${band.from}–${band.to} 名`, `Ranks ${band.from}–${band.to}`);
    const slotNote = L(
      `${band.size} 个名额`,
      `${band.size} ${band.size === 1 ? "slot" : "slots"}`,
    );
    return `
      <tr class="qual-row">
        <td colspan="8">
          <div class="qual-line">
            <span class="qual-line-label qual-${band.key}">${L(`${band.label}晋级线`, `${band.label} line`)}</span>
            <span class="qual-line-rule"></span>
            <span class="qual-line-note">${rankNote} · ${slotNote} · ${esc(asOf)}</span>
          </div>
        </td>
      </tr>`;
  }

  function factorProfile(id) {
    const team = DATA.teams[id];
    if (!team) return `<span class="muted-cell">—</span>`;
    const factors = team.factors || {};
    return `
      <div class="mini-factors" title="${L("赏金获取、赏金收集、对手网络、LAN 胜场", "Bounty offered, bounty collected, opponent network, LAN wins")}">
        ${factorList().map((factor) => {
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
      <svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${L("排名走势", "Rank trend")}">
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
        <div class="eyebrow">${L("变动", "Movement")}</div>
        <div class="side-title">${L("上升", "Climbers")}</div>
        ${rows(up, L("该快照中没有排名上升的战队。", "No upward movement in this snapshot."))}
        <div class="divider"></div>
        <div class="side-title">${L("下降", "Fallers")}</div>
        ${rows(down, L("该快照中没有排名下降的战队。", "No downward movement in this snapshot."))}
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
        <div class="eyebrow">${L("区域概览", "Region pulse")}</div>
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
        <div class="eyebrow">${L("Major 晋级线", "Major path")}</div>
        <div class="side-title">${L("各区域邀请线", "Invite lines by region")}</div>
        ${regions.map((region) => {
          const bands = qualCutoffs(region);
          if (!bands.length) return "";
          return `
            <div class="mp-region ${active === region ? "active" : ""}">
              <div class="mp-head">
                ${regionPill(region)}
                <span class="mono muted small">${L(`${bands[bands.length - 1].to} 个名额`, `${bands[bands.length - 1].to} ${bands[bands.length - 1].to === 1 ? "slot" : "slots"}`)}</span>
              </div>
              ${bands.map((band) => `
                <div class="mp-band">
                  <span class="qual-badge qual-${band.key}">${band.label}</span>
                  <span class="mp-range mono">${band.from === band.to ? `#${band.to}` : `#${band.from}–#${band.to}`}</span>
                </div>`).join("")}
            </div>`;
        }).join("")}
        <div class="mp-note">${L(`${esc(q.asOf)} 名额分配 · 累计晋级线，并非实时晋级资格。`, `${esc(q.asOf)} allocation · cumulative lines, not a live qualification.`)}</div>
      </section>`;
  }

  function renderDataHealth() {
    const detailCount = Object.keys(DATA.teams).length;
    return `
      <section class="panel side-card">
        <div class="eyebrow">${L("数据状态", "Data health")}</div>
        <div class="side-title">${L(`${fmtInt(detailCount)} 支有完整详情的阵容`, `${fmtInt(detailCount)} detailed rosters`)}</div>
        <div class="rp-row"><span class="rp-name">${L("已解析快照", "Snapshots parsed")}</span><span class="rp-count">${DATA.dates.length}</span></div>
        <div class="rp-row"><span class="rp-name">${L("详情失败数", "Detail failures")}</span><span class="rp-count ${DATA.failures.length ? "red" : ""}">${DATA.failures.length}</span></div>
        <div class="rp-row"><span class="rp-name">${L("数据源", "Source")}</span><span class="rp-count">Valve</span></div>
        <div class="rp-row"><span class="rp-name">${L("赛事数据", "Event data")}</span><span class="rp-count">HLTV</span></div>
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
          <h2>${L("未找到该阵容", "Roster not found")}</h2>
          <p class="muted" style="margin-top:8px">${L("当前数据快照中没有这个阵容。", "This roster is not in the bundled snapshot.")}</p>
          <a class="ghost-btn" style="margin-top:18px;display:inline-flex" href="#/">${L("返回排名", "Back to rankings")}</a>
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
          <a class="back-link" href="#/">← ${L("返回排名", "Back to rankings")}</a>
          <div class="team-title-row">
            <span class="team-rank-big">#${base.globalRank}</span>
            <div>
              <h1 class="team-title">${esc(base.name)}</h1>
              <div class="team-meta">
                ${regionPill(base.region)}
                <span>${L("区域排名", "Regional rank")} <strong class="mono">#${base.regionalRank || "—"}</strong></span>
                ${qualForRank(base.region, base.regionalRank) ? `<span class="team-meta-qual">${qualificationBadge(base.region, base.regionalRank)}</span>` : ""}
                <span>·</span>
                <span>${L(`${dateLabel(DATA.latestDate)} 快照`, `${dateLabel(DATA.latestDate)} snapshot`)}</span>
              </div>
            </div>
          </div>
          <div class="roster-chips">
            ${base.roster.map((player) => `<span class="chip">${esc(player)}</span>`).join("")}
          </div>
        </div>
        <div class="team-hero-right">
          <div class="big-points">${fmtInt(base.points)}</div>
          <div class="points-label">${L("VRS 积分", "VRS points")}</div>
          <div class="hero-delta ${previous ? `delta ${deltaClass(delta)}` : "delta flat"}">${previous ? L(`${deltaText(delta)}，较上一快照`, `${deltaText(delta)} vs previous snapshot`) : L("该快照中的新阵容", "New roster in this snapshot")}</div>
        </div>
      </section>`;

    if (!team) {
      return `
        ${header}
        <div class="notice">
          ${L("本原型只为最新快照打包了完整的比赛与因子数据。", "Detailed match and factor data is only bundled for the latest snapshot in this prototype.")}
          ${base.detailPath ? L(` 你仍然可以查看<a href="${esc(DATA.source.repo)}/blob/main/${esc(base.detailPath)}" target="_blank" rel="noreferrer">官方详情文件</a>。`, ` You can still read the <a href="${esc(DATA.source.repo)}/blob/main/${esc(base.detailPath)}" target="_blank" rel="noreferrer">official detail file</a>.`) : ""}
        </div>
        <div class="stack" style="margin-top:16px">
          <section class="panel card">
            <div class="card-head">
              <div>
                <div class="eyebrow">${L("历史", "History")}</div>
                <div class="card-title">${L("排名走势", "Rank over time")}</div>
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
                <div class="eyebrow">${L("积分拆解", "Score breakdown")}</div>
                <div class="card-title">${L("最终分数如何构成", "How the final value is built")}</div>
                <div class="card-sub">${L("起始排名分加上交手调整。", "Starting Rank Value plus head-to-head adjustments.")}</div>
              </div>
            </div>
            ${renderWaterfall(team)}
          </section>

          <section class="panel card">
            <div class="card-head">
              <div>
                <div class="eyebrow">${L("四个因子", "The four factors")}</div>
                <div class="card-title">${L("起始排名分的输入", "Starting Rank Value inputs")}</div>
                <div class="card-sub">${L("每个因子都归一化到 0–1。", "Each factor is normalized to 0–1.")}</div>
              </div>
            </div>
            ${renderFactorCards(team)}
          </section>
        </div>

        <section class="panel card">
          <div class="card-head">
            <div>
              <div class="eyebrow">${L("历史", "History")}</div>
              <div class="card-title">${L("排名走势", "Rank over time")}</div>
              <div class="card-sub">${L(`实线：当前这套阵容（${history.length} 个快照）。虚线：同名战队的所有阵容（${(team.orgHistory || []).length} 个快照）。`, `Solid line: this exact roster (${history.length} snapshots). Dashed line: any roster under the same name (${(team.orgHistory || []).length} snapshots).`)}</div>
            </div>
            <div class="card-head-right">
              <div class="chart-toggle">
                <button class="${state.historyMode === "globalRank" ? "active" : ""}" data-action="set-history-mode" data-mode="globalRank">${L("全球", "Global")}</button>
                <button class="${state.historyMode === "regionalRank" ? "active" : ""}" data-action="set-history-mode" data-mode="regionalRank">${L("区域", "Regional")}</button>
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
      <svg class="waterfall-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${L("从起始排名分到最终排名分的积分瀑布图", "Score waterfall from starting rank value to final rank value")}">
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

        <text x="${x1 + barWidth / 2}" y="${height - 16}" fill="#8b96a9" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">${L("起始排名分", "Starting Rank")}</text>
        <text x="${x2 + barWidth / 2}" y="${height - 16}" fill="#8b96a9" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">${L("交手调整", "Head-to-head")}</text>
        <text x="${x3 + barWidth / 2}" y="${height - 16}" fill="#8b96a9" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">${L("最终排名分", "Final Rank Value")}</text>
      </svg>
      <div class="waterfall-note">${L("坐标轴经过截断，以便看清交手调整的幅度。这里显示的是排名分，不是表格中四舍五入后的积分。", "Axis is truncated to make the head-to-head delta visible. Points shown are rank values, not the rounded table points.")}</div>`;
  }

  function renderFactorCards(team) {
    const factors = team.factors || {};
    return `
      <div class="factor-grid">
        ${factorList().map((factor) => {
          const value = Number(factors[factor.key]) || 0;
          const width = Math.max(2, Math.min(100, value * 100));
          let meta = "";
          if (factor.key === "bountyOffered" && team.top10ScaledWinnings !== null) {
            meta = L(`${money(team.top10ScaledWinnings)} TOP 10 折算奖金`, `${money(team.top10ScaledWinnings)} top-10 winnings`);
          } else if (factor.key === "bountyCollected") {
            meta = L("击败对手的赏金收集", "opponent bounty collected");
          } else if (factor.key === "opponentNetwork") {
            meta = L("击败的不同对手数", "distinct opponents beaten");
          } else if (factor.key === "lanWins") {
            meta = L("时效加权 LAN 胜场", "age-weighted LAN wins");
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
          name: L(`${team.name} · 所有阵容`, `${team.name} · all rosters`),
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
      return `<div class="empty"><div class="empty-icon">◌</div><div>${L("快照数量不足，无法绘制历史图。", "Not enough snapshots for a history chart.")}</div></div>`;
    }

    const values = series
      .flatMap((item) => dates.map((date) => {
        const entry = item.history.find((row) => row.date === date);
        return entry ? entry[mode] : null;
      }))
      .filter((value) => value !== null && value !== undefined && value > 0);
    if (!values.length) {
      return `<div class="empty"><div class="empty-icon">◌</div><div>${L("当前视图没有排名历史。", "No ranking history for this view.")}</div></div>`;
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
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${L("排名历史图", "Ranking history chart")}">
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
            <div class="panel-title">${L("比赛贡献", "Match contributions")}</div>
            <div class="panel-sub">${L(`${matches.length} 场比赛 · 高亮行为进入前十因子的比赛`, `${matches.length} matches · top-10 factor rows highlighted`)}</div>
          </div>
          <div class="panel-head-right">
            <div class="match-filters">
              <button class="filter-btn ${state.matchFilter === "all" ? "active" : ""}" data-action="set-match-filter" data-filter="all">${L("全部", "All")}</button>
              <button class="filter-btn ${state.matchFilter === "wins" ? "active" : ""}" data-action="set-match-filter" data-filter="wins">${L("胜", "Wins")}</button>
              <button class="filter-btn ${state.matchFilter === "losses" ? "active" : ""}" data-action="set-match-filter" data-filter="losses">${L("负", "Losses")}</button>
              <button class="filter-btn ${state.matchFilter === "top10" ? "active" : ""}" data-action="set-match-filter" data-filter="top10">TOP 10</button>
            </div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="match-table">
            <thead>
              <tr>
                <th>#</th>
                <th>${L("日期", "Date")}</th>
                <th>${L("对手", "Opponent")}</th>
                <th>${L("胜/负", "W/L")}</th>
                <th>${L("时效", "Age")}</th>
                <th>${L("赛事", "Event")}</th>
                <th>${L("赏金", "Bounty")}</th>
                <th>${L("对手网络", "Network")}</th>
                <th>LAN</th>
                <th>${L("交手", "H2H")}</th>
                <th>${L("使用阵容", "Roster used")}</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="11"><div class="empty">${L("当前筛选下没有比赛。", "No matches for this filter.")}</div></td></tr>`}
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
            <div class="eyebrow">${L("赏金获取", "Bounty Offered")}</div>
            <div class="card-title">${L("TOP 10 折算奖金", "Top 10 scaled winnings")}</div>
            <div class="card-sub">${L("用于种子分的时效加权奖金。", "Age-weighted prize money used for the seed.")}</div>
          </div>
        </div>
        ${winnings.length ? `
          <div class="table-wrap">
            <table class="winnings-table">
              <thead>
                <tr><th>${L("比赛日期", "Event date")}</th><th>${L("时效", "Age")}</th><th style="text-align:right">${L("奖金", "Prize")}</th><th style="text-align:right">${L("折算", "Scaled")}</th></tr>
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
          <div class="winnings-total"><span>${L("折算总额", "Total scaled")}</span><strong>${money(total)}</strong></div>
        ` : `<div class="empty">${L("当前时间窗口内没有奖金记录。", "No prize winnings in the current window.")}</div>`}
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
            <div class="eyebrow">${L("阵容身份", "Roster identity")}</div>
            <div class="card-title">${L("比赛所用阵容", "Lineups used in matches")}</div>
            <div class="card-sub">${L("VRS 依据阵容，而不只是队名。", "VRS follows the roster, not just the org name.")}</div>
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
                <div class="roster-item-meta">${shortDate(item.dates.slice().sort()[0])} – ${shortDate(item.dates.slice().sort().reverse()[0])} · ${L(`${item.dates.length} 场比赛`, `${item.dates.length} ${item.dates.length === 1 ? "match" : "matches"}`)}</div>
              </div>`).join("")}
          </div>
        ` : `<div class="empty">${L("没有阵容数据。", "No match roster data.")}</div>`}
      </section>`;
  }

  function renderProvenance(team) {
    return `
      <section class="panel card">
        <div class="card-head">
          <div>
            <div class="eyebrow">${L("数据来源", "Provenance")}</div>
            <div class="card-title">${L("这些数据从哪里来", "Where this data comes from")}</div>
          </div>
        </div>
        <div class="prose" style="margin-top:0">
          <p>${L("本页解析自 Valve 官方区域排名 Markdown，并非 Valve 官方产品。", "This page is parsed from the official Valve Regional Standings markdown. It is not an official Valve product.")}</p>
          <p style="margin-top:8px">
            <a href="${esc(DATA.source.repo)}/blob/main/${esc(team.detailPath)}" target="_blank" rel="noreferrer">${L("打开官方详情文件", "Open the source detail file")} ↗</a>
          </p>
          <p style="margin-top:8px">${L("区域排名的赛事数据由 HLTV.org 提供。", "Event data for Regional Standings is provided by HLTV.org.")}</p>
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
          <h2>${L("至少选择两支战队", "Pick at least two teams")}</h2>
          <p class="muted" style="margin-top:8px">${L("在排名表中勾选对比框，然后打开对比栏。", "Tick the compare box on any rankings row, then open the compare tray.")}</p>
          <a class="ghost-btn" style="margin-top:18px;display:inline-flex" href="#/">${L("浏览排名", "Browse rankings")}</a>
        </div>`;
    }
    if (teams.length < 2) {
      return `
        ${renderCompareRail(teams)}
        <div class="empty" style="padding:60px 0">
          <div class="empty-icon">⇄</div>
          <div>${L("再加一个阵容即可开始对比。", "Add one more roster to start comparing.")}</div>
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
                <div class="eyebrow">${L("形态", "Shape")}</div>
                <div class="card-title">${L("因子雷达图", "Factor radar")}</div>
                <div class="card-sub">${L("每个种子因子一个轴，数值归一化到 0 → 1。", "One axis per seed factor, each scaled 0 → 1.")}</div>
              </div>
            </div>
            ${renderRadar(teams)}
          </section>
          <section class="panel card">
            <div class="card-head">
              <div>
                <div class="eyebrow">${L("因子对比", "Factor comparison")}</div>
                <div class="card-title">${L("各阵容的优势", "Where each roster wins")}</div>
              </div>
            </div>
            ${renderFactorBars(teams)}
          </section>
        </div>
        <section class="panel card">
          <div class="card-head">
            <div>
              <div class="eyebrow">${L("分数公式", "Score equation")}</div>
              <div class="card-title">${L("起始分 + 交手调整", "Starting value + head-to-head")}</div>
              <div class="card-sub">${L("起始分是种子分，交手调整在其后叠加。", "The starting value is the seed; the head-to-head adjustment is applied after.")}</div>
            </div>
          </div>
          ${renderScoreTable(teams)}
        </section>
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">${L("共同对手", "Common opponents")}</div>
              <div class="panel-sub">${L("所选阵容对同一对手的战绩。", "Every selected roster's record against the same opponent.")}</div>
            </div>
          </div>
          ${renderCommonOpponents(teams)}
        </section>
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">${L("交手矩阵", "Head-to-head matrix")}</div>
              <div class="panel-sub">${L("所选阵容之间的直接交手。", "Direct matches between the selected rosters.")}</div>
            </div>
          </div>
          ${renderH2HMatrix(teams)}
        </section>
        <section class="panel card">
          <div class="card-head">
            <div>
              <div class="eyebrow">${L("历史", "History")}</div>
              <div class="card-title">${L("排名走势", "Rank over time")}</div>
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
            <button class="compare-card-remove" data-action="compare-remove" data-id="${esc(team.id)}" aria-label="${L("移除", "Remove")} ${esc(team.name)}">×</button>
            <div class="compare-card-rank">#${team.globalRank}</div>
            <div class="compare-card-name">${esc(team.name)}</div>
            <div class="compare-card-meta">${regionPill(team.region)}<span class="mono">${fmtInt(team.points)}</span></div>
            <div class="compare-card-roster">${esc((team.roster || []).join(", "))}</div>
          </div>`).join("")}
        ${teams.length < MAX_COMPARE ? `
          <div class="compare-card compare-card-add">
            <div class="compare-card-rank">+</div>
            <div class="compare-card-name">${L("添加战队", "Add team")}</div>
            <select class="select compare-add" data-action="compare-add" aria-label="${L("添加战队到对比", "Add a team to the comparison")}">
              <option value="">${L("选择战队…", "Select a team…")}</option>
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
            <div class="panel-title">${L("并排对比", "Side by side")}</div>
            <div class="panel-sub">${L(`${teams.length} 个阵容 · ${esc(DATA.latestDate)} 快照`, `${teams.length} rosters · ${esc(DATA.latestDate)} snapshot`)}</div>
          </div>
          <div class="panel-head-right">
            <button class="ghost-btn" data-action="compare-clear">${L("清空选择", "Clear selection")}</button>
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
              ${row(L("全球排名", "Global rank"), (team) => `<span class="mono">#${team.globalRank}</span>`)}
              ${row(L("区域", "Region"), (team) => `${regionPill(team.region)} <span class="muted small mono">#${team.regionalRank || "—"}</span>`)}
              ${row(L("VRS 积分", "VRS points"), (team) => `<span class="mono lime">${fmtInt(team.points)}</span>`)}
              ${row(L("起始分", "Starting value"), (team) => `<span class="mono">${fmt(team.startingRankValue, 1)}</span>`)}
              ${row(L("交手调整", "H2H adjustment"), (team) => `<span class="mono ${team.h2hAdjustment > 0 ? "h2h-pos" : team.h2hAdjustment < 0 ? "h2h-neg" : "h2h-zero"}">${team.h2hAdjustment > 0 ? "+" : ""}${fmt(team.h2hAdjustment, 1)}</span>`)}
              ${row(L("最终分", "Final value"), (team) => `<span class="mono">${fmt(team.finalRankValue, 1)}</span>`)}
              ${row(L("已统计比赛", "Matches tracked"), (team) => `<span class="mono">${fmtInt((team.matches || []).length)}</span>`)}
              ${row(L("Major 晋级线", "Major path"), (team) => qualificationBadge(team.region, team.regionalRank))}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function renderRadar(teams) {
    const width = 480;
    const height = 380;
    const cx = width / 2;
    const cy = height / 2 + 4;
    const maxR = 96;
    const axes = factorList();
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
      <svg class="radar-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${L("因子雷达对比", "Factor radar comparison")}">
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
        ${factorList().map((factor) => `
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
              <th>${L("阵容", "Roster")}</th>
              <th style="text-align:right">${L("起始", "Starting")}</th>
              <th style="text-align:right">${L("交手", "H2H")}</th>
              <th style="text-align:right">${L("最终", "Final")}</th>
              <th style="width:38%">${L("相对最高值的占比", "Share of the strongest value")}</th>
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
      return `<div class="empty"><div class="empty-icon">◌</div><div>${L("当前时间窗口内没有共同对手。", "No shared opponents in the current window.")}</div></div>`;
    }

    return `
      <div class="table-wrap">
        <table class="compare-table common-table">
          <thead>
            <tr>
              <th>${L("对手", "Opponent")}</th>
              ${teams.map((team) => `<th><span class="team-dot" style="background:${team.color}"></span>${esc(team.name)}</th>`).join("")}
              <th>${L("场次", "Matches")}</th>
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
      return `<div class="empty"><div class="empty-icon">◌</div><div>${L("当前时间窗口内这些阵容没有直接交手。", "No direct matches between these rosters in the current window.")}</div></div>`;
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
          <summary>${L(`${matchRows.length} 场直接交手`, `${matchRows.length} direct ${matchRows.length === 1 ? "match" : "matches"}`)}</summary>
          <div class="table-wrap">
            <table class="compare-table">
              <thead>
                <tr><th>${L("日期", "Date")}</th><th>${L("对阵", "Matchup")}</th><th>${L("结果", "Result")}</th><th>${L("交手调整", "H2H adj.")}</th><th>${L("赛事权重", "Event weight")}</th></tr>
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
        <div class="eyebrow"><span class="live-dot"></span> ${L("方法说明与数据来源", "Methodology & provenance")}</div>
        <h1>${L("这个网站是什么，不是什么。", "What this site is — and isn't.")}</h1>
        <p class="lead">${L("VRS Lab 是一个非官方的 Valve 区域排名（VRS）浏览器。它把 Valve 公布的 Markdown 转成易读的分数拆解，不重新计算排名，也与 Valve、HLTV 没有隶属关系。", "VRS Lab is an unofficial explorer for the Valve Regional Standings. It turns Valve's published markdown into a readable score breakdown. It does not recompute the ranking, and it is not affiliated with Valve or HLTV.")}</p>

        <div class="method-grid">
          <section class="method-card">
            <h3>${L("我们展示什么", "What we show")}</h3>
            <ul>
              <li>${L("Valve 公开仓库中的官方月度排名。", "Official monthly standings from Valve's public repository.")}</li>
              <li>${L("每个阵容的四个种子因子与交手调整。", "Each roster's four seed factors and head-to-head adjustment.")}</li>
              <li>${L("官方详情文件中的每一场比赛，包括时效与赛事权重。", "Every match listed in the official detail file, including age and event weights.")}</li>
              <li>${L(`跨 ${DATA.dates.length} 个已解析快照的排名历史。`, `Rank history across ${DATA.dates.length} parsed snapshots.`)}</li>
            </ul>
          </section>

          <section class="method-card">
            <h3>${L("我们不做什么", "What we don't do")}</h3>
            <ul>
              <li>${L("不重新计算 VRS，也不预测官方积分。", "We don't recompute VRS or predict official points.")}</li>
              <li>${L("不抓取 HLTV，也不使用非公开数据。", "We don't scrape HLTV or use private data.")}</li>
              <li>${L("不推断赛事名称——官方详情表本身不包含这些信息。", "We don't infer event names — the official detail tables don't include them.")}</li>
              <li>${L("不把同名阵容当成同一支战队。阵容身份由选手集合决定；虚线只是视觉辅助，不代表身份。", "We don't treat similarly named rosters as the same team. Roster identity is the player set; the dashed org line is a visual aid, not an identity.")}</li>
            </ul>
          </section>

          <section class="method-card">
            <h3>${L("分数公式", "The score equation")}</h3>
            <p>${L("最终排名分 = 起始种子分 + 交手调整。", "The final rank value is the starting seed plus head-to-head adjustments.")}</p>
            <div class="formula">${L("最终 = 起始 + 交手<br><br>起始 = 400 + ((avg − min) / (max − min)) × 1600<br><br>avg = mean(赏金获取, 赏金收集,<br>            对手网络, LAN 胜场)", "Final = Starting + H2H<br><br>Starting = 400 + ((avg − min) / (max − min)) × 1600<br><br>avg = mean(Bounty Offered, Bounty Collected,<br>            Opponent Network, LAN Wins)")}</div>
            <p style="margin-top:10px">${L("四个因子都归一化到 0–1。赏金与对手网络因子取过去六个月中最好的十项成绩，并按时间与赛事级别加权。", "The four factors are normalized to 0–1. Bounty and network factors use the ten best results over the past six months, with age and event weights.")}</p>
          </section>

          <section class="method-card">
            <h3>${L("晋级线", "Qualification lines")}</h3>
            <p>${L(`排名页可以在区域表上绘制 Major 邀请线。它们使用最近一次公布的名额分配——<strong>${esc(DATA.qualification?.asOf || "未加载名额表")}</strong>——并非实时预测。`, `The rankings view can draw Major invite lines on regional tables. They use the last published allocation — <strong>${esc(DATA.qualification?.asOf || "no allocation loaded")}</strong> — not a live projection.`)}</p>
            <div class="qual-table-wrap">
              <table class="qual-table">
                <thead>
                  <tr><th>${L("区域", "Region")}</th><th>${L("第三阶段", "Stage 3")}</th><th>${L("第二阶段", "Stage 2")}</th><th>${L("第一阶段", "Stage 1")}</th></tr>
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
            <p class="small muted" style="margin-top:10px">${L("Valve 每个 Major 周期都会根据上一届 Major 的各区域成绩重新计算这张表，所以数字可能变化。请把晋级线当作历史参考，而不是邀请资格。", "Valve recalculates this table for every Major cycle from the previous Major's regional results, so the numbers can change. Treat the lines as historical context, not an invitation.")}</p>
          </section>

          <section class="method-card">
            <h3>${L("数据状态", "Data health")}</h3>
            <ul>
              <li>${L("已解析快照", "Snapshots parsed")}${L("：", ": ")}<strong>${DATA.dates.length}</strong></li>
              <li>${L("最新排名战队数", "Teams in latest standings")}${L("：", ": ")}<strong>${fmtInt(total)}</strong></li>
              <li>${L("有完整详情的阵容", "Rosters with full detail")}${L("：", ": ")}<strong>${fmtInt(detailed)}</strong></li>
              <li>${L("详情解析失败", "Detail parse failures")}${L("：", ": ")}<strong>${DATA.failures.length}</strong></li>
            </ul>
          </section>
        </div>

        <div class="prose">
          <h2>${L("数据源", "Source")}</h2>
          <p>${L("排名与详情文件来自", "Standings and detail files come from")} <a href="${esc(DATA.source.repo)}" target="_blank" rel="noreferrer">ValveSoftware/counter-strike_regional_standings</a>${L("。详情页注明区域排名的赛事数据由 HLTV.org 提供。", ". The detail pages state that event data for Regional Standings is provided by HLTV.org.")}</p>

          <h2>${L("为什么阵容身份很重要", "Why roster identity matters")}</h2>
          <p>${L("VRS 以阵容为基础。阵容由一起上场比赛的选手决定，而不是由俱乐部名称决定。在本原型中，稳定的 ID 由排序后的选手集合生成，因此阵容变动会产生新的实体和新的历史线。", "VRS is roster-based. A roster is identified by the players who played together, not by the organization name. In this prototype, a stable ID is generated from the sorted player set, so a roster change creates a new entity and a new history line.")}</p>

          <h2>${L("晋级线", "Qualification lines")}</h2>
          <p>${L("虚线晋级线只是阅读辅助，不是预测。Valve 根据各区域在上一届 Major 的表现分配 Major 名额，并在每个周期重新发布这张表。本原型内置 Winter 2025 名额表，并在所有使用处标注其 <code>asOf</code> 日期。由于当前快照可能属于另一个周期，排在晋级线之上的战队不一定获得邀请。", "The dashed invite lines are a reading aid, not a prediction. Valve allocates Major slots to regions based on how each region performed at the previous Major, and republishes the table each cycle. This prototype ships the Winter 2025 table and labels it with its <code>asOf</code> date wherever it is used. Because the current snapshot may belong to a different cycle, a team above a line is not necessarily invited.")}</p>

          <h2>${L("已知限制", "Known limitations")}</h2>
          <p>${L("官方详情表不包含赛事名称，因此比赛行只能按日期、对手和赛事权重分组。本原型也只为最新快照打包完整比赛详情；更早的快照仅用于排名历史。Valve 可能调整模型，官方仓库也不一定与生产环境完全一致。", "The official detail table does not include event names, so match rows can only be grouped by date, opponent, and event weight. The prototype also bundles full match details only for the latest snapshot; older snapshots are used for rank history. Valve can change the model, and the official repository may not match production exactly.")}</p>

          <h2>${L("免责声明", "Disclaimer")}</h2>
          <p>${L("这是一个非官方的粉丝原型，未获得 Valve、HLTV 或任何赛事主办方的认可。请勿将其作为官方邀请或参赛资格决策的依据。", "This is an unofficial fan-made prototype. It is not endorsed by Valve, HLTV, or any tournament organizer. Do not use it as the basis for official invitations or eligibility decisions.")}</p>
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

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) throw new Error(L("响应不是 JSON", "Response is not JSON"));
    return res.json();
  }

  async function fetchMeta() {
    try {
      const meta = await fetchJson(`/api/meta?_=${Date.now()}`);
      meta.__mode = "live";
      return meta;
    } catch (apiError) {
      // Static hosting (Nginx without the updater, Gitee Pages, …) can still
      // expose the last build metadata, so the page keeps hot-swapping.
      try {
        const meta = await fetchJson(`data/meta.json?_=${Date.now()}`);
        meta.__mode = "static";
        return meta;
      } catch (staticError) {
        throw apiError;
      }
    }
  }

  function syncedText() {
    return `${live.staticMode ? L("静态托管", "Static") : L("已同步", "Live")} · ${shortDate(DATA.latestDate)}`;
  }

  function syncedTitle() {
    return live.staticMode
      ? L(`通过静态 meta.json 检查更新。最新官方快照：${DATA.latestDate}。`, `Checking for updates via static meta.json. Latest official snapshot: ${DATA.latestDate}.`)
      : L(`已与更新服务同步。最新官方快照：${DATA.latestDate}。`, `Synced with the update service. Latest official snapshot: ${DATA.latestDate}.`);
  }

  async function adoptBundle(version) {
    const res = await fetch(`data.js?v=${encodeURIComponent(version)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`data.js HTTP ${res.status}`);
    const text = await res.text();
    const next = new Function(`${text}\nreturn window.VRS_DATA;`)();
    if (version && next.builtAt && next.builtAt !== version) {
      throw new Error(L("数据包版本不一致", "Bundle version mismatch"));
    }
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
    live.text = syncedText();
    live.title = syncedTitle();
    render();
    showToast(L(`已载入新的官方快照：${dateLabel(DATA.latestDate)}`, `New official snapshot loaded: ${dateLabel(DATA.latestDate)}`), 5000);
  }

  async function checkForUpdates(manual = false) {
    if (liveBusy) {
      if (manual) showToast(L("正在检查更新，请稍候。", "An update check is already running."));
      return;
    }
    liveBusy = true;
    if (manual) setLive("checking", L("正在检查…", "Checking…"), L("正在查询最新快照。", "Asking for the newest snapshot."));
    let rateLimited = false;
    try {
      let checkStarted = false;
      if (manual && !live.staticMode) {
        try {
          const res = await fetch("/api/check", { method: "POST", cache: "no-store" });
          if (res.status === 429) {
            rateLimited = true;
            showToast(L("检查过于频繁，请稍后再试。", "Too many checks. Try again in a minute."));
          } else if (res.ok) {
            const payload = await res.json().catch(() => ({}));
            checkStarted = payload.started === true || payload.reason === "already running";
          }
        } catch (err) {
          // Static hosting: no POST endpoint, fall through to meta polling.
        }
      }
      if (checkStarted) {
        setLive("building", L("正在检查官方数据源…", "Checking the official source…"), L("更新服务正在检查 Valve 仓库。", "The update service is checking Valve's repository."));
        schedulePoll(5000);
        return;
      }
      const meta = await fetchMeta();
      const staticMode = meta.__mode === "static";
      live.available = true;
      live.staticMode = staticMode;
      const pollDelay = staticMode ? 300000 : 60000;

      if (meta.lastError) {
        setLive("warn", L("更新失败 · 使用缓存", "Update failed · cached data"), meta.lastError);
        schedulePoll(120000);
      } else if (meta.building || meta.checking) {
        setLive("building", L("正在检查官方数据源…", "Checking the official source…"), L("更新服务正在检查 Valve 仓库。", "The update service is checking Valve's repository."));
        schedulePoll(8000);
      } else if (meta.builtAt && meta.builtAt !== (live.builtAt || DATA.builtAt)) {
        if (DATA.builtAt === meta.builtAt) {
          live.builtAt = meta.builtAt;
          setLive("synced", syncedText(), syncedTitle());
          schedulePoll(pollDelay);
        } else {
          setLive("building", L("发现新快照 · 加载中…", "New snapshot found · loading…"), L("正在下载重新构建的数据包。", "Downloading the rebuilt data bundle."));
          try {
            await adoptBundle(meta.builtAt);
          } catch (err) {
            setLive("warn", L("请刷新页面更新", "Reload to update"), L(`无法加载新数据包：${err.message}`, `The new bundle could not be loaded: ${err.message}`));
          }
          schedulePoll(pollDelay);
        }
      } else {
        setLive("synced", syncedText(), syncedTitle());
        schedulePoll(pollDelay);
        if (manual && !rateLimited) showToast(L("已是最新版本。", "Already up to date."));
      }
    } catch (err) {
      live.available = false;
      setLive(
        "offline",
        L("静态版本", "Static version"),
        L("没有找到更新信息。页面会继续使用当前数据包；自动更新需要更新服务或静态 meta.json。", "No update metadata found. The page keeps using the current bundle; automatic updates need the update service or a static meta.json."),
      );
      schedulePoll(300000);
      if (manual) showToast(L("暂时无法检查更新。", "Could not check for updates right now."));
    } finally {
      liveBusy = false;
    }
  }

  function initLiveUpdates() {
    if (window.location.protocol === "file:") {
      setLive("offline", L("静态版本", "Static version"), L("直接打开本地文件时无法检查更新。", "Updates cannot be checked when opening the file directly."));
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
      if (action === "toggle-lang") {
        event.preventDefault();
        setLang(isZh() ? "en" : "zh");
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
      showToast(L(`最多同时对比 ${MAX_COMPARE} 支战队。`, `Compare up to ${MAX_COMPARE} teams at a time.`));
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
        showToast(L("部分已选阵容不在该快照中。", "Some selected rosters are not in this snapshot."));
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

  applyDocumentLang();
  render();
  initLiveUpdates();
})();
