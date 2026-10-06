// 首屏立即给 <html> 设置 data-route 属性（避免闪烁，兼容 MV3 CSP）
(function () {
  try {
    var raw = (location.hash || "").replace("#", "") || "privacy";
    var tab = raw.split("?")[0] || "privacy";
    document.documentElement.setAttribute("data-route", tab);
  } catch (e) {
    document.documentElement.setAttribute("data-route", "privacy");
  }
})();
