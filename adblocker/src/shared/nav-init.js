// 首屏立即根据 hash 设置侧栏/面板 active（避免闪现，兼容 MV3 CSP）
(function () {
  function apply() {
    try {
      var raw = (location.hash || "").replace("#", "") || "privacy";
      var tab = raw.split("?")[0] || "privacy";
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
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
