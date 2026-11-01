// 行为验证：host 归一化 + 三层判定一致性
globalThis.globalThisRef = globalThis;
const src = (await import('node:fs')).readFileSync('adblocker/src/shared/host.js','utf8');
(0, eval)(src);
const { normalizeHost, isValidHost, hostMatches, anyHostMatches, normalizeHostList, isPausedUntil, pausedUntilRemaining } = globalThis.adshieldHost;

let pass=0, fail=0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got)===JSON.stringify(want);
  ok?pass++:fail++;
  console.log(`  ${ok?'✓':'✗'} ${name}  got=${JSON.stringify(got)}${ok?'':'  want='+JSON.stringify(want)}`);
};

console.log('--- normalizeHost ---');
t('剥 www', normalizeHost('www.example.com'), 'example.com');
t('去协议+路径', normalizeHost('https://www.example.com/a/b?x=1'), 'example.com');
t('小写', normalizeHost('EXAMPLE.COM'), 'example.com');
t('null 安全', normalizeHost(null), '');
t('http 也处理', normalizeHost('http://example.com/x'), 'example.com');

console.log('--- isValidHost ---');
t('合法', isValidHost('example.com'), true);
t('非法(无点)', isValidHost('localhost'), false);
t('非法(中文)', isValidHost('例子.com'), false);

console.log('--- hostMatches（核心：子域匹配）---');
t('同域', hostMatches('example.com','example.com'), true);
t('www 命中裸域', hostMatches('www.example.com','example.com'), true);
t('裸域命中 www 存储项', hostMatches('example.com','www.example.com'), true);
t('子域命中', hostMatches('a.b.example.com','example.com'), true);
t('不同域', hostMatches('example.com','other.com'), false);
t('前缀相同但非子域', hostMatches('notexample.com','example.com'), false);

console.log('--- anyHostMatches ---');
t('数组含裸域,页面是www', anyHostMatches('www.example.com',['example.com']), true);
t('数组不含', anyHostMatches('www.other.com',['example.com']), false);
t('空数组', anyHostMatches('example.com',[]), false);

console.log('--- normalizeHostList（去重）---');
t('www 与裸域合并', normalizeHostList(['www.example.com','example.com','other.com']), ['example.com','other.com']);

console.log('--- isPausedUntil（定时暂停子域匹配）---');
const pu = {'www.example.com': Date.now()+60000};
t('www 页面命中 www 键', isPausedUntil(pu,'www.example.com'), true);
t('裸域页面命中 www 键', isPausedUntil(pu,'example.com'), true);
t('无关站不命中', isPausedUntil(pu,'other.com'), false);
t('过期不命中', isPausedUntil({'example.com': Date.now()-1000},'example.com'), false);
t('剩余时长取最大值', pausedUntilRemaining({'example.com':Date.now()+60000,'www.example.com':Date.now()+120000},'example.com') > 100000, true);

console.log('--- 三层一致性（回归 M5 原始 bug）---');
// 场景：用户在设置页添加 example.com（存为裸域），随后访问 www.example.com
const disabledSites = ['example.com'];   // 设置页写入形式
const pausedUntil = {};
const pageHost = 'www.example.com';      // 实际页面
const netLayer   = normalizeHostList(disabledSites).some(h=>hostMatches(pageHost,h));  // DNR requestDomains
const elemLayer  = anyHostMatches(pageHost, disabledSites);                          // cosmetic.js
const uiLayer    = anyHostMatches(pageHost, disabledSites);                          // popup.js
t('网络层放行', netLayer, true);
t('元素层放行（修复前为 false）', elemLayer, true);
t('UI 层显示已暂停（修复前为 false）', uiLayer, true);
t('三层一致', netLayer===elemLayer && elemLayer===uiLayer, true);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
