# 交接文档 · 补充篇 A：模块职责边界表

> 配套 `AGENTS.md`（硬性约定）、`docs/ARCHITECTURE.md`（全局结构）。
> 本文只补「每个文件负责什么 / 不负责什么 / 大文件内部实际分了哪几块」。
>
> **行号快照：2026-11-01 12:15**（`background.js` 1943 行）。源码会被并行修改，
> **行号只作定位辅助，一切以函数名 / 常量名为准**。

---

## A1. 文件级职责边界表

### A1.1 Service Worker（`src/background.js`，1943 行）

| 文件 | 一句话职责 | 对外接口（暴露给谁 / 怎么暴露） | **不该由它负责什么** |
|---|---|---|---|
| `background.js` | DNR 规则的写入方 + 设置的权威写入方 + 统计聚合器 + 消息路由 | ① **消息入口**：`chrome.runtime.onMessage`（L1382）→ `handleOtherMessage()`（L949）+ `ASSIST_DETECTED` 独立分支（L1384）② **Chrome 事件回调**：`onInstalled`(L1551) / `onStartup`(L1588) / `storage.onChanged`(L1593) / `alarms.onAlarm`(L197, L1534) / `commands.onCommand`(L1438) / `contextMenus.onClicked`(L1490) / `tabs.onActivated`(L1627) / `tabs.onUpdated`(L1631) / `tabs.onRemoved`(L1896) / `declarativeNetRequest.onRuleMatchedDebug`(L1740) | ✗ **不做 UI 渲染**（弹窗一律 `shared/modal.js`）<br>✗ **不做 host 归一化**——必须调 `self.adshieldHost` 的函数（见 A4 陷阱①）<br>✗ **不自己写默认设置**——`DEFAULT_SETTINGS` 只在 `shared/config.js`<br>✗ **不解析用户规则以外的自定义格式**——用户规则走 `parseRuleLine()`（L377），订阅走 `applySubscriptionText()`（L614），**两者是两套独立实现**（见 A4 陷阱③） |
| | | | ✗ **不写 `adshield_user_cosmetic` 以外的用户数据键**——`adshield_user_rules` 与 `adshield_user_cosmetic` 由 `applyUserRules()` 写（L522, L524），`adshield_stats` 由 `flushStats()` 写（L1683） |

### A1.2 Content Script（`src/content/`）

| 文件 | 一句话职责 | 对外接口 | **不该由它负责什么** |
|---|---|---|---|
| `content/cosmetic.js`（444 行） | 元素隐藏引擎：注入 `<style id="__adshield_cosmetic__">`；兼做**浏览助手的反拦截检测发起方** | ① 读 `adshield_settings` / `adshield_user_rules` / `adshield_user_cosmetic`（L216, L227, L430）② 发 `assistDetected` 消息（L269）③ 监听 `storage.onChanged` 重算样式（L411） | ✗ **不写任何 storage 键**（全文件无 `storage.local.set`）<br>✗ **不直接改页面 DOM 结构**——只注入一个 `<style>`，不删元素<br>✗ **不负责 MAIN world 的全局变量伪装**——那是 `anti-detect-main.js` |
| `content/anti-detect.js`（98 行） | 隔离世界的反拦截规避：生成 nonce、注入「广告位诱饵」CSS、给新增广告节点打 `data-adshield-bait` 标记 | ① 写 `document.documentElement[data-adshield-nonce]`（L25）+ `window.__adshield_nonce__`（L26）② `window.postMessage({__adshieldInit:1,...})` 通知 MAIN world（L32）③ 读 `adshield_settings`（L29） | ✗ **不做真实检测**——隔离 world 读不到页面 `window`，检测在 MAIN world<br>✗ **不覆盖原生原型**——文件头 L2 明确「不覆盖 Element/HTMLElement.prototype」 |
| `content/anti-detect-main.js`（97 行） | MAIN world：伪装 `canRunAds` 等全局变量 + 读取页面真实检测结果回报 | ① `Object.defineProperty(window, key, ...)` 写 8 个全局变量（L35-40）② `window.postMessage({__adshieldDetected:1,nonce,key})` 回报（L59） | ✗ **禁止出现任何 `chrome.*` 调用**（MAIN world 无扩展权限）——已实测文件内零 `chrome.` 调用<br>✗ **不做 DOM 诱饵**——那是 `anti-detect.js` |
| `content/picker.js`（303 行） | 元素拾取器：鼠标悬停高亮 → 点击生成 CSS 选择器 → 让用户选「本站 / 全站」 | ① 监听 `chrome.runtime.onMessage` 的 `startElementPicker`（L298）② 生成规则后发 `saveUserRules` 消息（L266） | ✗ **不直接写 `adshield_user_rules`**——只发消息，规则本体交给 background 写（L262-266 有注释说明原因）<br>✗ **不用 `shared/modal.js`**——content script 用不了扩展页样式，自带一套 `__adshield_dialog_*`（L33-138） |

### A1.3 扩展页面（`src/*.js`）

| 文件 | 一句话职责 | 对外接口 | **不该由它负责什么** |
|---|---|---|---|
| `options.js`（1965 行） | 设置页的全部交互与渲染：6 个面板（常规/规则/网站/统计/账号/关于） | ① `chrome.runtime.sendMessage`（包装成 `sendMessage()` L1205）② `window.adshieldAuth`（账号相关按钮，L1762）③ `window.__adshield_theme__.apply()`（L1190） | ✗ **不写 `adshield_user_rules` 本体**——只发 `saveUserRules`（L1064）<br>✗ **不直接写 `adshield_user_cosmetic`**——删除元素隐藏规则时也只发 `saveUserRules`（L1049），由 background 的 `applyUserRules()` 重算该键<br>✗ **不做云端同步**——那是 `shared/auth.js` |
| `popup.js`（699 行） | 工具栏弹窗：当前站点暂停按钮、分类圆环、规则集开关、工具项 | ① `chrome.runtime.sendMessage`（`getStats`/`getTabStats`/`resetStats`）② `chrome.tabs.sendMessage(tabId, {type:"startElementPicker"})`（L614）③ `chrome.tabs.create` 打开 options/logger（L530, L536） | ✗ **不做拾取器的规则写入**——只发 `startElementPicker`（L614），规则由 picker.js 发 `saveUserRules`<br>✗ **不自己画 SVG 圆环**——`renderWheel()`（L215）用 `SEG_CLASS`（L145）映射到 `popup.css` 的 `.seg-*` |
| `logger.js`（134 行） | 日志页：分类/关键词过滤、JSON/CSV 导出、清空日志 | ① `sendMessage(MSG.GET_STATS)`（L29）② `chrome.runtime.sendMessage({type:"clearLogs"})`（L129）③ `window.adshieldDom` 的 `downloadJson/downloadCsv` | ✗ **不直接清 storage**——`clearLogs` 必须走 background（L126-128 注释：否则内存缓冲会把旧日志写回来）<br>✗ **不做分类名映射的单一定义**——`CATS` 在 `config.js`，但 `logger.js` 自己有 `SAFE_CATS`（L12）、`catName`（L71）、`CAT_LABEL`（L92）三份硬编码 |
| `probe.js`（155 行） | 运行时诊断页：一次性采齐 DNR 上限、已用规则数、反馈 API 可用性 | ① 直接调 `chrome.declarativeNetRequest.getDynamicRules/getEnabledRulesets/getMatchedRules`（L58, L76, L87）② 输出 JSON 供 `tools/probe-dnr.mjs` 解读 | ✗ **不做用户可见的诊断 UI**——它是给开发者/排障用的<br>✗ **不改任何配置**——只读 |

### A1.4 共享模块（`src/shared/`）

| 文件 | 一句话职责 | 对外接口 | **不该由它负责什么** |
|---|---|---|---|
| `shared/host.js`（96 行） | **host 归一化的唯一真源**：7 个导出函数 | `ROOT.adshieldHost = {normalizeHost, isValidHost, hostMatches, anyHostMatches, normalizeHostList, isPausedUntil, pausedUntilRemaining}`（L87-95） | ✗ **不做业务判断**——只提供纯函数<br>✗ **不依赖其它模块**（无依赖） |
| `shared/config.js`（96 行） | 默认设置 / 规则集定义 / 统计分类 / 消息协议的唯一真源 | `ROOT.adshieldConfig = {DEFAULT_SETTINGS, RULESETS, CATS, CAT_KEYS, CAT_LABELS, CAT_COLORS, MSG}`（L95） | ✗ **不写 storage**——只给默认值<br>✗ **不做业务逻辑** |
| `shared/dom.js`（57 行） | HTML 转义 + Blob 下载的唯一真源 | `ROOT.adshieldDom = {escapeHtml, downloadBlob, downloadJson, downloadCsv, downloadText}`（L56） | ✗ **不做 UI 组件**——只提供纯工具 |
| `shared/validate.js`（267 行） | 云端数据的净化防线：4 个 `sanitizeCloud*` + 密码/邮箱校验 | `ROOT.adshieldValidate = {...}`（L257），共 14 个函数 | ✗ **不碰 chrome API 与 DOM**——这是它能被 `tools/test-validate.mjs` 直接 `eval` 测试的前提（L1-6 注释）<br>✗ **不做云端网络请求**——只做纯函数 |
| `shared/modal.js`（258 行） | 弹窗基座：`showConfirm` / `showAlert` / `showFormDialog` | 全局函数 `window.showConfirm`（L54）/ `window.showAlert`（L136）/ `window.showFormDialog`（L171） | ✗ **不关心业务内容**——只负责 overlay/ESC/遮罩点击/多层栈<br>✗ **不做样式**——样式在 `shared/modal.css` |
| `shared/auth.js`（2467 行） | 账号系统 + 云端同步 + 备份导入导出 | `window.adshieldAuth = {getState, render, login, register, logout, sync, exportBackup, importBackup, readSyncPrefs, isReady}`（L2288-2299） | ✗ **不做云端数据净化**——4 个 `sanitizeCloud*` 在 `validate.js`（`check.mjs` 第 4b 节强制此约定）<br>✗ **不做 Supabase SDK**——手写 `fetch`（`sbRequest` L606）<br>✗ **不写 `adshield_settings` 以外的配置键**（例外见 A4 陷阱⑥） |
| `shared/theme.js`（45 行） | 主题应用（light/dark/auto） | `window.__adshield_theme__ = {apply, set}`（L24-33） | ✗ **不读其它配置**——只读 `adshield_settings.theme` |
| `shared/nav-init.js`（32 行） | 首屏防闪烁：同步给 `<html>` 设 `data-route` | 无导出，副作用式设置 `data-route` 属性（L8） | ✗ **不做交互**——切换逻辑在 `options.js` L343 |

---

## A2. 大文件内部实际分了哪几块职责

> 这几块**在同一个文件里，但互不相干**。改其中一块不影响其它块，但改错块会破坏别的功能。

### A2.1 `background.js`（1943 行）——8 块

| # | 块 | 范围 | 核心内容 | 改它会影响谁 |
|---|---|---|---|---|
| 1 | **设置读写 + 订阅 ID 归一化** | L26-50 `getSettings()` | 合并 `DEFAULT_SETTINGS`；**把订阅 id 强制归一化到 1~99 且不撞号**（L35-48） | 改坏 → 订阅 DNR ID 段位错位（A4 陷阱②） |
| 2 | **DNR 规则同步**（全局暂停 / 规则集 / 站点放行） | L52-99 `syncGlobalPauseRule()` / L101-129 `syncRulesets()` / L131-182 `syncSiteAllowlist()` | 三个 `updateDynamicRules` 写入点：L74/83/88（全局暂停）、L120/121（规则集启停）、L177（站点放行） | 改坏 → 「暂停了但还在拦」或「没暂停却放行」 |
| 3 | **命中分类 + badge** | L204-309（`classifyRule` L271 / `STATIC_RULE_SETS` L254 / `staticRuleSetCat` L262 / `THIRD_PARTY_TRACKERS` L214）/ L311-357（`updateBadgeForTab`） | ruleId → 分类的映射 | 改坏 → 统计图表归类错 |
| 4 | **用户自定义规则引擎** | L359-532（`parseRuleLine` L377 / `applyUserRules` L456） | ABP 语法 → DNR 规则；`##` 元素隐藏分流 | 改坏 → 用户规则全部失效 |
| 5 | **订阅引擎**（最大的一块） | L534-947 | 拉取（L595）/ 解析（L567, L614）/ ID 段分配（L725）/ 提交（L845）/ 队列（L557）/ 全量更新（L867） | 改坏 → 订阅规则整段丢失 |
| 6 | **消息路由** | L949-1436 | 22 个 `MSG` 分支 + `ASSIST_DETECTED` 的来源校验（L1384-1392） | 改坏 → 某个页面功能失效 |
| 7 | **生命周期与调度** | L1438-1624 | 快捷键（L1438）/ 右键菜单（L1469, L1490）/ 订阅定时器（L1515）/ `onInstalled`(L1551) / `onStartup`(L1588) / `storage.onChanged`(L1593) | 改坏 → 设置改了不生效、订阅不更新 |
| 8 | **统计聚合 + 通知** | L1626-1943 | 内存缓冲与刷盘（L1641/L1667/L1690）/ 通知节流（L1706）/ `onRuleMatchedDebug`（L1740）/ `getTabMatchStats`（L1870）/ 孤儿清理（L1911） | 改坏 → 数字不涨或重复计 |

### A2.2 `shared/auth.js`（2467 行）——6 块

| # | 块 | 范围 | 核心内容 |
|---|---|---|---|
| 1 | **账号与会话** | L22-30（本地状态）/ L502-594（失败锁定 / 会话超时 / 登录日志）/ L637-797（登录注册登出改密） | `adshield_auth` 键的读写；`MAX_FAILS=5`（L504）/ `LOCK_DURATION=15min`（L505）；`SESSION_MAX_AGE=30 天`（L548） |
| 2 | **设备管理** | L1065-1264 | 浏览器指纹生成稳定 deviceId（L1069）、`adshield_devices` 的上报/拉取/移除 |
| 3 | **弹窗 UI 集合** | L1350-1705（忘记密码 / 改密 / 登录注册）/ L167-336（头像）/ L891-960（删除账号验证码） | 全部基于 `showFormDialog` 基座 |
| 4 | **云端同步（网络层）** | L1707-1938（`collectLocalData` L1711 / `pushToCloud` L1767 / `pullFromCloud` L1840 / `withAuthRetry` L1918 / `refreshAccessToken` L1863） | `adshield_configs` 表读写；**`refresh_token` 单例 Promise**（L1862） |
| 5 | **云端同步（应用层）** | L1940-2058（`applyCloudData` L1970） | 4 个 `sanitizeCloud*` 调用点（L1992-1995）；「全都不合法就保留本地」兜底（L2007-2037）；`suppressAutoUpload(8000)` 回环抑制（L2032） |
| 6 | **备份导入导出 + 自动上传** | L1266-1348（导出 L1267 / 导入 L1293）/ L2060-2155（自动上传防抖）/ L2157-2285（`checkCloudUpdate` / `doSync`） | `adshield_user_rules_result` 的写入方是 background，不是这里 |

**设备识别 + 头像压缩**（L35-355）是块 1/3 的辅助代码，与云端无关。

### A2.3 `options.js`（1965 行）——5 块

| # | 块 | 范围 | 核心内容 |
|---|---|---|---|
| 1 | **静态功能**（版本号 / 检查更新 / 更新日志 / 外部链接 / 诊断入口） | L18-292 | `syncVersion()`（L18）/ `checkUpdate()`（L53）拉 GitHub Releases；`simpleMarkdown()`（L226）轻量 Markdown 渲染 |
| 2 | **导航与设置读写** | L294-321（`readSettings` L294 / `writeSettings` L301 / `readStats` L304）/ L342-383（侧栏 L343 / hash 路由 `parseHash` L354）/ L1093-1196（主渲染 L1093 / 开关 L1146 / 主题 L1175） | `writeSettings()` 是**整对象覆盖写**（L301-303）——不是增量 |
| 3 | **白名单 / 站点 / 规则集** | L385-559（`renderRulesets` L386 / `initRulesetToggles` L397 / `renderSites` L411 / `renderGroup` L451 / `setupSiteEvents` L497） | 清空白名单走 `hostMatches` 子域匹配（L483）；`addSite()`（L509）用 `normalizeHost` + `isValidHost` 校验 |
| 4 | **统计报告 + 趋势图** | L588-991（`renderReport` L588 / `TREND_CATS` L715 / `renderTrend` L754） | SVG 手绘多线柱状图（`smoothPath` L724 Catmull-Rom）；`TREND_PREF_KEY` 偏好持久化（L964） |
| 5 | **订阅管理 UI** | L1198-1965 | 推荐源（`PRESET_SUBS` L1556）、5 态按钮（`setBtnState` L1590）、批量提交（`queueSubscribe` L1264）、导入导出卡片（`setupBackup` L1751）、同步勾选（`setupSyncPrefs` L1887）、规则应用结果提示（L1917-1939） |

**`options.css`（2641 行）**的分区：50+ 个 `/* ==== XXX ==== */` 段标（Layout/Sidebar/Content/Card/Stats/Sites/趋势图/Auth 弹窗/Account/About/Responsive…），与 `options.html` 的 6 个 `<section class="panel" data-panel="...">` 一一对应（`options.html` L110/272/379/422/492/746）。
**改 CSS 时注意：面板显示由 `html[data-route="X"] .panel[data-panel="X"]` 控制（options.css L393-399），不是 `.panel.active`**——`.panel.active` 那条（L391）是 JS 切换时用的，**双写机制**。

### A2.4 `content/cosmetic.js`（444 行）——4 块

| # | 块 | 范围 | 核心内容 |
|---|---|---|---|
| 1 | **选择器库** | L13-117 | `GENERIC_SELECTORS`（85 条通用，L13）/ `SITE_RULES`（30 个站点，L87） |
| 2 | **CSS 生成 + 注入** | L119-231（`buildCss` L119 / `injectStyle` L185 / `removeStyle` / `reloadUserRules` L215） | `STYLE_ID = "__adshield_cosmetic__"`；注入到 `document.head` |
| 3 | **用户选择器筛选** | L138-181（`pickUserSelectors` L141 / `domainsMatch` L173） | 支持 `##` / `#@#` / `~` 排除 / `*.` 通配；**纯 `~` 列表语义为「除排除项外全局」**（L179） |
| 4 | **浏览助手检测** | L233-408（`detectAdBlockScripts` L253） | 4 路检测（MAIN world 回报 / 脚本源码 / 弹窗文案 / MutationObserver）；`ASSIST_SKIP_HOSTS` 36 个大站跳过（L236-251）；页面浮条通知（L374-397） |

---

## A3. 模块依赖与「谁调谁」速查

```
页面层         options.js  popup.js  logger.js  probe.js
                 │  │         │        │         │
                 │  └─────────┴────────┴─────────┘   chrome.runtime.sendMessage
                 │                    │
共享层      shared/config.js  shared/validate.js  shared/host.js  shared/dom.js
                 │                    │
                 ▼                    ▼
             shared/auth.js ────────┘
                 │
                 ▼
Service Worker   background.js  ← importScripts(shared/host.js, shared/config.js)
                 │
                 ▼
          chrome.declarativeNetRequest  /  chrome.storage.local
```

**Content Script 是独立支线**：`host.js` → `cosmetic.js` → `anti-detect.js`（隔离世界）；
`dom.js` → `picker.js`；`anti-detect-main.js` 独立跑在 MAIN world。
**content script 不加载 `shared/config.js`**（manifest 只注入了 host/cosmetic/anti-detect 与 dom/picker），
所以 content script 里的消息类型是**硬编码字符串**（`"assistDetected"` L269、`"saveUserRules"` L266、`"startElementPicker"` L298），不走 `MSG` 常量。

---

## A4. 读代码时最容易看错的 6 处

| # | 陷阱 | 事实 |
|---|---|---|
| ① | `background.js` 看着像没用 `isPausedUntil` | **用对了**。L5 解构了 4 个：`const { normalizeHost, anyHostMatches, normalizeHostList, isPausedUntil } = self.adshieldHost;`，L333 用 `isPausedUntil(s.pausedUntil, host)` 判临时暂停。<br>⚠️ **这行是个教训**：`updateBadgeForTab`（L312）的 `catch (e) { /* tab 已关闭 */ }`（L354）会**吞掉任何异常**。曾经这里因为漏解构 `isPausedUntil` 抛 `ReferenceError`，导致 badge 数字永远不显示而无人察觉。**改这个函数时，如果 catch 里还这么写，异常会被静默吞掉** |
| ② | `getSettings()` 只是读设置 | **它还改**订阅 id（L35-48）。这个副作用会影响 DNR ID 段位（`applySubscriptionText` L725 `((sub.id\|\|0)%100)*10000`）。任何绕过 `getSettings()` 直接读 `store[SETTINGS_KEY].subscriptions` 的新代码都会拿到未归一化的 id |
| ③ | `applyUserRules` 和 `applySubscriptionText` 是同一个解析器 | **是两套**。用户规则走 `parseRuleLine`（L377，修饰符黑名单 `RULE_UNSUPPORTED_MODS` L370）；订阅走 `applySubscriptionText` 内联逻辑（L626-722，黑名单 `SKIP_MODS` L658）。两份黑名单**内容不同**（订阅版多 `~third-party`，用户版多 `important`/`all`） |
| ④ | `adshield_user_cosmetic` 只有 background 一个写入方 | 规则本体由 `applyUserRules()` 写（L524）——它**从 `adshield_user_rules` 里的 `##` 行重算出这个键**。⚠️ 这意味着 **`adshield_user_cosmetic` 是派生数据，不是独立数据源**：只改它而不改 `adshield_user_rules`，下一次应用规则时会被整体覆盖 |
| ⑤ | `MSG` 有 22 个常量 | **实际只有 15 个被调用**。`GET_STATE` / `TOGGLE_GLOBAL` / `TOGGLE_SITE` / `TOGGLE_RULESET` / `SET_FEATURE` / `GET_USER_RULES` / `SAVE_SUBSCRIPTIONS_BATCH` 七个分支**无任何调用方**（已 grep 全仓库确认）。页面侧改设置走的是**直接写 storage**（`options.js` L301 / `popup.js` L26），不是发消息 |
| ⑥ | `auth.js` 里的 `RULE_CTRL_CHARS` 是本地常量 | **是导出的**。它定义在 `shared/validate.js` L124，已列入导出清单（L267），`auth.js` L13-19 同步解构。⚠️ **曾经这里没导出**，导致 `auth.js` L1329 用裸标识符 `RULE_CTRL_CHARS.test(r)` 抛 `ReferenceError`，**导入含自定义规则的备份必崩**。改 `validate.js` 的导出清单时，记得 `auth.js` 的解构要同步 |
