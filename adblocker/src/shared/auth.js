// AdShield 账号系统（Supabase 预留）
(function () {
  if (window.__adshield_auth__) return;
  window.__adshield_auth__ = true;

  // ===== Supabase 配置 =====
  const SUPABASE_URL = "https://wsfrkhgybzjpqdupbubz.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_S1HoS7Y4VCKDwvnCbk2mWQ_lZmdbl-W";

  const AUTH_KEY = "adshield_auth";

  // 校验与净化纯函数来自 shared/validate.js（独立于 chrome/DOM，可单独测试）
  const {
    translateError, validateEmail, validatePassword, validateNewPassword,
    evalPasswordStrength, maskEmail, isOfflineError,
    isSafeCssSelector, isSafeUserRule, RULE_CTRL_CHARS,
    sanitizeCloudUserRules, sanitizeCloudSubscriptions,
    sanitizeCloudWhitelist, sanitizeCloudSettings
  } = window.adshieldValidate;
  const $ = (s) => document.querySelector(s);

  // ===== 本地状态管理 =====
  async function getAuthState() {
    const store = await chrome.storage.local.get(AUTH_KEY);
    return store[AUTH_KEY] || null;
  }
  async function setAuthState(state) {
    if (state) await chrome.storage.local.set({ [AUTH_KEY]: state });
    else await chrome.storage.local.remove(AUTH_KEY);
  }

  // 翻译 Supabase 错误信息为中文


  // ===== 系统版本识别（高精度）=====
  // 缓存准确的 OS 名（异步 API 只查一次）
  let __accurateOS = null;
  let __accurateOSPromise = null;

  // 通过 User-Agent Client Hints 获取准确系统版本
  async function fetchAccurateOS() {
    if (__accurateOS) return __accurateOS;
    if (__accurateOSPromise) return __accurateOSPromise;
    __accurateOSPromise = (async () => {
      try {
        const uaData = navigator.userAgentData;
        if (!uaData || !uaData.getHighEntropyValues) {
          __accurateOS = null;
          return null;
        }
        const data = await uaData.getHighEntropyValues(["platform", "platformVersion"]);
        const platform = data.platform || "";
        const ver = data.platformVersion || "";
        if (platform === "Windows") {
          const major = parseInt(ver.split(".")[0], 10) || 0;
          if (major >= 13) return "Windows 11";
          if (major >= 1)  return "Windows 10";
          return "Windows";
        }
        if (platform === "macOS") {
          const major = parseInt(ver.split(".")[0], 10) || 0;
          if (major > 10) return "macOS " + major;      // macOS 11+
          if (major === 10) return "macOS 10." + (ver.split(".")[1] || "");
          return "macOS";
        }
        if (platform === "Linux") return "Linux";
        if (platform === "Chrome OS") return "Chrome OS";
        if (platform === "Android") {
          const major = parseInt(ver.split(".")[0], 10) || 0;
          return "Android " + major;
        }
        return platform || null;
      } catch (e) {
        return null;
      }
    })();
    __accurateOS = await __accurateOSPromise;
    return __accurateOS;
  }

  // 从 UA 解析系统（同步，作为回退）
  function parseOSFromUA(ua) {
    ua = ua || "";
    if (ua.includes("Windows NT 6.1")) return "Windows 7";
    if (ua.includes("Windows NT 6.2")) return "Windows 8";
    if (ua.includes("Windows NT 6.3")) return "Windows 8.1";
    if (ua.includes("Windows NT 6.0")) return "Windows Vista";
    if (ua.includes("Windows NT 5.1")) return "Windows XP";
    if (ua.includes("Windows NT 10")) return "Windows 10";   // 可能实际是 11（无 Client Hints 时保守显示 10）
    if (ua.includes("Windows")) return "Windows";
    if (ua.includes("Mac OS X")) {
      const m = ua.match(/Mac OS X (\d+)[_\.](\d+)/);
      if (m) return "macOS " + m[1] + "." + m[2];
      return "macOS";
    }
    if (ua.includes("Android")) {
      const m = ua.match(/Android (\d+)/);
      return m ? "Android " + m[1] : "Android";
    }
    if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
    if (ua.includes("Linux")) return "Linux";
    return "未知系统";
  }

  // 识别浏览器
  function parseBrowserFromUA(ua) {
    ua = ua || "";
    if (ua.includes("Edg/")) return "Edge";
    if (ua.includes("OPR/") || ua.includes("Opera")) return "Opera";
    if (ua.includes("Chrome/")) return "Chrome";
    if (ua.includes("Firefox/")) return "Firefox";
    if (ua.includes("Safari/") && !ua.includes("Chrome")) return "Safari";
    return "浏览器";
  }

  // 识别设备（同步版，用缓存的准确 OS 或回退 UA）
  function parseDevice(ua) {
    // 如果 ua 是当前设备的（不传参或传 navigator.userAgent），优先用缓存的准确 OS
    const isSelf = !ua || ua === navigator.userAgent;
    const os = (isSelf && __accurateOS) ? __accurateOS : parseOSFromUA(ua);
    const browser = parseBrowserFromUA(ua);
    return { os, browser, label: os + " · " + browser };
  }

  // 异步获取并更新准确 OS 到列表（首次打开时调用）
  async function ensureAccurateOS() {
    await fetchAccurateOS();
  }

  // 兼容旧调用
  function getDeviceName() {
    return parseDevice(navigator.userAgent).label;
  }

  // 根据 OS 生成图标 SVG
  function osIcon(os) {
    const o = String(os || "").toLowerCase();
    if (o.includes("windows")) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 5.5l7.5-1v7.5H3zm8.5-1.1L21 3v9H11.5zM3 13h7.5v7.5L3 19.5zm8.5 0H21v9l-9.5-1.5z"/></svg>';
    }
    if (o.includes("macos")) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.05 12.04c-.03-2.61 2.13-3.86 2.23-3.92-1.21-1.77-3.1-2.02-3.77-2.05-1.61-.16-3.13.95-3.94.95-.81 0-2.06-.92-3.39-.9-1.75.03-3.36 1.01-4.26 2.58-1.81 3.15-.46 7.81 1.3 10.37.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84s2.01.84 3.39.81c1.4-.02 2.28-1.27 3.13-2.53.99-1.45 1.4-2.86 1.42-2.93-.03-.01-2.72-1.04-2.75-4.14zM14.58 4.33c.71-.86 1.19-2.06 1.06-3.25-1.02.04-2.26.68-3 1.54-.66.76-1.23 1.98-1.08 3.15 1.14.09 2.31-.58 3.02-1.44z"/></svg>';
    }
    if (o.includes("android")) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24c-2.86-1.21-6.08-1.21-8.94 0L5.65 5.67c-.19-.29-.58-.38-.87-.2-.28.18-.37.54-.22.83l1.84 3.18C3.82 11.05 2 13.79 2 16.9h20c0-3.11-1.82-5.85-4.4-7.42zM7 14.25c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25zm10 0c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25z"/></svg>';
    }
    if (o.includes("ios")) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.05 12.04c-.03-2.61 2.13-3.86 2.23-3.92-1.21-1.77-3.1-2.02-3.77-2.05-1.61-.16-3.13.95-3.94.95-.81 0-2.06-.92-3.39-.9-1.75.03-3.36 1.01-4.26 2.58-1.81 3.15-.46 7.81 1.3 10.37.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84s2.01.84 3.39.81c1.4-.02 2.28-1.27 3.13-2.53.99-1.45 1.4-2.86 1.42-2.93-.03-.01-2.72-1.04-2.75-4.14zM14.58 4.33c.71-.86 1.19-2.06 1.06-3.25-1.02.04-2.26.68-3 1.54-.66.76-1.23 1.98-1.08 3.15 1.14.09 2.31-.58 3.02-1.44z"/></svg>';
    }
    if (o.includes("linux")) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2c-1.5 0-2.5 1.5-2.5 3v2.5c0 1.5-1 2-1.5 2.5-.5.5-1.5 1.5-1.5 3.5 0 2 1.5 3 2.5 3.5.5.25.5.75.5 1.25 0 .5-.5 1-.5 1.5 0 .5.5.75 1 .75.5 0 1-.25 1-.75.25-.75 1-1.5 1-2.5h1c0 1 .75 1.75 1 2.5 0 .5.5.75 1 .75.5 0 1-.25 1-.75 0-.5-.5-1-.5-1.5 0-.5 0-1 .5-1.25 1-.5 2.5-1.5 2.5-3.5 0-2-1-3-1.5-3.5-.5-.5-1.5-1-1.5-2.5V5c0-1.5-1-3-2.5-3zm-1.5 5.5c-.5 0-1-.5-1-1s.5-1 1-1 1 .5 1 1-.5 1-1 1zm3 0c-.5 0-1-.5-1-1s.5-1 1-1 1 .5 1 1-.5 1-1 1z"/></svg>';
    }
    // 默认：通用显示器
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
  }

  // 根据 OS 返回图标颜色 class
  function osColorClass(os) {
    const o = String(os || "").toLowerCase();
    if (o.includes("windows")) return "device-icon-win";
    if (o.includes("macos") || o.includes("ios")) return "device-icon-mac";
    if (o.includes("android")) return "device-icon-android";
    if (o.includes("linux")) return "device-icon-linux";
    return "";
  }

  // ===== 头像管理 =====
  const AVATAR_KEY = "adshield_avatar";

  async function getAvatar() {
    const store = await chrome.storage.local.get(AVATAR_KEY);
    return store[AVATAR_KEY] || null;   // { type: "color"|"image", value }
  }
  async function setAvatar(avatar) {
    if (avatar) await chrome.storage.local.set({ [AVATAR_KEY]: avatar });
    else await chrome.storage.local.remove(AVATAR_KEY);
    // 触发同步
    try {
      const state = await getAuthState();
      if (state && state.token && state.userId && state.mode === "supabase") {
        await reportDevice(state.token, state.userId);
      }
    } catch (e) {}
  }

  // 预设颜色（8 个）
  const AVATAR_PRESETS = [
    { name: "蓝",   c1: "#00aef0", c2: "#0077cc" },
    { name: "橙",   c1: "#f79009", c2: "#e07f00" },
    { name: "紫",   c1: "#8b5cf6", c2: "#7c3aed" },
    { name: "粉",   c1: "#ec4899", c2: "#db2777" },
    { name: "绿",   c1: "#10b981", c2: "#059669" },
    { name: "青",   c1: "#06b6d4", c2: "#0891b2" },
    { name: "红",   c1: "#f43f5e", c2: "#e11d48" },
    { name: "靛",   c1: "#6366f1", c2: "#4f46e5" },
    { name: "金",   c1: "#f59e0b", c2: "#d97706" },
    { name: "灰",   c1: "#64748b", c2: "#475569" }
  ];

  // 生成头像显示的 CSS 值
  function avatarStyle(avatar, fallbackEmail) {
    if (avatar && avatar.type === "image" && avatar.value) {
      return { backgroundImage: "url(" + avatar.value + ")", backgroundSize: "cover" };
    }
    if (avatar && avatar.type === "color" && avatar.value) {
      const preset = AVATAR_PRESETS.find(p => p.name === avatar.value);
      if (preset) return { background: "linear-gradient(135deg, " + preset.c1 + ", " + preset.c2 + ")" };
    }
    // 默认：邮箱哈希色
    const [c1, c2] = hashColor(fallbackEmail || "");
    return { background: "linear-gradient(135deg, " + c1 + ", " + c2 + ")" };
  }

  // ===== 图片压缩（缩放到 maxSize×maxSize，输出 JPEG）=====
  function compressImage(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("图片格式不支持"));
        img.onload = () => {
          try {
            // 计算缩放
            let w = img.naturalWidth;
            let h = img.naturalHeight;
            const ratio = Math.min(maxSize / w, maxSize / h, 1);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);

            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);

            // 输出 JPEG（体积更小）
            const out = canvas.toDataURL("image/jpeg", quality);
            resolve(out);
          } catch (e) {
            reject(e);
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // 头像修改弹窗
  // 基于 shared/modal.js 的 showFormDialog 基座：overlay / cleanup / ESC / 遮罩点击
  // 全部由基座统一处理，这里只负责「预设色块」「上传图片」「恢复默认」三件事。
  async function showAvatarPickerDialog() {
    const currentAvatar = await getAvatar();
    const state = await getAuthState();
    const email = state ? state.email : "";

    const presetHtml = AVATAR_PRESETS.map(p => {
      const selected = currentAvatar && currentAvatar.type === "color" && currentAvatar.value === p.name;
      return '<div class="avatar-option' + (selected ? ' selected' : '') + '" data-preset="' + p.name + '" style="background:linear-gradient(135deg,' + p.c1 + ',' + p.c2 + ')">' + p.name[0] + '</div>';
    }).join("");

    const html = `
      <div class="avatar-picker">
        <div>
          <div class="avatar-picker-section-title">选择预设颜色</div>
          <div class="avatar-picker-grid">${presetHtml}</div>
        </div>
        <div>
          <div class="avatar-picker-section-title">或上传图片</div>
          <button class="avatar-upload-btn" id="avatarUploadBtn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            上传图片（自动压缩）
          </button>
        </div>
        <div class="avatar-hint" id="avatarHint" style="font-size:11.5px;color:var(--text-tertiary);text-align:center;"></div>
      </div>
    `;

    return showFormDialog({
      title: "修改头像",
      bodyHtml: html,
      showIcon: false,
      cancelText: "恢复默认",
      confirmText: "关闭",
      // 「恢复默认」= 取消按钮：清掉头像后关闭
      onCancel: async () => {
        await setAvatar(null);
        await renderAccount();
      },
      onSubmit: () => true,   // 「关闭」直接关掉，不改动任何东西
      onMount: (root) => {
        // 预设色块
        root.querySelectorAll(".avatar-option").forEach(el => {
          el.addEventListener("click", async () => {
            const name = el.getAttribute("data-preset");
            await setAvatar({ type: "color", value: name });
            root.querySelectorAll(".avatar-option").forEach(x => x.classList.remove("selected"));
            el.classList.add("selected");
            await renderAccount();
          });
        });

        // 上传按钮
        const fileInput = document.getElementById("avatarFileInput");
        root.querySelector("#avatarUploadBtn").addEventListener("click", () => fileInput.click());
        fileInput.onchange = async () => {
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = "";
          if (!file) return;
          const hint = root.querySelector("#avatarHint");
          if (!file.type.startsWith("image/")) {
            hint.textContent = "请选择图片文件（JPG / PNG / WebP）";
            hint.style.color = "var(--color-danger-500)";
            return;
          }
          hint.textContent = "处理中（自动压缩到 256×256）...";
          hint.style.color = "var(--text-tertiary)";
          try {
            const dataUrl = await compressImage(file, 256, 0.85);
            await setAvatar({ type: "image", value: dataUrl });
            hint.textContent = "✅ 已更新";
            hint.style.color = "var(--color-success-600)";
            await renderAccount();
          } catch (e) {
            hint.textContent = "处理失败：" + e.message;
            hint.style.color = "var(--color-danger-500)";
          }
        };
      }
    });
  }

  // 邮箱 → 头像颜色（一致哈希）
  function hashColor(email) {
    const palette = [
      ["#00aef0", "#0077cc"],  // 蓝
      ["#f79009", "#e07f00"],  // 橙
      ["#8b5cf6", "#7c3aed"],  // 紫
      ["#ec4899", "#db2777"],  // 粉
      ["#10b981", "#059669"],  // 绿
      ["#06b6d4", "#0891b2"],  // 青
      ["#f43f5e", "#e11d48"],  // 红
      ["#6366f1", "#4f46e5"]   // 靛
    ];
    let h = 0;
    for (let i = 0; i < email.length; i++) {
      h = (h * 31 + email.charCodeAt(i)) >>> 0;
    }
    return palette[h % palette.length];
  }

  // 相对时间
  function relativeTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 2592000000) return Math.floor(diff / 86400000) + " 天前";
    return new Date(ts).toLocaleDateString("zh-CN");
  }

  // ===== UI 渲染 =====
  async function renderAccount() {
    // 会话超时检查（30 天未活动则自动登出）
    const sess = await checkSessionValidity();
    let state;
    if (sess.valid) {
      state = await getAuthState();
      touchActivity();   // 打开账号面板算一次活跃
    } else {
      state = null;
      if (sess.reason === "expired") {
        // 静默过期提示（只弹一次）
        try {
          const flag = "adshield_session_expired_notified";
          const st = await chrome.storage.local.get(flag);
          if (!st[flag]) {
            await chrome.storage.local.set({ [flag]: Date.now() });
            setTimeout(() => {
              showAlert("登录已过期，请重新登录。", { title: "会话超时", type: "warning" });
            }, 500);
          }
        } catch (e) {}
      }
    }
    const guest = document.getElementById("accountGuest");
    const user = document.getElementById("accountUser");
    const badge = document.getElementById("navAccountBadge");
    if (!guest || !user) return;

    // 隐藏骨架屏
    const skeleton = document.getElementById("accountSkeleton");
    if (skeleton) skeleton.hidden = true;

    if (state && state.email) {
      // 已登录
      guest.hidden = true;
      user.hidden = false;
      const emailEl = document.getElementById("accountEmail");
      const initialEl = document.getElementById("accountInitial");
      const avatarEl = document.getElementById("accountAvatar");
      const loginTimeEl = document.getElementById("accountLoginTime");
      if (emailEl) emailEl.textContent = state.email;
      if (initialEl) initialEl.textContent = (state.email[0] || "U").toUpperCase();
      // 头像：预设 > 上传 > 哈希色
      if (avatarEl) {
        const avatar = await getAvatar();
        const style = avatarStyle(avatar, state.email);
        // 先清空
        avatarEl.style.background = "";
        avatarEl.style.backgroundImage = "";
        if (style.backgroundImage) {
          avatarEl.style.backgroundImage = style.backgroundImage;
          avatarEl.style.backgroundSize = "cover";
          avatarEl.style.backgroundPosition = "center";
          avatarEl.classList.add("has-image");
        } else {
          avatarEl.style.background = style.background;
          avatarEl.classList.remove("has-image");
        }
      }
      if (loginTimeEl) {
        const t = state.loginAt ? new Date(state.loginAt).toLocaleString("zh-CN") : "";
        loginTimeEl.textContent = t ? "登录于 " + t : "已登录";
      }
      // 当前设备（先用 UA 快速渲染）
      const deviceNameEl = document.getElementById("accountDeviceName");
      if (deviceNameEl) {
        deviceNameEl.textContent = getDeviceName();
      }
      // 异步获取准确 OS → 再更新
      ensureAccurateOS().then(() => {
        if (deviceNameEl) deviceNameEl.textContent = getDeviceName();
        // 设备列表 + 上报活跃（用准确 OS）
        if (state.mode === "supabase" && state.token && state.userId) {
          reportDevice(state.token, state.userId).then(() => renderDevices());
        } else {
          renderDevices();
        }
      });
      // 最近同步时间
      const syncTimeEl = document.getElementById("accountSyncTime");
      if (syncTimeEl) {
        const st = state.lastSyncAt;
        if (st) {
          syncTimeEl.textContent = "最近同步：" + relativeTime(st);
          syncTimeEl.style.display = "";
        } else {
          syncTimeEl.textContent = "尚未同步";
          syncTimeEl.style.display = "";
        }
      }
      if (badge) badge.style.display = "inline-block";

      // 开发者标识（原硬编码邮箱白名单已移除，统一显示免费版）
      const planBadge = document.getElementById("accountPlanBadge");
      if (planBadge) {
        planBadge.textContent = "免费版";
        planBadge.classList.remove("account-badge-dev");
      }
    } else {
      // 未登录
      guest.hidden = false;
      user.hidden = true;
      if (badge) badge.style.display = "none";
    }
  }

  // ===== 邮箱/密码校验 =====

  // 登录校验（宽松，兼容老用户）


  // 新密码策略（严格，仅用于注册 / 重置 / 改密）


  // 渲染密码强度条（DOM 显示）
  function renderStrength(el, pwd) {
    if (!el) return;
    const s = evalPasswordStrength(pwd);
    if (!pwd) { el.innerHTML = ""; el.classList.remove("show"); return; }
    el.classList.add("show");
    el.innerHTML =
      '<div class="pwd-strength-bar">' +
        '<div class="pwd-strength-fill" data-level="' + s.level + '"></div>' +
      '</div>' +
      '<div class="pwd-strength-label" data-level="' + s.level + '">' +
        s.label +
        (s.tips.length ? '<span class="pwd-strength-tips">· ' + s.tips.slice(0, 2).join(" / ") + '</span>' : '') +
      '</div>';
  }

  // 密码强度评估（实时反馈）


  // ===== 登录失败锁定 =====
  const LOGIN_FAIL_KEY = "adshield_login_fails";
  const MAX_FAILS = 5;
  const LOCK_DURATION = 15 * 60 * 1000;   // 15 分钟

  async function getLoginFails(email) {
    if (!email) return { count: 0, until: 0 };
    const store = await chrome.storage.local.get(LOGIN_FAIL_KEY);
    const map = store[LOGIN_FAIL_KEY] || {};
    return map[email.toLowerCase()] || { count: 0, until: 0 };
  }

  async function recordLoginFail(email) {
    if (!email) return;
    const store = await chrome.storage.local.get(LOGIN_FAIL_KEY);
    const map = store[LOGIN_FAIL_KEY] || {};
    const key = email.toLowerCase();
    const entry = map[key] || { count: 0, until: 0 };
    entry.count = (entry.count || 0) + 1;
    entry.lastFail = Date.now();
    if (entry.count >= MAX_FAILS) {
      entry.until = Date.now() + LOCK_DURATION;
      entry.count = 0;
    }
    map[key] = entry;
    await chrome.storage.local.set({ [LOGIN_FAIL_KEY]: map });
  }

  async function clearLoginFail(email) {
    if (!email) return;
    const store = await chrome.storage.local.get(LOGIN_FAIL_KEY);
    const map = store[LOGIN_FAIL_KEY] || {};
    delete map[email.toLowerCase()];
    await chrome.storage.local.set({ [LOGIN_FAIL_KEY]: map });
  }

  async function checkLoginLock(email) {
    const e = await getLoginFails(email);
    if (e.until && e.until > Date.now()) {
      const mins = Math.ceil((e.until - Date.now()) / 60000);
      return { locked: true, mins, until: e.until };
    }
    return { locked: false, remaining: MAX_FAILS - (e.count || 0) };
  }

  // ===== 会话超时 =====
  const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;   // 30 天

  async function checkSessionValidity() {
    const state = await getAuthState();
    if (!state) return { valid: false, reason: "not-logged-in" };
    if (state.mode === "local") return { valid: true };
    // 判的是「多久没活跃」，不是「登录多久了」。登录后一直在用就不该被登出。
    // lastActiveAt 由 touchActivity 维护，lastSyncAt 每次同步成功都会更新。
    const lastActive = Math.max(
      state.lastActiveAt || 0,
      state.lastSyncAt || 0,
      state.lastCloudAppliedAt || 0,
      state.loginAt || 0
    );
    if (!lastActive) return { valid: true };
    if (Date.now() - lastActive > SESSION_MAX_AGE) {
      await doLogout();
      return { valid: false, reason: "expired" };
    }
    return { valid: true };
  }

  // 记录一次「用户在用扩展」，6 小时最多写一次 storage
  let __lastTouchWrite = 0;
  async function touchActivity() {
    const state = await getAuthState();
    if (!state || state.mode === "local") return;
    const now = Date.now();
    if (now - __lastTouchWrite < 6 * 60 * 60 * 1000) return;
    __lastTouchWrite = now;
    try {
      await setAuthState(Object.assign({}, state, { lastActiveAt: now }));
    } catch (e) {}
  }

  // ===== 登录尝试日志 =====
  const LOGIN_LOG_KEY = "adshield_login_log";

  async function logLoginAttempt(email, ok, reason) {
    try {
      const store = await chrome.storage.local.get(LOGIN_LOG_KEY);
      const log = store[LOGIN_LOG_KEY] || [];
      log.push({ ts: Date.now(), email: maskEmail(email), ok: !!ok, reason: reason || "" });
      if (log.length > 50) log.splice(0, log.length - 50);
      await chrome.storage.local.set({ [LOGIN_LOG_KEY]: log });
    } catch (e) {}
  }

  // ===== Supabase API 调用（未配置时走本地模式）=====
  function isSupabaseReady() {
    return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
  }

  // 网络层失败（连不上/超时）与凭据被服务端拒绝是两回事：
  // 把断网也报成「登录已过期」会把好好的会话踢掉，用户既看不懂也自救不了。
  const NET_TIMEOUT_MS = 15000;


  async function sbRequest(path, options) {
    const url = SUPABASE_URL + path;
    const headers = Object.assign({
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    }, (options && options.headers) || {});
    if (options && options.token) {
      headers["Authorization"] = "Bearer " + options.token;
    }
    console.log("[AdShield Auth] →", (options && options.method) || "GET", url);
    let resp;
    try {
      // 没有超时就没有「按钮永久停在登录中…」：连不上的时候必须自己断开并恢复界面
      resp = await fetch(url, Object.assign({}, options, {
        headers,
        signal: AbortSignal.timeout(NET_TIMEOUT_MS)
      }));
    } catch (e) {
      if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new Error("连接账号服务超时（15 秒），请检查网络后重试");
      }
      throw e;
    }
    const data = await resp.json().catch(() => ({}));
    console.log("[AdShield Auth] ←", resp.status, data);
    if (!resp.ok) {
      throw new Error(data.error_description || data.msg || data.message || data.error || ("HTTP " + resp.status));
    }
    return data;
  }

  // ===== 登录 / 注册 =====
  async function doLogin(email, password) {
    // 0) 检查登录锁定
    const lock = await checkLoginLock(email);
    if (lock.locked) {
      await logLoginAttempt(email, false, "locked");
      const err = new Error("账号已锁定，请 " + lock.mins + " 分钟后重试");
      err.code = "LOCKED";
      err.mins = lock.mins;
      throw err;
    }

    if (!isSupabaseReady()) {
      // 账号服务未配置时直接失败，不再伪造本地登录（那会让任意密码都能"登录成功"）
      throw new Error("账号服务未配置，无法登录");
    }

    // 真实模式
    try {
      const data = await sbRequest("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      // 关键：先写 authState（后续 renderAccount 需要）
      await setAuthState({
        email: data.user && data.user.email || email,
        token: data.access_token,
        refreshToken: data.refresh_token,
        userId: data.user && data.user.id,
        loginAt: Date.now(),
        lastSyncAt: Date.now(),
        mode: "supabase"
      });
      // 重新登录成功：复位「过期已提示」标记，否则下次静默过期就再也不出声了
      try { await chrome.storage.local.remove("adshield_session_expired_notified"); } catch (e) {}
      // 立即渲染 UI（不等待后台操作）
      renderAccount();
      // 后台操作：并发执行，不阻塞登录返回
      Promise.allSettled([
        clearLoginFail(email),
        logLoginAttempt(email, true, ""),
        reportDevice(data.access_token, data.user && data.user.id)
      ]).catch(() => {});
      return { ok: true, mode: "supabase" };
    } catch (e) {
      const msg = String(e.message || e);
      // 只有"密码错误 / 未验证"才计入失败次数（网络错误不算）
      if (/invalid login credentials|email not confirmed|邮箱或密码错误/i.test(msg)) {
        await recordLoginFail(email);
        await logLoginAttempt(email, false, msg);
        const after = await getLoginFails(email);
        const remaining = MAX_FAILS - (after.count || 0);
        if (remaining > 0 && remaining <= 2) {
          e.remaining = remaining;
        }
      } else {
        await logLoginAttempt(email, false, "network-error");
      }
      throw e;
    }
  }

  async function doRegister(email, password) {
    // 注册时使用严格密码策略
    const pwdCheck = validateNewPassword(password);
    if (!pwdCheck.ok) {
      const err = new Error(pwdCheck.reason);
      err.code = "WEAK_PASSWORD";
      throw err;
    }
    // 注册后不自动登录（让用户手动登录）
    if (!isSupabaseReady()) {
      throw new Error("账号服务未配置，无法注册");
    }
    const data = await sbRequest("/auth/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    // 注册成功（无论是否要邮箱验证），返回注册信息，不自动登录
    return {
      ok: true,
      mode: "supabase",
      needVerify: !data.access_token,
      registered: true,
      email: (data.user && data.user.email) || email
    };
  }

  async function doLogout() {
    await setAuthState(null);
  }

  // ===== 忘记密码（发送重置邮件）=====
  async function sendResetEmail(email) {
    if (!isSupabaseReady()) {
      throw new Error("本地演示模式暂不支持重置密码");
    }
    await sbRequest("/auth/v1/recover", {
      method: "POST",
      body: JSON.stringify({ email })
    });
    return true;
  }

  // ===== 重发验证邮件 =====
  async function resendVerificationEmail(email) {
    if (!isSupabaseReady()) {
      throw new Error("本地演示模式暂不支持");
    }
    await sbRequest("/auth/v1/resend", {
      method: "POST",
      body: JSON.stringify({ type: "signup", email })
    });
    return true;
  }

  // ===== 验证原密码（用登录 API 试一次）=====
  async function verifyPassword(email, password) {
    if (!isSupabaseReady()) return false;   // 服务未配置时不能放行，宁可拒绝
    try {
      await sbRequest("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // ===== 修改密码 =====
  async function changePassword(oldPassword, newPassword) {
    const state = await getAuthState();
    if (!state) throw new Error("未登录");
    if (state.mode === "local") {
      throw new Error("本地演示模式暂不支持修改密码");
    }
    // 先用旧密码验证身份
    const ok = await verifyPassword(state.email, oldPassword);
    if (!ok) throw new Error("原密码不正确");
    // Supabase 更新密码
    await sbRequest("/auth/v1/user", {
      method: "PUT",
      headers: { "Authorization": "Bearer " + state.token },
      body: JSON.stringify({ password: newPassword })
    });
    return true;
  }

  // ===== 删除账号：发送验证邮件 =====
  async function sendDeleteVerificationEmail(email) {
    if (!isSupabaseReady()) throw new Error("本地演示模式暂不支持");
    await sbRequest("/auth/v1/recover", {
      method: "POST",
      body: JSON.stringify({ email })
    });
    return true;
  }

  // ===== 删除账号：验证 6 位验证码，返回 access_token =====
  async function verifyDeleteCode(email, token) {
    if (!isSupabaseReady()) throw new Error("本地演示模式暂不支持");
    const data = await sbRequest("/auth/v1/verify", {
      method: "POST",
      body: JSON.stringify({ type: "recovery", email, token })
    });
    if (!data || !data.access_token) throw new Error("验证码无效");
    return data.access_token;
  }

  // ===== 删除账号 =====
  // 返回 { ok, configDeleted, authDeleted, mode, errors: [] }
  // verifyToken 可选：删除验证码验证成功后返回的新 access_token
  async function deleteAccount(verifyToken) {
    const state = await getAuthState();
    if (!state) throw new Error("未登录");

    if (state.mode === "local") {
      await setAuthState(null);
      return { ok: true, configDeleted: false, authDeleted: false, mode: "local", errors: [] };
    }

    const result = { ok: false, configDeleted: false, authDeleted: false, mode: "supabase", errors: [] };

    // 0) 优先用验证码验证返回的新 token
    let token = verifyToken || state.token;
    if (!verifyToken && state.refreshToken) {
      try {
        const r = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: state.refreshToken }),
          signal: AbortSignal.timeout(NET_TIMEOUT_MS)
        });
        if (r.ok) {
          const d = await r.json();
          if (d.access_token) token = d.access_token;
        }
      } catch (e) { /* 忽略，继续用旧 token */ }
    }

    // 1) 删除云端配置数据（adshield_configs）
    try {
      const resp = await fetch(SUPABASE_URL + SUPABASE_TABLE + "?user_id=eq." + state.userId, {
        method: "DELETE",
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + token
        },
        signal: AbortSignal.timeout(NET_TIMEOUT_MS)
      });
      if (resp.ok || resp.status === 204) {
        result.configDeleted = true;
      } else {
        const d = await resp.json().catch(() => ({}));
        result.errors.push("配置数据: " + (d.message || d.hint || ("HTTP " + resp.status)));
      }
    } catch (e) {
      result.errors.push("配置数据: " + (e.message || e));
    }

    // 2) 调用 RPC 删除 Supabase Auth 用户（用户可删除自己）
    try {
      const resp = await fetch(SUPABASE_URL + "/rest/v1/rpc/delete_own_account", {
        method: "POST",
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(NET_TIMEOUT_MS)
      });
      if (resp.ok) {
        const d = await resp.json().catch(() => ({}));
        if (d && d.ok) {
          result.authDeleted = true;
        } else {
          result.errors.push("账号: " + (d && d.error || "RPC 返回失败"));
        }
      } else {
        const d = await resp.json().catch(() => ({}));
        result.errors.push("账号: " + (d.message || d.hint || d.error || ("HTTP " + resp.status)));
      }
    } catch (e) {
      result.errors.push("账号: " + (e.message || e));
    }

    // 3) 无论云端是否成功，都清本地登录状态
    await setAuthState(null);
    result.ok = result.authDeleted;
    return result;
  }

  // ===== 删除账号：输入验证码弹窗 =====
  function showDeleteVerificationDialog(email) {
    const html = `
      <form class="del-verify-form" id="delForm" autocomplete="off">
        <input type="text" class="del-verify-input" id="delCode"
          placeholder="输入验证码" maxlength="10" required
          autocomplete="one-time-code" inputmode="numeric" />
        <div class="auth-hint" id="delHint"></div>
        <div class="del-verify-top">
          <div class="del-verify-hint">验证码已发送，请检查邮件。</div>
          <a href="#" id="delResend" class="del-verify-resend">重新发送</a>
        </div>
      </form>
    `;

    return showFormDialog({
      title: "删除账号 — 安全验证",
      bodyHtml: html,
      type: "danger",
      confirmText: "验证并删除",
      cancelText: "取消",
      focusSelector: "#delCode",
      onSubmit: (root) => {
        const codeInput = root.querySelector("#delCode");
        const hint = root.querySelector("#delHint");
        const code = (codeInput.value || "").trim();
        hint.textContent = "";
        hint.className = "auth-hint";
        if (!/^[0-9]{6,10}$/.test(code)) {
          hint.textContent = "请输入邮件中的验证码（6~10 位数字）";
          hint.classList.add("err");
          return false;   // 校验不通过，弹窗保持打开
        }
        return code;
      },
      onMount: (root) => {
        const hint = root.querySelector("#delHint");
        const btnResend = root.querySelector("#delResend");
        // 回车提交
        root.querySelector("#delForm").addEventListener("submit", (e) => {
          e.preventDefault();
          const btn = root.querySelector("[data-confirm]");
          if (btn) btn.click();
        });
        btnResend.addEventListener("click", async (e) => {
          e.preventDefault();
          btnResend.textContent = "发送中...";
          btnResend.style.pointerEvents = "none";
          try {
            await sendDeleteVerificationEmail(email);
            btnResend.textContent = "已重新发送";
            setTimeout(() => {
              btnResend.textContent = "重新发送验证码";
              btnResend.style.pointerEvents = "";
            }, 3000);
          } catch (e2) {
            const m = String(e2.message || e2);
            // 与 shared/validate.js 的 translateError 保持一致：
            // Supabase 真实报文是 "...once every N seconds"，数字在 every 之后
            const match = m.match(/(?:after|every)\s+(\d+)\s*seconds?/i);
            btnResend.textContent = match ? ("请 " + match[1] + " 秒后重试") : "发送过于频繁";
            setTimeout(() => {
              btnResend.textContent = "重新发送验证码";
              btnResend.style.pointerEvents = "";
            }, 5000);
          }
        });
      }
    });
  }

  // ===== 处理密码重置回跳 =====
  // URL 格式：chrome-extension://xxx/src/options.html#access_token=yyy&type=recovery
  async function handleRecoveryRedirect() {
    const hash = location.hash || "";
    if (!hash.includes("access_token=") || !hash.includes("type=recovery")) return false;

    // 解析参数
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    if (!accessToken) return false;

    // 清掉 URL（避免刷新时重复触发）
    history.replaceState(null, "", location.pathname + location.search);

    // 弹窗输入新密码
    const ok = await showRecoveryPasswordDialog(accessToken, refreshToken);
    if (ok) {
      await showAlert("密码已重置成功，请用新密码登录。", { title: "完成", type: "info" });
    }
    return true;
  }

  // 重置密码弹窗（从邮件链接跳回后）
  // 基于 shared/modal.js 的 showFormDialog 基座。
  async function showRecoveryPasswordDialog(accessToken, refreshToken) {
    const html = `
      <form class="auth-form" id="recForm" autocomplete="on">
        <div class="auth-field">
          <label class="auth-label">新密码</label>
          <input type="password" class="auth-input" id="recPwd" placeholder="至少 8 位，含大小写和数字" required minlength="8" maxlength="128" autocomplete="new-password" />
          <div class="pwd-strength" id="recStrength"></div>
        </div>
        <div class="auth-field">
          <label class="auth-label">确认新密码</label>
          <input type="password" class="auth-input" id="recPwd2" placeholder="再输一次" required minlength="8" maxlength="128" autocomplete="new-password" />
        </div>
        <div class="auth-hint" id="recHint"></div>
      </form>
    `;

    return showFormDialog({
      title: "重置密码",
      bodyHtml: html,
      showIcon: false,
      confirmText: "确定",
      cancelText: "取消",
      focusSelector: "#recPwd",
      onSubmit: async (root) => {
        const pwd = root.querySelector("#recPwd");
        const pwd2 = root.querySelector("#recPwd2");
        const hint = root.querySelector("#recHint");
        const btnConfirm = root.querySelector("[data-confirm]");
        const p1 = pwd.value;
        const p2 = pwd2.value;
        hint.textContent = "";
        hint.className = "auth-hint";
        const check = validateNewPassword(p1);
        if (!check.ok) { hint.textContent = check.reason; hint.classList.add("err"); return false; }
        if (p1 !== p2) { hint.textContent = "两次密码不一致"; hint.classList.add("err"); return false; }

        btnConfirm.disabled = true;
        btnConfirm.textContent = "提交中...";
        try {
          // 用 access_token 更新密码
          const resp = await fetch(SUPABASE_URL + "/auth/v1/user", {
            method: "PUT",
            headers: {
              "apikey": SUPABASE_ANON_KEY,
              "Authorization": "Bearer " + accessToken,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ password: p1 }),
            signal: AbortSignal.timeout(NET_TIMEOUT_MS)
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data.msg || data.message || ("HTTP " + resp.status));
          return true;
        } catch (e) {
          hint.textContent = translateError(e.message || e);
          hint.classList.add("err");
          btnConfirm.disabled = false;
          btnConfirm.textContent = "确定";
          return false;   // 保持弹窗打开，用户可重试
        }
      },
      onMount: (root) => {
        const pwd = root.querySelector("#recPwd");
        const strengthEl = root.querySelector("#recStrength");
        // 实时强度
        pwd.addEventListener("input", () => {
          renderStrength(strengthEl, pwd.value);
        });
        // 回车提交
        root.querySelector("#recForm").addEventListener("submit", (e) => {
          e.preventDefault();
          const btn = root.querySelector("[data-confirm]");
          if (btn) btn.click();
        });
      }
    });
  }

  // ===== 设备管理 =====
  const DEVICE_ID_KEY = "adshield_device_id";

  // 用浏览器指纹生成稳定设备 ID（移除扩展后重装仍是同一台）
  function generateFingerprint() {
    const parts = [
      navigator.userAgent,
      navigator.language,
      navigator.languages ? navigator.languages.join(",") : "",
      (screen.width || 0) + "x" + (screen.height || 0),
      screen.colorDepth || 0,
      new Date().getTimezoneOffset(),
      navigator.hardwareConcurrency || 0,
      navigator.deviceMemory || 0,
      navigator.platform || ""
    ];
    const str = parts.join("|");
    // 简单 hash（FNV-1a 32bit）
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return "fp-" + h.toString(36);
  }

  async function getDeviceId() {
    const store = await chrome.storage.local.get(DEVICE_ID_KEY);
    if (store[DEVICE_ID_KEY]) return store[DEVICE_ID_KEY];
    // 生成稳定 ID（基于指纹）
    const id = generateFingerprint();
    await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
    return id;
  }

  // 上报当前设备（带超时 + 静默重试）
  async function reportDevice(token, userId, _retry) {
    const retry = _retry || 0;
    try {
      const deviceId = await getDeviceId();
      const parsed = parseDevice(navigator.userAgent);
      const deviceName = parsed.label;

      // 15 秒超时（避免 fetch 挂起）
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);

      let resp;
      try {
        // Upsert：存在则更新 last_active（走 401→刷新→重试一次）
        resp = await withAuthRetry((tk) => fetch(SUPABASE_URL + "/rest/v1/adshield_devices?on_conflict=user_id,device_id", {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + tk,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal"
          },
          body: JSON.stringify({
            user_id: userId,
            device_id: deviceId,
            device_name: deviceName,
            user_agent: navigator.userAgent.slice(0, 200),
            last_active: new Date().toISOString()
          })
        }), token);
      } finally {
        clearTimeout(timeout);
      }

      if (!resp.ok) {
        const err = await resp.text();
        // 刷新后仍是 401/403（凭证问题，withAuthRetry 已提示过期）或已达网络重试上限
        if ((resp.status === 401 || resp.status === 403) || retry >= 3) {
          console.warn("[AdShield Device] 上报失败:", resp.status, err);
          return;
        }
        // 其它错误 → 延迟重试
        throw new Error("HTTP " + resp.status);
      }
    } catch (e) {
      // 网络错误 → 静默重试（最多 3 次，指数退避）
      if (retry < 3) {
        const delay = 3000 * Math.pow(2, retry);   // 3s, 6s, 12s
        setTimeout(() => { reportDevice(token, userId, retry + 1).catch(() => {}); }, delay);
        return;
      }
      // 超过重试上限 → 只打一次简短日志
      console.warn("[AdShield Device] 上报最终失败（已重试 3 次）");
    }
  }

  // 拉取设备列表（走 401→刷新→重试一次的路径）
  async function fetchDevices(token, userId) {
    const url = SUPABASE_URL + "/rest/v1/adshield_devices?user_id=eq." + userId + "&select=*&order=last_active.desc";
    const resp = await withAuthRetry((tk) => fetch(url, {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + tk
      },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS)
    }), token);
    if (!resp.ok) throw new Error("获取设备列表失败：" + resp.status);
    return resp.json();
  }

  // 移除设备（走 401→刷新→重试一次的路径）
  async function removeDevice(token, userId, deviceId) {
    // 必须同时按 user_id 过滤：只按 device_id 删的话，任何登录用户都能删掉别人账号的设备记录。
    // 真正的授权边界在服务端 RLS，这个过滤是客户端这一侧的兜底，不是替代品。
    const url = SUPABASE_URL + "/rest/v1/adshield_devices?user_id=eq." + encodeURIComponent(userId) +
      "&device_id=eq." + encodeURIComponent(deviceId);
    const resp = await withAuthRetry((tk) => fetch(url, {
      method: "DELETE",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + tk
      },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS)
    }), token);
    if (!resp.ok) throw new Error("移除失败：" + resp.status);
    return true;
  }

  // 简易 HTML 转义（本地工具函数）
  // HTML 转义统一走 shared/dom.js（options.html 已在 auth.js 之前加载它）
  const { escapeHtml: escapeHtmlSimple, downloadJson } = window.adshieldDom;
  // 渲染设备列表
  async function renderDevices() {
    const listEl = document.getElementById("deviceList");
    if (!listEl) return;
    const state = await getAuthState();
    const hintEl = document.getElementById("deviceHint");
    const setHint = (text, kind) => {
      if (!hintEl) return;
      hintEl.textContent = text || "";
      hintEl.className = "hint" + (kind ? " " + kind : "");
    };
    if (!state || !state.token || !state.userId || state.mode === "local") {
      listEl.innerHTML = "";
      setHint("");
      return;
    }
    listEl.innerHTML = '<li class="device-item"><span class="device-loading">加载中...</span></li>';
    setHint("正在读取登录设备…", "busy");
    try {
      const devices = await fetchDevices(state.token, state.userId);
      const currentId = await getDeviceId();
      listEl.innerHTML = "";
      if (!devices || devices.length === 0) {
        listEl.innerHTML = '<li class="device-item"><span class="device-empty">暂无设备记录</span></li>';
        return;
      }
      for (const d of devices) {
        const isCurrent = d.device_id === currentId;
        const li = document.createElement("li");
        li.className = "device-item" + (isCurrent ? " device-current" : "");
        const lastActive = d.last_active ? relativeTime(new Date(d.last_active).getTime()) : "";
        const nameHtml = escapeHtmlSimple(d.device_name || "未知设备");
        const metaHtml = lastActive ? "活跃于 " + lastActive : "";
        const badge = isCurrent ? '<span class="device-badge">本机</span>' : "";
        const action = isCurrent
          ? ""
          : '<button class="device-remove" data-device-id="' + escapeHtmlSimple(d.device_id) + '">移除</button>';
        li.innerHTML =
          '<div class="device-icon">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<rect x="2" y="3" width="20" height="14" rx="2"/>' +
              '<line x1="8" y1="21" x2="16" y2="21"/>' +
              '<line x1="12" y1="17" x2="12" y2="21"/>' +
            '</svg>' +
          '</div>' +
          '<div class="device-info">' +
            '<div class="device-name">' + nameHtml + badge + '</div>' +
            '<div class="device-meta">' + metaHtml + '</div>' +
          '</div>' +
          action;
        if (!isCurrent) {
          li.querySelector(".device-remove").addEventListener("click", async () => {
            const ok = await showConfirm("确定移除该设备？该设备将退出登录。", {
              title: "移除设备", confirmText: "移除", cancelText: "取消", type: "warning"
            });
            if (!ok) return;
            try {
              await removeDevice(state.token, state.userId, d.device_id);
              await renderDevices();
            } catch (e) {
              await showAlert("移除失败：" + (e.message || e), { title: "错误", type: "danger" });
            }
          });
        }
        listEl.appendChild(li);
      }
      setHint(devices.length + " 台设备登录过此账号", devices.length > 1 ? "ok" : undefined);
    } catch (e) {
      setHint("设备列表没读到：" + (e.message || e) + "（其余同步功能不受影响）", "err");
      listEl.innerHTML = '<li class="device-item"><span class="device-empty">加载失败：' + escapeHtmlSimple(e.message || e) + "</span></li>";
    }
  }

  // ===== 数据导出 / 导入 =====
  async function exportAllData() {
    const keys = [
      "adshield_settings",
      "adshield_user_rules",
      "adshield_user_cosmetic",
      "adshield_stats",
      "adshield_trend_pref"
    ];
    const store = await chrome.storage.local.get(keys);
    const payload = {
      _meta: {
        app: "AdShield",
        version: chrome.runtime.getManifest().version,
        exportedAt: new Date().toISOString()
      },
      data: {}
    };
    for (const k of keys) {
      if (store[k] !== undefined) payload.data[k] = store[k];
    }
    const json = JSON.stringify(payload, null, 2);
    const ts = new Date().toISOString().slice(0, 10);
    downloadJson(payload, "adshield-backup-" + ts + ".json");
    return { size: json.length, count: Object.keys(payload.data).length };
  }

  async function importAllData(file) {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      throw new Error("文件不是有效的 JSON");
    }
    if (!payload || !payload.data || typeof payload.data !== "object") {
      throw new Error("文件格式不正确（缺少 data 字段）");
    }
    // 校验 meta
    const meta = payload._meta || {};
    if (meta.app && meta.app !== "AdShield") {
      throw new Error("文件不是 AdShield 备份（" + meta.app + "）");
    }
    // 允许导入的 key
    const allowed = [
      "adshield_settings",
      "adshield_user_rules",
      "adshield_user_cosmetic",
      "adshield_stats",
      "adshield_trend_pref"
    ];
    const toSave = {};
    let count = 0;
    let skipped = 0;
    for (const [k, v] of Object.entries(payload.data)) {
      if (!allowed.includes(k)) { skipped++; continue; }
      if (k === "adshield_user_rules" || k === "adshield_user_cosmetic") {
        // 备份文件是外部输入，不能照单全收：
        // adshield_user_cosmetic 会被 cosmetic.js 直接消费（连 background 的 ## 过滤都不经过），
        // 一条含 { } 的规则就能往每个网站注入任意 CSS。
        if (!Array.isArray(v)) { skipped++; continue; }
        const clean = [];
        for (const r of v) {
          if (typeof r !== "string" || r.length > 1000 || RULE_CTRL_CHARS.test(r)) { skipped++; continue; }
          if (!isSafeUserRule(r)) { skipped++; continue; }
          clean.push(r);
        }
        toSave[k] = clean;
        count++;
        continue;
      }
      if (k === "adshield_settings") {
        if (!v || typeof v !== "object" || Array.isArray(v)) { skipped++; continue; }
      }
      toSave[k] = v;
      count++;
    }
    if (count === 0) {
      throw new Error("文件中没有可导入的数据");
    }
    await chrome.storage.local.set(toSave);
    return { count, meta, skipped };
  }

  // ===== 忘记密码弹窗 =====
  // 基于 shared/modal.js 的 showFormDialog 基座
  async function showForgotPasswordDialog(presetEmail) {
    const emailValue = presetEmail ? 'value="' + presetEmail.replace(/"/g, "&quot;") + '"' : '';
    const html = `
      <form class="auth-form" id="forgotForm" autocomplete="on">
        <div class="auth-help" style="padding: 8px 0; line-height: 1.6;">
          目前忘记密码需要<strong>联系开发者手动重置</strong>。<br>
          请发送邮件到：<br>
          <a href="mailto:guihuo125@users.noreply.github.com?subject=AdShield 密码重置请求&body=我的注册邮箱：" style="color: var(--brand-600); font-weight: 600; word-break: break-all;">
            guihuo125@users.noreply.github.com
          </a>
        </div>
        <div class="auth-field">
          <label class="auth-label">您的注册邮箱</label>
          <input type="email" class="auth-input" id="forgotEmail" placeholder="请填写注册时使用的邮箱" required autocomplete="email" ${emailValue} />
        </div>
        <div class="auth-hint" id="forgotHint"></div>
      </form>
    `;

    const r = await showFormDialog({
      title: "忘记密码",
      bodyHtml: html,
      showIcon: false,
      confirmText: "联系开发者",
      cancelText: "取消",
      focusSelector: "#forgotEmail",
      onSubmit: (root) => {
        const emailInput = root.querySelector("#forgotEmail");
        const hint = root.querySelector("#forgotHint");
        const email = emailInput.value.trim();
        hint.textContent = "";
        hint.className = "auth-hint";
        if (!validateEmail(email)) { hint.textContent = "邮箱格式不正确"; hint.classList.add("err"); return false; }
        // 打开邮件客户端（预填收件人、主题、正文）
        const to = "guihuo125@users.noreply.github.com";
        const subject = encodeURIComponent("AdShield 密码重置请求");
        const body = encodeURIComponent("您好，\n\n我的 AdShield 账号邮箱是：" + email + "\n\n请帮我重置密码，谢谢！");
        const mailto = "mailto:" + to + "?subject=" + subject + "&body=" + body;
        try {
          chrome.tabs.create({ url: mailto });
        } catch (e) {
          window.location.href = mailto;
        }
        return true;
      },
      onMount: (root) => {
        // 回车提交
        root.querySelector("#forgotForm").addEventListener("submit", (e) => {
          e.preventDefault();
          const btn = root.querySelector("[data-confirm]");
          if (btn) btn.click();
        });
      }
    });

    if (r) {
      await showAlert(
        "已打开您的邮件客户端（如果没自动打开，请手动发邮件到：\n\nguihuo125@users.noreply.github.com",
        { title: "请发送邮件", type: "info" }
      );
    }
    return !!r;
  }

  // ===== 修改密码弹窗 =====
  function showChangePasswordDialog() {
    const html = `
      <form class="auth-form" id="pwdForm" autocomplete="on">
        <div class="auth-field">
          <label class="auth-label">原密码</label>
          <input type="password" class="auth-input" id="oldPwd" placeholder="请输入当前密码" required autocomplete="current-password" />
        </div>
        <div class="auth-field">
          <label class="auth-label">新密码</label>
          <input type="password" class="auth-input" id="newPwd" placeholder="至少 8 位，含大小写和数字" required minlength="8" maxlength="128" autocomplete="new-password" />
          <div class="pwd-strength" id="newPwdStrength"></div>
        </div>
        <div class="auth-field">
          <label class="auth-label">确认新密码</label>
          <input type="password" class="auth-input" id="newPwd2" placeholder="再输一次" required minlength="8" maxlength="128" autocomplete="new-password" />
        </div>
        <div class="auth-hint" id="pwdHint"></div>
      </form>
    `;

    return showFormDialog({
      title: "修改密码",
      bodyHtml: html,
      showIcon: false,
      confirmText: "确定",
      cancelText: "取消",
      focusSelector: "#oldPwd",
      onSubmit: async (root) => {
        const oldPwd = root.querySelector("#oldPwd");
        const newPwd = root.querySelector("#newPwd");
        const newPwd2 = root.querySelector("#newPwd2");
        const hint = root.querySelector("#pwdHint");
        const btnConfirm = root.querySelector("[data-confirm]");
        const oldP = oldPwd.value;
        const p1 = newPwd.value;
        const p2 = newPwd2.value;
        hint.textContent = "";
        hint.className = "auth-hint";
        if (!oldP) { hint.textContent = "请输入原密码"; hint.classList.add("err"); return false; }
        const check = validateNewPassword(p1);
        if (!check.ok) { hint.textContent = check.reason; hint.classList.add("err"); return false; }
        if (p1 !== p2) { hint.textContent = "两次新密码不一致"; hint.classList.add("err"); return false; }
        if (oldP === p1) { hint.textContent = "新密码不能与原密码相同"; hint.classList.add("err"); return false; }

        btnConfirm.disabled = true;
        btnConfirm.textContent = "提交中...";
        try {
          await changePassword(oldP, p1);
          return true;
        } catch (e) {
          hint.textContent = translateError(e.message || e);
          hint.classList.add("err");
          btnConfirm.disabled = false;
          btnConfirm.textContent = "确定";
          return false;   // 保持弹窗打开，用户可重试
        }
      },
      onMount: (root) => {
        const newPwd = root.querySelector("#newPwd");
        const strengthEl = root.querySelector("#newPwdStrength");
        newPwd.addEventListener("input", () => {
          renderStrength(strengthEl, newPwd.value);
        });
        // 回车提交
        root.querySelector("#pwdForm").addEventListener("submit", (e) => {
          e.preventDefault();
          const btn = root.querySelector("[data-confirm]");
          if (btn) btn.click();
        });
      }
    });
  }

  // ===== 弹窗：登录 / 注册 =====
  // 基于 shared/modal.js 的 showFormDialog 基座。
  // 「切换登录/注册」用的是「关掉当前 → 用同一套 UI 再开一个」，
  // 所以这里用 showFormDialog 的 onCancel + 自定义链接实现：
  //   切换 → onCancel 里 resolve(showAuthDialog(另一种))
  //   忘记密码 → onCancel 里 resolve(null)，另开一个弹窗
  async function showAuthDialog(mode, preset) {
    // mode: "login" | "register"
    // preset: { email, notice } — 用于注册成功后预填邮箱 + 提示
    preset = preset || {};
    const isLogin = mode === "login";
    const noticeHtml = preset.notice
      ? '<div class="auth-notice auth-notice-ok">' + escapeHtmlSimple(preset.notice) + '</div>'
      : '';
    const emailValue = preset.email ? 'value="' + escapeHtmlSimple(preset.email) + '"' : '';
    const html = `
      <form class="auth-form" id="authForm" autocomplete="on">
        ${noticeHtml}
        <div class="auth-field">
          <label class="auth-label">邮箱</label>
          <input type="email" class="auth-input" id="authEmail" placeholder="you@example.com" required autocomplete="email" ${emailValue} />
        </div>
        <div class="auth-field">
          <label class="auth-label">密码</label>
          <input type="password" class="auth-input" id="authPassword"
            placeholder="${isLogin ? "请输入密码" : "至少 8 位，含大小写和数字"}"
            required minlength="${isLogin ? "1" : "8"}" maxlength="128"
            autocomplete="${isLogin ? "current-password" : "new-password"}" />
          <div class="pwd-strength" id="authPwdStrength"></div>
        </div>
        ${isLogin ? "" : '<div class="auth-field"><label class="auth-label">确认密码</label><input type="password" class="auth-input" id="authPassword2" placeholder="再输一次" required minlength="8" maxlength="128" autocomplete="new-password" /></div>'}
        <div class="auth-hint" id="authHint"></div>
        <div class="auth-switch">
          ${isLogin
            ? '还没有账号？<a href="#" data-switch="register">立即注册</a> · <a href="#" data-action="forgot">忘记密码？</a>'
            : '已有账号？<a href="#" data-switch="login">直接登录</a>'}
        </div>
        ${!isSupabaseReady() ? '<div class="auth-local-tip">⚠️ 本地演示模式（未接入云端）</div>' : ''}
      </form>
    `;

    // 切换/忘记密码：关掉当前弹窗后要走另一条路
    let redirect = null;   // { kind: "switch", mode } | { kind: "forgot", email }

    const result = await showFormDialog({
      title: isLogin ? "登录账号" : "注册账号",
      bodyHtml: html,
      showIcon: false,
      confirmText: isLogin ? "登录" : "注册",
      cancelText: "取消",
      focusSelector: "#authEmail",
      onSubmit: async (root) => {
        const emailInput = root.querySelector("#authEmail");
        const pwdInput = root.querySelector("#authPassword");
        const pwd2Input = root.querySelector("#authPassword2");
        const hint = root.querySelector("#authHint");
        const btnConfirm = root.querySelector("[data-confirm]");

        const email = emailInput.value.trim();
        const pwd = pwdInput.value;
        hint.textContent = "";
        hint.className = "auth-hint";

        if (!validateEmail(email)) {
          hint.textContent = "邮箱格式不正确";
          hint.classList.add("err");
          return false;
        }
        if (isLogin) {
          // 登录：宽松校验（老用户密码可能不符新策略）
          if (!validatePassword(pwd)) {
            hint.textContent = "请输入密码";
            hint.classList.add("err");
            return false;
          }
        } else {
          // 注册：严格校验
          const check = validateNewPassword(pwd);
          if (!check.ok) {
            hint.textContent = check.reason;
            hint.classList.add("err");
            return false;
          }
          if (pwd2Input && pwd2Input.value !== pwd) {
            hint.textContent = "两次密码不一致";
            hint.classList.add("err");
            return false;
          }
        }

        btnConfirm.disabled = true;
        btnConfirm.textContent = isLogin ? "登录中..." : "注册中...";
        try {
          const r = isLogin ? await doLogin(email, pwd) : await doRegister(email, pwd);
          if (isLogin) {
            // 登录成功：直接返回
            return { email, mode: "login", result: r };
          }
          // 注册成功：自动切换到登录页（预填邮箱 + 提示）
          const needVerify = !!(r && r.needVerify);
          const noticeText = needVerify
            ? "✅ 注册成功！验证邮件已发送到 " + email + "，请点击邮件中的链接完成验证，然后返回登录。"
            : "✅ 注册成功，请登录";
          redirect = { kind: "afterRegister", email, noticeText };
          return { email, mode: "register", result: r };
        } catch (err) {
          console.error("[AdShield Auth] 失败:", err);
          const errMsg = String(err.message || err);
          const isNotConfirmed = /email not confirmed|邮箱未验证/i.test(errMsg);
          hint.innerHTML = "";
          hint.className = "auth-hint err";
          const msgSpan = document.createElement("span");
          let displayMsg = translateError(errMsg);
          // 剩余次数提示
          if (err && err.remaining && err.remaining > 0 && err.remaining <= 2) {
            displayMsg += "（还剩 " + err.remaining + " 次机会）";
          }
          msgSpan.textContent = displayMsg;
          hint.appendChild(msgSpan);
          // 未验证邮箱：提供重发按钮
          if (isNotConfirmed && isLogin) {
            const resendLink = document.createElement("a");
            resendLink.href = "#";
            resendLink.className = "auth-notice-resend";
            resendLink.textContent = "重新发送验证邮件";
            resendLink.addEventListener("click", async (e) => {
              e.preventDefault();
              resendLink.textContent = "发送中...";
              try {
                await resendVerificationEmail(email);
                resendLink.textContent = "✅ 已重新发送";
                resendLink.style.color = "#067307";
                setTimeout(() => {
                  resendLink.textContent = "重新发送验证邮件";
                  resendLink.style.color = "";
                }, 3000);
              } catch (e2) {
                const m = String(e2.message || e2);
                if (/rate limit|email rate/i.test(m)) {
                  resendLink.textContent = "⏱ 发送过于频繁，请稍后再试";
                } else {
                  resendLink.textContent = "❌ 发送失败：" + (e2.message || e2);
                }
                setTimeout(() => {
                  resendLink.textContent = "重新发送验证邮件";
                }, 5000);
              }
            });
            hint.appendChild(document.createElement("br"));
            hint.appendChild(resendLink);
          }
          btnConfirm.disabled = false;
          btnConfirm.textContent = isLogin ? "登录" : "注册";
          return false;   // 保持弹窗打开，用户可重试
        }
      },
      onCancel: (root) => {
        const emailInput = root.querySelector("#authEmail");
        redirect = { kind: "cancel", email: emailInput ? emailInput.value.trim() : "" };
      },
      onMount: (root) => {
        const pwdInput = root.querySelector("#authPassword");
        const pwdStrengthEl = root.querySelector("#authPwdStrength");
        // 注册时实时显示密码强度
        if (!isLogin && pwdInput && pwdStrengthEl) {
          pwdInput.addEventListener("input", () => {
            renderStrength(pwdStrengthEl, pwdInput.value);
          });
        }
        // 切换登录/注册 / 忘记密码
        root.addEventListener("click", (e) => {
          const link = e.target.closest("[data-switch]");
          if (link) {
            e.preventDefault();
            redirect = { kind: "switch", mode: link.getAttribute("data-switch") };
            const btn = root.querySelector("[data-cancel]");
            if (btn) btn.click();
            return;
          }
          const forgot = e.target.closest('[data-action="forgot"]');
          if (forgot) {
            e.preventDefault();
            const emailInput = root.querySelector("#authEmail");
            redirect = { kind: "forgot", email: emailInput ? emailInput.value.trim() : "" };
            const btn = root.querySelector("[data-cancel]");
            if (btn) btn.click();
          }
        });
        // 回车提交
        root.querySelector("#authForm").addEventListener("submit", (e) => {
          e.preventDefault();
          const btn = root.querySelector("[data-confirm]");
          if (btn) btn.click();
        });
      }
    });

    // 弹窗关闭后按 redirect 分派
    if (redirect && redirect.kind === "switch") {
      return showAuthDialog(redirect.mode);
    }
    if (redirect && redirect.kind === "forgot") {
      await showForgotPasswordDialog(redirect.email);
      return null;
    }
    if (redirect && redirect.kind === "afterRegister") {
      const loginResult = await showAuthDialog("login", {
        email: redirect.email,
        notice: redirect.noticeText
      });
      // 登录成功后（或取消后）刷新 UI
      renderAccount();
      return { email: redirect.email, mode: "register", result: result && result.result, loginResult };
    }
    return result;
  }

  // ===== 云端同步 =====
  const SUPABASE_TABLE = "/rest/v1/adshield_configs";

  // 读取本地要同步的数据
  async function collectLocalData() {
    const keys = ["adshield_settings", "adshield_user_rules"];
    const store = await chrome.storage.local.get(keys);
    const settings = store.adshield_settings || {};
    const userRules = store.adshield_user_rules || [];
    return {
      settings: {
        enabled: settings.enabled,
        rulesets: settings.rulesets,
        antiDetect: settings.antiDetect,
        assist: settings.assist,
        showBadge: settings.showBadge,
        subscriptionInterval: settings.subscriptionInterval
      },
      whitelist: {
        disabledSites: settings.disabledSites || [],
        pausedUntil: settings.pausedUntil || {}
      },
      user_rules: userRules,
      subscriptions: settings.subscriptions || []
    };
  }

  // 「云端同步」里那四个勾选框的真实效果。
  // 整行 upsert 会把没提供的列写成 null，所以未勾选的块不能靠「不传」来保持不动，
  // 必须把云端现有值原样读回来填进去。
  const SYNC_PREF_KEY = "adshield_sync_prefs";
  async function readSyncPrefs() {
    let p = null;
    try { p = (await chrome.storage.local.get(SYNC_PREF_KEY))[SYNC_PREF_KEY]; } catch (e) {}
    p = p || {};
    return {
      settings: p.settings !== false,
      whitelist: p.whitelist !== false,
      user_rules: p.user_rules !== false,
      subscriptions: p.subscriptions !== false
    };
  }
  function anySyncOff(prefs) {
    return !(prefs.settings && prefs.whitelist && prefs.user_rules && prefs.subscriptions);
  }

  // 上传到云端（走 401→刷新→重试一次的路径）
  // 只取云端的 updated_at，用于上传前判断是否被别的设备改过
  async function fetchCloudUpdatedAt(token, userId) {
    const url = SUPABASE_URL + SUPABASE_TABLE + "?user_id=eq." + userId + "&select=updated_at";
    const resp = await withAuthRetry((tk) => fetch(url, {
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + tk },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS)
    }), token);
    if (!resp.ok) return 0;
    const rows = await resp.json().catch(() => null);
    if (!Array.isArray(rows) || !rows.length || !rows[0].updated_at) return 0;
    return new Date(rows[0].updated_at).getTime() || 0;
  }

  async function pushToCloud(token, userId, opts) {
    // 自动上传前先看云端有没有被别的设备改过，避免整行覆盖别人的改动。
    // 手动点「上传到云端」时传 force 跳过这项检查。
    if (!(opts && opts.force)) {
      try {
        const remoteTime = await fetchCloudUpdatedAt(token, userId);
        const st = await getAuthState();
        const localBase = Math.max((st && st.lastSyncAt) || 0, (st && st.lastCloudAppliedAt) || 0);
        if (remoteTime && localBase && remoteTime - localBase > 60000) {
          const err = new Error("云端有更新的配置，已跳过自动上传");
          err.code = "CLOUD_NEWER";
          throw err;
        }
      } catch (e) {
        if (e && e.code === "CLOUD_NEWER") throw e;
        // 探测失败（网络等）不阻塞正常上传
      }
    }
    const prefs = await readSyncPrefs();
    const data = await collectLocalData();
    if (anySyncOff(prefs)) {
      let cloudRow = null;
      let readFailed = false;
      try {
        cloudRow = await pullFromCloud(token, userId);
      } catch (e) {
        readFailed = true;
        console.log("[AdShield Sync] 读取云端原值失败:", (e && e.message) || e);
      }
      if (readFailed) {
        // 读不到云端现值就没法保证未勾选的块不被覆盖，中止本次上传比赌一把安全
        throw new Error("读不到云端配置，为避免误删未勾选的项目，本次上传已取消");
      }
      // cloudRow 为 null 表示云端还没有记录（首次上传），没有旧值需要保留
      if (cloudRow) {
        if (!prefs.settings) data.settings = cloudRow.settings || {};
        if (!prefs.whitelist) data.whitelist = cloudRow.whitelist || {};
        if (!prefs.user_rules) data.user_rules = cloudRow.user_rules || [];
        if (!prefs.subscriptions) data.subscriptions = cloudRow.subscriptions || [];
      }
    }
    const body = JSON.stringify({
      user_id: userId,
      settings: data.settings,
      whitelist: data.whitelist,
      user_rules: data.user_rules,
      subscriptions: data.subscriptions,
      updated_at: new Date().toISOString()
    });
    const resp = await withAuthRetry((tk) => fetch(SUPABASE_URL + SUPABASE_TABLE, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + tk,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: body,
      signal: AbortSignal.timeout(NET_TIMEOUT_MS)
    }), token);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error("上传失败：" + resp.status + " " + err);
    }
    // 上传成功后记录本地同步时间（用于缺陷3判断本地是否比云端新）
    try {
      const st = await getAuthState();
      if (st) await setAuthState(Object.assign({}, st, { lastSyncAt: Date.now() }));
    } catch (e) {}
    return true;
  }

  // 从云端拉取（走 401→刷新→重试一次的路径）
  async function pullFromCloud(token, userId) {
    const url = SUPABASE_URL + SUPABASE_TABLE + "?user_id=eq." + userId + "&select=*";
    const resp = await withAuthRetry((tk) => fetch(url, {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + tk
      },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS)
    }), token);
    if (!resp.ok) throw new Error("拉取失败：" + resp.status);
    const rows = await resp.json();
    if (!rows || rows.length === 0) return null;   // 云端没数据
    return rows[0];
  }

  // ===== 缺陷2：401 → 刷新 token → 只重试一次 =====
  let __authExpiredWarnAt = 0;

  // 用 refresh_token 换取新 access token，成功写回 storage
  // 用 refresh_token 换取新 access token，成功写回 storage。
  // refresh_token 是一次性的（服务端轮换），并发刷新时第二个必然失败并误报「登录已过期」，
  // 所以用单例 Promise 让并发的 401 共享同一次刷新。
  let __refreshPromise = null;
  async function refreshAccessToken() {
    if (__refreshPromise) return __refreshPromise;
    __refreshPromise = (async () => {
      const state = await getAuthState();
      if (!state || !state.refreshToken) return false;
      try {
        const r = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: state.refreshToken }),
          signal: AbortSignal.timeout(NET_TIMEOUT_MS)
        });
        if (!r.ok) return false;
        const d = await r.json();
        if (!d || !d.access_token) return false;
        const st = await getAuthState();
        if (st) await setAuthState(Object.assign({}, st, {
          token: d.access_token,
          refreshToken: d.refresh_token || st.refreshToken
        }));
        return true;
      } catch (e) {
        // 连不上 ≠ 凭据失效，返回独立状态，交给调用方区分处理
        return isOfflineError(e) ? "offline" : false;
      }
    })();
    try { return await __refreshPromise; } finally { __refreshPromise = null; }
  }

  // 刷新彻底失败（服务端明确拒绝）：必须真的退出登录。
  // 只弹一句提示而不清登录态的话，界面会一直显示「已登录」，而之后每一次同步都 401，
  // 会话又靠活跃时间续期，用户永远等不到自动登出，也就没有任何自救入口。
  async function forceRelogin() {
    try { await chrome.storage.local.remove("adshield_session_expired_notified"); } catch (e) {}
    try { await setAuthState(null); } catch (e) {}
    try { window.dispatchEvent(new Event("adshield:auth-changed")); } catch (e) {}
    try {
      if (typeof showAlert === "function") {
        showAlert("登录状态已失效，请重新登录后再同步。", { title: "需要重新登录", type: "warning" });
      }
    } catch (e) {}
  }

  // 只是连不上：保留登录态，把「没同步」说清楚
  function notifyOffline(detail) {
    const now = Date.now();
    if (now - __authExpiredWarnAt < 60000) return;
    __authExpiredWarnAt = now;
    console.log("[AdShield Sync] 网络不可用，本次同步未执行:", detail && (detail.message || detail) || "");
    try {
      if (typeof showSyncToast === "function") showSyncToast("网络不可用，未同步");
    } catch (e) {}
  }

  // doRequest(token) 返回 fetch Response；401 且有 refreshToken 时刷新后只重试一次
  async function withAuthRetry(doRequest, initialToken) {
    const state = await getAuthState();
    const firstToken = initialToken || (state && state.token);
    let resp = await doRequest(firstToken);
    if (resp && resp.status === 401) {
      if (state && state.refreshToken) {
        const ok = await refreshAccessToken();
        if (ok === true) {
          const st2 = await getAuthState();
          resp = await doRequest(st2 && st2.token);   // 只重试一次
        } else if (ok === "offline") {
          notifyOffline();
        } else {
          await forceRelogin();
        }
      } else {
        await forceRelogin();
      }
    }
    return resp;
  }

  // ===== 云端数据白名单校验 =====
  // 纯函数已移到 shared/validate.js（不碰 chrome/DOM，可单独测试），
  // 配套测试见 tools/test-validate.mjs。


  // 元素隐藏规则（## / #@#）的选择器会被原样拼进 CSS —— cosmetic.js 里是 sel + "{display:none !important;}"。
  // 含 { } @ /* 的选择器能提前闭合规则块、塞进新声明、或把后面的内容注释掉，
  // 等于往用户访问的每个网站注入任意 CSS（可伪造界面、可外传页面数据）。
  // < > 不拦：".ad > .banner" 是合法选择器，拦了会误伤用户自己的正常规则。





  // 带元素隐藏部分的用户规则要额外检查选择器；纯网络规则交给 background 的解析器，不在这里管


  // user_rules：数组；每项 string；≤1000 字符；总条数 ≤5000；元素隐藏部分的选择器不能突破 CSS 块


  // subscriptions：数组 ≤20；url 必须 ^https:// 且 new URL() 可解析且 ≤500；id 归一化 1..99


  // whitelist.disabledSites：主机名白名单；pausedUntil：键同主机校验、值为有限正整数时间戳


  // settings：只拷贝白名单键；rulesets 只接受布尔值；subscriptionInterval 必须 0..168；其余丢弃并计数


  // 写回本地：缺陷3（updated_at 冲突防护）+ 缺陷1（白名单校验，拒绝项汇总不静默丢弃）
  async function applyCloudData(cloud, opts) {
    opts = opts || {};
    if (!cloud || typeof cloud !== "object") return { applied: 0, rejected: [] };
    const cloudTime = cloud.updated_at ? (new Date(cloud.updated_at).getTime() || 0) : 0;
    const state = await getAuthState();

    // 缺陷3：本地比云端新（且云端是尚未应用过的新版本）时，先询问，默认(取消)不动本地
    if (!opts.force && state && cloudTime) {
      const lastSync = state.lastSyncAt || 0;
      const lastApplied = state.lastCloudAppliedAt || 0;
      if (lastSync > cloudTime + 60000 && cloudTime > lastApplied) {
        const overwrite = await showConfirm(
          "本地配置比云端更新（本地可能有未上传的改动）。\n\n" +
          "「用云端覆盖本地」＝丢弃本地改动、恢复云端；\n" +
          "「保留本地」＝不动本地数据，可稍后手动上传覆盖云端。",
          { title: "本地与云端冲突", confirmText: "用云端覆盖本地", cancelText: "保留本地", type: "warning" }
        );
        if (!overwrite) return { applied: 0, rejected: [], skipped: true };
      }
    }

    // 缺陷1：全部经白名单校验，被拒绝的项汇总
    const rulesRes = sanitizeCloudUserRules(cloud.user_rules);
    const subsRes = sanitizeCloudSubscriptions(cloud.subscriptions);
    const wlRes = sanitizeCloudWhitelist(cloud.whitelist);
    const stRes = sanitizeCloudSettings(cloud.settings);
    const rejected = [];
    if (rulesRes.rejected) rejected.push({ field: "user_rules", count: rulesRes.rejected, reason: "非字符串、超1000字符、含控制字符、选择器可能突破 CSS 块，或超过5000条" });
    if (subsRes.rejected) rejected.push({ field: "subscriptions", count: subsRes.rejected, reason: "订阅须为 https、可解析、≤500字符，最多20条" });
    if (wlRes.rejected) rejected.push({ field: "whitelist", count: wlRes.rejected, reason: "非法主机名，或 pausedUntil 值非有限正整数时间戳" });
    if (stRes.rejected) rejected.push({ field: "settings", count: stRes.rejected, reason: "非白名单键，或 rulesets 非布尔 / subscriptionInterval 越界(0..168)" });

    const store = await chrome.storage.local.get(["adshield_settings"]);
    const s = store.adshield_settings || {};
    // 云端某个字段"有内容但校验后一个都不剩"时保留本地原值：
    // 否则一条全非法的行就能把用户的白名单/规则/订阅清空。
    // 云端确实是空数组（用户主动清空）时仍照常覆盖。
    const wiped = (arr, keptCount) => Array.isArray(arr) && arr.length > 0 && keptCount === 0;
    const keptLocal = [];
    const prefs = await readSyncPrefs();
    if (prefs.settings) Object.assign(s, stRes.settings);                       // settings（仅白名单键）
    if (prefs.whitelist && cloud.whitelist && typeof cloud.whitelist === "object") {   // 仅当云端提供且本地开了这项时才覆盖
      if (wiped(cloud.whitelist.disabledSites, wlRes.disabledSites.length)) {
        keptLocal.push("disabledSites");
      } else {
        s.disabledSites = wlRes.disabledSites;
      }
      const pin = cloud.whitelist.pausedUntil;
      const pinCount = (pin && typeof pin === "object") ? Object.keys(pin).length : 0;
      if (pinCount > 0 && Object.keys(wlRes.pausedUntil).length === 0) {
        keptLocal.push("pausedUntil");
      } else {
        s.pausedUntil = wlRes.pausedUntil;
      }
    }
    if (prefs.subscriptions && Array.isArray(cloud.subscriptions)) {
      if (wiped(cloud.subscriptions, subsRes.list.length)) keptLocal.push("subscriptions");
      else s.subscriptions = subsRes.list;
    }
    // 拉取写本地 → storage.onChanged → 自动上传，会把刚拉下来的数据又推回云端。
    // 这一趟往返不仅多余，还会把「校验时丢掉的少数条目」以偏概全地覆盖掉云端原文，
    // 所以写入前先开一个抑制窗口，把这一轮回环挡掉（窗口结束后照常上传）。
    suppressAutoUpload(8000);
    await chrome.storage.local.set({ adshield_settings: s });
    if (prefs.user_rules && Array.isArray(cloud.user_rules)) {              // 写入的是校验后的值
      if (wiped(cloud.user_rules, rulesRes.list.length)) keptLocal.push("user_rules");
      else await chrome.storage.local.set({ adshield_user_rules: rulesRes.list });
    }

    const applied =
      rulesRes.list.length + subsRes.list.length +
      wlRes.disabledSites.length + Object.keys(wlRes.pausedUntil).length +
      Object.keys(stRes.settings).length;

    // 记录本次已应用的云端版本，供缺陷3下次比较，避免重复提示/误判
    try {
      const st = await getAuthState();
      if (st) await setAuthState(Object.assign({}, st, { lastCloudAppliedAt: cloudTime || Date.now() }));
    } catch (e) {}

    if (rejected.length) {
      const summary = rejected.map(r => r.field + " 拒绝 " + r.count + " 项（" + r.reason + "）").join("；");
      console.log("[AdShield Sync] 云端数据校验：部分项被拒绝 → " + summary);
    }
    if (keptLocal.length) {
      console.log("[AdShield Sync] 云端这些字段全部非法，已保留本地原值：" + keptLocal.join("、"));
    }
    return { applied: applied, rejected: rejected, keptLocal: keptLocal };
  }

  // ===== 自动上传（防抖 5 秒）=====
  let __autoUploadTimer = 0;
  let __autoUploadLast = 0;
  let __autoUploadRetry = 0;
  // 刚拉取完云端时，抑制「写本地 → 自动上传」这一轮回环的截止时间
  let __suppressUploadUntil = 0;
  function suppressAutoUpload(ms) {
    __suppressUploadUntil = Math.max(__suppressUploadUntil, Date.now() + ms);
  }
  async function autoUpload() {
    // 抑制窗口内不硬拦：延后到窗口结束后再传，否则这段时间里用户的真实改动会被漏掉
    if (Date.now() < __suppressUploadUntil) {
      scheduleAutoUpload(__suppressUploadUntil - Date.now() + 600);
      return;
    }
    const state = await getAuthState();
    if (!state || state.mode === "local" || !state.token || !state.userId) return;
    // 3 秒内的重复触发合并掉
    const now = Date.now();
    if (now - __autoUploadLast < 3000) return;
    __autoUploadLast = now;
    try {
      await pushToCloud(state.token, state.userId);
      console.log("[AdShield Sync] 自动上传成功");
      // 显示轻提示（右下角）
      showSyncToast("已自动同步到云端");
    } catch (e) {
      // 失败不占住节流位，否则接下来 3 秒内的改动会被静默吞掉
      __autoUploadLast = 0;
      if (e && e.code === "CLOUD_NEWER") {
        console.log("[AdShield Sync] 云端更新，跳过本次自动上传");
        showSyncToast("云端有更新，本次改动未上传");
        return;   // 冲突不自动重试，等用户在账号页处理
      }
      if (isOfflineError(e)) {
        console.log("[AdShield Sync] 自动上传未成功（网络不可用）:", e.message || e);
        showSyncToast("网络不可用，改动已存本地");
      } else {
        console.warn("[AdShield Sync] 自动上传失败:", e);
        showSyncToast("同步失败：" + (e && e.message ? e.message : e));
      }
      // 30 秒后重试一次，避免改完没换设备就永远不同步
      if (!__autoUploadRetry) {
        __autoUploadRetry = setTimeout(() => {
          __autoUploadRetry = 0;
          autoUpload().catch(() => {});
        }, 30000);
      }
    }
  }

  function scheduleAutoUpload(delay) {
    if (__autoUploadTimer) clearTimeout(__autoUploadTimer);
    const wait = (typeof delay === "number" && delay >= 0) ? delay : 5000;
    __autoUploadTimer = setTimeout(() => {
      __autoUploadTimer = 0;
      autoUpload();
    }, wait);
  }

  // 右下角轻提示
  function showSyncToast(text) {
    const id = "__adshield_sync_toast__";
    if (document.getElementById(id)) return;
    const el = document.createElement("div");
    el.id = id;
    el.className = "sync-toast";
    // 图标是固定串，用 innerHTML 没问题；正文一律走 textContent。
    // 服务端返回的错误正文可能带 HTML（代理劫持页、错误页），拼进 innerHTML 就能在设置页
    // 塞出 <form> / <meta refresh> 之类的假界面骗用户输密码。
    el.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>';
    const msg = document.createElement("span");
    msg.textContent = String(text == null ? "" : text);
    el.appendChild(msg);
    document.body.appendChild(el);
    setTimeout(() => el.classList.add("show"), 50);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 2200);
  }

  // 监听 storage 变化：设置 / 白名单 / 用户规则 变化时触发自动上传
  (function setupAutoUploadWatcher() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        // 只监听同步相关的 key
        const keys = ["adshield_settings", "adshield_user_rules"];
        const hit = keys.some(k => changes[k]);
        if (hit) scheduleAutoUpload();
      });
    } catch (e) {
      console.warn("[AdShield Sync] 无法监听 storage:", e);
    }
  })();

  // ===== 打开时检查云端是否有更新 =====
  async function checkCloudUpdate() {
    const state = await getAuthState();
    if (!state || state.mode === "local" || !state.token || !state.userId) return;

    // 本地参考时间：取 lastSyncAt 与 lastCloudAppliedAt 的较大者（缺陷3：应用云端后记录 lastCloudAppliedAt）
    const localTime = Math.max(state.lastSyncAt || 0, state.lastCloudAppliedAt || 0);
    if (!localTime) {
      // 首次：记录当前时间，避免下次误提示
      await setAuthState(Object.assign({}, state, { lastSyncAt: Date.now() }));
      return;
    }

    try {
      const cloud = await pullFromCloud(state.token, state.userId);
      if (!cloud || !cloud.updated_at) return;
      const cloudTime = new Date(cloud.updated_at).getTime();
      // 云端比本地晚 1 分钟以上（避免时间误差导致误报）→ 才提示
      if (cloudTime - localTime > 60000) {
        const ok = await showConfirm(
          "检测到云端有更新的配置，是否从云端恢复？\n\n恢复将覆盖本地设置。",
          { title: "云端有新配置", confirmText: "恢复", cancelText: "稍后", type: "info" }
        );
        if (ok) {
          // 用户已确认，force 跳过 applyCloudData 内的冲突询问；其内部会记录 lastCloudAppliedAt
          await applyCloudData(cloud, { force: true });
          location.reload();
        }
      }
    } catch (e) {
      console.log("[AdShield Sync] 检查云端失败:", e);
    }
  }

  async function doSync(direction, opts) {
    // direction: "pull" | "push" | "both"
    opts = opts || {};
    const hint = document.getElementById("syncHint");
    const state = await getAuthState();
    if (!state) return;

    if (hint) {
      hint.textContent = "正在同步...";
      hint.className = "hint";
    }

    try {
      if (!isSupabaseReady() || !state.token || state.mode === "local") {
        await new Promise(r => setTimeout(r, 400));
        if (hint) {
          hint.textContent = "⚠️ 未登录云端账号，请先退出并重新登录";
          hint.className = "hint err";
          setTimeout(() => { hint.textContent = ""; }, 5000);
        }
        return;
      }

      const token = state.token;
      const userId = state.userId;
      if (!userId) throw new Error("缺少用户 ID");

      // push：上传本地到云端
      if (direction === "push" || direction === "both") {
        if (opts.askOnConflict) {
          // 手动上传以前一律 force，另一台设备改的配置会被静默覆盖掉。
          // 现在先探测，确有冲突就问一次，用户坚持才覆盖。
          try {
            await pushToCloud(token, userId);
          } catch (e) {
            if (!e || e.code !== "CLOUD_NEWER") throw e;
            const go = await showConfirm(
              "云端配置比本地新（可能在别的设备上改过）。\n\n" +
              "「仍然上传」＝用本地覆盖云端，云端那份改动会丢失；\n" +
              "「取消」＝先不上传，可改用「从云端恢复」把两边对齐。",
              { title: "上传会覆盖云端", confirmText: "仍然上传", cancelText: "取消", type: "warning" }
            );
            if (!go) {
              if (hint) {
                hint.textContent = "已取消，本地未上传";
                hint.className = "hint";
                setTimeout(() => { hint.textContent = ""; }, 4000);
              }
              return;
            }
            await pushToCloud(token, userId, { force: true });
          }
        } else {
          await pushToCloud(token, userId, { force: true });
        }
      }
      // pull：从云端拉取（both 时不覆盖本地，先 push 后 pull 会拿到自己数据）
      if (direction === "pull") {
        const cloud = await pullFromCloud(token, userId);
        if (cloud) {
          const res = await applyCloudData(cloud);
          // 用户在冲突框里选了「保留本地」，此时什么都没改，不能再报「同步成功」
          if (res && res.skipped) {
            if (hint) {
              hint.textContent = "已保留本地，未做改动";
              hint.className = "hint";
              setTimeout(() => { hint.textContent = ""; }, 4000);
            }
            renderAccount();
            return;
          }
        } else {
          if (hint) {
            hint.textContent = "⚠️ 云端暂无数据，请先上传";
            hint.className = "hint err";
            setTimeout(() => { hint.textContent = ""; }, 4000);
            return;
          }
        }
      }

      if (hint) {
        hint.textContent = "✅ 同步成功";
        hint.className = "hint ok";
        setTimeout(() => { hint.textContent = ""; }, 3000);
      }
      renderAccount();
    } catch (e) {
      console.error("[AdShield Sync] 失败:", e);
      if (hint) {
        hint.textContent = "❌ " + (e.message || e);
        hint.className = "hint err";
      }
    }
  }

  // ===== 对外暴露 =====
  window.adshieldAuth = {
    getState: getAuthState,
    render: renderAccount,
    login: () => showAuthDialog("login"),
    register: () => showAuthDialog("register"),
    logout: doLogout,
    sync: doSync,
    exportBackup: exportAllData,
    importBackup: importAllData,
    readSyncPrefs: readSyncPrefs,
    isReady: isSupabaseReady
  };

  // ===== 事件绑定 =====
  document.addEventListener("DOMContentLoaded", () => {
    // 头像点击
    const avatarEl = document.getElementById("accountAvatar");
    if (avatarEl) {
      avatarEl.addEventListener("click", () => showAvatarPickerDialog());
    }
    // 优先获取准确 OS（异步）
    ensureAccurateOS();
    // 检查是否为密码重置回跳
    handleRecoveryRedirect().then(handled => {
      if (handled) return;
    });
    // 首次加载 2 秒后检查云端更新（避免阻塞 UI）
    setTimeout(() => checkCloudUpdate(), 2000);
    const btnLogin = document.getElementById("btnLogin");
    const btnRegister = document.getElementById("btnRegister");
    const btnLogout = document.getElementById("btnLogout");
    const btnDownload = document.getElementById("btnDownload");
    const btnUpload = document.getElementById("btnUpload");

    if (btnLogin) btnLogin.addEventListener("click", () => showAuthDialog("login"));
    if (btnRegister) btnRegister.addEventListener("click", () => showAuthDialog("register"));
    if (btnLogout) btnLogout.addEventListener("click", async () => {
      const ok = await showConfirm("确定退出登录？云端数据不会删除。", {
        title: "退出登录", confirmText: "退出", type: "warning"
      });
      if (ok) { await doLogout(); renderAccount(); }
    });
    const btnChangePassword = document.getElementById("btnChangePassword");
    const btnDeleteAccount = document.getElementById("btnDeleteAccount");
    const btnExportData = document.getElementById("btnExportData");
    const btnImportData = document.getElementById("btnImportData");
    const importFileInput = document.getElementById("importFileInput");

    if (btnExportData) btnExportData.addEventListener("click", async () => {
      try {
        const r = await exportAllData();
        await showAlert(
          "已导出 " + Math.round(r.size / 1024) + " KB 的数据文件，请在浏览器「下载」目录查看。",
          { title: "导出成功", type: "info" }
        );
      } catch (e) {
        await showAlert("导出失败：" + (e.message || e), { title: "导出失败", type: "danger" });
      }
    });

    if (btnImportData && importFileInput) {
      btnImportData.addEventListener("click", () => importFileInput.click());
      importFileInput.addEventListener("change", async () => {
        const file = importFileInput.files && importFileInput.files[0];
        importFileInput.value = "";
        if (!file) return;
        const ok = await showConfirm(
          "导入将覆盖本地现有配置（设置 / 白名单 / 自定义规则 / 统计）。\n\n确定继续？",
          { title: "导入数据", confirmText: "导入并覆盖", cancelText: "取消", type: "warning" }
        );
        if (!ok) return;
        try {
          const r = await importAllData(file);
          await showAlert(
            "已导入 " + r.count + " 项配置。" + (r.meta.version ? "\n来源版本：" + r.meta.version : "") + "\n\n页面将刷新以应用配置。",
            { title: "导入成功", type: "info" }
          );
          location.reload();
        } catch (e) {
          await showAlert("导入失败：" + (e.message || e), { title: "导入失败", type: "danger" });
        }
      });
    }

    if (btnChangePassword) btnChangePassword.addEventListener("click", async () => {
      const ok = await showChangePasswordDialog();
      if (ok) {
        await showAlert("密码已修改成功。", { title: "完成", type: "info" });
      }
    });

    if (btnDeleteAccount) btnDeleteAccount.addEventListener("click", async () => {
      const state = await getAuthState();
      if (!state || !state.email) {
        await showAlert("请先登录账号", { title: "提示", type: "info" });
        return;
      }

      // 第 1 步：确认
      const ok = await showConfirm(
        "此操作将永久删除您的账号与云端数据，不可恢复。\n\n下一步会向您的邮箱发送验证码。",
        { title: "删除账号", confirmText: "继续", cancelText: "取消", type: "danger" }
      );
      if (!ok) return;

      // 第 2 步：发送验证码
      try {
        await sendDeleteVerificationEmail(state.email);
      } catch (e) {
        const msg = translateError(e.message || e);
        // 限流时：提示用户直接用之前发送的验证码
        if (/请求过于频繁|For security purposes/i.test(e.message || e)) {
          const ok = await showConfirm(
            msg + "\n\n如果之前已收到验证码邮件，可直接输入验证。",
            { title: "请求过于频繁", confirmText: "输入验证码", cancelText: "取消", type: "warning" }
          );
          if (!ok) return;
        } else {
          await showAlert("发送验证码失败：" + msg, { title: "错误", type: "danger" });
          return;
        }
      }

      // 第 3 步：输入验证码
      const code = await showDeleteVerificationDialog(state.email);
      if (!code) return;

      // 第 4 步：验证码校验
      let verifyToken;
      try {
        verifyToken = await verifyDeleteCode(state.email, code);
      } catch (e) {
        await showAlert("验证码校验失败：" + (e.message || e), { title: "验证失败", type: "danger" });
        return;
      }

      // 第 5 步：执行删除
      try {
        const result = await deleteAccount(verifyToken);
        renderAccount();
        if (result.authDeleted) {
          await showAlert("账号已永久删除，所有云端数据已清除。", { title: "完成", type: "info" });
        } else if (result.configDeleted) {
          let msg = "已清空云端配置并退出登录。";
          if (result.errors.length) {
            msg += "\n\n账号记录未能删除：\n" + result.errors.join("\n");
          }
          await showAlert(msg, { title: "部分完成", type: "warning" });
        } else {
          let msg = "删除未完成。已退出登录。";
          if (result.errors.length) {
            msg += "\n\n" + result.errors.join("\n");
          }
          await showAlert(msg, { title: "删除失败", type: "danger" });
        }
      } catch (e) {
        await showAlert("删除失败：" + (e.message || e), { title: "错误", type: "danger" });
      }
    });

    if (btnDownload) btnDownload.addEventListener("click", async () => {
      const ok = await showConfirm(
        "从云端恢复将覆盖本地配置（白名单 / 自定义规则 / 订阅）。\n\n确定继续？",
        { title: "从云端恢复", confirmText: "恢复", type: "warning" }
      );
      if (!ok) return;
      await doSync("pull");
      // 刷新 UI（配置变了）
      if (typeof window.renderOptionsUI === "function") window.renderOptionsUI();
      else location.reload();
    });
    if (btnUpload) btnUpload.addEventListener("click", () => doSync("push", { askOnConflict: true }));

    // 首次渲染：延迟 300ms（让骨架屏展示一下）
    setTimeout(() => renderAccount(), 300);
  });

  // 登录成功后刷新 UI
  window.addEventListener("adshield:auth-changed", renderAccount);
})();
