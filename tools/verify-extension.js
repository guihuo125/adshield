// AdShield 真机验证脚本（CDP harness）
// 用法：node tools\verify-extension.js
// 前置：Chrome 156+，扩展源码在 D:\AdShield 广告拦截器\adblocker
// 做三件事：全局暂停真的停用动态规则 / 全局放行规则增删正确 / 设置页提示条可见
// 依赖：Chrome 137+ 移除了 --load-extension，这里用 CDP Extensions.loadUnpacked 加载
// 精简真机验证：加载扩展 -> 全局暂停行为 -> 设置页截图
const { spawn } = require("child_process");
const http = require("http");
const os = require("os"); const path = require("path"); const fs = require("fs");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT_SRC = "D:\\AdShield 广告拦截器\\adblocker";
const WORK = path.join(os.tmpdir(), "adshield-selftest");
const EXT = path.join(WORK, "ext"); const PROFILE = path.join(WORK, "profile-final");
const PORT = 9420; const HTTP_PORT = 8920;
const GLOBAL_ALLOW_RULE_ID = 2000000; const TEST_BLOCK_RULE_ID = 1900000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(l, a, e) { const ok = JSON.stringify(a) === JSON.stringify(e); if (!ok) failures++;
  console.log((ok ? "PASS" : "FAIL") + "  " + l); if (!ok) console.log("      实际=" + JSON.stringify(a) + " 期望=" + JSON.stringify(e)); }
function mkClient(url, tag) { return new Promise((res, rej) => {
  const ws = new WebSocket(url); let id = 0; const pend = new Map(); const hs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.method) { hs.forEach(h => h(m)); return; }
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); clearTimeout(p.t);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  ws.onerror = () => rej(new Error(tag + " ws"));
  ws.onopen = () => res({ on: h => hs.push(h),
    send: (method, params) => new Promise((r, j) => { const i = ++id;
      const t = setTimeout(() => { pend.delete(i); j(new Error(tag + " " + method + " 超时")); }, 20000);
      pend.set(i, { res: r, rej: j, t }); ws.send(JSON.stringify({ id: i, method, params })); }),
    close: () => ws.close() }); }); }
(async () => {
  const server = http.createServer((q, s) => { s.writeHead(200); s.end("ok"); });
  await new Promise(r => server.listen(HTTP_PORT, "127.0.0.1", r));
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
  fs.rmSync(EXT, { recursive: true, force: true }); fs.cpSync(EXT_SRC, EXT, { recursive: true });
  const chrome = spawn(CHROME, ["--no-first-run", "--no-default-browser-check",
    "--remote-allow-origins=*", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
    "--window-position=-32000,-32000", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} try { server.close(); } catch (e) {} };
  process.on("exit", cleanup);
  let v = null;
  for (let i = 0; i < 40; i++) { try { v = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json(); break; } catch (e) {} await sleep(500); }
  const browser = await mkClient(v.webSocketDebuggerUrl, "browser");
  const r = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const extId = r.id; console.log("扩展已加载 " + extId);
  const mk = async (url) => { const t = await browser.send("Target.createTarget", { url });
    let p = null; for (let i = 0; i < 40; i++) { const l = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      p = l.find(x => x.type === "page" && x.id === t.targetId); if (p) break; await sleep(300); }
    const c = await mkClient(p.webSocketDebuggerUrl, "pg"); await c.send("Runtime.enable", {}); await sleep(2200);
    c.ev = async (e) => { const rr = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
      if (rr.exceptionDetails) return { __err: rr.exceptionDetails.text }; return rr.result.value; };
    return c; };
  const ext = await mk("chrome-extension://" + extId + "/src/options.html");
  const nav = await mk("about:blank");
  await nav.send("Page.enable", {}); await nav.send("Network.enable", {});
  let evs = []; nav.on(m => { if (m.method === "Network.loadingFailed") evs.push({ f: 1, e: m.params.errorText });
    else if (m.method === "Network.responseReceived") evs.push({ r: 1, s: m.params.response.status }); });
  await ext.ev(`(async () => { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [], addRules: [
    { id: ${TEST_BLOCK_RULE_ID}, priority: 1, action: { type: "block" }, condition: { urlFilter: "||127.0.0.1:" + ${HTTP_PORT} } }] });
    return true; })()`);
  const load = async () => { evs = []; await nav.send("Page.navigate", { url: "http://127.0.0.1:" + HTTP_PORT + "/x.txt" }); await sleep(3000);
    const f = evs.find(x => x.f); if (f) return /BLOCKED/i.test(f.e) ? "BLOCKED" : "FAILED:" + f.e;
    return evs.find(x => x.r && x.s === 200) ? "LOADED" : "NONE"; };
  const setEnabled = async (v2) => { await ext.ev(`(async () => { const st = await chrome.storage.local.get("adshield_settings");
    await chrome.storage.local.set({ adshield_settings: Object.assign({}, st.adshield_settings || {}, { enabled: ${v2} }) }); return true; })()`);
    await sleep(2200); };
  await setEnabled(true);
  check("未暂停：请求被拦", await load(), "BLOCKED");
  await setEnabled(false);
  check("全局暂停：请求放行", await load(), "LOADED");
  await setEnabled(true);
  check("恢复：又被拦", await load(), "BLOCKED");
  const gi = await ext.ev(`(async () => { const rs = await chrome.declarativeNetRequest.getDynamicRules();
    const g = rs.filter(x => x.id === ${GLOBAL_ALLOW_RULE_ID}); const sets = await chrome.declarativeNetRequest.getEnabledRulesets();
    return { global: g.length, action: g[0] && g[0].action.type, prio: g[0] && g[0].priority, sets: sets.slice().sort() }; })()`);
  check("恢复后全局放行规则已移除", gi.global, 0);
  check("静态规则集已恢复", gi.sets.join(","), "ads,annoyances,malware,tracking,url_clean");
  // 设置页拦截统计提示条
  await ext.ev(`(() => { const el = document.querySelector('[data-tab="report"]'); if (el) el.click(); return true; })()`);
  await sleep(2500);
  const note = await ext.ev(`(() => { const n = document.getElementById('reportStatsNote'); return n ? (n.hidden ? 'hidden' : 'visible') : 'missing'; })()`);
  check("拦截统计提示条可见", note, "visible");
  const shot = await ext.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(WORK, "shot-final-options.png"), Buffer.from(shot.data, "base64"));
  console.log("截图: " + path.join(WORK, "shot-final-options.png"));
  browser.close(); cleanup(); await sleep(400);
  console.log(""); console.log(failures === 0 ? "全部通过" : (failures + " 项不符"));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("异常:", e); process.exit(2); });
