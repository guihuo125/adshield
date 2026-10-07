// AdShield MV3 service worker
const ALL_RULESETS = ["ads", "tracking", "annoyances", "url_clean", "malware"];
const STATS_KEY = "adshield_stats";
const SETTINGS_KEY = "adshield_settings";

// 内存中的统计缓冲（供 badge 实时读取，避免 storage 写盘延迟）
let __statsBuffer = null;

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
  return s;
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
// 双维度判断：URL 特征 > rulesetId
// 原因：多个规则集优先级相同时，Chrome 可能先命中 ads，导致 tracking 永不被选中
// 分类：
//   ads      — 广告
//   tracking — 第三方追踪器（跨站）
//   annoyances — 干扰内容
//   url_clean  — URL 参数清理
//   malware    — 恶意域名
function getRootDomain(host) {
  if (!host) return "";
  const parts = String(host).toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  // 常见多段顶级域
  const twoPartTlds = ["co", "com", "net", "org", "gov", "edu", "ac", "mil"];
  const second = parts[parts.length - 2];
  if (twoPartTlds.includes(second) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

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

function classifyRule(rulesetId, url, pageHost) {
  const u = String(url || "").toLowerCase();

  // 1) URL 参数特征：追踪参数 -> url_clean
  if (/[?&](utm_|gclid|fbclid|dclid|msclkid|yclid|twclid|spm=|scm=)/i.test(u)) {
    return "url_clean";
  }

  // 2) 解析当前请求的主机
  let reqHost = "";
  try { reqHost = new URL(url).hostname; } catch (e) {}

  // 3) 已知第三方追踪器 -> tracking
  if (reqHost && isThirdPartyTracker(reqHost)) return "tracking";

  // 4) 域名/路径特征含埋点关键词 -> tracking
  const isTelemetrySignal = /\/(log|logs|analytics|stats?|beacon|track|tracking|metrics?|collect|telemetry|report|impression|pixel|data|cm)(\/|\?|$)/i.test(u)
    || /^(log|logs|data|cm|beacon|analytics|track|stat|report|telemetry|metrics|ping|monitor|trace|h5-analytics|nec)\./i.test(reqHost)
    || /\.(mmstat|cnzz|umeng|talkingdata|growingio|sensorsdata)\./.test(reqHost);

  if (isTelemetrySignal) {
    return "tracking";
  }

  // 5) 回退到 rulesetId
  if (!rulesetId) return "ads";
  const id = String(rulesetId).toLowerCase();
  if (id.includes("track")) return "tracking";
  if (id.includes("annoy")) return "annoyances";
  if (id.includes("url")) return "url_clean";
  if (id.includes("malware")) return "malware";
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

  // 域名规则：||example.com^
  const m1 = line.match(/^\|\|([a-zA-Z0-9_.*-]+)\^?\$?/);
  if (m1) {
    const domain = m1[1].replace(/^\*\./, "");  // 去掉前导 *.
    return {
      id,
      priority: isException ? 100 : 2,
      action: { type: isException ? "allow" : "block" },
      condition: { requestDomains: [domain], excludedResourceTypes: ["main_frame"] }
    };
  }

  // 路径片段：/ads/
  if (line.startsWith("/")) {
    return {
      id,
      priority: isException ? 100 : 2,
      action: { type: isException ? "allow" : "block" },
      condition: { urlFilter: line, excludedResourceTypes: ["main_frame"] }
    };
  }

  // 兜底：作为 urlFilter
  return {
    id,
    priority: isException ? 100 : 2,
    action: { type: isException ? "allow" : "block" },
    condition: { urlFilter: line, excludedResourceTypes: ["main_frame"] }
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

  // 长度上限（Chrome 动态规则上限 5000）
  if (addRules.length > 5000) {
    const overflow = addRules.splice(5000);
    overflow.forEach(r => skipped.push({ line: r.condition.urlFilter || r.condition.requestDomains?.[0] || "?", reason: "超过 Chrome 5000 条上限" }));
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    // 把 ## 规则存给 cosmetic 用
    await chrome.storage.local.set({ "adshield_user_cosmetic": cosmetic });
    console.log("[AdShield] 已应用用户规则:", addRules.length, "条，元素隐藏:", cosmetic.length, "条，跳过:", skipped.length, "条");
  } catch (e) {
    console.warn("[AdShield] 用户规则应用失败", e);
    return { applied: 0, skipped: [...skipped, { line: "(全体)", reason: e.message || String(e) }], cosmetic: 0 };
  }

  return { applied: addRules.length, skipped, cosmetic: cosmetic.length };
}

/* ============ 规则订阅：在线更新 ============ */
const SUB_RULE_BASE = 300000;   // 订阅规则 ID 段（300000~399999）

/* ============ 默认订阅源（首次安装自动订阅） ============ */
const DEFAULT_SUBSCRIPTIONS = [
  { url: "https://easylist-downloads.adblockplus.org/easylistchina.txt", name: "EasyList China" },
  { url: "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_224_Chinese/filter.txt", name: "AdGuard CN" },
  { url: "https://raw.githubusercontent.com/cjx82630/cjxlist/master/cjx-annoyance.txt", name: "CJX Annoyance" },
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

// ===== 路径规则智能过滤（D2）=====
// 高价值关键词（含这些的路径规则保留）
const HIGH_VALUE_PATH_KEYWORDS = [
  "ads", "adserver", "adservice", "advert", "adframe", "admanager",
  "banner", "banners", "sponsor", "sponsored", "popunder", "popup",
  "track", "tracking", "click", "beacon", "analytics", "stat", "stats",
  "counter", "impression", "pixel", "promo", "promotion", "partner",
  "affiliate", "campaign", "telemetry", "log", "logs", "metrics",
  "collect", "report", "adtech", "adsense", "adzone", "adslot",
  "adunit", "adspace", "adserv"
];

// 低价值/危险路径模式（过滤掉）
const LOW_VALUE_PATH_PATTERNS = [
  /^\/+$/,                    // 只有斜杠
  /^\/[a-z0-9]\/?$/,           // 单字符路径（如 /a/）
  /^\/[a-z0-9]{1,2}\/$/,       // 2 字符以内
  /^\/\d+\/?$/,               // 纯数字
  /^\/[a-z]{1,2}\d*\/?$/      // 短字母+数字
];

// 评估路径规则的质量分数（0~100）
function scorePathRule(path) {
  if (!path || typeof path !== "string") return 0;
  const p = path.toLowerCase();

  // 过长（> 200）视为复杂规则，降级
  if (p.length > 200) return 10;
  // 过短（< 4）过滤
  if (p.length < 4) return 0;

  // 低价值模式直接拒绝
  for (const re of LOW_VALUE_PATH_PATTERNS) {
    if (re.test(p)) return 0;
  }

  // 命中高价值关键词：加分
  let score = 20;
  for (const kw of HIGH_VALUE_PATH_KEYWORDS) {
    if (p.includes(kw)) { score += 40; break; }
  }

  // 长度适中加分（6~50 之间最佳）
  if (p.length >= 6 && p.length <= 50) score += 20;
  else if (p.length > 50 && p.length <= 100) score += 10;
  else if (p.length > 100) score -= 10;

  // 包含通配符 * 降级（易误拦）
  if (p.includes("*") && !p.includes("ads") && !p.includes("banner")) score -= 15;

  return Math.max(0, Math.min(100, score));
}

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

  // 阶段 2：串行提交（防 dynamicRules 冲突）
  let totalOk = 0, totalFail = 0, totalRules = 0, totalChanged = 0;
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
      // 检测内容是否变化
      const oldHash = sub.lastHash;
      if (oldHash && oldHash !== newHash) {
        sub.hasUpdate = true;
        totalChanged++;
      } else if (!oldHash) {
        // 首次（无历史 hash），不标记为"更新"
        sub.hasUpdate = false;
      }
      sub.lastHash = newHash;
      sub.lastCount = result.count;
      sub.lastDomains = result.domains || 0;
      sub.lastExceptions = result.exceptions || 0;
      sub.lastPaths = result.paths || 0;
      delete sub.lastError;
      totalOk++;
      totalRules += result.count;
    } else {
      sub.lastError = result.error;
      totalFail++;
    }
  }

  s.subscriptions = subs;
  s.lastSubscriptionCheck = Date.now();
  if (totalChanged > 0) {
    s.lastSubscriptionChangeTs = Date.now();
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
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
          sendResponse(__statsBuffer);
        } else {
          const store = await chrome.storage.local.get(STATS_KEY);
          const stats = store[STATS_KEY] || { total: 0, byPage: {}, byBlocked: {}, byCategory: {}, byDate: {}, byHour: {}, recentLogs: [] };
          // 同时填充内存缓冲，避免后续每次都读 storage
          __statsBuffer = stats;
          sendResponse(stats);
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
        await chrome.storage.local.set({ "adshield_user_rules": msg.rules || [] });
        const result = await applyUserRules(msg.rules || []);
        sendResponse({ ok: true, result });
      } else if (msg && msg.type === "getSubscriptions") {
        sendResponse({ ok: true, subscriptions: s.subscriptions || [], interval: s.subscriptionInterval || 24, lastCheck: s.lastSubscriptionCheck || 0 });
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
        // 清理该订阅的规则（ID 段算法与 applySubscription 一致）
        const base = SUB_RULE_BASE + ((msg.id || 0) % 100) * 10000;
        const existing = await chrome.declarativeNetRequest.getDynamicRules();
        const removeRuleIds = existing
          .filter(r => r.id >= base && r.id < base + 10000)
          .map(r => r.id);
        if (removeRuleIds.length) {
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
        }
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

/* ============ 外部消息：官网 Turnstile 验证回调 ============ */
const TURNSTILE_KEY = "adshield_turnstile";
const TURNSTILE_ALLOWED_ORIGINS = [
  "https://adshield.j3.ink",
  "https://guihuo125.github.io"
];
// Turnstile token 有效期 5 分钟
const TURNSTILE_TTL_MS = 4.5 * 60 * 1000;

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // 校验消息来源
  let origin = sender.origin || "";
  if (!origin && sender.url) {
    try { origin = new URL(sender.url).origin; } catch (e) {}
  }
  const allowed = TURNSTILE_ALLOWED_ORIGINS.some(function (o) {
    return origin === o || origin.startsWith(o + "/");
  });
  if (!allowed) {
    console.warn("[AdShield Auth] 拒绝外部消息，来源:", origin);
    sendResponse({ ok: false, error: "origin-not-allowed" });
    return true;
  }

  // 健康检查
  if (msg && msg.type === "ping") {
    sendResponse({ ok: true, name: "AdShield", version: chrome.runtime.getManifest().version });
    return true;
  }

  // 接收 Turnstile token
  if (msg && msg.type === "turnstileToken" && msg.token) {
    (async () => {
      try {
        await chrome.storage.local.set({
          [TURNSTILE_KEY]: {
            token: String(msg.token),
            action: String(msg.action || ""),
            email: String(msg.email || ""),
            ts: Date.now()
          }
        });
        console.log("[AdShield Auth] 收到 Turnstile token，action:", msg.action);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  sendResponse({ ok: false, error: "unknown-message" });
  return true;
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
  chrome.alarms.create("adshield-sub-update", {
    periodInMinutes: Math.max(30, hours * 60)
  });
  console.log("[AdShield] 订阅更新定时器已设置：每", hours, "小时");
}

chrome.alarms.onAlarm.addListener(async (a) => {
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

  // ===== 首次安装：延迟 2 秒后自动拉取订阅（避免阻塞浏览器启动） =====
  if (needFetchDefaults) {
    setTimeout(() => {
      updateAllSubscriptions().catch((e) => {
        console.warn("[AdShield] 首次订阅拉取失败：", e);
      });
    }, 2000);
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
    applyUserRules(changes.adshield_user_rules.newValue || []);
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
    console.warn("[AdShield] 通知失败：", e);
  }
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  console.log("[AdShield] onRuleMatchedDebug 已注册");
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
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
    const rulesetId = info.rule && info.rule.rulesetId;
    const cat = classifyRule(rulesetId, info.request.url, pageHost);
    // url_clean 规则集是参数清理（重定向），不计入"拦截总数"
    // 注意：必须用 rulesetId 判断，不能用 cat（cat 基于 URL 特征可能误判）
    const isUrlClean = String(rulesetId || "").toLowerCase() === "url_clean";
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
  console.warn("[AdShield] onRuleMatchedDebug 不可用（需开发者模式加载）");
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
    console.warn("[AdShield] 启动应用用户规则失败:", e);
  }
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
    console.warn("[AdShield] 清理孤儿订阅规则失败:", e);
  }
}

// 不在启动时主动调用（由 onInstalled/onStartup 触发）

// SW 挂起前刷盘：MV3 SW 没有 beforeunload，改用 chrome.runtime.onSuspend
// 注意：Chrome MV3 中 onSuspend 事件在 SW 被终止前触发，但只有很短的时间窗口
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    try { flushStats(); } catch (e) {}
  });
}
