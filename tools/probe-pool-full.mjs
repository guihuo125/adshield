#!/usr/bin/env node
// AdShield 动态规则池边界诊断（可复用工具，非测试）
//
// 用途：把「动态规则池接近 / 达到上限时会发生什么」从「只能靠人手动灌规则再猜」
// 变成「一条命令 → 明确结论」。这个场景无法进 `npm run verify`：
// 它要把池子真的灌到 29,995 / 30,000 条，耗时且吃浏览器资源。
//
// 它验证的是**已修复的两条 P1 缺陷的防线还在不在**：
//   ① 池满时保存用户自定义规则 → 旧规则必须保住，不能「只删不加」被清空
//   ② updateDynamicRules 是原子操作 → 空 addRules 下发 = 只删不加
//
// 2026-11-01 修复前实测（缺陷复现）：
//   poolBefore: 29995 → poolAfter: 29990
//   用户规则段 100000~109999：保存前 5 条 → 保存后 0 条     ← 旧规则被清空
//   applied: 0，skipped: 2
// 修复后本脚本的预期：① 旧规则条数不变 ② applied === 0 且 skipped 覆盖全部条目
//                      ③ 旧规则内容仍在（urlFilter 未变）
//
// 用法：
//   node tools/probe-pool-full.mjs           跑诊断并输出结论
//   node tools/probe-pool-full.mjs --keep    保留临时 profile（调试用）
//   node tools/probe-pool-full.mjs --json    只输出原始 JSON
//
// 退出码：0 = 防线在；1 = 防线失效（回归了）；2 = 环境不可用（找不到 Chrome 等）

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, "adblocker");

const ARGS = process.argv.slice(2);
const JSON_ONLY = ARGS.includes("--json");
const KEEP = ARGS.includes("--keep");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  process.env.CHROMIUM_PATH
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/* ---------- CDP over pipe ----------
   Chrome 以 --remote-debugging-pipe 启动时通过 fd 3/4 通信。
   实测（本机 Chrome 156）：Node 侧向 fd 3 写入、Chrome 从 fd 4 读回，
   即 stdio 数组的 index 3 是写端、index 4 是读端。消息以 \0 分隔。
   与 probe-cdp.mjs 同一套协议。 */
class PipeCDP {
  constructor(readable, writable) {
    this.r = readable;
    this.w = writable;
    this.id = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.r.on("data", (chunk) => this._onData(chunk));
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let idx;
    while ((idx = this.buf.indexOf(0)) !== -1) {
      const msg = this.buf.subarray(0, idx).toString("utf8");
      this.buf = this.buf.subarray(idx + 1);
      if (!msg.trim()) continue;
      let m;
      try { m = JSON.parse(msg); } catch (e) { continue; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result);
      }
    }
  }
  send(method, params = {}, sessionId) {
    const mid = ++this.id;
    const payload = JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((res, rej) => {
      this.pending.set(mid, { res, rej });
      this.w.write(payload + "\0");
    });
  }
  close() { try { this.w.end(); } catch (e) { /* 已关闭 */ } }
}

let proc = null;
let cdp = null;
let profile = null;

async function cleanup(code) {
  try { if (cdp) cdp.close(); } catch (e) { /* 忽略 */ }
  try { if (proc) proc.kill(); } catch (e) { /* 忽略 */ }
  await sleep(400);
  if (profile) {
    if (KEEP) console.error("已保留临时 profile: " + profile);
    else { try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
  }
  process.exit(code);
}

const chrome = findChrome();
if (!chrome) {
  console.error("找不到 Chrome/Edge/Chromium，无法运行池边界诊断。");
  console.error("（本诊断需要真实浏览器环境，无法用纯 Node 模拟。）");
  process.exit(2);
}

try {
  profile = mkdtempSync(join(tmpdir(), "adshield-poolprobe-"));
  proc = spawn(chrome, [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-sync",
    "about:blank"
  ], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });

  cdp = new PipeCDP(proc.stdio[4], proc.stdio[3]);

  // 1) 加载扩展
  let extId = null;
  try {
    const r = await cdp.send("Extensions.loadUnpacked", { path: EXT_DIR });
    extId = r && r.id;
    if (!JSON_ONLY) console.error(`✓ 扩展已加载，ID: ${extId}`);
  } catch (e) {
    console.error("Extensions.loadUnpacked 失败：" + (e && e.message));
    console.error("提示：需要 Chrome 126+ 且带 --enable-unsafe-extension-debugging");
    await cleanup(2);
  }

  // 2) 等 service worker 出现（确认真的加载了）
  let swUrl = null;
  for (let i = 0; i < 30 && !swUrl; i++) {
    try {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const sw = targetInfos.find(t => t.url.startsWith("chrome-extension://" + extId));
      if (sw) swUrl = sw.url; else await sleep(300);
    } catch (e) { await sleep(300); }
  }
  if (!swUrl) {
    console.error("扩展的 service worker 未出现，扩展可能没真正加载。");
    await cleanup(2);
  }

  // 3) 打开扩展页面（扩展页面才能调 chrome.declarativeNetRequest）
  const probeUrl = `chrome-extension://${extId}/src/probe.html`;
  const { targetId } = await cdp.send("Target.createTarget", { url: probeUrl });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(2000);

  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true
    }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      return "EXC:" + ((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return r.result && r.result.value;
  };

  /* ---------- 场景 A：原子性（池未满，探「只删不加」是否存在）----------
     直接调 updateDynamicRules，把 remove 和 add 放在同一次调用里，
     看 Chrome 是不是「先删后加」的原子操作 —— 这是缺陷 1 的机理前提。 */
  const atomics = await evaluate(`(async () => {
    const dnr = chrome.declarativeNetRequest;
    const out = {};
    // A1: 同一次调用里，同一 ID 同时出现在 removeRuleIds 与 addRules
    const ID = 555001;
    try {
      await dnr.updateDynamicRules({
        removeRuleIds: [ID],
        addRules: [{ id: ID, priority: 1, action: { type: "block" },
                     condition: { urlFilter: "||adshield-atomic-probe.test^" } }]
      });
      const cur = await dnr.getDynamicRules();
      out.sameIdRemoveAndAdd = { ok: true, present: cur.some(x => x.id === ID) };
    } catch (e) { out.sameIdRemoveAndAdd = { ok: false, error: String(e && e.message || e) }; }
    // A2: 空 addRules + 有 remove —— 这就是「只删不加」
    try {
      await dnr.updateDynamicRules({ removeRuleIds: [ID], addRules: [] });
      const cur = await dnr.getDynamicRules();
      out.emptyAddRules = { ok: true, stillPresent: cur.some(x => x.id === ID) };
    } catch (e) { out.emptyAddRules = { ok: false, error: String(e && e.message || e) }; }
    // A3: 整批超限 —— 应整批拒绝，规则数一条不变
    const MAX = dnr.MAX_NUMBER_OF_DYNAMIC_RULES;
    let cur = await dnr.getDynamicRules();
    const before = cur.length;
    try {
      await dnr.updateDynamicRules({
        removeRuleIds: [],
        addRules: Array.from({ length: MAX + 10 }, (_, i) => ({
          id: 7000000 + i, priority: 1, action: { type: "block" },
          condition: { urlFilter: "||over" + i + ".test^" }
        }))
      });
      out.overLimit = { ok: true };
    } catch (e) { out.overLimit = { ok: false, error: String(e && e.message || e) }; }
    cur = await dnr.getDynamicRules();
    out.overLimitCountBefore = before;
    out.overLimitCountAfter = cur.length;
    out.MAX = MAX;
    return JSON.stringify(out);
  })()`);

  /* ---------- 场景 B：真实 background.js 路径，池满时保存用户规则 ----------
     走真实的 saveUserRules 消息，不复刻逻辑。 */
  const poolFull = await evaluate(`(async () => {
    const dnr = chrome.declarativeNetRequest;
    const MAX = dnr.MAX_NUMBER_OF_DYNAMIC_RULES;
    const out = { MAX };

    // 清空所有动态规则，建立干净基线
    let cur = await dnr.getDynamicRules();
    if (cur.length) await dnr.updateDynamicRules({ removeRuleIds: cur.map(function(x){return x.id}), addRules: [] });
    cur = await dnr.getDynamicRules();
    out.baseline = cur.length;

    // 先正常装 5 条用户规则（走真实路径）
    await chrome.runtime.sendMessage({
      type: "saveUserRules",
      rules: ["||adshield-u1.test^","||adshield-u2.test^","||adshield-u3.test^","||adshield-u4.test^","||adshield-u5.test^"]
    });
    await new Promise(function(r){ setTimeout(r, 2500); });
    const userSeg = () => dnr.getDynamicRules().then(function(all){
      return all.filter(function(x){ return x.id >= 100000 && x.id < 110000; });
    });
    const segBefore = await userSeg();
    out.userSegBefore = segBefore.length;
    out.userSegBeforeIds = segBefore.map(function(x){ return x.id; });
    out.userSegBeforeFilters = segBefore.map(function(x){ return x.condition.urlFilter; });

    // 把池子灌到 MAX-5（用 9000000+ 段，避开用户段与订阅段）
    cur = await dnr.getDynamicRules();
    let added = 0;
    const target = MAX - 5;
    while (added < target - cur.length) {
      const n = Math.min(2000, target - cur.length - added);
      const chunk = [];
      for (let i = 0; i < n; i++) chunk.push({
        id: 9000000 + added + i, priority: 1, action: { type: "block" },
        condition: { urlFilter: "||adshield-fill" + (added + i) + ".test^" }
      });
      try {
        await dnr.updateDynamicRules({ removeRuleIds: [], addRules: chunk });
        added += chunk.length;
      } catch (e) {
        out.fillError = String(e && e.message || e);
        break;
      }
    }
    cur = await dnr.getDynamicRules();
    out.poolBefore = cur.length;
    out.poolFilledTo = cur.length;

    // 池满时保存 2 条新规则 → 期望：旧规则一条都不能少
    const resp = await chrome.runtime.sendMessage({
      type: "saveUserRules", rules: ["||adshield-n1.test^", "||adshield-n2.test^"]
    });
    await new Promise(function(r){ setTimeout(r, 3000); });

    const st = await chrome.storage.local.get("adshield_user_rules_result");
    const res = st.adshield_user_rules_result;
    cur = await dnr.getDynamicRules();
    const segAfter = await userSeg();
    out.poolAfter = cur.length;
    out.userSegAfter = segAfter.length;
    out.userSegAfterIds = segAfter.map(function(x){ return x.id; });
    out.userSegAfterFilters = segAfter.map(function(x){ return x.condition.urlFilter; });
    out.applied = res && res.result && res.result.applied;
    out.skippedCount = res && res.result && res.result.skipped && res.result.skipped.length;
    out.firstSkip = res && res.result && res.result.skipped && res.result.skipped[0];
    out.resultOk = res && res.ok;
    out.storedRules = (await chrome.storage.local.get("adshield_user_rules")).adshield_user_rules;
    out.respPending = resp && resp.pending;

    // 清理
    try {
      const all = await dnr.getDynamicRules();
      await dnr.updateDynamicRules({ removeRuleIds: all.map(function(x){return x.id}), addRules: [] });
    } catch (e) { /* 忽略 */ }
    return JSON.stringify(out);
  })()`);

  try { await cdp.send("Target.closeTarget", { targetId }); } catch (e) { /* 忽略 */ }

  const data = {
    collectedAt: new Date().toISOString(),
    chrome: chrome,
    atomics: JSON.parse(atomics),
    poolFull: JSON.parse(poolFull)
  };

  /* ---------- 判定 ---------- */
  const a = data.atomics;
  const b = data.poolFull;

  // 防线 1：池满时旧用户规则必须保住
  const oldRulesKept = b.userSegBefore > 0 && b.userSegAfter === b.userSegBefore;
  // 防线 2：旧规则内容未变（不是被换成了别的）
  const contentKept = JSON.stringify(b.userSegBeforeFilters) === JSON.stringify(b.userSegAfterFilters);
  // 防线 3：未应用时必须明确回传，不能静默
  const reported = b.applied === 0 && b.skippedCount > 0;
  // 机理前提：空 addRules 下发 = 只删不加（这正是缺陷 1 的成因）
  const emptyAddDeletes = a.emptyAddRules && a.emptyAddRules.ok && a.emptyAddRules.stillPresent === false;
  // 整批超限必须原子拒绝
  const atomicReject = a.overLimit && a.overLimit.ok === false &&
                       a.overLimitCountAfter === a.overLimitCountBefore;

  const defensePresent = oldRulesKept && contentKept && reported && emptyAddDeletes && atomicReject;

  if (JSON_ONLY) {
    console.log(JSON.stringify(data, null, 2));
    await cleanup(defensePresent ? 0 : 1);
  }

  const line = (s = "") => console.log(s);
  const ok = (s) => console.log("  ✓ " + s);
  const bad = (s) => console.log("  ✗ " + s);
  const warn = (s) => console.log("  ⚠ " + s);

  line("===== AdShield 动态规则池边界诊断 =====");
  line("");
  line(`采集时间 : ${data.collectedAt}`);
  line(`动态规则上限 : ${b.MAX.toLocaleString("en-US")}`);

  line("");
  line("【原子性：updateDynamicRules 的真实语义】");
  if (a.sameIdRemoveAndAdd && a.sameIdRemoveAndAdd.ok) {
    if (a.sameIdRemoveAndAdd.present) {
      ok("同一 ID 同时出现在 removeRuleIds 与 addRules → 被接受，规则存在");
      line("     （Chrome 156 实测。ARCHITECTURE.md 已按此修订）");
    } else {
      bad("同一 ID 同时 remove + add → 规则未生效");
    }
  } else {
    bad("同一 ID 同时 remove + add → 报错：" + (a.sameIdRemoveAndAdd.error || "未知"));
  }
  if (emptyAddDeletes) {
    ok("空 addRules + 有 remove → 只删不加（这就是「旧规则被清空」的机理）");
  } else {
    warn("空 addRules + 有 remove → 规则仍在（语义与预期不同，请重新核对机理）");
  }
  if (atomicReject) {
    ok(`整批超限 → 整批拒绝，规则数不变（${a.overLimitCountBefore} → ${a.overLimitCountAfter}）`);
  } else {
    bad("整批超限 → 未被原子拒绝，或规则数变了（部分生效？）");
  }

  line("");
  line("【池满时保存用户规则（真实 background.js 路径）】");
  line(`  灌池前用户规则段条数 : ${b.userSegBefore}  (id ${JSON.stringify(b.userSegBeforeIds)})`);
  line(`  池子灌到             : ${b.poolFilledTo} / ${b.MAX}`);
  line(`  保存 2 条新规则后    :`);
  line(`    池总数             : ${b.poolAfter}`);
  line(`    用户规则段条数     : ${b.userSegAfter}  (id ${JSON.stringify(b.userSegAfterIds)})`);
  line(`    applied            : ${b.applied}`);
  line(`    skipped            : ${b.skippedCount}`);
  if (b.firstSkip) line(`    首条 skipped       : ${JSON.stringify(b.firstSkip)}`);
  line(`    storage 里的规则   : ${JSON.stringify(b.storedRules)}`);

  line("");
  line("【防线判定】");
  if (oldRulesKept) ok(`旧用户规则保住了（${b.userSegBefore} → ${b.userSegAfter}）`);
  else bad(`旧用户规则被删了（${b.userSegBefore} → ${b.userSegAfter}）—— 缺陷 1 回归！`);
  if (contentKept) ok("旧规则内容未被替换");
  else bad("旧规则内容被替换了");
  if (reported) ok("未应用的规则已回传给用户（skipped 有内容），不是静默失败");
  else bad("未应用却没回传 skipped —— 用户看不到发生了什么");

  line("");
  if (defensePresent) {
    ok("结论：防线在。池满时旧规则保住、失败被明确告知、updateDynamicRules 语义与预期一致。");
  } else {
    bad("结论：防线失效。至少一条不满足，需要修。");
  }
  line("");
  line("  注：本工具是诊断工具，不进 `npm run verify`（要真把池子灌到上限，代价高）。");
  line("  把它当回归工具用时，看退出码：0 = 防线在，1 = 回归了。");

  await cleanup(defensePresent ? 0 : 1);
} catch (e) {
  console.error("诊断失败：" + (e && e.message || e));
  await cleanup(2);
}
