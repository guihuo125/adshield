// 针对本轮修复的真机补充验证（CDP，离屏临时 profile，不碰用户正在用的 Chrome）
// 用法：node _verify_fixes.js
const { spawn } = require("child_process");
const http = require("http");
const os = require("os"), path = require("path"), fs = require("fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT_SRC = "D:\\AdShield 广告拦截器\\adblocker";
const WORK = path.join(os.tmpdir(), "adshield-fixcheck");
const EXT = path.join(WORK, "ext");
const PROFILE = path.join(WORK, "profile");
const DL = path.join(WORK, "dl");
const PORT = 9431, HTTP_PORT = 8931;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(l, a, e) {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + l);
  if (!ok) console.log("        实际=" + JSON.stringify(a) + "  期望=" + JSON.stringify(e));
}
function mkClient(url, tag) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); let id = 0; const pend = new Map(); const hs = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method) { hs.forEach(h => h(m)); return; }
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); clearTimeout(p.t);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    };
    ws.onerror = () => rej(new Error(tag + " ws"));
    ws.onopen = () => res({
      on: h => hs.push(h),
      send: (method, params) => new Promise((r, j) => {
        const i = ++id;
        const t = setTimeout(() => { pend.delete(i); j(new Error(tag + " " + method + " 超时")); }, 25000);
        pend.set(i, { res: r, rej: j, t }); ws.send(JSON.stringify({ id: i, method, params }));
      }),
      close: () => ws.close()
    });
  });
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true }); fs.mkdirSync(DL, { recursive: true });
  fs.cpSync(EXT_SRC, EXT, { recursive: true });

  const server = http.createServer((q, s) => { s.writeHead(200, { "Content-Type": "text/html" }); s.end("<h1>verify</h1>"); });
  await new Promise(r => server.listen(HTTP_PORT, "127.0.0.1", r));

  const chrome = spawn(CHROME, ["--no-first-run", "--no-default-browser-check",
    "--remote-allow-origins=*", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
    "--window-position=-32000,-32000", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} try { server.close(); } catch (e) {} };
  process.on("exit", cleanup);

  let v = null;
  for (let i = 0; i < 40; i++) { try { v = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json(); break; } catch (e) {} await sleep(500); }
  if (!v) throw new Error("Chrome 调试端口没起来");
  const browser = await mkClient(v.webSocketDebuggerUrl, "browser");
  const { id: extId } = await browser.send("Extensions.loadUnpacked", { path: EXT });
  console.log("扩展已加载 " + extId + "\n");

  const mk = async (url) => {
    const t = await browser.send("Target.createTarget", { url });
    let p = null;
    for (let i = 0; i < 40; i++) {
      const l = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      p = l.find(x => x.type === "page" && x.id === t.targetId); if (p) break; await sleep(300);
    }
    const c = await mkClient(p.webSocketDebuggerUrl, "pg");
    await c.send("Runtime.enable", {});
    await sleep(2000);
    c.ev = async (e) => {
      const rr = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
      if (rr.exceptionDetails) return { __err: (rr.exceptionDetails.exception && rr.exceptionDetails.exception.description) || rr.exceptionDetails.text };
      return rr.result.value;
    };
    return c;
  };

  const opt = await mk("chrome-extension://" + extId + "/src/options.html");
  const nav = await mk("about:blank");
  await nav.send("Page.enable", {});
  // 下载行为设在 browser 会话上（设在页面会话上会被忽略）
  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL.replace(/\\/g, "/"), eventsEnabled: true });

  // ---------- A 订阅更新间隔真的落盘 ----------
  const intervalTest = await opt.ev(`(async () => {
    const sel = document.getElementById('subIntervalSelect');
    if (!sel) return 'no-select';
    const out = {};
    sel.value = '6'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    let st = await chrome.storage.local.get('adshield_settings');
    out.six = st.adshield_settings ? st.adshield_settings.subscriptionInterval : 'none';
    sel.value = '0'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    st = await chrome.storage.local.get('adshield_settings');
    out.zero = st.adshield_settings ? st.adshield_settings.subscriptionInterval : 'none';
    return out;
  })()`);
  check("下拉选「每 6 小时」写入 6", intervalTest && intervalTest.six, 6);
  check("下拉选「关闭」写入 0（不再被当成 24）", intervalTest && intervalTest.zero, 0);

  // 重新打开页面看回显
  const reloadShown = await opt.ev(`(async () => {
    location.reload();
    return true;
  })()`);
  await sleep(3500);
  const shown = await opt.ev(`(() => { const s = document.getElementById('subIntervalSelect'); return s ? s.value : 'none'; })()`);
  check("重开设置页后下拉仍显示「关闭」", shown, "0");

  // ---------- B 含 > 的自定义规则真的生效并保留 ----------
  const ruleTest = await opt.ev(`(async () => {
    const ta = document.getElementById('rulesInput');
    if (!ta) return 'no-textarea';
    ta.value = 'example.com##.ad > .banner\\n||qoder-fixcheck-block.test^\\n';
    document.getElementById('saveBtn').click();
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      const st = await chrome.storage.local.get(['adshield_user_rules_result','adshield_user_cosmetic']);
      const res = st.adshield_user_rules_result;
      if (res && !res.pending) {
        const dyn = (await chrome.declarativeNetRequest.getDynamicRules()).filter(x => x.id >= 100000 && x.id < 110000);
        return { result: res.result, ok: res.ok, cosmetic: st.adshield_user_cosmetic, dynCount: dyn.length,
                 statusText: (document.getElementById('status') || {}).textContent };
      }
    }
    return 'timeout';
  })()`);
  check("保存后应用结果：1 条网络规则 + 1 条元素隐藏",
    ruleTest && [ruleTest.result.applied, ruleTest.result.cosmetic], [1, 1]);
  check("含 > 的选择器原样保留", ruleTest && ruleTest.cosmetic, ["example.com##.ad > .banner"]);
  check("动态规则确实装上了", ruleTest && ruleTest.dynCount, 1);
  check("页面状态栏显示了结果而不是空", !!ruleTest && /已应用/.test(ruleTest.statusText || ""), true);

  // ---------- C 三个导出按钮真的产出下载 ----------
  // Chrome 156 不再把 blob 下载写进 setDownloadBehavior 指定的目录，
  // 所以以 Browser.downloadWillBegin 事件 + 页面提示文案为准，而不是磁盘文件。
  const dlEvents = [];
  browser.on(m => { if (m.method === "Browser.downloadWillBegin") dlEvents.push(m.params.suggestedFilename); });
  let mark = 0;
  const clickAndWait = async (jsExpr, namePattern) => {
    mark = dlEvents.length;
    await opt.ev(jsExpr);
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      const fresh = dlEvents.slice(mark).find(n => namePattern.test(n));
      if (fresh) return fresh;
    }
    return null;
  };
  const backupName = await clickAndWait(`(() => { document.getElementById('exportAllBtn').click(); return true; })()`, /^adshield-backup-.*\.json$/);
  const backupStatus = await opt.ev(`(() => (document.getElementById('importStatus') || {}).textContent)()`);
  check("「导出全部设置」触发下载", !!backupName, true);
  check("「导出全部设置」提示了内容而不是空白", /已导出 \d+ 项配置/.test(backupStatus || ""), true);

  const cosName = await clickAndWait(`(() => { document.getElementById('exportCosmeticBtn').click(); return true; })()`, /^adshield-cosmetic-.*\.txt$/);
  check("「元素隐藏 导出」触发 TXT 下载", !!cosName, true);

  await opt.ev(`(() => { const el = document.querySelector('[data-tab="report"]'); if (el) el.click(); return true; })()`);
  await sleep(1200);
  const statsName = await clickAndWait(`(() => { document.getElementById('exportBtn').click(); return true; })()`, /^adshield-stats-.*\.json$/);
  check("「导出日志(统计)」触发下载", !!statsName, true);

  // ---------- D 两个弹窗不再互相顶掉 ----------
  const modal = await opt.ev(`(async () => {
    document.getElementById('resetStatsBtn').click();          // 开第一个确认框
    await new Promise(r => setTimeout(r, 250));
    window.showConfirm('第二个的内容', { title: '第二层' });      // 再开第二个
    await new Promise(r => setTimeout(r, 350));
    const overs = [...document.querySelectorAll('.adshield-modal-overlay')];
    const texts = overs.map(o => o.querySelector('[data-title]').textContent);
    overs[overs.length - 1].querySelector('[data-cancel]').click();  // 关掉最上层
    await new Promise(r => setTimeout(r, 350));
    const rest = [...document.querySelectorAll('.adshield-modal-overlay')];
    const firstStillThere = rest.length === 1 && rest[0].querySelector('[data-title]').textContent;
    rest[0].querySelector('[data-cancel]').click();
    await new Promise(r => setTimeout(r, 300));
    return { layers: overs.length, texts, firstStillThere, after: document.querySelectorAll('.adshield-modal-overlay').length };
  })()`);
  check("同时打开时是两层而不是复用一层", modal && modal.layers, 2);
  check("关掉上层后下层内容没被改写", modal && modal.firstStillThere, "重置统计");
  check("两次关闭后没有残留", modal && modal.after, 0);

  // ---------- E URL 参数清理不计入拦截总数（带阳性对照）----------
  const readStats = () => opt.ev(`(async () => {
    const s = (await chrome.storage.local.get('adshield_stats')).adshield_stats || {};
    const sum = (k) => Object.keys(s.byCategory || {}).reduce((a, h) => a + ((s.byCategory[h] || {})[k] || 0), 0);
    return { total: s.total || 0, urlClean: sum('url_clean'), ads: sum('ads') };
  })()`);
  await nav.send("Page.navigate", { url: "http://127.0.0.1:" + HTTP_PORT + "/warm" });
  await sleep(2000);
  const base = await readStats();
  // 阳性对照：装一条会命中本页图片的拦截规则，总数必须 +1
  await opt.ev(`(async () => { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1900002], addRules: [
    { id: 1900002, priority: 1, action: { type: "block" }, condition: { urlFilter: "||127.0.0.1:${HTTP_PORT}/diag.png", resourceTypes: ["image"] } }] }); return true; })()`);
  await nav.ev(`(() => { const i = document.createElement('img'); i.src = 'http://127.0.0.1:${HTTP_PORT}/diag.png'; document.body.appendChild(i); return true; })()`);
  await sleep(3000);
  const afterBlock = await readStats();
  check("阳性对照：真实拦截确实计入总数", afterBlock.total - base.total, 1);

  // 现在只发生参数清理（redirect），总数不该再涨
  await nav.send("Page.navigate", { url: "http://127.0.0.1:" + HTTP_PORT + "/p?utm_source=fixcheck&keep=1" });
  await sleep(3500);
  const afterClean = await readStats();
  const navUrl = await nav.ev(`(() => location.href)()`);
  check("清理后地址栏里没有 utm_source", /utm_source/.test(navUrl || ""), false);
  check("地址栏保留了其它参数", /keep=1/.test(navUrl || ""), true);
  check("参数清理记进了 url_clean 分类", afterClean.urlClean > afterBlock.urlClean, true);
  check("参数清理没有把拦截总数加上去", afterClean.total, afterBlock.total);

  await opt.ev(`(async () => { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1900002], addRules: [] }); return true; })()`);

  // ---------- F 云同步勾选落到 storage 且默认全开 ----------
  await opt.ev(`(() => { const el = document.querySelector('[data-tab="account"]'); if (el) el.click(); return true; })()`);
  await sleep(1200);
  const syncPref = await opt.ev(`(async () => {
    const cb = document.getElementById('syncWhitelist');
    if (!cb) return 'no-checkbox';
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    const prefs = await window.adshieldAuth.readSyncPrefs();
    return prefs;
  })()`);
  check("取消勾选「白名单」后确实是 false", !!syncPref && syncPref.whitelist, false);
  check("其余三项未勾选过则默认开启", !!syncPref && [syncPref.settings, syncPref.user_rules, syncPref.subscriptions], [true, true, true]);

  // ---------- G 清理测试规则 ----------
  await opt.ev(`(async () => {
    await chrome.storage.local.set({ adshield_user_rules: [], adshield_user_cosmetic: [] });
    await chrome.runtime.sendMessage({ type: 'saveUserRules', rules: [] });
    return true;
  })()`);
  await sleep(1500);
  const cleaned = await opt.ev(`(async () => {
    const rs = await chrome.declarativeNetRequest.getDynamicRules();
    return rs.filter(x => x.id >= 100000 && x.id < 110000).map(x => x.id);
  })()`);
  check("测试规则已清理", JSON.stringify(cleaned), "[]");

  console.log("");
  console.log(failures === 0 ? "全部通过" : (failures + " 项不符"));
  browser.close(); cleanup(); await sleep(400);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("异常:", e); process.exit(2); });
