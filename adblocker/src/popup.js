const SETTINGS_KEY = "adshield_settings";
const STATS_KEY = "adshield_stats";
const DEFAULT_SETTINGS = {
  enabled: true,
  disabledSites: [],
  pausedUntil: {},
  globalPausedUntil: 0,
  rulesets: { ads: true, tracking: true, annoyances: true, url_clean: true, malware: true },
  antiDetect: true,
  assist: true,
  showBadge: true,
  theme: "auto"
};
const RULESETS = [
  { id: "ads",        label: "广告拦截",   color: "#FD3638" },
  { id: "tracking",   label: "追踪防护",   color: "#A78BFA" },
  { id: "annoyances", label: "干扰过滤",   color: "#F79009" },
  { id: "url_clean",  label: "URL 清理",   color: "#00AEF0" },
  { id: "malware",    label: "恶意防护",   color: "#7F1D1D" }
];
const FEATURES = [
  { key: "antiDetect", label: "反拦截检测" }
];
const PAUSE_TYPES = { 60: "1 小时", 1440: "1 天", 0: "永久" };

const $ = (s) => document.querySelector(s);
let currentHost = "";

async function readSettings() {
  const store = await chrome.storage.local.get(SETTINGS_KEY);
  const s = Object.assign({}, DEFAULT_SETTINGS, store[SETTINGS_KEY] || {});
  s.pausedUntil = s.pausedUntil || {};
  s.disabledSites = s.disabledSites || [];
  s.rulesets = Object.assign({}, DEFAULT_SETTINGS.rulesets, s.rulesets || {});
  return s;
}
async function writeSettings(next) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
}
async function readStats() {
  // 优先向 background 请求（bg 内存里有实时数据）
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getStats" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        chrome.storage.local.get(STATS_KEY).then(store => {
          resolve(store[STATS_KEY] || { total: 0, byPage: {}, byBlocked: {}, byCategory: {} });
        });
      } else {
        resolve(resp);
      }
    });
  });
}

function isPaused(host, s) {
  if (!host) return false;
  if (s.disabledSites.includes(host)) return true;
  const until = s.pausedUntil[host];
  return !!(until && until > Date.now());
}
function pauseRemainText(host, s) {
  if (s.disabledSites.includes(host)) return "已永久暂停";
  const until = s.pausedUntil[host];
  if (!until || until <= Date.now()) return "";
  const mins = Math.ceil((until - Date.now()) / 60000);
  if (mins >= 1440) return `${Math.ceil(mins/1440)} 天后自动恢复`;
  if (mins >= 60) return `${Math.ceil(mins/60)} 小时后自动恢复`;
  return `${mins} 分钟后自动恢复`;
}

/* ---------- Menu 开关列表 ---------- */
function buildMenuRow({ label, color, checked, disabled }) {
  const row = document.createElement("label");
  row.className = "menu-row";
  row.innerHTML = `
    <div class="menu-row-label">
      ${color ? `<span class="menu-row-dot" style="background:${color}"></span>` : ""}
      <span>${label}</span>
    </div>
    <div class="switch-toggle">
      <input type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span class="slider"></span>
    </div>
  `;
  return row;
}
function renderMenuLists(s) {
  const rl = $("#rulesetList");
  rl.innerHTML = "";
  for (const r of RULESETS) {
    const row = buildMenuRow({
      label: r.label, color: r.color,
      checked: s.rulesets[r.id] !== false,
      disabled: !s.enabled
    });
    const input = row.querySelector("input");
    input.addEventListener("change", async () => {
      const cur = await readSettings();
      cur.rulesets[r.id] = input.checked;
      await writeSettings(cur);
    });
    rl.appendChild(row);
  }

  const fl = $("#featureList");
  if (!fl) return;   // 「功能」分区已从 popup 移除
  fl.innerHTML = "";
  for (const f of FEATURES) {
    const row = buildMenuRow({
      label: f.label,
      checked: s[f.key] !== false,
      disabled: !s.enabled
    });
    const input = row.querySelector("input");
    input.addEventListener("change", async () => {
      const cur = await readSettings();
      cur[f.key] = input.checked;
      await writeSettings(cur);
    });
    fl.appendChild(row);
  }
}

/* ---------- Wheel ---------- */
// Ghostery 风格细线 + 多色分段（ads/tracking/annoyances/url_clean/malware）
const CATS = ["ads", "tracking", "annoyances", "url_clean", "malware"];
const SEG_CLASS = { ads: "seg-ads", tracking: "seg-track", annoyances: "seg-anno", url_clean: "seg-url", malware: "seg-malware" };

const __wheelDisplay = { ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 };
const __wheelTarget  = { ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 };
let __wheelRafId = 0;

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// 把各分类计数转成 [pct, offsetDeg]
function computeSegments(catData) {
  const GAP = 1.5;      // 段间空隙（百分比）
  const MIN_SEG = 4;    // 每段最小占比（百分比）

  const active = CATS
    .map(c => ({ cat: c, value: catData[c] || 0 }))
    .filter(d => d.value > 0);

  if (!active.length) return [];

  const totalGap = GAP * active.length;
  const availablePct = 100 - totalGap;
  const sum = active.reduce((n, d) => n + d.value, 0);
  const raw = active.map(d => (d.value / sum) * availablePct);
  const small = raw.map(v => v < MIN_SEG);

  if (small.some(x => x)) {
    const minCount = small.filter(x => x).length;
    const remainingPct = availablePct - MIN_SEG * minCount;
    const bigSum = active.reduce((n, d, i) => n + (small[i] ? 0 : d.value), 0);
    active.forEach((d, i) => {
      d.pct = small[i]
        ? MIN_SEG
        : (bigSum > 0 ? (d.value / bigSum) * remainingPct : remainingPct / active.length);
    });
  } else {
    active.forEach((d, i) => { d.pct = raw[i]; });
  }

  // 每段起始角度（pct × 3.6）
  let offsetDeg = 0;
  const segs = [];
  for (const d of active) {
    segs.push({ cat: d.cat, pct: d.pct, offsetDeg });
    offsetDeg += (d.pct + GAP) * 3.6;
  }
  return segs;
}

function paintSegments(catData) {
  const segs = computeSegments(catData);

  // 先清空所有段
  for (const c of CATS) {
    const el = document.querySelector('.' + SEG_CLASS[c]);
    if (el) {
      el.setAttribute('pathLength', '100');
      el.setAttribute('stroke-dasharray', '0 100');
    }
  }

  // 画每一段
  for (const s of segs) {
    const el = document.querySelector('.' + SEG_CLASS[s.cat]);
    if (el) {
      el.setAttribute('stroke-dasharray', s.pct + ' ' + (100 - s.pct));
      el.setAttribute('transform', 'rotate(' + s.offsetDeg + ', 18, 18)');
    }
  }
}

function renderWheel(catData, animate) {
  if (animate === undefined) animate = true;

  // 更新目标
  let changed = false;
  for (const c of CATS) {
    const v = catData[c] || 0;
    if (v !== __wheelTarget[c]) changed = true;
    __wheelTarget[c] = v;
  }

  // 动画模式：数据没变就不重绘；非动画模式：始终重绘
  if (!changed && animate) return;

  if (__wheelRafId) { cancelAnimationFrame(__wheelRafId); __wheelRafId = 0; }

  if (!animate) {
    for (const c of CATS) __wheelDisplay[c] = __wheelTarget[c];
    paintSegments(__wheelTarget);
    return;
  }

  const start = Object.assign({}, __wheelDisplay);
  const end = Object.assign({}, __wheelTarget);
  const t0 = performance.now();
  const DURATION = 500;

  function tick(now) {
    const t = Math.min((now - t0) / DURATION, 1);
    const e = easeOutCubic(t);
    for (const c of CATS) {
      __wheelDisplay[c] = start[c] + (end[c] - start[c]) * e;
    }
    paintSegments(__wheelDisplay);
    if (t < 1) {
      __wheelRafId = requestAnimationFrame(tick);
    } else {
      __wheelRafId = 0;
    }
  }
  __wheelRafId = requestAnimationFrame(tick);
}

/* ---------- 分类 chip 渲染 ---------- */
const CAT_LABELS = { ads: "广告", tracking: "追踪", annoyances: "干扰", url_clean: "URL", malware: "恶意" };
const CAT_COLORS = { ads: "#FD3638", tracking: "#A78BFA", annoyances: "#F79009", url_clean: "#00AEF0", malware: "#7F1D1D" };

function renderCatChips(byCategory) {
  const row = $("#catRow");
  if (!row) return;
  row.innerHTML = "";

  const items = CATS
    .map(cat => ({ cat, count: byCategory[cat] || 0 }))
    .filter(x => x.count > 0);

  if (!items.length) {
    row.innerHTML = '<div class="cat-empty">本站暂无分类拦截</div>';
    return;
  }

  // 按数量降序
  items.sort((a, b) => b.count - a.count);

  for (const item of items) {
    const chip = document.createElement("div");
    chip.className = "cat-chip";
    chip.innerHTML =
      '<span class="cat-dot" style="background:' + CAT_COLORS[item.cat] + '"></span>' +
      CAT_LABELS[item.cat] + ' <b>' + item.count + '</b>';
    row.appendChild(chip);
  }
}

/* ---------- 主渲染 ---------- */
async function render() {
  let host = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:/.test(tab.url)) host = new URL(tab.url).hostname;
  } catch {}
  currentHost = host;

  const s = await readSettings();
  const stats = await readStats();
  const byPage = stats.byPage || {};
  const byCategory = (stats.byCategory || {})[host] || {};
  const siteCount = byPage[host] || 0;

  // Section head
  $("#siteHost").textContent = host || "无活动页面";
  $("#siteCount").textContent = siteCount;  // 保留 DOM，但已 hidden

  // Pause
  const paused = isPaused(host, s);
  const isPermanent = paused && s.disabledSites.includes(host);
  const card = $("#pauseCard");
  card.classList.toggle("paused", paused);
  card.classList.toggle("permanent", isPermanent);
  const label = $("#pauseLabel");
  const icon = $("#pauseIcon");
  if (paused) {
    const remain = pauseRemainText(host, s);
    label.textContent = remain || "已在此网站暂停";
    // 已暂停 → 显示"播放"图标（点击可恢复）
    if (icon) {
      icon.innerHTML = '<polygon points="6 4 20 12 6 20" fill="currentColor" stroke="none"/>';
    }
  } else {
    label.textContent = host ? "在这个网站上暂停" : "无活动页面";
    // 未暂停 → 显示"暂停"图标
    if (icon) {
      icon.innerHTML = '<circle cx="12" cy="12" r="9"/><line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/>';
    }
  }

  // 暂停按钮右侧：显示用户选中的时长，或"恢复"
  const typeBtn = $("#pauseTypeBtn");
  if (paused) {
    $("#pauseTypeLabel").textContent = "恢复";
    typeBtn.disabled = false;
  } else {
    // 用上次选择的时长（默认 60）
    const last = s._lastPauseType || 60;
    $("#pauseTypeLabel").textContent = PAUSE_TYPES[last];
    typeBtn.disabled = !host;
  }

  // 高亮当前选中的时长菜单项
  const lastType = s._lastPauseType || 60;
  document.querySelectorAll(".pause-option").forEach(btn => {
    const m = parseInt(btn.dataset.min, 10);
    btn.classList.toggle("active", m === lastType);
  });

  // Wheel：把计数写到 ::after 的 data-count 上
  const wheelWrap = document.querySelector(".wheel-wrap");
  wheelWrap.setAttribute("data-count", siteCount);
  wheelWrap.classList.toggle("inactive", !host);

  // 检查当前站点是否有任何分类命中
  const hasAnyCat = Object.values(byCategory || {}).reduce((a, b) => a + b, 0) > 0;
  wheelWrap.classList.toggle("empty", !hasAnyCat);

  // 无论是否有变化，都强制刷新圆环（避免残留）
  renderWheel(byCategory, false);

  // Stats（注意：本站数用 statSite，累计数用 statTotal）
  const elSite = $("#statSite");
  const elTotal = $("#statTotal");
  if (elSite) elSite.textContent = siteCount;
  if (elTotal) elTotal.textContent = stats.total || 0;

  // 分类明细 chips
  renderCatChips(byCategory);

  // Menu 内的开关
  const swGE = $("#swGlobalEnabled");
  if (swGE) swGE.checked = s.enabled !== false;
  const swNotify = $("#swNotifyOnBlock");
  if (swNotify) swNotify.checked = !!s.notifyOnBlock;
  renderMenuLists(s);

  // 同步白名单按钮文案
  updateWhitelistLabel(s);
}

/* ---------- 事件 ---------- */
$("#pauseBtn").addEventListener("click", async () => {
  if (!currentHost) return;
  const s = await readSettings();
  if (isPaused(currentHost, s)) {
    // 恢复
    s.disabledSites = s.disabledSites.filter(h => h !== currentHost);
    delete s.pausedUntil[currentHost];
  } else {
    // 用上次选择的时长（默认 1 小时）
    const mins = s._lastPauseType || 60;
    s.disabledSites = s.disabledSites.filter(h => h !== currentHost);
    if (mins === 0) {
      s.disabledSites.push(currentHost);
      delete s.pausedUntil[currentHost];
    } else {
      s.pausedUntil[currentHost] = Date.now() + mins * 60000;
    }
  }
  await writeSettings(s);
  render();
});

$("#pauseTypeBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!currentHost) return;
  const s = await readSettings();
  if (isPaused(currentHost, s)) {
    s.disabledSites = s.disabledSites.filter(h => h !== currentHost);
    delete s.pausedUntil[currentHost];
    await writeSettings(s);
    render();
    return;
  }
  $("#pauseMenu").classList.toggle("open");
});

document.querySelectorAll(".pause-option").forEach(btn => {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!currentHost) return;
    const mins = parseInt(btn.dataset.min, 10);
    const s = await readSettings();
    s._lastPauseType = mins;   // 记住本次选择
    s.disabledSites = s.disabledSites.filter(h => h !== currentHost);
    if (mins === 0) {
      s.disabledSites.push(currentHost);
      delete s.pausedUntil[currentHost];
    } else {
      s.pausedUntil[currentHost] = Date.now() + mins * 60000;
    }
    await writeSettings(s);
    $("#pauseMenu").classList.remove("open");
    render();
  });
});

document.addEventListener("click", () => {
  $("#pauseMenu").classList.remove("open");
});

// 通知开关
$("#swNotifyOnBlock").addEventListener("change", async (e) => {
  const s = await readSettings();
  s.notifyOnBlock = e.target.checked;
  await writeSettings(s);
  // 首次开启 → 请求通知权限（Chrome 会在首次 create 时自动弹权限）
  if (e.target.checked) {
    try {
      chrome.notifications.create("adshield-test-" + Date.now(), {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "AdShield 通知已开启",
        message: "后续拦截广告时会通知您",
        silent: true
      });
    } catch (err) {}
  }
});

// Menu 打开 / 关闭
$("#menuBtn").addEventListener("click", () => $("#menuOverlay").classList.add("open"));
$("#menuCloseBtn").addEventListener("click", () => $("#menuOverlay").classList.remove("open"));
$("#menuOverlay").addEventListener("click", (e) => {
  if (e.target === $("#menuOverlay")) $("#menuOverlay").classList.remove("open");
});

// 底部按钮
/* ---------- 工具项：打开网站设置 ---------- */
$("#actSiteSettings").addEventListener("click", () => {
  if (!currentHost) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/options.html#sites?host=${encodeURIComponent(currentHost)}`) });
  window.close();
});

/* ---------- 工具项：查看详细日志 ---------- */
$("#actLogger").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/logger.html") });
  window.close();
});

/* ---------- 工具项：清除浏览数据 ---------- */
$("#actClearData").addEventListener("click", async () => {
  const ok = await showConfirm("将清除当前网站的 Cookie、缓存和本地存储。确定继续？", {
    title: "清除浏览数据",
    confirmText: "清除",
    type: "warning"
  });
  if (!ok) return;
  try {
    // browsingData 是可选权限，先请求
    const granted = await chrome.permissions.request({ permissions: ["browsingData"] });
    if (!granted) {
      await showAlert("需要授权「清除浏览数据」权限才能使用此功能。", { title: "未授权", type: "warning" });
      return;
    }
    // 拿到当前标签页的 origin
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const origin = new URL(tab.url).origin;
    await chrome.browsingData.remove(
      { origins: [origin] },
      {
        cache: true,
        cookies: true,
        localStorage: true,
        indexedDB: true,
        serviceWorkers: true
      }
    );
    await showAlert("已清除 " + currentHost + " 的浏览数据", { title: "完成", type: "info" });
    chrome.tabs.reload(tab.id);
  } catch (e) {
    await showAlert("清除失败：" + e.message, { title: "错误", type: "danger" });
  }
});

/* ---------- 工具项：加入/移出白名单 ---------- */
$("#actWhitelist").addEventListener("click", async () => {
  if (!currentHost) {
    await showAlert("无活动页面", { title: "提示", type: "info" });
    return;
  }
  const s = await readSettings();
  const inList = s.disabledSites.includes(currentHost);
  if (inList) {
    s.disabledSites = s.disabledSites.filter(h => h !== currentHost);
  } else {
    s.disabledSites.push(currentHost);
    delete s.pausedUntil[currentHost];   // 加入白名单时清掉临时暂停
  }
  await writeSettings(s);
  render();
  // 更新按钮文案
  updateWhitelistLabel(s);
});

function updateWhitelistLabel(s) {
  const label = $("#whitelistLabel");
  if (!label) return;
  const inList = currentHost && s.disabledSites && s.disabledSites.includes(currentHost);
  label.textContent = inList ? "移出白名单" : "加入白名单";
}

/* ---------- 工具项：隐藏内容块（元素拾取器） ---------- */
$("#actHideBlock").addEventListener("click", async () => {
  if (!currentHost) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    await showAlert("当前页面不支持元素拾取（仅限 http/https 页面）。", { title: "无法使用", type: "warning" });
    return;
  }

  // 第一次尝试：直接发消息（正常情况 content script 已注入）
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "startElementPicker" });
    window.close();
    return;
  } catch (e) {
    // 失败则尝试动态注入（旧页面 / 扩展刚重载）
    console.log("[AdShield] 直接发消息失败，尝试动态注入 picker.js:", e.message);
  }

  // 兜底：动态注入 picker.js 后再发消息
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ["src/content/picker.js"]
    });
    // 等 100ms 让脚本注册 listener
    await new Promise(r => setTimeout(r, 100));
    await chrome.tabs.sendMessage(tab.id, { type: "startElementPicker" });
    window.close();
  } catch (e2) {
    await showAlert("无法启动拾取器：\n" + e2.message + "\n\n请刷新页面后重试。", { title: "启动失败", type: "danger" });
  }
});

/* ---------- 工具项：报告问题 ---------- */
$("#actReport").addEventListener("click", async () => {
  if (!currentHost) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const s = await readSettings();
  const stats = await readStats();
  const byPage = stats.byPage || {};
  const byCategory = (stats.byCategory || {})[currentHost] || {};
  const report = {
    _type: "adshield-issue-report",
    _version: 1,
    时间: new Date().toISOString(),
    站点: currentHost,
    页面URL: tab ? tab.url : "",
    本站拦截数: byPage[currentHost] || 0,
    分类统计: byCategory,
    全局累计拦截: stats.total || 0,
    当前设置: {
      规则集: s.rulesets,
      全局启用: s.enabled,
      反拦截检测: s.antiDetect,
      本站已暂停: s.disabledSites.includes(currentHost)
    }
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `adshield-report-${currentHost}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// 全局启用开关
const swGE = $("#swGlobalEnabled");
if (swGE) {
  swGE.addEventListener("change", async (e) => {
    const cur = await readSettings();
    cur.enabled = e.target.checked;
    cur.globalPausedUntil = 0;
    await writeSettings(cur);
    render();
  });
}

$("#optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#resetBtn").addEventListener("click", async () => {
  // 通过 background 重置（保证内存缓冲一起清空）
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "resetStats" }, () => resolve());
  });
  // 重置内存里的圆环状态
  for (const c of CATS) { __wheelDisplay[c] = 0; __wheelTarget[c] = 0; }
  __wheelRafId && cancelAnimationFrame(__wheelRafId);
  __wheelRafId = 0;
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[SETTINGS_KEY] || changes[STATS_KEY])) render();
});

// 轻量轮询：popup 打开时每 2 秒刷新数字（万一用户在别的标签访问）
setInterval(() => {
  if (document.visibilityState === "visible") render();
}, 2000);

render();
