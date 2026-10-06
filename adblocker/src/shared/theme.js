// AdShield 主题管理（light / dark / auto）
(function() {
  "use strict";
  
  const KEY = "adshield_settings";
  
  function applyTheme(theme) {
    const effective = theme === "auto"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.setAttribute("data-theme", effective);
    // 同时把 meta color-scheme 更新（浏览器 UI 跟随）
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", effective === "dark" ? "dark" : "light");
  }
  
  // 立即读取并应用（尽量早，减少闪烁）
  chrome.storage.local.get(KEY, (store) => {
    const settings = store[KEY] || {};
    applyTheme(settings.theme || "auto");
  });
  
  // 暴露给页面使用
  window.__adshield_theme__ = {
    apply: applyTheme,
    async set(theme) {
      const store = await chrome.storage.local.get(KEY);
      const settings = store[KEY] || {};
      settings.theme = theme;
      await chrome.storage.local.set({ [KEY]: settings });
      applyTheme(theme);
    }
  };
  
  // 监听系统偏好变化（仅当当前为 auto 时响应）
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
      const store = await chrome.storage.local.get(KEY);
      const settings = store[KEY] || {};
      if ((settings.theme || "auto") === "auto") {
        applyTheme("auto");
      }
    });
  }
})();
