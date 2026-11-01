# UI 层结构与改动手册

> 覆盖范围：`adblocker/src/` 下的 4 个界面（options / popup / logger / probe）+ `shared/` 共享层。
> 本文只讲 UI 层，运行时架构见 `docs/ARCHITECTURE.md`，硬性约定见 `AGENTS.md`。
> 所有行号基于当前工作区（2026-11-01 审查后版本）。

---

## A. 四个界面的职责与结构

### A.1 总览

| 界面 | 文件 | 行数 | 解决的问题 | 入口 |
|---|---|---|---|---|
| 设置页 | `options.html` | 1002 | 全部配置项的管理入口（开关 / 规则 / 白名单 / 统计 / 账号） | `chrome.runtime.openOptionsPage()`；popup 底部「规则管理」按钮（`popup.html:260`） |
| 工具栏弹窗 | `popup.html` | 269 | 「我现在在这个网站上被拦了多少，想临时关掉 / 加白名单」 | `manifest.json` → `action.default_popup` |
| 详细日志 | `logger.html` | 64 | 逐条查看被拦截的 URL、分类、来源页面 | popup 菜单「查看详细日志」（`popup.html:232`） |
| 运行时诊断 | `probe.html` | 38 | 采集 DNR 运行时事实（规则上限 / 已用规则数 / 反馈 API 可用性） | 设置页「关于 → 运行时诊断」（`options.html:582`） |

四页全部是**独立 HTML 页面**（非路由框架），各自加载自己的 CSS + JS，彼此不共享 `<script>`，只共享 `shared/` 目录。

### A.2 options.html — 设置页

**结构**（左侧栏 + 右侧内容区的两栏布局，`.layout` 是 `grid-template-columns: 240px 1fr`）

| 区块 | 位置 | 内容 |
|---|---|---|
| 侧栏 | `options.html:19-82` | 品牌区 + 6 个导航项 + 底部版本号 |
| 顶部条 | `options.html:86-107` | 仅主题分段按钮 `#themeSegmented`（light / auto / dark 三个 `.theme-btn`） |
| 面板 ×6 | `options.html:110 / 272 / 379 / 422 / 492 / 746` | 见下表 |

**6 个面板（`data-panel`）与导航项（`data-tab`）严格一一对应**：

| 面板 | nav 行号 | panel 行号 | 内容 |
|---|---|---|---|
| `privacy` 常规设置 | `:26` | `:110` | 4 个 feature-card 开关（全局 / 反拦截 / 浏览助手 / badge）+ 5 个分类开关 + 全局暂停 |
| `rules` 规则管理 | `:33` | `:272` | 订阅源列表 + 自定义规则 textarea + 元素隐藏规则 + 导入导出 |
| `sites` 网站 | `:42` | `:379` | 白名单添加 + 永久暂停列表 + 临时暂停列表 |
| `report` 拦截统计 | `:49` | `:422` | 3 个统计盒 + 趋势图 + 占比条 + 站点排行 + Top 域名 |
| `about` 关于 | `:66` | `:492` | 链接列表 + 功能特性 + 技术栈 |
| `account` 账号 | `:58` | `:746` | 登录 / 注册 / 同步开关 / 设备管理（**由 `shared/auth.js` 独占**） |

**JS**：`options.js`（1965 行）+ `shared/auth.js`（2467 行，仅账号面板）+ `shared/nav-init.js`（首屏防闪）

**CSS**：`options.css`（2641 行，500 条规则）+ `shared/modal.css`

**状态来源**：

| 来源 | 键 / 消息 | 用途 |
|---|---|---|
| storage.local | `adshield_settings` | 全部设置（`SETTINGS_KEY`，`options.js:1`），结构见 `shared/config.js:16-31` |
| storage.local | `adshield_stats` | 统计（`STATS_KEY`，`options.js:2`） |
| storage.local | `adshield_user_rules` | 自定义拦截规则（`options.js:995`） |
| storage.local | `adshield_user_cosmetic` | 元素隐藏规则（`options.js:1002`） |
| storage.local | `adshield_trend_pref` | 趋势图时间范围偏好（`options.js:964`） |
| storage.local | `adshield_sync_prefs` | 云同步勾选（`options.js:1885`） |
| storage.local | `adshield_user_rules_result` | 规则应用结果提示（`options.js:1917`） |
| background 消息 | `getStats` / `saveUserRules` / `ping` + `MSG.*` 系列 | 统计读取、规则保存、SW 保活、订阅管理 |

**路由机制（关键）**：`nav-init.js` 在 `<head>` 里同步执行，直接给 `<html>` 写 `data-route` 属性；`options.css:118-123` 与 `:393-398` 用 `html[data-route="xxx"]` 匹配做首屏高亮与面板显示。**加新面板必须同时改这两处 CSS 硬编码列表**（详见 B.3）。

### A.3 popup.html — 工具栏弹窗

**结构**（单列滚动面板，宽 320px，见 `popup.css:63`）

| 区块 | 位置 | 说明 |
|---|---|---|
| Header | `:15-27` | Logo + 菜单按钮 `#menuBtn` |
| 暂停卡片 | `:30-70` | `#pauseBtn` 主暂停 + `#pauseTypeBtn` 时长下拉（`data-min` = 60 / 1440 / 0） |
| 站点标题 | `:73-79` | `#siteHost` + `#siteCount`（**已被 `hidden` 隐藏**，`:78`） |
| 圆环图 | `:82-91` | SVG 5 段（`ads`/`track`/`anno`/`url`/`malware`），JS 动态改 `stroke-dasharray` |
| 提示条 | `:94` | `#statsNote`，正式安装版才显示 |
| 统计卡片 ×2 | `:97-121` | `#statSite` 本站已拦截 / `#statTotal` 累计拦截 |
| 分类 chips | `:124` | `#catRow`，JS 动态生成 |
| 设置浮层 | `:127-264` | `#menuOverlay`，分 4 组：全局 / 防护类型 / 通知 / 工具 |

**JS**：`popup.js`（699 行）+ `shared/modal.js` + `shared/host.js`

**CSS**：`popup.css`（623 行，129 条规则）+ `shared/modal.css`

**状态来源**：
- storage.local：`adshield_settings`、`adshield_stats`
- background 消息：`getStats`（`popup.js:32`）、`getTabStats`（`popup.js:334`）、`resetStats`（`popup.js:682`）
- content script 消息：`startElementPicker`（`popup.js:614`），失败时动态注入 `src/content/picker.js`（`popup.js:626`）

**刷新节奏**：`popup.js:696-698` 每 2 秒轮询一次 `render()`；`chrome.storage.onChanged` 也会触发（`:691`）。

### A.4 logger.html — 详细日志

**结构**（单页表格）

| 区块 | 位置 |
|---|---|
| Header + 4 个按钮 | `:15-26`（刷新 / 导出 JSON / 导出 CSV / 清空） |
| 统计盒 ×2 | `:28-31`（`#totalCount` 累计拦截 / `#logCount` 日志条数） |
| 提示条 | `:33`（`#statsNote`） |
| 过滤行 | `:35-45`（`#filterInput` 文本过滤 + `#catFilter` 分类下拉，5 个 option 硬编码在 HTML） |
| 表格 | `:47-60`，4 列：时间 / 分类 / 被拦截 URL / 来源页面 |
| 空状态 | `:59`（`#emptyTip`） |

**JS**：`logger.js`（134 行）+ `shared/modal.js`
**CSS**：`logger.css`（90 行，40 条规则）+ `shared/modal.css`

**状态来源**：storage.local `adshield_stats` → 取 `stats.recentLogs`（`logger.js:35`）；background 消息 `getStats`（`logger.js:29`）、`clearLogs`（`logger.js:129`）。
**注意**：清空必须走 background（`logger.js:129`），直接写 storage 会被内存缓冲写回来。

### A.5 probe.html — 运行时诊断

**结构**（无表格，纯输出页）：header（`#runBtn` 重新采集）→ `.p-note` 说明 → `#status` 状态行 → `#out` JSON 输出 → 复制/下载按钮 → 命令行提示（`node tools/probe-dnr.mjs probe.json`）。

**JS**：`probe.js`（155 行）+ `shared/theme.js`
**CSS**：`probe.css`（70 行，18 条规则）—— **唯一不加载 `shared/modal.css` 的页面**

**状态来源**：不读 storage 统计，只读 `adshield_settings` 做设置快照（`probe.js:97`）；数据全部来自 `chrome.declarativeNetRequest` API 实测。

---

## B. 改一个 UI 元素要动哪几个文件

### B.1 加一个新的设置开关（以「新增一个 feature 开关」为例）

**必改 4 个文件**：

| # | 文件 | 改什么 | 定位 |
|---|---|---|---|
| 1 | `shared/config.js` | `DEFAULT_SETTINGS` 加默认值 | `:16-31`（**唯一真源**，`check.mjs:170-180` 强制） |
| 2 | `options.html` | 加 `<input type="checkbox" id="swXxx" />` 控件 | 放在 `data-panel="privacy"` 的 `.feature-card`（`:117-185`）或 `.rule-item-static`（`:252-268`）里 |
| 3 | `options.js` | ① `swMap` 加读取 ② `toggles` 数组加写入 | 读取 `:1101-1110`；写入 `:1146-1159` |
| 4 | `options.css` | 控件样式（若复用 `.switch` / `.slider` 则无需改） | `.switch` 定义在 `:426-432`，`.slider` 在 `:426-432` |

**若这个开关要影响拦截行为**，还需改 `background.js` 的消费点。参考现有模式：
- `showBadge` → `background.js:337`
- `notifyOnBlock` → `background.js:1671`
- `antiDetect` → `content/anti-detect.js:15`（不是 background）
- `assist` → `background.js` 中 9 处引用

**⚠ 忘记改 `swMap` 或 `toggles` 的症状**：开关能点但刷新后状态丢失（只写了没读），或开关永远显示关闭（只读了没写）。这两处是**分开的两张表**，必须成对改。

**若该开关要上云同步**，还要加进 `shared/validate.js:227` 的 `ALLOW` 白名单。

### B.2 改弹窗（popup）上的一个显示

| 场景 | 改什么 |
|---|---|
| 改文案/位置 | `popup.html` 对应行 |
| 改文案内容（JS 动态生成的） | `popup.js`：`render()` 在 `:308-432`；开关列表在 `buildMenuRow()` `:64-78`；分类 chips 在 `renderCatChips()` `:262-287` |
| 改圆环颜色 | 分类色值来自 `shared/config.js:44-48` 的 `CATS`，**不在 CSS 里** |
| 改样式 | `popup.css` |
| 改图标 SVG | `popup.html` 内联 SVG |

**注意**：`popup.js` 的 `buildMenuRow` 用 `innerHTML` 拼字符串（`:67-76`），但插进去的 `label` / `color` 来自 `shared/config.js` 的 `RULESETS`（常量），不是用户数据，所以未转义是安全的。

### B.3 加一个新的设置页面板（导航项 + panel）

**必改 3 个文件，漏一处就是白屏/点不动**：

| # | 文件 | 改什么 | 定位 |
|---|---|---|---|
| 1 | `options.html` | ① 侧栏加 `<a class="nav-item" data-tab="xxx">` ② 主区加 `<section class="panel" data-panel="xxx">` | nav 在 `:26-73`，panel 在 `:110-994` |
| 2 | `options.css` | **两处硬编码列表都要加** | `:118-123`（nav 高亮）、`:393-398`（panel 显示） |
| 3 | `options.js` | 若新面板需要独立渲染逻辑，在 `render()` `:1093-1143` 里加调用 | — |

**⚠ 最容易漏的是第 2 步**：`options.css` 的首屏防闪规则是逐条写死 6 个路由名的（`:118-123` 和 `:393-398`），不是通配。加了 `data-tab="xxx"` 但没加这两处 CSS，首屏会停在空白面板上（`.panel { display: none }` 在 `:390`，只有 `.active` 或 `html[data-route=...]` 匹配才显示）。

`shared/nav-init.js` 和 `options.js:343-352` 的路由切换逻辑是**通用的**，不需要改。

### B.4 改主题色

**这是本次审查中成本最高的一项**。见 C.3 的数量统计。

**主色变量定义在 4 个文件里，各写一份**（没有共享的 theme.css）：

| 文件 | `:root` 位置 | 变量数 | `html[data-theme="dark"]` 位置 |
|---|---|---|---|
| `options.css` | `:3` | 33 | `:44` |
| `popup.css` | `:3` | 36 | `:49` |
| `logger.css` | `:2` | 21 | `:14` |
| `probe.css` | `:2` | 12 | `:16` |
| `shared/modal.css` | **无** | **0** | 分散在 `:226 / 230 / 249 / 252 / 255 / 258 / 261 / 265` |

**改一个主题色的完整清单**（以品牌蓝 `#00aef0` 为例）：
1. `options.css:5` — `--color-brand-500: #00aef0;`
2. `popup.css:11` — 同名变量
3. `logger.css:3` — 同名变量（写在单行里）
4. `probe.css:9` — 这里是 `--brand`，**变量名不同**
5. `shared/modal.css` — **不参与**，它 0 个 `var(--)` 全部硬编码
6. 各 CSS 中 `html[data-theme="dark"]` 块内**硬编码**的同类色（`options.css` 50 块 / `popup.css` 6 块 / `logger.css` 6 块 / `probe.css` 1 块 / `modal.css` 8 块）
7. JS 里内联写死的色值：`shared/config.js:35-48`（规则集色，10 处）、`options.html:195-659`（12 处内联 style）、`options.js:716-720`（趋势图分类色，5 处）

### B.5 加一个日志页的列

**必改 3 个文件**：

| # | 文件 | 改什么 | 定位 |
|---|---|---|---|
| 1 | `logger.html` | `<thead>` 里加 `<th>` | `:49-56`（当前 4 列：时间 / 分类 / 被拦截 URL / 来源页面） |
| 2 | `logger.js` | `render()` 的 `<tr>` 模板加 `<td>` | `:72`（单行模板字符串，4 个 `<td>`） |
| 3 | `logger.js` | 若该字段要参与过滤，加进 `hay` | `:55` |
| 4 | `logger.js` | 若该字段要导出，加进 CSV 头 + 行 | `:97`（header 数组）、`:99-106`（行循环） |

**⚠ 注意**：`logger.js:72` 是一行超长模板字符串，4 个 `<td>` 挤在一行里。改列时容易少写一个 `</td>`，且**没有 lint 会发现**（`tools/check.mjs` 不校验 HTML 结构）。
`logger.html` 的表格是 `<table id="logTable">`（`:48`），但 `#logTable` 这个 id 在 `logger.js` 里**从未被引用**（全项目仅 `logger.html:48` 一处）——是死 id，可忽略。

---

## C. UI 层的样式与主题机制

### C.1 主题切换：light / dark / auto

**机制分两层**：

```
shared/theme.js（逻辑层）          各页面 CSS（表现层）
       │                                  │
 读 storage.theme              :root{ --xxx: 亮色值 }
       │                        html[data-theme="dark"]{ --xxx: 暗色值 }
       ▼                                  │
 applyTheme() → <html data-theme="light|dark">
```

**`shared/theme.js` 做的事**（45 行）：
1. `applyTheme(theme)` `:7-15`：把 `auto` 用 `matchMedia("(prefers-color-scheme: dark)")` 解析成实际的 `light`/`dark`；写 `<html data-theme="...">`；同步更新 `<meta name="color-scheme">`（让浏览器原生 UI 也跟随）
2. 页面加载时立即读 `adshield_settings.theme` 并应用 `:18-21`（默认 `auto`）
3. 暴露 `window.__adshield_theme__.apply(theme)` 与 `.set(theme)` `:24-33`
4. 监听系统主题变化，仅当当前为 `auto` 时响应 `:36-44`

**关键事实**：
- `theme.js` 只在 `<head>` 里同步执行一次（`options.html:7` / `popup.html:6` / `logger.html:7` / `probe.html:7`），且**在 CSS `<link>` 之前**——这是防闪的关键
- **CSS 里没有任何 `data-theme="auto"` 选择器**（已验证：0 处）。`theme.js` 保证 `<html>` 上的 `data-theme` 只会是 `light` 或 `dark`，CSS 只认这两个
- 切换主题的 UI **只有设置页一处**：`options.js:1182-1196`，写 storage 后调 `window.__adshield_theme__.apply(theme)`（`:1191`）。`theme.js` 暴露的 `.set()` 方法**全项目无人调用**（只有 `.apply` 被用）——`.set()` 是死代码
- **其它页面不会自动跟随**：popup / logger / probe 的 `theme.js` 只在加载时读一次。设置页改了主题后，已打开的 popup 不会变（需重开）

### C.2 弹窗样式与页面 CSS 的分工

**分工非常干净**：

| 层 | 文件 | 管辖范围 |
|---|---|---|
| 通用模态框 | `shared/modal.css`（268 行，49 条规则） | 只管 `.adshield-modal*` 前缀的 12 个 class。**0 个 `var(--)`、0 个 `:root`**——完全独立的色值体系 |
| 页面私有 | `options.css` / `popup.css` / `logger.css` / `probe.css` | 页面自己的 class，**不含任何 `.adshield-modal` 规则** |

- `shared/modal.js` 运行时用 `innerHTML` 注入 `.adshield-modal-overlay` 骨架（`modal.js:21-33`），所以 HTML 文件里没有对应的静态标签
- `shared/modal.css` 被 options / popup / logger 加载，**probe 不加载**（probe 无弹窗）
- **代价**：模态框是项目里唯一完全脱离 CSS 变量体系的部分。改主题色**不会**影响模态框，要改得单独改 `modal.css` 的 37 处硬编码。

### C.3 硬编码颜色值散落情况（决定改主题色的成本）

**全量统计（口径：`#hex` + `rgb()/rgba()` 三参数形式）**：

| 位置 | 硬编码色值处数 | 说明 |
|---|---|---|
| **CSS（`:root` 变量定义之外）** | | |
| `options.css` | **236** | 其中 `html[data-theme="dark"]` 块内 50 块 |
| `popup.css` | **48** | |
| `shared/modal.css` | **37** | 全部（无变量体系） |
| `logger.css` | **24** | |
| `probe.css` | **12** | |
| **CSS 小计** | **357** | 另有 80 处在 `:root` / `html[data-theme="dark"]` 变量定义块内（属于可集中改的） |
| **HTML / JS** | | |
| `shared/auth.js` | **37** | 19 行，主要是头像渐变色板 `:188-197`、`:341-348` |
| `options.html` | **12** | 全是内联 `style="background:#XXXXXX"`（规则集圆点 `:195-239`、功能圆点 `:624-659`、`:985`） |
| `shared/config.js` | **10** | `RULESETS` 色 `:35-39` + `CATS` 色 `:44-48` |
| `options.js` | **6** | `TREND_CATS` 色 `:716-720` + 订阅错误红 `:1425` |
| **HTML/JS 小计** | **65** | |
| **总计** | **422 处** | 唯一色值 **128 个**（hex 109 + rgba 19） |

**改主题色的实际成本**：422 处里有约 **357 处不会自动跟随**变量改动。其中：
- 最集中的两块是 `options.css` 的 236 处 和 `shared/auth.js` 的 37 处
- `options.html` 的 12 处内联色（`:195-239`、`:624-659`）是最典型的「同一批颜色在 3 个地方各写一遍」：`shared/config.js:35-48` → `options.html` 内联 style → `options.css` 的 `--cat-*` 变量
- `shared/config.js:35-48` 与 `options.js:716-720` 是**同一张分类色表的两份拷贝**（`#FD3638` / `#A78BFA` / `#F79009` / `#00AEF0` / `#7F1D1D`），改分类色要同时改这两处

### C.4 重复定义的 CSS 类 / 变量

**重复的 CSS 变量（跨文件同名，各写一份）**：**29 个变量名**在 2-4 个文件里重复定义。

| 变量 | 定义在 |
|---|---|
| `--color-gray-100` … `--color-gray-900`（9 个灰阶） | options.css + popup.css + logger.css |
| `--color-brand-400/500/600` | options.css + popup.css + logger.css |
| `--bg-primary` / `--bg-secondary` / `--bg-tertiary` / `--border-primary` | options.css + popup.css + logger.css（+ probe.css 用了 `--bg-secondary`/`--bg-tertiary`） |
| `--text-primary` / `--text-secondary` / `--text-tertiary` | options.css + popup.css + logger.css + probe.css |
| `--font-family` | options.css + popup.css + logger.css |
| `--radius-s/m/l`、`--shadow-card`、`--color-danger-500`、`--color-warning-400`、`--color-success-500`、`--text-quaternary` | options.css + popup.css（部分 + logger.css） |

**⚠ `probe.css` 用的是完全另一套命名**：`--bg` / `--border` / `--brand` / `--brand-dark` / `--danger` / `--success` / `--warning` / `--text-*`，与其它三页的 `--bg-primary` / `--border-primary` / `--color-brand-500` 不通用。改主题时 probe 页要单独改。

**重复的 CSS 类（跨文件同名）**：**13 个** class 在多个文件里各定义一份：

| class | 出现处 | 风险 |
|---|---|---|
| `.slider` | 16 处（options.css 9 + popup.css 5 + 其它） | 开关滑块两页样式独立，**改开关外观要同时改两页** |
| `.switch-toggle` | 11 处 | 同上 |
| `.btn` | logger.css + probe.css | 按钮基础样式两页各一份 |
| `.brand` / `.logo` | popup.css + logger.css + probe.css | 页头各一份 |
| `.stat-num` / `.stat-label` / `.stat-box` | popup.css + logger.css + options.css | 统计盒各一份 |
| `.actions` | options.css + logger.css | |
| `.auth-hint` | options.css + modal.css | 模态框里复用了 options 的类名，**跨文件耦合** |
| `.empty` / `.open` / `.active` | 多处（多为状态修饰类） | 语义词复用，改名要全局搜 |

**同文件内重复定义**：**0 个**（已用 CSS 解析器逐块验证，options.css 121 个 / popup.css 29 个 class 出现在多条规则里都是正常的修饰器组合 `:hover` / `::after` / 后代选择器，不是重复定义）。

---

## D. 前端层的已知坑（基于真实代码）

### D.1 innerHTML 拼字符串与转义

**转义真源**：`shared/dom.js:12-17` 的 `escapeHtml()`（转义 `& < > " '` 五个字符）。`tools/check.mjs:159-168` 强制只有 `shared/dom.js` 能自己实现，其它文件引用即用。

**各文件 innerHTML 出现次数**：

| 文件 | innerHTML 次数 | 说明 |
|---|---|---|
| `options.js` | **25** | 列表渲染为主 |
| `shared/auth.js` | **12** | 账号区 DOM 拼接 |
| `popup.js` | **7** | 开关行 + chips + 图标 |
| `shared/modal.js` | **5** | 模态框骨架（模板常量） |
| `logger.js` | **2** | 表格行 |

**逐点核查结论**：

| 位置 | 动态字段 | 是否转义 | 风险 |
|---|---|---|---|
| `options.js:472-473` | `item.host` / `item.meta` | ✅ `escapeHtml` | 无 |
| `options.js:477` | `data-host="${...}"` | ✅ | 无 |
| `options.js:578` / `:698` | `host` | ✅ | 无 |
| `options.js:681` | `c.color` / `c.label` | ❌ | **安全**——来自 `shared/config.js:44-48` 常量 |
| `options.js:955` | `c.color` / `c.label` | ❌ | **安全**——`TREND_CATS` 常量（`options.js:716-720`） |
| `options.js:1030-1035` | `domainsPart` / `selector` | ✅ | 无 |
| `options.js:1421-1429` | `sub.url` / `displayName` / `sub.id` | ✅ | 无（`sub.lastError` 也转义，`:1425`） |
| `options.js:1478-1480` | `preset.name` / `preset.desc` | ✅ | 无 |
| `logger.js:72` | `l.url` / `l.pageHost` | ✅ | 无 |
| `logger.js:71` | **`catName`** | ❌ | **需注意**——`catName` 优先取自硬编码映射表，未命中时回退到 `l.cat \|\| "未知"`（`:71` 末位 `\|\| l.cat`）。`l.cat` 来自 background 的 `classifyRule()`，返回值域是 `ads/tracking/annoyances/url_clean/malware` 五个枚举（`background.js:271-311`），**当前安全**，但这是一条未被转义包裹的外部数据路径 |
| `popup.js:69` | `label` / `color` | ❌ | **安全**——`RULESETS` 常量 |
| `popup.js:283` | `CAT_LABELS` / `CAT_COLORS` | ❌ | **安全**——config 常量 |
| `auth.js:1224-1229` | `device_name` / `device_id` | ✅ | 无 |
| `auth.js:1262` | `e.message` | ✅ | 无 |
| `auth.js:2130-2132` | 服务端错误正文 | ✅ **走 textContent** | 已刻意处理，注释见 `:2127-2129` |

**`shared/modal.js` 的 HTML 注入点**：`:184` `showFormDialog` 的 `bodyHtml` 直接 `innerHTML`（文档注释 `:159` 明确写了「调用方负责转义用户数据」）。`auth.js` 的 6 个调用点（`:284` / `:908` / `:1005` / `:1373` / `:1439` / `:1536`）都在 auth.js 内部拼装并已转义。**`showConfirm` 的 `html: true` 选项**（`modal.js:72-76`）同样直接 `innerHTML`——目前只有 `options.js:161` 和 `:172`（检查更新）用它，拼接内容走了 `escapeHtmlSimple` / `simpleMarkdown`（后者在 `options.js:229` 自行实现了一份转义，**与 `shared/dom.js` 重复**）。

> ⚠ `options.js` 里实际存在 **3 份 escapeHtml 实现/包装**：`escapeHtmlSimple`（`:194`）、`escapeHtml`（`:494` 转调 `window.adshieldDom.escapeHtml`）、以及 `simpleMarkdown` 内部的局部 `esc`（`:229`）。`tools/check.mjs:163` 的正则 `function\s+escapeHtml(Simple)?\s*\(` 抓得到前两个，抓不到 `:229` 的箭头函数 `const esc = (s) => ...`——**校验有盲区**。

### D.2 DOM id 契约：`tools/check.mjs` 校验了什么、没校验什么

**已校验**（`tools/check.mjs:95-130`）：

| # | 规则 | 实现 |
|---|---|---|
| 1 | JS 引用的 id 必须存在于对应 HTML | `:110-111` 抓 `$("#id")` 和 `getElementById("id")` 两种写法 |
| 2 | 覆盖 3 对页面 | `:97-101` `PAGES = [options, popup, logger]` |
| 3 | 「裸引用」判 error，「有空值保护」判 warning | `:120-127`，通过在引用点前后 ±200/240 字符窗口内匹配 `if (!x)` / `if (x && y)` / `? x : null` 来判定 |

**当前状态**：`node tools/check.mjs` 通过，仅 1 条 warning（`popup.js` 引用不存在的 `featureList`，有 null 保护）。

**⚠ 没校验的（重要）**：

| # | 盲区 | 影响 |
|---|---|---|
| 1 | **`probe.js` / `probe.html` 完全不在 `PAGES` 里**（`:97-101`） | probe 页的 id 契约零校验。当前 5 个 id 恰好都对，但以后改坏了不会有任何提示 |
| 2 | **`shared/auth.js` 不在 `PAGES` 里** | `options.html` 里 **26 个 id 只被 `shared/auth.js` 引用**（`navAccount` / `accountSkeleton` / `accountGuest` / `btnLogin` / `btnLogout` / `deviceList` / `btnDeleteAccount` 等），这些 id 改坏了不会被 `check.mjs` 发现 |
| 3 | 只抓 `$("#id")` 与 `getElementById("id")` 两种写法 | `$$("#id")`、`querySelector("#id")`、`getElementById('id')`（单引号）都漏。**当前项目里这三种写法一个都没用到**，所以暂时安全——但这正是「写新代码时最容易踩的坑」：用 `$$("#xxx")` 引用一个不存在的 id，检查照样通过 |
| 4 | **不校验 HTML 里「定义了但 JS 从不引用」的 id** | `options.html` 的 `swRsAds` / `swRsTracking` / `swRsAnnoyances` / `swRsUrlClean` / `swRsMalware` 这 5 个 id（`:201` / `:212` / `:223` / `:234` / `:245`）在 JS 里从未按 id 引用——规则集开关是靠 `data-ruleset` 属性选的（`options.js:388` / `:398`）。**改这 5 个 id 不会坏，但改 `data-ruleset` 值会静默失效** |
| 5 | 不校验 class 名与 CSS 的对应 | 改 class 名不会报错，只会「样式不生效」 |
| 6 | 不校验 HTML 结构（标签闭合、嵌套） | `logger.js:72` 少写一个 `</td>` 不会被发现 |
| 7 | 不校验 `data-tab` / `data-panel` 配对 | 见 B.3，加导航项漏改 CSS 会白屏 |

**id 唯一性**：4 个页面的 id 全部唯一（已验证，options.html 97 / popup.html 28 / logger.html 12 / probe.html 5，无重复）。

**id 覆盖率**（以「作为子串出现在对应 JS 中」为口径）：

| 页面 | id 总数 | JS 引用到 | 未引用 |
|---|---|---|---|
| options.html | 97 | 92 | 5（`swRs*`，走 `data-ruleset`） |
| popup.html | 28 | 28 | 0 |
| logger.html | 12 | 11 | 1（`logTable`，纯死 id） |
| probe.html | 5 | 5 | 0 |

### D.3 大文件体量下的回归风险

**规模数据**：

| 文件 | 行数 | 规模指标 |
|---|---|---|
| `options.css` | **2641** | 500 条 CSS 规则、313 个 class、50 个 `html[data-theme="dark"]` 块 |
| `options.html` | **1002** | 97 个 id、6 个面板、931 个标签、21 处内联 `style` |
| `options.js` | 1965 | 25 处 innerHTML、6 个 storage 键 |
| `shared/auth.js` | 2467 | 12 处 innerHTML、37 处硬编码色、独占 26 个 options.html 的 id |

**具体回归风险点**：

| 风险 | 说明 |
|---|---|
| **1. `options.css` 的暗色块是「逐条覆写」而非「重新定义一套变量」** | 50 个 `html[data-theme="dark"]` 块里散落着独立硬编码色（`:488-493` 的图标底色、`:1723-1728` 的密码强度条、`:2272-2281` 的更新状态、`:2466-2471` 的技术栈图标、`:2566-2570` 的链接图标）。**加一个新的彩色元素到暗色模式，必须手动补一条暗色规则**，漏了就是暗色下颜色不对 |
| **2. `options.js` 的 `render()` 是一个大总管** | `:1093-1143` 一次调用 7 个渲染函数（`renderSites` / `renderTrackers` / `renderReport` / `loadUserRules` / `loadSubscriptions` / `renderCosmeticRules`）。**任意一个抛错会中断后续所有渲染**，没有 try/catch 包裹 |
| **3. `options.js` 的开关读写是两张分离的表** | 读：`swMap` `:1101-1110`；写：`toggles` `:1146-1151`。**加开关必须同时改两处**，漏改的症状是「能点但状态不保存」或「保存了但开关不动」 |
| **4. `options.html` 里的账号面板被 `auth.js` 独占** | `options.html:746-994` 这 249 行的 26 个 id 全部由 `shared/auth.js` 消费。**只改 options.html 会直接坏掉账号功能**，改账号面板必须同时打开 `shared/auth.js`（2467 行） |
| **5. `options.css` 的开关样式 `.switch` / `.slider` 与 `popup.css` 各写一份** | options.css `:426-432`（11 处规则）、popup.css `:475-497`（7 处规则）。**改开关外观要同时改两个 CSS 文件**，只改一处会出现「设置页和弹窗的开关长得不一样」 |
| **6. `options.html` 的 21 处内联 `style` 绕过 CSS** | 规则集圆点色（`:195-239`）、功能圆点色（`:624-659`）、`:985` 的删除账号红。这些**改 CSS 改不动**，必须改 HTML |
| **7. `shared/modal.css` 里有 `.auth-hint`** | `modal.css:27` 复用了 `options.css` 的类名。**改 options.css 的 `.auth-hint` 会影响模态框**——这是一个跨文件耦合点，且 `check.mjs` 查不出来 |
| **8. `logger.js` 的表格是单行模板字符串** | `:72` 一个 `<tr>` 挤在一行 4 个 `<td>`，改列时容易少闭合标签，且无 lint 保护 |
| **9. `options.js` 的订阅渲染是「innerHTML 拼 HTML 再 querySelector 绑事件」** | `:1416-1432`、`:1474-1484`。改结构时若改了 `data-update` / `data-remove` / `data-preset-add` 属性名，**要同时改拼接处和 `:1436` / `:1454` / `:1485` 的选择器** |
| **10. `popup.js` 的 2 秒轮询会覆写开关** | 已用 `__pending` 标志防住（`popup.js:92` / `:425` / `:427` / `:500` / `:668`）。**新增开关时若忘了加 `__pending` 保护，用户点击会被 2 秒后的轮询「弹回去」** |

### D.4 正式安装版下拿不到数据的 UI 元素

**根因**（`background.js:1790-1800` 有完整说明）：Chrome 官方文档明确 `declarativeNetRequestFeedback` 权限「is ignored for extensions installed from the Chrome Web Store」。因此 `onRuleMatchedDebug` 在商店安装版**永不触发**（`background.js:1700` 的 `if` 走不进，`:1787` 打印「不可用」）。

**影响链**：`stats.total` / `stats.byPage` / `stats.byBlocked` / `stats.byCategory` / `stats.byDate` / `stats.byHour` / `stats.recentLogs` 的**唯一写入点**是 `onRuleMatchedDebug` 回调内的 `background.js:1733-1776`。该回调不触发 → 这些字段永远为空。

**受影响的具体 UI 元素**：

| 界面 | 元素 | 正式安装版表现 | 依据 |
|---|---|---|---|
| **popup** | `#statTotal`（累计拦截） | **恒 0** | `popup.js:418` 取 `stats.total`，写入点在 `background.js:1733` |
| **popup** | `#siteCount` | 已 `hidden`，不显示 | `popup.html:78` |
| **popup** | `#catRow`（分类 chips） | **空**（`byCategory` 无数据） | `popup.js:262-274` |
| **popup** | 圆环 `.seg-*` 5 段 | **全空**（走 `byCategory`） | `popup.js:405` → `renderWheel` |
| **popup** | `#statSite`（本站已拦截） | **可用** ✅ | 正式版走 `getTabStats` → `getMatchedRules`（activeTab 授权），`popup.js:332-343` |
| **popup** | `#statsNote` 提示条 | **显示**（`hidden = stats.live === true`，正式版 `live` 恒 false） | `popup.js:412` |
| **logger** | `#totalCount`（累计拦截） | **恒 0** | `logger.js:34` |
| **logger** | `#logCount`（日志条数） | **恒 0** | `logger.js:36` |
| **logger** | 表格 `#logBody` | **空**（`recentLogs` 无数据） | `logger.js:35` |
| **logger** | `#statsNote` 提示条 | **显示** | `logger.html:33` / `logger.js:39` |
| **options** | `#repTotal`（累计拦截） | **恒 0** | `options.js:603` |
| **options** | `#repPages`（访问过的站点） | **恒 0** | `options.js:604` |
| **options** | `#repDomains`（拦截的域名） | **恒 0** | `options.js:605` |
| **options** | 趋势图 `#trendSvg` | **空**（显示「暂无数据」） | `options.js:862-872` |
| **options** | 占比条 `#distBar` / `#distLegend` | **空** | `options.js:666-668` |
| **options** | 站点排行 `#pageBars` | **空**（显示「暂无数据」） | `options.js:691-692` |
| **options** | Top 域名 `#trackerBars` | **空** | `options.js:570-572` |
| **options** | `#reportStatsNote` 提示条 | **显示** | `options.js:599` |
| **options** | 网站页各站点的「已拦截 N」 | **恒 0** | `options.js:422` / `:431` 取 `byPage` |

**⚠ 与提示文案不符的一处（需进一步确认）**：

`options.html:428` 的 `#reportStatsNote` 文案写的是：

> 「提示：正式安装版通过 getMatchedRules 统计，**「累计拦截 / 访问过的站点 / 各类型占比」可用**；「拦截的域名」与趋势图需要请求级明细……」

但**代码事实是**：`options.js` 的 `renderReport()`（`:588-709`）**只读 `stats`**（来自 `getStats` 消息），**全项目没有任何一处调用 `getTabStats`**（已 grep 验证：`getTabStats` 只出现在 `background.js:1001` / `popup.js:334` / `shared/config.js:76`）。

而 `getStats` 返回的是 `__statsBuffer`，其内容依赖 `onRuleMatchedDebug` 写入 → **正式安装版下 `options.js` 的统计页整体为空**，包括文案声称「可用」的「累计拦截 / 访问过的站点 / 各类型占比」。

→ **结论：设置页的「拦截统计」面板在正式安装版下实际拿不到任何数据**，与它自己的提示文案矛盾。`popup.js` 有 `getTabStats` 降级路径，设置页没有。**这是一个待确认的缺陷**（文案在描述一个已实现但不适用于本面板的机制）。

**正式安装版下能拿到数据的 UI**：

| 元素 | 数据来源 |
|---|---|
| popup `#statSite` / 圆环 / chips | `getTabStats` → `getMatchedRules({tabId})`，靠用户点击扩展图标授予的 activeTab（`background.js:1821-1843`）。**配额 20 次/10 分钟**，popup 已做 60 秒冷却（`popup.js:293-306`） |
| popup 全局开关 / 规则集开关 / 通知开关 | `adshield_settings`，正常 |
| options 全部开关 / 规则 / 白名单 | `adshield_settings` + background 消息，正常 |
| probe 页全部数据 | 直接调 `chrome.declarativeNetRequest` API，**不受权限影响** |
| 工具栏 badge 数字 | `updateBadgeForTab`（`background.js:312-345`）读 `stats.byPage` → **正式安装版恒空**（badge 不显示数字） |

---

## 附录：UI 层单一真源速查

| 东西 | 唯一真源 | 不该在哪 |
|---|---|---|
| 设置项默认值 | `shared/config.js:16-31` `DEFAULT_SETTINGS` | `background.js` / `options.js` / `popup.js`（`check.mjs:170-180` 强制） |
| 消息类型常量 | `shared/config.js:64-93` `MSG` | 各文件裸写字符串 |
| 规则集定义 + 分类色 | `shared/config.js:34-49` `RULESETS` / `CATS` | `options.html` 内联 style、`options.js` `TREND_CATS` |
| HTML 转义 | `shared/dom.js:12-17` `escapeHtml` | `options.js` / `logger.js` / `auth.js` 自带实现 |
| 文件下载 | `shared/dom.js:29-54` | 各文件自己写 Blob + `createObjectURL` |
| host 归一化 / 子域匹配 | `shared/host.js` | 任何其它文件（`check.mjs:132-155` 强制） |
| 模态框 | `shared/modal.js` + `shared/modal.css` | 各页自己写 overlay |
| 主题应用逻辑 | `shared/theme.js` | 各页自己读 `prefers-color-scheme` |
| 校验纯函数 | `shared/validate.js` | `shared/auth.js`（`check.mjs:194-209` 强制） |

**新增 UI 代码前必跑的检查**：`node tools/check.mjs`
