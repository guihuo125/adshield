const STATS_KEY = "adshield_stats";
const MAX_ROWS = 2000;
const $ = (s) => document.querySelector(s);
let allLogs = [];

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

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
  let stats = await sendMessage("getStats");
  if (!stats) {
    const store = await chrome.storage.local.get(STATS_KEY);
    stats = store[STATS_KEY] || {};
  }
  $("#totalCount").textContent = stats.total || 0;
  allLogs = (stats.recentLogs || []).slice().reverse();
  $("#logCount").textContent = allLogs.length;
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
    tr.innerHTML = `<td>${fmtTime(l.ts)}</td><td><span class="cat-tag cat-${l.cat || "ads"}">${catName}</span></td><td>${escapeHtml(l.url || "")}</td><td>${escapeHtml(l.pageHost || "")}</td>`;
    tbody.appendChild(tr);
  }
}

$("#refreshBtn").addEventListener("click", load);
$("#filterInput").addEventListener("input", render);
$("#catFilter").addEventListener("change", render);

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(allLogs, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "adshield-logs-" + Date.now() + ".json";
  a.click();
  URL.revokeObjectURL(url);
});

$("#clearBtn").addEventListener("click", async () => {
  const ok = await showConfirm("确定清空所有日志？", {
    title: "清空日志",
    confirmText: "清空",
    type: "danger"
  });
  if (!ok) return;
  const store = await chrome.storage.local.get(STATS_KEY);
  const stats = store[STATS_KEY] || {};
  stats.recentLogs = [];
  await chrome.storage.local.set({ [STATS_KEY]: stats });
  allLogs = [];
  render();
});

load();
