# 交接文档 · 补充篇 B：改动手册（Playbook）

> 配套 `AGENTS.md`、`docs/ARCHITECTURE.md`、补充篇 A（模块职责边界表）。
> 每条格式：**改哪些文件 → 要注意什么 → 怎么验证**。
> 「验证」一栏只列项目已有的自动化手段（`npm run verify` / `npm run check` / `npm run probe`），没有的标注「需人工验证」。
>
> **行号快照：2026-11-01 12:15**（`background.js` 1943 行）。**以函数名 / 常量名为准**，行号只作定位辅助。

---

## B1. 新增一个静态规则集（rules/*.json）

**改哪些文件（5 处，缺一不可）**

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `adblocker/rules/<新文件>.json` | 顶层是**数组**。每条规则 `id` 必须落在你打算占用的 ID 段内；`condition.regexFilter` 必须 `^...$` 锚定 |
| 2 | `adblocker/manifest.json` | `declarative_net_request.rule_resources` 加一项：`{ "id": "<集名>", "enabled": true, "path": "rules/<新文件>.json" }` |
| 3 | `src/background.js` `STATIC_RULE_SETS`（L254-260） | 加 `{ min: X, max: Y, cat: "<分类>" }`。**这是分类统计的唯一真源**——不改的话命中统计会归错类（`check.mjs` 会报错拦住） |
| 4 | `src/background.js` `ALL_RULESETS`（L7） | 加集名。**漏了会怎样**：`syncRulesets()`（L102）遍历 `ALL_RULESETS`（L114）决定启用/禁用——漏加则这个集永远处于 manifest 的 `enabled: true` 初始值，**用户关不掉它** |
| 5 | `src/shared/config.js` | `RULESETS`（L34）加显示项；`CATS`（L43）加统计分类；**`DEFAULT_SETTINGS.rulesets`（L21）加默认开关值** |

**ID 段怎么选**

现有段位已被占满（`AGENTS.md` 第 2 节的表）：

| 已占用 | 段 |
|---|---|
| ads / tracking / annoyances / malware | 100 / 1000 / 2000 / 4000（**各只有 1 条规则**，整包域名塞在一条规则的 `requestDomains` 里：325 / 294 / 139 / 65 个） |
| url_clean | 3000~3028（29 条，每条一个 `redirect`） |

新集**必须用新段**（如 5000、6000）。不要往现有段的空隙里塞——`check.mjs` 只校验「落在某个区间内」，**不校验「区间不重叠」**，重叠了 `staticRuleSetCat()`（L262）会返回**第一个匹配**的分类，静默错归类。

**要注意什么**

- 动态规则段位（100000+ / 200000+ / 300000+ / 2000000）是**动态**的，与静态规则集无关，不要混。
- 静态规则的 `priority` 打包时固定为 1，**代码改不了**。因此「全局暂停」只能靠动态 `allow` 规则（priority 10000）覆盖，不能靠关静态集。
- 一个 `requestDomains` 数组塞几百个域名是本项目的既有做法。Chrome 对单条规则的域名数有隐含限制，**加到几千个时需实测**。
- **分类要同时加到 4 处硬编码列表**（见 B1.1）。

### B1.1 新增一个统计分类（不只是新规则集）

如果新规则集引入了**新的分类 key**（比如 `social`），以下 4 处都要改，否则统计会出现「分类不显示」或「颜色丢失」：

| # | 文件 | 位置 | 内容 |
|---|---|---|---|
| 1 | `src/shared/config.js` | `CATS`（L43） | `{key, label, color}`——**popup 与 options 共享** |
| 2 | `src/background.js` | `byCategory`/`byDate`/`byHour` 初始化 | L1777 / L1785 / L1793，三处都是 `{ ads: 0, tracking: 0, annoyances: 0, url_clean: 0, malware: 0 }` 硬编码 |
| 3 | `src/options.js` | `TREND_CATS`（L715）/ `catTotals`（L608）/ `emptyData()`（L763） | 三处硬编码 |
| 4 | `src/popup.js` | `SEG_CLASS`（L145）+ `popup.css` 的 `--cat-*`（L4-8）与 `.seg-*`（L311-315） | 类名映射 |
| 5 | `src/logger.js` | `SAFE_CATS`（L12）/ `catName`（L71）/ `CAT_LABEL`（L92）+ `logger.html` 的 `<option>` + `logger.css` 的 `.cat-*`（light + dark 两条） | 日志页分类 |

**怎么验证**

```bash
npm run check        # 校验 regexFilter 锚定 + ruleId 落在区间内
npm run verify       # check + 三个测试
npm run probe        # 端到端：确认新集出现在 enabled 列表里
```
人工：设置页规则管理面板能看到新开关；开关切换后 popup 圆环 / 统计页分类分布出现新分类；logger 页的分类下拉里有它。

---

## B2. 新增一条 background 消息

**改哪些文件（3 处）**

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/shared/config.js` `MSG`（L64-93） | 加常量 `NEW_THING: "newThing"`。**值必须是 kebab/camel 的字符串字面量**——`options.js` L1205 的 `sendMessage(type, payload)` 直接把它当 `msg.type` 发出去 |
| 2 | `src/background.js` `handleOtherMessage()`（L949） | 加 `else if (msg && msg.type === MSG.NEW_THING) { ... }` 分支。**必须 `sendResponse(...)`**——不响应则调用方的 `await` 永远挂住 |
| 3 | 调用方页面 | `const { MSG } = window.adshieldConfig;` 解构后用 `sendMessage(MSG.NEW_THING, payload)` |

**要注意什么**

- **返回值必须是 async 函数 + `return true`**：`handleOtherMessage` 的整体结构是 `(async () => {...})();`（L955）+ `return true;`（L1379）。你在分支里写的 `await` 必须在这层 async 之内，否则 `return true` 已经执行、消息通道关闭、响应丢失。
- **`MSG` 的使用是分层的**：
  - 扩展页面（options/popup/logger）→ **必须用 `MSG.XXX`**。`check.mjs` 第 4b 节（L182-193）会检查：文件里出现 `MSG.XXX` 却没从 `adshieldConfig` 解构 `MSG` → 报「运行时会 ReferenceError」。
  - content script（cosmetic / picker）→ **只能用硬编码字符串**。它们不加载 `config.js`（manifest 只注入 host/cosmetic/anti-detect 与 dom/picker），没有 `MSG` 可用。现有例子：`"assistDetected"`（cosmetic.js L269）、`"saveUserRules"`（picker.js L266）、`"startElementPicker"`（picker.js L298）。
  - `tabs.sendMessage` 是**另一条通道**，不经 `MSG`：`"startElementPicker"` 由 popup.js L614 发，picker.js L298 收。
- **注意 `sendResponse` 的调用点位置**。`ASSIST_DETECTED` 是个特例：它在 `chrome.runtime.onMessage` 顶层（L1384）单独处理，因为要先做来源校验（`sender.tab.url` 的 hostname 必须等于 `msg.host`，L1386-1392）——防止页面伪造 host 暂停任意站点。**你的新消息如果涉及「按站点生效」，也要加同样的来源校验。**
- **`GET_TAB_STATS` 是唯一有「写回」的分支**（L1013-1046）：它把查询结果用 `Math.max` 合并进 `__statsBuffer`（L1022-1045），因为**设置页拿不到 activeTab 授权**，只能靠弹窗查到的数据回写共享。用 `max` 而不是累加是刻意的——`getMatchedRules` 返回的是该标签页**累计**命中列表，累加会让数字翻倍（L1028-1030 注释）。**你的新分支如果也要写回统计，照抄这个模式。**

**怎么验证**

```bash
npm run verify
```
人工：在 background 的 console 里 `chrome.runtime.sendMessage({type:"newThing"})`，确认收到响应；再从目标页面触发，确认 UI 有反应。

---

## B3. 新增一个设置开关

**改哪些文件**

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/shared/config.js` `DEFAULT_SETTINGS`（L16-31） | 加 `myFlag: false`（**默认值必须在这里，不要在页面里写 fallback**——`check.mjs` 第 4b 节 L170-179 会拦下自带 `DEFAULT_SETTINGS` 的文件） |
| 2 | `src/options.html` | 加 `<input type="checkbox" id="swMyFlag" />` + `<span class="slider"></span>`（照抄 `id="swGlobal"` 的 L125-128 结构） |
| 3 | `src/options.js` | ① `render()` 的 `swMap`（L1101）加映射 ② `toggles` 数组（L1146）加一行 ③ `disabledSelectors`（L1113）决定暂停时是否变灰 |
| 4 | `src/popup.js`（若要在 popup 里也有） | `renderMenuLists()`（L114）的 `ruleItems`/`featItems`（L115-139）。注意 `FEATURES`（L5-7）目前只剩 `antiDetect` 一项，且 `#featureList` 分区**已从 popup 移除**（L127-128 `if (!fl) return;`） |

**要注意什么**

- **设置页和 popup 都是「整对象覆盖写」**：`options.js` L301-303 `writeSettings(next)` = `chrome.storage.local.set({ adshield_settings: next })`。也就是说**页面端改一个开关会把整个 `adshield_settings` 覆盖掉**。如果 background 此刻正在写同一键（比如订阅更新落盘 L943），两者的写入会互相覆盖。
- **background 侧靠 `storage.onChanged` 感知**（L1593）：`adshield_settings` 一变，自动跑 `syncRulesets()` + `syncSiteAllowlist()` + `scheduleCleanup()` + `scheduleSubscriptionCheck()` + 刷新所有标签的 badge（L1595-1604）。**你的新开关如果影响 DNR 行为，必须在这条链上体现**（比如像 `enabled` 那样参与 `syncRulesets` L115 的 `s.enabled && s.rulesets[id] !== false` 判断）。
- **`MSG.SET_FEATURE` 存在但无人调用**（L998-1001）。它是「页面发消息改设置」的现成通道，但当前所有页面都走直接写 storage。**新开关建议沿用现有页面的直接写模式**（与 `enabled`/`antiDetect`/`assist`/`showBadge` 一致），不要引入第二套写法。
- **不要在页面里写 `DEFAULT_SETTINGS` 的副本**——`check.mjs` 会拦。

**怎么验证**

```bash
npm run verify
```
人工：设置页切换开关 → 关掉设置页重开 → 开关状态还在 → popup 同步反映 → 断网重开也在（`storage.local` 持久）。

---

## B4. 改订阅源的解析规则

**改哪些文件（都在 `src/background.js`）**

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `parseSubscriptionText()`（L567） | **格式层**：JSON 数组 还是 uBlock 文本 |
| 2 | `applySubscriptionText()` 的解析循环（L626-722） | **语法层**：修饰符黑名单 `SKIP_MODS`（L658）、资源类型映射 `TYPE_MAP`（L667）、域名/例外/路径三类分流 |
| 3 | `applySubscriptionText()` 的规则构造（L734-818） | **打包层**：域名 1000 个/条合并（`CHUNK` L738）、例外优先级 100、路径规则上限 `MAX_PATHS = 800`（L790）、域名块上限 4500（L741）/ 例外块上限 4600（L756） |
| 4 | `fetchSubscriptionText()`（L595） | **网络层**：30 秒超时（`AbortController` L598） |

**要注意什么**

- **`@@` 例外规则绝不能进 `pathRules`**。L704 有明确注释：那里每一项都会被构建成「拦截」规则，`@@` 放行会变成拉黑，**语义完全反过来**。你改分流逻辑时这一条必须保留。
- **`domainAllow`（例外）用 priority 100，域名拦截用 priority 1**。改动优先级会改变「例外 vs 拦截」的胜负关系。
- **新语法要先判断「加进 DNR 规则」还是「加进 `##` 元素隐藏」**。`##` / `#@#` 走 `cosmetic.js` 的 CSS 注入路径，**不在** `applySubscriptionText` 里处理——L630 明确跳过元素隐藏规则。**订阅源里的 `##` 目前完全不支持。**
- **不要引入正则规则**。Chrome 的 `regexFilter` 是**全串匹配**（非锚定正则 = 静默 0 命中，`AGENTS.md` 第 4 节）。订阅源里的正则/通配复杂规则目前一律跳过（L720-721）。
- **解析结果为 0 条时必须整段放弃**（L824）。这是 CDN/反爬挡回一个 HTML 错误页时的救命逻辑——照常下发会把该订阅原有规则整段删掉，还回一句「更新成功 0 条」。
- **预算截断在提交前**（L832-840）。`updateDynamicRules` 是**整批原子提交**——超限意味着这批一条都上不去。截断后可能一条不剩，同样不能下发（L840）。
- ⚠️ **「截断到空 → 不下发」是硬约束**。`updateDynamicRules` 是「先删后加」的原子操作，`addRules` 为空却下发 = **只删不加**，用户原有规则被整段清空。订阅路径的保护在 L824 / L840，用户规则路径的同类保护在 L514-519（`POOL_FULL`）。**你改这两条路径的任何一处，都要确认「空 addRules 不下发」还在。**

**怎么验证**

```bash
npm run verify
```
人工：设置页订阅管理 → 加一个订阅 → 看「已应用 N 条 DNR 规则」提示 → 检查它拦住的东西确实被拦（开发者模式下 background console 有 `[AdShield] 路径规则处理完成：原始 X 条 → 有效 Y 条 → 保留 Z 条`）。
`npm run probe` 可以看实际占用了多少动态规则。

---

## B5. 新增一个页面（扩展页面）

**改哪些文件**

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/<新页>.html` | 页面骨架。注意 **`<script>` 顺序必须在使用它的脚本之前**（`AGENTS.md` 第 2 节） |
| 2 | `src/<新页>.js` | 页面逻辑 |
| 3 | `src/<新页>.css` | 样式（可选） |
| 4 | `src/options.html` | 若挂在设置页里：加 `<a class="nav-item" data-tab="xxx">`（L26-66 区）+ `<section class="panel" data-panel="xxx">` |
| 5 | `src/options.css` | **三处** `html[data-route="xxx"]` 规则：L118-127（nav-item 高亮）、L128-135（svg 描边）、L393-399（panel 显示）。**漏了 CSS，页面永远不显示** |
| 6 | `src/shared/nav-init.js` | 默认 tab 名（当前 `"privacy"`，L3）。新增 tab 不一定要改这里，但默认值要一致 |

**要注意什么**

- **独立页面（如 logger/probe）不需要动 manifest**——它们是 `chrome.runtime.getURL("src/xxx.html")` 打开的。但**内容脚本**必须加进 `manifest.json` 的 `content_scripts`。
- **脚本加载顺序**：`theme.js` 放最前（减少闪烁），`nav-init.js` 次之（首屏立即设 `data-route`），然后才是 `host.js` / `dom.js` / `config.js`，`modal.js` 必须在用 `showConfirm`/`showAlert` 的脚本之前。
  - `check.mjs` 第 5 节（L211-227）**只检查 `logger.html`**：用了 `showConfirm`/`showAlert` 但没加载 `modal.js` → 报错。新页面不在这个检查范围内，**要自己保证顺序**。
- **`config.js` 必须在页面脚本之前**——`options.js` L3 顶层就解构 `window.adshieldConfig`。
- **新页面引用的 DOM id 要在 HTML 里存在**。`check.mjs` 第 3 节（L95-130）只检查 `options.js`/`popup.js`/`logger.js` 三个文件的 `$("#xxx")` 和 `getElementById("xxx")`——**新页面不在覆盖范围内**。规则是：JS 里引用了 HTML 中不存在的 id，且**没有空值保护**（`if (!el)` / `if (el && ...)` / `el ? ... : null`）→ 报错。

**怎么验证**

```bash
npm run verify
```
人工：新页面能打开、脚本无 console 报错、`chrome://extensions` 里点进去不白屏。

---

## B6. 加一条用户自定义规则语法

**改哪些文件（语法分两路，各改各的）**

| 规则类型 | 改哪里 |
|---|---|
| **网络规则**（`\|\|example.com^`、`/ads/`、`@@\|\|...`） | `src/background.js` `parseRuleLine()`（L377）。修饰符映射 `RULE_TYPE_MAP`（L363）、黑名单 `RULE_UNSUPPORTED_MODS`（L370） |
| **元素隐藏规则**（`##selector`、`#@#selector`） | `src/content/cosmetic.js` `pickUserSelectors()`（L141）+ `domainsMatch()`（L173） |

**要注意什么**

- **两套解析器是独立的**（A4 陷阱③）。用户在设置页写 `||example.com^$script` 走 `parseRuleLine`；订阅源里同一语法走 `applySubscriptionText` 内联逻辑（L626-722）。**加语法要确认改的是哪一路**。
- **修饰符黑名单两份不一样**：
  - 用户规则 `RULE_UNSUPPORTED_MODS`（L370）：含 `important`、`all`
  - 订阅规则 `SKIP_MODS`（L658）：含 `~third-party`
  加新修饰符时**别指望另一份自动跟上**。
- **`$` 后面必须是合法修饰符字符**才当修饰符解析：L397 的 `/^[a-z0-9,|~_\-]+$/i`。不匹配则整行当 `urlFilter` 处理——这是为了避免把 URL 里的 `$` 误判。
- **`||domain^` 的域名会剥掉前导 `*.`**（L427 附近）。剥不掉（含其它 `*`）就跳过整条。
- **`buildCondition()` 强制加 `excludedResourceTypes: ["main_frame"]`**（L417）——用户规则永远不拦主文档。
- **例外规则 `@@` 的 priority 是 100，普通拦截是 2**。新增语法要决定用哪个。
- **不支持的修饰符 = 整条跳过，不报错**（L408-410）。用户看不到任何提示——**这是刻意的**（注释 L369：「宁可少拦，不可误拦」），但也意味着新语法加错时是**静默失效**。
- **`##` 元素隐藏规则不进 DNR**，它进 `adshield_user_cosmetic` 键（L524），由 `cosmetic.js` 的 `reloadUserRules()`（L215）读出来注入 CSS。
- **`#@#` 例外规则**：在 `pickUserSelectors` 里进 `except` 集合，`buildCss` 时从 `hide` 里剔除。**例外只对匹配域名生效**——域名匹配失败时不进 except。

**怎么验证**

```bash
npm run verify
```
人工：设置页「自定义规则」→ 写一行 → 保存 → 看底部状态提示「已应用 N 条网络规则，M 条元素隐藏；K 条未生效（原因：...）」。**这个提示是 `adshield_user_rules_result` 键驱动的**（`options.js` L1916-1939），background 写、设置页读。看不到提示说明应用流程断了。

---

## B7. 加一条用户自定义规则语法的完整链路（补充）

保存一条用户规则，**实际经过 4 跳**：

```
options.js 点「保存」(L1059-1082)
  └─ sendMessage(SAVE_USER_RULES, {rules: lines})
       └─ background.js handleOtherMessage (L1060)
            ├─ 值有变化 → 写 adshield_user_rules (L1066) + 写 adshield_user_rules_result{pending:true} (L1070)
            │    └─ storage.onChanged 触发 → 防抖 300ms (L1607-1614) → applyUserRules() (L456)
            │         └─ 写 adshield_user_rules_result{ok:true,result} (L1615)
            └─ 值没变化 → 直接 applyUserRules() → 写 adshield_user_rules_result{ok:true,result} (L1074)
```

**关键点**：
- **「保存成功」和「规则生效」是两件事**。background 收到消息时只保证写盘成功；真正应用在 300ms 防抖之后。`options.js` L1068-1071 因此专门处理 `resp.pending`。
- **防抖 300ms 是为了合并短时间内的多次变更**（L1608 注释），避免 `updateDynamicRules` 并发竞态。
- **`applyUserRules()` 会写 `adshield_user_cosmetic`**（L524）——即使这次只改了网络规则，`##` 部分也会被整体重写。
- **失败会落盘**（L1616-1622）：`applyUserRules` 抛异常 → 写 `{ok:false,error}` → 设置页显示「⚠ 规则未能生效」。**不落盘的话设置页只显示「保存成功」，实际一条都没生效**（L1613-1614 注释）。

**怎么验证**：保存后**等 1 秒**再看状态提示；连点两次保存（快速），确认只应用一次且结果正确。

---

## B8. 改静态规则集 ID 段 / 动态规则段位（高危，详见 C 篇）

| 段 | 常量 | 位置 |
|---|---|---|
| 用户自定义 | `USER_RULE_BASE = 100000` | background.js L360 |
| 站点放行 | `SITE_RULE_BASE = 200000` | background.js L132 |
| 订阅 | `SUB_RULE_BASE = 300000` | background.js L535 |
| 全局放行 | `GLOBAL_ALLOW_RULE_ID = 2000000` | background.js L58 |

改任何一段位，**至少要同步 5 处**：常量定义、`applyUserRules`（L459 过滤区间）/ `syncSiteAllowlist`（L163）/ `applySubscriptionText`（L730 段位计算）里的区间计算、`probe.js`（L61-69）的分段统计、`AGENTS.md` 第 2 节的段位表。

---

## B9. 改 UI 文案 / 样式

| 目标 | 改哪里 | 注意 |
|---|---|---|
| 扩展页面文案 | 对应 `.html` | UI 文案**目前全是硬编码中文**，`_locales` 只有 `extensionName` / `extensionDescription` 两个键（`AGENTS.md` 第 7 节） |
| 设置页样式 | `src/options.css`（2641 行，50+ 段标） | **双写机制**：面板显示由 `html[data-route="X"] .panel[data-panel="X"]`（L393-399）控制，`.panel.active`（L391）是 JS 切换时用的。改 CSS 时别只改一条 |
| popup 样式 | `src/popup.css`（623 行） | 分类色用 CSS 变量 `--cat-ads` 等（L4-8），类名映射在 `popup.js` `SEG_CLASS`（L145） |
| logger 样式 | `src/logger.css`（90 行） | `.cat-*` 类名有 light + dark 两套（L68-78），新增分类要加两条 |
| 弹窗样式 | `src/shared/modal.css`（268 行） | picker.js 有**自己的一套** `__adshield_dialog_*`（因为 content script 用不了扩展页样式），改弹窗外观要同步改两处 |
