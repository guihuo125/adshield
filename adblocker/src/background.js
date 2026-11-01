// AdShield MV3 service worker
const ALL_RULESETS = ["ads", "tracking", "annoyances", "url_clean", "malware"];
const STATS_KEY = "adshield_stats";
const SETTINGS_KEY = "adshield_settings";

// Chrome 动态规则总上限。实测 Chrome 156 = 30000（chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES）。
// 订阅规则、站点放行规则、用户自定义规则共用这一个池子，不是各自独立的上限。
const MAX_DYNAMIC_RULES =
  (chrome.declarativeNetRequest && chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES) || 30000;

// 内存中的统计缓冲（供 badge 实时读取，避免 storage 写盘延迟）
let __statsBuffer = null;
// 统计可用性标记：onRuleMatchedDebug 只在"开发者模式加载的未打包扩展"中触发，
// 正式安装版该事件永不触发。live 供 popup/logger 判断是否显示降级提示。
let __statsLive = false;
// 用户规则应用防抖定时器（合并短时间内的多次变更）
let __userRulesApplyTimer = 0;

const DEFAULT_SETTINGS = {
  enabled: true,
  disabledSites: [],
  pausedUntil: {},
  globalPausedUntil: 0,
  rulesets: { ads: true, tracking: true, annoyances: true, url_clean: true, malware: true },
  antiDetect: true,
  assist: true,
  showBadge: true,
  theme: "auto",
  notifyOnBlock: false,  // 拦截时是否发系统通知（默认关）
  assistedSites: [],   // 浏览助手触发历史：[{ host, ts, until, reason }]
  // 订阅更新
  subscriptions: [],           // [{ id, name, url, enabled, lastUpdate, lastCount, lastError }]
  subscriptionInterval: 24,    // 自动更新间隔（小时）；0 = 关闭
  lastSubscriptionCheck: 0
};

async function getSettings() {
  const store = await chrome.storage.local.get(SETTINGS_KEY);
  const s = Object.assign({}, DEFAULT_SETTINGS, store[SETTINGS_KEY] || {});
  s.rulesets = Object.assign({}, DEFAULT_SETTINGS.rulesets, s.rulesets || {});
  s.pausedUntil = s.pausedUntil || {};
  s.disabledSites = s.disabledSites || [];
  // 规范化订阅 ID：必须落在 1~99（防御历史脏数据导致 id%100===0 的 ID 段冲突），
  // 而且同一个 ID 只能属于一个订阅 —— DNR 的 ID 段是按 id%100 分的，
  // 两条订阅撞号就会共用同一段规则，后应用的把前一个整段覆盖掉。
  if (Array.isArray(s.subscriptions)) {
    const usedIds = new Set();
    for (const sub of s.subscriptions) {
      const m = ((Number(sub.id) || 0) % 100);
      let id = (m >= 1 && m <= 99) ? m : 0;
      if (!id || usedIds.has(id)) {
        id = 0;
        for (let k = 1; k < 100; k++) { if (!usedIds.has(k)) { id = k; break; } }
      }
      if (!id) continue;   // 1~99 个槽位全占满，跳过这条（本地模式下最多 99 条订阅）
      usedIds.add(id);
      sub.id = id;
    }
  }
  return s;
}

/* ============ 全局暂停 ============ */
// 全局暂停原先只关掉 5 个静态规则集，订阅规则和用户自定义规则（都是动态规则）照旧拦截，
// 用户看到的现象是「暂停了但页面还是被拦坏」。这里补一条高优先级 allow 动态规则，
// 把所有请求放行；恢复时移除。
// ID 选 2000000：躲开用户规则段 100000~110000、站点放行段 200000~210000、
// 订阅段 300000~1300000，也不会被 cleanupOrphanSubscriptions 当成孤儿删掉。
const GLOBAL_ALLOW_RULE_ID = 2000000;
const GLOBAL_ALLOW_PRIORITY = 10000;

async function syncGlobalPauseRule(s) {
  const paused = s.enabled === false;
  const rule = {
    id: GLOBAL_ALLOW_RULE_ID,
    priority: GLOBAL_ALLOW_PRIORITY,
    action: { type: "allow" },
    condition: { urlFilter: "*" }
  };
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const present = existing.some(r => r.id === GLOBAL_ALLOW_RULE_ID);
    if (present === paused) return;   // 状态已经对上了
    if (!paused) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [GLOBAL_ALLOW_RULE_ID],
        addRules: []
      });
      console.log("[AdShield] 全局暂停：已恢复拦截");
      return;
    }
    // 删和加拆成两次调用：不依赖 Chrome 对「同一个 ID 同时出现在 remove 和 add 里」的处理顺序，
    // 也不会因为规则已存在而整批被拒。
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [GLOBAL_ALLOW_RULE_ID],
      addRules: []
    });
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [], addRules: [rule] });
    } catch (e2) {
      // 并发写入时另一路可能已经加好了同一条规则，重复添加会报错；
      // 这时目标状态已经达成，不算失败。
      const cur = await chrome.declarativeNetRequest.getDynamicRules();
      if (!cur.some(r => r.id === GLOBAL_ALLOW_RULE_ID)) throw e2;
    }
    console.log("[AdShield] 全局暂停：已放行全部请求（订阅与自定义规则同时停用）");
  } catch (e) {
    console.warn("[AdShield] 全局暂停规则更新失败", e);
  }
}

/* ============ 规则集同步 ============ */
async function syncRulesets() {
  const s = await getSettings();

  // 全局暂停到期 -> 自动恢复
  if (s.globalPausedUntil && s.globalPausedUntil <= Date.now()) {
    s.globalPausedUntil = 0;
    s.enabled = true;
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  }

  const enable = [];
  const disable = [];
  for (const id of ALL_RULESETS) {
    const on = s.enabled && s.rulesets[id] !== false;
    if (on) enable.push(id);
    else disable.push(id);
  }
  try {
    if (enable.length) await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enable });
    if (disable.length) await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: disable });
    const current = await chrome.declarativeNetRequest.getEnabledRulesets();
    console.log("[AdShield] 规则集同步：已启用 =", current.join(", "), "| 目标 =", enable.join(", "));
  } catch (e) {
    console.warn("[AdShield] 同步规则集失败", e);
  }
  // 静态规则集之外的动态规则（订阅 / 用户自定义）也要跟着全局开关走
  await syncGlobalPauseRule(s);
}

/* ============ 站点暂停 -> 动态 allowAllRequests ============ */
const SITE_RULE_BASE = 200000;

function activePausedSites(s) {
  const now = Date.now();
  const list = new Set(s.disabledSites || []);
  for (const [host, until] of Object.entries(s.pausedUntil || {})) {
    if (until && until > now) list.add(host);
  }
  return Array.from(list);
}

async function syncSiteAllowlist() {
  const s = await getSettings();
  const hosts = activePausedSites(s);

  // 清理过期项
  const now = Date.now();
  let changed = false;
  for (const [host, until] of Object.entries(s.pausedUntil || {})) {
    if (!until || until <= now) {
      delete s.pausedUntil[host];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter(r => r.id >= SITE_RULE_BASE && r.id < SITE_RULE_BASE + 10000)
    .map(r => r.id);

  const addRules = hosts.map((host, i) => ({
    id: SITE_RULE_BASE + i,
    priority: 100,
    action: { type: "allowAllRequests" },
    condition: {
      requestDomains: [host],
      resourceTypes: ["main_frame"]
    }
  }));

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    console.log("[AdShield] 站点放行名单已更新:", hosts);
  } catch (e) {
    console.warn("[AdShield] 站点放行更新失败", e);
  }
}

/* ============ 定时器 ============ */
async function scheduleCleanup() {
  const s = await getSettings();
  const future = Object.values(s.pausedUntil || {}).filter(t => t > Date.now());
  if (s.globalPausedUntil && s.globalPausedUntil > Date.now()) {
    future.push(s.globalPausedUntil);
  }
  if (future.length) {
    const next = Math.min(...future);
    chrome.alarms.create("adshield-pause-expire", { when: next + 500 });
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "adshield-pause-expire") {
    syncSiteAllowlist();
    syncRulesets();
  }
});

/* ============ 命中规则分类 ============ */
// 判断顺序：静态 ruleId 区间 > URL 特征
// 原因：多个规则集优先级相同时，Chrome 可能先命中 ads，导致 tracking 永不被选中
// 分类：
//   ads      — 广告
//   tracking — 第三方追踪器（跨站）
//   annoyances — 干扰内容
//   url_clean  — URL 参数清理
//   malware    — 恶意域名
  // 常见第三方追踪服务（跨站追踪器，明确列表）
const THIRD_PARTY_TRACKERS = [
  "google-analytics.com", "googletagmanager.com", "doubleclick.net",
  "hotjar.com", "amplitude.com", "mixpanel.com", "segment.com", "segment.io",
  "fullstory.com", "heapanalytics.com", "logrocket.io", "logrocket.com",
  "bugsnag.com", "rollbar.com", "pendo.io", "appcues.com",
  "scorecardresearch.com", "quantserve.com", "comscore.com",
  "criteo.com", "criteo.net", "adnxs.com", "taboola.com", "outbrain.com",
  "mathtag.com", "exelator.com", "bluekai.com", "bidswitch.net",
  "casalemedia.com", "pubmatic.com", "rubiconproject.com", "openx.net",
  "smartadserver.com", "agkn.com", "crwdcntrl.net", "demdex.net",
  "omtrdc.net", "2o7.net", "everesttech.net", "rlcdn.com",
  "facebook.com", "connect.facebook.net", "graph.facebook.com",
  "twitter.com", "t.co", "syndication.twitter.com",
  "pinterest.com", "pinimg.com", "snapchat.com", "sc-static.net",
  "linkedin.com", "licdn.com", "bing.com", "bat.bing.com",
  "yandex.ru", "mc.yandex.ru", "metrika.yandex.net",
  "clarity.ms", "hotjar.io", "mouseflow.com", "luckyorange.com",
  "crazyegg.com", "inspectlet.com", "quantummetric.com",
  "branch.io", "appsflyer.com", "adjust.com", "kochava.com",
  "singular.net", "tenjin.com", "amplitude.io", "kissmetrics.com"
];

function isThirdPartyTracker(host) {
  const h = String(host || "").toLowerCase();
  for (const t of THIRD_PARTY_TRACKERS) {
    if (h === t || h.endsWith("." + t)) return true;
  }
  return false;
}

/* ============ 静态规则集身份 ============
   manifest 里的规则集 id 是字符串，但 onRuleMatchedDebug 给的 rulesetId 是 Chrome 分配的
   数字，拿 "url_clean" 去比对永远不成立。静态规则的 ruleId 打包时就固定不变，用它认门最可靠：
   ads=100 / tracking=1000 / annoyances=2000 / url_clean=3000~3028 / malware=4000。 */
const STATIC_RULE_SETS = [
  { min: 100, max: 100, cat: "ads" },
  { min: 1000, max: 1000, cat: "tracking" },
  { min: 2000, max: 2000, cat: "annoyances" },
  { min: 3000, max: 3028, cat: "url_clean" },
  { min: 4000, max: 4000, cat: "malware" }
];

function staticRuleSetCat(ruleId) {
  const rid = Number(ruleId);
  if (!Number.isFinite(rid)) return "";
  for (const s of STATIC_RULE_SETS) {
    if (rid >= s.min && rid <= s.max) return s.cat;
  }
  return "";
}

function classifyRule(ruleId, url, pageHost, hostCat) {
  // 0) 静态规则集直接按 ruleId 归属，不再靠 URL 猜
  const fixed = staticRuleSetCat(ruleId);
  if (fixed) return fixed;

  const u = String(url || "").toLowerCase();

  // 1) URL 参数特征：追踪参数 -> url_clean
  if (/[?&](utm_|gclid|fbclid|dclid|msclkid|yclid|twclid|spm=|scm=)/i.test(u)) {
    return "url_clean";
  }

  // 2) 解析当前请求的主机
  let reqHost = "";
  try { reqHost = new URL(url).hostname; } catch (e) {}

  // 3) 同一个被拦域名只归一类：之前判过就直接沿用，避免同一域名一会儿算追踪、一会儿算广告
  //    （路径关键词命中与否取决于具体 URL，光靠它判定会飘）
  if (hostCat) return hostCat;

  // 4) 已知第三方追踪器 -> tracking
  if (reqHost && isThirdPartyTracker(reqHost)) return "tracking";

  // 5) 域名/路径特征含埋点关键词 -> tracking
  //    域名里带 telemetry/beacon/trace/gatherer/tdid 这类词的，不管路径怎么写都算追踪：
  //    galileotelemetry.tencent.com 的 /collect 和 /aegiscontrol/whitelist 是同一个 SDK
  const isTelemetrySignal = /(telemetry|beacon|gatherer|metrika|tdid|guance|sensorsdata|talkingdata)/i.test(reqHost)
    || /(?:^|\.|-|_)(analytics|metrics?|tracking|gtag)(?:[.\-_|]|$)/i.test(reqHost)
    || /\/(log|logs|analytics|stats?|beacon|track|tracking|metrics?|collect|telemetry|report|impression|pixel|data|cm|kv)([/?.$]|$)/i.test(u)
    || /^(log|logs|data|cm|beacon|analytics|track|stat|report|telemetry|metrics|ping|monitor|trace|h5-analytics|nec)\./i.test(reqHost)
    || /\.(mmstat|cnzz|umeng|talkingdata|growingio|sensorsdata|guance)\./.test(reqHost);

  if (isTelemetrySignal) {
    return "tracking";
  }

  // 6) 走到这里只剩动态规则（订阅 / 用户自定义），它们没有规则集身份，按 URL 特征归到广告
  return "ads";
}

/* ============ 工具栏 badge ============ */
async function updateBadgeForTab(tabId) {
  if (tabId == null || tabId < 0) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const s = await getSettings();
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
      await chrome.action.setBadgeText({ tabId, text: "" });
      await chrome.action.setTitle({ tabId, title: "AdShield 广告拦截器" });
      return;
    }
    const host = new URL(tab.url).hostname;
    // 优先从内存缓冲读（实时），未初始化时回退到 storage
    let stats = __statsBuffer;
    if (!stats) {
      const store = await chrome.storage.local.get(STATS_KEY);
      stats = store[STATS_KEY] || {};
    }
    const count = (stats.byPage || {})[host] || 0;
    // 判断是否被暂停：全局停用 / 永久白名单 / 临时暂停
    const now = Date.now();
    const pausedUntil = (s.pausedUntil || {})[host];
    const isTemporarilyPaused = !!(pausedUntil && pausedUntil > now);
    const isPaused = !s.enabled || s.disabledSites.includes(host) || isTemporarilyPaused;
    const enabled = !isPaused;

    if (s.showBadge === false) {
      await chrome.action.setBadgeText({ tabId, text: "" });
      await chrome.action.setTitle({ tabId, title: enabled ? "AdShield 广告拦截器" : "AdShield：本站已暂停" });
      return;
    }

    const text = count > 0 ? (count > 999 ? "999+" : String(count)) : "";
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: enabled ? "#43c46b" : "#888888"
    });
    if (count > 0) {
      await chrome.action.setTitle({ tabId, title: `AdShield：本站已拦截 ${count} 条` });
    } else {
      await chrome.action.setTitle({ tabId, title: "AdShield 广告拦截器" });
    }
  } catch (e) {
    /* tab 已关闭 */
  }
}

/* ============ 用户自定义规则 ============ */
const USER_RULE_BASE = 100000;

// ABP 修饰符 -> Chrome DNR 资源类型
const RULE_TYPE_MAP = {
  script: "script", image: "image", stylesheet: "stylesheet",
  xmlhttprequest: "xmlhttprequest", subdocument: "sub_frame",
  media: "media", font: "font", ping: "ping", other: "other",
  object: "object", websocket: "websocket", main_frame: "main_frame"
};
// 不支持的修饰符：出现即整条跳过（宁可少拦，不可误拦）
const RULE_UNSUPPORTED_MODS = new Set([
  "document", "popup", "elemhide", "genericblock", "csp", "rewrite",
  "removeparam", "redirect", "removeheader", "third-party", "3p",
  "first-party", "1p", "match-case", "badfilter", "webrtc", "sitekey",
  "important", "all"
]);

function parseRuleLine(rawLine, id) {
  let line = (rawLine || "").trim();
  if (!line) return { skip: "空行" };

  // 元素隐藏规则：不在此处理（由 cosmetic 单独管）
  if (line.includes("##")) return { skip: "元素隐藏规则", isCosmetic: true };
  if (line.includes("#@#")) return { skip: "元素隐藏例外", isCosmetic: true };

  // 例外规则 @@||domain^ —— 放行优先
  let isException = false;
  if (line.startsWith("@@")) {
    isException = true;
    line = line.slice(2).trim();
  }

  // 拆分修饰符：||example.com^$script,image（$ 后必须全是合法修饰符字符才算）
  let body = line;
  let mods = "";
  const dollarIdx = line.lastIndexOf("$");
  if (dollarIdx > 0) {
    const after = line.slice(dollarIdx + 1);
    if (/^[a-z0-9,|~_\-]+$/i.test(after)) {
      mods = after.toLowerCase();
      body = line.slice(0, dollarIdx);
    }
  }

  // 修饰符处理：不支持的整条跳过；支持的类型映射到 resourceTypes/excludedResourceTypes
  let resourceTypes, excludedResourceTypes;
  if (mods) {
    const parts = mods.split(",").filter(Boolean);
    if (parts.some(p => RULE_UNSUPPORTED_MODS.has(p.replace(/^~/, "")))) {
      return { skip: "不支持的修饰符: $" + mods };
    }
    const neg = parts.filter(p => p.startsWith("~")).map(p => p.slice(1));
    const pos = parts.filter(p => !p.startsWith("~"));
    if (pos.length) resourceTypes = pos.map(p => RULE_TYPE_MAP[p]).filter(Boolean);
    if (neg.length) excludedResourceTypes = neg.map(p => RULE_TYPE_MAP[p]).filter(Boolean);
  }

  function buildCondition(extra) {
    const cond = Object.assign({ excludedResourceTypes: ["main_frame"] }, extra);
    if (resourceTypes) cond.resourceTypes = resourceTypes;
    if (excludedResourceTypes) cond.excludedResourceTypes = cond.excludedResourceTypes.concat(excludedResourceTypes);
    return cond;
  }

  // 域名规则：||example.com^
  const m1 = body.match(/^\|\|([a-zA-Z0-9_.*-]+)\^?$/);
  if (m1) {
    const domain = m1[1].replace(/^\*\./, "");  // 去掉前导 *.
    if (!domain || domain.includes("*")) return { skip: "域名无效: " + line };
    return {
      id,
      priority: isException ? 100 : 2,
      action: { type: isException ? "allow" : "block" },
      condition: buildCondition({ requestDomains: [domain] })
    };
  }

  // 路径片段：/ads/
  if (body.startsWith("/")) {
    return {
      id,
      priority: isException ? 100 : 2,
      action: { type: isException ? "allow" : "block" },
      condition: buildCondition({ urlFilter: body })
    };
  }

  // 兜底：作为 urlFilter
  return {
    id,
    priority: isException ? 100 : 2,
    action: { type: isException ? "allow" : "block" },
    condition: buildCondition({ urlFilter: body })
  };
}

async function applyUserRules(rules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter(r => r.id >= USER_RULE_BASE && r.id < USER_RULE_BASE + 10000)
    .map(r => r.id);

  const addRules = [];
  const skipped = [];   // [{line, reason}]
  const cosmetic = [];  // ## 规则单独收集
  let id = USER_RULE_BASE;

  for (const line of rules) {
    const trimmed = (line || "").trim();
    if (!trimmed) continue;

    // 先判 ## 元素隐藏（必须放在注释判断之前，因为 ## 也以 # 开头）
    if (trimmed.includes("##") || trimmed.includes("#@#")) {
      cosmetic.push(trimmed);
      continue;
    }

    // 再判注释（! 开头；或单个 # 后跟非 # 字符）
    if (trimmed.startsWith("!")) continue;
    if (trimmed.startsWith("#") && !trimmed.startsWith("##")) continue;

    const parsed = parseRuleLine(trimmed, id);
    if (parsed && parsed.skip) {
      skipped.push({ line: trimmed, reason: parsed.skip });
      continue;
    }
    if (parsed) { addRules.push(parsed); id++; }
    else { skipped.push({ line: trimmed, reason: "无法解析" }); }
  }

  // 长度上限：Chrome 的动态规则是共用一个池子的，订阅规则、站点放行、用户自定义都算在里面。
  // 上限实测为 30000（chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES，Chrome 156），
  // 这里按剩余额度算，给站点放行规则留 50 条余量。
  const usedByOthers = existing.length - removeRuleIds.length;
  const budget = Math.max(0, MAX_DYNAMIC_RULES - usedByOthers - 50);
  if (addRules.length > budget) {
    const overflow = addRules.splice(budget);
    overflow.forEach(r => skipped.push({ line: r.condition.urlFilter || r.condition.requestDomains?.[0] || "?", reason: "超过 Chrome 动态规则总上限 " + MAX_DYNAMIC_RULES + " 条" }));
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    // 把 ## 规则存给 cosmetic 用
    await chrome.storage.local.set({ "adshield_user_cosmetic": cosmetic });
    console.log("[AdShield] 已应用用户规则:", addRules.length, "条，元素隐藏:", cosmetic.length, "条，跳过:", skipped.length, "条");
  } catch (e) {
    console.log("[AdShield] 用户规则应用失败（已写入结果供设置页显示）", e);
    return { applied: 0, skipped: [...skipped, { line: "(全体)", reason: e.message || String(e) }], cosmetic: 0 };
  }

  return { applied: addRules.length, skipped, cosmetic: cosmetic.length };
}

/* ============ 规则订阅：在线更新 ============ */
const SUB_RULE_BASE = 300000;   // 订阅规则 ID 段（300000~399999）

/* ============ 默认订阅源（首次安装自动订阅） ============ */
const DEFAULT_SUBSCRIPTIONS = [
  { url: "https://easylist-downloads.adblockplus.org/easylistchina.txt", name: "EasyList China" },
  { url: "https://filters.adtidy.org/extension/ublock/filters/224.txt", name: "AdGuard CN" },
  { url: "https://easylist-downloads.adblockplus.org/fanboy-annoyance.txt", name: "Fanboy Annoyance" },
  { url: "https://easylist.to/easylist/easyprivacy.txt", name: "EasyPrivacy" }
];

/* ============ 简单字符串哈希（用于检测规则变化） ============ */
function simpleHash(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/* ============ 订阅操作串行队列（防并发竞态） ============ */
let __subscriptionQueue = Promise.resolve();
function enqueueSubscription(fn) {
  const next = __subscriptionQueue.then(
    () => fn(),
    () => fn()   // 前一个失败也继续
  );
  __subscriptionQueue = next.catch(() => {});
  return next;
}

// 解析订阅内容（支持 JSON 数组 或 uBlock 文本格式）
function parseSubscriptionText(text) {
  const lines = [];
  const trimmed = (text || "").trim();

  // 尝试 JSON 格式
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      const arr = Array.isArray(data) ? data : (data.rules || []);
      for (const item of arr) {
        if (typeof item === "string") lines.push(item);
        else if (item && item.urlFilter) lines.push(item.urlFilter);
        else if (item && item.rule) lines.push(item.rule);
      }
      return lines;
    } catch (e) {
      // JSON 解析失败，回退到文本
    }
  }

  // 文本格式：每行一条
  return trimmed.split(/\r?\n/);
}

// 订阅里的路径规则按社区列表原有顺序保留：只做去重 + 危险规则过滤，再取前 800 条。
// 不做关键词打分——社区列表本身已按价值排好序，按关键词筛反而会误杀冷门但有效的规则。

// ===== 只拉取订阅文本（可并发） =====
async function fetchSubscriptionText(url) {
  if (!url) return { ok: false, error: "无 URL" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const text = await resp.text();
    if (!text || text.length < 5) throw new Error("内容为空");
    return { ok: true, text };
  } catch (e) {
    const msg = (e && e.name === "AbortError") ? "请求超时（30 秒）" : String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

// ===== 应用订阅规则到动态规则（接收已拉取的 text） =====
async function applySubscriptionText(sub, text) {
  if (!text) return { ok: false, error: "内容为空" };

  // 解析
  const lines = parseSubscriptionText(text);

  // ===== 分类处理 =====
  const domainBlock = new Set();   // 拦截域名
  const domainAllow = new Set();   // 例外域名（@@）
  const pathRules = [];            // 路径 / 复杂规则
  let skipped = 0;

  for (const line of lines) {
    const t = (line || "").trim();
    if (!t) continue;
    if (t.startsWith("!")) continue;                   // 注释
    if (t.includes("##") || t.includes("#@#")) continue;  // 元素隐藏跳过
    if (t.startsWith("[")) continue;                   // [Adblock Plus 2.0] 之类

    let body = t;
    let isException = false;
    if (body.startsWith("@@")) {
      isException = true;
      body = body.slice(2).trim();
    }

    // 重要：如果含 $ 修饰符，先解析出资源类型
    let modifiers = "";
    const dollarIdx = body.lastIndexOf("$");
    if (dollarIdx > 0) {
      // 检查 $ 后是否合法修饰符（[a-z,|~_-]+），避免把 URL 里的 $ 误判
      const after = body.slice(dollarIdx + 1);
      if (/^[a-z0-9,|~_\-]+$/i.test(after)) {
        modifiers = after.toLowerCase();
        body = body.slice(0, dollarIdx);
      }
    }

    // 解析修饰符：跳过高风险 + 不支持的
    if (modifiers) {
      // 跳过：$document $popup $elemhide $genericblock $csp $rewrite $removeparam $redirect 等
      // 处理：$image $script $stylesheet $xmlhttprequest $subdocument $media $font $ping $other
      //       $third-party $3p  → 我们无法区分第三方，跳过
      //       $~third-party $1p → 只对第一方生效，跳过
      const SKIP_MODS = ["document", "popup", "elemhide", "genericblock", "csp",
                         "rewrite", "removeparam", "redirect", "removeheader",
                         "third-party", "3p", "first-party", "1p", "~third-party",
                         "match-case", "badfilter", "webrtc", "sitekey"];
      const parts = modifiers.split(",");
      const isSkip = parts.some(p => SKIP_MODS.includes(p.replace(/^~/, "")));
      if (isSkip) { skipped++; continue; }

      // 提取资源类型（只保留 resourceTypes 支持的类型）
      const TYPE_MAP = {
        "image": "image", "script": "script", "stylesheet": "stylesheet",
        "xmlhttprequest": "xmlhttprequest", "subdocument": "sub_frame",
        "media": "media", "font": "font", "ping": "ping", "other": "other",
        "object": "object", "websocket": "websocket"
      };
      const resTypes = [];
      for (const p of parts) {
        const clean = p.replace(/^~/, "");
        if (TYPE_MAP[clean]) resTypes.push(TYPE_MAP[clean]);
      }
      // 如果只指定了 $image，那就只拦图片
      if (resTypes.length > 0) {
        const domainOnly = body.match(/^\|\|([a-zA-Z0-9_.*-]+)\^?$/);
        if (domainOnly) {
          const domain = domainOnly[1].replace(/^\*\./, "").replace(/\*$/, "");
          if (domain && !domain.includes("*")) {
            pathRules.push({ kind: "domain-with-type", domain, types: resTypes, exception: isException });
            continue;
          }
        }
        // 非域名格式（路径 + 类型）暂不处理
        skipped++;
        continue;
      }
      // 有修饰符但没识别出资源类型（如 $important），跳过
      skipped++;
      continue;
    }

    // 纯域名规则：||example.com^（无修饰符）
    const m = body.match(/^\|\|([a-zA-Z0-9_.*-]+)\^?$/);
    if (m) {
      const domain = m[1].replace(/^\*\./, "").replace(/\*$/, "");
      if (!domain || domain.includes("*")) {
        // 带通配符的例外规则不能原样丢进 pathRules：
        // 那里每一项都会被构建成「拦截」规则，@@ 放行会变成拉黑，语义完全反过来
        if (isException) { skipped++; continue; }
        pathRules.push(t);
        continue;
      }
      if (isException) domainAllow.add(domain);
      else domainBlock.add(domain);
      continue;
    }

    // 路径规则：/banner/ 开头（无修饰符）
    if (body.startsWith("/") && body.length > 2) {
      if (!isException) pathRules.push(body);
      else skipped++;
      continue;
    }

    // 其它复杂规则（正则、通配符）—— 跳过
    skipped++;
  }

  // ===== 分配 ID 段（每个订阅 10000 个 ID） =====
  const offset = ((sub.id || 0) % 100) * 10000;
  const base = SUB_RULE_BASE + offset;

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter(r => r.id >= base && r.id < base + 10000)
    .map(r => r.id);

  // ===== 构造规则 =====
  const addRules = [];
  let id = base;

  // 1) 域名拦截（每 1000 个域名合并成 1 条）
  const CHUNK = 1000;
  const domainArr = Array.from(domainBlock);
  for (let i = 0; i < domainArr.length; i += CHUNK) {
    if (addRules.length >= 4500) { skipped += domainArr.length - i; break; }
    addRules.push({
      id: id++,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: domainArr.slice(i, i + CHUNK),
        excludedResourceTypes: ["main_frame"]
      }
    });
  }

  // 2) 例外域名（放行，priority 高）
  const allowArr = Array.from(domainAllow);
  for (let i = 0; i < allowArr.length; i += CHUNK) {
    if (addRules.length >= 4600) { skipped += allowArr.length - i; break; }
    addRules.push({
      id: id++,
      priority: 100,
      action: { type: "allow" },
      condition: {
        requestDomains: allowArr.slice(i, i + CHUNK),
        excludedResourceTypes: ["main_frame"]
      }
    });
  }

  // 3) 路径规则 + 精确类型规则（D2：只去重 + 过滤危险规则）
  // 保留原始顺序（社区已优化），只做去重 + 危险规则过滤
  const seenPaths = new Set();
  const validPathRules = [];
  for (const p of pathRules) {
    if (typeof p === "string") {
      // 去重
      if (seenPaths.has(p)) { skipped++; continue; }
      seenPaths.add(p);
      // 过滤明显危险的（超长正则、通配符爆炸）
      if (p.length > 500) { skipped++; continue; }
      const wildcardCount = (p.match(/\*/g) || []).length;
      if (wildcardCount > 3) { skipped++; continue; }
      validPathRules.push({ rule: p, kind: "path" });
    } else if (p && p.kind === "domain-with-type") {
      validPathRules.push({ rule: p, kind: "typed" });
    } else {
      skipped++;
    }
  }

  // 取前 800 条（保持原始顺序）
  const MAX_PATHS = 800;
  const selected = validPathRules.slice(0, MAX_PATHS);
  const overflow = validPathRules.length - selected.length;
  if (overflow > 0) skipped += overflow;

  // 构造规则
  let pathAdded = 0;
  for (const item of selected) {
    const p = item.rule;
    if (item.kind === "path") {
      addRules.push({
        id: id++,
        priority: 1,
        action: { type: "block" },
        condition: { urlFilter: p, excludedResourceTypes: ["main_frame"] }
      });
    } else if (item.kind === "typed") {
      addRules.push({
        id: id++,
        priority: p.exception ? 100 : 1,
        action: { type: p.exception ? "allow" : "block" },
        condition: {
          requestDomains: [p.domain],
          resourceTypes: p.types
        }
      });
    }
    pathAdded++;
  }
  console.log("[AdShield] 路径规则处理完成：原始", pathRules.length, "条 → 有效", validPathRules.length, "条 → 保留", pathAdded, "条");

  // ===== 应用 =====
  // 一条都没解析出来时什么都不做。订阅源被 CDN/反爬挡回一个 HTML 错误页时，解析结果就是 0 条，
  // 照常下发会把该订阅原有的规则整段删掉，还回一句「更新成功 0 条」，用户只看到广告回来了。
  if (addRules.length === 0) {
    return { ok: false, error: "未解析出任何可用规则（可能拿到的是错误页，或格式不受支持）", skipped };
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    return {
      ok: true,
      count: addRules.length,
      domains: domainBlock.size,
      exceptions: domainAllow.size,
      paths: pathAdded,
      skipped
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ===== 兼容包装：拉取 + 应用（顺序执行，用于更新单个订阅） =====
async function applySubscription(sub) {
  const fetched = await fetchSubscriptionText(sub.url);
  if (!fetched.ok) return fetched;
  return await applySubscriptionText(sub, fetched.text);
}

// 更新所有启用的订阅（并发拉取 + 串行提交）
async function updateAllSubscriptions() {
  const s = await getSettings();
  const subs = s.subscriptions || [];
  const enabledSubs = subs.filter(x => x.enabled !== false);

  // 阶段 1：所有订阅并发拉取
  const fetchedList = await Promise.all(
    enabledSubs.map(sub => fetchSubscriptionText(sub.url).then(r => ({ sub, fetched: r })))
  );

  // 阶段 2：串行提交。整段放进订阅队列 —— 单条订阅的新增/更新/删除也走同一个队列，
  // 两边并发时各自算出同一批规则 ID，Chrome 会整批拒绝写入，订阅就此停在旧版本。
  let totalOk = 0, totalFail = 0, totalRules = 0, totalChanged = 0;
  await enqueueSubscription(async () => {
    for (const { sub, fetched } of fetchedList) {
      let result;
      let newHash = "";
      if (fetched.ok) {
        newHash = simpleHash(fetched.text);
        result = await applySubscriptionText(sub, fetched.text);
      } else {
        result = { ok: false, error: fetched.error };
      }
      sub.lastUpdate = Date.now();
      if (result.ok) {
        // 检测内容是否变化（用于统计，不保留 hasUpdate）
        const oldHash = sub.lastHash;
        if (oldHash && oldHash !== newHash) {
          totalChanged++;
        }
        sub.lastHash = newHash;
        sub.lastCount = result.count;
        sub.lastDomains = result.domains || 0;
        sub.lastExceptions = result.exceptions || 0;
        sub.lastPaths = result.paths || 0;
        // 更新完成 → 清除 hasUpdate 标记（关键修复）
        sub.hasUpdate = false;
        delete sub.lastError;
        totalOk++;
        totalRules += result.count;
      } else {
        sub.lastError = result.error;
        totalFail++;
      }
    }
  });

  // 这一轮拉取最长要 30 秒，期间用户可能在弹窗里改开关、暂停站点，甚至增删订阅。
  // 直接把函数开头读到的那个对象整体写回，会把那些改动一起抹掉（表现为「我刚关掉的又自己开了」），
  // 所以落盘前重读一次，只把本轮真正改过的字段合并进去。
  const fresh = await getSettings();
  const freshSubs = fresh.subscriptions || [];
  const byId = new Map(subs.map(x => [x.id, x]));
  for (const cur of freshSubs) {
    const upd = byId.get(cur.id);
    if (!upd) continue;                 // 本轮没碰过这条（新增/刚恢复），保持用户现在的状态
    cur.lastUpdate = upd.lastUpdate;
    if (upd.lastError) {
      cur.lastError = upd.lastError;
    } else {
      delete cur.lastError;
      cur.hasUpdate = false;
      cur.lastHash = upd.lastHash;
      cur.lastCount = upd.lastCount;
      cur.lastDomains = upd.lastDomains;
      cur.lastExceptions = upd.lastExceptions;
      cur.lastPaths = upd.lastPaths;
    }
    byId.delete(cur.id);
  }
  // byId 里剩下的是拉取期间已被用户删掉的订阅，不写回
  fresh.subscriptions = freshSubs;
  fresh.lastSubscriptionCheck = Date.now();
  if (totalChanged > 0) {
    fresh.lastSubscriptionChangeTs = Date.now();
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: fresh });
  console.log("[AdShield] 订阅更新完成：成功", totalOk, "失败", totalFail, "共", totalRules, "条规则，", totalChanged, "个有变化");
  return { ok: totalOk, fail: totalFail, rules: totalRules, changed: totalChanged };
}

/* ============ 消息处理 ============ */
function handleOtherMessage(msg, sender, sendResponse) {
  // 最快路径：ping 立即响应（保活 SW，避免冷启动）
  if (msg && msg.type === "ping") {
    sendResponse({ ok: true, ts: Date.now() });
    return;
  }
  (async () => {
    try {
      const s = await getSettings();
      if (msg && msg.type === "getState") {
        const tab = msg.tabId ? await chrome.tabs.get(msg.tabId).catch(() => null) : null;
        let siteHost = "";
        if (tab && tab.url) {
          try { siteHost = new URL(tab.url).hostname; } catch (e) {}
        }
        // 优先读内存缓冲（实时），未初始化时回退 storage
        let stats = __statsBuffer;
        if (!stats) {
          const store = await chrome.storage.local.get(STATS_KEY);
          stats = store[STATS_KEY] || {};
          __statsBuffer = stats;   // 填充内存
        }
        sendResponse({
          settings: s,
          siteHost,
          siteDisabled: s.disabledSites.includes(siteHost),
          total: stats.total || 0,
          siteCount: (stats.byPage || {})[siteHost] || 0
        });
      } else if (msg && msg.type === "toggleGlobal") {
        s.enabled = !!msg.value;
        await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        await syncRulesets();
        sendResponse({ ok: true, settings: s });
      } else if (msg && msg.type === "toggleSite") {
        const host = msg.host;
        if (host) {
          const set = new Set(s.disabledSites);
          if (msg.value) set.add(host);
          else set.delete(host);
          s.disabledSites = Array.from(set);
          await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        }
        sendResponse({ ok: true, settings: s });
      } else if (msg && msg.type === "toggleRuleset") {
        s.rulesets[msg.id] = !!msg.value;
        await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        await syncRulesets();
        sendResponse({ ok: true, settings: s });
      } else if (msg && msg.type === "setFeature") {
        s[msg.key] = !!msg.value;
        await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        sendResponse({ ok: true, settings: s });
      } else if (msg && msg.type === "getStats") {
        // 若内存缓冲存在，直接返回（实时）；否则从 storage 读
        if (__statsBuffer) {
          sendResponse(Object.assign({}, __statsBuffer, { live: __statsLive }));
        } else {
          const store = await chrome.storage.local.get(STATS_KEY);
          const stats = store[STATS_KEY] || { total: 0, byPage: {}, byBlocked: {}, byCategory: {}, byDate: {}, byHour: {}, recentLogs: [] };
          // 同时填充内存缓冲，避免后续每次都读 storage
          __statsBuffer = stats;
          sendResponse(Object.assign({}, stats, { live: __statsLive }));
        }
      } else if (msg && msg.type === "resetStats") {
        const blank = { total: 0, byPage: {}, byBlocked: {}, byCategory: {}, byDate: {}, byHour: {}, recentLogs: [] };
        __statsBuffer = blank;   // 关键：同时清内存
        await chrome.storage.local.set({ [STATS_KEY]: blank });
        sendResponse({ ok: true });
      } else if (msg && msg.type === "getUserRules") {
        const store = await chrome.storage.local.get("adshield_user_rules");
        sendResponse(store.adshield_user_rules || []);
      } else if (msg && msg.type === "saveUserRules") {
        // 值变化时由 storage.onChanged 统一触发应用（避免双写导致 updateDynamicRules 竞态）；
        // 值未变化时 onChanged 不会触发，手动应用一次保证幂等（用户强制重刷场景）。
        const next = msg.rules || [];
        const prev = (await chrome.storage.local.get("adshield_user_rules")).adshield_user_rules || [];
        const changed = JSON.stringify(prev) !== JSON.stringify(next);
        await chrome.storage.local.set({ "adshield_user_rules": next });
        if (changed) {
          // 真正生效在 storage.onChanged 的防抖里，这里先立一个 pending 标记，
          // 让设置页能区分「正在应用」和「上一次的结果」
          await chrome.storage.local.set({ adshield_user_rules_result: { ts: Date.now(), pending: true } });
          sendResponse({ ok: true, pending: true });
        } else {
          const result = await applyUserRules(next);
          await chrome.storage.local.set({ adshield_user_rules_result: { ts: Date.now(), ok: true, result } });
          sendResponse({ ok: true, result });
        }
      } else if (msg && msg.type === "getSubscriptions") {
        sendResponse({ ok: true, subscriptions: s.subscriptions || [], interval: typeof s.subscriptionInterval === "number" ? s.subscriptionInterval : 24, lastCheck: s.lastSubscriptionCheck || 0 });
      } else if (msg && msg.type === "saveSubscription") {
        const incoming = msg.subscription || {};

        // ===== 阶段 1：先 fetch（不排队，多个订阅可并发拉取） =====
        let fetched = null;
        if (incoming.url) {
          fetched = await fetchSubscriptionText(incoming.url);
        }

        // ===== 阶段 2：串行 commit（防止 dynamicRules 冲突） =====
        await enqueueSubscription(async () => {
          const s = await getSettings();
          const subs = s.subscriptions || [];

          // ===== 新增订阅 =====
          if (!incoming.id) {
            if (!incoming.url) {
              sendResponse({ ok: false, error: "缺少 URL" });
              return;
            }
            if (!fetched || !fetched.ok) {
              sendResponse({ ok: false, error: (fetched && fetched.error) || "拉取失败" });
              return;
            }
            const used = new Set(subs.map(x => x.id % 100));
            let newId = -1;
            for (let i = 1; i < 100; i++) {
              if (!used.has(i)) { newId = i; break; }
            }
            if (newId < 0) {
              sendResponse({ ok: false, error: "订阅数量已达上限（99 个）" });
              return;
            }
            const target = incoming;
            target.id = newId;
            target.enabled = target.enabled !== false;
            target.lastUpdate = 0;
            target.lastCount = 0;

            const result = await applySubscriptionText(target, fetched.text);
            if (!result.ok) {
              try {
                const base = SUB_RULE_BASE + ((newId || 0) % 100) * 10000;
                const existing = await chrome.declarativeNetRequest.getDynamicRules();
                const removeRuleIds = existing
                  .filter(r => r.id >= base && r.id < base + 10000)
                  .map(r => r.id);
                if (removeRuleIds.length) {
                  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
                }
              } catch (e) {}
              sendResponse({ ok: false, error: result.error || "规则应用失败", result });
              return;
            }

            target.lastUpdate = Date.now();
            target.lastCount = result.count;
            target.lastDomains = result.domains || 0;
            target.lastExceptions = result.exceptions || 0;
            target.lastPaths = result.paths || 0;
            target.lastHash = simpleHash(fetched.text);
            target.hasUpdate = false;
            subs.push(target);
            s.subscriptions = subs;
            await chrome.storage.local.set({ [SETTINGS_KEY]: s });
            sendResponse({ ok: true, subscriptions: subs, result });
            return;
          }

          // ===== 更新已有订阅 =====
          const idx = subs.findIndex(x => x.id === incoming.id);
          if (idx < 0) {
            sendResponse({ ok: false, error: "未找到订阅" });
            return;
          }
          const target = Object.assign(subs[idx], incoming);

          if (target.enabled !== false && target.url) {
            let result;
            if (fetched && fetched.ok) {
              result = await applySubscriptionText(target, fetched.text);
            } else {
              result = { ok: false, error: (fetched && fetched.error) || "拉取失败" };
            }
            target.lastUpdate = Date.now();
            if (result.ok) {
              target.lastCount = result.count;
              target.lastDomains = result.domains || 0;
              target.lastExceptions = result.exceptions || 0;
              target.lastPaths = result.paths || 0;
              delete target.lastError;
            } else {
              target.lastError = result.error;
            }
            s.subscriptions = subs;
            await chrome.storage.local.set({ [SETTINGS_KEY]: s });
            sendResponse({ ok: true, subscriptions: subs, result });
          } else {
            s.subscriptions = subs;
            await chrome.storage.local.set({ [SETTINGS_KEY]: s });
            sendResponse({ ok: true, subscriptions: subs });
          }
        });
      } else if (msg && msg.type === "saveSubscriptionsBatch") {
        const incoming = msg.subscriptions || [];
        if (!incoming.length) {
          sendResponse({ ok: true, results: [] });
          return;
        }

        // ===== 阶段 1：并发 fetch（不排队，多订阅同时拉取） =====
        const fetchedList = await Promise.all(
          incoming.map(sub =>
            fetchSubscriptionText(sub.url).then(r => ({ sub, fetched: r }))
          )
        );

        // ===== 阶段 2：串行 commit（防 dynamicRules 冲突） =====
        await enqueueSubscription(async () => {
          const s = await getSettings();
          const subs = s.subscriptions || [];
          const results = [];

          for (const { sub, fetched } of fetchedList) {
            // 检查是否已订阅同 URL
            const existIdx = subs.findIndex(x => x.url === sub.url);
            if (existIdx >= 0) {
              results.push({ ok: false, error: "已订阅该源" });
              continue;
            }

            if (!fetched.ok) {
              results.push({ ok: false, error: fetched.error });
              continue;
            }

            // 分配 ID
            const used = new Set(subs.map(x => x.id % 100));
            let newId = -1;
            for (let i = 1; i < 100; i++) {
              if (!used.has(i)) { newId = i; break; }
            }
            if (newId < 0) {
              results.push({ ok: false, error: "订阅数量已达上限（99 个）" });
              continue;
            }

            const target = { url: sub.url, id: newId, enabled: true, lastUpdate: 0, lastCount: 0 };
            const result = await applySubscriptionText(target, fetched.text);
            if (!result.ok) {
              // 回滚（虽然 apply 内部失败不会写入）
              results.push({ ok: false, error: result.error || "应用失败" });
              continue;
            }

            target.lastUpdate = Date.now();
            target.lastCount = result.count;
            target.lastDomains = result.domains || 0;
            target.lastExceptions = result.exceptions || 0;
            target.lastPaths = result.paths || 0;
            target.lastHash = simpleHash(fetched.text);
            target.hasUpdate = false;
            subs.push(target);
            // 更新 settings（每次都要写，防止 ID 重复）
            s.subscriptions = subs;
            await chrome.storage.local.set({ [SETTINGS_KEY]: s });
            results.push({ ok: true, result });
          }

          sendResponse({ ok: true, results });
        });
      } else if (msg && msg.type === "restoreDefaultSubscriptions") {
        // 恢复默认订阅（不重复已有的）
        await enqueueSubscription(async () => {
          const s = await getSettings();
          const subs = s.subscriptions || [];
          const existingUrls = new Set(subs.map(x => x.url));
          const toAdd = DEFAULT_SUBSCRIPTIONS.filter(d => !existingUrls.has(d.url));

          if (!toAdd.length) {
            sendResponse({ ok: true, added: 0, message: "所有推荐订阅已存在" });
            return;
          }

          // 分配 ID
          const used = new Set(subs.map(x => x.id % 100));
          let nextId = 1;
          const assigned = [];
          for (const d of toAdd) {
            while (used.has(nextId) && nextId < 100) nextId++;
            if (nextId >= 100) break;
            used.add(nextId);
            assigned.push({ id: nextId, url: d.url, name: d.name });
            nextId++;
          }

          // 并发拉取
          const fetched = await Promise.all(
            assigned.map(a => fetchSubscriptionText(a.url).then(r => ({ a, r })))
          );

          // 串行提交
          let added = 0;
          for (const { a, r } of fetched) {
            if (!r.ok) continue;
            const target = { id: a.id, url: a.url, enabled: true, lastUpdate: 0, lastCount: 0 };
            const result = await applySubscriptionText(target, r.text);
            if (!result.ok) continue;
            target.lastUpdate = Date.now();
            target.lastCount = result.count;
            target.lastDomains = result.domains || 0;
            target.lastExceptions = result.exceptions || 0;
            target.lastPaths = result.paths || 0;
            subs.push(target);
            s.subscriptions = subs;
            await chrome.storage.local.set({ [SETTINGS_KEY]: s });
            added++;
          }
          sendResponse({ ok: true, added });
        });
      } else if (msg && msg.type === "checkSubscriptionUpdates") {
        // 轻量检查：只拉取 + 对比 hash，不应用规则
        const s = await getSettings();
        const subs = s.subscriptions || [];
        const enabledSubs = subs.filter(x => x.enabled !== false);
        if (!enabledSubs.length) {
          sendResponse({ ok: true, checked: 0, changed: 0 });
          return;
        }
        // 并发拉取
        const fetchedList = await Promise.all(
          enabledSubs.map(sub => fetchSubscriptionText(sub.url).then(r => ({ sub, fetched: r })))
        );
        let changed = 0;
        for (const { sub, fetched } of fetchedList) {
          if (!fetched.ok) continue;
          const newHash = simpleHash(fetched.text);
          if (sub.lastHash && sub.lastHash !== newHash) {
            sub.hasUpdate = true;
            changed++;
          } else if (!sub.lastHash) {
            // 无历史 hash，仅记录不提示
            sub.lastHash = newHash;
          }
        }
        if (changed > 0) {
          s.subscriptions = subs;
          await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        }
        console.log("[AdShield] 检查订阅更新：", changed, "/", enabledSubs.length, "个有变化");
        sendResponse({ ok: true, checked: enabledSubs.length, changed });
      } else if (msg && msg.type === "clearSubscriptionUpdateFlag") {
        const s = await getSettings();
        const subs = s.subscriptions || [];
        if (msg.id) {
          // 只清指定订阅
          for (const sub of subs) {
            if (sub.id === msg.id) { sub.hasUpdate = false; break; }
          }
        } else {
          // 清所有
          for (const sub of subs) {
            if (sub.hasUpdate) sub.hasUpdate = false;
          }
        }
        s.subscriptions = subs;
        await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        sendResponse({ ok: true });
      } else if (msg && msg.type === "removeSubscription") {
        const subs = (s.subscriptions || []).filter(x => x.id !== msg.id);
        s.subscriptions = subs;
        await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        // 清理该订阅的规则（ID 段算法与 applySubscription 一致）。
        // 同样要排队：与订阅更新并发时，这里算出的 removeRuleIds 可能漏掉对方刚写入的 ID。
        await enqueueSubscription(async () => {
          const base = SUB_RULE_BASE + ((msg.id || 0) % 100) * 10000;
          const existing = await chrome.declarativeNetRequest.getDynamicRules();
          const removeRuleIds = existing
            .filter(r => r.id >= base && r.id < base + 10000)
            .map(r => r.id);
          if (removeRuleIds.length) {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
          }
        });
        sendResponse({ ok: true, subscriptions: subs });
      } else if (msg && msg.type === "updateAllSubscriptions") {
        const result = await updateAllSubscriptions();
        const s2 = await getSettings();
        sendResponse({ ok: true, result, subscriptions: s2.subscriptions || [] });
      } else if (msg && msg.type === "setSubscriptionInterval") {
        s.subscriptionInterval = Math.max(0, parseInt(msg.hours, 10) || 0);
        await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        sendResponse({ ok: true, interval: s.subscriptionInterval });
      } else {
        sendResponse({ ok: false, error: "unknown type" });
      }
    } catch (e) {
      sendResponse({ error: String(e) });
    }
  })();
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 浏览助手：自动暂停该站点
  if (msg && msg.type === "assistDetected" && msg.host) {
    // msg.host 必须与发送方所在标签页一致，否则页面可伪造 host 暂停任意站点
    const senderHost = (() => {
      if (!sender || !sender.tab || !sender.tab.url) return "";
      try { return new URL(sender.tab.url).hostname; } catch (e) { return ""; }
    })();
    if (senderHost && senderHost !== msg.host) {
      console.log("[AdShield 浏览助手] 已拒绝：host 与来源标签页不符", msg.host, "≠", senderHost);
      sendResponse({ ok: false, reason: "host-mismatch" });
      return true;
    }
    (async () => {
      try {
        const s = await getSettings();
        if (s.assist === false) { sendResponse({ ok: false, reason: "assist-disabled" }); return; }
        if (s.disabledSites.includes(msg.host)) { sendResponse({ ok: false, reason: "already-paused" }); return; }
        // 已在协助列表里且未过期 → 不重复暂停
        const existing = s.pausedUntil[msg.host];
        if (existing && existing > Date.now()) {
          sendResponse({ ok: false, reason: "already-active" });
          return;
        }
        // 暂时暂停 1 小时（浏览助手触发时）
        const until = Date.now() + 60 * 60 * 1000;
        s.pausedUntil[msg.host] = until;
        // 记录到协助历史（用于 UI 显示）
        if (!Array.isArray(s.assistedSites)) s.assistedSites = [];
        s.assistedSites = s.assistedSites.filter(x => x.host !== msg.host);
        s.assistedSites.push({
          host: msg.host,
          ts: Date.now(),
          until: until,
          reason: msg.reason || "detected"
        });
        // 只保留最近 100 条
        if (s.assistedSites.length > 100) {
          s.assistedSites = s.assistedSites.slice(-100);
        }
        await chrome.storage.local.set({ [SETTINGS_KEY]: s });
        console.log("[AdShield 浏览助手] 已暂时暂停:", msg.host, "1 小时，原因:", msg.reason || "detected");
        sendResponse({ ok: true, until });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  return handleOtherMessage(msg, sender, sendResponse);
});

/* ============ 快捷键：Alt+A 全局暂停，Alt+S 站点暂停 ============ */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-global") {
    const s = await getSettings();
    s.enabled = !s.enabled;
    s.globalPausedUntil = 0;
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
    console.log("[AdShield] 快捷键：全局", s.enabled ? "恢复" : "暂停");
  } else if (command === "toggle-site") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;
    const host = new URL(tab.url).hostname;
    const s = await getSettings();
    const set = new Set(s.disabledSites || []);
    if (set.has(host)) {
      set.delete(host);
      delete s.pausedUntil[host];
      console.log("[AdShield] 快捷键：本站恢复", host);
    } else {
      set.add(host);
      console.log("[AdShield] 快捷键：本站暂停", host);
    }
    s.disabledSites = Array.from(set);
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  }
});

/* ============ 右键菜单：站点暂停 / 恢复 ============ */
const MENU_ID_PAUSE = "adshield-pause-site";
const MENU_ID_RESUME = "adshield-resume-site";
const MENU_ID_OPTIONS = "adshield-options";

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID_PAUSE,
      title: "在此网站暂停 AdShield",
      contexts: ["page", "frame"]
    });
    chrome.contextMenus.create({
      id: MENU_ID_RESUME,
      title: "恢复此网站的 AdShield",
      contexts: ["page", "frame"]
    });
    chrome.contextMenus.create({ id: "adshield-sep", type: "separator", contexts: ["page", "frame"] });
    chrome.contextMenus.create({
      id: MENU_ID_OPTIONS,
      title: "AdShield 设置",
      contexts: ["page", "frame"]
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;
  const host = new URL(tab.url).hostname;

  if (info.menuItemId === MENU_ID_PAUSE) {
    const s = await getSettings();
    const set = new Set(s.disabledSites || []);
    set.add(host);
    s.disabledSites = Array.from(set);
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
    console.log("[AdShield] 右键菜单：暂停", host);
  } else if (info.menuItemId === MENU_ID_RESUME) {
    const s = await getSettings();
    const set = new Set(s.disabledSites || []);
    set.delete(host);
    s.disabledSites = Array.from(set);
    delete s.pausedUntil[host];
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
    console.log("[AdShield] 右键菜单：恢复", host);
  } else if (info.menuItemId === MENU_ID_OPTIONS) {
    chrome.runtime.openOptionsPage();
  }
});

/* ============ 订阅更新定时器 ============ */
async function scheduleSubscriptionCheck() {
  const s = await getSettings();
  const hours = s.subscriptionInterval || 0;
  if (hours <= 0) {
    // 关闭订阅更新
    try { await chrome.alarms.clear("adshield-sub-update"); } catch (e) {}
    return;
  }
  // 使用 periodInMinutes（最小 30 分钟）
  const periodInMinutes = Math.max(30, hours * 60);
  // 同名 alarm 再次 create 会被整个替换，首次触发时间也随之推后。
  // 而 storage.onChanged 里每一次设置变动都会走到这里——照旧重建，
  // 「每 24 小时自动更新」就会被用户的日常操作无限推迟，事实上永远不触发。
  try {
    const cur = await chrome.alarms.get("adshield-sub-update");
    if (cur && cur.periodInMinutes === periodInMinutes) return;
  } catch (e) {}
  chrome.alarms.create("adshield-sub-update", { periodInMinutes });
  console.log("[AdShield] 订阅更新定时器已设置：每", hours, "小时");
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === MATCH_POLL_ALARM) {
    await pollMatchedRules();
    return;
  }
  if (a.name === "adshield-first-sub-fetch") {
    await chrome.alarms.clear("adshield-first-sub-fetch");
    updateAllSubscriptions().catch((e) => {
      console.log("[AdShield] 首次订阅拉取失败：", e);
    });
    return;
  }
  if (a.name === "adshield-sub-update") {
    console.log("[AdShield] 定时器触发：开始更新订阅");
    await updateAllSubscriptions();
  }
});

/* ============ 生命周期 ============ */
chrome.runtime.onInstalled.addListener(async (details) => {
  const s = await getSettings();

  // ===== 首次安装：填入默认订阅源 =====
  let needFetchDefaults = false;
  if (details && details.reason === "install") {
    if (!s.subscriptions || s.subscriptions.length === 0) {
      s.subscriptions = DEFAULT_SUBSCRIPTIONS.map((d, i) => ({
        id: i + 1,                 // ID 段：1~4
        url: d.url,
        enabled: true,
        lastUpdate: 0,
        lastCount: 0
      }));
      needFetchDefaults = true;
      console.log("[AdShield] 首次安装：已写入默认订阅", DEFAULT_SUBSCRIPTIONS.length, "个");
    }
  }

  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  await syncRulesets();
  await syncSiteAllowlist();
  createMenus();
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) updateBadgeForTab(t.id);
  await scheduleSubscriptionCheck();
  await cleanupOrphanSubscriptions();

  // ===== 首次安装：用 alarm 延迟拉取订阅（MV3 SW 的 setTimeout 可能因挂起而丢失） =====
  if (needFetchDefaults) {
    chrome.alarms.create("adshield-first-sub-fetch", { delayInMinutes: 0.5 });
  } else {
    // 非首次：立即更新（若已有订阅）
    updateAllSubscriptions().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(syncRulesets);
chrome.runtime.onStartup.addListener(syncSiteAllowlist);
chrome.runtime.onStartup.addListener(scheduleSubscriptionCheck);
chrome.runtime.onStartup.addListener(cleanupOrphanSubscriptions);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SETTINGS_KEY]) {
    syncRulesets();
    syncSiteAllowlist();
    scheduleCleanup();
    scheduleSubscriptionCheck();
    // 关键：设置变化（暂停/恢复/白名单）时立即刷新所有标签的 badge
    chrome.tabs.query({}).then(tabs => {
      for (const t of tabs) {
        if (t.id != null) updateBadgeForTab(t.id);
      }
    }).catch(() => {});
  }
  if (changes.adshield_user_rules) {
    // 防抖：合并短时间内的多次变更，避免 updateDynamicRules 并发竞态
    clearTimeout(__userRulesApplyTimer);
    __userRulesApplyTimer = setTimeout(() => {
      applyUserRules(changes.adshield_user_rules.newValue || [])
        .then((result) => {
          // 结果必须落盘：saveUserRules 早就回了 ok:true，若这里失败只有 console 里一行，
          // 用户在设置页看到的是「保存成功」，实际一条都没生效。
          return chrome.storage.local.set({ adshield_user_rules_result: { ts: Date.now(), ok: true, result } });
        })
        .catch((e) => {
          console.error("[AdShield] 自定义规则应用异常:", e);
          return chrome.storage.local.set({
            adshield_user_rules_result: { ts: Date.now(), ok: false, error: String((e && e.message) || e) }
          });
        });
    }, 300);
  }
});

chrome.tabs.onActivated.addListener((info) => {
  updateBadgeForTab(info.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    updateBadgeForTab(tabId);
  }
});

/* ============ 命中统计（节流：内存缓冲 + 定期刷盘） ============ */
// 统计写盘状态
let __statsFlushPending = false;

async function loadStatsBuffer() {
  if (__statsBuffer) return __statsBuffer;
  const store = await chrome.storage.local.get(STATS_KEY);
  __statsBuffer = store[STATS_KEY] || { total: 0, byPage: {}, byBlocked: {}, byCategory: {}, byDate: {}, byHour: {} };
  if (!__statsBuffer.byPage) __statsBuffer.byPage = {};
  if (!__statsBuffer.byBlocked) __statsBuffer.byBlocked = {};
  if (!__statsBuffer.byCategory) __statsBuffer.byCategory = {};
  if (!__statsBuffer.byDate) __statsBuffer.byDate = {};
  if (!__statsBuffer.byHour) __statsBuffer.byHour = {};
  return __statsBuffer;
}

// 返回本地日期字符串（YYYY-MM-DD）
function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// 返回本地小时字符串（YYYY-MM-DD-HH）
function hourKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(d.getHours());
}

async function flushStats() {
  if (!__statsBuffer || !__statsFlushPending) return;
  __statsFlushPending = false;

  // 截断（避免无限增长）
  const cap = (obj) => {
    const e = Object.entries(obj);
    if (e.length > 200) {
      e.sort((a, b) => b[1] - a[1]);
      return Object.fromEntries(e.slice(0, 200));
    }
    return obj;
  };
  __statsBuffer.byPage = cap(__statsBuffer.byPage);
  __statsBuffer.byBlocked = cap(__statsBuffer.byBlocked);

  await chrome.storage.local.set({ [STATS_KEY]: __statsBuffer });
}

// 写盘队列：保证串行，且每次有变化就立即写（不依赖 setTimeout，避免 MV3 SW 挂起丢数据）
let __statsWriteQueued = false;
let __statsWriteChain = Promise.resolve();

function scheduleFlush() {
  __statsFlushPending = true;
  if (__statsWriteQueued) return;   // 已有排队中的写盘
  __statsWriteQueued = true;
  __statsWriteChain = __statsWriteChain.then(async () => {
    __statsWriteQueued = false;
    if (!__statsFlushPending) return;
    try { await flushStats(); } catch (e) {}
  }).catch(() => {});
}

/* ============ 拦截通知（节流：每 tab 每 60 秒最多 1 次） ============ */
const __notifyState = new Map();   // tabId -> { lastNotify: ts, count: number }
const NOTIFY_THROTTLE = 60 * 1000;   // 60 秒
const NOTIFY_MIN_COUNT = 5;          // 至少拦截 5 条才通知

async function maybeNotifyBlocked(tabId, pageHost, count) {
  if (!tabId || tabId < 0) return;
  const s = await getSettings();
  if (!s.notifyOnBlock) return;

  let st = __notifyState.get(tabId);
  if (!st) {
    st = { lastNotify: 0, count: 0 };
    __notifyState.set(tabId, st);
  }
  st.count++;
  const now = Date.now();
  if (st.count < NOTIFY_MIN_COUNT) return;
  if (now - st.lastNotify < NOTIFY_THROTTLE) return;
  st.lastNotify = now;
  const shown = st.count;
  st.count = 0;

  try {
    chrome.notifications.create("adshield-block-" + tabId + "-" + now, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "AdShield 已拦截",
      message: "在 " + (pageHost || "当前页面") + " 拦截了 " + shown + " 个请求",
      priority: 0,
      silent: true
    });
  } catch (e) {
    console.log("[AdShield] 通知失败：", e);
  }
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  console.log("[AdShield] onRuleMatchedDebug 已注册");
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
    if (!__statsLive) __statsLive = true;   // 事件能触发 => 开发者模式，统计可用
    const blockedHost = (() => {
      try { return new URL(info.request.url).hostname; } catch (e) { return ""; }
    })();
    let pageHost = "";
    const initiator = info.request && info.request.initiator;
    if (initiator && initiator !== "null") {
      try { pageHost = new URL(initiator).hostname; } catch (e) {}
    }
    if (!pageHost && info.request && info.request.tabId != null && info.request.tabId >= 0) {
      try {
        const tab = await chrome.tabs.get(info.request.tabId);
        if (tab && tab.url) pageHost = new URL(tab.url).hostname;
      } catch (e) {}
    }

    const stats = await loadStatsBuffer();
    const ruleId = info.rule && info.rule.ruleId;
    if (!stats.byHostCat) stats.byHostCat = {};
    const cat = classifyRule(ruleId, info.request.url, pageHost, blockedHost ? stats.byHostCat[blockedHost] : "");
    // 记下这个域名的归类（只给动态规则记；静态规则有权威 ruleId，参数清理按 URL 判）
    if (blockedHost && !stats.byHostCat[blockedHost] && !staticRuleSetCat(ruleId) && cat !== "url_clean") {
      stats.byHostCat[blockedHost] = cat;
      const hk = Object.keys(stats.byHostCat);
      if (hk.length > 800) delete stats.byHostCat[hk[0]];
    }
    // url_clean 规则集是参数清理（重定向），不计入"拦截总数"
    // 注意：按静态 ruleId 区间判定，不能用 cat（cat 基于 URL 特征可能误判）
    const isUrlClean = staticRuleSetCat(ruleId) === "url_clean";
    if (!isUrlClean) {
      stats.total = (stats.total || 0) + 1;
      if (pageHost) stats.byPage[pageHost] = (stats.byPage[pageHost] || 0) + 1;
      if (blockedHost) stats.byBlocked[blockedHost] = (stats.byBlocked[blockedHost] || 0) + 1;
    }
    if (pageHost) {
      if (!stats.byCategory[pageHost]) {
        stats.byCategory[pageHost] = { ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 };
      }
      stats.byCategory[pageHost][cat] = (stats.byCategory[pageHost][cat] || 0) + 1;
    }
    // 按日期 + 分类累计（趋势图用）
    if (!stats.byDate) stats.byDate = {};
    const dayKey = todayKey();
    if (!stats.byDate[dayKey] || typeof stats.byDate[dayKey] === "number") {
      stats.byDate[dayKey] = { ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 };
    }
    stats.byDate[dayKey][cat] = (stats.byDate[dayKey][cat] || 0) + 1;

    // 按小时累计（24 小时视图用）
    if (!stats.byHour) stats.byHour = {};
    const hKey = hourKey();
    if (!stats.byHour[hKey]) {
      stats.byHour[hKey] = { ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 };
    }
    stats.byHour[hKey][cat] = (stats.byHour[hKey][cat] || 0) + 1;

    // 保留策略：byDate 最多 365 天；byHour 最多 48 小时
    const dayKeys = Object.keys(stats.byDate).sort();
    if (dayKeys.length > 365) {
      const keep = dayKeys.slice(-365);
      const trimmed = {};
      for (const k of keep) trimmed[k] = stats.byDate[k];
      stats.byDate = trimmed;
    }
    const hourKeys = Object.keys(stats.byHour).sort();
    if (hourKeys.length > 48) {
      const keep = hourKeys.slice(-48);
      const trimmedH = {};
      for (const k of keep) trimmedH[k] = stats.byHour[k];
      stats.byHour = trimmedH;
    }
    if (!stats.recentLogs) stats.recentLogs = [];
    stats.recentLogs.push({ ts: Date.now(), url: info.request.url, pageHost: pageHost || "", blockedHost: blockedHost || "", cat });
    if (stats.recentLogs.length > 500) stats.recentLogs = stats.recentLogs.slice(-500);
    scheduleFlush();

    const tid = info.request && info.request.tabId;
    if (tid != null && tid >= 0) {
      updateBadgeForTab(tid);
      // 触发通知（若开启）
      maybeNotifyBlocked(tid, pageHost, 1).catch(() => {});
    }
  });
} else {
  console.log("[AdShield] onRuleMatchedDebug 不可用（需开发者模式加载）");
}

/* ============ 正式安装版的请求级统计 ============ */
// onRuleMatchedDebug 只存在于「开发者模式加载的未打包扩展」里，正式安装版没有这个事件，
// 所以正式版的统计改走 getMatchedRules()：它对持有 declarativeNetRequestFeedback 权限的扩展
// 同样可用（实测 Chrome 156），返回命中过的规则列表（带命中时间戳和 tabId）。
// 配额：20 次 / 10 分钟（MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL / GETMATCHEDRULES_QUOTA_INTERVAL），
// 这里 60 秒一次，远低于配额。
const MATCH_POLL_ALARM = "adshield-match-poll";
const MATCH_POLL_MINUTES = 1;
const MATCH_TS_KEY = "adshield_match_poll_ts";

async function pollMatchedRules() {
  // 开发模式下 onRuleMatchedDebug 给的数据更全（带 URL、分类、时间线），不重复计
  if (__statsLive) return;
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.getMatchedRules) return;

  let res;
  try {
    res = await chrome.declarativeNetRequest.getMatchedRules();
  } catch (e) {
    return;   // 配额用完 / 权限不足：跳过这一轮，不刷错误日志
  }
  const infos = (res && res.rulesMatchedInfo) || [];
  const now = Date.now();
  // 水位线放 storage：MV3 的 Service Worker 空闲就会被挂起，内存变量一重启就丢，
  // 丢一次就会漏算或重算那一分钟的命中。
  const store = await chrome.storage.local.get(MATCH_TS_KEY);
  const since = store[MATCH_TS_KEY] || (now - MATCH_POLL_MINUTES * 60 * 1000);
  await chrome.storage.local.set({ [MATCH_TS_KEY]: now });
  // 只算本轮之后新命中的：老的条目会因为「超过 5 分钟且没关联到文档」被 Chrome 丢掉，
  // 直接取总数会随保留窗口忽上忽下。
  const fresh = infos.filter(i => i && i.timeStamp && i.timeStamp > since);
  if (!fresh.length) return;

  // 按 tabId 归到站点；标签已关掉的拿不到 URL，只计总数
  const tabIds = Array.from(new Set(fresh.map(i => i.tabId).filter(id => id != null && id >= 0)));
  const tabHosts = {};
  for (const id of tabIds) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab && tab.url) { try { tabHosts[id] = new URL(tab.url).hostname; } catch (e) {} }
    } catch (e) {}
  }

  const stats = await loadStatsBuffer();
  let total = 0;
  for (const info of fresh) {
    const ruleId = info.rule && info.rule.ruleId;
    const cat = staticRuleSetCat(ruleId) || "ads";   // 动态规则（订阅/自定义）归到广告
    const host = tabHosts[info.tabId] || "";
    // url_clean 是重定向不是拦截，不计入总数
    if (cat !== "url_clean") total++;
    const key = host || "(全局)";
    if (!stats.byCategory[key]) {
      stats.byCategory[key] = { ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 };
    }
    stats.byCategory[key][cat] = (stats.byCategory[key][cat] || 0) + 1;
    if (host) stats.byPage[host] = (stats.byPage[host] || 0) + 1;
  }
  stats.total = (stats.total || 0) + total;
  scheduleFlush();
}

async function ensureMatchPollAlarm() {
  // 不靠「onRuleMatchedDebug 这个 API 存不存在」来判断是不是开发模式：
  // 打包版里它可能存在但永不触发，那样就永远不会去建轮询，统计就一直是空的。
  // 只在调试事件真的来过（__statsLive）时，pollMatchedRules 自己会跳过。
  try {
    const cur = await chrome.alarms.get(MATCH_POLL_ALARM);
    if (cur && cur.periodInMinutes === MATCH_POLL_MINUTES) return;
  } catch (e) {}
  chrome.alarms.create(MATCH_POLL_ALARM, { periodInMinutes: MATCH_POLL_MINUTES });
}

// 标签关闭时清理通知状态
chrome.tabs.onRemoved.addListener((tabId) => {
  __notifyState.delete(tabId);
});

/* ============ 启动时应用一次用户规则 ============ */
(async () => {
  try {
    const store = await chrome.storage.local.get("adshield_user_rules");
    await applyUserRules(store.adshield_user_rules || []);
  } catch (e) {
    console.log("[AdShield] 启动应用用户规则失败:", e);
  }
  // 正式安装版的统计轮询（开发模式跳过）
  try { await ensureMatchPollAlarm(); } catch (e) {}
})();

/* ============ 清理孤儿订阅规则 ============ */
async function cleanupOrphanSubscriptions() {
  try {
    const s = await getSettings();
    const subs = s.subscriptions || [];
    // 所有已启用/禁用订阅占用的 ID 段
    const validBases = new Set(subs.map(x => SUB_RULE_BASE + ((x.id || 0) % 100) * 10000));
    // 扫描所有订阅 ID 段（SUB_RULE_BASE ~ SUB_RULE_BASE + 1000000）内的规则
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const orphan = existing.filter(r => {
      if (r.id < SUB_RULE_BASE || r.id >= SUB_RULE_BASE + 100 * 10000) return false;
      // 找到该规则属于哪个 ID 段
      const segStart = SUB_RULE_BASE + Math.floor((r.id - SUB_RULE_BASE) / 10000) * 10000;
      return !validBases.has(segStart);
    }).map(r => r.id);
    if (orphan.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: orphan, addRules: [] });
      console.log("[AdShield] 已清理孤儿订阅规则:", orphan.length, "条");
    }
  } catch (e) {
    console.log("[AdShield] 清理孤儿订阅规则失败:", e);
  }
}

// 不在启动时主动调用（由 onInstalled/onStartup 触发）

// 浏览器退出时把统计缓冲落盘。
// 注意：MV3 只在「永久挂起」（退出浏览器）时触发本事件，空闲终止不会走到这里，
// 所以它只是兜底，防丢数据主要靠命中时的排队写盘。
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    flushStats().catch((e) => { console.log("[AdShield] 挂起前刷盘未完成:", (e && e.message) || e); });
  });
}
