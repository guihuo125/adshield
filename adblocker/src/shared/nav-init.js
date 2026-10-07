// 首屏立即给 <html> 设置 data-route 属性（避免闪烁，兼容 MV3 CSP）
(function () {
  var raw = (location.hash || "").replace("#", "") || "privacy";
  var tab = raw.split("?")[0] || "privacy";

  // 立即设置 html 属性（head 里同步执行）
  try {
    document.documentElement.setAttribute("data-route", tab);
  } catch (e) {
    document.documentElement.setAttribute("data-route", "privacy");
  }

  // DOM 就绪后设置 nav-item / panel 的 active 类
  function applyActive() {
    try {
      var navItems = document.querySelectorAll(".nav-item");
      var panels = document.querySelectorAll(".panel");
      for (var i = 0; i < navItems.length; i++) {
        navItems[i].classList.toggle("active", navItems[i].getAttribute("data-tab") === tab);
      }
      for (var j = 0; j < panels.length; j++) {
        panels[j].classList.toggle("active", panels[j].getAttribute("data-panel") === tab);
      }
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyActive);
  } else {
    applyActive();
  }
})();
