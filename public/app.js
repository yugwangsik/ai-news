/* AI/IT Radar — 화면 로직
 *
 * data/feed.json 하나만 읽고 필터·정렬·페이징은 전부 브라우저에서 합니다.
 * file:// 로 열면 fetch 가 막히므로 그 경우 data/feed.js 를 <script> 로 끼워 읽습니다.
 */

const REGIONS = ["KR", "US", "JP"];
const REGION_NAME = { KR: "한국", US: "미국", JP: "일본" };
const PAGE_SIZE = 25;
const STORE_FILTERS = "radar:filters";
const STORE_READ = "radar:read";
const STORE_THEME = "radar:theme";

const $ = (id) => document.getElementById(id);

const state = {
  items: [],
  sourceIds: [],
  regions: new Set(REGIONS),
  sources: new Set(), // 선택된 출처 id (기본값은 전체)
  sourcesRestored: false,
  sort: "mixed",      // mixed | recent
  preset: "all",      // all | today | 6h | 24h | 3d | 7d | custom
  from: null,         // custom 일 때 시작 시각(ms)
  to: null,           // custom 일 때 종료 시각(ms)
  query: "",
  visible: PAGE_SIZE,
  read: new Set(),
};

// ================================================================ 저장소

function loadStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 사생활 보호 모드 등에서 실패해도 화면은 계속 동작합니다. */
  }
}

function saveFilters() {
  saveStore(STORE_FILTERS, {
    regions: [...state.regions],
    sources: [...state.sources],
    sort: state.sort,
    preset: state.preset,
    from: state.from,
    to: state.to,
  });
}

// ================================================================ 데이터

function loadViaScript() {
  return new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "data/feed.js";
    tag.onload = () =>
      window.__FEED__
        ? resolve(window.__FEED__)
        : reject(new Error("feed.js 에 데이터가 없습니다"));
    tag.onerror = () => reject(new Error("data/feed.js 를 불러오지 못했습니다"));
    document.head.appendChild(tag);
  });
}

async function loadFeed() {
  try {
    const res = await fetch("data/feed.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return loadViaScript(); // file:// 또는 파일 없음
  }
}

// ================================================================ 유틸

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function highlight(escaped) {
  if (!state.query) return escaped;
  const needle = escapeHtml(state.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(needle, "gi"), (hit) => `<mark>${hit}</mark>`);
}

function relativeTime(iso) {
  const then = new Date(iso);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return `${then.getMonth() + 1}.${then.getDate()}`;
}

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
      new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000
  );
  if (diff === 0) return "오늘";
  if (diff === 1) return "어제";
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${weekday})`;
}

function formatStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}.${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 입력이 쓰는 'YYYY-MM-DDTHH:mm' 형식(로컬 시각). */
function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatUpdated(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 수집`;
}

/** 한 매체가 상단을 독점하지 않도록 출처별로 한 건씩 돌아가며 뽑습니다. */
function diversify(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.sourceId)) groups.set(item.sourceId, []);
    groups.get(item.sourceId).push(item);
  }
  const lists = [...groups.values()].sort((a, b) =>
    b[0].publishedAt.localeCompare(a[0].publishedAt)
  );
  const out = [];
  for (let round = 0; out.length < items.length; round += 1) {
    for (const list of lists) if (list[round]) out.push(list[round]);
  }
  return out;
}

// ================================================================ 필터

/** 기간을 뺀 나머지 조건(국가·출처·검색어). */
function matchesBase(item) {
  if (!state.regions.has(item.region)) return false;
  if (!state.sources.has(item.sourceId)) return false;
  if (!state.query) return true;
  const haystack = `${item.title} ${item.source} ${item.summary || ""}`.toLowerCase();
  return haystack.includes(state.query.toLowerCase());
}

/** 프리셋의 시작 시각(ms). 'all' 이면 제한 없음. */
function presetStart(preset) {
  const now = Date.now();
  const hour = 3600000;
  switch (preset) {
    case "today": {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    case "6h": return now - 6 * hour;
    case "24h": return now - 24 * hour;
    case "3d": return now - 72 * hour;
    case "7d": return now - 168 * hour;
    default: return null;
  }
}

function inRange(item, preset = state.preset) {
  const at = Date.parse(item.publishedAt);
  if (preset === "custom") {
    if (state.from !== null && at < state.from) return false;
    if (state.to !== null && at > state.to) return false;
    return true;
  }
  const start = presetStart(preset);
  return start === null || at >= start;
}

function matches(item) {
  return matchesBase(item) && inRange(item);
}

function isDefaultFilters() {
  return (
    state.regions.size === REGIONS.length &&
    state.sources.size === state.sourceIds.length &&
    state.sort === "mixed" &&
    state.preset === "all" &&
    !state.query
  );
}

/** 날짜별로 묶고, 하루 안에서 정렬 방식을 적용합니다. */
function groupByDay(items) {
  const groups = [];
  const index = new Map();
  for (const item of items) {
    const key = dayKey(item.publishedAt);
    if (!index.has(key)) {
      index.set(key, { key, label: dayLabel(item.publishedAt), items: [] });
      groups.push(index.get(key));
    }
    index.get(key).items.push(item);
  }
  for (const group of groups) {
    if (state.sort === "mixed") group.items = diversify(group.items);
  }
  return groups;
}

// ================================================================ 렌더링

function metaHtml(item) {
  return `<span class="meta">
    <span class="source-tag" data-region="${item.region}">
      <span class="dotmark"></span>${escapeHtml(item.channel || item.source)}
    </span>
    <time datetime="${escapeHtml(item.publishedAt)}">${relativeTime(item.publishedAt)}</time>
  </span>`;
}

function articleHtml(item) {
  const read = state.read.has(item.url) ? " is-read" : "";
  return `<li>
    <a class="item${read}" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" data-url="${escapeHtml(item.url)}">
      <p class="article-title">${highlight(escapeHtml(item.title))}</p>
      ${item.summary ? `<p class="article-summary">${highlight(escapeHtml(item.summary))}</p>` : ""}
      ${metaHtml(item)}
    </a>
  </li>`;
}

function renderArticles(all) {
  const shown = all.slice(0, state.visible);
  $("articles").innerHTML = groupByDay(shown)
    .map(
      (group) => `<section class="day-group">
        <h3 class="day-head">${group.label}<span class="day-count">${group.items.length}</span></h3>
        <ol class="article-list">${group.items.map(articleHtml).join("")}</ol>
      </section>`
    )
    .join("");

  const hasMore = all.length > shown.length;
  $("more").hidden = !hasMore;
  $("more").textContent = `더 보기 (${all.length - shown.length}건 남음)`;
  $("articles-count").textContent = all.length
    ? `${shown.length} / ${all.length}건`
    : "0건";
  $("articles-empty").hidden = all.length > 0;
}

function renderVideos(items) {
  const ordered = state.sort === "mixed" ? diversify(items) : items;
  $("videos").innerHTML = ordered
    .map((item) => {
      const read = state.read.has(item.url) ? " is-read" : "";
      return `<a class="video-card item${read}" role="listitem" href="${escapeHtml(item.url)}"
          target="_blank" rel="noopener noreferrer" data-url="${escapeHtml(item.url)}">
        <div class="thumb-wrap">
          ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy">` : ""}
          <span class="play-badge">▶ 영상</span>
        </div>
        <p class="video-title">${highlight(escapeHtml(item.title))}</p>
        ${metaHtml(item)}
      </a>`;
    })
    .join("");
  $("videos-count").textContent = `${items.length}건`;
  $("videos-empty").hidden = items.length > 0;
  $("videos").hidden = items.length === 0;
  $("rail-prev").disabled = $("rail-next").disabled = items.length === 0;
}

function renderRange() {
  // 기간을 뺀 조건으로 먼저 좁힌 뒤, 프리셋별 건수를 보여줍니다.
  const base = state.items.filter(matchesBase);
  let activeLabel = "전체";
  for (const chip of $("range-presets").children) {
    const preset = chip.dataset.preset;
    const on = preset === state.preset;
    chip.classList.toggle("is-on", on);
    chip.setAttribute("aria-pressed", String(on));
    chip.querySelector(".chip-num").textContent =
      base.filter((item) => inRange(item, preset)).length;
    if (on) activeLabel = chip.textContent.trim().split(/\s+/)[0];
  }

  if (state.preset === "custom") {
    activeLabel =
      `${state.from === null ? "처음" : formatStamp(state.from)} ~ ` +
      `${state.to === null ? "지금" : formatStamp(state.to)}`;
  }
  $("range-label").textContent = activeLabel;
  $("range-apply").disabled = !$("range-from").value && !$("range-to").value;
}

function render() {
  const visible = state.items.filter(matches);
  renderArticles(visible.filter((i) => i.type === "article"));
  renderVideos(visible.filter((i) => i.type === "video"));
  renderRange();
  $("reset").hidden = isDefaultFilters();
}

function renderSourceChips(feed) {
  const counts = new Map();
  for (const item of state.items) {
    counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
  }
  const list = feed.sources.filter((s) => counts.has(s.id));
  state.sourceIds = list.map((s) => s.id);

  // 저장된 선택은 지금 피드에 있는 출처로만 좁히고, 저장분이 없으면 전체 선택.
  state.sources = state.sourcesRestored
    ? new Set([...state.sources].filter((id) => counts.has(id)))
    : new Set(state.sourceIds);

  $("source-chips").innerHTML = list
    .map(
      (s) => `<button type="button" class="chip source-chip${
        state.sources.has(s.id) ? " is-on" : ""
      }" data-source="${escapeHtml(s.id)}" data-region="${s.region}"
        aria-pressed="${state.sources.has(s.id)}">
        <span class="dotmark"></span>${escapeHtml(s.name)}
        <span class="chip-num">${counts.get(s.id)}</span>
      </button>`
    )
    .join("");
  updateSourcesNum();

  for (const region of REGIONS) {
    const el = document.querySelector(`[data-count="${region}"]`);
    if (el) {
      el.textContent = state.items.filter((i) => i.region === region).length;
    }
  }
}

function updateSourcesNum() {
  const total = state.sourceIds.length;
  const picked = state.sources.size;
  $("sources-num").textContent = picked === total ? `${total}` : `${picked}/${total}`;
}

function renderSourceStatus(feed) {
  const { sourcesOk, sourcesTotal } = feed.counts;
  const failed = feed.sources.filter((s) => !s.ok && !s.stale);
  const stale = feed.sources.filter((s) => s.stale);
  $("source-summary").textContent =
    `소스 ${sourcesTotal}개 중 ${sourcesOk}개 수집됨` +
    (stale.length ? ` · 이전 수집분 유지 ${stale.length}개` : "") +
    (failed.length ? ` · 실패 ${failed.length}개` : "") +
    ` · 기사 ${feed.counts.articles}건 · 영상 ${feed.counts.videos}건`;
  $("source-status").innerHTML = feed.sources
    .map((s) => {
      const cls = s.ok ? "" : s.stale ? "stale" : "failed";
      const tip = s.error ? ` title="${escapeHtml(s.error)}"` : "";
      const num = s.ok ? s.count : s.stale ? `${s.count} 이전분` : "실패";
      return `<li class="${cls}"${tip}>${escapeHtml(s.name)} <span class="chip-num">${num}</span></li>`;
    })
    .join("");
}

// ================================================================ 이벤트

function markRead(url, element) {
  if (!url || state.read.has(url)) return;
  state.read.add(url);
  element?.classList.add("is-read");
  saveStore(STORE_READ, [...state.read].slice(-800));
}

function bindRegionChips() {
  $("regions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-region]");
    if (!button) return;
    const region = button.dataset.region;
    if (state.regions.has(region)) state.regions.delete(region);
    else state.regions.add(region);
    if (state.regions.size === 0) state.regions.add(region); // 전부 끄지는 못하게
    const on = state.regions.has(region);
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
    state.visible = PAGE_SIZE;
    saveFilters();
    render();
  });
}

/** 패널은 한 번에 하나만 엽니다. */
function togglePanel(panelId, toggleId) {
  const open = $(panelId).hidden;
  for (const [panel, button] of [
    ["sources-panel", "sources-toggle"],
    ["range-panel", "range-toggle"],
  ]) {
    const show = panel === panelId && open;
    $(panel).hidden = !show;
    $(button).setAttribute("aria-expanded", String(show));
  }
}

function bindSourcePanel() {
  $("sources-toggle").addEventListener("click", () =>
    togglePanel("sources-panel", "sources-toggle")
  );

  $("source-chips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-source]");
    if (!button) return;
    const id = button.dataset.source;
    if (state.sources.has(id)) state.sources.delete(id);
    else state.sources.add(id);
    syncSourceChips();
  });

  document.querySelector('[data-sources="all"]').addEventListener("click", () => {
    state.sources = new Set(state.sourceIds);
    syncSourceChips();
  });

  document.querySelector('[data-sources="none"]').addEventListener("click", () => {
    state.sources.clear();
    syncSourceChips();
  });
}

function syncSourceChips() {
  for (const chip of $("source-chips").children) {
    const on = state.sources.has(chip.dataset.source);
    chip.classList.toggle("is-on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  updateSourcesNum();
  state.visible = PAGE_SIZE;
  saveFilters();
  render();
}

function applyRange(preset, from = null, to = null) {
  state.preset = preset;
  state.from = from;
  state.to = to;
  state.visible = PAGE_SIZE;
  saveFilters();
  render();
}

function bindRangePanel() {
  $("range-toggle").addEventListener("click", () =>
    togglePanel("range-panel", "range-toggle")
  );

  $("range-presets").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) return;
    $("range-from").value = "";
    $("range-to").value = "";
    applyRange(button.dataset.preset);
  });

  const readInputs = () => {
    const from = $("range-from").value ? new Date($("range-from").value).getTime() : null;
    const to = $("range-to").value ? new Date($("range-to").value).getTime() : null;
    return [from, to];
  };

  $("range-apply").addEventListener("click", () => {
    let [from, to] = readInputs();
    if (from === null && to === null) {
      applyRange("all");
      return;
    }
    if (from !== null && to !== null && from > to) [from, to] = [to, from]; // 뒤집혀 있으면 바로잡음
    $("range-from").value = from === null ? "" : toLocalInput(from);
    $("range-to").value = to === null ? "" : toLocalInput(to);
    applyRange("custom", from, to);
  });

  $("range-clear").addEventListener("click", () => {
    $("range-from").value = "";
    $("range-to").value = "";
    applyRange("all");
  });

  // 입력만 고치고 적용 버튼을 누르지 않은 상태를 버튼 활성/비활성으로 알립니다.
  for (const id of ["range-from", "range-to"]) {
    $(id).addEventListener("input", () => {
      $("range-apply").disabled = !$("range-from").value && !$("range-to").value;
    });
  }
}

function bindSort() {
  document.querySelector(".sort").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (!button || button.classList.contains("is-on")) return;
    state.sort = button.dataset.sort;
    for (const seg of document.querySelectorAll("[data-sort]")) {
      seg.classList.toggle("is-on", seg === button);
    }
    state.visible = PAGE_SIZE;
    saveFilters();
    render();
  });
}

function bindSearch() {
  let timer;
  $("search").addEventListener("input", (event) => {
    clearTimeout(timer);
    const value = event.target.value.trim();
    timer = setTimeout(() => {
      state.query = value;
      state.visible = PAGE_SIZE;
      $("search-kbd").style.opacity = value ? "0" : "";
      render();
    }, 120);
  });
}

function resetFilters() {
  state.regions = new Set(REGIONS);
  state.sources = new Set(state.sourceIds);
  state.sort = "mixed";
  state.preset = "all";
  state.from = null;
  state.to = null;
  state.query = "";
  state.visible = PAGE_SIZE;
  $("range-from").value = "";
  $("range-to").value = "";
  $("search").value = "";
  $("search-kbd").style.opacity = "";
  for (const chip of $("regions").children) {
    chip.classList.add("is-on");
    chip.setAttribute("aria-pressed", "true");
  }
  for (const seg of document.querySelectorAll("[data-sort]")) {
    seg.classList.toggle("is-on", seg.dataset.sort === "mixed");
  }
  syncSourceChips();
}

function bindMore() {
  $("more").addEventListener("click", () => {
    state.visible += PAGE_SIZE;
    render();
  });

  // 자동 로딩: 목록 끝이 보이면 다음 묶음을 이어 붙입니다.
  const sentinel = $("sentinel");
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries[0].isIntersecting || $("more").hidden) return;
      state.visible += PAGE_SIZE;
      render();
      // 아직 화면에 남아 있으면 다시 알림을 받도록 재등록합니다.
      observer.unobserve(sentinel);
      observer.observe(sentinel);
    },
    { rootMargin: "600px" }
  );
  observer.observe(sentinel);
}

function bindRail() {
  const rail = $("videos");
  const scrollBy = (dir) =>
    rail.scrollBy({ left: dir * rail.clientWidth * 0.85, behavior: "smooth" });
  $("rail-prev").addEventListener("click", () => scrollBy(-1));
  $("rail-next").addEventListener("click", () => scrollBy(1));
  // 세로 휠로도 가로 스크롤
  rail.addEventListener(
    "wheel",
    (event) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        rail.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    },
    { passive: false }
  );
}

function bindReadTracking() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest(".item[data-url]");
    if (link) markRead(link.dataset.url, link);
  });
  document.addEventListener("auxclick", (event) => {
    const link = event.target.closest(".item[data-url]");
    if (link && event.button === 1) markRead(link.dataset.url, link);
  });
}

function bindTheme() {
  const order = ["auto", "light", "dark"];
  const icon = { auto: "🌗", light: "☀️", dark: "🌙" };
  let mode = loadStore(STORE_THEME, "auto");

  const apply = () => {
    if (mode === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    $("theme-icon").textContent = icon[mode];
    $("theme").title = `화면 테마: ${{ auto: "시스템", light: "밝게", dark: "어둡게" }[mode]}`;
  };

  apply();
  $("theme").addEventListener("click", () => {
    mode = order[(order.indexOf(mode) + 1) % order.length];
    saveStore(STORE_THEME, mode);
    apply();
  });
}

function bindShortcuts() {
  document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (event.key === "/" && !typing) {
      event.preventDefault();
      $("search").focus();
      $("search").select();
    } else if (event.key === "Escape" && typing) {
      $("search").value = "";
      state.query = "";
      state.visible = PAGE_SIZE;
      $("search-kbd").style.opacity = "";
      $("search").blur();
      render();
    } else if (event.key === "g" && !typing) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
}

/** 날짜 헤더가 sticky 헤더 밑에 가리지 않도록 실제 높이를 CSS 변수로 넘깁니다. */
function trackHeaderHeight() {
  const header = document.querySelector(".site-header");
  const update = () =>
    document.documentElement.style.setProperty(
      "--header-h",
      `${Math.round(header.getBoundingClientRect().height)}px`
    );
  update();
  if (window.ResizeObserver) new ResizeObserver(update).observe(header);
  else window.addEventListener("resize", update);
}

function bindToTop() {
  const button = $("to-top");
  button.addEventListener("click", () =>
    window.scrollTo({ top: 0, behavior: "smooth" })
  );
  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        button.hidden = window.scrollY < 600;
        ticking = false;
      });
    },
    { passive: true }
  );
}

// ================================================================ 시작

function restoreFilters() {
  const saved = loadStore(STORE_FILTERS, null);
  if (!saved) return;
  if (Array.isArray(saved.regions) && saved.regions.length) {
    state.regions = new Set(saved.regions.filter((r) => REGIONS.includes(r)));
    if (!state.regions.size) state.regions = new Set(REGIONS);
  }
  if (Array.isArray(saved.sources)) {
    state.sources = new Set(saved.sources);
    state.sourcesRestored = true;
  }
  if (saved.sort === "recent" || saved.sort === "mixed") state.sort = saved.sort;
  if (typeof saved.preset === "string") {
    state.preset = saved.preset;
    state.from = typeof saved.from === "number" ? saved.from : null;
    state.to = typeof saved.to === "number" ? saved.to : null;
    if (state.preset === "custom") {
      if (state.from !== null) $("range-from").value = toLocalInput(state.from);
      if (state.to !== null) $("range-to").value = toLocalInput(state.to);
    }
  }

  for (const chip of $("regions").children) {
    const on = state.regions.has(chip.dataset.region);
    chip.classList.toggle("is-on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  for (const seg of document.querySelectorAll("[data-sort]")) {
    seg.classList.toggle("is-on", seg.dataset.sort === state.sort);
  }
}

/** 실제 데이터가 걸쳐 있는 구간을 알려주고, 입력의 min/max 로도 씁니다. */
function setupRangeBounds() {
  if (!state.items.length) return;
  const stamps = state.items.map((i) => Date.parse(i.publishedAt));
  const oldest = Math.min(...stamps);
  const newest = Math.max(...stamps);
  $("range-span").textContent = `데이터 ${formatStamp(oldest)} ~ ${formatStamp(newest)}`;
  for (const id of ["range-from", "range-to"]) {
    $(id).min = toLocalInput(oldest);
    $(id).max = toLocalInput(newest);
  }
}

function showSkeleton() {
  $("articles").innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join("");
}

async function init() {
  bindTheme();
  restoreFilters();
  state.read = new Set(loadStore(STORE_READ, []));
  showSkeleton();

  bindRegionChips();
  bindSourcePanel();
  bindRangePanel();
  bindSort();
  bindSearch();
  bindMore();
  bindRail();
  bindReadTracking();
  bindShortcuts();
  bindToTop();
  trackHeaderHeight();
  $("reset").addEventListener("click", resetFilters);
  document.querySelector("[data-reset]").addEventListener("click", resetFilters);

  try {
    const feed = await loadFeed();
    state.items = (feed.items || []).map((item) => ({
      ...item,
      sourceId: item.sourceId || item.source,
    }));

    $("updated").textContent = formatUpdated(feed.generatedAt);
    setupRangeBounds();
    renderSourceChips(feed);
    renderSourceStatus(feed);
    render();
  } catch (err) {
    $("updated").textContent = "데이터 없음";
    $("articles").innerHTML = "";
    $("articles-empty").hidden = false;
    $("articles-empty").textContent =
      "feed.json 을 불러오지 못했습니다. python3 scripts/collect.py 를 먼저 실행하세요.";
    console.error(err);
  }
}

init();
