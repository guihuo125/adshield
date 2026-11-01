# AdShield 广告拦截器 — AI 交接文档

> 面向下一个接手这个项目的 AI / 开发者。
> 文档里的每个数字都是 **2026-11-01 在 Chrome 156.0.8078.74 上实测出来的**，不是从记忆或旧文档抄的。
> 凡是「逻辑推演」「未实测」的地方都单独标了，不要当成事实继承。
>
> **2026-11-01 第二轮（2.9.97）更新**：新增 §6.6 上线门禁、§6.7 改动手册、§6.8 模块职责边界、
> §2 UI 层速查；已知坑从 15 条加到 24 条；测试从 0 增至 149 项（`npm run verify`）。
> 同轮修掉 3 个真实缺陷（解构漏项 ×2、池满清空用户规则 ×1）并补了 2 个 P1（云端空 rulesets 覆盖、
> 设置页正式版统计无数据）。逐条记录见 §5 与 §7.2b。

---

## 1. 这是什么

- Chrome Manifest V3 扩展，广告拦截 + 元素隐藏 + URL 参数清理 + 反拦截检测 + 账号云同步。
- 独立开发者的单人项目，没有 CI、没有 review、没有测试框架。
- 当前版本 **2.9.96**（`adblocker/manifest.json`）。
- 两个目录，**必须分清**（见 §8）：

| 目录 | 角色 |
|---|---|
| `D:\AdShield 广告拦截器\` | 工作区。**打包源**（`pack.ps1` 从这里打 CRX/ZIP），代码实际编辑处 |
| `D:\temp-adshield-repo\` | git 仓库。README / PRIVACY / docs / 发布用的 git 历史在这里 |

两边内容必须保持一致。2026-11-01 全量哈希比对后已一致（31/31 逐字节相同），比对方法见 §6.4。

---

## 2. 目录结构与文件职责

```
adblocker/
  manifest.json            MV3 清单。5 个静态规则集 + 3 个 content script + service worker
  rules/                   静态 DNR 规则集（打包进 CRX）
    ads.json               1 条规则，requestDomains 列了 ~330 个广告域名
    tracking.json          1 条规则
    annoyances.json        1 条规则
    url-tracking.json      29 条规则，id 3000~3028，redirect + queryTransform.removeParams
    malware.json           1 条规则
  _locales/{zh_CN,en}/messages.json   只有 extensionName / extensionDescription 两个键
  icons/                   icon16/32/48/128
  src/
    background.js          1894 行。Service Worker：规则同步、订阅拉取、统计、消息处理
    popup.{html,css,js}   699 行 js。工具栏弹窗
    options.{html,css,js} 1965 行 js + 48KB html。设置页（6 个页签）
    logger.{html,css,js}  134 行。请求级明细日志
    content/
      cosmetic.js          444 行。元素隐藏引擎 + 浏览助手（反拦截检测）
      anti-detect.js       97 行。隔离世界部分：DOM 诱饵 + 与 MAIN world 握手
      anti-detect-main.js  97 行。**MAIN world**：全局变量伪装 + 真实检测
      picker.js            303 行。元素拾取器（自带一套模态框样式）
    shared/
      auth.js              2467 行。账号系统 + Supabase 云同步（**最大的单文件**）
      modal.js             258 行。showConfirm / showAlert / showFormDialog
      host.js              96 行。host 归一化（**唯一真源**）
      dom.js               57 行。HTML 转义 + 文件下载（**唯一真源**）
      config.js            96 行。默认设置 + 规则集定义 + 消息协议（**唯一真源**）
      validate.js          267 行。云端数据校验纯函数（**唯一真源**，可单测）
      theme.js / nav-init.js
tools/                    开发工具，**不进扩展包**
  check.mjs               静态校验：regexFilter 锚定 / 规则 id 区间 / DOM 契约 / 单一真源
  test-host.mjs           27 项：host 归一化与三层判定一致性
  test-rules.mjs          13 项：用户规则段位上限 / 订阅全局预算
  test-validate.mjs       100 项：云端数据净化与校验（安全边界）
  probe-cdp.mjs           运行时诊断采集（自启 Chrome + CDP，零人工）
  probe-dnr.mjs           诊断结果解读
  verify-extension.js     真机验证（仓库侧，6 项）
  verify-round3-fixes.js  第三轮修复的真机验证（仓库侧，22 项）
package.json              npm run check / test / verify / probe
```

### 静态规则的 ruleId 段（`background.js: STATIC_RULE_SETS`）

| 规则集 | ruleId |
|---|---|
| ads | 100 |
| tracking | 1000 |
| annoyances | 2000 |
| url_clean | 3000~3028 |
| malware | 4000 |

**分类统计靠这个段位反推**，不是靠 URL 特征猜。改规则集的 id 段 = 改坏统计。

### UI 层速查（改界面看这里）

四个界面的职责、对应文件、状态来源：

| 界面 | 文件 | 解决什么问题 | 状态来源 |
|---|---|---|---|
| 设置页 | `options.{html,css,js}` | 开关、规则、订阅、统计、账号 | `adshield_settings` / background 消息 |
| 工具栏弹窗 | `popup.{html,css,js}` | 当前站状态、暂停菜单、快速统计 | `getState` / `getStats` / `getTabStats` |
| 详细日志 | `logger.{html,css,js}` | 逐条拦截记录 | `getStats` 的 `recentLogs` |
| 运行时诊断 | `probe.{html,css,js}` | 采集 DNR 运行时事实 | 直接调 `chrome.declarativeNetRequest` |

**改一个 UI 元素要动的地方**：

| 场景 | 动哪里 | 注意 |
|---|---|---|
| 加一个设置开关 | `options.html` 加控件 → `options.js` 加读写 → `shared/config.js` 的 `DEFAULT_SETTINGS` | 三处都要动。`DEFAULT_SETTINGS` 是唯一真源，`options.js` 与 `popup.js` 共用 |
| 改弹窗上的显示 | `popup.js` 的 `render()` → `popup.html` 对应 DOM | `render()` 每 2 秒跑一次，别在里面做重活 |
| 加一个设置页板 | `options.html` 加 `.nav-item` + `.panel` → `shared/nav-init.js` 会自动切 `data-route` | `nav-init.js` 读 `location.hash`，首屏就会应用 |
| 改主题色 | CSS 变量：`options.css` / `popup.css` / `logger.css` 各自定义了一套 `--bg` / `--text-*` | **三份 CSS 各自定义了变量，没有共用**，改主题色要同步改三处 |
| 加日志页的一列 | `logger.js` 的 `render()`（拼 `tr.innerHTML`）+ `logger.css` | 转义走 `shared/dom.js` 的 `escapeHtml` |
| 加弹窗 | 用 `shared/modal.js` 的 `showConfirm` / `showAlert` / `showFormDialog`，**不要自己写 overlay** | `auth.js` 曾有 6 处手写 overlay，现已全部收敛 |

**样式与主题机制**：

- `shared/theme.js` 在页面 `<head>` 里同步执行，读 `adshield_settings.theme`，
  给 `<html>` 设 `data-theme="light|dark"`，并同步 `<meta name="color-scheme">`。
- 各 CSS 用 `html[data-theme="dark"] { --bg: ...; }` 覆盖变量。
- `shared/modal.css` 是弹窗样式，四个页面都引了它；页面自己的 CSS 只管自己的布局。

**已知的前端层坑**：

| 坑 | 位置 | 说明 |
|---|---|---|
| **设置页统计在正式版拿不到数据** | `options.js` 的 `renderReport()` | 已修（2.9.97）：正式版由弹窗查到的数据**回写**统计缓冲，设置页读共享缓冲。设置页自己拿不到 activeTab（Chrome 只在用户调用扩展时授予），所以不能自己查 |
| 硬编码色值散落 | 三个 CSS 文件 | 改主题色要同步改三处变量表 |
| `options.css` 2641 行 | `options.css` | 样式与 HTML 强耦合，改动回归面大 |
| `innerHTML` 拼接 | `options.js` / `logger.js` / `popup.js` | 用户数据必须走 `escapeHtml`；服务端返回的正文一律 `textContent` |

---

## 3. 运行时架构

### 3.1 消息流

```
popup / options  --chrome.runtime.sendMessage-->  background.js
content script  --chrome.runtime.sendMessage-->  background.js
```

`background.js` 的 `chrome.runtime.onMessage` 是唯一入口，分两支：
- `assistDetected`（来自 content script）：自动暂停本站。**会校验 `msg.host` 必须等于 `sender.tab.url` 的主机名**，否则拒绝。
- 其余全部走 `handleOtherMessage()`。

### 3.2 规则体系（这是全项目最容易出错的地方）

有 **两套**规则，作用范围不同：

| | 静态规则集 | 动态规则 |
|---|---|---|
| 存哪 | CRX 内的 `rules/*.json` | `chrome.declarativeNetRequest` 动态规则表 |
| 谁写 | 打包时固定 | 运行时装 |
| 开关 | `updateEnabledRulesets()` | 无开关，只能增删 |
| 组成 | ads/tracking/annoyances/url_clean/malware | 订阅规则、用户自定义规则、站点放行规则、全局放行规则 |

**动态规则的 ID 段划分**（`background.js` 顶部几个常量）：

| 用途 | 基址 | 段宽 | 说明 |
|---|---|---|---|
| 用户自定义规则 | `USER_RULE_BASE = 100000` | 10000 | |
| 站点放行规则 | `SITE_RULE_BASE = 200000` | 10000 | `allowAllRequests`，站点暂停用 |
| 订阅规则 | `SUB_RULE_BASE = 300000` | `10000 × (sub.id % 100)` | **子订阅的 ID 段由 sub.id 决定，撞号会互相覆盖** |
| 全局放行规则 | `GLOBAL_ALLOW_RULE_ID = 2000000` | 1 | 2.9.94 引入，全局暂停用 |

**所有动态规则共用一个池子**，上限见 §4.2。

### 3.3 全局暂停（2.9.94 引入）

原实现只关 5 个静态规则集，订阅规则和用户自定义规则照旧拦 —— 用户看到的现象是「暂停了但页面还是坏的」。

现在全局暂停时额外写一条动态规则：

```js
{ id: 2000000, priority: 10000, action: { type: "allow" }, condition: { urlFilter: "*" } }
```

恢复时删掉。写入拆成「先删一次、再加一次」两次 `updateDynamicRules` 调用，不依赖 Chrome 对「同一 ID 同时出现在 remove 和 add 里」的处理顺序。

站点暂停不受影响（它是另一段规则，`allowAllRequests`）。

### 3.4 统计体系（两套并存）

| | 开发模式（未打包） | 正式安装版 |
|---|---|---|
| 数据源 | `chrome.declarativeNetRequest.onRuleMatchedDebug` | `chrome.declarativeNetRequest.getMatchedRules({tabId})` |
| 粒度 | 每条请求：URL、分类、时间线 | 每条命中：ruleId、tabId、timeStamp（**没有 URL**） |
| 触发 | 事件驱动 | **按需**：用户打开弹窗时查一次当前标签页 |
| 代码 | `background.js` 的 `onRuleMatchedDebug` 分支 | `background.js` 的 `getTabMatchStats()` |

正式版按需查询的关键设计（**2.9.97 改版**）：
- **不再后台轮询。** 旧实现每分钟起一个 alarm 调 `getMatchedRules()`，
  但 `declarativeNetRequestFeedback` 权限对商店安装版被忽略 —— 正式版这个调用**必然失败**，
  等于每分钟白唤醒一次 Service Worker。已删除。
- **走 `activeTab`。** `getMatchedRules(filter)` 的文档写明：
  「适用于持 `declarativeNetRequestFeedback` 权限的扩展，**或对 filter 里 tabId 有 `activeTab` 授权**的扩展」。
  用户点扩展图标打开弹窗时授予 activeTab，此时按 tabId 查就能拿到真实命中。
- **配额限流**：`getMatchedRules` 是 20 次 / 10 分钟，而弹窗每 2 秒轮询一次。
  弹窗侧做了 60 秒冷却 + 换标签页立即放行（`popup.js` 的 `__tabStatsAllowed`）。
- **弹窗查到的数据回写统计缓冲**（`background.js` 的 `GET_TAB_STATS` 分支）：
  设置页是自己打开的扩展页，**拿不到 activeTab**，无法自己查；
  只能靠弹窗查到的数据回写共享缓冲，设置页读缓冲才有数。
  用 `Math.max` 而非累加 —— `getMatchedRules` 返回的是该标签页**累计**命中，
  累加会让同一个 tab 查两次就翻倍。
- **仍拿不到**：被拦域名、趋势图（`getMatchedRules` 不返回 URL，这是 API 能力边界）。

### 3.5 账号与云同步（`shared/auth.js`）

- Supabase，`sb_publishable_*` 客户端密钥（**公开设计，不是密钥泄露**）。
- 两张表：`adshield_configs`（每人一行）、`adshield_devices`（每人多行）。
- 真正的授权边界在服务端 RLS，客户端的 `user_id=eq.` 只是过滤条件，不是边界。
- 客户端这一侧已经做的校验（`applyCloudData` → 4 个 sanitize 函数）：
  - `sanitizeCloudUserRules`：必须是字符串、≤1000 字符、无控制字符、总数 ≤5000、**元素隐藏选择器不能突破 CSS 块**。
  - `sanitizeCloudSubscriptions`：必须 https、可解析、≤500 字符、≤20 条、**ID 唯一**。
  - `sanitizeCloudWhitelist`：主机名合法、`pausedUntil` 值是有限正整数。
  - `sanitizeCloudSettings`：白名单键、`rulesets` 只接受布尔、`subscriptionInterval` 0..168。

---

## 4. 环境事实（全部实测，别凭记忆改）

### 4.1 Chrome 扩展的浏览器内验证

- 品牌版 Chrome **137+ 已移除 `--load-extension`**（官方 2025-06 公告：「移除 --load-extension 标记」）。
- `--disable-features=DisableLoadExtensionCommandLineSwitch`（社区常用的绕过）在 **Chrome 156 上已无效**。试过 ASCII 路径、`--headless=new`、离屏窗口三种组合，`chrome://extensions-internals` 里都查不到扩展。
- **可行替代：CDP 的 `Extensions.loadUnpacked`**。

```js
// 连浏览器级 WebSocket（不是页面级）
const v = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json();
const browser = await connect(v.webSocketDebuggerUrl);
const { id } = await browser.send("Extensions.loadUnpacked", { path: EXT_DIR });
// 再用 Target.createTarget 开扩展页
await browser.send("Target.createTarget", { url: "chrome-extension://" + id + "/src/options.html" });
```

启动参数：

```
--no-first-run --no-default-browser-check
--remote-allow-origins=* --remote-debugging-port=<port>
--user-data-dir=<临时 profile>
--window-position=-32000,-32000     # 离屏，不打扰用户
```

**配套坑：**
- 求值一律放在**扩展页**里做，不要在 Service Worker 目标里求值 —— SW 会休眠，`Runtime.evaluate` 会一直挂着不返回。
- 判定「请求被拦没被拦」用 **CDP Network 事件**（`Network.loadingFailed` 的 `errorText` 含 `BLOCKED`；`Network.responseReceived` 200），**不要读 DOM** —— Chrome 的错误页 body 取 `innerText` 常拿到空串。
- 扩展 ID = 公钥 SPKI DER 的 SHA-256 前 16 字节，十六进制位映射到 `a-p`。
  - CRX 身份（由签名私钥决定，私钥现在在 `D:\AdShield-Keys\adblocker.pem`，见 §7.2）：`gbkfkgfigndbbbdaiffebegiiddoikin`
  - 未打包加载（按目录路径算）：`enkhcjphkpfbdmkdamjcipommamllbmg`
  - 这两个不是同一个扩展，别混。

### 4.2 DNR 常量（Chrome 156 实测）

`getAvailableConstants()` 这个 API **在 156 上不存在**。常量是 `chrome.declarativeNetRequest` 对象上的静态属性：

```js
chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES              // 30000
chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES  // 5000
chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES       // 5000
chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES                // 1000
chrome.declarativeNetRequest.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS    // 50
chrome.declarativeNetRequest.MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL    // 20
chrome.declarativeNetRequest.GETMATCHEDRULES_QUOTA_INTERVAL           // 10（分钟）
```

**动态规则总数实测：30000 条接受，30156 条被拒**，报错 `Dynamic rule count exceeded.`。
另测：8000 条路径形规则（`urlFilter`）+ 8000 条域名放行规则（`allow`）共 16000 条，全部装下 → **5000 条的「不安全规则池」不约束本扩展的规则形状**（因为有 `<all_urls>` 主机权限）。

### 4.3 getMatchedRules 的能力边界

- 官方文档：此方法适用于持 `declarativeNetRequestFeedback` 权限的扩展，或对 filter 里 tabId 有 `activeTab` 权限的扩展。**正式安装版可用**（只有 `onRuleMatchedDebug` 是未打包专属）。
- 返回 `{ rulesMatchedInfo: [{ rule: { ruleId, rulesetId }, tabId, timeStamp }] }`。
- **没有 URL、没有分类**。所以正式版只能给「累计拦截 / 访问过的站点 / 各类型占比」，给不出「拦截的域名」和趋势图。设置页和弹窗的提示条已经按这个事实写。

### 4.4 Windows / PowerShell

- 本机执行策略是 **Restricted**（所有作用域 Undefined）。跑 `.ps1` 要用单次进程级绕过：
  ```
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\AdShield 广告拦截器\pack.ps1" 2.9.96 -ExpectedId gbkfkgfigndbbbdaiffebegiiddoikin
  ```
  不改系统设置。**不要**用 `Set-ExecutionPolicy` 持久改。
- PowerShell 5.1 读 UTF-8 无 BOM 文件会按 ANSI 解码 → 中文变乱码。脚本文件（尤其 `.ps1`）里的注释**只写 ASCII**。其它文件（`.json`/`.md`/`.gitignore`）用 UTF-8 无 BOM 写。
- `Add-Content -Encoding UTF8` 在 PS 5.1 会插 BOM，追加中文注释时先确认字节。

### 4.5 打包

```
pack.ps1 <版本号> [-ExpectedId <扩展ID>]
```

- 版本号会**自动写进 manifest.json**，跑完记得把 manifest.json 同步进 git 仓库。
- 打包前会检查源目录、Chrome、签名私钥，缺一不可。
- 私钥找不到就**拒绝打包**（不打包会导致扩展 ID 变化，已装用户收不到更新）。
- 私钥仍留在项目目录里时，每次打包会打 warning。
- 会打印 CRX 里内嵌的扩展 ID，可与 `-ExpectedId` 比对。
- `_metadata/`（Chrome 生成）会在打包时移开、打完还原。

---

## 5. 已知坑（踩过的，别再踩）

来自 `.learnings/LEARNINGS.md`（前八条）+ 本轮新增：

| # | 坑 | 结论 |
|---|---|---|
| 1 | Chrome API 的数值上限不能凭记忆写 | 要么附 `getAvailableConstants()` / 常量属性的实测输出，要么写「以实测为准」 |
| 2 | `regexFilter` 是**全串匹配**（须匹配整个 URL），`urlFilter` 才是子串匹配 | 非锚定的正则 = 静默 0 命中，但规则集照样编译成功。写 `^.*[?&]utm_source=.*$` |
| 3 | 注入类代码先看**跑在哪个 world** | manifest 没有 `world: "MAIN"` 就是隔离世界，页面脚本看不见。全局变量伪装必须在 MAIN world |
| 4 | `onRuleMatchedDebug` **只在未打包扩展**里触发 | 正式安装版统计要走 `getMatchedRules()`，两者数据粒度不同 |
| 5 | 前端里的 `sb_publishable_*` 是公开设计 | 别报成「密钥泄露」。要查的是「服务端授权是否可证明 + 返回数据是否被当指令执行」 |
| 6 | 工作区目录 ≠ 项目全貌 | 扫父目录同级 + Desktop/Documents/Downloads 找同名项目和 `.git`，搜 `*.pem` / `*.key` / `.env` |
| 7 | 审查报告要**按现象写**，不要术语堆砌 | 每个术语后面跟一句「你会看到什么现象」。一次最多讲 3 件事，其余等用户要 |
| 8 | UI 自动化选控件优先用 **ID 字段**，同名控件用 id 区分 | 「我重载了扩展」要有内容级指纹（行号/版本号/新日志）证明新代码真的生效 |
| 9 | 打包产物会**落后于源码** | 2.9.93 的 zip 打于 10-31 16:58，最后一轮修复在 11-01 07:46 —— 11 个文件对不上。每次改完重打 + 逐字节校验 |
| 10 | 服务端返回的正文**不能进 innerHTML** | 扩展页被注入 `<form>` 就能骗用户输密码。正文一律 `textContent` |
| 11 | 云端/备份数据是**外部输入** | 元素隐藏选择器会被原样拼进 CSS（`sel + "{display:none !important;}"`）。含 `{ } @ /*` 的能突破规则块。`<` `>` 是合法选择器，别误杀 |
| 12 | DNR 动态规则是**共享池子** | 订阅、用户自定义、站点放行共用一个上限，不是各自独立 |
| 13 | MV3 的 SW 会**频繁挂起** | 跨重启要保留的状态（水位线之类）必须存 storage，不能用模块级变量 |
| 14 | 仓库目录 `D:\temp-adshield-repo` 和工作区要**手工同步** | 改完忘了同步 = 发出去的包和 git 历史不一致。打包前先跑一次全量哈希比对 |
| 15 | 打包时把 `_metadata` 移到**源码目录之外** | 旧脚本把它改名成 `_metadata.bak-<时间戳>` 留在 `adblocker/` 里，Chrome 打包时连带收进 CRX：2.9.95 的 crx 有 46 个条目（15 个是垃圾），zip 却只有干净的 31 个。发布前必须分别验 zip 和 crx 载荷 |
| 16 | **删掉一条数据通路前，先查还有谁在用它的文案** | 2.9.96 删掉正式版的 `pollMatchedRules` 轮询后，正式版设置页的「累计拦截 / 访问过的站点 / 各类型占比」全成 0，**但 `options.html` 的提示文案还写着「可用」**。修法：要么给新通路补回写，要么改文案说清限制。**两者都要做**——文案是用户唯一的真相来源 |
| 17 | **设置页拿不到 `activeTab`** | Chrome 只在用户**调用**扩展时（点图标 / 右键菜单 / 快捷键）授予 activeTab。扩展页面自己打开时没有这个授权，所以设置页**不能**自己查 `getMatchedRules({tabId})`。只能靠弹窗查到后回写共享缓冲 |
| 18 | **`getMatchedRules` 返回的是累计值，回写要用 max 不是加法** | 同一个 tab 查两次拿到同一批数据，累加会让数字翻倍（实测 1 条 → 显示 2 条）。用 `Math.max` 天然去重 |
| 19 | **`getAvailableConstants()` 在 Chrome 156 上不存在** | 常量是 `chrome.declarativeNetRequest` 对象上的静态属性（`MAX_NUMBER_OF_DYNAMIC_RULES` 等）。取常量要两种形态都试 |
| 20 | **别用 `--load-extension`** | Chrome 137+ 官方品牌版已移除，`--disable-features=DisableLoadExtensionCommandLineSwitch` 在 142+ 也失效。改用 `--remote-debugging-pipe` + CDP `Extensions.loadUnpacked`。**pipe 方向是 Node 写 fd3、Chrome 从 fd4 读回**（与直觉相反），写反了表现为「SIGTERM + 零输出」这种没有线索的失败 |
| 21 | **CDP target 列表里的 `chrome-extension://` 可能是内置组件扩展** | 扩展没加载成功时，`Target.getTargets` 里仍能看到内置组件扩展的 `chrome-extension://` target，误判成「扩展加载成功」。真判据是**你自己的扩展 ID** 的 service worker 出现，且扩展页能正常打开（不是 `chrome-error://`） |
| 22 | **从模块解构时漏一个名字 = 运行时 ReferenceError** | 真实发生过：`background.js` 用了 `isPausedUntil` 但解构时漏了 → badge 计数完全不显示；`auth.js` 用了 `RULE_CTRL_CHARS` 但没导入 → 导入备份必崩。**语法检查查不出来**（语法完全合法）。`npm run check` 现在会静态比对「用到的名字」与「解构进来的名字」，缺一个就报错 |
| 23 | **池满时「只删不加」会清空用户已有规则** | `updateDynamicRules` 是「先按 removeRuleIds 删、再按 addRules 加」的原子操作。预算截断后如果 `addRules` 变成空还照常下发，等于只删不加 —— 用户什么都没做错（只是订阅太多占满池子），自定义规则却被整段清空。**截断后为空必须直接 return 不下发**（订阅路径原本就有这个保护，用户规则路径漏了） |
| 24 | **云端 `rulesets: {}` 会把本地开关全清掉** | `getSettings` 的默认值合并是 `Object.assign({}, DEFAULT, s.rulesets || {})`，**空对象不是 falsy**，默认值补不回来。云端一行 `rulesets:{}` 就能让用户本地的 5 个规则集开关全变 undefined。校验器要把空映射表判为「未提供有效值」，保留本地 |

---

## 6. 验证方法（可复现）

### 6.1 基础（一条命令）

```bash
npm run verify     # = check + test，必须全绿
npm run probe      # 运行时诊断 + 端到端自检
```

`npm run verify` 跑的是：

| 脚本 | 覆盖什么 | 项数 |
|---|---|---|
| `tools/check.mjs` | regexFilter 锚定 / 规则 id 区间 / DOM 契约 / 单一真源 / logger 页 modal.js 依赖 | 静态校验 |
| `tools/test-host.mjs` | host 归一化与三层判定一致性 | 27 |
| `tools/test-rules.mjs` | 用户规则段位上限 / 订阅全局预算 / **池满时不下发** | 19 |
| `tools/test-validate.mjs` | 云端数据净化与校验（安全边界） | 103 |

**语法检查**（`node --check` 逐文件）：

```
Get-ChildItem D:\AdShield 广告拦截器\adblocker\src -Recurse -Filter *.js |
  ForEach-Object { node --check $_.FullName }
```

### 6.1b 自动化测试的覆盖边界

`npm run verify` 是**逻辑层**验证，**不覆盖**以下行为 —— 它们只能靠真机（§6.2）：

| 未覆盖 | 为什么 | 怎么验 |
|---|---|---|
| DNR 规则实际拦截请求 | 需要真实网络请求 | §6.2 场景 1 / `npm run probe` 的端到端自检 |
| 元素隐藏 CSS 是否生效 | 需要真实页面 DOM | 打开含广告的页面，看元素是否被隐藏 |
| 订阅拉取与解析 | 需要外网 | 设置页 → 订阅 → 立即更新 |
| 账号登录注册 | 需要 Supabase 服务端 | 真机操作 |
| 弹窗交互（ESC / 遮罩 / 多层） | 需要真实事件 | 真机点 |
| 打包产物是否正确 | 需要跑 pack.ps1 | §6.3 |

**新增代码时的规矩**：能写成纯函数的，就放进 `shared/validate.js` 之类的地方并加单元测试；
只能靠真机验的，在 §6.2 补一个场景。

### 6.2 真机（CDP harness）

见 §4.1 的加载方式。三个必测场景：

1. **全局暂停真的停用动态规则**
   - 本地起 HTTP 服务 + 装一条会拦掉它的动态规则（模拟订阅规则）
   - 未暂停 → 请求被拦（Network `loadingFailed` 含 BLOCKED）
   - 全局暂停 → 请求放行（`responseReceived` 200）
   - 恢复 → 又被拦
2. **选择器收窄没有误杀**
   - 博客文章页（正文含「请关闭广告拦截」）：旧选择器会误判，新选择器不判
   - 真反拦截弹窗：两种选择器都要能抓到
3. **UI 没坏**
   - 打开 options.html → 切到「拦截统计」→ 截图，确认提示条可见、元素数与改前一致

### 6.3 打包产物校验

```
# zip 内每个文件与工作区逐字节比对
```

脚本思路：读 zip 的 entry 流 → SHA256 → 和源文件 SHA256 比。**这一步不能省**，见坑 #9。

实测过的一条（注意 zip 是扁平到扩展根的，比对基准要带上 `adblocker/`）：

```bash
cd /tmp && rm -rf zx && mkdir zx && cd zx
unzip -q "D:/AdShield 广告拦截器/adblocker-v2.9.96.zip"
find . -type f | sed 's|^\./||' | while read f; do
  a=$(md5sum "$f" | cut -d' ' -f1)
  b=$(md5sum "D:/AdShield 广告拦截器/adblocker/$f" | cut -d' ' -f1)
  [ "$a" = "$b" ] || echo "DIFF $f"
done
```

CRX 也要单独验，**它的载荷不是从文件尾读长度得到的**：CRX3 布局是
`"Cr24"(4) + version(4) + headerLength(4) + header + zip`，zip 从第 `12 + headerLength` 字节开始一直到文件尾，
中间**没有** zip 长度字段（把 `headerLength` 后面 4 字节当长度读会得出几十 MB 的假数值）。

```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path');
const b=fs.readFileSync('D:/AdShield 广告拦截器/adblocker-v2.9.96.crx');
const hl=b.readUInt32LE(8);
fs.writeFileSync(p.join(os.tmpdir(),'crx-payload.zip'), b.slice(12+hl));"
```

2026-11-01 实测（2.9.96）：ZIP 与 CRX 载荷都是 **31 个文件、与工作区逐字节一致、无 `_metadata` 残留**，
CRX 内嵌扩展 ID `gbkfkgfigndbbbdaiffebegiiddoikin` 与签名私钥一致。

### 6.4 两个目录全量比对（可复现）

```bash
cd "D:/AdShield 广告拦截器/adblocker"
find . -type f \( -name "*.js" -o -name "*.json" -o -name "*.css" -o -name "*.html" -o -name "*.png" \) | sed 's|^\./||' | while read f; do
  a=$(md5sum "$f" | cut -d' ' -f1)
  b=$(md5sum "D:/temp-adshield-repo/adblocker/$f" 2>/dev/null | cut -d' ' -f1)
  [ "$a" = "$b" ] || echo "DIFF $f"
done
```

2026-11-01 结果：31/31 一致（本轮之前 auth.js 差一份，已补）。

### 6.5 第三轮修复的真机验证（22 项全过）

除了 `tools/verify-extension.js` 的那 6 项，另有一轮同思路的 CDP 验证已入库，可直接跑：

```
node D:\temp-adshield-repo\tools\verify-round3-fixes.js
```

（离屏临时 profile + `Extensions.loadUnpacked`，不碰用户正在用的 Chrome；2026-11-01 实测 22 项全过）覆盖本轮改动的行为：

- 订阅更新间隔选 6 / 选「关闭」都落盘，重开设置页回显正确（**0 不再被当成 24**）
- 含 `>` 的自定义规则保存后 `applied=1 / cosmetic=1`，选择器原样保留，动态规则确实装上，状态栏显示结果而不是空白
- 备份 JSON / 元素隐藏 TXT / 统计 JSON 三个导出按钮都真的触发下载并给出提示文案
- 同时打开两个确认框是两层独立 DOM，关掉上层不会改写下层，关完不残留
- **阳性对照**：真实拦截让 `total +1`；参数清理让 `url_clean` 分类 +1 而 `total` 不变（先证明计数通道有效，再证明清理不计数）
- 取消勾选「白名单」后 `readSyncPrefs()` 返回 `whitelist:false`，其余三项默认 true

两个坑：

- Chrome 156 不把 blob 下载写进 `Browser.setDownloadBehavior` 指定的目录，**断言要放在 `Browser.downloadWillBegin` 事件 + 页面文案上**，查磁盘会假失败。
- `setDownloadBehavior` 必须设在**浏览器会话**上；设在页面会话上会被静默忽略。

### 6.6 上线门禁（12 项，逐项过）

发布前逐项确认。**任何一项没过就不发。**

| # | 检查项 | 怎么验 | 不过的典型原因 |
|---|---|---|---|
| 1 | 静态校验 + 149 项测试全绿 | `npm run verify` | 有新写的代码没加测试 |
| 2 | 端到端自检三项全绿 | `npm run probe` | 规则集没编译 / content script 没注入 |
| 3 | 动态规则占用率 < 90% | `npm run probe` 的「当前规则占用」 | 订阅太多，该停用几个 |
| 4 | 全局暂停真的停用动态规则 | 真机：装一条会拦请求的动态规则 → 暂停 → 请求放行 → 恢复 → 又被拦 | 只关了静态规则集，动态规则照拦 |
| 5 | 站点暂停对该站整站生效 | 真机：暂停后主框架与子框架资源都放行 | `allowAllRequests` 的 resourceTypes 没覆盖子框架 |
| 6 | 元素隐藏在真实站点生效 | 打开含广告的页面，看元素是否被隐藏 | content script 没注入 / 选择器过期 |
| 7 | URL 参数清理生效且**不计入拦截总数** | 访问带 `?utm_source=` 的 URL | 清理被算成拦截，圆环与中心数对不上 |
| 8 | 设置页统计在正式安装版有数 | 装 CRX → 点一次扩展图标 → 回设置页看「拦截统计」 | 弹窗没回写统计缓冲（坑 #17） |
| 9 | 云端脏数据被拒且本地不被清空 | 造一条含非法 `rulesets` / 超长规则 / 越界订阅的云端行 → 同步 | 校验器放行了非法值（坑 #22） |
| 10 | 动态规则池满时**用户规则不被清空** | 塞满订阅 → 保存自定义规则 → 确认旧规则还在 | 只删不加（坑 #23） |
| 11 | ZIP 与 CRX 载荷都干净且与工作区逐字节一致 | §6.3 | `_metadata` 备份混进包（坑 #15） |
| 12 | 两个目录逐字节一致 | §6.4 / `node tools/sync-repo.mjs` | 改完忘了同步（坑 #14） |

**发布前额外确认**（远端文档 §8 第 10/13 条）：
- [ ] `git push` 前确认远端内容与预期一致
- [ ] 版本号 +1，且 `manifest.json` 的 version 与发布说明一致
- [ ] 签名私钥仍在项目目录外（`D://AdShield-Keys//adblocker.pem`）

### 6.7 改动手册（我要做 X，先动哪里）

| 我要做的事 | 改哪些文件 | 同步要改的地方 | 怎么验 |
|---|---|---|---|
| **新增一个静态规则集** | ① `adblocker/rules/xxx.json`<br>② `adblocker/manifest.json` 的 `declarative_net_request.rule_resources`<br>③ `background.js` 的 `STATIC_RULE_SETS` 加区间<br>④ `background.js` 的 `ALL_RULESETS` 加 id<br>⑤ `shared/config.js` 的 `RULESETS` 加显示项 | ④ 的 `ALL_RULESETS` 决定「规则集同步」时启用哪个；漏了 → 开关不生效 | `npm run check`（校验 id 落在区间内）+ `npm run probe` |
| **新增一条 background 消息** | ① `shared/config.js` 的 `MSG` 加常量<br>② `background.js` 的 `handleOtherMessage` 加分支<br>③ 调用方 | `MSG` 加了但分支没加 → 消息永远无响应 | `npm run check`（校验 MSG 解构）+ 真机收发一次 |
| **新增一个设置开关** | ① `shared/config.js` 的 `DEFAULT_SETTINGS`<br>② `options.html` 加控件<br>③ `options.js` 加读写（`render()` 渲染 + 事件处理） | 开关存 `adshield_settings`，**只有 background 能写**（见 AGENTS.md 单一写入者表） | `npm run verify` + 手动开关一次看是否落盘 |
| **新增一个规则集开关项** | ① `shared/config.js` 的 `RULESETS`<br>② `options.html` 的开关控件<br>③ `background.js` 的 `ALL_RULESETS` | `ALL_RULESETS` 漏了 → 开关勾了但规则集不同步 | 手动开关后看 `chrome://extensions` 或诊断页的已启用规则集 |
| **新增一个 DNR 规则段位** | ① `background.js` 顶部加 `XXX_RULE_BASE` 常量<br>② 段位表（AGENTS.md）加一行 | 段位**不能与现有重叠**：用户 100000~ / 站点 200000~ / 订阅 300000~ / 全局放行 2000000 | `npm run probe` 看「分段明细」是否落在预期段 |
| **改订阅源的解析规则** | `background.js` 的 `parseSubscriptionText` | 解析结果为 0 时**必须不下发**（否则会清空该订阅原有规则）；这条保护在 `applySubscriptionText` 里，别删 | 拿真实订阅源试；解析为 0 时应报「未解析出任何可用规则」而不是「更新成功 0 条」 |
| **改云端数据校验** | `shared/validate.js` | 改完必须跑 `tools/test-validate.mjs`；这批函数是云端数据进本地的**唯一防线** | `npm test`（103 项） |
| **新增一个界面** | ① 新建 `xxx.html/js/css`<br>② `manifest.json` 无需改（扩展页不用注册）<br>③ 入口按钮所在页面 | 扩展页要在 `<head>` 里按序引 `shared/theme.js` → `shared/dom.js` → `shared/config.js` → `shared/modal.js` | `npm run check` 的 DOM 契约项 |
| **加一条用户自定义规则语法** | `background.js` 的 `parseRuleLine` | 语法要同时被 `applyUserRules`（下发）和 `parseSubscriptionText`（订阅）理解，否则两条路径行为不一致 | 手动加一条规则，看 `adshield_user_rules_result` 的 applied/skipped |

### 6.8 模块职责边界（别越界改）

| 文件 | 负责 | 不负责 |
|---|---|---|
| `background.js` | DNR 规则的增删改查、订阅拉取与解析、统计聚合、消息分发、全局/站点放行 | UI 渲染、DOM 操作 |
| `shared/validate.js` | 云端数据的白名单校验与净化（纯函数） | 任何 `chrome.*` 调用、任何 DOM 操作 |
| `shared/host.js` | host 归一化与匹配语义 | 其它任何工具 |
| `shared/config.js` | 默认设置、规则集显示定义、消息类型常量 | 业务逻辑 |
| `shared/dom.js` | HTML 转义、文件下载 | 业务逻辑 |
| `shared/modal.js` | 弹窗基座与栈管理 | 业务逻辑 |
| `shared/auth.js` | 账号、云同步、设备管理、备份导入导出 | DNR 规则（那在 background） |
| `content/cosmetic.js` | 元素隐藏（CSS 注入）、浏览助手的 DOM 检测 | 伪装全局变量（在 MAIN world） |
| `content/anti-detect-main.js` | MAIN world 的全局变量伪装与真实检测 | 任何 `chrome.*` 调用（MAIN world 没有） |
| `content/picker.js` | 元素拾取器 | 规则存储（交给 background） |
| `options.js` | 设置页交互 | 写 `adshield_settings`（交给 background） |
| `popup.js` | 工具栏弹窗 | 同上 |
| `logger.js` | 日志页渲染 | 同上 |

### 6.9 高风险改动区（改错了会怎样）

**A. 会导致用户数据丢失的地方**

| 位置 | 风险 | 现在的防线 | 防线强度 |
|---|---|---|---|
| `auth.js` 的 `applyCloudData` | 云端行整块覆盖本地设置 | 4 个 `sanitizeCloud*` 白名单校验 + 「全非法则保留本地」兜底 | 中 |
| `auth.js` 的 `importAllData` | 备份导入覆盖本地配置 | 导入前校验 + `skipped` 计数 | 中 |
| `background.js` 的 `applyUserRules` | 池满时下发空 `addRules` → **用户已有规则被整段清空** | 截断到空时**直接 return 不下发**（`err.code = "POOL_FULL"`） | 中 |
| `validate.js` 的 `sanitizeCloudSettings` | 云端 `rulesets: {}` 把本地开关全清掉 | 空映射表判为「未提供」，保留本地 | 中 |
| `options.js` 的元素隐藏规则删除 | 页面自己 `storage.set` + 发消息 → 两个写入者竞争 | 已改为**只发消息**，由 background 统一写 | 强 |

**B. 会影响 DNR 规则 ID 分配的地方**

- 四个段位常量（`USER_RULE_BASE` / `SITE_RULE_BASE` / `SUB_RULE_BASE` / `GLOBAL_ALLOW_RULE_ID`）——**一改全错**，见 §3.2 的表
- 静态规则的 ruleId → 分类映射（`STATIC_RULE_SETS`）—— 改了 JSON 不同步这张表，分类统计会**静默错归类**
- `updateDynamicRules` 的提交方式 —— 单次调用里同一 ID 同时出现在 remove 和 add 是「替换」语义（2026-11-01 实测），但 `syncGlobalPauseRule` 仍保持两次调用

**C. 有并发 / 时序陷阱的地方**

| 陷阱 | 说明 |
|---|---|
| 订阅更新队列 | 订阅操作串行化，防 `updateDynamicRules` 并发写冲突 |
| 30 秒拉取窗口内的用户改动被抹掉 | `updateAllSubscriptions` 拉取期间用户改了规则，合并时以**拉取后**的 `fresh` 为准 |
| Service Worker 挂起 vs `setTimeout` | SW 空闲即挂起，`setTimeout` 不可靠；跨重启要保留的状态必须存 storage |
| 内存缓冲 vs 落盘 | `__statsBuffer` 实时但会丢，storage 持久但有延迟；清空类操作**必须同时清两边** |
| 弹窗 2 秒轮询 vs 60 秒限流 | `getMatchedRules` 配额 20 次/10 分钟，弹窗轮询必须限流 |
| `storage.onChanged` 的级联 | 写 storage → 触发监听 → 又写 storage；注意防抖与自触发 |
| 定时器重建 | `chrome.alarms.create` 同名会整体替换并推后下次触发 |

**D. 「看起来能跑其实不生效」的陷阱**

| 陷阱 | 说明 |
|---|---|
| `regexFilter` 未锚定 | 全串匹配，非锚定 = 静默 0 命中，但规则集照样编译成功（见坑 #2） |
| `onRuleMatchedDebug` 只在未打包扩展触发 | 正式版要用 `getMatchedRules({tabId})` + activeTab（见坑 #17） |
| 分类判定：静态 ruleId 优先 | 多个规则集 priority 相同时，Chrome 可能先命中 ads，导致 tracking 永不被选中 |
| `url_clean` 不计入拦截总数 | 它是重定向不是拦截；计进去会让圆环与中心数对不上 |
| **`MSG` 用了但没解构** | 运行时 ReferenceError，**语法检查查不出来**（见坑 #22） |
| host 归一化的单一真源 | 自己写一份就会出现「请求已放行但元素仍被隐藏」（见坑 #17、AGENTS.md） |
| **`updateBadgeForTab` 的 catch 会吞掉任何异常** | `catch (e) { /* tab 已关闭 */ }` —— 里面其实什么也没做，但因为异常被吞，**漏解构会静默表现为「badge 不显示数字」而不是报错**。这是坑 #22 那个 bug 长期没被发现的原因 |

### 6.10 已修复但防线脆弱的缺陷（怎么判断防线还在不在）

这一节记录「已经踩过、已经修好、但防线很脆」的坑。
**重点不是历史，是：这些防线现在长什么样、你能怎么判断它还在不在。**

| # | 曾经的缺陷 | 现在的防线 | 强度 |
|---|---|---|---|
| 1 | `isPausedUntil` 未解构 → badge 永远不显示数字 | 已解构 | 弱：靠 `updateBadgeForTab` 的 catch 静默；`npm run check` 现在会校验解构完整性 |
| 2 | `RULE_CTRL_CHARS` 未导出 → 导入备份必崩 | 已加进导出与解构清单 | 中：两份清单手写，`check.mjs` 现在校验配对 |
| 3 | 池满时下发空 `addRules` → 清空用户规则 | 截断到空直接 return | 中：`test-rules.mjs` 是**逻辑复刻**，复刻里没有「先删后加」的原子语义 |
| 4 | 云端 `rulesets: {}` 覆盖本地开关 | 空映射表不写入 | 中 |
| 5 | 元素隐藏规则两个写入者竞争 | 只发消息，background 统一写 | 强：`check.mjs` 校验单一写入者 |

**手动确认这几条防线还在不在**：

```bash
grep -n "adshieldHost" adblocker/src/background.js | head -1        # 1
grep -n "RULE_CTRL_CHARS" adblocker/src/shared/validate.js adblocker/src/shared/auth.js  # 2
grep -n "POOL_FULL" adblocker/src/background.js                      # 3
grep -n "Object.keys(clean).length" adblocker/src/shared/validate.js # 4
grep -n "adshield_user_cosmetic" adblocker/src/options.js            # 5 应只有读、没有 set
```

### 6.11 自动化校验的能力边界

**`npm run check` 覆盖**：regexFilter 锚定 / 静态规则 id 区间 / DOM 契约 / 单一真源 /
storage 键单一写入者 / **共享模块解构完整性** / logger 页 modal.js 依赖。

**`npm test` 覆盖**：host 归一化与三层判定（27）/ 规则段位与预算（19）/ 云端数据净化（103）。

**不覆盖的（改动时要格外小心）**：
- ❌ `probe.js` 的 DOM 契约（不在 `check.mjs` 的 `PAGES` 列表里）
- ❌ `content/*.js` 的任何检查
- ❌ `rules/*.json` 的**区间重叠**检查
- ❌ 订阅 ID 撞号的端到端验证
- ❌ `applyUserRules` / `applySubscriptionText` 的规则 id 是否越段
- ❌ `MSG` 常量的**值**与实际调用是否一致（改名就会断）
- ❌ `updateDynamicRules` 的「先删后加」原子语义 —— **单元测试复刻不了这个**，只能真机验

---

## 7. 未完成 / 待办

### 7.1 ✅ 已完成（2026-11-01，commit `02b0f92`）

`adblocker/src/shared/auth.js` 的四处修复（设备删除越权 / 服务端错误注入 / 云端 CSS 注入面 / 订阅 ID 去重）已同步进 git 仓库，两个目录现在逐字节一致（见 §6.4）。

当时同步的做法：

```bash
cp "D:/AdShield 广告拦截器/adblocker/src/shared/auth.js" "D:/temp-adshield-repo/adblocker/src/shared/auth.js"
cd D:/temp-adshield-repo && git add adblocker/src/shared/auth.js && git commit
```

**没有 push**，按 §8 第 10 条等确认。

### 7.2 ✅ 已完成（2026-11-01）：签名私钥已移出项目目录

私钥现在只在 `D:\AdShield-Keys\adblocker.pem`，项目内的 `.keys\adblocker.pem` 已删除（`.keys` 里只剩公钥 `derived-public.pem` 和一个 ACL 备份，都可以外发）。

- 删除前先做了 SHA256 比对，两边一致：`4AE4746E…4237AA95` —— 同一把钥匙，**扩展 ID 不变**，已装用户照常收更新。
- 权限照搬原来的收紧状态：`SYSTEM:(F)`、`Administrators:(F)`、`YUNGUI-PC\39007:(R)`，无继承。
- `pack.ps1` 的查找顺序是 `$env:ADSHIELD_KEY` → `D:\AdShield-Keys\adblocker.pem` → 项目内 `.keys\`，所以不用改脚本，也不会再打「私钥仍在项目目录」的 warning。

踩到的两个坑：

- `.ps1` 里**不要写中文路径字面量**（PS 5.1 按 ANSI 解码 UTF-8 无 BOM 会乱码），用 `$PSScriptRoot` 派生。
- 收紧过的文件用 `Remove-Item -Force` 会报「访问被拒绝」；先 `icacls <file> /grant "<user>:(D)"`，再用 `[System.IO.File]::Delete()` 才能删掉。

### 7.2b ✅ 已完成（2026-11-01）：共享模块化 + 测试体系 + 运行时诊断

第二轮（2.9.97）做了四件事，详见 `REVIEW-2026-11-01.md`：

1. **抽出 4 个共享模块**（各自单一真源）：`shared/host.js`（host 归一化）、
   `shared/dom.js`（转义 + 下载）、`shared/config.js`（默认设置 + 消息协议）、
   `shared/validate.js`（云端数据校验纯函数）。消除了 5 份 `escapeHtml`、
   3 份漂移的 `DEFAULT_SETTINGS`、2 份 `sendMessage`。
2. **auth.js 的 6 处手写弹窗收敛到 `shared/modal.js` 的 `showFormDialog` 基座**，
   auth.js 从 2782 行降到 2467 行，且弹窗行为与 `showConfirm` 统一。
3. **测试从 0 增至 149 项**：`npm run verify` = 静态校验 + 27 + 19 + 103。
4. **运行时诊断工具**：`npm run probe` 自启 Chrome + CDP 采集，零人工操作。

### 7.3 i18n（最大的未开工项）

- 现状：`grep chrome.i18n` 全项目 **0 处**。`_locales/en/messages.json` 只有 extensionName / extensionDescription 两个键。英文浏览器用户看到的仍是中文界面。
- 规模：options 195 + options.js 427 + popup 27 + popup.js 143 + logger 20 + logger.js 26 + auth.js 605 ≈ **860 条唯一中文串**（约 1400 处出现）。
- 建议路径（分两次做，别一次铺开）：
  1. 先 popup + logger（216 条）跑通链路：新建 `src/shared/i18n.js` 暴露 `window.t(key, fallback)` + DOMContentLoaded 时按 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label` 替换；HTML 里保留中文原文当 fallback；`_locales/zh_CN/messages.json` 存中文、`_locales/en/messages.json` 存英文，两边 key 集合必须完全一致。
  2. 再 options + auth。
- **不要翻译**：console 输出、注释、用于逻辑比较的字符串（reason 代码 / mode 值 / 分类 id）、用户自己的数据（规则文本、域名、URL、设备名、邮箱）。
- **中文界面必须逐字不变**（除了新增的 data-i18n 属性）。

### 7.4 RLS 策略需要真的去 Supabase 执行

`docs/supabase-rls.sql` 已入仓，但**还没在 Supabase 项目里跑过**。隐私政策对外承诺了「每个账号只能读写自己那一行，匿名请求读到的结果为空」——这条承诺目前只有策略文件，没有生效证据。跑完按文件末尾的验证步骤核对。

### 7.5 已知但未修（优先级低）

| 问题 | 位置 | 说明 |
|---|---|---|
| `getSettings()` 里 `s.pausedUntil = s.pausedUntil || {}` 会指向 `DEFAULT_SETTINGS.pausedUntil` 同一个对象 | `background.js` getSettings | 存储里没有 pausedUntil 时，删除操作会污染模块级默认值。**逻辑推演，未实测**，影响很小 |
| 订阅路径规则只取前 800 条 | `background.js` applySubscriptionText | EasyList 这类大列表会被截断。当前是刻意设计（保持原序），但确实会丢规则 |
| 站点暂停用 `allowAllRequests` + `requestDomains` + `main_frame` | `background.js` syncSiteAllowlist | 子框架（iframe）里的资源不受该放行影响 |
| 正式版统计给不出「拦截的域名」和趋势图 | `getMatchedRules` 的能力边界 | 要 URL 明细只能靠未打包模式的调试事件 |

---

## 8. 动手前的规矩

1. **先取证再下结论。** 读代码、跑测试、看真实报错。别凭对项目的猜测改。
2. **报告分三层**：实测通过 / 逻辑推演 / 没验证。
3. **数字必须实测过才写进文档**，没验证的标「未验证」。
4. **搜索返回空 ≠ 不存在**，先拿已知样本证明通道有效。
5. **改完自己审查并实测**：语法检查 + 相关回归 + 能自动化的验证全跑。
6. **范围纪律**：只做要求的那一件事。修 bug 不顺手优化，不加「以后可能用得上」的功能，不清理无关代码。
7. **注释默认不写**，只在 WHY 不显然时写一行（隐藏约束、踩过的坑、反直觉的写法）。
8. **文档用中文，且必须与代码同步**；改了实现要顺手校正文档里的实测数字。
9. **不要回退已定的产品策略**：确认弹窗只在不可逆操作时出现；主按钮保持官方橙 `#D97757`；不加常驻应用菜单栏；输入框不画分隔线；设置面板保留让位挤压。
10. **破坏性 git 操作、push、发布先确认。**
11. **看到不是自己起的进程别杀**，先查命令行确认归属。
12. **改完同步两个目录**：工作区 → git 仓库，然后跑一次全量哈希比对确认一致。
13. **改完重新打包并逐字节校验**，然后提交。版本号 +1。

---

## 9. 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| **2.9.97**（待发布） | 2026-11-01 | 第二轮：抽出 4 个共享模块（host/dom/config/validate），auth.js 6 处手写弹窗收敛到 modal.js 基座；测试 0 → 149 项；新增运行时诊断工具（`npm run probe`，自启 Chrome + CDP，零人工）；修 3 个真实缺陷（`isPausedUntil` 与 `RULE_CTRL_CHARS` 解构漏项、池满时清空用户已有规则）；补 2 个 P1（云端空 `rulesets` 覆盖本地、正式版设置页统计无数据 + 弹窗回写统计缓冲）；`check.mjs` 增加「单一写入者」与「解构完整性」两项校验 |
| **2.9.96** | 2026-11-01 | **已发布为 GitHub Release**，一次覆盖 2.9.94 与 2.9.95 的内容：云同步不再吃掉含 `>` 的元素隐藏规则、订阅源解析失败不再清空旧规则、自动更新闹钟不再被重置、URL 清理不再计入拦截总数、账号过期与断网分开处理、请求全部带超时、设置页此前没接线的按钮和下拉补齐、弹窗改为独立分层；打包脚本修掉 CRX 混入 `_metadata` 备份的问题 |
| 2.9.95 | 2026-11-01 | 遗留批量修复：设备删除越权、服务端错误正文注入、云端/备份 CSS 注入面、订阅 ID 去重、规则上限改用实测常量、正式版统计接 `getMatchedRules`、`docs/supabase-rls.sql` 入仓 |
| 2.9.94 | 2026-11-01 | 全局暂停真正停用动态规则；浏览助手文案误判（选择器收窄 + 500 字上限）；设置页补统计可用性说明；`pack.ps1` 的示例扩展 ID 修正 |
| 2.9.93 | 2026-10-31 | 第三轮审查修复（反拦截 MAIN world、URL 清理正则锚定、云端校验器） |

git 仓库提交：
- `73e95eb` 遗留批量修复
- `de3bf72` 全局暂停 + 文案误判 + 统计说明
- `6b1982a` 第三轮审查修复
- `de1a68f` 本交接文档 + `tools/verify-extension.js`
- `02b0f92` 把只在工作区的 auth.js 四处修复补进 git 历史
- 本次：文档校正（行数、§6.3–6.5 验证方法、§7.1/7.2 完成）+ 私钥移出项目目录 + 2.9.96 发布

以上都已 push 到 `origin/main`（2026-11-01 推完，远端最新 `v2.9.96` 标签 + Release）。

---

## 10. 一句话给下一个 AI

规则系统有两套（静态规则集 / 共享池子的动态规则），id 段不能乱；Chrome 的 API 行为和数值上限**一律先实测再写进代码**；品牌版 Chrome 装不了未打包扩展，要用 CDP `Extensions.loadUnpacked`；打包产物和 git 仓库要手工同步并且逐字节校验；**从共享模块解构时漏一个名字就是运行时 ReferenceError，语法检查查不出来，跑 `npm run verify`**——这五条踩过坑，其余按 §8 的规矩来。
