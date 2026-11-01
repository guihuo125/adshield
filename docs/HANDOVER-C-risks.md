# 交接文档 · 补充篇 C：高风险改动区

> 配套补充篇 A（模块职责边界表）、补充篇 B（改动手册）。
> 每条给出：**触发什么后果** → **怎么自检**。
> 全部基于当前代码结构，已标注具体文件与行号/函数名。
>
> **行号快照：2026-11-01 12:15**（`background.js` 1943 行）。**以函数名 / 常量名为准**，行号只作定位辅助。

---

## C1. 会导致「用户数据丢失」的地方

### C1.1 云端同步写回本地 —— 整块覆盖

**位置**：`src/shared/auth.js` `applyCloudData()`（L1970-2058）

**后果**：`applyCloudData` 直接 `chrome.storage.local.set({ adshield_settings: s })`（L2033）和 `{ adshield_user_rules: ... }`（L2036）。**它绕过 background**——不经过 `MSG` 通道。虽然 `storage.onChanged`（background L1593）会捡到变化并重新同步 DNR，但**写进去的值本身没经过 background 的任何归一化**（比如订阅 ID 归一化 L35-48）。

代码里已有三道防线，**改这段时必须保留**：

| 防线 | 位置 | 防什么 |
|---|---|---|
| 4 个 `sanitizeCloud*` 白名单校验 | L1992-1995（实现在 `shared/validate.js`：L153 / L167 / L200 / L224） | 云端行里的任意内容进本地前被过滤 |
| 「全都不合法就保留本地」兜底 | L2007-2037（`wiped()` 判定在 L2007） | 云端某字段有内容但校验后一条不剩时，**保留本地原值**。否则一条全非法的行就能把用户白名单清空 |
| 回环抑制 | L2032 `suppressAutoUpload(8000)` | 「写本地 → storage.onChanged → 自动上传」会把这趟数据又推回云端，把「校验时丢掉的少数条目」以偏概全地覆盖云端原文 |

⚠️ **`wiped()` 只作用于数组字段**（`disabledSites` / `pausedUntil` / `subscriptions` / `user_rules`）。**`settings.rulesets` 不在其列** —— 它靠 `sanitizeCloudSettings` 自己的一道防线兜住：

```
validate.js  L241  if (Object.keys(clean).length) res.settings.rulesets = clean;
validate.js  L242  else res.rejected++;    // 空映射表 → 不写入 → 本地保留
```

**为什么这道防线必须存在**：`settings.rulesets` 是**对象**不是数组，`wiped()` 判不了。若过滤后为空却仍写入 `res.settings.rulesets = {}`，则 `Object.assign(s, stRes.settings)` 会把本地的 `rulesets` 覆盖成 `{}`——而 `{}` **不是 falsy**，`getSettings()` 里的 `Object.assign({}, DEFAULT_SETTINGS.rulesets, {})` **补不回默认值**，结果是用户手动关掉的规则集开关被静默重开。

**四种形态的当前行为（已实测）**：

| 云端 `settings.rulesets` | 结果 |
|---|---|
| `{ads:"notabool", tracking:"x"}`（对象且全非法） | ✅ 本地保留（L241 不写入） |
| `"ads"`（字符串，非对象） | ✅ 本地保留（走 `else res.rejected++`） |
| `{ads:true, tracking:true}`（部分合法） | ✅ 正常覆盖 |
| `{ads:false, tracking:false, ...}`（全 false，用户主动全关） | ✅ 正常覆盖（`Object.keys(clean).length` 非 0） |

⚠️ 注意最后一行：**「全 false」必须正常覆盖，不能被当成「非法」保留本地** —— 那是用户主动关的，不是脏数据。L241 用的是 `Object.keys(clean).length`（键数）而不是「值是否全 false」，正是为了区分这两种情况。

**自检**：
```bash
npm test    # test-validate.mjs 覆盖 4 个 sanitizeCloud*
```
人工：登录账号 → 在设置页关掉一个同步项 → 触发一次同步 → 确认**没勾选的项在云端原样保留**（提示文案：「不再同步（云端那份会原样保留，不会被删除）」，options.js L1907）。
另测：手动关掉一个规则集开关 → 触发同步 → 确认**关掉的状态没被重开**。

### C1.2 备份导入 —— `RULE_CTRL_CHARS` 的导出与解构必须同步

**位置**：`src/shared/validate.js` L124（定义）/ L267（导出清单）；`src/shared/auth.js` L13-19（解构）/ L1329（使用）

**事实**：`RULE_CTRL_CHARS`（拒掉会让规则坏掉的控制字符）定义在 `validate.js` 的 IIFE 内部，**必须显式导出**才能被 `auth.js` 用到：

```
validate.js  L124  const RULE_CTRL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
validate.js  L267  RULE_CTRL_CHARS,          ← 导出清单里必须有它
auth.js      L16   isSafeUserRule, RULE_CTRL_CHARS,   ← 解构里必须有它
auth.js      L1329 if (... || RULE_CTRL_CHARS.test(r)) ...   ← 使用点
```

**后果**：`validate.js` 的导出清单与 `auth.js` 的解构清单**必须成对维护**。少任何一边 → `auth.js` L1329 用裸标识符 → **`ReferenceError: RULE_CTRL_CHARS is not defined`** → **导入任何含 `adshield_user_rules` 或 `adshield_user_cosmetic` 的备份都直接失败**（这个缺陷曾真实存在，已修）。

**为什么容易复发**：`validate.js` 的导出清单是**手写**的，`check.mjs` 第 4b 节只检查「`sanitizeCloud*` 必须从 `adshieldValidate` 取、不能留在 auth.js 里」，**不检查导出清单与使用点是否配对**。

**注意**：`importAllData` 还有一层手写校验（L1322-1336），**与 `validate.js` 的 `isSafeUserRule`（L141）重复**。两者语义要一致——`isSafeUserRule` 检查 `##` 选择器是否会突破 CSS 块，因为 `adshield_user_cosmetic` 会被 `cosmetic.js` 直接拼进 CSS（`sel + "{display:none !important;}"`，cosmetic.js L121/L132）。

**自检**：
```bash
npm run verify
```
人工：设置页 → 导入/导出卡片 → 导出 → 改文件 → 导入 → 确认**成功**且规则数量对得上。
**加一条防回归断言**：任何在 `validate.js` 里新增的常量，若被 `auth.js` 使用，必须同时出现在两处清单里 —— 这条目前**没有自动化校验**，只能靠人工或新增 check 规则。

### C1.3 元素隐藏规则：派生数据，不是独立数据源

**位置**：`src/background.js` `applyUserRules()`（L456）末尾 L524；`src/options.js` `renderCosmeticRules()` 的删除按钮（L1039-1051）

**事实**：`adshield_user_cosmetic` 这个键**只由 background 的 `applyUserRules()` 写**（L524），而它的内容是**从 `adshield_user_rules` 里的 `##` / `#@#` 行重新算出来的**。

**后果**：
- **`adshield_user_cosmetic` 是派生数据**。任何只改它、不改 `adshield_user_rules` 的写法，下一次应用规则时都会被整体覆盖。
- 删除一条 `##` 规则的正确做法是**改 `adshield_user_rules`**（删掉对应的那一行），再发 `saveUserRules` 消息让 background 重算。`options.js` L1039-1051 现在就是这么做的：它从 `adshield_user_rules` 里按值摘掉一行（`lastIndexOf(raw)`，L1043），然后发 `saveUserRules`（L1049）。
- ⚠️ **`lastIndexOf(raw)` 按值删**：同一行写了两次时只删掉一条（L1042 注释已说明）。而下面的 `##` 列表是按索引渲染的（`data-idx`），删完之后索引会错位——`renderCosmeticRules()` 需要重新渲染（L1050）。

**自检**：删一条 `##` 规则 → 立刻刷新设置页 → 确认列表和规则数一致；重复写同一行两遍再删，确认只删一条、另一条还在。

> 备注：此前的实现是页面直接 `storage.local.set({adshield_user_cosmetic})` 再发 `saveUserRules`，两个写入者竞争——删掉的规则可能被 background 的重算带回来。**这个写法已被移除，不要恢复**。

### C1.4 白名单的存储形式

**位置**：`src/background.js` `getSettings()` 的 `normalizeHostList`（L137, L974）；`src/options.js` `setupSiteEvents()` 的 `addSite()`（L509）

**后果**：`AGENTS.md` 第 1 节末尾的「host 归一化的两条约定」——**存储形式是归一化后的裸域名**（去协议/去路径/去 www/转小写），**匹配方式是含子域匹配**。**只统一其中一条，三层判定就打架**：

| 层 | 位置 |
|---|---|
| 网络层 | `background.js` `syncSiteAllowlist()`（L144）→ `activePausedSites()`（L134） |
| 元素隐藏层 | `content/cosmetic.js` `shouldApply()`（L199） |
| UI 层 | `popup.js` `isPaused()`（L47） |

**症状**：「请求已放行但元素仍被隐藏、弹窗却显示未暂停」的半失效状态。

**自检**：`npm test`（`test-host.mjs` 覆盖 `normalizeHost` / `hostMatches` / `anyHostMatches` / `normalizeHostList` / `isPausedUntil`）。
人工：设置页加 `example.com` → 访问 `www.example.com` → popup 应显示「已永久暂停」→ 页面上该站的广告元素**不隐藏**（网络层已放行）。

---

## C2. 会影响 DNR 规则 ID 分配的地方

### C2.1 四个段位常量 —— 一改全错

**位置**：`background.js` L58（`GLOBAL_ALLOW_RULE_ID=2000000`）、L132（`SITE_RULE_BASE=200000`）、L360（`USER_RULE_BASE=100000`）、L535（`SUB_RULE_BASE=300000`）

**后果**：DNR 规则 ID 全局唯一。**动态规则共用一个池子**（上限 30000，Chrome 156 实测，`AGENTS.md` 第 5 节）——订阅、站点放行、用户自定义**不是各自独立的上限**。

段位错位的**具体后果**：
- 两个订阅撞到同一个 `id%100` → 共用一段 → **后应用的那个把前一个整段覆盖掉**（`getSettings()` L32-34 注释；`applySubscriptionText()` L725 `((sub.id||0)%100)*10000`）
- 用户规则段（100000~109999）只有 **10000** 个。超出会越过段尾，而 `removeRuleIds` 只清理 `[100000,110000)`（L459）→ **每保存一次留一批孤儿**，累积到总上限就让 `updateDynamicRules` 整批失败 → **用户所有自定义规则一起失效**。现有防护在 L485-488（截断 + 明确告知丢了哪些）
- 全局放行规则（2000000）必须躲开所有其它段——L56-57 注释列了它躲开的段

**自检**：
```bash
npm test    # test-rules.mjs：从 background.js 读真实常量复刻两段截断逻辑做行为验证
```
⚠️ `test-rules.mjs` 的注释明确写着「逻辑改了，这份测试要跟着改 —— 它是这两条防线的护栏」。**它是从 background.js 正则提取常量的**，所以常量改了它会跟着变；但**截断逻辑改了（比如改了阈值），它不会自动跟上**。

### C2.2 静态规则的 ruleId → 分类映射

**位置**：`background.js` `STATIC_RULE_SETS`（L254-260）+ `staticRuleSetCat()`（L262-269）

**后果**：`STATIC_RULE_SETS` 是静态规则 ruleId 的**唯一真源**（L249-251 注释）。`rules/*.json` 里每条规则的 id 必须落在对应区间内，否则**分类统计静默错归类**。

用 ruleId 而不是 manifest 的 rulesetId 来认门，原因是（L244-248）：manifest 里的规则集 id 是字符串（`"url_clean"`），但 `onRuleMatchedDebug` 给的 `rulesetId` 是 **Chrome 分配的数字**，拿字符串去比**永远不成立**。

**自检**：`npm run check` 第 2 节（L64-93）会校验这一点。
⚠️ 但 `check.mjs` **只校验「落在某个区间内」，不校验「区间不重叠」**——重叠了 `staticRuleSetCat()` 返回第一个匹配的分类，静默错归类。

### C2.3 `updateDynamicRules` 的提交方式

**位置**：`background.js` L522（用户规则）、L177（站点放行）、L845（订阅）、L74/83/88（全局放行）

**后果**：
- **整批原子提交**——超限则这批**全部失败**，不是部分生效。所以 `applyUserRules`（L503-507）和 `applySubscriptionText`（L832-840）都做了**预算截断**，被丢弃的条目回传给用户
- ⚠️ **截断到空时「不下发」是关键防线**。`updateDynamicRules` 是「先按 `removeRuleIds` 删、再按 `addRules` 加」的原子操作——**如果 `addRules` 为空却仍然下发，等于只删不加**，用户原有的规则会被整段清空，而用户什么都没做错（只是订阅太多把池子占满了）。
  - 用户规则路径的保护在 **L514-519**：`if (addRules.length === 0 && rules.length > 0) { ... return; }`，并设 `err.code = "POOL_FULL"`
  - 订阅路径的保护在 **L824** 和 **L840**
  - **改这两条路径时，任何时候都不能让「空的 addRules」被下发**
- **同一个 ID 同时出现在 `removeRuleIds` 和 `addRules` 里**：2026-11-01 实测（Chrome 156）**单次调用可行**，等价于「替换」，Chrome 接受并正确执行。代码里 `applyUserRules`（L522）/ `applySubscriptionText`（L845）/ `syncSiteAllowlist`（L177）都是单次调用，工作正常。
  - 只有 `syncGlobalPauseRule`（L83-88）保留两次调用——**全局暂停开关必须绝对可靠**，拆开写多一层保险，代价只是一次 IPC
  - ⚠️ **不要因为「文档说必须拆」就批量改代码，也不要因为「实测能单次」就去改关键路径。** 详见 `docs/ARCHITECTURE.md` §二第 1 条
- **先删后加 vs 先加后删**：全局暂停规则用先删后加（L83-88）。若改成先加后删，用户会经历一个「规则已存在」的中间态

**自检**：
```bash
npm run probe
```
人工：开发者模式打开扩展 → background console 看 `[AdShield] 订阅规则超出动态规则总上限，丢弃 N 条` 这类日志。

---

## C3. 有并发 / 时序陷阱的地方

### C3.1 订阅更新队列

**位置**：`background.js` `enqueueSubscription()`（L557-564）

**后果**：订阅的「拉取」可以并发（`Promise.all` L873），但「提交」必须串行。原因写在 L878-879：**两边并发时各自算出同一批规则 ID，Chrome 会整批拒绝写入，订阅就此停在旧版本**。

所有**写 DNR 的订阅路径**都必须走这个队列：
- `updateAllSubscriptions()` 的提交段（L880）
- `SAVE_SUBSCRIPTION` 的提交段（L1089 附近）
- `SAVE_SUBSCRIPTIONS_BATCH` 的提交段（L1192 附近）
- `RESTORE_DEFAULT_SUBSCRIPTIONS` 的提交段（L1260 附近）
- `REMOVE_SUBSCRIPTION` 的清理段（L1353 附近）——注释明确：与订阅更新并发时，这里算出的 `removeRuleIds` 可能漏掉对方刚写入的 ID

**自检**：同时点「立即更新全部」和删除某个订阅，看 background console 有没有「规则 ID 冲突」类报错。

### C3.2 30 秒拉取窗口内的用户改动被抹掉

**位置**：`background.js` `updateAllSubscriptions()`（L867-946）

**后果**：这一轮拉取最长要 **30 秒**（L598 的 `AbortController` 超时）。期间用户可能在弹窗里改开关、暂停站点，甚至增删订阅。

**代码里的处理**（L914-916 注释 + L917-943 实现）：不直接把函数开头读到的对象整体写回，而是**落盘前重读一次**（L917 `fresh = await getSettings()`），**只把本轮真正改过的字段合并进去**（L920-938）。

**改这段时**：如果简化成「直接写 `s`」，就会出现「我刚关掉的又自己开了」。L922 的 `if (!upd) continue;`（本轮没碰过这条 → 保持用户现在的状态）和 L937 注释（byId 里剩下的是拉取期间已被用户删掉的订阅，不写回）都是这条防线的组成部分。

### C3.3 Service Worker 挂起 vs `setTimeout`

**位置**：`background.js` 首次订阅拉取（L1579-1583）

**后果**：MV3 的 SW 空闲就挂起，`setTimeout` 可能因挂起而丢失。所以首次安装的订阅拉取**用 `chrome.alarms` 延迟 0.5 分钟**（L1581），不用 `setTimeout`。

对比：统计写盘（L1686-1699）刻意**不用 setTimeout**，改成 Promise 串行链（`__statsWriteChain` L1688）——因为 `scheduleFlush()` 是在 `onRuleMatchedDebug` 里调的，那个事件可能已经把 SW 唤醒了，但后续的写盘还要再撑一段时间。

**自检**：
```bash
npm run probe
```
人工：安装扩展后**不打开任何页面**，等 1 分钟，看 background console 有没有 `[AdShield] 首次安装：已写入默认订阅 4 个` 和后续的订阅更新日志。

### C3.4 内存缓冲 vs 落盘

**位置**：`background.js` `__statsBuffer`（L17）、`flushStats()`（L1667）、`scheduleFlush()`（L1690）、`loadStatsBuffer()`（L1641）

**后果**：SW 挂起时内存变量一重启就丢。所以「清空统计」这类操作**必须同时清内存与磁盘**：
- `RESET_STATS`（L1043-1047）——`__statsBuffer = blank` **然后**才写 storage
- `CLEAR_LOGS`（L1048-1056）——先 `loadStatsBuffer()` 拿到**同一个对象引用**再改 `recentLogs`（L1053-1054）。注意 `loadStatsBuffer()` 返回的是 `__statsBuffer` 本身（L1642），所以改它的属性等于改了内存缓冲

**页面侧必须发消息，不能直接写 storage**：`logger.js` L126-128 注释明确——直接写 storage 的话 background 的内存缓冲仍留着旧日志，下一次 flush 会把它们写回来，用户点了「清空」日志却又冒出来。

**自检**：人工：logger 页点「清空日志」→ 立刻访问一个有广告的页面 → 日志表应只有新产生的条目，**不应出现清空前的旧条目**。

### C3.5 弹窗 / 设置页的 2 秒轮询 vs 60 秒限流

**位置**：`popup.js` `__tabStatsAllowed()`（L296-306）

**后果**：`getMatchedRules` 的配额是 **20 次 / 10 分钟**，而 popup 每 2 秒轮询一次（L696-698）。不限流直接超限。

现有限流：**60 秒最多查一次**，且**换标签页时立即放行**（L298-301，新标签页的初始计数用户最想立刻看到）。

⚠️ **这个「换标签页立即放行」是有代价的**：疯狂切标签页可以在 10 分钟内触发远超 20 次查询。**这是已知的取舍，不是 bug**——但如果有人要「优化」这个逻辑，要先想清楚配额。

**自检**：`npm run probe` 的 `feedback.getMatchedRulesWorks` 字段会告诉你当前还能不能查。

### C3.6 定时器重建陷阱

**位置**：`background.js` `scheduleSubscriptionCheck()`（L1515-1534）

**后果**：同名 alarm 再次 `create` 会被**整个替换**，首次触发时间也随之推后。而 `storage.onChanged` 里每一次设置变动都会走到这里（L1599）——照旧重建的话，「每 24 小时自动更新」会被用户的日常操作**无限推迟**，事实上永远不触发。

**现有防护**（L1529-1531）：先 `chrome.alarms.get()` 查已有 alarm，`periodInMinutes` 相同就 `return` 不重建。

⚠️ **`periodInMinutes` 最小 30 分钟**（L1524 `Math.max(30, hours*60)`）——这是业务选择，比 Chrome 自身的最小周期限制宽松。

**自检**：设置页把更新间隔改成 1 小时 → 等 1 小时看是否真的触发了（background console 有 `[AdShield] 定时器触发：开始更新订阅`）。

### C3.7 `storage.onChanged` 的级联

**位置**：`background.js` L1593-1624

**后果**：`adshield_settings` 一变 → 同时触发 4 件事：`syncRulesets()` + `syncSiteAllowlist()` + `scheduleCleanup()` + `scheduleSubscriptionCheck()`（L1596-1599），外加**刷新所有标签的 badge**（L1601-1605）。

`syncSiteAllowlist()` 自己还会写 storage（L158，清理过期的 pausedUntil）→ **触发新一轮 onChanged**。这个循环靠「第二次没有过期项要清理、`changed` 保持 false、不再写」收敛（L150, L157-159）。

**自检**：改一个设置 → 观察 background console 有几次 `[AdShield] 规则集同步` / `站点放行名单已更新`。**次数不应无限增长**。

---

## C4. 「看起来能跑其实不生效」的陷阱

### C4.1 regexFilter 未锚定（已在 AGENTS.md，此处只标注影响面）

**位置**：`rules/*.json`；校验在 `tools/check.mjs` L50-55

**后果**：DNR 的 `regexFilter` 是**全串匹配**。未锚定的正则**永不命中，但规则集照样编译成功**。这是「文件加载了 / 规则集启用了 / 功能在跑」三个互不相同命题里最隐蔽的一个——前两个都成立，第三个不成立。

`urlFilter` 才是子串匹配。

**自检**：`npm run check`。

### C4.2 `onRuleMatchedDebug` 只在未打包扩展触发

**位置**：`background.js` L1740-1786；判定标志 `__statsLive`（L20、L1741）

**后果**：`declarativeNetRequestFeedback` 权限「仅对未打包扩展生效，商店安装版被忽略」。正式安装版 `onRuleMatchedDebug` **永不触发** → `__statsLive` 恒为 false → `stats.live` 不是 `true`。

**代码里的三处判定必须统一为「只有明确拿到 `live === true` 才隐藏说明」**：
- `popup.js` L412
- `options.js` L599
- `logger.js` L39

而**降级路径必须显式补 `live: false`**（`popup.js` L37、`options.js` L313）——`live` 字段缺失时 `stats.live === true` 不成立，但 `stats.live !== false` 成立，两处判定会各说各话。

**正式版的替代路径**：`activeTab` + `getMatchedRules({tabId})`（`getTabMatchStats()` L1870-1894），用户打开 popup 时授予 activeTab。**但 `getMatchedRules()` 不返回被拦请求的 URL**，所以正式版只能给「按规则分类的计数」，给不了被拦域名与逐条日志。

⚠️ **正式版设置页拿不到 activeTab**——`activeTab` 只在用户点击扩展图标 / 右键菜单 / 快捷键时授予，设置页是自己打开的扩展页。所以 `GET_TAB_STATS` 分支（L1013-1046）把查到的结果**回写进 `__statsBuffer`**，让设置页也能读到正式版数据。**改这个分支时注意**：回写用 `Math.max` 而不是累加（L1030-1041），因为 `getMatchedRules` 返回的是该标签页**累计**命中列表，同一个 tab 查两次会拿到同一批数据，累加会让数字翻倍。

**自检**：`npm run probe` 看 `feedback.hasOnRuleMatchedDebug` / `getMatchedRulesWorks`。

### C4.3 分类判定：静态 ruleId 优先

**位置**：`background.js` `classifyRule()`（L271-309）

**后果**：判定顺序是 **静态 ruleId 区间 > URL 特征**。原因（L206-207）：多个规则集优先级相同时，Chrome 可能先命中 ads，导致 tracking 永不被选中。

具体顺序：
1. 静态 ruleId 区间命中 → 直接返回（L272-274）
2. URL 含 `utm_`/`gclid`/`fbclid` 等 → `url_clean`（L279）
3. **同域名沿用上次归类**（L289）——之前判过就直接沿用，避免同一域名一会儿算追踪一会儿算广告
4. 已知第三方追踪器域名表 → `tracking`（L292，表在 L214-234）
5. 域名/路径埋点关键词 → `tracking`（L297）
6. 兜底 → `ads`（L308，动态规则没有规则集身份）

**自检**：统计页看同一域名是否稳定归到同一类。

### C4.4 `url_clean` 不计入拦截总数

**位置**：`background.js` L1767-1774；`getTabMatchStats()` L1889-1890；`popup.js` L396-402

**后果**：`url_clean` 是**参数清理（重定向）不是拦截**。两处判定口径必须一致：
- 开发模式：按**静态 ruleId 区间**判定（L1769 `staticRuleSetCat(ruleId) === "url_clean"`）——**不能用 `cat`**，因为 `cat` 基于 URL 特征可能误判（L1768 注释）
- popup 圆环：直接 `delete wheelCats.url_clean`（L400），但**分类芯片里仍然保留**（L396-398 注释：它本身有信息量）

**中心数字走 `byPage`（本来就不含 url_clean）**，圆环若含它就会「中心的数和下面加起来对不上」。

**自检**：访问带 utm 参数的链接 → 统计总数不应因为参数被清理而增加。

### C4.5 `MSG` 用了但没解构 → 运行时 ReferenceError

**位置**：`tools/check.mjs` 第 4b 节 L182-193

**后果**：文件里出现 `MSG.XXX` 但没从 `adshieldConfig` 解构 `MSG` → **运行时 ReferenceError**。`check.mjs` 会拦。

⚠️ **反向不管**：页面侧**直接写 storage 改设置**（options.js L301 / popup.js L26），**不发消息**。所以 `MSG.SET_FEATURE` / `TOGGLE_*` 那几个分支实际**没有调用方**。新增设置开关时不要以为「有个 SET_FEATURE 消息可以用」——**它是死的**。

**自检**：`npm run check`。

### C4.6 host 归一化的单一真源

**位置**：`tools/check.mjs` 第 4 节 L132-155

**后果**：`normalizeHost` / `isValidHost` 只能有一份实现（`shared/host.js`）。其它文件自带实现 → 报错。

⚠️ **`check.mjs` 的判定有盲区**（L140-142）：`selfImpl && !usesShared` 才报错。所以**一个文件既自己实现了 `normalizeHost`、又引用了 `adshieldHost`**，检查会放行——但两份实现都在用，哪份生效取决于调用点。**写新代码时不要「顺手」再写一个 normalizeHost。**

**自检**：`npm run check` + `npm test`（`test-host.mjs`）。

---

## C5. 曾经存在、现已修复的缺陷（**代码里已有防线，但防线本身没有自动化保护**）

> 这一节记录「已经踩过、已经修好、但防线很脆」的坑。
> **重点不是历史，是：这些防线现在长什么样、你能怎么判断它还在不在。**

| # | 位置 | 曾经的缺陷 | 现在的防线 | 防线强度 |
|---|---|---|---|---|
| 1 | `background.js` L5 vs L333 | `isPausedUntil` 未从 `self.adshieldHost` 解构 → `ReferenceError` 被 L354 的 catch 吞掉 → **工具栏 badge 永远不显示数字** | L5 已解构 `isPausedUntil` | ⚠️ **弱**：`updateBadgeForTab` 的 `catch (e) { /* tab 已关闭 */ }` 会吞掉任何异常，**下次再漏解构同样静默** |
| 2 | `validate.js` L124/L267 ↔ `auth.js` L13-19 | `RULE_CTRL_CHARS` 未导出 → `ReferenceError` → **导入含自定义规则的备份必崩** | 已加进导出清单 + 解构清单 | ⚠️ **弱**：两份清单都是手写的，`check.mjs` 不校验配对 |
| 3 | `background.js` L514-519 | 动态规则池满时，`applyUserRules` 仍下发 `updateDynamicRules({removeRuleIds: 旧规则, addRules: []})` → **用户原有自定义规则被整段清空** | 截断到空时**直接 return 不下发**（L514-519，`err.code = "POOL_FULL"`），与订阅路径 L824/L840 的保护一致 | ⚠️ **中**：分支存在且有注释，但 `tools/test-rules.mjs` 是**逻辑复刻**（它自己第 13 行写了「逻辑改了，这份测试要跟着改」），复刻里没有「先删后加」这个原子语义 → **守不住这条** |
| 4 | `validate.js` L237-242 | 云端 `settings.rulesets` 是「对象且全非法」时，`sanitizeCloudSettings` 返回 `rulesets: {}`（空对象）→ `Object.assign` 覆盖 → **用户手动关掉的开关被静默重开** | 空映射表**不写入** `res.settings.rulesets`（L241），并计入 `rejected`（L242） | ⚠️ **中**：漏洞形态很窄（只有「对象且全非法」会漏；字符串形态本来就不覆盖），但 `wiped` 兜底只作用于数组字段，`rulesets` 不在其列 |
| 5 | `options.js` 删除 `##` 规则 | 页面直接 `storage.set({adshield_user_cosmetic})` 再发 `saveUserRules` → 两个写入者竞争 → 删掉的规则可能被 background 的重算带回来 | 已改为**只发 `saveUserRules`**（L1049），由 background 的 `applyUserRules()` 重算 | ✅ **强**：`adshield_user_cosmetic` 现在只有 background 一个写入者，与 `AGENTS.md` 第 1 节的表一致 |
| 6 | `background.js` L1852 / L860 | — | — | ⚠️ **死代码**：`MATCH_POLL_ALARM`（L1852）定义了从未使用；`applySubscription()`（L860）定义了从未被调用。grep 全仓库确认。删除，或确认后接上 |

**怎么判断这几条防线还在不在**（因为没有自动化保护）：

```bash
# 1（isPausedUntil 解构）
grep -n "adshieldHost" adblocker/src/background.js | head -1
# 2（RULE_CTRL_CHARS 配对）
grep -n "RULE_CTRL_CHARS" adblocker/src/shared/validate.js adblocker/src/shared/auth.js
# 3（池满保护）
grep -n "POOL_FULL" adblocker/src/background.js
# 4（rulesets 空映射表保护）
grep -n "Object.keys(clean).length" adblocker/src/shared/validate.js
# 5（cosmetic 单一写入者）
grep -n "adshield_user_cosmetic" adblocker/src/options.js   # 应只有读、没有 set
```

> 建议：把上面 5 条做成 `tools/check.mjs` 的新一节。**这比再写一份一次性 CDP 脚本更有价值** —— 它守的是「防线还在不在」，而 CDP 脚本守的是「某个具体场景对不对」。

---

## C6. 自动化校验的能力边界

**`npm run check` 覆盖的（5 类）**：
1. `regexFilter` 必须 `^...$` 锚定（规则集 JSON）
2. 静态规则 `id` 落在 `STATIC_RULE_SETS` 区间内
3. DOM 契约：`options.js`/`popup.js`/`logger.js` 里 `$("#x")` / `getElementById("x")` 引用的 id 必须在对应 HTML 存在
4. 单一真源：host 归一化、HTML 转义、`DEFAULT_SETTINGS`、`MSG` 解构、`sanitizeCloud*` 的归属
5. `logger.html` 必须加载 `modal.js` 且顺序在前

**`npm test` 覆盖的（3 个文件）**：
- `test-host.mjs`：host 归一化 + 三层判定一致性
- `test-rules.mjs`：规则段位与预算（**逻辑改了要跟着改**，见 C2.1）
- `test-validate.mjs`：4 个 `sanitizeCloud*`

**不覆盖的（改动时要格外小心）**：
- ❌ `probe.js` 的 DOM 契约（不在 `check.mjs` 的 `PAGES` 列表里）
- ❌ `content/*.js` 的任何检查
- ❌ `rules/*.json` 的**区间重叠**检查
- ❌ 订阅 ID 撞号的端到端验证（只在 `getSettings()` 里做了防御）
- ❌ `applyUserRules` 与 `applySubscriptionText` 的**规则 id 是否越段**
- ❌ `MSG` 常量的**值**与实际调用是否一致（比如 `MSG.GET_STATS = "getStats"` 与硬编码的 `{type:"getStats"}` 一致——但改名就会断）
