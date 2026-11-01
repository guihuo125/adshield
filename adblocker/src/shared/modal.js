// AdShield 通用模态框（替代浏览器原生 confirm / alert / prompt）
(function () {
  if (window.__adshield_modal__) return;
  window.__adshield_modal__ = true;

  // 每个弹窗各占一层，后开的压在上面。
  // 原先全场共用一个 overlay：第二个弹窗会直接改写第一个的文案和按钮，
  // 第一个 Promise 永远等不到 resolve（调用方就此挂住），键盘还会同时触发两层。
  const stack = [];

  // 图标（内联 SVG）—— showConfirm 与 showFormDialog 共用一份
  const ICONS = {
    info: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    warning: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    danger: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
  };

  function createOverlay() {
    const el = document.createElement("div");
    el.className = "adshield-modal-overlay";
    el.innerHTML = `
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
    document.body.appendChild(el);
    stack.push(el);
    return el;
  }

  function isTop(el) {
    return stack.length > 0 && stack[stack.length - 1] === el;
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
      const el = createOverlay();
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
      iconEl.innerHTML = ICONS[type] || ICONS.info;

      const btnConfirm = el.querySelector("[data-confirm]");
      const btnCancel = el.querySelector("[data-cancel]");
      btnConfirm.textContent = confirmText;
      btnCancel.textContent = cancelText;

      // 显示
      requestAnimationFrame(() => el.classList.add("open"));

      function cleanup(result) {
        const cur = el;
        cur.classList.remove("open");
        btnConfirm.removeEventListener("click", onConfirm);
        btnCancel.removeEventListener("click", onCancel);
        cur.removeEventListener("click", onOverlayClick);
        document.removeEventListener("keydown", onKey);
        const at = stack.indexOf(cur);
        if (at >= 0) stack.splice(at, 1);
        setTimeout(() => {
          if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
        }, 180);
        resolve(result);
      }
      function onConfirm() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onOverlayClick(e) {
        // 只响应最上层那一个，否则点一下会把底下几层一起关掉
        if (e.target === el && isTop(el)) cleanup(false);
      }
      function onKey(e) {
        if (!isTop(el)) return;
        if (e.key === "Escape") cleanup(false);
        if (e.key === "Enter") cleanup(true);
      }

      btnConfirm.addEventListener("click", onConfirm);
      btnCancel.addEventListener("click", onCancel);
      el.addEventListener("click", onOverlayClick);
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

  /* ============ 表单弹窗基座 ============
     带输入框的弹窗（登录/注册/改密/验证码/找回密码/头像选择）此前在 auth.js 里
     各写了一份 overlay + cleanup + onKey + 遮罩点击，六份几乎一样、约 600 行。
     这里抽成统一的基座，auth.js 只提供「内容 HTML + 校验函数 + 提交回调」。

     与 showConfirm 的区别：
       - showConfirm：只有确认/取消，返回 boolean
       - showFormDialog：带表单，返回 Promise<结果值 | null>（取消返回 null）
     两套共用同一个 stack，因此 ESC / 遮罩点击 / 多层叠加的行为完全一致。 */

  /**
   * 带表单的弹窗。
   * @param {Object} opts
   * @param {string} opts.title              标题
   * @param {string} opts.bodyHtml           内容 HTML（调用方负责转义用户数据）
   * @param {'info'|'warning'|'danger'} [opts.type='info']
   * @param {string} [opts.confirmText='确定']
   * @param {string} [opts.cancelText='取消']
   * @param {(root:HTMLElement) => void} [opts.onMount] 挂载后拿到弹窗根节点，用于绑定额外事件
   * @param {(root:HTMLElement) => any} opts.onSubmit 点击「确定」时的处理函数
   *        返回 undefined/false 表示校验未通过（弹窗保持打开）；
   *        返回其它值则视为结果，关闭弹窗并 resolve 该值。
   * @param {(root:HTMLElement) => void} [opts.onCancel] 取消时的额外清理
   * @param {string} [opts.focusSelector] 打开后自动聚焦的元素选择器
   * @returns {Promise<any>} 取消时 resolve(null)
   */
  window.showFormDialog = function (opts) {
    opts = opts || {};
    const type = opts.type || "info";
    const confirmText = opts.confirmText || "确定";
    const cancelText = opts.cancelText || "取消";

    return new Promise((resolve) => {
      const el = createOverlay();
      el.setAttribute("data-type", type);
      el.setAttribute("data-size", opts.size || "normal");
      el.setAttribute("data-alert-only", "false");

      el.querySelector("[data-title]").textContent = opts.title || "";
      el.querySelector("[data-message]").innerHTML = opts.bodyHtml || "";
      const iconEl = el.querySelector("[data-icon]");
      if (iconEl) {
        // showIcon: false 用于头像选择器这类「纯内容」弹窗
        iconEl.innerHTML = opts.showIcon === false ? "" : (ICONS[type] || ICONS.info);
        iconEl.style.display = opts.showIcon === false ? "none" : "";
      }

      const btnConfirm = el.querySelector("[data-confirm]");
      const btnCancel = el.querySelector("[data-cancel]");
      btnConfirm.textContent = confirmText;
      btnCancel.textContent = cancelText;

      requestAnimationFrame(() => el.classList.add("open"));

      let settled = false;
      function cleanup(result) {
        if (settled) return;
        settled = true;
        cur.classList.remove("open");
        btnConfirm.removeEventListener("click", onConfirm);
        btnCancel.removeEventListener("click", onCancel);
        cur.removeEventListener("click", onOverlayClick);
        document.removeEventListener("keydown", onKey);
        const at = stack.indexOf(cur);
        if (at >= 0) stack.splice(at, 1);
        setTimeout(() => {
          if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
        }, 180);
        resolve(result === undefined ? null : result);
      }
      const cur = el;

      function onConfirm() {
        // onSubmit 返回 false 表示校验未通过，弹窗保持打开
        let r;
        try { r = opts.onSubmit ? opts.onSubmit(cur) : true; }
        catch (e) { console.error("[AdShield] 表单弹窗提交出错:", e); return; }
        if (r === false || r === undefined) return;
        cleanup(r);
      }
      function onCancel() {
        try { if (opts.onCancel) opts.onCancel(cur); } catch (e) { console.error(e); }
        cleanup(null);
      }
      function onOverlayClick(e) {
        if (e.target === el && isTop(el)) onCancel();
      }
      function onKey(e) {
        if (!isTop(el)) return;
        // Escape 取消；Enter 提交（表单里按回车也应生效）
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        else if (e.key === "Enter" && !e.shiftKey) {
          const tag = (e.target && e.target.tagName || "").toLowerCase();
          if (tag === "textarea") return;
          e.preventDefault();
          onConfirm();
        }
      }

      btnConfirm.addEventListener("click", onConfirm);
      btnCancel.addEventListener("click", onCancel);
      el.addEventListener("click", onOverlayClick);
      document.addEventListener("keydown", onKey);

      // 挂载后交给调用方绑定额外事件（重发验证码、强度条等）
      try { if (opts.onMount) opts.onMount(cur); } catch (e) { console.error("[AdShield] 表单弹窗挂载出错:", e); }

      if (opts.focusSelector) {
        const target = cur.querySelector(opts.focusSelector);
        if (target) setTimeout(() => target.focus(), 50);
      }
    });
  };
})();
