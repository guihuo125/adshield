const STATS_KEY = "adshield_stats";
const MAX_ROWS = 2000;
const $ = (s) => document.querySelector(s);
let allLogs = [];

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

const SAFE_CATS = { ads: 1, tracking: 1, annoyances: 1, url_clean: 1, malware: 1 };

// HTML 转义与文件下载统一走 shared/dom.js
const { escapeHtml, downloadJson, downloadCsv } = window.adshieldDom;
const { MSG } = window.adshieldConfig;

function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

async function load() {
  // 优先向 background 请求实时数据
  let stats = await sendMessage(MSG.GET_STATS);
  if (!stats) {
    const store = await chrome.storage.local.get(STATS_KEY);
    stats = store[STATS_KEY] || {};
  }
  $("#totalCount").textContent = stats.total || 0;
  allLogs = (stats.recentLogs || []).slice().reverse();
  $("#logCount").textContent = allLogs.length;
  const note = $("#statsNote");
  // 判定统一为「只有明确拿到 live === true 才隐藏」，与 popup/options 保持一致
  if (note) note.hidden = stats.live === true;
  render();
}

// 每 2 秒自动刷新（页面可见时）
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  load();
}, 2000);

function render() {
  const kw = ($("#filterInput").value || "").trim().toLowerCase();
  const cat = $("#catFilter").value;
  const filtered = allLogs.filter(l => {
    if (cat && l.cat !== cat) return false;
    if (kw) {
      const hay = ((l.url || "") + " " + (l.pageHost || "") + " " + (l.blockedHost || "")).toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const tbody = $("#logBody");
  tbody.innerHTML = "";
  const empty = $("#emptyTip");
  if (!filtered.length) {
    empty.style.display = "block";
    empty.textContent = allLogs.length ? "无匹配日志" : "暂无日志（访问带广告的页面后将自动记录）";
    return;
  }
  empty.style.display = "none";
  for (const l of filtered.slice(0, MAX_ROWS)) {
    const tr = document.createElement("tr");
    const catName = { ads: "广告", tracking: "追踪", annoyances: "干扰", url_clean: "URL", malware: "恶意" }[l.cat] || l.cat || "未知";
    tr.innerHTML = `<td>${fmtTime(l.ts)}</td><td><span class="cat-tag cat-${SAFE_CATS[l.cat] ? l.cat : "ads"}">${catName}</span></td><td>${escapeHtml(l.url || "")}</td><td>${escapeHtml(l.pageHost || "")}</td>`;
    tbody.appendChild(tr);
  }
}

$("#refreshBtn").addEventListener("click", load);
$("#filterInput").addEventListener("input", render);
$("#catFilter").addEventListener("change", render);

// 导出 JSON
$("#exportJsonBtn").addEventListener("click", () => {
  downloadJson(allLogs, `adshield-logs-${fmtDate()}.json`);
});

// 导出 CSV
$("#exportCsvBtn").addEventListener("click", () => {
  if (!allLogs.length) {
    showAlert("暂无日志可导出", { title: "提示", type: "info" });
    return;
  }
  const CAT_LABEL = { ads: "广告", tracking: "追踪", annoyances: "干扰", url_clean: "URL 清理", malware: "恶意" };
  // CSV 转义：双引号包裹 + 内部双引号变两个
  function csvEsc(s) {
    return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  }
  const header = ["时间", "分类", "被拦截 URL", "来源页面"];
  const rows = [header.map(csvEsc).join(",")];
  for (const l of allLogs) {
    rows.push([
      csvEsc(new Date(l.ts).toLocaleString("zh-CN")),
      csvEsc(CAT_LABEL[l.cat] || l.cat || "未知"),
      csvEsc(l.url || ""),
      csvEsc(l.pageHost || "")
    ].join(","));
  }
  // downloadCsv 自带 BOM（\uFEFF），让 Excel 正确识别 UTF-8 中文
  downloadCsv(rows, `adshield-logs-${fmtDate()}.csv`);
});

// 日期格式：YYYY-MM-DD_HHmm
function fmtDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "_" + pad(d.getHours()) + pad(d.getMinutes());
}

$("#clearBtn").addEventListener("click", async () => {
  const ok = await showConfirm("确定清空所有日志？", {
    title: "清空日志",
    confirmText: "清空",
    type: "danger"
  });
  if (!ok) return;
  // 走 background 清：内存缓冲和落盘一起清。
  // 这里若直接写 storage，background 的内存缓冲仍留着旧日志，
  // 下一次 flush 会把它们写回来，用户点了「清空」日志却又冒出来。
  await chrome.runtime.sendMessage({ type: "clearLogs" });
  allLogs = [];
  render();
});

load();
