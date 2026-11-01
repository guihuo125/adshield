#!/usr/bin/env node
// AdShield 运行时诊断 —— Chrome 137+ 兼容版
//
// 背景：Chrome 137 起，官方品牌版移除了 --load-extension 标志
//   （--disable-features=DisableLoadExtensionCommandLineSwitch 在 142+ 也失效）。
//   官方替代方案是 CDP 的 Extensions.loadUnpacked 命令，
//   它要求浏览器以 --remote-debugging-pipe + --enable-unsafe-extension-debugging 启动。
//
// 做法：
//   1. 启动独立 Chrome 实例（临时 profile，不碰用户日常浏览器）
//   2. 通过 pipe 通道说 CDP 协议，发 Extensions.loadUnpacked 加载扩展
//   3. 打开扩展自己的诊断页，取回采集结果
//
// 零第三方依赖：Node 22 内置 WebSocket / fetch + pipe 通信。
//
// 用法：
//   node tools/probe-cdp.mjs              采集并解读
//   node tools/probe-cdp.mjs --json       只输出原始 JSON
//   node tools/probe-cdp.mjs --keep       保留临时 profile（调试用）

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, "adblocker");
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  // Chrome for Testing / Chromium 仍支持 --load-extension，作为回退
  process.env.CHROMIUM_PATH
].filter(Boolean);

const ARGS = process.argv.slice(2);
const JSON_ONLY = ARGS.includes("--json");
const KEEP = ARGS.includes("--keep");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/* ---------- CDP over pipe ----------
   Chrome 以 --remote-debugging-pipe 启动时，通过 fd 3/4 通信。
   实测（本机 Chrome 156）：Node 侧向 fd 3 写入、Chrome 从 fd 4 读回，
   即 stdio 数组的 index 3 是写端、index 4 是读端。
   消息格式与 WebSocket 版一致：以 \0 分隔的 JSON。 */
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
if (!chrome) { console.error("找不到 Chrome/Edge/Chromium。"); process.exit(1); }

try {
  profile = mkdtempSync(join(tmpdir(), "adshield-probe-"));

  // stdio: [stdin, stdout, stderr, fd3(Chrome 读), fd4(Chrome 写)]
  proc = spawn(chrome, [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-sync",
    "about:blank"
  ], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });

  // fd3 = 写端（Node → Chrome），fd4 = 读端（Chrome → Node）
  cdp = new PipeCDP(proc.stdio[4], proc.stdio[3]);

  // 1) 加载扩展
  let extId = null;
  try {
    const r = await cdp.send("Extensions.loadUnpacked", { path: EXT_DIR });
    extId = r && r.id;
    if (!JSON_ONLY) console.error(`✓ 扩展已加载（Extensions.loadUnpacked），ID: ${extId}`);
  } catch (e) {
    console.error("Extensions.loadUnpacked 失败：" + (e && e.message));
    console.error("提示：需要 Chrome 126+ 且带 --enable-unsafe-extension-debugging");
    await cleanup(1);
  }

  // 2) 找到扩展的 service worker（确认真的加载了）
  let swUrl = null;
  for (let i = 0; i < 30 && !swUrl; i++) {
    try {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const sw = targetInfos.find(t => t.url.startsWith("chrome-extension://" + extId));
      if (sw) swUrl = sw.url;
      else await sleep(300);
    } catch (e) { await sleep(300); }
  }
  if (!swUrl) {
    console.error("扩展的 service worker 未出现，扩展可能没真正加载。");
    await cleanup(1);
  }
  if (!JSON_ONLY) console.error(`✓ service worker: ${swUrl}`);

  // 3) 打开诊断页
  const probeUrl = `chrome-extension://${extId}/src/probe.html`;
  const { targetId } = await cdp.send("Target.createTarget", { url: probeUrl });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  // 4) 等采集结果
  let data = null;
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    try {
      const r = await cdp.send("Runtime.evaluate", {
        expression: "document.getElementById('status') && document.getElementById('status').textContent",
        returnByValue: true
      }, sessionId);
      const status = r.result && r.result.value;
      if (status && status.includes("采集完成")) {
        const j = await cdp.send("Runtime.evaluate", {
          expression: "document.getElementById('out').textContent",
          returnByValue: true
        }, sessionId);
        data = JSON.parse(j.result.value);
        break;
      }
      if (status && status.includes("采集失败")) {
        console.error("诊断页采集失败：" + status);
        await cleanup(1);
      }
    } catch (e) { /* 页面还在加载 */ }
  }
  if (!data) { console.error("等待诊断页结果超时"); await cleanup(1); }

  // 5) 补采：未打包模式下 feedback API 是否真的可用
  try {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        try {
          const res = await chrome.declarativeNetRequest.getMatchedRules();
          return { ok: true, count: (res.rulesMatchedInfo || []).length };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })()`,
      awaitPromise: true, returnByValue: true
    }, sessionId);
    data.feedback.getMatchedRulesWorks = r.result.value.ok;
    if (!r.result.value.ok) data.feedback.getMatchedRulesError = r.result.value.error;
    else data.feedback.matchedRuleCount = r.result.value.count;
  } catch (e) { /* 忽略 */ }

  /* ---------- 6) 端到端自检：规则真的命中吗？ ----------
     LRN-20261031-002 的教训：「文件加载了 / 规则集启用了 / 功能在跑」
     是三个互不相同的命题，只有第三个需要命中证据。
     这里做两个真实验证：
       ① 静态规则：访问一个 ads 规则集覆盖的域名，看 getMatchedRules 是否记到命中
       ② URL 清理：访问带 ?utm_source= 的 URL，看是否被重定向掉 */
  data.selfTest = {};
  try {
    // ① 静态规则命中
    const t = await cdp.send("Target.createTarget", { url: "https://ad.doubleclick.net/" });
    const { sessionId: s2 } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await sleep(4500);
    const mr = await cdp.send("Runtime.evaluate", {
      expression: `chrome.declarativeNetRequest.getMatchedRules()
        .then(r => JSON.stringify(r.rulesMatchedInfo))
        .catch(e => 'ERR ' + e.message)`,
      returnByValue: true, awaitPromise: true
    }, sessionId);
    let hits = [];
    try { hits = JSON.parse(mr.result.value) || []; } catch (e) { /* 非 JSON */ }
    data.selfTest.staticRuleMatched = hits.length > 0;
    data.selfTest.staticRuleHits = hits.slice(0, 5);
    // content script 是否注入
    const cs = await cdp.send("Runtime.evaluate", {
      expression: "document.getElementById('__adshield_cosmetic__') ? 'yes' : 'no'",
      returnByValue: true
    }, s2);
    data.selfTest.contentScriptInjected = cs.result.value === "yes";
    await cdp.send("Target.closeTarget", { targetId: t.targetId });
  } catch (e) {
    data.selfTest.staticRuleMatched = false;
    data.selfTest.error = String(e && e.message || e);
  }
  try {
    // ② URL 清理（url_clean 规则集，ruleId 3000~3028）
    const t = await cdp.send("Target.createTarget", { url: "https://example.com/?utm_source=probe_test" });
    const { sessionId: s3 } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await sleep(3500);
    const r3 = await cdp.send("Runtime.evaluate", {
      expression: "location.href", returnByValue: true
    }, s3);
    const finalUrl = r3.result.value || "";
    data.selfTest.urlCleaned = !/utm_source=/.test(finalUrl);
    data.selfTest.urlCleanFinal = finalUrl;
    await cdp.send("Target.closeTarget", { targetId: t.targetId });
  } catch (e) {
    data.selfTest.urlCleaned = false;
  }

  try { await cdp.send("Target.closeTarget", { targetId }); } catch (e) { /* 忽略 */ }

  if (JSON_ONLY) {
    console.log(JSON.stringify(data, null, 2));
    await cleanup(0);
  } else {
    const tmpJson = join(profile, "probe.json");
    writeFileSync(tmpJson, JSON.stringify(data, null, 2), "utf8");
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [join(ROOT, "tools", "probe-dnr.mjs"), tmpJson], { stdio: "inherit" });
    await cleanup(r.status || 0);
  }
} catch (e) {
  console.error("诊断失败：" + (e && e.message || e));
  await cleanup(1);
}
