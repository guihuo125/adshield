#!/usr/bin/env node
// AdShield 运行时诊断解读器
//
// 读入 probe.html 采集到的 JSON，输出人话结论。
// 目的：把「DNR 上限到底是多少」「正式版能不能拿到反馈」这类只能靠实测的问题，
// 从「请你打开 DevTools 跑一段代码再贴回来」变成「点一下 → 下载 → 跑一条命令」。
//
// 教训来源：.learnings/LEARNINGS.md
//   LRN-20261031-001 —— 曾把 Chrome 动态规则上限凭记忆写成 5000，与官方文档口径不符，
//                        差点把一个正常功能误判成架构缺陷。
//   FEAT-20261031-001 —— 本工具就是那条能力请求的落地。
//
// 用法：
//   node tools/probe-dnr.mjs probe.json      解读一个采集结果
//   node tools/probe-dnr.mjs probe.json -v   附带完整 JSON
//   node tools/probe-dnr.mjs --help

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  console.log(`AdShield 运行时诊断解读器

用法：
  node tools/probe-dnr.mjs <probe.json> [-v]

参数：
  <probe.json>   probe.html「下载 JSON」产出的文件
  -v             额外打印完整 JSON

说明：
  先在扩展的「运行时诊断」页（chrome://extensions → 扩展详情 → 扩展页面）
  点「重新采集」并下载 JSON，再交给本脚本解读。`);
  process.exit(args.includes("--help") ? 0 : 1);
}

const file = args.find(a => !a.startsWith("-"));
if (!file || !existsSync(file)) {
  console.error(`找不到文件：${file}`);
  console.error("先在扩展的 probe.html 页采集并下载 JSON。");
  process.exit(1);
}

let d;
try {
  d = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error("JSON 解析失败：" + e.message);
  process.exit(1);
}

const line = (s = "") => console.log(s);
const ok = (s) => console.log("  ✓ " + s);
const warn = (s) => console.log("  ⚠ " + s);
const bad = (s) => console.log("  ✗ " + s);

line("===== AdShield 运行时诊断解读 =====");
line("");
line(`采集时间   : ${d.collectedAt || "未知"}`);
line(`扩展版本   : ${d.extensionVersion || "未知"}`);
line(`浏览器     : ${(d.userAgent || "").replace(/^Mozilla\/5\.0 \(([^)]*)\).*/, "$1").slice(0, 60)}`);

// ---- 动态规则上限 ----
line("");
line("【动态规则上限】");
const dnr = d.dnr || {};
const consts = dnr.constants || dnr.availableConstants || {};
const maxDyn = consts.MAX_NUMBER_OF_DYNAMIC_RULES ?? dnr.maxNumberOfDynamicRules;
const maxStaticSets = consts.MAX_NUMBER_OF_STATIC_RULESETS;
const maxEnabledSets = consts.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS ?? dnr.maxNumberOfEnabledStaticRulesets;
const maxSession = consts.MAX_NUMBER_OF_SESSION_RULES ?? dnr.maxNumberOfSessionRules;
const maxRegex = consts.MAX_NUMBER_OF_REGEX_RULES;
const maxGetMatched = consts.MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL;

if (typeof maxDyn === "number") {
  ok(`动态规则上限：${maxDyn.toLocaleString("en-US")}`);
} else {
  warn("动态规则上限：未取到");
}
if (typeof maxSession === "number") ok(`会话规则上限：${maxSession.toLocaleString("en-US")}`);
if (typeof maxStaticSets === "number") ok(`静态规则集总数上限：${maxStaticSets}`);
if (typeof maxEnabledSets === "number") ok(`可同时启用的静态规则集：${maxEnabledSets}`);
if (typeof maxRegex === "number") ok(`含正则的规则上限：${maxRegex}`);
if (typeof maxGetMatched === "number") ok(`getMatchedRules 调用配额：${maxGetMatched} 次 / 间隔`);

line("");
line("  这些数字以本机实测为准，不要引用文档或记忆里的旧值。");
line("  （注：Chrome 156 没有 getAvailableConstants()，常量直接挂在 API 对象上）");

// ---- 已用规则 ----
line("");
line("【当前规则占用】");
if (typeof dnr.dynamicRuleCount === "number") {
  const used = dnr.dynamicRuleCount;
  const cap = typeof maxDyn === "number" ? maxDyn : null;
  const pct = cap ? (used / cap * 100) : null;
  ok(`动态规则已用 ${used.toLocaleString("en-US")} 条` +
     (cap ? ` / 上限 ${cap.toLocaleString("en-US")}（${pct.toFixed(1)}%）` : ""));
  if (cap && pct >= 90) bad("占用率已 ≥90%，新增订阅或规则很可能触发 updateDynamicRules 整批失败");
  else if (cap && pct >= 70) warn("占用率偏高，注意剩余额度");

  const seg = dnr.dynamicRuleSegments || {};
  if (seg.user || seg.site || seg.subscription || seg.globalAllow) {
    line("");
    line("  分段明细（与 background.js 的 ID 段规划对应）：");
    line(`    用户自定义段 100000~109999 : ${(seg.user || 0).toLocaleString("en-US")}`);
    line(`    站点放行段   200000~209999 : ${(seg.site || 0).toLocaleString("en-US")}`);
    line(`    订阅段       300000~1299999: ${(seg.subscription || 0).toLocaleString("en-US")}`);
    line(`    全局放行     2000000       : ${(seg.globalAllow || 0).toLocaleString("en-US")}`);
    if (seg.other) line(`    其它/越界段                : ${(seg.other || 0).toLocaleString("en-US")}`);
    if (seg.other) {
      warn(`有 ${seg.other} 条规则落在已规划的 ID 段之外 —— 可能来自旧版本残留，或用户规则超过 10000 条后的溢出`);
    }
  }
} else {
  warn("动态规则数未取到");
}

// ---- 规则集 ----
line("");
line("【静态规则集】");
const rs = d.rulesets || {};
if (Array.isArray(rs.enabled)) {
  ok(`已启用 ${rs.enabled.length} 个：${rs.enabled.join(", ")}`);
} else {
  warn("已启用规则集未取到");
}

// ---- 反馈 API ----
line("");
line("【请求级反馈可用性】");
const fb = d.feedback || {};
if (fb.getMatchedRulesWorks) {
  ok(`getMatchedRules() 可用，命中 ${fb.matchedRuleCount || 0} 条`);
} else {
  warn("getMatchedRules() 不可用：" + (fb.getMatchedRulesError || "未知原因"));
}
if (fb.hasOnRuleMatchedDebug) {
  ok("onRuleMatchedDebug 事件存在");
} else {
  bad("onRuleMatchedDebug 事件不存在");
}
line("");
line("  判定要点（依据 Chrome 官方权限表）：");
line("  · declarativeNetRequestFeedback 权限「仅对未打包扩展生效，商店安装版被忽略」");
line("  · 因此正式安装版没有请求级明细（被拦域名、逐条日志）");
line("  · 正式版可用的路径是 activeTab + getMatchedRules({tabId})，");
line("    用户打开扩展弹窗时授予 activeTab，此时按标签页查询可拿到真实命中计数");

// ---- 端到端自检 ----
if (d.selfTest) {
  line("");
  line("【端到端自检：规则真的命中了吗】");
  const st = d.selfTest;
  if (st.staticRuleMatched) {
    const ids = (st.staticRuleHits || []).map(h => (h.rule && h.rule.ruleId));
    ok(`静态规则命中：ads 规则集拦下了请求（ruleId ${ids.join(", ") || "?"}）`);
  } else {
    bad("静态规则未命中 —— 规则集虽已启用，但请求没被拦下");
  }
  if (st.contentScriptInjected === true) ok("content script 已注入（元素隐藏样式存在）");
  else if (st.contentScriptInjected === false) bad("content script 未注入");
  if (st.urlCleaned) ok(`URL 参数清理生效：${st.urlCleanFinal || ""}`);
  else if (st.urlCleaned === false) bad("URL 参数清理未生效（utm_source 未被移除）");
  line("");
  line("  这三项是「文件加载了 / 规则集启用了 / 功能在跑」里最关键的第三个命题，");
  line("  规则集编译成功不等于功能真的在跑 [LRN-20261031-002]。");
}

// ---- 设置 ----
if (d.settings) {
  line("");
  line("【本扩展设置】");
  const st = d.settings;
  line(`  全局启用：${st.enabled === false ? "否" : "是"}`);
  line(`  规则集   ：${JSON.stringify(st.rulesets || {})}`);
  line(`  订阅数   ：${st.subscriptionCount ?? "?"}`);
  line(`  白名单数 ：${st.disabledSiteCount ?? "?"}`);
}

// ---- 错误 ----
if (Array.isArray(d.errors) && d.errors.length) {
  line("");
  line("【采集过程中的错误】");
  for (const e of d.errors) bad(e);
}

if (args.includes("-v")) {
  line("");
  line("===== 完整 JSON =====");
  line(JSON.stringify(d, null, 2));
}
line("");
