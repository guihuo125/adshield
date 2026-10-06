// AdShield 反拦截检测规避 v4
// 关键：不覆盖 Element/HTMLElement.prototype 的原生方法
// 优化：属性枚举隐藏、setter 同步、失败回退
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

  chrome.storage.local.get("adshield_settings", (store) => {
    if (shouldApply(store.adshield_settings)) apply();
  });

  function apply() {
    try { fakeGlobals(); } catch (e) { console.warn("[AdShield] fakeGlobals 失败", e); }
    try { injectBaitCSS(); } catch (e) { console.warn("[AdShield] injectBaitCSS 失败", e); }
    try { watchBaitElements(); } catch (e) { console.warn("[AdShield] watchBaitElements 失败", e); }
  }

  // === 1) 全局变量伪装：枚举隐藏 + setter 同步 ===
  function fakeGlobals() {
    const values = {
      canRunAds: true,
      canShowAds: true,
      adBlockDetected: false,
      adblock: false,
      Adblock: false,
      blockAdBlock: undefined,
      fuckAdBlock: undefined
    };
    for (const key of Object.keys(values)) {
      try {
        // 如果页面已有该属性（非 configurable），跳过
        const existing = Object.getOwnPropertyDescriptor(window, key);
        if (existing && existing.configurable === false) continue;

        const fakeGetter = function () {
          // 返回函数形式的探测值（部分脚本会调用 adBlockDetected()）
          const v = values[key];
          return typeof v === "function" ? v : v;
        };
        // 让 getter/setter/toString 看起来像原生
        const nativeToString = Function.prototype.toString.call(function () {});

        Object.defineProperty(window, key, {
          get: fakeGetter,
          set: function (v) {
            // 页面尝试写该变量时：同步内部值（防止检测脚本发现"只读被绕过"）
            values[key] = v;
          },
          enumerable: false,        // 隐藏枚举
          configurable: true
        });
      } catch (e) {
        // 失败回退：用赋值方式（弱化，但不报错）
        try { window[key] = values[key]; } catch (_) {}
      }
    }
  }

  // === 2) CSS 诱饵伪装：不动原型，纯样式 ===
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

  // === 3) MutationObserver：加防抖，减少回调频率 ===
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
