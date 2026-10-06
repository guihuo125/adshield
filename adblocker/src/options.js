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
  { id: "ads",        label: "广告拦截", desc: "拦截横幅、弹窗、视频贴片等展示广告",       color: "#FD3638" },
  { id: "tracking",   label: "追踪防护", desc: "阻止第三方跨站追踪器收集您的浏览行为",     color: "#A78BFA" },
  { id: "annoyances", label: "干扰过滤", desc: "屏蔽推送请求、弹窗挂件、反拦截检测脚本",   color: "#F79009" },
  { id: "url_clean",  label: "URL 清理", desc: "自动去除链接里的 utm 等追踪参数",          color: "#00AEF0" },
  { id: "malware",    label: "恶意防护", desc: "拦截浏览器挖矿脚本与已知恶意/欺诈分发域名", color: "#7F1D1D" }
];
const CATS = [
  { key: "ads",        label: "广告", color: "#FD3638" },
  { key: "tracking",   label: "追踪", color: "#A78BFA" },
  { key: "annoyances", label: "干扰", color: "#F79009" },
  { key: "url_clean",  label: "URL",  color: "#00AEF0" },
  { key: "malware",    label: "恶意", color: "#7F1D1D" }
];

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// 版本号：从 manifest 动态读取，避免硬编码
(function syncVersion() {
  try {
    const v = chrome.runtime.getManifest().version;
    const vText = "v" + v;
    const fv = document.getElementById("footVersion");
    const av = document.getElementById("aboutVersion");
    if (fv) fv.textContent = vText;
    if (av) av.textContent = vText;
  } catch (e) {}
})();

// 项目链接：点击打开外部 URL
document.addEventListener("click", (e) => {
  const item = e.target.closest(".link-item[data-url]");
  if (!item) return;
  const url = item.getAttribute("data-url");
  if (url) chrome.tabs.create({ url });
});

// 版本号比较：a > b 返回 1，a < b 返回 -1，相等 0
function compareVersion(a, b) {
  const clean = (s) => String(s || "").replace(/^v/i, "").trim();
  const pa = clean(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = clean(b).split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// 检查更新 + 更新日志（融合版）
async function checkUpdate() {
  const btn = document.getElementById("checkUpdateBtn");
  const desc = document.getElementById("checkUpdateDesc");
  const currentVersion = chrome.runtime.getManifest().version;
  const origDesc = desc ? desc.textContent : "";

  // Loading 状态
  if (btn) btn.style.pointerEvents = "none";
  if (desc) desc.textContent = "正在检查...";

  try {
    // 一次拉取最近 20 个 Release
    const resp = await fetch("https://api.github.com/repos/guihuo125/adshield/releases?per_page=20", {
      headers: { "Accept": "application/vnd.github+json" },
      cache: "no-store"
    });
    if (!resp.ok) throw new Error("GitHub API " + resp.status);
    const releases = await resp.json();

    if (desc) desc.textContent = origDesc;
    if (btn) btn.style.pointerEvents = "";

    if (!Array.isArray(releases) || releases.length === 0) {
      await showAlert("暂无发布版本。", { title: "检查更新", confirmText: "好的", type: "info" });
      return;
    }

    // 最新版本 = 第一个（GitHub 已按发布时间倒序）
    const latestRel = releases[0];
    const latestVersion = (latestRel.tag_name || "").replace(/^v/i, "").trim();
    const latestUrl = latestRel.html_url || "https://github.com/guihuo125/adshield/releases";

    // 找 zip 附件
    const assets = Array.isArray(latestRel.assets) ? latestRel.assets : [];
    const zipAsset = assets.find(a => /\.zip$/i.test(a.name || "")) || null;

    const cmp = compareVersion(latestVersion, currentVersion);
    const hasUpdate = cmp > 0;
    const isDev = cmp < 0;

    // ===== 顶部状态区 =====
    let statusHtml = "";
    if (hasUpdate) {
      // 下载区块（如果有 zip 附件）
      let downloadBlock = "";
      if (zipAsset && zipAsset.browser_download_url) {
        const sizeKb = zipAsset.size ? Math.round(zipAsset.size / 1024) + " KB" : "";
        const sizeText = sizeKb ? " · " + sizeKb : "";
        downloadBlock =
          '<div class="cl-download">' +
            '<a class="cl-download-btn" href="' + escapeHtmlSimple(zipAsset.browser_download_url) + '" download="' + escapeHtmlSimple(zipAsset.name) + '" data-download>' +
              '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
                '<polyline points="7 10 12 15 17 10"/>' +
                '<line x1="12" y1="15" x2="12" y2="3"/>' +
              '</svg>' +
              '直接下载 ' + escapeHtmlSimple(zipAsset.name) +
            '</a>' +
            '<div class="cl-download-hint">' + escapeHtmlSimple(zipAsset.name) + sizeText + ' · 下载后手动加载解压目录</div>' +
          '</div>';
      }
      statusHtml =
        '<div class="cl-status cl-status-update">' +
          '<div class="cl-status-title">🎉 发现新版本</div>' +
          '<div class="cl-status-desc">最新版本 <b>v' + latestVersion + '</b> · 当前版本 v' + currentVersion + '</div>' +
          downloadBlock +
        '</div>';
    } else if (isDev) {
      statusHtml =
        '<div class="cl-status cl-status-dev">' +
          '<div class="cl-status-title">🧪 开发版</div>' +
          '<div class="cl-status-desc">当前版本 v' + currentVersion + ' 比最新发布版 v' + latestVersion + ' 更新</div>' +
        '</div>';
    } else {
      statusHtml =
        '<div class="cl-status cl-status-ok">' +
          '<div class="cl-status-title">✅ 已是最新版本</div>' +
          '<div class="cl-status-desc">当前版本 v' + currentVersion + '</div>' +
        '</div>';
    }

    // ===== 更新日志列表 =====
    const currentVStr = "v" + currentVersion;
    let logsHtml = '<div class="cl-logs-title">更新日志</div><div class="changelog-list">';
    for (let i = 0; i < releases.length; i++) {
      const r = releases[i];
      const tag = (r.tag_name || "").replace(/^v/i, "");
      const isCurrent = ("v" + tag) === currentVStr;
      const date = r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : "";
      const name = r.name || r.tag_name || ("v" + tag);
      const body = r.body || "（无说明）";
      logsHtml += '<div class="changelog-item">';
      logsHtml += '<div class="changelog-head">';
      logsHtml += '<span class="changelog-tag">' + tag + '</span>';
      logsHtml += '<span class="changelog-name">' + escapeHtmlSimple(name) + '</span>';
      if (isCurrent) logsHtml += '<span class="changelog-badge">当前版本</span>';
      logsHtml += '<span class="changelog-date">' + date + '</span>';
      logsHtml += '</div>';
      logsHtml += '<div class="changelog-body">' + simpleMarkdown(body) + '</div>';
      logsHtml += '</div>';
    }
    logsHtml += '</div>';

    const html = statusHtml + logsHtml;

    // ===== 弹窗 =====
    if (hasUpdate) {
      // 有新版本：确定按钮 = 去 GitHub 页面（可选）
      const ok = await showConfirm(html, {
        title: "检查更新",
        confirmText: "打开 GitHub",
        cancelText: "关闭",
        size: "large",
        html: true,
        type: "info"
      });
      if (ok) chrome.tabs.create({ url: latestUrl });
    } else {
      // 已最新 / 开发版：只有关闭
      await showConfirm(html, {
        title: "检查更新",
        confirmText: "关闭",
        alertOnly: true,
        size: "large",
        html: true,
        type: "info"
      });
    }
  } catch (e) {
    if (desc) desc.textContent = origDesc;
    if (btn) btn.style.pointerEvents = "";
    let msg = String(e.message || e);
    if (msg.includes("403")) msg = "GitHub API 限流，请稍后再试";
    else if (msg.includes("404")) msg = "未找到发布版本";
    else if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) msg = "网络连接失败，请检查网络";
    await showAlert("检查更新失败：" + msg, { title: "检查失败", type: "warning" });
  }
}

// 简易 HTML 转义（用于名称）
function escapeHtmlSimple(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// 检查更新按钮事件
document.addEventListener("click", (e) => {
  const item = e.target.closest('.link-item[data-action="checkUpdate"]');
  if (!item) return;
  checkUpdate();
});

// 下载链接点击提示（<a download> 会由浏览器自动处理，这里只做提示）
document.addEventListener("click", (e) => {
  const dl = e.target.closest("[data-download]");
  if (!dl) return;
  // 不 preventDefault，让浏览器原生下载
  console.log("[AdShield] 开始下载:", dl.getAttribute("download") || dl.href);
  // 1.5 秒后显示"下载完成后请手动加载"提示
  setTimeout(() => {
    showAlert(
      "下载完成后：\n\n1. 解压 zip 到任意目录\n2. 打开 chrome://extensions/\n3. 移除旧版本 → 加载已解压的扩展程序 → 选解压目录",
      { title: "安装新版本", confirmText: "知道了", type: "info" }
    );
  }, 1500);
});

// ===== 更新日志 =====
// 轻量 Markdown → HTML（只处理常见语法）
function simpleMarkdown(md) {
  if (!md) return "";
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const lines = String(md).split(/\r?\n/);
  const html = [];
  let inList = false;
  let inCode = false;
  const codeBuf = [];

  const closeList = () => { if (inList) { html.push("</ul>"); inList = false; } };

  for (let raw of lines) {
    // 代码块
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        html.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
        codeBuf.length = 0;
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    let line = raw;
    // 标题
    if (/^###\s+/.test(line)) { closeList(); html.push("<h4>" + inline(esc(line.replace(/^###\s+/, ""))) + "</h4>"); continue; }
    if (/^##\s+/.test(line)) { closeList(); html.push("<h3>" + inline(esc(line.replace(/^##\s+/, ""))) + "</h3>"); continue; }
    if (/^#\s+/.test(line)) { closeList(); html.push("<h2>" + inline(esc(line.replace(/^#\s+/, ""))) + "</h2>"); continue; }

    // 列表
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push("<li>" + inline(esc(line.replace(/^\s*[-*]\s+/, ""))) + "</li>");
      continue;
    }
    // 数字列表
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push("<li>" + inline(esc(line.replace(/^\s*\d+\.\s+/, ""))) + "</li>");
      continue;
    }

    // 空行
    if (!line.trim()) { closeList(); continue; }

    closeList();
    html.push("<p>" + inline(esc(line)) + "</p>");
  }
  closeList();
  if (inCode && codeBuf.length) {
    html.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
  }

  // 行内元素：**粗**、`代码`、[文字](url)
  function inline(s) {
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  return html.join("");
}

async function readSettings() {
  const store = await chrome.storage.local.get(SETTINGS_KEY);
  const s = Object.assign({}, DEFAULT_SETTINGS, store[SETTINGS_KEY] || {});
  s.rulesets = Object.assign({}, DEFAULT_SETTINGS.rulesets, s.rulesets || {});
  s.pausedUntil = s.pausedUntil || {};
  return s;
}
async function writeSettings(next) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
}
async function readStats() {
  // 优先向 background 请求（bg 内存里有实时数据，storage 有 3 秒写盘延迟）
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getStats" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        // 降级：直接读 storage
        chrome.storage.local.get(STATS_KEY).then(store => {
          resolve(store[STATS_KEY] || { total: 0, byPage: {}, byBlocked: {}, byCategory: {} });
        });
      } else {
        resolve(resp);
      }
    });
  });
}

/* ---------- 自动检查订阅更新（打开规则页时触发，5 分钟冷却） ---------- */
let __lastAutoCheck = 0;
const AUTO_CHECK_COOLDOWN = 5 * 60 * 1000;   // 5 分钟

async function autoCheckSubscriptions() {
  // 冷却期内不重复检查
  if (Date.now() - __lastAutoCheck < AUTO_CHECK_COOLDOWN) return;
  __lastAutoCheck = Date.now();
  try {
    const resp = await sendMessage("checkSubscriptionUpdates");
    if (resp && resp.ok && resp.changed > 0) {
      // 有更新 → 强制刷新列表显示横幅
      await loadSubscriptions({ force: true });
    }
  } catch (e) {
    // 静默失败
  }
}

/* ---------- 侧栏切换 ---------- */
$$(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    const tab = item.dataset.tab;
    document.documentElement.setAttribute("data-route", tab);
    $$(".nav-item").forEach(n => n.classList.toggle("active", n === item));
    $$(".panel").forEach(p => p.classList.toggle("active", p.dataset.panel === tab));
    location.hash = tab;
    if (tab === "rules") autoCheckSubscriptions();
  });
});
// 支持 #sites?host=xxx 定位
function parseHash() {
  const raw = location.hash.replace("#", "") || "privacy";
  const [tab, query] = raw.split("?");
  const params = {};
  if (query) {
    for (const pair of query.split("&")) {
      const [k, v] = pair.split("=");
      if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : "";
    }
  }
  return { tab, params };
}
const { tab: initialTab, params: initialParams } = parseHash();
// nav-init.js（外部脚本）已在 head 里设置 active 状态（避免闪烁）
// 这里只需触发规则页的自动检查（不重复切换 active）
if (initialTab === "rules") {
  autoCheckSubscriptions();
}

// 若带 host 参数，滚动到该站点并高亮
if (initialTab === "sites" && initialParams.host) {
  setTimeout(() => {
    const target = document.querySelector(`.sites-list li[data-host="${CSS.escape(initialParams.host)}"]`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.style.background = "var(--bg-brand-soft)";
      setTimeout(() => (target.style.background = ""), 2000);
    }
  }, 250);
}

/* ---------- 规则集行 ---------- */
function renderRulesets(s) {
  // 更新 5 个分规则集开关
  const all = document.querySelectorAll("input[data-ruleset]");
  for (const input of all) {
    const id = input.getAttribute("data-ruleset");
    input.checked = s.rulesets[id] !== false;
    input.disabled = !s.enabled;
  }
}

// ===== 分规则集开关事件绑定（DOMContentLoaded 后执行一次） =====
function initRulesetToggles() {
  const all = document.querySelectorAll("input[data-ruleset]");
  for (const input of all) {
    input.addEventListener("change", async (e) => {
      const id = input.getAttribute("data-ruleset");
      const cur = await readSettings();
      cur.rulesets[id] = input.checked;
      await writeSettings(cur);
      // 立即生效：background 会监听 storage 变化并 syncRulesets
    });
  }
}

/* ---------- 网站列表 ---------- */
async function renderSites() {
  const s = await readSettings();
  const stats = await readStats();
  const byPage = stats.byPage || {};
  const now = Date.now();

  const permanent = [];
  const temporary = [];

  // 永久白名单
  for (const host of s.disabledSites) {
    permanent.push({ host, meta: "永久暂停", count: byPage[host] || 0 });
  }
  // 定时暂停（过滤过期）
  for (const [host, until] of Object.entries(s.pausedUntil)) {
    if (until && until > now) {
      const mins = Math.ceil((until - now) / 60000);
      const text = mins >= 1440
        ? `${Math.ceil(mins/1440)} 天后自动恢复`
        : mins >= 60 ? `${Math.ceil(mins/60)} 小时后自动恢复` : `${mins} 分钟后自动恢复`;
      temporary.push({ host, meta: text, count: byPage[host] || 0 });
    }
  }
  // 按拦截数降序
  permanent.sort((a, b) => b.count - a.count);
  temporary.sort((a, b) => b.count - a.count);

  renderGroup("#sitesPermanentList", "#sitesPermanentCount", "#sitesPermanentCard", permanent, "暂无永久暂停的网站");
  renderGroup("#sitesTempList", "#sitesTempCount", "#sitesTempCard", temporary, "暂无临时暂停的网站");

  // 无数据时禁用「清空全部白名单」按钮
  const clearBtn = $("#clearAllSitesBtn");
  if (clearBtn) {
    const hasAny = permanent.length + temporary.length > 0;
    clearBtn.disabled = !hasAny;
    clearBtn.style.opacity = hasAny ? "" : ".45";
    clearBtn.style.cursor = hasAny ? "" : "not-allowed";
  }
}

function renderGroup(listSel, countSel, cardSel, items, emptyText) {
  const wrap = $(listSel);
  const countEl = $(countSel);
  const cardEl = $(cardSel);
  if (!wrap) return;

  if (countEl) countEl.textContent = items.length;
  if (cardEl) cardEl.style.display = items.length ? "" : "none";

  wrap.innerHTML = "";
  if (!items.length) {
    wrap.innerHTML = `<li class='sites-empty'>${emptyText}</li>`;
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.dataset.host = item.host;
    li.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="site-host">${escapeHtml(item.host)}</div>
        <div class="site-meta">${escapeHtml(item.meta)}</div>
      </div>
      <div class="site-right">
        <span class="site-count">已拦截 <b>${item.count}</b></span>
        <button class="site-resume" data-host="${escapeHtml(item.host)}">恢复</button>
      </div>
    `;
    li.querySelector(".site-resume").addEventListener("click", async () => {
      const cur = await readSettings();
      cur.disabledSites = cur.disabledSites.filter(h => h !== item.host);
      delete cur.pausedUntil[item.host];
      await writeSettings(cur);
      renderSites();
    });
    wrap.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------- 网站页：添加 / 清空事件 ---------- */
function setupSiteEvents() {
  const addBtn = $("#siteAddBtn");
  const addInput = $("#siteAddInput");
  const hint = $("#siteAddHint");

  function showHint(text, ok) {
    if (!hint) return;
    hint.textContent = text;
    hint.className = "site-add-hint " + (ok ? "ok" : "err");
    setTimeout(() => { hint.textContent = ""; hint.className = "site-add-hint"; }, 3000);
  }

  async function addSite() {
    if (!addInput) return;
    let host = (addInput.value || "").trim().toLowerCase();
    if (!host) { showHint("请输入域名", false); return; }

    // 剥离协议和路径
    host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
      showHint("域名格式无效：" + host, false);
      return;
    }

    const s = await readSettings();
    if (s.disabledSites.includes(host)) {
      showHint("该网站已在白名单中", false);
      return;
    }
    s.disabledSites.push(host);
    await writeSettings(s);
    addInput.value = "";
    showHint(`已添加 ${host} 到白名单`, true);
    renderSites();
  }

  if (addBtn) addBtn.addEventListener("click", addSite);
  if (addInput) addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSite();
  });

  const clearBtn = $("#clearAllSitesBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      const s = await readSettings();
      const total = s.disabledSites.length + Object.keys(s.pausedUntil).length;
      if (!total) return;   // 空列表时按钮已禁用，这里兜底
      const ok = await showConfirm(`确定清空全部 ${total} 个白名单网站？`, {
        title: "清空白名单",
        confirmText: "清空",
        type: "warning"
      });
      if (!ok) return;
      s.disabledSites = [];
      s.pausedUntil = {};
      await writeSettings(s);
      renderSites();
    });
  }
}
setupSiteEvents();

/* ---------- Top 拦截域名 ---------- */
async function renderTrackers() {
  const stats = await readStats();
  const entries = Object.entries(stats.byBlocked || {}).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const ul = $("#trackerBars");
  if (!ul) return;
  const max = entries[0] ? entries[0][1] : 1;
  ul.innerHTML = "";
  if (!entries.length) {
    ul.innerHTML = "<li class='sites-empty'>暂无数据</li>";
    return;
  }
  for (const [host, cnt] of entries) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="tb-row">
        <span class="tb-host">${host}</span>
        <span class="tb-count">${cnt}</span>
      </div>
      <div class="tb-bar"><div class="tb-fill" style="width:${(cnt / max * 100).toFixed(1)}%"></div></div>
    `;
    ul.appendChild(li);
  }
}

/* ---------- 报告 ---------- */
async function renderReport() {
  // 先加载 UI 偏好（首次或切换页面后）
  await loadTrendPref();
  // 同步下拉框
  const rs = $("#rangeSelect");
  if (rs && rs.value !== String(__trendRange)) rs.value = String(__trendRange);

  const stats = await readStats();
  const elTotal = $("#repTotal");
  const elPages = $("#repPages");
  const elDomains = $("#repDomains");
  if (elTotal) elTotal.textContent = stats.total || 0;
  if (elPages) elPages.textContent = Object.keys(stats.byPage || {}).length;
  if (elDomains) elDomains.textContent = Object.keys(stats.byBlocked || {}).length;

  // 分类分布：按当前时间范围（__trendRange）汇总，与趋势图同步
  const catTotals = { ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 };
  const byDate = stats.byDate || {};
  const byHour = stats.byHour || {};
  const isHourly = __trendRange === 1;
  const isMonthly = __trendRange === 365;
  const pad2 = (n) => String(n).padStart(2, "0");

  if (isHourly) {
    // 24 小时：从 byHour 汇总当天 00:00~23:00
    const today = new Date();
    const dayPrefix = today.getFullYear() + "-" + pad2(today.getMonth() + 1) + "-" + pad2(today.getDate()) + "-";
    for (const [key, val] of Object.entries(byHour)) {
      if (!key.startsWith(dayPrefix)) continue;
      if (!val || typeof val !== "object") continue;
      for (const k of Object.keys(catTotals)) catTotals[k] += val[k] || 0;
    }
  } else if (isMonthly) {
    // 一年（按月聚合）：过去 12 个月
    const now = new Date();
    const monthPrefixes = new Set();
    for (let m = 11; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      monthPrefixes.add(d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-");
    }
    for (const [key, val] of Object.entries(byDate)) {
      if (!val || typeof val !== "object") continue;
      let match = false;
      for (const p of monthPrefixes) { if (key.startsWith(p)) { match = true; break; } }
      if (!match) continue;
      for (const k of Object.keys(catTotals)) catTotals[k] += val[k] || 0;
    }
  } else {
    // 一周 / 一个月：最近 N 天（含今天）
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (__trendRange - 1));
    const startStr = start.getFullYear() + "-" + pad2(start.getMonth() + 1) + "-" + pad2(start.getDate());
    for (const [key, val] of Object.entries(byDate)) {
      if (!val || typeof val !== "object") continue;
      if (key < startStr) continue;
      for (const k of Object.keys(catTotals)) catTotals[k] += val[k] || 0;
    }
  }

  // 回退：如果当前范围内无数据，用 byCategory 汇总
  const byDateSum = Object.values(catTotals).reduce((a, b) => a + b, 0);
  if (byDateSum === 0) {
    for (const catObj of Object.values(stats.byCategory || {})) {
      for (const k of Object.keys(catTotals)) catTotals[k] += catObj[k] || 0;
    }
  }
  const total = CATS.reduce((n, c) => n + catTotals[c.key], 0);
  const bar = $("#distBar");
  const legend = $("#distLegend");
  bar.innerHTML = "";
  legend.innerHTML = "";

  if (!total) {
    bar.innerHTML = "<div class='dist-seg' style='width:100%;background:var(--bg-tertiary)'></div>";
    legend.innerHTML = "<div class='item'>暂无数据</div>";
  } else {
    for (const c of CATS) {
      const v = catTotals[c.key];
      if (!v) continue;
      const pct = (v / total * 100);
      const seg = document.createElement("div");
      seg.className = "dist-seg";
      seg.style.width = pct.toFixed(2) + "%";
      seg.style.background = c.color;
      bar.appendChild(seg);
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `<span class="dot" style="background:${c.color}"></span>${c.label} ${pct.toFixed(1)}%`;
      legend.appendChild(item);
    }
  }

  // 站点排行
  const pages = Object.entries(stats.byPage || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const pmax = pages[0]?.[1] || 1;
  const pu = $("#pageBars");
  pu.innerHTML = "";
  if (!pages.length) {
    pu.innerHTML = "<li class='sites-empty'>暂无数据</li>";
  } else {
    for (const [host, cnt] of pages) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="tb-row">
          <span class="tb-host">${host}</span>
          <span class="tb-count">${cnt}</span>
        </div>
        <div class="tb-bar"><div class="tb-fill" style="width:${(cnt / pmax * 100).toFixed(1)}%"></div></div>
      `;
      pu.appendChild(li);
    }
  }

  // 趋势图
  renderTrend(stats);
}

/* ---------- 分类趋势图（多线 SVG） ---------- */
let __trendRange = 7;   // 从 storage 异步加载覆盖
let __trendCatFilter = "";

const TREND_CATS = [
  { key: "ads",        label: "广告", color: "#FD3638" },
  { key: "tracking",   label: "追踪", color: "#A78BFA" },
  { key: "annoyances", label: "干扰", color: "#F79009" },
  { key: "url_clean",  label: "URL",  color: "#00AEF0" },
  { key: "malware",    label: "恶意", color: "#7F1D1D" }
];

// 平滑曲线：Catmull-Rom → 贝塞尔
function smoothPath(points) {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return "M " + points[0].x + " " + points[0].y + " L " + points[1].x + " " + points[1].y;
  }
  let d = "M " + points[0].x + " " + points[0].y;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += " C " + cp1x + " " + cp1y + ", " + cp2x + " " + cp2y + ", " + p2.x + " " + p2.y;
  }
  return d;
}

// 平滑面积路径（曲线 + 闭合到底部）
function smoothAreaPath(points, baseY) {
  if (points.length < 2) return "";
  const linePath = smoothPath(points);
  return linePath + " L " + points[points.length - 1].x + " " + baseY +
         " L " + points[0].x + " " + baseY + " Z";
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function renderTrend(stats) {
  const svg = $("#trendSvg");
  if (!svg) return;

  const isHourly = __trendRange === 1;
  const isMonthly = __trendRange === 365;
  const byDate = stats.byDate || {};
  const byHour = stats.byHour || {};

  const emptyData = () => ({ ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 });
  const buckets = [];

  if (isHourly) {
    // 当天 00:00 ~ 23:00（自然顺序）
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    for (let h = 0; h < 24; h++) {
      const d = new Date(today);
      d.setHours(h);
      const key = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(h);
      const raw = byHour[key];
      const data = raw || emptyData();
      const total = TREND_CATS.reduce((s, c) => s + (data[c.key] || 0), 0);
      buckets.push({ key, data, date: d, total, label: pad(h) + ":00" });
    }
  } else if (isMonthly) {
    // 月度视图：过去 12 个月，每月聚合
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");

    for (let m = 11; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const year = d.getFullYear();
      const month = d.getMonth();   // 0-11
      const prefix = year + "-" + pad(month + 1) + "-";

      // 汇总该月所有 byDate 记录
      const data = emptyData();
      for (const [key, val] of Object.entries(byDate)) {
        if (!key.startsWith(prefix)) continue;
        if (!val || typeof val !== "object") continue;
        for (const c of TREND_CATS) {
          data[c.key] += val[c.key] || 0;
        }
      }
      const total = TREND_CATS.reduce((s, c) => s + (data[c.key] || 0), 0);
      buckets.push({
        key: year + "-" + pad(month + 1),
        data,
        date: d,
        total,
        label: (month + 1) + "月"
      });
    }
  } else {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    for (let i = __trendRange - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      const raw = byDate[key];
      let data;
      if (!raw) data = emptyData();
      else if (typeof raw === "number") data = { ads: raw, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 };
      else data = raw;
      const total = TREND_CATS.reduce((s, c) => s + (data[c.key] || 0), 0);
      buckets.push({ key, data, date: d, total, label: pad(d.getMonth() + 1) + "-" + pad(d.getDate()) });
    }
  }

  const days = buckets;

  // 始终显示所有分类（不再过滤）
  const activeCats = TREND_CATS.filter(c => days.some(d => (d.data[c.key] || 0) > 0));
  if (activeCats.length === 0) activeCats.push(TREND_CATS[0]);

  // 最大值（用单分类最大，避免小分类看不清）
  const maxVal = Math.max(1, ...days.flatMap(d => activeCats.map(c => d.data[c.key] || 0)));

  // 动态获取 SVG 实际像素尺寸（避免 viewBox 拉伸导致文字变形）
  const rect = svg.getBoundingClientRect();
  const W = Math.max(400, Math.round(rect.width) || 600);
  const H = Math.max(150, Math.round(rect.height) || 220);
  // 同步 viewBox（让 1 单位 = 1 像素）
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.removeAttribute("preserveAspectRatio");   // 恢复默认 xMidYMid meet
  const PAD_L = 10, PAD_R = 10, PAD_T = 26, PAD_B = 32;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const n = days.length;

  svg.innerHTML = "";

  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + (chartH / 4) * i;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "grid-line");
    line.setAttribute("x1", PAD_L);
    line.setAttribute("y1", y);
    line.setAttribute("x2", W - PAD_R);
    line.setAttribute("y2", y);
    svg.appendChild(line);
  }

  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  if (grandTotal === 0) {
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "text");
    empty.setAttribute("class", "axis-label");
    empty.setAttribute("x", W / 2);
    empty.setAttribute("y", H / 2);
    empty.setAttribute("text-anchor", "middle");
    empty.setAttribute("style", "font-size:12px");
    empty.textContent = "暂无数据（访问有广告的页面后将开始记录）";
    svg.appendChild(empty);
    $("#trendSeries").innerHTML = "";
    return;
  }

  // 并排布局：每天一组，组内按分类并排
  const slotW = chartW / n;
  const innerPad = slotW * 0.28;              // 槽内两侧留白更多（更窄的柱区）
  const barAreaW = slotW - innerPad * 2;
  const catsPerDay = activeCats.length;
  const catGap = catsPerDay > 1 ? 2 : 0;      // 并排柱之间的间隙
  const barW = Math.min(38, (barAreaW - catGap * (catsPerDay - 1)) / catsPerDay);

  // 每根柱子顶部显示数值：柱子宽度足够才显示（避免挤成一团）
  const showBarValue = barW >= 10;

  days.forEach((d, i) => {
    const slotX = PAD_L + slotW * i;

    // 该天有数据的分类（紧凑排列，不留空位）
    const dayCats = activeCats.filter(c => (d.data[c.key] || 0) > 0);
    if (dayCats.length === 0) return;

    // 该组总宽 = 柱宽 × 该天分类数 + 间隙，居中于槽内
    const groupW = barW * dayCats.length + catGap * (dayCats.length - 1);
    const groupStartX = slotX + (slotW - groupW) / 2;

    dayCats.forEach((c, ci) => {
      const v = d.data[c.key] || 0;
      const barH = (v / maxVal) * chartH;
      const x = groupStartX + ci * (barW + catGap);
      const y = PAD_T + chartH - barH;

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", Math.max(1, barW));
      rect.setAttribute("height", Math.max(1, barH));
      rect.setAttribute("fill", c.color);

      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = d.key + " " + c.label + "：" + v + " 条";
      rect.appendChild(title);
      svg.appendChild(rect);

      // 柱子顶部数值标签
      if (showBarValue) {
        const valText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        valText.setAttribute("x", x + barW / 2);
        valText.setAttribute("y", y - 3);
        valText.setAttribute("text-anchor", "middle");
        valText.setAttribute("fill", c.color);
        valText.setAttribute("style", "font-size:9px;font-weight:700;font-family:inherit");
        valText.textContent = v;
        svg.appendChild(valText);
      }
    });
  });

  // X 轴标签：天视图最多显示 15 个（7 天全显示），小时视图最多 8 个
  const maxLabels = isHourly ? 24 : (isMonthly ? 12 : 15);
  const labelStep = Math.max(1, Math.ceil(n / maxLabels));
  for (let i = 0; i < n; i++) {
    if (i % labelStep !== 0 && i !== n - 1) continue;
    const cx = PAD_L + slotW * i + slotW / 2;
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "axis-label");
    label.setAttribute("x", cx);
    label.setAttribute("y", H - 10);
    label.setAttribute("text-anchor", "middle");
    label.textContent = days[i].label;
    svg.appendChild(label);
  }

  // 底部图例
  const series = $("#trendSeries");
  if (series) {
    series.innerHTML = "";
    const totalAll = activeCats.reduce((s, c) => s + days.reduce((s2, d) => s2 + (d.data[c.key] || 0), 0), 0);
    for (const c of activeCats) {
      const sum = days.reduce((s, d) => s + (d.data[c.key] || 0), 0);
      if (sum === 0) continue;
      const pct = totalAll > 0 ? (sum / totalAll * 100).toFixed(1) : "0.0";
      const item = document.createElement("div");
      item.className = "ts-item";
      item.innerHTML = "<span class='ts-dot' style='background:" + c.color + "'></span>" +
                       c.label + " <span class='ts-count'>" + sum + "</span>" +
                       " <span class='ts-pct'>" + pct + "%</span>";
      series.appendChild(item);
    }
  }
}

// ============ 趋势图 UI 偏好（持久化到 storage） ============
const TREND_PREF_KEY = "adshield_trend_pref";

async function loadTrendPref() {
  const store = await chrome.storage.local.get(TREND_PREF_KEY);
  const pref = store[TREND_PREF_KEY] || {};
  __trendRange = pref.range || 7;
  __trendCatFilter = pref.cat || "";
}

async function saveTrendPref() {
  await chrome.storage.local.set({
    [TREND_PREF_KEY]: { range: __trendRange, cat: __trendCatFilter }
  });
}

// 时间范围
const rangeSelect = $("#rangeSelect");
if (rangeSelect) {
  rangeSelect.value = String(__trendRange);
  rangeSelect.addEventListener("change", async () => {
    __trendRange = parseInt(rangeSelect.value, 10) || 7;
    await saveTrendPref();
    renderReport();   // 重渲染整个报告（趋势图 + 分类分布）
  });
}

// （分类下拉已移除）


/* ---------- 自定义规则 ---------- */
async function loadUserRules() {
  const store = await chrome.storage.local.get("adshield_user_rules");
  const el = $("#rulesInput");
  if (el) el.value = (store.adshield_user_rules || []).join("\n");
}

/* ---------- 元素隐藏规则渲染 ---------- */
async function renderCosmeticRules() {
  const store = await chrome.storage.local.get("adshield_user_cosmetic");
  const rules = store.adshield_user_cosmetic || [];
  const listEl = $("#cosmeticRulesList");
  const emptyEl = $("#cosmeticRulesEmpty");
  const countEl = $("#cosmeticCount");
  if (!listEl || !emptyEl) return;

  if (countEl) countEl.textContent = rules.length;
  listEl.innerHTML = "";
  if (!rules.length) {
    emptyEl.style.display = "block";
    listEl.style.display = "none";
    return;
  }
  emptyEl.style.display = "none";
  listEl.style.display = "flex";

  rules.forEach((raw, idx) => {
    if (typeof raw !== "string") return;
    const li = document.createElement("li");
    li.className = "cosmetic-item";

    const idx2 = raw.indexOf("##");
    const domainsPart = idx2 >= 0 ? raw.slice(0, idx2).trim() : "";
    const selector = idx2 >= 0 ? raw.slice(idx2 + 2).trim() : raw;

    const domainHtml = !domainsPart
      ? '<span class="cosmetic-global">全局</span>'
      : '<span class="cosmetic-domain">' + escapeHtml(domainsPart) + '</span>';

    li.innerHTML =
      '<div class="cosmetic-item-text">' +
        domainHtml +
        '<span class="cosmetic-selector">##' + escapeHtml(selector) + '</span>' +
      '</div>' +
      '<button class="cosmetic-remove" data-idx="' + idx + '">删除</button>';

    li.querySelector(".cosmetic-remove").addEventListener("click", async () => {
      const cur = await chrome.storage.local.get("adshield_user_cosmetic");
      const arr = cur.adshield_user_cosmetic || [];
      arr.splice(idx, 1);
      await chrome.storage.local.set({ "adshield_user_cosmetic": arr });
      const store2 = await chrome.storage.local.get("adshield_user_rules");
      const userRules = (store2.adshield_user_rules || []).filter(r => r !== raw);
      await chrome.storage.local.set({ "adshield_user_rules": userRules });
      await chrome.runtime.sendMessage({ type: "saveUserRules", rules: userRules });
      await renderCosmeticRules();
      await loadUserRules();
    });

    listEl.appendChild(li);
  });
}

/* ---------- 自定义规则保存 / 清空 ---------- */
const saveBtn = $("#saveBtn");
if (saveBtn) {
  saveBtn.addEventListener("click", async () => {
    const lines = ($("#rulesInput").value || "").split("\n").map(l => l.trim()).filter(Boolean);
    await chrome.storage.local.set({ "adshield_user_rules": lines });
    const resp = await chrome.runtime.sendMessage({ type: "saveUserRules", rules: lines });
    const st = $("#status");
    const r = (resp && resp.result) || {};
    let msg = "已应用 " + (r.applied || 0) + " 条";
    if (r.cosmetic) msg += "，元素隐藏 " + r.cosmetic + " 条";
    if (r.skipped && r.skipped.length) msg += "，跳过 " + r.skipped.length + " 条";
    if (st) {
      st.textContent = msg + " ✓";
      setTimeout(() => { st.textContent = ""; }, 3500);
    }
    await renderCosmeticRules();
  });
}

const clearBtn2 = $("#clearBtn");
if (clearBtn2) {
  clearBtn2.addEventListener("click", () => {
    const el = $("#rulesInput");
    if (el) el.value = "";
  });
}

/* ---------- 主渲染 ---------- */
async function render() {
  const s = await readSettings();
  const paused = s.globalPausedUntil && s.globalPausedUntil > Date.now();

  // 主题分段按钮
  updateThemeSegUI(s.theme || "auto");

  // 基础状态
  const swMap = {
    "#swGlobal": s.enabled,
    "#swAntiDetect": s.antiDetect !== false,
    "#swAssist": s.assist !== false,
    "#swBadge": s.showBadge !== false
  };
  for (const [sel, val] of Object.entries(swMap)) {
    const el = $(sel);
    if (el) el.checked = val;
  }

  // 暂停时禁用其它开关（变灰）
  const disabledSelectors = ["#swGlobal", "#swAntiDetect", "#swAssist", "#swBadge"];
  for (const sel of disabledSelectors) {
    const el = $(sel);
    if (el) el.disabled = !!paused;
  }
  // 规则集开关（如果有）
  renderRulesets(s);

  // 暂停开关
  const swPause = $("#swGlobalPause");
  if (swPause) swPause.checked = !!paused;
  const pauseSub = $("#globalPauseSub");
  if (pauseSub) {
    if (paused) {
      const hrs = Math.ceil((s.globalPausedUntil - Date.now()) / 3600000);
      pauseSub.textContent = `已暂停，${hrs} 小时后自动恢复`;
    } else {
      pauseSub.textContent = "暂停全局保护，1 天后自动恢复";
    }
  }

  renderSites();
  renderTrackers();
  renderReport();
  loadUserRules();
  loadSubscriptions();
  renderCosmeticRules();
}

/* ---------- 开关事件 ---------- */
const toggles = [
  ["#swGlobal",      "enabled",     true],
  ["#swAntiDetect",  "antiDetect",  true],
  ["#swAssist",      "assist",      true],
  ["#swBadge",       "showBadge",   true]
];
for (const [sel, key] of toggles) {
  $(sel).addEventListener("change", async (e) => {
    const s = await readSettings();
    s[key] = e.target.checked;
    await writeSettings(s);
    if (key === "enabled") render();
  });
}

$("#swGlobalPause").addEventListener("change", async (e) => {
  const s = await readSettings();
  if (e.target.checked) {
    s.globalPausedUntil = Date.now() + 24 * 3600 * 1000;
    s.enabled = false;
  } else {
    s.globalPausedUntil = 0;
    s.enabled = true;
  }
  await writeSettings(s);
  render();
});

/* ---------- 主题切换 ---------- */
function updateThemeSegUI(theme) {
  const seg = $("#themeSegmented");
  if (!seg) return;
  seg.querySelectorAll(".theme-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-theme-value") === theme);
  });
}
const themeSeg = $("#themeSegmented");
if (themeSeg) {
  themeSeg.querySelectorAll(".theme-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const theme = btn.getAttribute("data-theme-value");
      const s = await readSettings();
      s.theme = theme;
      await writeSettings(s);
      if (window.__adshield_theme__) {
        window.__adshield_theme__.apply(theme);
      }
      updateThemeSegUI(theme);
    });
  });
}

/* ---------- 规则订阅管理 ---------- */
function fmtTime(ts) {
  if (!ts) return "从未更新";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false });
    });
  });
}

// ===== SW 保活（防止 MV3 冷启动延迟） =====
// 页面打开时立即 ping 唤醒 SW，之后每 20 秒 ping 一次
(function keepServiceWorkerAlive() {
  let pingTimer = 0;
  const ping = () => {
    try {
      chrome.runtime.sendMessage({ type: "ping" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  };
  const start = () => {
    if (pingTimer) return;
    ping();
    pingTimer = setInterval(ping, 20000);
  };
  const stop = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = 0; }
  };
  start();
  // 页面隐藏时暂停 ping（省电）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") start();
    else stop();
  });
  // 页面关闭时清理（钉住页面/长时间打开的兜底）
  window.addEventListener("pagehide", stop, { once: true });
})();

// ===== 订阅并发管理（多个订阅可同时拉取，全部完成后统一刷新 UI） =====
let __activeSubRequests = 0;

// 带重试的消息发送（防 MV3 SW 消息丢失）
async function sendMessageWithRetry(type, payload, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await sendMessage(type, payload);
      if (resp && (resp.ok !== undefined || resp.results !== undefined)) {
        return resp;
      }
    } catch (e) {
      // 继续重试
    }
    await new Promise(r => setTimeout(r, 150 * (i + 1)));
  }
  return { ok: false, error: "请求失败（已重试 " + maxRetries + " 次）" };
}

// 提交单个订阅（立即显示拉取中，后端串行处理）
function queueSubscribe(url, name, btn) {
  // 关键：点击瞬间立即同步更新 UI（在任何 await 之前）
  __activeSubRequests++;
  btn.disabled = true;
  btn.textContent = "拉取中...";
  // 强制回流（确保 UI 立即刷新，避免等待微任务）
  void btn.offsetHeight;

  return (async () => {
  let result;
  try {
    const resp = await sendMessageWithRetry("saveSubscription", {
      subscription: { url }
    });
    if (resp && resp.ok && resp.result) {
      result = resp.result;
    } else if (resp && resp.ok) {
      result = { ok: true };
    } else {
      result = { ok: false, error: (resp && resp.error) || "未知错误" };
    }
  } catch (e) {
    result = { ok: false, error: String(e) };
  } finally {
    __activeSubRequests--;
    // 只有所有请求完成才刷新列表（避免中间态被覆盖）
    if (__activeSubRequests === 0) {
      setTimeout(() => loadSubscriptions(), 50);
    }
  }
  return result;
  })();
}

// 订阅数据缓存
let __subsCache = null;
let __subsCacheTs = 0;
const SUBS_CACHE_TTL = 1500;   // 1.5 秒内复用缓存

async function loadSubscriptions(opts) {
  opts = opts || {};
  const force = !!opts.force;

  // 缓存命中：直接渲染（除非强制刷新）
  if (!force && __subsCache && Date.now() - __subsCacheTs < SUBS_CACHE_TTL) {
    renderSubsList(__subsCache.subs, __subsCache.interval, __subsCache.lastCheck);
    return;
  }

  const resp = await sendMessage("getSubscriptions");
  if (!resp.ok) return;
  const subs = resp.subscriptions || [];
  const interval = resp.interval || 24;
  const lastCheck = resp.lastCheck || 0;

  // 更新缓存
  __subsCache = { subs, interval, lastCheck };
  __subsCacheTs = Date.now();

  renderSubsList(subs, interval, lastCheck);
}

function renderSubsList(subs, interval, lastCheck) {
  // 空状态切换
  const emptyEl = $("#subEmptyState");
  if (emptyEl) emptyEl.style.display = (subs.length === 0) ? "block" : "none";

  // 有更新横幅
  const banner = $("#subUpdateBanner");
  if (banner) {
    const updated = subs.filter(s => s.hasUpdate);
    if (updated.length > 0) {
      banner.style.display = "flex";
      const titleEl = $("#subUpdateBannerTitle");
      const descEl = $("#subUpdateBannerDesc");
      if (titleEl) titleEl.textContent = updated.length + " 个订阅源有更新";
      if (descEl) descEl.textContent = "点击「立即更新」应用最新规则";
    } else {
      banner.style.display = "none";
    }
  }

  // 同步按钮状态（如果当前是 idle 且有更新，切到 ready）
  if (__btnState === "idle") {
    const cnt = subs.filter(s => s.hasUpdate).length;
    if (cnt > 0) setBtnState("ready", cnt);
  }

  // 更新间隔下拉
  const sel = $("#subIntervalSelect");
  if (sel) sel.value = String(interval);

  // 上次检查时间
  const lc = $("#subLastCheck");
  if (lc) lc.textContent = lastCheck ? ("上次检查：" + fmtTime(lastCheck)) : "";

  // 渲染列表
  const ul = $("#subList");
  if (!ul) return;
  ul.innerHTML = "";

  // 已订阅的 URL 集合
  const subscribedUrls = new Set(subs.map(s => s.url));

  // ===== 1) 已订阅列表 =====
  for (const sub of subs) {
    const li = document.createElement("li");
    li.className = "sub-item sub-item-subscribed";

    // 推荐源显示友好名称，自定义源显示 URL
    let displayName = sub.url || "";
    for (const [k, p] of Object.entries(PRESET_SUBS)) {
      if (p.url === sub.url) { displayName = p.name; break; }
    }

    let status;
    if (sub.lastError) {
      status = "<span class='sub-status err'>错误</span>";
    } else if (sub.lastUpdate) {
      const parts = [];
      if (sub.lastDomains) parts.push("域名 " + sub.lastDomains);
      if (sub.lastPaths) parts.push("路径 " + sub.lastPaths);
      if (sub.lastExceptions) parts.push("例外 " + sub.lastExceptions);
      const detail = parts.length ? " · " + parts.join(" / ") : "";
      status = "<span class='sub-status ok'>" + (sub.lastCount || 0) + " 条</span>" + detail;
    } else {
      status = "<span class='sub-status'>未更新</span>";
    }

    // 有更新徽章
    const updateBadge = sub.hasUpdate ? "<span class='sub-badge sub-badge-new'>🆕 有更新</span>" : "";

    li.innerHTML =
      "<div class='item-main'>" +
        "<div class='item-title-row'>" +
          "<span class='sub-badge sub-badge-on'>已订阅</span>" +
          updateBadge +
          "<span class='item-title' title='" + escapeHtml(sub.url || "") + "'>" + escapeHtml(displayName) + "</span>" +
        "</div>" +
        "<div class='item-meta'>" +
          status + " · " + fmtTime(sub.lastUpdate) +
          (sub.lastError ? " · <span style='color:#b91c1c'>" + escapeHtml(sub.lastError) + "</span>" : "") +
        "</div>" +
      "</div>" +
      "<div style='display:flex;gap:4px'>" +
        "<button class='item-action primary' data-update='" + sub.id + "'>更新</button>" +
        "<button class='item-action' data-remove='" + sub.id + "'>删除</button>" +
      "</div>";

    // 有更新时：加边框高亮
    if (sub.hasUpdate) li.classList.add("sub-item-has-update");
    // 更新按钮
    li.querySelector("[data-update]").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const origText = btn.textContent;
      btn.textContent = "更新中...";
      btn.disabled = true;
      try {
        await sendMessage("saveSubscription", { subscription: { id: sub.id, url: sub.url, enabled: sub.enabled } });
        // 清除该订阅的"有更新"标记
        if (sub.hasUpdate) {
          await sendMessage("clearSubscriptionUpdateFlag", { id: sub.id });
        }
        await loadSubscriptions({ force: true });
      } catch (err) {
        btn.textContent = origText;
        btn.disabled = false;
      }
    });
    // 删除按钮
    li.querySelector("[data-remove]").addEventListener("click", async () => {
      const ok = await showConfirm("确定删除此订阅？", {
        title: "删除订阅",
        confirmText: "删除",
        type: "danger"
      });
      if (!ok) return;
      await sendMessage("removeSubscription", { id: sub.id });
      await loadSubscriptions({ force: true });
    });
    ul.appendChild(li);
  }

  // ===== 2) 推荐源（未订阅的） =====
  let presetShown = 0;
  for (const [key, preset] of Object.entries(PRESET_SUBS)) {
    if (subscribedUrls.has(preset.url)) continue;   // 已订阅的跳过
    presetShown++;
    const li = document.createElement("li");
    li.className = "sub-item sub-item-preset";
    li.innerHTML =
      "<div class='item-main'>" +
        "<div class='item-title-row'>" +
          "<span class='sub-badge sub-badge-rec'>推荐</span>" +
          "<span class='item-title'>" + escapeHtml(preset.name) + "</span>" +
        "</div>" +
        "<div class='item-meta'>" + escapeHtml(preset.desc || "来自 " + new URL(preset.url).hostname) + "</div>" +
      "</div>" +
      "<div style='display:flex;gap:4px'>" +
        "<button class='item-action primary' data-preset-add='" + key + "'>+ 订阅</button>" +
      "</div>";
    li.querySelector("[data-preset-add]").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const hint = $("#subHint");
      hint.textContent = "正在拉取并验证（可能需几秒）...";
      hint.className = "hint";

      // 并发提交（立即显示拉取中，后端串行处理）
      const result = await queueSubscribe(preset.url, preset.name, btn);
      if (result && result.ok) {
        const parts = [];
        if (result.domains) parts.push("域名 " + result.domains);
        if (result.exceptions) parts.push("例外 " + result.exceptions);
        if (result.paths) parts.push("路径 " + result.paths);
        const detail = parts.length ? "（" + parts.join(" / ") + "）" : "";
        hint.textContent = "✅ " + preset.name + " 已应用 " + (result.count || 0) + " 条 DNR 规则" + detail;
        hint.className = "hint ok";
        setTimeout(() => { hint.textContent = ""; }, 6000);
      } else {
        const err = (result && result.error) || "未知错误";
        hint.textContent = "❌ " + preset.name + " 添加失败：" + err;
        hint.className = "hint err";
        setTimeout(() => { hint.textContent = ""; }, 6000);
        btn.disabled = false;
        btn.textContent = "+ 订阅";
      }
    });
    ul.appendChild(li);
  }

  // 空状态
  if (subs.length === 0 && presetShown === 0) {
    ul.innerHTML = "<li class='sub-item' style='text-align:center;color:var(--text-tertiary);padding:16px 0'>暂无订阅</li>";
  }
}

// 添加订阅
const subAddBtn = $("#subAddBtn");
if (subAddBtn) {
  subAddBtn.addEventListener("click", async () => {
    const url = ($("#subUrlInput").value || "").trim();
    const hint = $("#subHint");
    if (!url) { hint.textContent = "请输入 URL"; hint.className = "hint err"; setTimeout(() => { hint.textContent = ""; }, 3000); return; }
    if (!/^https?:\/\//.test(url)) { hint.textContent = "URL 必须以 http(s):// 开头"; hint.className = "hint err"; setTimeout(() => { hint.textContent = ""; }, 3000); return; }
    hint.textContent = "正在拉取并验证...";
    hint.className = "hint";
    const resp = await sendMessage("saveSubscription", { subscription: { url } });
    if (resp.ok && resp.result && resp.result.ok) {
      // 成功
      const result = resp.result;
      const parts = [];
      if (result.domains) parts.push("域名 " + result.domains);
      if (result.exceptions) parts.push("例外 " + result.exceptions);
      if (result.paths) parts.push("路径 " + result.paths);
      const detail = parts.length ? "（" + parts.join(" / ") + "）" : "";
      hint.textContent = "✅ 已应用 " + (result.count || 0) + " 条 DNR 规则" + detail;
      hint.className = "hint ok";
      $("#subUrlInput").value = "";
      setTimeout(() => { hint.textContent = ""; }, 5000);
      await loadSubscriptions({ force: true });
    } else {
      // 失败：不保存
      const err = (resp && resp.error) || (resp && resp.result && resp.result.error) || "未知错误";
      hint.textContent = "❌ 添加失败：" + err;
      hint.className = "hint err";
      setTimeout(() => { hint.textContent = ""; }, 6000);
      await loadSubscriptions({ force: true });
    }
  });
}

// 预置订阅
const PRESET_SUBS = {
  "easylist-cn":    { url: "https://easylist-downloads.adblockplus.org/easylistchina.txt", name: "EasyList China", desc: "网站广告规则 · 约 18000 条" },
  "cjx-annoyance":  { url: "https://raw.githubusercontent.com/cjx82630/cjxlist/master/cjx-annoyance.txt", name: "CJX Annoyance", desc: "扰民元素过滤 · 约 1800 条" },
  "adguard-cn":     { url: "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_224_Chinese/filter.txt", name: "AdGuard CN", desc: "AdGuard 官方中文规则 · 约 21000 条" },
  "easyprivacy":    { url: "https://easylist.to/easylist/easyprivacy.txt", name: "EasyPrivacy", desc: "全球追踪器规则 · 约 56000 条" },
  "adrules-lite":   { url: "https://bitbucket.org/hacamer/adrules/raw/main/adblock_lite.txt", name: "AdRules 精简版", desc: "中国地区广告屏蔽 · 3w+ 条 · 移动优化" }
};

/* ============ 有更新提示横幅 ============ */
const bannerBtn = $("#subUpdateBannerBtn");
if (bannerBtn) {
  bannerBtn.addEventListener("click", async () => {
    // 触发"立即更新全部"按钮
    const ub = $("#subUpdateAllBtn");
    if (ub) ub.click();
  });
}
const bannerDismiss = $("#subUpdateBannerDismiss");
if (bannerDismiss) {
  bannerDismiss.addEventListener("click", async () => {
    // 忽略：清除所有 hasUpdate 标记
    await sendMessage("clearSubscriptionUpdateFlag");
    await loadSubscriptions({ force: true });
  });
}

/* ============ 检查 / 更新按钮（3 态） ============ */
const updateAllBtn = $("#subUpdateAllBtn");
let __btnState = "idle";   // idle | checking | updating | uptodate | ready
let __pendingUpdateCount = 0;

function setBtnState(state, extra) {
  if (!updateAllBtn) return;
  __btnState = state;
  updateAllBtn.classList.remove("loading", "ready");

  switch (state) {
    case "idle":
      updateAllBtn.textContent = "检查更新";
      updateAllBtn.disabled = false;
      break;
    case "checking":
      updateAllBtn.classList.add("loading");
      updateAllBtn.textContent = "检查中...";
      updateAllBtn.disabled = true;
      break;
    case "uptodate":
      updateAllBtn.textContent = "✓ 已是最新";
      updateAllBtn.disabled = true;
      setTimeout(() => { if (__btnState === "uptodate") setBtnState("idle"); }, 2500);
      break;
    case "ready":
      __pendingUpdateCount = extra || 0;
      updateAllBtn.classList.add("ready");
      updateAllBtn.textContent = "立即更新（" + __pendingUpdateCount + "）";
      updateAllBtn.disabled = false;
      break;
    case "updating":
      updateAllBtn.classList.add("loading");
      updateAllBtn.textContent = "更新中...";
      updateAllBtn.disabled = true;
      break;
  }
}

async function doCheck() {
  setBtnState("checking");
  const hint = $("#subHint");
  try {
    const resp = await sendMessage("checkSubscriptionUpdates");
    const changed = (resp && resp.changed) || 0;
    if (changed > 0) {
      if (hint) {
        hint.textContent = "🔔 发现 " + changed + " 个订阅源有更新";
        hint.className = "hint ok";
        setTimeout(() => { hint.textContent = ""; }, 4000);
      }
      setBtnState("ready", changed);
    } else {
      setBtnState("uptodate");
    }
  } catch (e) {
    if (hint) {
      hint.textContent = "❌ 检查失败：" + (e.message || e);
      hint.className = "hint err";
      setTimeout(() => { hint.textContent = ""; }, 4000);
    }
    setBtnState("idle");
  }
}

async function doUpdateAll() {
  setBtnState("updating");
  const hint = $("#subHint");
  try {
    const resp = await sendMessage("updateAllSubscriptions");
    const result = (resp && resp.result) || {};
    if (hint) {
      if (result.fail > 0) {
        hint.textContent = "✅ 成功 " + (result.ok || 0) + " · ❌ 失败 " + result.fail + " · 共 " + (result.rules || 0) + " 条规则";
        hint.className = "hint err";
      } else {
        hint.textContent = "✅ 全部更新成功 · " + (result.rules || 0) + " 条规则";
        hint.className = "hint ok";
      }
      setTimeout(() => { hint.textContent = ""; }, 5000);
    }
    // 更新完成 → 重置为「已是最新」
    await loadSubscriptions({ force: true });
    setBtnState("uptodate");
  } catch (e) {
    if (hint) {
      hint.textContent = "❌ 更新失败：" + (e.message || e);
      hint.className = "hint err";
      setTimeout(() => { hint.textContent = ""; }, 5000);
    }
    setBtnState("idle");
  }
}

if (updateAllBtn) {
  updateAllBtn.addEventListener("click", () => {
    if (__btnState === "checking" || __btnState === "updating") return;
    if (__btnState === "ready") {
      doUpdateAll();
    } else {
      doCheck();
    }
  });
  // 初始化
  setBtnState("idle");
}

/* ============ 恢复默认订阅按钮 ============ */
const restoreBtn = $("#restoreDefaultsBtn");
if (restoreBtn) {
  restoreBtn.addEventListener("click", async () => {
    restoreBtn.disabled = true;
    restoreBtn.textContent = "拉取中...";
    try {
      const resp = await sendMessage("restoreDefaultSubscriptions");
      if (resp && resp.ok) {
        if (resp.added > 0) {
          await loadSubscriptions({ force: true });
        } else {
          restoreBtn.textContent = resp.message || "已存在";
          setTimeout(() => {
            restoreBtn.disabled = false;
            restoreBtn.textContent = "恢复推荐订阅（4 个）";
          }, 2000);
        }
      } else {
        restoreBtn.textContent = "失败：" + ((resp && resp.error) || "未知错误");
        setTimeout(() => {
          restoreBtn.disabled = false;
          restoreBtn.textContent = "恢复推荐订阅（4 个）";
        }, 3000);
      }
    } catch (e) {
      restoreBtn.textContent = "失败：" + e.message;
      setTimeout(() => {
        restoreBtn.disabled = false;
        restoreBtn.textContent = "恢复推荐订阅（4 个）";
      }, 3000);
    }
  });
}

/* ============ 初始化 ============ */
// 绑定分规则集开关事件（只绑一次）
initRulesetToggles();
// 首次渲染
render();

// 侧栏 hash 变化监听
window.addEventListener("hashchange", () => {
  const { tab } = parseHash();
  document.documentElement.setAttribute("data-route", tab);
  const item = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (item) item.click();
  if (tab === "rules") autoCheckSubscriptions();
});
