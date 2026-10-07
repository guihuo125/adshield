// AdShield 账号系统（Supabase 预留）
(function () {
  if (window.__adshield_auth__) return;
  window.__adshield_auth__ = true;

  // ===== Supabase 配置 =====
  const SUPABASE_URL = "https://wsfrkhgybzjpqdupbubz.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_S1HoS7Y4VCKDwvnCbk2mWQ_lZmdbl-W";

  const AUTH_KEY = "adshield_auth";
  const $ = (s) => document.querySelector(s);

  // 开发者白名单（显示"开发者版"徽章 + 特权）
  const DEV_EMAILS = [
    "3900704329@qq.com"
  ];
  function isDevEmail(email) {
    return DEV_EMAILS.includes(String(email || "").toLowerCase());
  }

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
  function translateError(msg) {
    if (!msg) return "未知错误";
    const m = String(msg);
    if (m.includes("Invalid login credentials")) return "邮箱或密码错误";
    if (m.includes("User already registered")) return "该邮箱已注册，请直接登录";
    if (m.includes("Email not confirmed")) return "邮箱未验证，请先到邮箱点击验证链接";
    if (m.includes("New password should be different from the old password")) return "新密码不能与旧密码相同";
    if (m.includes("原密码不正确")) return "原密码不正确";
    if (m.includes("Password should be at least")) return "密码至少 6 位";
    if (m.includes("signup is disabled")) return "注册功能已关闭";
    if (m.includes("email rate limit exceeded")) return "验证邮件发送过于频繁，请稍后再试";
    if (m.includes("For security purposes")) {
      const match = m.match(/after (\d+) seconds?/i);
      return match ? ("请求过于频繁，请 " + match[1] + " 秒后重试") : "请求过于频繁，请稍后再试";
    }
    if (m.includes("JWT expired")) return "登录已过期，请重新登录";
    return m;
  }

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
  function showAvatarPickerDialog() {
    return new Promise(async (resolve) => {
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

      const overlay = document.createElement("div");
      overlay.className = "adshield-modal-overlay";
      overlay.setAttribute("data-type", "info");
      overlay.setAttribute("data-size", "normal");

      overlay.innerHTML = `
        <div class="adshield-modal" role="dialog" aria-modal="true">
          <div class="adshield-modal-body">
            <div class="adshield-modal-title">修改头像</div>
            <div class="adshield-modal-message"></div>
          </div>
          <div class="adshield-modal-actions">
            <button class="adshield-modal-btn adshield-modal-btn-cancel" data-reset>恢复默认</button>
            <button class="adshield-modal-btn adshield-modal-btn-confirm" data-close>关闭</button>
          </div>
        </div>
      `;
      overlay.querySelector(".adshield-modal-message").innerHTML = html;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      function cleanup() {
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 180);
      }
      function onKey(e) { if (e.key === "Escape") { cleanup(); document.removeEventListener("keydown", onKey); resolve(); } }
      document.addEventListener("keydown", onKey);

      // 预设点击
      overlay.querySelectorAll(".avatar-option").forEach(el => {
        el.addEventListener("click", async () => {
          const name = el.getAttribute("data-preset");
          await setAvatar({ type: "color", value: name });
          overlay.querySelectorAll(".avatar-option").forEach(x => x.classList.remove("selected"));
          el.classList.add("selected");
          await renderAccount();
        });
      });

      // 上传按钮
      const fileInput = document.getElementById("avatarFileInput");
      overlay.querySelector("#avatarUploadBtn").addEventListener("click", () => fileInput.click());
      fileInput.onchange = async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!file) return;
        const hint = overlay.querySelector("#avatarHint");
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

      // 恢复默认
      overlay.querySelector("[data-reset]").addEventListener("click", async () => {
        await setAvatar(null);
        await renderAccount();
        cleanup();
        document.removeEventListener("keydown", onKey);
        resolve();
      });

      // 关闭
      overlay.querySelector("[data-close]").addEventListener("click", () => {
        cleanup();
        document.removeEventListener("keydown", onKey);
        resolve();
      });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) { cleanup(); document.removeEventListener("keydown", onKey); resolve(); }
      });
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

      // 开发者标识
      const planBadge = document.getElementById("accountPlanBadge");
      if (planBadge) {
        const isDev = DEV_EMAILS.includes(String(state.email).toLowerCase());
        if (isDev) {
          planBadge.textContent = "开发者版";
          planBadge.classList.add("account-badge-dev");
        } else {
          planBadge.textContent = "免费版";
          planBadge.classList.remove("account-badge-dev");
        }
      }
    } else {
      // 未登录
      guest.hidden = false;
      user.hidden = true;
      if (badge) badge.style.display = "none";
    }
  }

  // ===== 邮箱/密码校验 =====
  function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  // 登录校验（宽松，兼容老用户）
  function validatePassword(pwd) {
    return typeof pwd === "string" && pwd.length >= 6;
  }

  // 新密码策略（严格，仅用于注册 / 重置 / 改密）
  function validateNewPassword(pwd) {
    if (typeof pwd !== "string") return { ok: false, reason: "密码格式错误" };
    if (pwd.length < 8) return { ok: false, reason: "密码至少 8 位" };
    if (pwd.length > 128) return { ok: false, reason: "密码不能超过 128 位" };
    if (!/[A-Z]/.test(pwd)) return { ok: false, reason: "需含至少 1 个大写字母" };
    if (!/[a-z]/.test(pwd)) return { ok: false, reason: "需含至少 1 个小写字母" };
    if (!/[0-9]/.test(pwd)) return { ok: false, reason: "需含至少 1 个数字" };
    // 拒绝常见弱密码
    const COMMON = ["password", "12345678", "qwerty123", "abc12345", "admin123", "11111111", "password1", "123456789"];
    if (COMMON.includes(pwd.toLowerCase())) return { ok: false, reason: "密码过于简单，请更换" };
    return { ok: true };
  }

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
  function evalPasswordStrength(pwd) {
    if (!pwd) return { score: 0, level: "empty", label: "", tips: [] };
    let score = 0;
    const tips = [];
    if (pwd.length >= 8) score += 1; else tips.push("至少 8 位");
    if (pwd.length >= 12) score += 1;
    if (/[a-z]/.test(pwd)) score += 1; else tips.push("含小写字母");
    if (/[A-Z]/.test(pwd)) score += 1; else tips.push("含大写字母");
    if (/[0-9]/.test(pwd)) score += 1; else tips.push("含数字");
    if (/[^a-zA-Z0-9]/.test(pwd)) score += 1; else tips.push("含特殊字符");

    let level, label;
    if (score <= 2) { level = "weak"; label = "弱"; }
    else if (score <= 4) { level = "medium"; label = "中"; }
    else { level = "strong"; label = "强"; }
    return { score, level, label, tips };
  }

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
    const loginAt = state.loginAt || 0;
    if (loginAt && Date.now() - loginAt > SESSION_MAX_AGE) {
      await doLogout();
      return { valid: false, reason: "expired" };
    }
    return { valid: true };
  }

  // ===== 登录尝试日志 =====
  const LOGIN_LOG_KEY = "adshield_login_log";
  function maskEmail(email) {
    if (!email) return "";
    const parts = email.split("@");
    if (parts.length !== 2) return email;
    const u = parts[0], d = parts[1];
    const masked = u.length <= 2 ? (u[0] || "") + "*" : u[0] + "***" + u.slice(-1);
    return masked + "@" + d;
  }
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
    const resp = await fetch(url, Object.assign({}, options, { headers }));
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
      // 本地模式：直接假登录
      await setAuthState({
        email,
        token: "local-" + Date.now(),
        loginAt: Date.now(),
        mode: "local"
      });
      return { ok: true, mode: "local" };
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
      return { ok: true, mode: "local", needVerify: false, registered: true, email };
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
    if (!isSupabaseReady()) return true;   // 本地模式直接通过
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
          body: JSON.stringify({ refresh_token: state.refreshToken })
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
        }
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
        body: JSON.stringify({})
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

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "adshield-modal-overlay";
      overlay.setAttribute("data-type", "danger");
      overlay.setAttribute("data-size", "normal");

      overlay.innerHTML = `
        <div class="adshield-modal" role="dialog" aria-modal="true">
          <div class="adshield-modal-icon" data-icon></div>
          <div class="adshield-modal-body">
            <div class="adshield-modal-title">删除账号 — 安全验证</div>
            <div class="adshield-modal-message"></div>
          </div>
          <div class="adshield-modal-actions">
            <button class="adshield-modal-btn adshield-modal-btn-cancel" data-cancel>取消</button>
            <button class="adshield-modal-btn adshield-modal-btn-confirm" data-confirm>验证并删除</button>
          </div>
        </div>
      `;

      const iconEl = overlay.querySelector("[data-icon]");
      iconEl.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

      overlay.querySelector(".adshield-modal-message").innerHTML = html;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      const form = overlay.querySelector("#delForm");
      const codeInput = overlay.querySelector("#delCode");
      const hint = overlay.querySelector("#delHint");
      const btnConfirm = overlay.querySelector("[data-confirm]");
      const btnCancel = overlay.querySelector("[data-cancel]");
      const btnResend = overlay.querySelector("#delResend");

      function cleanup() {
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 180);
      }

      function submit() {
        const code = (codeInput.value || "").trim();
        hint.textContent = "";
        hint.className = "auth-hint";
        if (!/^[0-9]{6,10}$/.test(code)) {
          hint.textContent = "请输入邮件中的验证码（6~10 位数字）";
          hint.classList.add("err");
          return;
        }
        cleanup();
        resolve(code);
      }

      form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
      btnConfirm.addEventListener("click", submit);
      btnCancel.addEventListener("click", () => { cleanup(); resolve(null); });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) { cleanup(); resolve(null); }
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
          const match = m.match(/after (\d+) seconds?/i);
          btnResend.textContent = match ? ("请 " + match[1] + " 秒后重试") : "发送过于频繁";
          setTimeout(() => {
            btnResend.textContent = "重新发送验证码";
            btnResend.style.pointerEvents = "";
          }, 5000);
        }
      });

      const onKey = (e) => {
        if (e.key === "Escape") { cleanup(); document.removeEventListener("keydown", onKey); resolve(null); }
      };
      document.addEventListener("keydown", onKey);

      setTimeout(() => codeInput.focus(), 50);
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
  function showRecoveryPasswordDialog(accessToken, refreshToken) {
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

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "adshield-modal-overlay";
      overlay.setAttribute("data-type", "info");
      overlay.setAttribute("data-size", "normal");
      overlay.innerHTML = `
        <div class="adshield-modal" role="dialog" aria-modal="true">
          <div class="adshield-modal-body">
            <div class="adshield-modal-title">重置密码</div>
            <div class="adshield-modal-message"></div>
          </div>
          <div class="adshield-modal-actions">
            <button class="adshield-modal-btn adshield-modal-btn-confirm" data-confirm>确定</button>
          </div>
        </div>
      `;
      overlay.querySelector(".adshield-modal-message").innerHTML = html;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      const form = overlay.querySelector("#recForm");
      const pwd = overlay.querySelector("#recPwd");
      const pwd2 = overlay.querySelector("#recPwd2");
      const hint = overlay.querySelector("#recHint");
      const strengthEl = overlay.querySelector("#recStrength");
      const btnConfirm = overlay.querySelector("[data-confirm]");

      function cleanup() {
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 180);
      }

      // 实时强度
      pwd.addEventListener("input", () => {
        renderStrength(strengthEl, pwd.value);
      });

      async function doSubmit() {
        const p1 = pwd.value;
        const p2 = pwd2.value;
        hint.textContent = "";
        hint.className = "auth-hint";
        const check = validateNewPassword(p1);
        if (!check.ok) { hint.textContent = check.reason; hint.classList.add("err"); return; }
        if (p1 !== p2) { hint.textContent = "两次密码不一致"; hint.classList.add("err"); return; }

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
            body: JSON.stringify({ password: p1 })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data.msg || data.message || ("HTTP " + resp.status));
          cleanup();
          resolve(true);
        } catch (e) {
          hint.textContent = translateError(e.message || e);
          hint.classList.add("err");
          btnConfirm.disabled = false;
          btnConfirm.textContent = "确定";
        }
      }
      form.addEventListener("submit", (e) => { e.preventDefault(); doSubmit(); });
      btnConfirm.addEventListener("click", doSubmit);
      setTimeout(() => pwd.focus(), 50);
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

  // 上报当前设备
  async function reportDevice(token, userId) {
    try {
      const deviceId = await getDeviceId();
      const parsed = parseDevice(navigator.userAgent);
      const deviceName = parsed.label;
      // Upsert：存在则更新 last_active
      const resp = await fetch(SUPABASE_URL + "/rest/v1/adshield_devices?on_conflict=user_id,device_id", {
        method: "POST",
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + token,
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
      });
      if (!resp.ok) {
        const err = await resp.text();
        console.warn("[AdShield Device] 上报失败:", resp.status, err);
      }
    } catch (e) {
      console.warn("[AdShield Device] 上报异常:", e);
    }
  }

  // 拉取设备列表
  async function fetchDevices(token, userId) {
    const url = SUPABASE_URL + "/rest/v1/adshield_devices?user_id=eq." + userId + "&select=*&order=last_active.desc";
    const resp = await fetch(url, {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token
      }
    });
    if (!resp.ok) throw new Error("获取设备列表失败：" + resp.status);
    return resp.json();
  }

  // 移除设备
  async function removeDevice(token, deviceId) {
    const url = SUPABASE_URL + "/rest/v1/adshield_devices?device_id=eq." + encodeURIComponent(deviceId);
    const resp = await fetch(url, {
      method: "DELETE",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token
      }
    });
    if (!resp.ok) throw new Error("移除失败：" + resp.status);
    return true;
  }

  // 简易 HTML 转义（本地工具函数）
  function escapeHtmlSimple(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  // 渲染设备列表
  async function renderDevices() {
    const listEl = document.getElementById("deviceList");
    if (!listEl) return;
    const state = await getAuthState();
    if (!state || !state.token || !state.userId || state.mode === "local") {
      listEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = '<li class="device-item"><span class="device-loading">加载中...</span></li>';
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
              await removeDevice(state.token, d.device_id);
              await renderDevices();
            } catch (e) {
              await showAlert("移除失败：" + (e.message || e), { title: "错误", type: "danger" });
            }
          });
        }
        listEl.appendChild(li);
      }
    } catch (e) {
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
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = "adshield-backup-" + ts + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { size: json.length };
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
    for (const [k, v] of Object.entries(payload.data)) {
      if (allowed.includes(k)) {
        toSave[k] = v;
        count++;
      }
    }
    if (count === 0) {
      throw new Error("文件中没有可导入的数据");
    }
    await chrome.storage.local.set(toSave);
    return { count, meta };
  }

  // ===== 忘记密码弹窗 =====
  function showForgotPasswordDialog(presetEmail) {
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

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "adshield-modal-overlay";
      overlay.setAttribute("data-type", "info");
      overlay.setAttribute("data-size", "normal");

      overlay.innerHTML = `
        <div class="adshield-modal" role="dialog" aria-modal="true">
          <div class="adshield-modal-body">
            <div class="adshield-modal-title">忘记密码</div>
            <div class="adshield-modal-message"></div>
          </div>
          <div class="adshield-modal-actions">
            <button class="adshield-modal-btn adshield-modal-btn-cancel" data-cancel>取消</button>
            <button class="adshield-modal-btn adshield-modal-btn-confirm" data-confirm>联系开发者</button>
          </div>
        </div>
      `;
      overlay.querySelector(".adshield-modal-message").innerHTML = html;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      const form = overlay.querySelector("#forgotForm");
      const emailInput = overlay.querySelector("#forgotEmail");
      const hint = overlay.querySelector("#forgotHint");
      const btnConfirm = overlay.querySelector("[data-confirm]");
      const btnCancel = overlay.querySelector("[data-cancel]");

      function cleanup() {
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 180);
      }
      function onKey(e) { if (e.key === "Escape") { cleanup(); document.removeEventListener("keydown", onKey); resolve(false); } }
      document.addEventListener("keydown", onKey);

      btnCancel.addEventListener("click", () => { cleanup(); document.removeEventListener("keydown", onKey); resolve(false); });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) { cleanup(); document.removeEventListener("keydown", onKey); resolve(false); } });

      async function doSubmit() {
        const email = emailInput.value.trim();
        hint.textContent = "";
        hint.className = "auth-hint";
        if (!validateEmail(email)) { hint.textContent = "邮箱格式不正确"; hint.classList.add("err"); return; }

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

        cleanup();
        document.removeEventListener("keydown", onKey);
        await showAlert(
          "已打开您的邮件客户端（如果没自动打开，请手动发邮件到：\n\nguihuo125@users.noreply.github.com",
          { title: "请发送邮件", type: "info" }
        );
        resolve(true);
      }
      form.addEventListener("submit", (e) => { e.preventDefault(); doSubmit(); });
      btnConfirm.addEventListener("click", doSubmit);
      setTimeout(() => emailInput.focus(), 50);
    });
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

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "adshield-modal-overlay";
      overlay.setAttribute("data-type", "info");
      overlay.setAttribute("data-size", "normal");

      overlay.innerHTML = `
        <div class="adshield-modal" role="dialog" aria-modal="true">
          <div class="adshield-modal-body">
            <div class="adshield-modal-title">修改密码</div>
            <div class="adshield-modal-message"></div>
          </div>
          <div class="adshield-modal-actions">
            <button class="adshield-modal-btn adshield-modal-btn-cancel" data-cancel>取消</button>
            <button class="adshield-modal-btn adshield-modal-btn-confirm" data-confirm>确定</button>
          </div>
        </div>
      `;
      overlay.querySelector(".adshield-modal-message").innerHTML = html;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      const form = overlay.querySelector("#pwdForm");
      const oldPwd = overlay.querySelector("#oldPwd");
      const newPwd = overlay.querySelector("#newPwd");
      const newPwd2 = overlay.querySelector("#newPwd2");
      const hint = overlay.querySelector("#pwdHint");
      const strengthEl = overlay.querySelector("#newPwdStrength");
      const btnConfirm = overlay.querySelector("[data-confirm]");
      const btnCancel = overlay.querySelector("[data-cancel]");

      newPwd.addEventListener("input", () => {
        renderStrength(strengthEl, newPwd.value);
      });

      function cleanup() {
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 180);
      }
      function onKey(e) { if (e.key === "Escape") { cleanup(); document.removeEventListener("keydown", onKey); resolve(false); } }
      document.addEventListener("keydown", onKey);

      btnCancel.addEventListener("click", () => { cleanup(); document.removeEventListener("keydown", onKey); resolve(false); });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) { cleanup(); document.removeEventListener("keydown", onKey); resolve(false); } });

      async function doSubmit() {
        const oldP = oldPwd.value;
        const p1 = newPwd.value;
        const p2 = newPwd2.value;
        hint.textContent = "";
        hint.className = "auth-hint";
        if (!oldP) { hint.textContent = "请输入原密码"; hint.classList.add("err"); return; }
        const check = validateNewPassword(p1);
        if (!check.ok) { hint.textContent = check.reason; hint.classList.add("err"); return; }
        if (p1 !== p2) { hint.textContent = "两次新密码不一致"; hint.classList.add("err"); return; }
        if (oldP === p1) { hint.textContent = "新密码不能与原密码相同"; hint.classList.add("err"); return; }

        btnConfirm.disabled = true;
        btnConfirm.textContent = "提交中...";
        try {
          await changePassword(oldP, p1);
          cleanup();
          document.removeEventListener("keydown", onKey);
          resolve(true);
        } catch (e) {
          hint.textContent = translateError(e.message || e);
          hint.classList.add("err");
          btnConfirm.disabled = false;
          btnConfirm.textContent = "确定";
        }
      }
      form.addEventListener("submit", (e) => { e.preventDefault(); doSubmit(); });
      btnConfirm.addEventListener("click", doSubmit);
      setTimeout(() => oldPwd.focus(), 50);
    });
  }

  // ===== 弹窗：登录 / 注册 =====
  function showAuthDialog(mode, preset) {
    // mode: "login" | "register"
    // preset: { email, notice } — 用于注册成功后预填邮箱 + 提示
    preset = preset || {};
    const isLogin = mode === "login";
    const noticeHtml = preset.notice
      ? '<div class="auth-notice auth-notice-ok">' + preset.notice + '</div>'
      : '';
    const emailValue = preset.email ? 'value="' + preset.email.replace(/"/g, "&quot;") + '"' : '';
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

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "adshield-modal-overlay";
      overlay.setAttribute("data-type", "info");
      overlay.setAttribute("data-size", "normal");

      overlay.innerHTML = `
        <div class="adshield-modal" role="dialog" aria-modal="true">
          <div class="adshield-modal-body">
            <div class="adshield-modal-title">${isLogin ? "登录账号" : "注册账号"}</div>
            <div class="adshield-modal-message"></div>
          </div>
          <div class="adshield-modal-actions">
            <button class="adshield-modal-btn adshield-modal-btn-cancel" data-cancel>取消</button>
            <button class="adshield-modal-btn adshield-modal-btn-confirm" data-confirm>${isLogin ? "登录" : "注册"}</button>
          </div>
        </div>
      `;
      // 把表单塞进 message 区
      overlay.querySelector(".adshield-modal-message").innerHTML = html;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      const form = overlay.querySelector("#authForm");
      const emailInput = overlay.querySelector("#authEmail");
      const pwdInput = overlay.querySelector("#authPassword");
      const pwd2Input = overlay.querySelector("#authPassword2");
      const pwdStrengthEl = overlay.querySelector("#authPwdStrength");
      const hint = overlay.querySelector("#authHint");
      const btnConfirm = overlay.querySelector("[data-confirm]");
      const btnCancel = overlay.querySelector("[data-cancel]");

      // 注册时实时显示密码强度
      if (!isLogin && pwdInput && pwdStrengthEl) {
        pwdInput.addEventListener("input", () => {
          renderStrength(pwdStrengthEl, pwdInput.value);
        });
      }

      function cleanup() {
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 180);
      }

      // 切换登录/注册 / 忘记密码
      overlay.addEventListener("click", (e) => {
        const link = e.target.closest("[data-switch]");
        if (link) {
          e.preventDefault();
          cleanup();
          resolve(showAuthDialog(link.getAttribute("data-switch")));
          return;
        }
        const forgot = e.target.closest('[data-action="forgot"]');
        if (forgot) {
          e.preventDefault();
          const email = emailInput ? emailInput.value.trim() : "";
          cleanup();
          setTimeout(async () => {
            await showForgotPasswordDialog(email);
            resolve(null);
          }, 200);
        }
      });

      // 取消
      btnCancel.addEventListener("click", () => { cleanup(); resolve(null); });
      // 点遮罩
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) { cleanup(); resolve(null); }
      });
      // ESC
      const onKey = (e) => {
        if (e.key === "Escape") { cleanup(); document.removeEventListener("keydown", onKey); resolve(null); }
      };
      document.addEventListener("keydown", onKey);

      // 提交逻辑
      async function doSubmit() {
        const email = emailInput.value.trim();
        const pwd = pwdInput.value;
        hint.textContent = "";
        hint.className = "auth-hint";

        if (!validateEmail(email)) {
          hint.textContent = "邮箱格式不正确";
          hint.classList.add("err");
          return;
        }
        if (isLogin) {
          // 登录：宽松校验（老用户密码可能不符新策略）
          if (!validatePassword(pwd)) {
            hint.textContent = "请输入密码";
            hint.classList.add("err");
            return;
          }
        } else {
          // 注册：严格校验
          const check = validateNewPassword(pwd);
          if (!check.ok) {
            hint.textContent = check.reason;
            hint.classList.add("err");
            return;
          }
          if (pwd2Input && pwd2Input.value !== pwd) {
            hint.textContent = "两次密码不一致";
            hint.classList.add("err");
            return;
          }
        }

        btnConfirm.disabled = true;
        btnConfirm.textContent = isLogin ? "登录中..." : "注册中...";
        try {
          const result = isLogin ? await doLogin(email, pwd) : await doRegister(email, pwd);
          document.removeEventListener("keydown", onKey);
          cleanup();
          if (isLogin) {
            // 登录成功：直接返回
            resolve({ email, mode: "login", result });
          } else {
            // 注册成功：自动切换到登录页（预填邮箱 + 提示）
            const needVerify = !!(result && result.needVerify);
            const noticeText = needVerify
              ? "✅ 注册成功！验证邮件已发送到 " + email + "，请点击邮件中的链接完成验证，然后返回登录。"
              : "✅ 注册成功，请登录";
            setTimeout(async () => {
              const loginResult = await showAuthDialog("login", {
                email: email,
                notice: noticeText
              });
              // 登录成功后（或取消后）刷新 UI
              renderAccount();
              resolve({ email, mode: "register", result, loginResult });
            }, 200);
          }
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
        }
      }

      // form 提交（按回车）
      form.addEventListener("submit", (e) => { e.preventDefault(); doSubmit(); });
      // 关键：弹窗的「确定」按钮手动触发提交
      btnConfirm.addEventListener("click", doSubmit);

      // 自动聚焦
      setTimeout(() => emailInput.focus(), 50);
    });
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
        cosmetic: settings.cosmetic,
        antiDetect: settings.antiDetect,
        assist: settings.assist,
        showBadge: settings.showBadge
      },
      whitelist: {
        disabledSites: settings.disabledSites || [],
        pausedUntil: settings.pausedUntil || {}
      },
      user_rules: userRules,
      subscriptions: settings.subscriptions || []
    };
  }

  // 上传到云端
  async function pushToCloud(token, userId) {
    const data = await collectLocalData();
    // 记下本次上传时间（用于打开时判断云端是否更新）
    try {
      const st = await getAuthState();
      if (st) await setAuthState(Object.assign({}, st, { lastSyncAt: Date.now() }));
    } catch (e) {}
    // Upsert（存在则更新，不存在则插入）
    const resp = await fetch(SUPABASE_URL + SUPABASE_TABLE, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: userId,
        settings: data.settings,
        whitelist: data.whitelist,
        user_rules: data.user_rules,
        subscriptions: data.subscriptions,
        updated_at: new Date().toISOString()
      })
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error("上传失败：" + resp.status + " " + err);
    }
    return true;
  }

  // 从云端拉取
  async function pullFromCloud(token, userId) {
    const url = SUPABASE_URL + SUPABASE_TABLE + "?user_id=eq." + userId + "&select=*";
    const resp = await fetch(url, {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token
      }
    });
    if (!resp.ok) throw new Error("拉取失败：" + resp.status);
    const rows = await resp.json();
    if (!rows || rows.length === 0) return null;   // 云端没数据
    return rows[0];
  }

  // 写回本地
  async function applyCloudData(cloud) {
    const store = await chrome.storage.local.get(["adshield_settings"]);
    const s = store.adshield_settings || {};
    // 合并 settings
    Object.assign(s, cloud.settings || {});
    // 合并 whitelist
    if (cloud.whitelist) {
      s.disabledSites = cloud.whitelist.disabledSites || [];
      s.pausedUntil = cloud.whitelist.pausedUntil || {};
    }
    // 合并 subscriptions
    if (Array.isArray(cloud.subscriptions)) {
      s.subscriptions = cloud.subscriptions;
    }
    await chrome.storage.local.set({ adshield_settings: s });
    // 用户规则
    if (Array.isArray(cloud.user_rules)) {
      await chrome.storage.local.set({ adshield_user_rules: cloud.user_rules });
    }
  }

  // ===== 自动上传（防抖 5 秒）=====
  let __autoUploadTimer = 0;
  let __autoUploadLast = 0;
  async function autoUpload() {
    const state = await getAuthState();
    if (!state || state.mode === "local" || !state.token || !state.userId) return;
    // 5 秒内避免重复上传
    const now = Date.now();
    if (now - __autoUploadLast < 3000) return;
    __autoUploadLast = now;
    try {
      await pushToCloud(state.token, state.userId);
      console.log("[AdShield Sync] 自动上传成功");
      // 显示轻提示（右下角）
      showSyncToast("已自动同步到云端");
    } catch (e) {
      console.warn("[AdShield Sync] 自动上传失败:", e);
    }
  }

  function scheduleAutoUpload() {
    if (__autoUploadTimer) clearTimeout(__autoUploadTimer);
    __autoUploadTimer = setTimeout(() => {
      __autoUploadTimer = 0;
      autoUpload();
    }, 5000);   // 5 秒防抖
  }

  // 右下角轻提示
  function showSyncToast(text) {
    const id = "__adshield_sync_toast__";
    if (document.getElementById(id)) return;
    const el = document.createElement("div");
    el.id = id;
    el.className = "sync-toast";
    el.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg><span>' + text + '</span>';
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

    // 关键：首次登录（没有 lastSyncAt）→ 静默同步，不弹窗
    const localTime = state.lastSyncAt || 0;
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
          await applyCloudData(cloud);
          await setAuthState(Object.assign({}, state, { lastSyncAt: Date.now() }));
          location.reload();
        }
      }
    } catch (e) {
      console.warn("[AdShield Sync] 检查云端失败:", e);
    }
  }

  async function doSync(direction) {
    // direction: "pull" | "push" | "both"
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
        await pushToCloud(token, userId);
      }
      // pull：从云端拉取（both 时不覆盖本地，先 push 后 pull 会拿到自己数据）
      if (direction === "pull") {
        const cloud = await pullFromCloud(token, userId);
        if (cloud) {
          await applyCloudData(cloud);
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
    if (btnUpload) btnUpload.addEventListener("click", () => doSync("push"));

    // 首次渲染：延迟 300ms（让骨架屏展示一下）
    setTimeout(() => renderAccount(), 300);
  });

  // 登录成功后刷新 UI
  window.addEventListener("adshield:auth-changed", renderAccount);
})();
