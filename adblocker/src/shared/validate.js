// AdShield 校验与净化纯函数 —— 独立于 chrome API 与 DOM，可单独测试
//
// 背景（2026-11-01 审查 D4）：auth.js 里有一批安全边界函数，原先被关在 IIFE 里，
// 注释写着「纯函数，不碰 chrome/DOM，便于单独测试」—— 但项目里没有任何测试。
// 这批函数是云端数据进入本地的唯一防线：云端行里的任意内容都会经过它们。
// 抽到这里后由 tools/test-validate.mjs 用 node:test 直接覆盖。
(function () {
  const ROOT = typeof globalThis !== "undefined" ? globalThis : self;

  // host 归一化来自 shared/host.js（唯一真源）。
  // 这里做一次惰性读取而不是顶层解构：validate.js 可能被单独引入做测试，
  // 那时 host.js 不一定已加载。
  function host() {
    return ROOT.adshieldHost || {};
  }
  function normalizeHost(h) {
    const m = host().normalizeHost;
    return m ? m(h) : String(h == null ? "" : h).trim().toLowerCase().replace(/^www\./, "");
  }
  function isValidHost(h) {
    const m = host().isValidHost;
    return m ? m(h) : /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h);
  }

  /* ============ 错误信息翻译 ============ */

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
      // Supabase 的限流报文实际是 "For security purposes, you can only request
      // this once every 60 seconds"（数字在 every 之后）。
      // 原先的正则只认 "after N seconds"，与真实报文对不上，
      // 于是永远落到兜底文案「请稍后再试」，用户看不到要等多久。
      // 这里同时兼容 after/every 两种写法。
      const match = m.match(/(?:after|every)\s+(\d+)\s*seconds?/i);
      return match ? ("请求过于频繁，请 " + match[1] + " 秒后重试") : "请求过于频繁，请稍后再试";
    }
    if (m.includes("JWT expired")) return "登录已过期，请重新登录";
    return m;
  }

  /* ============ 邮箱 / 密码校验 ============ */

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

  /* ============ 杂项 ============ */

  function maskEmail(email) {
    if (!email) return "";
    const parts = email.split("@");
    if (parts.length !== 2) return email;
    const u = parts[0], d = parts[1];
    const masked = u.length <= 2 ? (u[0] || "") + "*" : u[0] + "***" + u.slice(-1);
    return masked + "@" + d;
  }

  // 网络层失败（连不上/超时）与凭据被服务端拒绝是两回事：
  // 把断网也报成「登录已过期」会把好好的会话踢掉，用户既看不懂也自救不了。
  function isOfflineError(e) {
    if (!e) return false;
    const n = String(e.name || "");
    const m = String(e.message || e);
    return n === "TimeoutError" || n === "AbortError" ||
      /Failed to fetch|NetworkError|ERR_[A-Z_]+|timed out|超时|网络/i.test(m);
  }

  /* ============ 云端数据白名单校验 ============
     以下四个 sanitize* 是云端数据进入本地的唯一防线。
     每个都返回 { ...归一化后的值, rejected: 被拒绝的条数 }，
     由调用方汇总告知用户，而不是静默丢弃。 */

  // 只拒「会让规则坏掉」的字符：除 \t \n \r 之外的控制字符。
  // 绝不能拒 < > —— 元素隐藏规则 example.com##.ad > .banner 和 CSS 声明里它们是合法字符，
  // 而这里拒掉的条目会被写回本地、再触发自动上传推回云端，等于把用户的规则永久删掉。
  const RULE_CTRL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

  // 元素隐藏规则（## / #@#）的选择器会被原样拼进 CSS —— cosmetic.js 里是 sel + "{display:none !important;}"。
  // 含 { } @ /* 的选择器能提前闭合规则块、塞进新声明、或把后面的内容注释掉，
  // 等于往用户访问的每个网站注入任意 CSS（可伪造界面、可外传页面数据）。
  // < > 不拦：".ad > .banner" 是合法选择器，拦了会误伤用户自己的正常规则。
  const CSS_BREAKOUT = /[{}@]|\/\*|\*\//;
  const MAX_CSS_SELECTOR_LEN = 500;

  function isSafeCssSelector(sel) {
    if (typeof sel !== "string") return false;
    const s = sel.trim();
    if (!s || s.length > MAX_CSS_SELECTOR_LEN) return false;
    return !CSS_BREAKOUT.test(s);
  }

  // 带元素隐藏部分的用户规则要额外检查选择器；纯网络规则交给 background 的解析器，不在这里管
  function isSafeUserRule(rule) {
    if (typeof rule !== "string") return false;
    const hideIdx = rule.indexOf("##");
    const excIdx = rule.indexOf("#@#");
    if (hideIdx < 0 && excIdx < 0) return true;
    const isExcept = excIdx >= 0;
    const idx = isExcept ? excIdx : hideIdx;
    const selector = rule.slice(idx + (isExcept ? 3 : 2)).trim();
    return isSafeCssSelector(selector);
  }

  // user_rules：数组；每项 string；≤1000 字符；总条数 ≤5000；元素隐藏部分的选择器不能突破 CSS 块
  function sanitizeCloudUserRules(arr) {
    const res = { list: [], rejected: 0 };
    if (!Array.isArray(arr)) { if (arr != null) res.rejected = 1; return res; }
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      if (typeof r !== "string" || r.length > 1000 || RULE_CTRL_CHARS.test(r)) { res.rejected++; continue; }
      if (!isSafeUserRule(r)) { res.rejected++; continue; }
      if (res.list.length >= 5000) { res.rejected++; continue; }   // 超过总条数上限
      res.list.push(r);
    }
    return res;
  }

  // subscriptions：数组 ≤20；url 必须 ^https:// 且 new URL() 可解析且 ≤500；id 归一化 1..99
  function sanitizeCloudSubscriptions(arr) {
    const res = { list: [], rejected: 0 };
    if (!Array.isArray(arr)) { if (arr != null) res.rejected = 1; return res; }
    const usedIds = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (res.list.length >= 20) { res.rejected++; continue; }
      const sub = arr[i];
      if (!sub || typeof sub !== "object") { res.rejected++; continue; }
      const url = typeof sub.url === "string" ? sub.url.trim() : "";
      if (!/^https:\/\//.test(url) || url.length > 500) { res.rejected++; continue; }
      try { new URL(url); } catch (e) { res.rejected++; continue; }
      const m = ((Number(sub.id) || 0) % 100);   // 沿用后台 ID 约定
      let id = (m >= 1 && m <= 99) ? m : 0;
      // 订阅 id 决定它占用的 DNR ID 段（后台：SUB_RULE_BASE + id%100 * 10000）。
      // 两个订阅撞到同一个 id 就会共用一段规则，后应用的那个把前一个整段覆盖掉。
      if (!id || usedIds.has(id)) {
        id = 0;
        for (let k = 1; k < 100; k++) { if (!usedIds.has(k)) { id = k; break; } }
      }
      if (!id) { res.rejected++; continue; }
      usedIds.add(id);
      // 只重建已知键：云端行里的额外键不能原样透传，否则一条脏数据就能改写后台消费的字段
      res.list.push({
        url: url,
        id: id,
        name: typeof sub.name === "string" && sub.name.length <= 120 ? sub.name : "",
        enabled: sub.enabled === false ? false : true
      });
    }
    return res;
  }

  // whitelist.disabledSites：主机名白名单；pausedUntil：键同主机校验、值为有限正整数时间戳
  function sanitizeCloudWhitelist(obj) {
    const res = { disabledSites: [], pausedUntil: {}, rejected: 0 };
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) { if (obj != null) res.rejected = 1; return res; }
    const ds = obj.disabledSites;
    if (Array.isArray(ds)) {
      for (let i = 0; i < ds.length; i++) {
        const h = normalizeHost(ds[i]);
        if (h && isValidHost(h)) { if (res.disabledSites.indexOf(h) === -1) res.disabledSites.push(h); }
        else res.rejected++;
      }
    } else if (ds != null) res.rejected++;
    const pu = obj.pausedUntil;
    if (pu && typeof pu === "object" && !Array.isArray(pu)) {
      for (const k of Object.keys(pu)) {
        const h = normalizeHost(k);
        const n = Number(pu[k]);
        if (h && isValidHost(h) && Number.isFinite(n) && Number.isInteger(n) && n > 0) res.pausedUntil[h] = n;
        else res.rejected++;
      }
    } else if (pu != null) res.rejected++;
    return res;
  }

  // settings：只拷贝白名单键；rulesets 只接受布尔值；subscriptionInterval 必须 0..168；其余丢弃并计数
  function sanitizeCloudSettings(obj) {
    const res = { settings: {}, rejected: 0 };
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) { if (obj != null) res.rejected = 1; return res; }
    const ALLOW = ["enabled", "rulesets", "antiDetect", "assist", "showBadge", "subscriptionInterval"];
    for (const k of Object.keys(obj)) {
      if (ALLOW.indexOf(k) === -1) { res.rejected++; continue; }   // 白名单外的键丢弃
      const v = obj[k];
      if (k === "rulesets") {
        if (typeof v === "boolean") { res.settings.rulesets = v; }
        else if (v && typeof v === "object" && !Array.isArray(v)) {
          // rulesets 为映射表时逐项过滤，只保留布尔值，非布尔项丢弃并计数
          const clean = {};
          for (const rk of Object.keys(v)) { if (typeof v[rk] === "boolean") clean[rk] = v[rk]; else res.rejected++; }
          // 空映射表视为「云端没提供有效值」，保留本地。
          // 否则云端一行 rulesets:{} 就会把用户本地的规则集开关整个覆盖掉，
          // 而 getSettings 的默认值合并（Object.assign({}, DEFAULT, {})) 补不回来 ——
          // 空对象不是 falsy，默认值不会生效。
          if (Object.keys(clean).length) res.settings.rulesets = clean;
          else res.rejected++;
        } else res.rejected++;
      } else if (k === "subscriptionInterval") {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0 && n <= 168) res.settings.subscriptionInterval = n;
        else res.rejected++;
      } else if (typeof v === "boolean") {
        res.settings[k] = v;   // enabled / antiDetect / assist / showBadge
      } else {
        res.rejected++;        // 非布尔值一律拒绝，避免 "yes" 之类的字符串写进开关
      }
    }
    return res;
  }

  ROOT.adshieldValidate = {
    translateError,
    validateEmail,
    validatePassword,
    validateNewPassword,
    evalPasswordStrength,
    maskEmail,
    isOfflineError,
    isSafeCssSelector,
    isSafeUserRule,
    RULE_CTRL_CHARS,
    sanitizeCloudUserRules,
    sanitizeCloudSubscriptions,
    sanitizeCloudWhitelist,
    sanitizeCloudSettings
  };
})();
