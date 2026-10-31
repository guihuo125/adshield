// AdShield 反拦截规避 v4 — MAIN world 部分
// 隔离世界的 window 对页面脚本不可见，全局变量伪装与真实检测必须在此完成。
// 本文件运行在页面主世界，无任何扩展权限：禁止出现 chrome.* 调用。
(function () {
  if (window.__adshield_anti_detect_main_installed__) return;
  window.__adshield_anti_detect_main_installed__ = true;

  // 隔离世界握手用一次性 nonce（两个 world 注入顺序无保证，先尝试直接读 data 属性）
  let nonce = "";
  try { nonce = document.documentElement.getAttribute("data-adshield-nonce") || ""; } catch (e) {}
  let initApplied = false;
  let reported = false;

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

  // === 2) 真实检测：读页面 window 自己的检测结果，回报给隔离世界 ===
  const DETECT_GLOBALS_TRUE = [
    "adblockDetected", "adBlockDetected", "adblockerDetected",
    "isAdBlockEnabled", "adBlockEnabled"
  ];
  const DETECT_GLOBALS_FALSE = [
    "canRunAds", "canShowAds", "adsEnabled", "adsVisible"
  ];

  function report(key) {
    reported = true;
    try { window.postMessage({ __adshieldDetected: 1, nonce, key }, "*"); } catch (e) {}
  }

  function detectOnce() {
    if (reported || !nonce) return;
    for (const key of DETECT_GLOBALS_TRUE) {
      try {
        if (window[key] === true) { report(key); return; }
      } catch (e) {}
    }
    for (const key of DETECT_GLOBALS_FALSE) {
      try {
        if (window[key] === false) { report(key + "=false"); return; }
      } catch (e) {}
    }
  }

  // 握手：隔离世界（anti-detect.js）读设置后 postMessage 告知开关状态
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__adshieldInit !== 1) return;
    // nonce 必须与 data 属性一致，拒收页面伪造的 init
    if (!d.nonce || d.nonce !== (document.documentElement.getAttribute("data-adshield-nonce") || "")) return;
    nonce = d.nonce;
    detectOnce();   // 先检测再伪装：伪装生效前把页面已有的检测结果报出去
    if (d.antiDetect === true && !initApplied) {
      initApplied = true;
      try { fakeGlobals(); } catch (e) { console.warn("[AdShield] fakeGlobals 失败", e); }
    }
  });

  detectOnce();   // document_start 第一次
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", detectOnce, { once: true });   // DOMContentLoaded 第二次
  } else {
    detectOnce();
  }
})();
