// AdShield 分类稳定性验证（纯函数，不开浏览器）
// 用法：node toolserify-classify.js
// 断言：同一个被拦域名只会归一类；静态规则仍按 ruleId 权威归类；参数清理不被吞
const fs = require("fs");
const src = fs.readFileSync("D:/AdShield 广告拦截器/adblocker/src/background.js", "utf8");
const start = src.indexOf("const THIRD_PARTY_TRACKERS");
const endMark = '  return "ads";\n}';
const end = src.indexOf(endMark, start) + endMark.length;
if (start < 0 || end < start) { console.log("ABORT 抽不出分类代码段"); process.exit(1); }
const code = src.slice(start, end);
const factory = new Function(code + "\n; return { classifyRule, staticRuleSetCat };");
const { classifyRule } = factory();

let fails = 0;
const t = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name.padEnd(52) + "→ " + got + (ok ? "" : "   期望 " + want));
};

console.log("=== 你机器上 workbuddy 那 150 条里的真实 URL ===");
t("galileotelemetry /collect", classifyRule(300001, "https://galileotelemetry.tencent.com/collect", "www.workbuddy.cn"), "tracking");
t("galileotelemetry /aegiscontrol/whitelist（原来算广告）",
  classifyRule(300002, "https://galileotelemetry.tencent.com/aegiscontrol/whitelist?uid=undefined&topic=SDK-57adf98784ef8147e530", "www.workbuddy.cn"), "tracking");
t("cloudcache .../analytics.js（原来算广告）",
  classifyRule(300003, "https://cloudcache.tencent-cloud.cn/open/qcloud/common/analytics.js?max_age=31536000", "www.workbuddy.cn"), "tracking");
t("browsertdidticket /jprx/1941（原来算广告）",
  classifyRule(300004, "https://browsertdidticket.m.qq.com/jprx/1941", "www.workbuddy.cn"), "tracking");
t("otheve.beacon /analytics/v2_upload",
  classifyRule(300005, "https://otheve.beacon.qq.com/analytics/v2_upload?appkey=0WEB0OEX9Y4SQ244", "www.workbuddy.cn"), "tracking");
t("h.trace.qq.com /kv", classifyRule(300006, "https://h.trace.qq.com/kv?attaid=00400014144", "www.workbuddy.cn"), "tracking");
t("gatherer.m.qq.com /event/report", classifyRule(300007, "https://gatherer.m.qq.com/event/report", "www.workbuddy.cn"), "tracking");
t("googletagmanager gtag/js", classifyRule(300008, "https://www.googletagmanager.com/gtag/js?id=AW-17806298785", "www.workbuddy.cn"), "tracking");
t("oth.str.beacon QueryConfig", classifyRule(300009, "https://oth.str.beacon.qq.com/trpc.beacon.configserver.BeaconConfigService/QueryConfig", "www.workbuddy.cn"), "tracking");

console.log("\n=== 同一域名不再分裂 ===");
const h1 = classifyRule(300010, "https://galileotelemetry.tencent.com/collect", "x");
const h2 = classifyRule(300011, "https://galileotelemetry.tencent.com/aegiscontrol/whitelist", "x");
t("两次判定结果相同", h1 === h2, true);

console.log("\n=== 既定分类优先（hostCat）===");
t("域名已判为 tracking，路径像广告也沿用",
  classifyRule(300012, "https://cdn.foo.com/promo/banner.png", "cdn.foo.com", "tracking"), "tracking");
t("域名已判为 ads，路径像埋点也沿用",
  classifyRule(300013, "https://ads.foo.com/collect", "ads.foo.com", "ads"), "ads");

console.log("\n=== 不能被改坏的部分 ===");
t("静态规则仍是权威（ruleId 100 = ads，URL 像埋点也不算）",
  classifyRule(100, "https://anything.com/collect", "p"), "ads");
t("静态 tracking 段", classifyRule(1000, "https://x.com/y", "p"), "tracking");
t("静态 url_clean 段", classifyRule(3005, "https://x.com/?utm_source=a", "p"), "url_clean");
t("URL 里带 utm 参数仍判 url_clean", classifyRule(300014, "https://site.com/p?utm_source=x", "p"), "url_clean");
t("普通广告路径仍判 ads", classifyRule(300015, "https://ad-server.example.com/banner/728x90.png", "p"), "ads");
t("路径末段 analytics.gif 判 tracking", classifyRule(300016, "https://img.foo.net/analytics.gif", "p"), "tracking");
t("普通静态资源路径不被误判成埋点（statics/app.js）",
  classifyRule(300017, "https://cdn.foo.com/statics/app.js", "p"), "ads");

console.log("\n" + (fails ? fails + " 项不符" : "全部通过"));
process.exit(fails ? 1 : 0);
