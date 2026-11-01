# AdShield 广告拦截器 — AI 交接文档

> 面向下一个接手这个项目的 AI / 开发者。
> 文档里的每个数字都是 **2026-11-01 在 Chrome 156.0.8078.74 上实测出来的**，不是从记忆或旧文档抄的。
> 凡是「逻辑推演」「未实测」的地方都单独标了，不要当成事实继承。

---

## 1. 这是什么

- Chrome Manifest V3 扩展，广告拦截 + 元素隐藏 + URL 参数清理 + 反拦截检测 + 账号云同步。
- 独立开发者的单人项目，没有 CI、没有 review、没有测试框架。
- 当前版本 **2.9.95**（`adblocker/manifest.json`）。
- 两个目录，**必须分清**（见 §8）：

| 目录 | 角色 |
|---|---|
| `D:\AdShield 广告拦截器\` | 工作区。**打包源**（`pack.ps1` 从这里打 CRX/ZIP），代码实际编辑处 |
| `D:\temp-adshield-repo\` | git 仓库。README / PRIVACY / docs / 发布用的 git 历史在这里 |

两边内容必须保持一致。目前**仓库里少一个文件**（`adblocker/src/shared/auth.js`，见 §7.1）。

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
    background.js          1618 行。Service Worker：规则同步、订阅拉取、统计、消息处理
    popup.{html,css,js}   572 行 js。工具栏弹窗
    options.{html,css,js} 1746 行 js + 48KB html。设置页（6 个页签）
    logger.{html,css,js}  133 行。请求级明细日志
    content/
      cosmetic.js          388 行。元素隐藏引擎 + 浏览助手（反拦截检测）
      anti-detect.js       85 行。隔离世界部分：DOM 诱饵 + 与 MAIN world 握手
      anti-detect-main.js  81 行。**MAIN world**：全局变量伪装 + 真实检测
      picker.js            279 行。元素拾取器（自带一套模态框样式）
    shared/
      auth.js              2589 行。账号系统 + Supabase 云同步（**最大的单文件**）
      modal.js             120 行。自定义 showConfirm / showAlert
      theme.js / nav-init.js
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
| 数据源 | `chrome.declarativeNetRequest.onRuleMatchedDebug` | `chrome.declarativeNetRequest.getMatchedRules()` |
| 粒度 | 每条请求：URL、分类、时间线 | 每条命中：ruleId、tabId、timeStamp（**没有 URL**） |
| 触发 | 事件驱动 | 每分钟轮询一次（alarm `adshield-match-poll`） |
| 代码 | `background.js` 的 `onRuleMatchedDebug` 分支 | `background.js` 的 `pollMatchedRules()` |

正式版轮询的关键设计：
- **水位线存 storage**（`adshield_match_poll_ts`），不放内存 —— MV3 的 Service Worker 空闲就被挂起，内存变量一重启就丢，会漏算或重算。
- 按 `timeStamp > 水位线` 筛新增。Chrome 会丢掉「超过 5 分钟且没关联到文档」的旧条目，直接取总数会忽上忽下。
- `__statsLive` 为 true（说明调试事件真的来过）时跳过轮询，避免开发模式重复计数。

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
  - CRX 身份（由 `.keys/adblocker.pem` 决定）：`gbkfkgfigndbbbdaiffebegiiddoikin`
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
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\AdShield 广告拦截器\pack.ps1" 2.9.95 -ExpectedId gbkfkgfigndbbbdaiffebegiiddoikin
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

---

## 6. 验证方法（可复现）

### 6.1 基础

```
# 语法（全部 12 个 js）
Get-ChildItem D:\AdShield 广告拦截器\adblocker\src -Recurse -Filter *.js |
  ForEach-Object { node --check $_.FullName }
```

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

---

## 7. 未完成 / 待办

### 7.1 立刻要做的（一条命令）

`adblocker/src/shared/auth.js` 的四处修复（设备删除越权 / 服务端错误注入 / 云端 CSS 注入面 / 订阅 ID 去重）**在工作区里是对的，但没进 git 仓库**（写仓库目录被沙箱策略拦了）。2.9.95 的包里是含修复的，只有 git 历史差这一个文件：

```powershell
Copy-Item 'D:\AdShield 广告拦截器\adblocker\src\shared\auth.js' 'D:\temp-adshield-repo\adblocker\src\shared\auth.js' -Force
cd D:\temp-adshield-repo
git add adblocker/src/shared/auth.js
git commit -m "fix(auth): 设备删除越权/服务端错误注入/云端CSS注入面/订阅ID去重"
```

### 7.2 签名私钥外移（一条命令 + 一个环境变量）

私钥现在在 `D:\AdShield 广告拦截器\.keys\adblocker.pem`，**和源码同目录**。整个文件夹被打包发人 = 扩展身份送人（拿到私钥就能签出同一个扩展 ID 的更新）。

```powershell
New-Item -ItemType Directory D:\AdShield-Keys -Force
Move-Item 'D:\AdShield 广告拦截器\.keys\adblocker.pem' 'D:\AdShield-Keys\adblocker.pem'
```

`pack.ps1` 已经改成按这个顺序找私钥：`$env:ADSHIELD_KEY` → `D:\AdShield-Keys\adblocker.pem` → 项目内 `.keys\`。移动后不用改脚本。要设环境变量就 `$env:ADSHIELD_KEY = 'D:\AdShield-Keys\adblocker.pem'`。

**注意：私钥丢了 = 扩展 ID 变化 = 已装用户收不到更新。** 备份好。

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
| 2.9.95 | 2026-11-01 | 遗留批量修复：设备删除越权、服务端错误正文注入、云端/备份 CSS 注入面、订阅 ID 去重、规则上限改用实测常量、正式版统计接 `getMatchedRules`、`docs/supabase-rls.sql` 入仓 |
| 2.9.94 | 2026-11-01 | 全局暂停真正停用动态规则；浏览助手文案误判（选择器收窄 + 500 字上限）；设置页补统计可用性说明；`pack.ps1` 的示例扩展 ID 修正 |
| 2.9.93 | 2026-10-31 | 第三轮审查修复（反拦截 MAIN world、URL 清理正则锚定、云端校验器） |

git 仓库提交：
- `73e95eb` 遗留批量修复
- `de3bf72` 全局暂停 + 文案误判 + 统计说明
- `6b1982a` 第三轮审查修复

---

## 10. 一句话给下一个 AI

规则系统有两套（静态规则集 / 共享池子的动态规则），id 段不能乱；Chrome 的 API 行为和数值上限**一律先实测再写进代码**；品牌版 Chrome 装不了未打包扩展，要用 CDP `Extensions.loadUnpacked`；打包产物和 git 仓库要手工同步并且逐字节校验——这四条踩过坑，其余按 §8 的规矩来。
