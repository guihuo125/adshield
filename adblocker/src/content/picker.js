// AdShield 元素拾取器
(function () {
  if (window.__adshield_picker_installed__) return;
  window.__adshield_picker_installed__ = true;

  let active = false;
  let overlay = null;

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id && !/^\d/.test(el.id)) {
      const sel = "#" + CSS.escape(el.id);
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    }
    const parts = [];
    if (el.tagName) parts.push(el.tagName.toLowerCase());
    if (typeof el.className === "string" && el.className.trim()) {
      const classes = el.className.trim().split(/\s+/).filter(c => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 3);
      for (const c of classes) parts.push("." + CSS.escape(c));
    }
    const sel = parts.join("");
    if (sel) {
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    }
    if (el.parentElement) {
      const parentSel = buildSelector(el.parentElement);
      if (parentSel) return parentSel + " > " + sel;
    }
    return sel;
  }

  /* ============ 内嵌弹窗（content script 无法用扩展页面样式，所以自带一套） ============ */
  function ensureModalStyles() {
    if (document.getElementById("__adshield_picker_modal_css__")) return;
    const style = document.createElement("style");
    style.id = "__adshield_picker_modal_css__";
    style.textContent = `
      .__adshield_dialog_overlay__ {
        position: fixed !important;
        inset: 0 !important;
        background: rgba(0, 0, 0, 0.35) !important;
        backdrop-filter: blur(2px) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 2147483647 !important;
        opacity: 0;
        transition: opacity .18s ease;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif !important;
      }
      .__adshield_dialog_overlay__.open { opacity: 1 !important; }
      .__adshield_dialog__ {
        background: #fff !important;
        border-radius: 14px !important;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25), 0 4px 12px rgba(0, 0, 0, 0.1) !important;
        padding: 22px 22px 18px !important;
        max-width: 420px !important;
        min-width: 320px !important;
        width: calc(100% - 48px) !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 14px !important;
        transform: scale(0.96);
        transition: transform .18s cubic-bezier(0.34, 1.56, 0.64, 1);
        color: #202225 !important;
        box-sizing: border-box !important;
      }
      .__adshield_dialog_overlay__.open .__adshield_dialog__ { transform: scale(1) !important; }
      .__adshield_dialog_title__ {
        font-size: 16px !important;
        font-weight: 700 !important;
        color: #202225 !important;
        letter-spacing: -0.2px !important;
        margin: 0 !important;
      }
      .__adshield_dialog_message__ {
        font-size: 13.5px !important;
        color: #636568 !important;
        line-height: 1.55 !important;
        word-break: break-word !important;
        margin: 0 !important;
      }
      .__adshield_dialog_selector__ {
        display: block !important;
        padding: 8px 12px !important;
        background: #f2f4f7 !important;
        border-radius: 6px !important;
        font-family: 'Menlo', 'Consolas', monospace !important;
        font-size: 12px !important;
        color: #0077cc !important;
        word-break: break-all !important;
        margin: 4px 0 !important;
        max-height: 100px !important;
        overflow-y: auto !important;
      }
      .__adshield_dialog_hint__ {
        font-size: 12px !important;
        color: #88898c !important;
        margin-top: 4px !important;
      }
      .__adshield_dialog_actions__ {
        display: flex !important;
        justify-content: flex-end !important;
        gap: 8px !important;
        margin-top: 6px !important;
        flex-wrap: wrap !important;
      }
      .__adshield_dialog_btn__ {
        padding: 9px 16px !important;
        border-radius: 8px !important;
        border: none !important;
        font-size: 13px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        font-family: inherit !important;
        transition: background .12s !important;
        min-width: 64px !important;
        outline: none !important;
      }
      .__adshield_dialog_btn__:hover { opacity: 0.9; }
      .__adshield_dialog_btn_cancel__ {
        background: #f2f4f7 !important;
        color: #3f4146 !important;
      }
      .__adshield_dialog_btn_cancel__:hover { background: #e0e2e5 !important; }
      .__adshield_dialog_btn_primary__ {
        background: #00aef0 !important;
        color: #fff !important;
      }
      .__adshield_dialog_btn_primary__:hover { background: #0077cc !important; }
      .__adshield_dialog_btn_secondary__ {
        background: #e7f6fe !important;
        color: #0077cc !important;
      }
      .__adshield_dialog_btn_secondary__:hover { background: #d4eafc !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * 显示拾取器对话框
   * @param {Object} opts
   * @param {string} opts.title
   * @param {string} [opts.message]
   * @param {string} [opts.selector] 若提供则显示选择器
   * @param {string} [opts.host]
   * @param {'alert'|'choice'} [opts.mode='alert']
   * @returns {Promise<'cancel'|'global'|'site'|void>}
   */
  function showPickerDialog(opts) {
    ensureModalStyles();
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "__adshield_dialog_overlay__";

      const selectorHtml = opts.selector
        ? `<code class="__adshield_dialog_selector__">${escapeHtml(opts.selector)}</code>`
        : "";

      const hintHtml = opts.mode === "choice"
        ? `<div class="__adshield_dialog_hint__">选择应用范围：</div>`
        : "";

      const actionsHtml = opts.mode === "choice"
        ? `
          <button class="__adshield_dialog_btn__ __adshield_dialog_btn_cancel__" data-action="cancel">取消</button>
          <button class="__adshield_dialog_btn__ __adshield_dialog_btn_secondary__" data-action="site">仅 ${escapeHtml(opts.host || "")}</button>
          <button class="__adshield_dialog_btn__ __adshield_dialog_btn_primary__" data-action="global">所有站点</button>
        `
        : `
          <button class="__adshield_dialog_btn__ __adshield_dialog_btn_primary__" data-action="ok">好的</button>
        `;

      overlay.innerHTML = `
        <div class="__adshield_dialog__">
          <h3 class="__adshield_dialog_title__">${escapeHtml(opts.title || "")}</h3>
          ${opts.message ? `<p class="__adshield_dialog_message__">${escapeHtml(opts.message)}</p>` : ""}
          ${selectorHtml}
          ${hintHtml}
          <div class="__adshield_dialog_actions__">${actionsHtml}</div>
        </div>
      `;

      (document.body || document.documentElement).appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      function cleanup(result) {
        overlay.classList.remove("open");
        document.removeEventListener("keydown", onKey);
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 180);
        resolve(result);
      }

      function onKey(ev) {
        if (ev.key === "Escape") { ev.preventDefault(); cleanup("cancel"); }
      }
      document.addEventListener("keydown", onKey, true);

      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) { cleanup("cancel"); return; }
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.getAttribute("data-action");
        if (action === "ok") cleanup();
        else cleanup(action);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "__adshield_picker_overlay__";
    overlay.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #00aef0;background:rgba(0,174,240,.15);border-radius:4px;transition:all .06s ease-out;box-shadow:0 0 0 2px rgba(255,255,255,.6)";
    document.documentElement.appendChild(overlay);
  }
  function hideOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function onMove(e) {
    if (!active) return;
    const el = e.target;
    if (!el || el === document.documentElement || el === document.body) return;
    if (el.id === "__adshield_picker_overlay__") return;
    ensureOverlay();
    const r = el.getBoundingClientRect();
    overlay.style.left = r.left + "px";
    overlay.style.top = r.top + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
  }

  async function onClick(e) {
    if (!active) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const el = e.target;
    if (!el || el === overlay) return;
    const selector = buildSelector(el);
    deactivate();
    if (!selector) {
      showPickerDialog({ title: "无法生成选择器", message: "这个元素没有可用的 CSS 选择器。", mode: "alert" });
      return;
    }
    const result = await showPickerDialog({
      title: "已生成选择器",
      selector: selector,
      host: location.hostname,
      mode: "choice"
    });
    if (result === "cancel") return;
    const fullRule = result === "global" ? "##" + selector : location.hostname + "##" + selector;
    try {
      const store = await chrome.storage.local.get("adshield_user_rules");
      const rules = store.adshield_user_rules || [];
      if (!rules.includes(fullRule)) rules.push(fullRule);
      await chrome.storage.local.set({ "adshield_user_rules": rules });
      await chrome.runtime.sendMessage({ type: "saveUserRules", rules });
      console.log("[AdShield 拾取器] 已添加规则:", fullRule);
    } catch (err) {
      showPickerDialog({ title: "保存失败", message: err.message || "未知错误", mode: "alert" });
    }
  }

  function onKey(e) {
    if (e.key === "Escape" && active) deactivate();
  }

  function activate() {
    if (active) return;
    active = true;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.body.style.cursor = "crosshair";
    console.log("[AdShield 拾取器] 已启动，按 ESC 取消");
  }

  function deactivate() {
    active = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.body.style.cursor = "";
    hideOverlay();
    console.log("[AdShield 拾取器] 已停止");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "startElementPicker") {
      activate();
      sendResponse({ ok: true });
    }
  });
})();
