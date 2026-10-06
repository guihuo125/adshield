// AdShield 通用模态框（替代浏览器原生 confirm / alert / prompt）
(function () {
  if (window.__adshield_modal__) return;
  window.__adshield_modal__ = true;

  let overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "adshield-modal-overlay";
    overlay.innerHTML = `
      <div class="adshield-modal" role="dialog" aria-modal="true">
        <div class="adshield-modal-icon" data-icon></div>
        <div class="adshield-modal-body">
          <div class="adshield-modal-title" data-title></div>
          <div class="adshield-modal-message" data-message></div>
        </div>
        <div class="adshield-modal-actions">
          <button class="adshield-modal-btn adshield-modal-btn-cancel" data-cancel></button>
          <button class="adshield-modal-btn adshield-modal-btn-confirm" data-confirm></button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  /**
   * 自定义确认框（替代 window.confirm）
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.title='确认操作']
   * @param {string} [options.confirmText='确定']
   * @param {string} [options.cancelText='取消']
   * @param {'info'|'warning'|'danger'} [options.type='info']
   * @param {boolean} [options.alertOnly] 只显示确定按钮
   * @returns {Promise<boolean>}
   */
  window.showConfirm = function (message, options) {
    options = options || {};
    const title = options.title || "确认操作";
    const confirmText = options.confirmText || "确定";
    const cancelText = options.cancelText || "取消";
    const type = options.type || "info";
    const alertOnly = !!options.alertOnly;
    const size = options.size || "normal";    // "normal" | "large"
    const isHtml = !!options.html;            // 是否 HTML 渲染

    return new Promise((resolve) => {
      const el = ensureOverlay();
      el.setAttribute("data-type", type);
      el.setAttribute("data-size", size);
      el.setAttribute("data-alert-only", alertOnly ? "true" : "false");

      el.querySelector("[data-title]").textContent = title;
      const msgEl = el.querySelector("[data-message]");
      if (isHtml) {
        msgEl.innerHTML = message;
      } else {
        msgEl.textContent = message;
      }
      // 只显示确定按钮时，隐藏取消
      el.querySelector("[data-cancel]").style.display = alertOnly ? "none" : "";

      const iconEl = el.querySelector("[data-icon]");
      // 图标（内联 SVG）
      const ICONS = {
        info: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        warning: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        danger: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
      };
      iconEl.innerHTML = ICONS[type] || ICONS.info;

      const btnConfirm = el.querySelector("[data-confirm]");
      const btnCancel = el.querySelector("[data-cancel]");
      btnConfirm.textContent = confirmText;
      btnCancel.textContent = cancelText;

      // 显示
      requestAnimationFrame(() => el.classList.add("open"));

      function cleanup(result) {
        const cur = el;   // 捕获当前 overlay 引用（避免被新的 showConfirm 覆盖）
        cur.classList.remove("open");
        btnConfirm.removeEventListener("click", onConfirm);
        btnCancel.removeEventListener("click", onCancel);
        cur.removeEventListener("click", onOverlayClick);
        document.removeEventListener("keydown", onKey);
        // 立即置 null → 让下一次 showConfirm 创建新 overlay
        if (overlay === cur) overlay = null;
        setTimeout(() => {
          if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
        }, 180);
        resolve(result);
      }
      function onConfirm() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onOverlayClick(e) {
        if (e.target === overlay) cleanup(false);
      }
      function onKey(e) {
        if (e.key === "Escape") cleanup(false);
        if (e.key === "Enter") cleanup(true);
      }

      btnConfirm.addEventListener("click", onConfirm);
      btnCancel.addEventListener("click", onCancel);
      overlay.addEventListener("click", onOverlayClick);
      document.addEventListener("keydown", onKey);

      // 自动聚焦"取消"（安全默认）；alertOnly 时聚焦确定
      setTimeout(() => (alertOnly ? btnConfirm : btnCancel).focus(), 50);
    });
  };

  /**
   * 自定义提示框（替代 window.alert）
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.title='提示']
   * @param {string} [options.confirmText='好的']
   * @param {'info'|'warning'|'danger'} [options.type='info']
   * @returns {Promise<void>}
   */
  window.showAlert = function (message, options) {
    options = options || {};
    return window.showConfirm(message, Object.assign({
      title: "提示",
      confirmText: "好的",
      type: "info"
    }, options, { alertOnly: true })).then(() => undefined);
  };
})();
