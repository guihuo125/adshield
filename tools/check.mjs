#!/usr/bin/env node
// AdShield 静态校验：规则集 + DOM 契约 + host 归一化单一真源
//
// 用途：把「代码看起来对、实际不生效」的几类静默失败挡在提交之前。
//   1. regexFilter 必须 ^...$ 锚定 —— DNR 的 regexFilter 是全串匹配，
//      未锚定的正则永远 0 命中，但规则集照样编译成功。
//      教训来源：.learnings/LEARNINGS.md LRN-20261031-002
//   2. 静态规则的 ruleId 必须落在 background.js 的 STATIC_RULE_SETS 区间内 ——
//      改 JSON 不同步区间表，分类统计会静默出错。
//   3. DOM 契约：JS 里引用的 id 必须在对应 HTML 中存在 ——
//      「元素存在但永远不显示」这类问题的第一现场。
//   4. host 归一化只能有一份实现（shared/host.js），
//      其余文件不得自带 normalizeHost / isValidHost。
//
// 用法：node tools/check.mjs        （在项目根目录执行）
// 退出码：0 = 全部通过；1 = 有错误

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "adblocker", "src");

const errors = [];
const warnings = [];

function err(file, msg) { errors.push(`${file}: ${msg}`); }
function warn(file, msg) { warnings.push(`${file}: ${msg}`); }

function read(p) { return readFileSync(p, "utf8"); }

/* ---------- 1. regexFilter 锚定 ---------- */
const RULES_DIR = join(ROOT, "adblocker", "rules");
if (existsSync(RULES_DIR)) {
  for (const f of readdirSync(RULES_DIR).filter(n => n.endsWith(".json"))) {
    const file = join("rules", f);
    let rules;
    try { rules = JSON.parse(read(join(RULES_DIR, f))); }
    catch (e) { err(file, `JSON 解析失败: ${e.message}`); continue; }
    if (!Array.isArray(rules)) { err(file, "顶层不是数组"); continue; }

    const seenIds = new Set();
    for (const r of rules) {
      if (!r || typeof r !== "object") { err(file, "存在非对象规则项"); continue; }
      if (r.id == null) err(file, "规则缺少 id");
      else if (seenIds.has(r.id)) err(file, `规则 id 重复: ${r.id}`);
      else seenIds.add(r.id);

      const filter = r.condition && r.condition.regexFilter;
      if (filter != null) {
        if (!String(filter).startsWith("^") || !String(filter).endsWith("$")) {
          err(file, `规则 ${r.id} 的 regexFilter 未锚定，将永不命中: ${filter}`);
        }
      }
      // redirect 动作必须带 redirect 字段
      if (r.action && r.action.type === "redirect" && !r.action.redirect) {
        err(file, `规则 ${r.id} 是 redirect 动作但缺少 redirect 字段`);
      }
    }
  }
}

/* ---------- 2. 静态规则 ruleId 区间一致性 ---------- */
const bg = read(join(SRC, "background.js"));
const rangeM = bg.match(/const STATIC_RULE_SETS = \[([\s\S]*?)\];/);
if (!rangeM) {
  err("background.js", "找不到 STATIC_RULE_SETS 区间表");
} else {
  const ranges = [];
  const re = /\{\s*min:\s*(\d+),\s*max:\s*(\d+),\s*cat:\s*"([^"]+)"\s*\}/g;
  let m;
  while ((m = re.exec(rangeM[1])) !== null) {
    ranges.push({ min: +m[1], max: +m[2], cat: m[3] });
  }
  if (!ranges.length) err("background.js", "STATIC_RULE_SETS 区间表解析不出条目");

  const RULES_DIR2 = RULES_DIR;
  if (existsSync(RULES_DIR2)) {
    for (const f of readdirSync(RULES_DIR2).filter(n => n.endsWith(".json"))) {
      const file = join("rules", f);
      let rules;
      try { rules = JSON.parse(read(join(RULES_DIR2, f))); } catch { continue; }
      for (const r of rules) {
        if (!r || r.id == null) continue;
        const hit = ranges.some(x => r.id >= x.min && r.id <= x.max);
        if (!hit) {
          err(file, `规则 id ${r.id} 不落在 background.js 的 STATIC_RULE_SETS 任何区间内 —— 分类统计会把它错归类`);
        }
      }
    }
  }
}

/* ---------- 3. DOM 契约 ---------- */
// options.js / popup.js / logger.js 里 $("#xxx") 与 getElementById("xxx") 的引用
const PAGES = [
  { js: "options.js", html: "options.html" },
  { js: "popup.js",   html: "popup.html" },
  { js: "logger.js",  html: "logger.html" },
];
for (const { js, html } of PAGES) {
  const jsPath = join(SRC, js);
  const htmlPath = join(SRC, html);
  if (!existsSync(jsPath) || !existsSync(htmlPath)) continue;
  const src = read(jsPath);
  const doc = read(htmlPath);

  const ids = new Map();   // id -> 该引用所在的源码片段
  for (const m of src.matchAll(/\$\("#([A-Za-z][\w-]*)"\)/g)) ids.set(m[1], m[0]);
  for (const m of src.matchAll(/getElementById\("([A-Za-z][\w-]*)"\)/g)) ids.set(m[1], m[0]);

  const htmlIds = new Set();
  for (const m of doc.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

  for (const [id, ref] of ids) {
    if (htmlIds.has(id)) continue;
    // 已做空值保护的引用是有意为之（例如从 popup 移除的「功能」分区），
    // 只有「裸用」—— 直接 .textContent / .addEventListener / .innerHTML —— 才是缺陷。
    const at = src.indexOf(ref);
    const around = src.slice(Math.max(0, at - 200), at + 240);
    const guarded = /\bif\s*\(\s*!\s*\w+\s*\)|\bif\s*\(\s*\w+\s*&&\s*\w+\s*\)/.test(around)
                 || /\?\s*\w+\s*:\s*null/.test(around);
    if (guarded) {
      warn(js, `引用了 HTML 中不存在的 id "${id}"，但已有空值保护 —— 若非有意为之请确认`);
      continue;
    }
    err(js, `裸引用了 HTML 中不存在的 id "${id}" —— 该处代码会静默 return 或抛异常`);
  }
}

/* ---------- 4. host 归一化单一真源 ---------- */
const HOST_IMPLS = ["content/cosmetic.js", "content/anti-detect.js", "popup.js",
                    "options.js", "shared/auth.js", "background.js"];
for (const rel of HOST_IMPLS) {
  const p = join(SRC, rel);
  if (!existsSync(p)) continue;
  const src = read(p);
  // 允许通过解构引用 shared/host.js，不允许自己再实现一份
  const selfImpl = /function\s+(normalizeHost|isValidHost)\s*\(/.test(src);
  const usesShared = /adshieldHost/.test(src);
  if (selfImpl && !usesShared) {
    err(rel, "自带了 host 归一化实现 —— host 归一化只能有一份真源（shared/host.js）");
  }
}
// shared/host.js 自身必须存在且导出全部函数
const hostPath = join(SRC, "shared", "host.js");
if (!existsSync(hostPath)) {
  err("shared/host.js", "缺少 host 归一化的唯一真源");
} else {
  const h = read(hostPath);
  for (const fn of ["normalizeHost", "isValidHost", "hostMatches", "anyHostMatches", "normalizeHostList"]) {
    if (!h.includes(`function ${fn}`)) err("shared/host.js", `缺少导出函数 ${fn}`);
  }
}

/* ---------- 4b. 其它单一真源（转义 / 默认设置 / 消息协议 / 校验函数） ---------- */
// HTML 转义：只允许 shared/dom.js 自己实现
for (const rel of ["content/picker.js", "logger.js", "options.js", "popup.js", "shared/auth.js"]) {
  const p = join(SRC, rel);
  if (!existsSync(p)) continue;
  const src = read(p);
  const selfImpl = /function\s+escapeHtml(Simple)?\s*\(/.test(src);
  const usesShared = /adshieldDom/.test(src);
  if (selfImpl && !usesShared) {
    err(rel, "自带了 HTML 转义实现 —— 转义只能有一份真源（shared/dom.js）");
  }
}
// 默认设置：只允许 shared/config.js 自己定义
for (const rel of ["background.js", "options.js", "popup.js"]) {
  const p = join(SRC, rel);
  if (!existsSync(p)) continue;
  const src = read(p);
  if (/const\s+DEFAULT_SETTINGS\s*=\s*\{/.test(src)) {
    err(rel, "自带了 DEFAULT_SETTINGS 定义 —— 默认设置只能有一份真源（shared/config.js）");
  }
  if (!/adshieldConfig/.test(src)) {
    err(rel, "未引用 shared/config.js");
  }
}
// 消息类型：所有用到 MSG.X 的文件都必须解构了 MSG
for (const rel of ["background.js", "options.js", "popup.js", "logger.js", "shared/auth.js"]) {
  const p = join(SRC, rel);
  if (!existsSync(p)) continue;
  const src = read(p);
  const uses = (src.match(/\bMSG\.[A-Z_]+/g) || []).length;
  if (uses === 0) continue;
  const declared = src.split("\n").some(line =>
    line.trim().startsWith("const") && /adshieldConfig/.test(line) && /\bMSG\b/.test(line));
  if (!declared) {
    err(rel, `用到了 ${uses} 处 MSG.XXX，但没有从 adshieldConfig 解构 MSG —— 运行时会 ReferenceError`);
  }
}
// 校验纯函数：只允许 shared/validate.js 自己实现
{
  const p = join(SRC, "shared", "auth.js");
  if (existsSync(p)) {
    const src = read(p);
    for (const fn of ["sanitizeCloudUserRules", "sanitizeCloudSubscriptions",
                      "sanitizeCloudWhitelist", "sanitizeCloudSettings", "isSafeUserRule"]) {
      if (new RegExp(`function\\s+${fn}\\s*\\(`).test(src)) {
        err("shared/auth.js", `${fn} 应当在 shared/validate.js（可单测），不应留在 auth.js 里`);
      }
    }
    if (!/adshieldValidate/.test(src)) {
      err("shared/auth.js", "未引用 shared/validate.js");
    }
  }
}

/* ---------- 4c. storage 键的单一写入者 ---------- */
// 每个键只能有一个权威写入者。页面侧直接 set 会与 background 竞争，
// 导致数据被回写 / 删除的规则又冒出来（这个坑真实发生过）。
const STORAGE_OWNERS = {
  "adshield_settings": "background.js",
  "adshield_user_rules": "background.js",
  "adshield_user_cosmetic": "background.js",
  "adshield_stats": "background.js",
};
for (const [key, owner] of Object.entries(STORAGE_OWNERS)) {
  const ownerPath = owner === "background.js"
    ? join(SRC, "background.js")
    : join(SRC, "shared", owner);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  walk(SRC);
  for (const f of files) {
    if (f === ownerPath) continue;
    const src = read(f);
    const rel = f.replace(/\\/g, "/").split("/adblocker/").pop();
    // 找 storage.local.set({ "key": ... }) 或 set({ "key": ...
    const re = new RegExp(`storage\\.local\\.set\\(\\s*\\{[^}]*["']${key}["']`, "s");
    if (re.test(src)) {
      err(rel, `直接写了 storage 键 "${key}"，但它的权威写入者是 ${owner} —— 两个写入者会互相覆盖`);
    }
  }
}

/* ---------- 4d. 共享模块的解构完整性 ---------- */
// 反例（真实发生过）：background.js 用了 isPausedUntil 但解构时漏了，
// 运行到那行直接 ReferenceError —— badge 完全不显示，而语法检查查不出来。
// 这里静态比对「用到的成员」与「解构进来的成员」，缺一个就报错。
{
  const MODULES = {
    adshieldHost: { file: join(SRC, "shared", "host.js"), names: ["normalizeHost", "isValidHost", "hostMatches", "anyHostMatches", "normalizeHostList", "isPausedUntil", "pausedUntilRemaining"] },
    adshieldDom: { file: join(SRC, "shared", "dom.js"), names: ["escapeHtml", "downloadBlob", "downloadJson", "downloadCsv", "downloadText"] },
    adshieldConfig: { file: join(SRC, "shared", "config.js"), names: ["DEFAULT_SETTINGS", "RULESETS", "CATS", "CAT_KEYS", "CAT_LABELS", "CAT_COLORS", "MSG"] },
    adshieldValidate: { file: join(SRC, "shared", "validate.js"), names: ["translateError", "validateEmail", "validatePassword", "validateNewPassword", "evalPasswordStrength", "maskEmail", "isOfflineError", "isSafeCssSelector", "isSafeUserRule", "RULE_CTRL_CHARS", "sanitizeCloudUserRules", "sanitizeCloudSubscriptions", "sanitizeCloudWhitelist", "sanitizeCloudSettings"] },
  };
  const allJs = [];
  const walkJs = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walkJs(p);
      else if (e.name.endsWith(".js")) allJs.push(p);
    }
  };
  walkJs(SRC);

  for (const f of allJs) {
    const src = read(f);
    const rel = f.replace(/\\/g, "/").split("/adblocker/").pop();
    for (const [mod, def] of Object.entries(MODULES)) {
      // 找出所有解构行：const { a, b } = window.adshieldXxx / self.adshieldXxx
      const declRe = new RegExp(
        `const\\s*\\{([^}]*)\\}\\s*=\\s*(?:window|self)\\.${mod}\\b`, "g");
      let m;
      const declared = new Set();
      let hasDecl = false;
      while ((m = declRe.exec(src)) !== null) {
        hasDecl = true;
        for (const n of m[1].split(",").map(s => s.trim().split(":")[0].trim()).filter(Boolean)) {
          declared.add(n);
        }
      }
      if (!hasDecl) continue;
      // 检测「用了模块导出的名字，但没从该模块解构」。
      // 两种用法都要抓：
      //   裸标识符：isPausedUntil(...)          —— 必须先解构
      //   完整路径：window.adshieldHost.foo(...) —— 合法，不需要解构
      // 所以：裸标识符用法 → 要求解构；完整路径 → 放行。
      const declaredSet = declared;
      // 本文件自己定义/声明的同名标识符 —— 这些与模块无关，不该报
      const locallyDefined = new Set();
      for (const mm of src.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g)) locallyDefined.add(mm[1]);
      for (const mm of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=/g)) locallyDefined.add(mm[1]);

      for (const name of def.names) {
        if (locallyDefined.has(name)) continue;
        // 找出裸标识符调用（前面不是 . 也不是字母数字下划线）
        const bareRe = new RegExp(`(?<![.\\w])${name}\\s*\\(`, "g");
        const bareUses = (src.match(bareRe) || []).length;
        if (bareUses > 0 && !declaredSet.has(name)) {
          err(rel, `用了 ${name}(...) 但没从 ${mod} 解构 —— 运行到那行会 ReferenceError（该名字由 ${mod} 提供，定义在 ${def.file.replace(/\\/g, "/").split("/adblocker/").pop()}）`);
        }
      }
      // 解构了但模块根本没导出
      for (const d of declared) {
        if (!def.names.includes(d)) {
          err(rel, `从 ${mod} 解构了 ${d}，但该模块没有导出它 —— 运行到那行会 undefined`);
        }
      }
    }
  }
}

/* ---------- 5. logger 页必须加载 modal.js ---------- */
{
  const doc = read(join(SRC, "logger.html"));
  const js = read(join(SRC, "logger.js"));
  const needsModal = /\bshowConfirm\b|\bshowAlert\b/.test(js);
  const hasModal = doc.includes("shared/modal.js");
  if (needsModal && !hasModal) {
    err("logger.html", "logger.js 用到了 showConfirm/showAlert，但页面没有加载 shared/modal.js —— 点击即抛 ReferenceError");
  }
  if (hasModal) {
    const modalIdx = doc.indexOf("shared/modal.js");
    const loggerIdx = doc.indexOf("logger.js");
    if (loggerIdx !== -1 && modalIdx > loggerIdx) {
      err("logger.html", "shared/modal.js 排在 logger.js 之后 —— 全局函数尚未定义就被调用");
    }
  }
}

/* ---------- 输出 ---------- */
console.log("===== AdShield 静态校验 =====");
if (warnings.length) {
  console.log("\n警告：");
  for (const w of warnings) console.log("  ⚠ " + w);
}
if (errors.length) {
  console.log(`\n错误 ${errors.length} 条：`);
  for (const e of errors) console.log("  ✗ " + e);
  console.log("\n结果：不通过");
  process.exit(1);
}
console.log("\n结果：通过（无错误）");
process.exit(0);
