#!/usr/bin/env node
// 把工作区同步到 git 仓库，并做逐字节校验。
//
// 背景：项目是「两个目录」结构 —— 工作区（打包源）与 git 仓库。
// 改完忘了同步 = 发出去的包和 git 历史不一致（远端交接文档 §7.1 记录过这个坑）。
// 本脚本把同步 + 校验合成一步，避免漏。
//
// 用法：
//   node tools/sync-repo.mjs                          同步 + 校验（不提交）
//   node tools/sync-repo.mjs --commit "提交信息"       同步 + 校验 + 在仓库提交（不 push）
//
// 不会做的事：git push、修改签名密钥、打包。发布前请自行按远端文档 §8 第 10/13 条操作。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const WORKSPACE = "D:/AdShield 广告拦截器";
const REPO = "D:/temp-adshield-repo";

const argv = process.argv.slice(2);
const DO_COMMIT = argv[0] === "--commit";
const COMMIT_MSG = DO_COMMIT ? (argv[1] || "") : "";
if (DO_COMMIT && !COMMIT_MSG) {
  console.error('用法：node tools/sync-repo.mjs --commit "提交信息"');
  process.exit(1);
}

for (const d of [WORKSPACE, REPO]) {
  if (!existsSync(d)) { console.error(`目录不存在：${d}`); process.exit(1); }
}
if (!existsSync(join(REPO, ".git"))) { console.error(`${REPO} 不是 git 仓库`); process.exit(1); }

/** 递归列出文件（相对路径，posix 分隔），可排除目录 */
function walk(dir, base = dir, acc = [], excludeDirs = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (excludeDirs.includes(e.name)) continue;
      walk(join(dir, e.name), base, acc, excludeDirs);
    } else {
      acc.push(relative(base, join(dir, e.name)).split("\\").join("/"));
    }
  }
  return acc;
}

function copyTree(from, to, excludeDirs = []) {
  const files = walk(from, from, [], excludeDirs);
  for (const f of files) {
    const dst = join(to, f);
    mkdirSync(join(dst, ".."), { recursive: true });
    copyFileSync(join(from, f), dst);
  }
  // 注意：**不删除目标端多出来的文件**。
  // 工作区不是仓库的子集 —— 仓库里有工作区没有的东西（docs/AI-HANDOVER.md、
  // tools/verify-*.js 等真机验证脚本），早期版本用 --delete 语义把它们删掉了。
  // 只有工作区确实废弃了某个文件时，才手动从仓库删除。
  return files.length;
}

/* ---------- 1. 同步 ---------- */
console.log("===== 1. 同步 adblocker/ =====");
const n1 = copyTree(join(WORKSPACE, "adblocker"), join(REPO, "adblocker"), ["_metadata"]);
console.log(`  ✓ adblocker/ 已同步（${n1} 个文件）`);

console.log("===== 2. 同步 tools/、docs/ 与 package.json =====");
const n2 = copyTree(join(WORKSPACE, "tools"), join(REPO, "tools"), []);
copyFileSync(join(WORKSPACE, "package.json"), join(REPO, "package.json"));
// docs/ 是 GitHub Pages 的站点根（CNAME/index.html 在里面），必须一起同步
const n3 = copyTree(join(WORKSPACE, "docs"), join(REPO, "docs"), []);
console.log(`  ✓ tools/（${n2}）docs/（${n3}）与 package.json 已同步`);

/* ---------- 3. 逐字节校验 ---------- */
console.log("===== 3. 逐字节校验 =====");
const wsFiles = walk(join(WORKSPACE, "adblocker"), join(WORKSPACE, "adblocker"), [], ["_metadata"]).sort();
let diffs = [];
for (const f of wsFiles) {
  const a = readFileSync(join(WORKSPACE, "adblocker", f));
  const rp = join(REPO, "adblocker", f);
  if (!existsSync(rp)) { diffs.push(f + "（仓库缺失）"); continue; }
  if (!a.equals(readFileSync(rp))) diffs.push(f);
}
if (diffs.length) {
  console.log(`  ✗ ${diffs.length} 个文件不一致：`);
  for (const d of diffs) console.log("    " + d);
  process.exit(1);
}
console.log(`  ✓ ${wsFiles.length}/${wsFiles.length} 个文件逐字节一致`);

// 仓库里工作区没有的文件（真机验证脚本、docs 等）——列出来提醒，但不删
const repoOnly = walk(join(REPO, "adblocker"), join(REPO, "adblocker"), [], ["_metadata"])
  .filter(f => !wsFiles.includes(f));
if (repoOnly.length) {
  console.log(`  ℹ 仓库独有（工作区没有，保留不动）: ${repoOnly.join(", ")}`);
}

/* ---------- 4. 提交 ---------- */
if (DO_COMMIT) {
  console.log("===== 4. 提交（不 push）=====");
  const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
  git("add", "-A");
  // git diff --cached --quiet 退出码非 0 表示「有差异」。
  // execFileSync 遇非 0 会抛异常，所以这里用 status 判断而不是直接调。
  let hasChanges = true;
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: REPO, stdio: "ignore" });
    hasChanges = false;   // 退出码 0 = 无差异
  } catch (e) {
    hasChanges = true;    // 退出码非 0 = 有差异
  }
  if (!hasChanges) {
    console.log("  没有变化，跳过提交");
  } else {
    git("commit", "-q", "-m", COMMIT_MSG);
    console.log("  ✓ 已提交：" + git("log", "--oneline", "-1").trim());
  }
  console.log("");
  console.log("  提醒：远端交接文档 §8 第 10 条 —— push 与发布需先确认。");
  const unpushed = git("log", "--oneline", "origin/main..HEAD").trim();
  console.log("  未推送的提交：");
  console.log(unpushed ? unpushed.split("\n").map(l => "    " + l).join("\n") : "    （无）");
} else {
  console.log("");
  console.log("===== 完成（未提交）=====");
  console.log('  如需提交：node tools/sync-repo.mjs --commit "你的提交信息"');
}
