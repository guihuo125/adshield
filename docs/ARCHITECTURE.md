# AdShield 架构说明

本文说明四条主线如何协作：**静态规则集**、**动态规则**、**content script 双世界**、**云端同步**。

协作约定（DNR ID 段位表、storage 单一写入者等）见 [../AGENTS.md](../AGENTS.md)。

---

## 一、全局结构

```
                    ┌─────────────────────────────┐
                    │  Chrome 浏览器进程          │
                    │  ┌───────────────────────┐  │
   拦截请求 ───────▶│  │ DNR 规则引擎          │  │
                    │  │ （静态 + 动态规则）    │  │
                    │  └───────────┬───────────┘  │
                    │              │ 命中          │
                    │  ┌───────────▼───────────┐  │
                    │  │ Service Worker        │  │
                    │  │ background.js          │  │
                    │  │  · 规则应用/订阅更新   │  │
                    │  │  · 统计聚合            │  │
                    │  │  · 消息分发            │  │
                    │  └───────────┬───────────┘  │
                    │              │              │
        ┌───────────┼──────────────┼──────────────┼───────────┐
        │           │              │              │           │
   ┌────▼────┐ ┌────▼────┐   ┌─────▼─────┐  ┌─────▼─────┐ ┌───▼────┐
   │ popup   │ │ options │   │ content   │  │  logger   │ │ probe  │
   │ 工具栏  │ │  设置页 │   │ scripts   │  │  日志页   │ │ 诊断页 │
   └────┬────┘ └────┬────┘   └─────┬─────┘  └─────┬─────┘ └───┬────┘
        │           │              │              │           │
        └───────────┴──────┬───────┴──────────────┴───────────┘
                           │
                    ┌──────▼───────┐
                    │chrome.storage│
                    │    .local    │
                    └──────┬───────┘
                           │ 登录后
                    ┌──────▼───────┐
                    │  Supabase    │
                    │ adshield_configs │
                    └──────────────┘
```

---

## 二、DNR 规则：静态 + 动态

Chrome 的声明式网络请求规则分两种，各自独立存储但**共用配额池**。

### 静态规则集（打包进扩展）

`adblocker/rules/*.json`，由 `manifest.json` 的 `declarative_net_request.rule_resources` 声明。

- Chrome 在安装/升级时编译规则，**扩展代码改不了它们**
- 5 个规则集，每个是**一条**规则，`requestDomains` 里塞了成百上千个域名
- `url-tracking.json` 特殊：29 条规则，每条一个 `redirect` 动作去掉一个追踪参数
- ruleId 固定（100 / 1000 / 2000 / 3000~3028 / 4000），`background.js` 的
  `STATIC_RULE_SETS` 按区间反查分类

### 动态规则（运行时用 JS 下发）

`background.js` 通过 `chrome.declarativeNetRequest.updateDynamicRules()` 管理。

| 来源 | 段位 | 谁在写 |
|---|---|---|
| 用户自定义规则 | 100000~109999 | `applyUserRules()` |
| 站点放行（暂停） | 200000~209999 | `syncSiteAllowlist()` |
| 订阅过滤列表 | 300000~1299999 | `applySubscriptionText()` |
| 全局放行（全局暂停） | 2000000 | `syncGlobalPauseRule()` |

### 优先级语义

DNR 的 `priority` 决定多条规则同时匹配时谁生效。静态规则集的 priority 固定为 1；
用户规则用 1（拦截）/ 100（例外 `@@`）；站点放行与全局放行用 100 / 10000。

> **静态规则的优先级不可改**——它们在打包时固定。这决定了「全局暂停」必须用
> 一条动态 `allow` 规则（priority 10000）来覆盖，而不是去关静态规则集。

### 两个必须遵守的约束

1. **「先删后加」拆成两次调用，还是一次调用？**
   曾经的要求是拆成两次（`removeRuleIds` 一次、`addRules` 一次），理由是
   「同一次调用里让同一个 ID 同时出现在 `removeRuleIds` 和 `addRules` 中，行为依赖 Chrome 内部实现」。

   **2026-11-01 实测（Chrome 156）：单次调用是可行的** —— 同一个 ID 同时出现在
   `removeRuleIds` 和 `addRules` 里，等价于「替换」，Chrome 接受并正确执行。
   代码里 `applyUserRules` / `applySubscriptionText` / `syncSiteAllowlist` 都是单次调用，工作正常。

   仍然保留 `syncGlobalPauseRule` 的两次调用：全局暂停的开关必须**绝对可靠**，
   拆开写能在 Chrome 行为变化时多一层保险，代价只是多一次 IPC。

   **结论**：常规路径用单次调用即可；关键开关（全局暂停）保持两次调用。
   **不要因为「文档说必须拆」就批量改代码，也不要因为「实测能单次」就去改关键路径。**

2. **预算必须核算。** `updateDynamicRules` 是**整批原子提交**——超限则这批全部失败，
   不是部分生效。单个订阅可产出 5000+ 条，订阅数一多就会撞上总上限。
   `applyUserRules` 和 `applySubscriptionText` 都有预算截断，被丢弃的条目会回传给用户。

---

## 三、Content Script 双世界

`manifest.json` 声明了三个 content script 条目：

| 条目 | 文件 | world | all_frames | 作用 |
|---|---|---|---|---|
| 0 | `host.js` → `cosmetic.js` → `anti-detect.js` | 隔离 | 是 | 元素隐藏、反拦截（DOM 部分） |
| 1 | `dom.js` → `picker.js` | 隔离 | **否** | 元素拾取器（只在顶层 frame） |
| 2 | `anti-detect-main.js` | **MAIN** | 是 | 全局变量伪装、真实检测 |

### 为什么要有 MAIN world

页面的反拦截脚本运行在页面自己的 world。扩展的隔离 world 与页面 world **完全隔离**，
两边互相看不见对方的全局变量。

- 想**伪装**全局变量（让页面以为没装拦截器）→ 必须在 MAIN world
- 想**读取**页面检测结果 → 必须在 MAIN world

所以 `anti-detect-main.js` 跑在 MAIN world，它**不能有任何 `chrome.*` 调用**。

### 隔离世界 ↔ MAIN world 通信

用一个一次性 nonce：

1. `anti-detect.js`（隔离）生成 nonce，写进 `document.documentElement` 的
   `data-adshield-nonce` 属性
2. `anti-detect-main.js`（MAIN）读该属性
3. 隔离世界通过 `window.postMessage` 告知开关状态，MAIN 校验 nonce 一致后才响应

> **注入顺序不保证**（两个 world 的 content script 注入时机不同），
> 所以 nonce 通过 DOM 属性传递，且两端都有「属性还没就绪」的兜底路径。

### 反拦截的四路检测

`cosmetic.js` 的 `detectAdBlockScripts()`：

| 路 | 手段 | 准确度 | world |
|---|---|---|---|
| 1 | 页面全局变量检测 | 高 | MAIN（`anti-detect-main.js` 回报） |
| 2 | 脚本源码特征串扫描 | 中 | 隔离 |
| 3 | 弹窗文案扫描 | 低（兜底） | 隔离 |
| 4 | MutationObserver 持续监控（30 秒） | 中 | 隔离 |

路 3 早期版本扫的是 `body > div` / `body > section` / `main` —— 文章正文恰好都在这些容器里，
于是「一篇讲广告拦截的博客」会把自己的站点判成反拦截页并暂停 1 小时。
现在只在 `[role=dialog]` / `.modal` / `.popup` 这类容器里找，且要求文本量 < 500 字。

**大站跳过检测**（`ASSIST_SKIP_HOSTS`）：这些站点有大量自家反拦截逻辑，
自动暂停反而会破坏页面 UI，所以跳过、由用户手动处理。

---

## 四、统计的两条通道

### 开发模式（未打包扩展）

`onRuleMatchedDebug` 事件提供完整信息：**请求 URL + 分类 + 时间戳**。

写入 `__statsBuffer`（内存）的字段：`total` / `byPage` / `byBlocked` / `byCategory` /
`byDate` / `byHour` / `recentLogs`。

### 正式安装版

**没有 `onRuleMatchedDebug`。** 官方权限表原文：

> `declarativeNetRequestFeedback` — "This permission is for use with unpacked extensions
> and is ignored for extensions installed from the Chrome Web Store."

所以正式版只有一条路：`activeTab` + `getMatchedRules({tabId})`。

| | 开发模式 | 正式安装版 |
|---|---|---|
| 本页拦截数 | ✅ 精确 | ✅ `getMatchedRules({tabId})` |
| 分类明细 | ✅ 精确 | ✅ 按 ruleId 归类（动态规则一律归 ads） |
| 被拦域名 | ✅ | ❌ API 不返回 URL |
| 逐条日志 | ✅ | ❌ |
| 全局累计 | ✅ | ❌ 需全局查询，无 activeTab 授权 |

`popup.js` 在正式版下走 `getTabStats` 消息，并按 **60 秒限流**——
该 API 配额是 20 次 / 10 分钟，而 popup 每 2 秒轮询一次，不限流会直接超限。

### 内存缓冲与落盘

`__statsBuffer` 是内存中的实时计数，`scheduleFlush()` 负责串行写盘。

> **MV3 的 Service Worker 空闲就会被挂起**，内存变量一重启就丢。
> 所以「清空统计」这类操作必须**同时清内存与磁盘**——只清磁盘的话，
> 下一次 flush 会把旧数据写回去（这就是 `clearLogs` 消息存在的原因）。

---

## 五、账号与云端同步

`src/shared/auth.js` 负责全部账号逻辑，Supabase 是可选的（未配置时 `isSupabaseReady()` 为 false）。

### 数据流

```
本地 storage ──collectLocalData()──▶ 上传到 Supabase
      ▲                                    │
      └────applyCloudData()◀── pullFromCloud()
```

### 云端是「不可信输入」

云端表 `adshield_configs` 的行内容会直接进入本地设置。`shared/validate.js` 里的
四个 `sanitizeCloud*` 是这条路径上**唯一的防线**：

| 字段 | 校验 |
|---|---|
| `user_rules` | 数组、每项 string、≤1000 字符、≤5000 条、元素隐藏选择器不能突破 CSS 块 |
| `subscriptions` | ≤20 条、url 必须 `https://` 且可解析、≤500 字符、id 归一化到 1~99 且不撞号 |
| `whitelist` | 主机名格式合法、pausedUntil 值是有限正整数时间戳 |
| `settings` | 只接受白名单键、开关必须是布尔、subscriptionInterval 0..168 |

**被拒绝的项不会静默丢弃**——`applyCloudData` 汇总成 `rejected` 数组返回并记日志。

> 还有一个「全都不合法就保留本地」的兜底：云端某个字段有内容但校验后一个都不剩时，
> 保留本地原值。否则一条全非法的行就能把用户的白名单清空。

### CSS 注入防护

元素隐藏规则的选择器会被原样拼进 CSS（`sel + "{display:none !important;}"`）。
含 `{` `}` `@` `/*` 的选择器能提前闭合规则块、注入任意声明——等于往用户访问的每个网站
注入任意 CSS。`isSafeCssSelector` 拦掉这些，但**不拦 `<` `>`**，因为 `.ad > .banner` 是合法选择器。

### 令牌刷新

`refresh_token` 是一次性的（服务端轮换）。并发刷新时第二个必然失败并误报「登录已过期」，
所以用单例 Promise 让并发的 401 共享同一次刷新。

「连不上」与「凭据被拒」是两回事：前者保留登录态并提示「网络不可用，未同步」，
后者才真正退出登录。`isOfflineError` 负责区分。

---

## 六、模块依赖关系

```
shared/host.js     ← 无依赖（被 content script 与页面共用）
shared/dom.js      ← 无依赖
shared/config.js   ← 无依赖
shared/validate.js ← 依赖 host.js（惰性读取，可单独测试）
shared/modal.js    ← 无依赖
shared/auth.js     ← 依赖 dom.js / host.js / validate.js
background.js      ← importScripts: host.js, config.js
options.js         ← script: theme/nav-init/host/dom/config/validate/modal/auth
popup.js           ← script: theme/host/dom/config/modal
logger.js          ← script: theme/modal/dom/config
probe.js           ← script: theme（独立页）
content/cosmetic.js    ← manifest 注入: host.js
content/anti-detect.js ← manifest 注入: host.js
content/picker.js      ← manifest 注入: dom.js
content/anti-detect-main.js ← MAIN world，独立
```

**依赖方向永远是「共享模块 → 业务代码」**，共享模块之间只有 `validate → host` 一条边。
没有任何业务模块被共享模块反向依赖。

---

## 七、已知的设计取舍

| 取舍 | 理由 | 代价 |
|---|---|---|
| 元素隐藏用 CSS 注入而非 JS 移除 | 性能好，不触发重排 | 页面脚本仍能读到被隐藏的元素 |
| 反拦截伪装全局变量 | 这是对抗行为，页面若依赖 `canRunAds` 判断会误判 | 极小概率影响页面正常逻辑 |
| 订阅规则用域名分块（1000 域名/条） | DNR 对单条规则的域名数有隐含限制 | 单订阅最多 ~5400 条 |
| 站点放行用 `allowAllRequests` + `main_frame` | 一条规则放行整站 | 无法只放行部分子资源 |
| 统计只在开发者模式提供完整明细 | 平台限制（feedback 权限） | 正式版用户看不到明细 |
| 订阅规则更新走串行队列 | 防 `updateDynamicRules` 并发写冲突 | 更新耗时随订阅数线性增长 |
