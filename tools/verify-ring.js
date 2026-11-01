// AdShield 弹窗圆环口径验证（CDP，离屏临时 profile）
// 用法：node toolserify-ring.js
// 断言：圆环中心、圆环分段、分类芯片三者口径一致（URL 参数清理只出现在芯片里，不进圆环）
// 圆环口径的真机验证：把「当前标签页」伪造成测试站点，喂一份 url_clean 很大的统计，
// 看圆环中心、圆环分段、分类芯片分别显示什么。
const { spawn } = require("child_process");
const os = require("os"), path = require("path"), fs = require("fs");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT_SRC = "D:\\AdShield 广告拦截器\\adblocker";
const WORK = path.join(os.tmpdir(), "adshield-ringcheck");
const EXT = path.join(WORK, "ext"), PROFILE = path.join(WORK, "profile");
const PORT = 9433;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(l, a, e) {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + l + "\n        实际=" + JSON.stringify(a) + "  期望=" + JSON.stringify(e));
}
function mkClient(url, tag) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.method) return;
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); clearTimeout(p.t);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
    ws.onerror = () => rej(new Error(tag + " ws"));
    ws.onopen = () => res({ send: (method, params) => new Promise((r, j) => { const i = ++id;
      const t = setTimeout(() => { pend.delete(i); j(new Error(tag + " " + method + " 超时")); }, 20000);
      pend.set(i, { res: r, rej: j, t }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() });
  });
}
(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.cpSync(EXT_SRC, EXT, { recursive: true });
  const chrome = spawn(CHROME, ["--no-first-run", "--no-default-browser-check",
    "--remote-allow-origins=*", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
    "--window-position=-32000,-32000", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on("exit", cleanup);
  let v = null;
  for (let i = 0; i < 40; i++) { try { v = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json(); break; } catch (e) {} await sleep(500); }
  const browser = await mkClient(v.webSocketDebuggerUrl, "browser");
  const { id: extId } = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const t = await browser.send("Target.createTarget", { url: "chrome-extension://" + extId + "/src/popup.html" });
  let pg = null;
  for (let i = 0; i < 40; i++) { const l = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
    pg = l.find(x => x.type === "page" && x.id === t.targetId); if (pg) break; await sleep(300); }
  const c = await mkClient(pg.webSocketDebuggerUrl, "pg");
  await c.send("Runtime.enable", {});
  await sleep(2200);
  const ev = async (e) => { const rr = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
    if (rr.exceptionDetails) return { __err: (rr.exceptionDetails.exception && rr.exceptionDetails.exception.description) || rr.exceptionDetails.text };
    return rr.result.value; };

  const STATS = { total: 106, byPage: { "ringtest.invalid": 7 }, byBlocked: {},
    byCategory: { "ringtest.invalid": { ads: 3, tracking: 4, annoyances: 0, url_clean: 99, malware: 0 } },
    byDate: {}, byHour: {}, recentLogs: [] };
  const patched = await ev(`(async () => {
    const STATS = ${JSON.stringify(STATS)};
    chrome.tabs.query = () => Promise.resolve([{ id: 999, url: "https://ringtest.invalid/page" }]);
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (msg, cb) {
      if (msg && msg.type === "getStats") { const r = Object.assign({ ok: true }, STATS); if (cb) cb(r); return Promise.resolve(r); }
      return orig(msg, cb);
    };
    return "patched";
  })()`);
  check("能挂上伪造的当前标签页", patched, "patched");
  await sleep(3000);   // 等一次 2 秒轮询渲染

  const center = await ev(`(() => document.querySelector('.wheel-wrap').getAttribute('data-count'))()`);
  check("圆环中心 = 本站拦截数（7，不含 99 条参数清理）", center, "7");
  const cardSite = await ev(`(() => (document.getElementById('statSite')||{}).textContent)()`);
  check("下方「本站已拦截」与中心一致", cardSite, "7");
  const urlSeg = await ev(`(() => { const el = document.querySelector('.seg-url'); return el ? el.getAttribute('stroke-dasharray') : 'missing'; })()`);
  check("URL 那一档不再画进圆环", urlSeg, "0 100");
  const drawn = await ev(`(() => [...document.querySelectorAll('.wheel-wrap path[stroke-dasharray]')]
      .filter(p => p.getAttribute('stroke-dasharray') !== '0 100')
      .map(p => [...p.classList].find(c => c.startsWith('seg-')))
      .sort())()`);
  check("圆环里只画了广告和追踪两段", drawn, ["seg-ads", "seg-track"]);
  const chips = await ev(`(() => [...document.querySelectorAll('#catRow .cat-chip')].map(e => e.textContent.trim()))()`);
  check("分类芯片仍然显示 URL 那一档", JSON.stringify(chips).includes("URL") && JSON.stringify(chips).includes("99"), true);
  const chipSum = await ev(`(() => {
    let n = 0;
    for (const e of document.querySelectorAll('#catRow .cat-chip b')) n += Number(e.textContent) || 0;
    return n; })()`);
  check("（记录用）芯片合计 = 106，比中心大 99，正是被圆环排除的参数清理", chipSum, 106);

  browser.close(); cleanup(); await sleep(300);
  console.log("\n" + (failures ? failures + " 项不符" : "全部通过"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("异常:", e); process.exit(2); });
