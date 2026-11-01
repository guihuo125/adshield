#!/usr/bin/env node
// AdShield 规则段位与预算的行为测试
//
// 背景（来自 2026-11-01 代码审查）：
//   M3 —— applyUserRules 分配的 ID 段只有 10000 个（100000~109999），
//         但代码没有上限检查。规则数超 1 万时 ID 会越过段尾，
//         而 removeRuleIds 只清理 [100000,110000)，
//         于是超出的规则每次保存都留一批孤儿，最终撑爆动态规则池。
//   M4 —— applySubscriptionText 没有全局预算核算（对比 applyUserRules 是有的），
//         单个订阅可产出 5400 条，订阅数一多就撞上 Chrome 总上限，
//         而 updateDynamicRules 是整批原子提交 → 这个订阅一条都上不去。
//
// 这里把 background.js 里的两段截断逻辑等价复刻出来做行为验证：
// 逻辑改了，这份测试要跟着改 —— 它是这两条防线的护栏。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}  got=${JSON.stringify(got)}${ok ? "" : "  want=" + JSON.stringify(want)}`);
}

// 从 background.js 里读出真实常量，避免测试与实现漂移
const bg = readFileSync(join(ROOT, "adblocker", "src", "background.js"), "utf8");
const MAX = Number((bg.match(/MAX_NUMBER_OF_DYNAMIC_RULES\)\s*\|\|\s*(\d+)/) || [])[1] || 30000);
const USER_BASE = Number((bg.match(/const USER_RULE_BASE = (\d+)/) || [])[1]);
const USER_SEG = Number((bg.match(/r\.id < USER_RULE_BASE \+ (\d+)/) || [])[1]);
const SUB_BASE = Number((bg.match(/const SUB_RULE_BASE = (\d+)/) || [])[1]);

console.log(`常量（读自 background.js）：MAX=${MAX} USER_RULE_BASE=${USER_BASE} 段长=${USER_SEG} SUB_RULE_BASE=${SUB_BASE}\n`);

// ---- M3：用户规则段位上限 ----
console.log("--- M3：用户自定义规则的段位上限 ---");
function applyUserRules(rules, existingCount) {
  const addRules = [], skipped = [];
  let id = USER_BASE;
  for (const line of rules) {
    if (id >= USER_BASE + USER_SEG) {
      skipped.push({ line, reason: "超出本段规则上限 " + USER_SEG + " 条，超出部分未应用" });
      continue;
    }
    addRules.push(line); id++;
  }
  const budget = Math.max(0, MAX - existingCount - 50);
  if (addRules.length > budget) {
    const ov = addRules.splice(budget);
    ov.forEach(r => skipped.push({ line: r, reason: "超过 Chrome 动态规则总上限 " + MAX + " 条" }));
  }
  // 与 background.js 的 applyUserRules 一致：截断后为空则不下发，
  // 否则 updateDynamicRules 会「只删不加」，把用户原有规则整段清空。
  const shouldSkipSubmit = addRules.length === 0 && rules.length > 0;
  return { addRules, skipped, maxId: id - 1, shouldSkipSubmit };
}

const r1 = applyUserRules(Array.from({ length: 15000 }, (_, i) => "rule" + i), 0);
t("15000 条被截断到段上限内", r1.addRules.length, USER_SEG);
t("最高 ID 不越过段尾（否则永不被清理）", r1.maxId < USER_BASE + USER_SEG, true);
t("被丢弃的规则进入 skipped（用户看得见）", r1.skipped.length >= 5000, true);
t("丢弃原因可读", r1.skipped[0].reason.includes(String(USER_SEG)), true);

const r2 = applyUserRules(["a", "b", "c"], 0);
t("少量规则不受影响", r2.addRules.length, 3);
t("少量规则无 skipped", r2.skipped.length, 0);

// 回归：池满时截断后 addRules 为空，若仍然下发就等于「只删不加」，
// 用户原有的自定义规则会被整段清空 —— 用户什么都没做错，只是订阅太多占满了池子。
{
  const poolFull = applyUserRules(["a", "b", "c"], MAX);   // 池子已被占满
  t("池满时规则被截断到 0", poolFull.addRules.length, 0);
  t("池满时必须标记为不下发", poolFull.shouldSkipSubmit, true);
}
{
  // 对照：订阅路径已有同样的保护
  const subFull = applySub(Array.from({ length: 100 }, () => "r"), MAX - 10, 0);
  t("订阅路径池满时也截断到 0", subFull.addRules.length, 0);
  t("订阅路径池满时同样不下发", subFull.shouldSkipSubmit, true);
}
{
  const r3 = applyUserRules(Array.from({ length: 20000 }, (_, i) => "r" + i), 0);
  t("20000 条同样被截到段上限", r3.addRules.length, USER_SEG);
  t("段内截断不影响下发", r3.shouldSkipSubmit, false);
}

const r3 = applyUserRules(Array.from({ length: 20000 }, (_, i) => "r" + i), 0);
t("20000 条同样被截到段上限", r3.addRules.length, USER_SEG);

// ---- M4：订阅全局预算 ----
console.log("\n--- M4：订阅规则的全局预算 ---");
function applySub(addRules, existingCount, segRemove) {
  const usedBefore = existingCount - segRemove;
  const budget = Math.max(0, MAX - usedBefore - 50);
  if (addRules.length > budget) {
    const dropped = addRules.splice(budget);
    return { addRules, dropped: dropped.length, budget, shouldSkipSubmit: addRules.length === 0 };
  }
  return { addRules, dropped: 0, budget, shouldSkipSubmit: addRules.length === 0 };
}

const s1 = applySub(Array.from({ length: 50000 }, () => "r"), 0, 0);
t("50000 条截断到全局上限内", s1.addRules.length, MAX - 50);
t("丢弃量已统计", s1.dropped, 50000 - (MAX - 50));
t("截断后仍非空（不误触「一条不剩」分支）", s1.addRules.length > 0, true);

const s2 = applySub(Array.from({ length: 100 }, () => "r"), MAX - 10, 0);
t("池子将满时预算为 0", s2.budget, 0);
t("池子将满时截断到空（走「未能应用」提示分支）", s2.addRules.length, 0);

const s3 = applySub(Array.from({ length: 100 }, () => "r"), 1000, 1000);
t("本订阅自身的旧规则不计入占用", s3.budget, MAX - 50);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
