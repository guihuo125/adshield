// AdShield 反拦截检测规避 v4（隔离世界部分）
// 关键：不覆盖 Element/HTMLElement.prototype 的原生方法
// 全局变量伪装已移到 MAIN world（anti-detect-main.js），本文件只负责 DOM 诱饵与握手
(function () {
  if (window.__adshield_anti_detect_installed__) return;
  window.__adshield_anti_detect_installed__ = true;

  const host = location.hostname;

  function shouldApply(s) {
    if (!s) return true;
    if (s.enabled === false) return false;
    if (s.antiDetect === false) return false;
    if (Array.isArray(s.disabledSites) && s.disabledSites.includes(host)) return false;
    const until = (s.pausedUntil || {})[host];
    if (until && until > Date.now()) return false;
    return true;
  }

  // 一次性 nonce：data 属性传给 MAIN world，隔离世界内共享（cosmetic.js 校验消息来源）
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    document.documentElement.setAttribute("data-adshield-nonce", nonce);
    window.__adshield_nonce__ = nonce;
  } catch (e) {}

  chrome.storage.local.get("adshield_settings", (store) => {
    const s = store.adshield_settings;
    // 开关状态传给 MAIN world：仅当 antiDetect 生效时才应用全局伪装
    try { window.postMessage({ __adshieldInit: 1, nonce, antiDetect: shouldApply(s) }, "*"); } catch (e) {}
    if (shouldApply(s)) apply();
  });

  function apply() {
    try { injectBaitCSS(); } catch (e) { console.warn("[AdShield] injectBaitCSS 失败", e); }
    try { watchBaitElements(); } catch (e) { console.warn("[AdShield] watchBaitElements 失败", e); }
  }

  // === 1) CSS 诱饵伪装：不动原型，纯样式 ===
  function injectBaitCSS() {
    const css = `
      [class^="ad-"][class*="banner"],
      [class*=" ad-"][class*="banner"],
      [id^="ad-banner"],
      [class^="ad-banner"],
      [class^="adsbox"],
      [class="ad"],
      [class="ads"],
      [id="ad"],
      [id="ads"],
      [id="ad-banner"] {
        min-width: 300px !important;
        min-height: 250px !important;
        position: fixed !important;
        left: -10000px !important;
        top: -10000px !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    const style = document.createElement("style");
    style.id = "__adshield_bait__";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // === 2) MutationObserver：加防抖，减少回调频率 ===
  function watchBaitElements() {
    const BAIT_RE = /(^|\s)(ad|ads|adsbox|ad-banner|advertisement|ad-placeholder)(\s|$)/i;
    let timer = 0;

    const obs = new MutationObserver((records) => {
      // 防抖：多次同步变更合并成一次处理
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        for (const rec of records) {
          for (const node of rec.addedNodes) {
            if (node.nodeType !== 1) continue;
            const cls = (typeof node.className === "string") ? node.className : "";
            const id = node.id || "";
            if (BAIT_RE.test(cls) || /^ad[-_]?/i.test(id)) {
              try {
                if (!node.hasAttribute("data-adshield-bait")) {
                  node.setAttribute("data-adshield-bait", "1");
                }
              } catch (e) {}
            }
          }
        }
      }, 100);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("pagehide", () => { obs.disconnect(); if (timer) clearTimeout(timer); }, { once: true });
  }
})();
