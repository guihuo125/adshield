// AdShield 运行时诊断页
//
// 背景（2026-11-01 审查 D5 / .learnings/FEATURE_REQUESTS.md FEAT-20261031-001）：
// 项目里有多条结论卡在「只能靠用户实测」：
//   ① 动态规则上限到底是多少（决定订阅容量问题的严重度）
//   ② 正式安装版能否拿到请求级反馈
//   ③ 当前实际占用了多少动态规则
// 每次都要写「请你打开 DevTools 执行 X 再把输出贴回来」，来回成本全落在用户身上。
//
// 这个页面把三件事一次性采完，用户只需点一下「重新采集」并下载 JSON。
(function () {
  const $ = (s) => document.querySelector(s);

  async function collect() {
    const out = {
      collectedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      extensionVersion: chrome.runtime.getManifest().version,
      dnr: {},
      rulesets: {},
      feedback: {},
      errors: []
    };

    const dnr = chrome.declarativeNetRequest;
    if (!dnr) {
      out.errors.push("当前浏览器没有 chrome.declarativeNetRequest");
      return out;
    }

    // ---- 上限常量（以本机实测为准）----
    // 注意：Chrome 156 上没有 getAvailableConstants()，常量直接挂在 API 对象上。
    // 两种取法都试，取到哪个用哪个。
    try {
      if (typeof dnr.getAvailableConstants === "function") {
        out.dnr.availableConstants = await dnr.getAvailableConstants();
      }
    } catch (e) {
      out.errors.push("getAvailableConstants 失败: " + (e && e.message));
    }
    // 直接读挂在 API 上的 MAX_* 常量（Chrome 156 实测可用）
    const constants = {};
    for (const k of Object.keys(dnr)) {
      if (k.startsWith("MAX_") && typeof dnr[k] === "number") constants[k] = dnr[k];
    }
    out.dnr.constants = constants;
    if (!Object.keys(constants).length && !out.dnr.availableConstants) {
      out.errors.push("既没有 getAvailableConstants()，也没读到 MAX_* 常量 —— 上限未知");
    }

    // 兼容旧 API：直接读常量
    out.dnr.maxNumberOfDynamicRules = dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? null;
    out.dnr.maxNumberOfSessionRules = dnr.MAX_NUMBER_OF_SESSION_RULES ?? null;
    out.dnr.maxNumberOfEnabledStaticRulesets = dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS ?? null;

    // ---- 实际占用的动态规则 ----
    try {
      const dynamic = await dnr.getDynamicRules();
      out.dnr.dynamicRuleCount = dynamic.length;
      // 按 ID 段归类（与 background.js 的段位规划一致）
      const seg = { user: 0, site: 0, subscription: 0, globalAllow: 0, other: 0 };
      for (const r of dynamic) {
        if (r.id >= 100000 && r.id < 110000) seg.user++;
        else if (r.id >= 200000 && r.id < 210000) seg.site++;
        else if (r.id >= 300000 && r.id < 1300000) seg.subscription++;
        else if (r.id === 2000000) seg.globalAllow++;
        else seg.other++;
      }
      out.dnr.dynamicRuleSegments = seg;
    } catch (e) {
      out.errors.push("getDynamicRules 失败: " + (e && e.message));
    }

    // ---- 已启用的静态规则集 ----
    try {
      const enabled = await dnr.getEnabledRulesets();
      out.rulesets.enabled = enabled;
      out.rulesets.enabledCount = enabled.length;
    } catch (e) {
      out.errors.push("getEnabledRulesets 失败: " + (e && e.message));
    }

    // ---- 反馈 API 可用性（决定正式版有没有请求级统计）----
    out.feedback.hasOnRuleMatchedDebug = !!dnr.onRuleMatchedDebug;
    out.feedback.hasGetMatchedRules = typeof dnr.getMatchedRules === "function";
    try {
      const m = await dnr.getMatchedRules();
      out.feedback.getMatchedRulesWorks = true;
      out.feedback.matchedRuleCount = (m && m.rulesMatchedInfo || []).length;
    } catch (e) {
      out.feedback.getMatchedRulesWorks = false;
      out.feedback.getMatchedRulesError = (e && e.message) || String(e);
    }

    // ---- 本扩展的设置快照 ----
    try {
      const store = await chrome.storage.local.get("adshield_settings");
      const s = store.adshield_settings || {};
      out.settings = {
        enabled: s.enabled,
        rulesets: s.rulesets,
        subscriptionCount: (s.subscriptions || []).length,
        disabledSiteCount: (s.disabledSites || []).length
      };
    } catch (e) {
      out.errors.push("读取设置失败: " + (e && e.message));
    }

    return out;
  }

  let lastData = null;

  async function run() {
    const status = $("#status");
    const out = $("#out");
    status.textContent = "正在采集…";
    out.textContent = "";
    try {
      lastData = await collect();
      status.textContent = "采集完成 · " + new Date().toLocaleString("zh-CN");
      out.textContent = JSON.stringify(lastData, null, 2);
    } catch (e) {
      status.textContent = "采集失败：" + (e && e.message);
      out.textContent = String(e && e.stack || e);
    }
  }

  $("#runBtn").addEventListener("click", run);

  $("#copyBtn").addEventListener("click", async () => {
    if (!lastData) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastData, null, 2));
      $("#status").textContent = "已复制到剪贴板";
    } catch (e) {
      $("#status").textContent = "复制失败（请改用下载）：" + (e && e.message);
    }
  });

  $("#downloadBtn").addEventListener("click", () => {
    if (!lastData) return;
    const blob = new Blob([JSON.stringify(lastData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "adshield-probe-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  run();
})();
