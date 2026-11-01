// AdShield 唯一的 host 归一化入口。
//
// 背景：此前 options.js 剥 www、popup.js/background.js/cosmetic.js 不剥，
// 导致「暂停站点」在网络层、元素隐藏层、UI 层三处判定基准不同，
// 出现「请求已放行但元素仍被隐藏、弹窗却显示未暂停」的半失效状态。
//
// 约定（两条，必须同时成立）：
//   1) 存储形式：归一化后的裸域名（去协议、去路径、去 www、转小写）
//   2) 匹配方式：含子域匹配（存 example.com 则 www.example.com 也算命中）
// 这与 DNR 的 requestDomains 语义一致——requestDomains 命中的是该域及其子域。
// 只统一其中一条，三层判定依然会打架。
// 教训来源：2026-11-01 代码审查 M5（详见 REVIEW-2026-11-01.md）——
// 此前 options.js 剥 www、popup.js/background.js/cosmetic.js 不剥，
// 出现过「请求已放行但元素仍被隐藏、弹窗却显示未暂停」的半失效状态。
(function () {
  const ROOT = typeof globalThis !== "undefined" ? globalThis : self;

  // 归一化：去协议、去路径、去 www、转小写
  function normalizeHost(h) {
    return String(h == null ? "" : h).trim().toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
  }

  function isValidHost(h) {
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h);
  }

  // 归一化后的 host 是否命中当前页面（父域也算命中，与 DNR requestDomains 语义一致）
  function hostMatches(pageHost, pattern) {
    const p = normalizeHost(pageHost);
    const q = normalizeHost(pattern);
    if (!p || !q) return false;
    return p === q || p.endsWith("." + q);
  }

  // 一批 pattern 里是否有任意一个命中（用于白名单数组）
  function anyHostMatches(pageHost, patterns) {
    if (!Array.isArray(patterns)) return false;
    for (const p of patterns) {
      if (hostMatches(pageHost, p)) return true;
    }
    return false;
  }

  // 把一批 host 归一化并去重（写回存储前用，避免 example.com 与 www.example.com 占两条）
  function normalizeHostList(list) {
    const out = [];
    const seen = new Set();
    for (const h of (Array.isArray(list) ? list : [])) {
      const n = normalizeHost(h);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  // 定时暂停表里该页面是否处于暂停中。
  // pausedUntil 的键可能是 www.example.com 也可能是 example.com（历史数据两种都有），
  // 所以必须逐条做子域匹配，不能直接用 pausedUntil[host] 取值。
  function isPausedUntil(pausedUntil, pageHost, now) {
    if (!pausedUntil || typeof pausedUntil !== "object") return false;
    const t = now == null ? Date.now() : now;
    for (const key of Object.keys(pausedUntil)) {
      const until = pausedUntil[key];
      if (!until || until <= t) continue;
      if (hostMatches(pageHost, key)) return true;
    }
    return false;
  }

  // 该页面剩余的暂停时长（毫秒），无暂停返回 0
  function pausedUntilRemaining(pausedUntil, pageHost, now) {
    if (!pausedUntil || typeof pausedUntil !== "object") return 0;
    const t = now == null ? Date.now() : now;
    let max = 0;
    for (const key of Object.keys(pausedUntil)) {
      const until = pausedUntil[key];
      if (!until || until <= t) continue;
      if (hostMatches(pageHost, key) && until > max) max = until;
    }
    return max;
  }

  ROOT.adshieldHost = {
    normalizeHost,
    isValidHost,
    hostMatches,
    anyHostMatches,
    normalizeHostList,
    isPausedUntil,
    pausedUntilRemaining
  };
})();
