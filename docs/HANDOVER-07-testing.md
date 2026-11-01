## 七、测试与上线门禁

> 本章由钱准（测试工程师）产出。所有结论标注了依据：
> **【实测】** = 本机跑过命令/脚本得到的结果；**【读码】** = 从代码读出的事实；
> **【推断】** = 基于前两者的推理，尚未直接验证。
>
> 本轮验证环境：Windows 10 x64 + Chrome 156.0.8078.74 + 扩展 2.9.96，Node v22.22.2。

### 7.0 基线：本轮门禁跑出来的实际结果

```bash
npm run verify
```

**【实测】2026-11-01 全部通过**：

| 命令 | 结果 |
|---|---|
| `npm run check`（静态校验） | 0 错误，1 警告（`popup.js` 引用 HTML 中不存在的 id `featureList`，但已有空值保护 —— `popup.js:127-128` 的 `if (!fl) return;`，属有意为之，「功能」分区已从 popup 移除） |
| `node tools/test-host.mjs` | 27 通过 / 0 失败 |
| `node tools/test-rules.mjs` | 19 通过 / 0 失败（新增 `shouldSkipSubmit` 语义断言）|
| `node tools/test-validate.mjs` | 103 通过 / 0 失败（新增 rulesets 空映射表断言）|
| 合计 | **149 项断言全通过**（12:29 复验：test-host 27 + test-rules 19 + test-validate 103）|
| `node --check` 全部 JS | 17 个文件全部通过（REVIEW 报告写的是 15 个，现已增至 17） |
| 全部 JSON 解析 | 8 个文件全部通过（manifest + 5 个规则集 + 2 个 locales） |
| `node tools/probe-cdp.mjs` | **可跑通**，实测：动态规则上限 30,000 / 会话 5,000 / 正则 1,000 / 可启用静态规则集 50 / getMatchedRules 配额 20；已启用规则集 5 个；动态规则占用 0；`getMatchedRules()` 可用；端到端自检三项全过（静态规则命中 ruleId 100 / content script 已注入 / URL 参数清理后为 `https://example.com/`）；默认订阅 4 个 |

> `probe-cdp.mjs` **不在 `npm run verify` 里** —— 它是手动跑一次看现象的工具，
> 没有断言、没有退出码门禁。这是下面 7.1 里「端到端自检」一行的缺口。

### 7.1 测试覆盖现状评估

| # | 功能点 | 覆盖方式 | 现状与缺口 |
|---|---|---|---|
| 1 | host 归一化 + 网络/元素/UI 三层判定一致性 | **自动** | `test-host.mjs` 27 项，含 M5 原始 bug 的回归用例。覆盖充分 |
| 2 | 用户自定义规则段位上限（M3） | **自动（逻辑复刻）** | `test-rules.mjs` 覆盖了「截断到 10000 条」「最高 ID 不越段尾」「丢弃进 skipped」。**但它复刻了 `background.js` 的逻辑而不是调用真实代码**（`test-rules.mjs:13` 自述「逻辑改了，这份测试要跟着改」），实现改了测试不会红。池满时旧规则被删的真实路径无覆盖 |
| 3 | 订阅规则全局预算（M4） | **自动（逻辑复刻）** | 同上，且 `applySubscriptionText` 的解析分支（域名/例外/路径/带类型/不支持修饰符）完全无覆盖 |
| 4 | 云端数据净化 | **自动** | `test-validate.mjs` 100 项，四个 `sanitizeCloud*` 都覆盖到了。**缺口在净化之后的应用环节**（见第 12 行） |
| 5 | 静态规则 `regexFilter` 锚定 + ruleId 区间一致 | **自动** | `check.mjs` 覆盖充分 |
| 6 | DOM 契约（JS 引用的 id 必须在 HTML 中存在） | **自动** | `check.mjs` 覆盖，且能区分「裸引用」（错误）与「有空值保护」（警告） |
| 7 | 单一真源（host / 转义 / 默认设置 / 消息协议 / 校验函数） | **自动** | `check.mjs` 第 4、4b 节覆盖充分 |
| 8 | 端到端自检（静态规则真命中 / content script 注入 / URL 参数清理） | **半自动** | `probe-cdp.mjs` 能跑出真实结论（本轮已跑通），但**不在 `npm run verify` 里、无断言、无退出码**，属于「看现象」不是「守门禁」 |
| 9 | **订阅更新** | **无** | 拉取超时/失败/空内容/解析 0 条/ID 段分配/并发串行队列/孤儿清理 —— 全无自动化 |
| 10 | **统计采集** | **无** | `classifyRule` 分类口径、`url_clean` 不计入 total、`byDate` 365 天 / `byHour` 48 小时截断、`recentLogs` 500 条上限、`byPage`/`byBlocked` 200 条截断 —— 全无自动化 |
| 11 | **白名单暂停（网络层）** | **半自动** | host 判定有测试；`syncSiteAllowlist` 产出的规则形态、`pausedUntil` 过期清理、`globalPausedUntil` 到期自动恢复 —— 无覆盖 |
| 12 | **云端数据污染的拒绝行为** | **无** | `applyCloudData` 的「全都不合法就保留本地」兜底（`auth.js:2007` 的 `wiped`）只覆盖数组字段，**`settings.rulesets` 不在其列**。**本轮实测发现真实缺陷，见 7.6** |
| 13 | **云端同步冲突** | **无** | 冲突询问弹窗、「保留本地」分支、`CLOUD_NEWER` 跳过自动上传、拉取后 8 秒抑制回环窗口 —— 全无自动化 |
| 14 | **账号登录注册** | **部分** | 密码策略 / 邮箱格式 / 错误翻译（纯函数）在 103 项里；**登录失败锁定计数（MAX_FAILS）、会话 30 天有效期、refresh_token 单例刷新、401 重试一次** —— 无覆盖 |
| 15 | **元素拾取器** | **无** | `buildSelector` 选择器生成、「规则本体只由 background 写」（M6 修复）的落地 —— 无覆盖 |
| 16 | **正式版统计降级** | **无** | 未打包模式实测过（`live: true`，明细齐全）；**打包版从未实测**，REVIEW 报告第 1018-1021 行自己也承认「仍未实测」 |
| 17 | 打包产物 | **半自动** | `pack.ps1` 会校验 CRX 里的扩展 ID 与 `-ExpectedId` 一致，不符即中止；但 **zip 内容未与工作区逐字节比对**，且 **`pack.ps1` 本身不调用 `npm run verify`** —— 打包没有前置门禁 |
| 18 | 反拦截规避（双 world 伪装） | **无** | REVIEW 已列为待办，需真实反拦截站点验证 |

**一句话结论**：**纯函数层（净化、host、预算）覆盖到位；编排层（订阅更新、统计采集、云端应用、同步冲突、拾取器）几乎裸奔。**
本轮修的 6 个 Major 里，M3/M4 的**逻辑**有测试护栏，M1/M2/M5/M6 的**集成效果**没有。

### 7.2 核心闭环测试用例

> 每条预期结果都是可判定的（看得到具体值 / 具体规则 / 具体文案），不含「正常工作」这类表述。
> 「验证方式」：**自动** = 可写成脚本断言；**手动** = 需人操作并肉眼确认（但判定点已量化）。

#### A 组：拦截与放行闭环

| 编号 | 场景 | 操作步骤 | 预期结果（可判定） | 验证方式 |
|---|---|---|---|---|
| TC-A1 | 静态规则真命中 | 1. 未打包模式加载扩展 2. 访问 `https://ad.doubleclick.net/` 3. 查 `getMatchedRules()` | 返回 ≥1 条命中记录；其中 `ruleId` 落在 `STATIC_RULE_SETS` 的 ads 区间（100）内；`rulesetId` 为 `ads` | **自动**（probe-cdp 已实现此断言逻辑） |
| TC-A2 | 静态规则启用状态与实际拦截一致 | 1. 设置页关掉 `ads` 规则集 2. 访问 `https://ad.doubleclick.net/` 3. 查命中 | `getEnabledRulesets()` 不含 `ads`；该域名**不再出现在**命中记录里。**不能只验证「规则集已禁用」**——规则集编译成功≠功能在跑（LRN-20261031-002） | **自动** |
| TC-A3 | URL 参数清理生效 | 1. 访问 `https://example.com/?utm_source=probe_test` 2. 读最终 `location.href` | 最终 URL **不含** `utm_source=`；实测值形如 `https://example.com/` | **自动**（probe-cdp 已实现） |
| TC-A4 | URL 清理不计入拦截总数 | 1. 访问带 utm 的 URL 2. 读 `getStats().total` 与 `byCategory[host].url_clean` | `url_clean` 分类计数 ≥1，但 `total` **不含**这一次（重定向不是拦截）。圆环上也不出现 URL 档（`popup.js:400` 显式 `delete wheelCats.url_clean`） | **自动** |
| TC-A5 | 全局暂停放行一切 | 1. `toggleGlobal(false)` 2. 查动态规则 | 存在 `id === 2000000` 的规则，`action.type === "allow"`，`priority === 10000`，`condition.urlFilter === "*"`。**【实测】确认这四个值全部一致** | **自动** |
| TC-A6 | 全局恢复移除放行规则 | 1. `toggleGlobal(true)` 2. 查动态规则 | `id === 2000000` 的规则**不存在**。**【实测】** | **自动** |
| TC-A7 | 站点暂停生成放行规则且 host 已归一化 | 1. `toggleSite(host="www.example.com", value=true)` 2. 查 storage 与动态规则 | storage 的 `disabledSites` 为 `["example.com"]`（**剥 www**）；动态规则 `id >= 200000 && < 210000`，`action.type === "allowAllRequests"`，`condition.requestDomains === ["example.com"]`，`condition.resourceTypes === ["main_frame"]`。**【实测】全部一致** | **自动** |
| TC-A8 | 站点恢复清理放行规则 | 1. `toggleSite(value=false)` 2. 查动态规则 | `200000` 段规则数为 **0**。**【实测】** | **自动** |
| TC-A9 | 三层判定一致（回归 M5） | 1. 设置页加白名单 `example.com` 2. 访问 `www.example.com` 3. 分别看网络层放行 / 元素层是否隐藏 / 弹窗是否显示已暂停 | 三处**同时**表现为「已暂停」。任一处显示「未暂停」即失败 | **自动**（判定部分）+ 手动（观感） |

#### B 组：规则应用与容量闭环

| 编号 | 场景 | 操作步骤 | 预期结果（可判定） | 验证方式 |
|---|---|---|---|---|
| TC-B1 | 用户规则正常生效 | 1. 设置页保存 `\|\|example.com^` 2. 访问 `https://example.com/` | `adshield_user_rules` 长度 1；`adshield_user_rules_result.result.applied === 1`；`skipped` 为空；动态规则 `100000~109999` 段有 1 条 | **自动** |
| TC-B2 | 用户规则段位上限（M3） | 1. 保存 15000 条规则 2. 读结果 | `applied === 10000`；`skipped.length === 5000`；首条 skipped 的 `reason` 含「超出本段规则上限 10000 条」；动态规则该段恰好 10000 条且**最高 id < 110000**。**【实测】** | **自动** |
| TC-B3 | **动态规则池接近上限时的行为** | 1. 把池子灌到 29,995 / 30,000 2. 通过设置页保存 2 条新用户规则 3. 读结果与动态规则 | **已修复并复验 PASS**（修复前实测为 FAIL，见 7.6 第 1 条）。实测：旧规则 5→5 保住、池总数不变、skipped 有内容。期望：①`applied === 0` 且 `skipped` 覆盖全部未应用条目；②**原有的用户规则不得被删除**（`100000` 段条数不变）；③storage 与 DNR 一致。**用 `node tools/probe-pool-full.mjs` 一键复验（退出码 0 = 通过）** | **自动** |
| TC-B4 | 订阅更新成功 | 1. 设置页点「立即更新」 2. 读结果 | 4 个默认订阅全部 `ok`；`lastCount` 分别为 565 / 601 / 802 / 845；动态规则订阅段（300000~1299999）共 **2813** 条。**【实测】** | **自动**（依赖网络，可用本地 fixture） |
| TC-B5 | 订阅源返回错误页 | 1. 订阅 URL 指向一个返回 HTML 的地址 2. 点更新 | `ok === false`，`error` 含「未解析出任何可用规则」；**该订阅原有的规则一条都不能少**（`background.js:812-814` 的保护：解析为 0 条时不下发） | **自动**（fixture） |
| TC-B6 | 订阅 ID 段不越界 | 1. 订阅数加到 99 个 2. 更新 | 每个订阅占用的 ID 段互不重叠（`SUB_RULE_BASE + id%100 * 10000`）；无规则 id 落在段外 | **自动** |
| TC-B7 | 订阅更新失败不清空旧规则 | 1. 让订阅源返回 500 2. 点更新 | `lastError` 被记录；**原有规则仍在 DNR 里** | **自动**（fixture） |

#### C 组：统计闭环

| 编号 | 场景 | 操作步骤 | 预期结果（可判定） | 验证方式 |
|---|---|---|---|---|
| TC-C1 | 开发模式统计采集 | 1. 未打包模式访问 `https://ad.doubleclick.net/` 2. 读 `getStats()` | `live === true`；`total >= 1`；`byPage["ad.doubleclick.net"] >= 1`；`byCategory["ad.doubleclick.net"].ads >= 1`；`byBlocked` 含该域名；`recentLogs.length >= 1`，首条含 `url`/`blockedHost`/`cat`。**【实测】全部满足** | **自动** |
| TC-C2 | 分类口径正确 | 1. 触发一条静态 ads 规则与一条 url_clean 规则 2. 看分类 | ads 进 `byCategory.ads`；url_clean 进 `byCategory.url_clean` 且**不计入 total** | **自动** |
| TC-C3 | **正式安装版 vs 未打包模式的统计能力差异** | 1. 打包并安装 CRX 2. 访问带广告的站点 3. 打开弹窗 / 报告页 / 日志页 | 正式版**只有**「本站已拦截」计数（`getTabStats` 路径，走 activeTab 授权）；**被拦域名、逐条日志、趋势图（byDate/byHour）必须为空**，且 UI 上有明确的降级说明文字（`statsNote` 可见，`live !== true`）。**未打包模式则四者齐全。** 本条是平台限制，**不是 bug，不要去「修」它** | 手动（须装 CRX；**本轮未实测，见 7.6 第 3 条**） |
| TC-C4 | `getTabStats` 分类口径 | 1. 未打包模式访问广告站点 2. 调 `getTabStats(tabId)` | `ok === true`；`total >= 1`；`byCategory` 只含 `ads`（动态规则一律归 ads）；`count` ≥ `total`。**【实测】`{"ok":true,"total":1,"byCategory":{"ads":1},"count":1}`** | **自动** |
| TC-C5 | 统计截断上限 | 1. 造 >200 个域名 / >365 天 / >48 小时 / >500 条日志 2. 读 `getStats()` | `byPage` / `byBlocked` 各 ≤ 200 条；`byDate` ≤ 365 天；`byHour` ≤ 48 小时；`recentLogs` ≤ 500 条 | **自动** |
| TC-C6 | 日志清空同时清内存（M2 回归） | 1. 造若干日志 2. 日志页点「清空」 3. 等 10 秒再看 | 日志表为空；**等待后不反弹**。若反弹说明只清了 storage 没清 `__statsBuffer` | **自动** |
| TC-C7 | badge 计数与站点统计一致 | 1. 访问带广告站点 2. 看工具栏 badge 3. 对比弹窗「本站已拦截」 | 两者数字相同；`> 999` 时显示 `999+` | 手动 |

#### D 组：白名单与元素层闭环

| 编号 | 场景 | 操作步骤 | 预期结果（可判定） | 验证方式 |
|---|---|---|---|---|
| TC-D1 | 白名单暂停到期自动恢复 | 1. 设置站点暂停 1 分钟 2. 等待到期后不手动操作 3. 查动态规则 | 到期后 `200000` 段的该站放行规则**自动消失**，无需刷新页面 | **自动**（可缩短时长） |
| TC-D2 | 白名单去重 | 1. 分别加 `example.com` 与 `www.example.com` 2. 查 storage | `disabledSites` 长度为 **1**（归一化后去重） | **自动** |
| TC-D3 | 元素隐藏层随白名单关闭 | 1. 加白名单 `example.com` 2. 访问 `www.example.com` 3. 检查注入的样式 | 元素隐藏样式**不注入**（`#__adshield_cosmetic__` 不存在或不含该选择器） | **自动** |
| TC-D4 | 元素拾取器生成可用规则 | 1. popup 点「隐藏内容块」 2. 点页面某元素 3. 选「所有站点」 4. 刷新 | `adshield_user_rules` 新增一条形如 `##.xxx` 的规则；刷新后该元素被隐藏；**规则只被写一次**（`picker.js` 不得自己 `storage.set` 再发消息，否则同批规则被重写两遍 —— M6 修复点） | 手动 |
| TC-D5 | 拾取器规则跨站不生效 | 1. 拾取器选「仅本站」 2. 换到另一个域名 | 元素**不被**隐藏（域名前缀生效） | 手动 |

#### E 组：账号与云端闭环

| 编号 | 场景 | 操作步骤 | 预期结果（可判定） | 验证方式 |
|---|---|---|---|---|
| TC-E1 | 注册密码策略 | 1. 注册页输入弱密码 2. 点注册 | 逐条被拒并给出**具体**原因：`<8 位` / `需含至少 1 个大写字母` / `需含至少 1 个小写字母` / `需含至少 1 个数字` / `密码过于简单，请更换` / `不能超过 128 位`。不得只说「密码不合规」 | **自动**（已在 100 项里，但需补「UI 实际显示的就是这句话」这一层） |
| TC-E2 | 连续登录失败锁定 | 1. 连续输错密码至阈值 2. 再用正确密码登录 | 达阈值后报「账号已锁定，请 N 分钟后重试」；**正确密码也不放行**；锁定期满后恢复 | **自动**（需 stub `sbRequest`） |
| TC-E3 | 断网不被误判为登录过期 | 1. 断网 2. 点同步 | 提示「网络不可用，未同步」；**登录态保留**（不是「登录已过期」） | **自动**（需 stub fetch） |
| TC-E4 | 上传/拉取往返一致 | 1. 本地改规则集开关 2. 上传到云端 3. 换设备拉取 | 拉取后规则集开关与上传前**逐项相同** | 手动 |
| TC-E5 | **云端数据被污染时的拒绝行为** | 1. 直接改云端行：`settings.rulesets` 全部填非布尔值；`whitelist.disabledSites` 填非法主机名；`user_rules` 填含 `##.ad{color:red}` 的行；`subscriptions` 填 `http://` 开头的 URL 2. 在另一台设备拉取 | ① 含 `{` `}` `@` `/*` 的选择器被拒、**不进入**本地 `adshield_user_rules`；② `http://` 订阅被拒；③ 非法主机名被拒；④ 全部条目被拒的字段**保留本地原值**；⑤ 拒绝项在 console 有汇总且计数正确。**本条第 ④ 项已修复并复验 PASS**（修复前 FAIL，见 7.6 第 2 条）：全非法 → 本地保留；全 false → 正常覆盖 | **自动**（纯函数层已覆盖；应用层需补） |
| TC-E6 | 同步冲突不静默覆盖 | 1. A 设备改配置并上传 2. B 设备改配置后点上传 3. 观察 | 弹「上传会覆盖云端」确认框；**未确认则不上传**且提示「已取消，本地未上传」 | 手动 |
| TC-E7 | 本地比云端新时不被动覆盖 | 1. 本地改动未上传 2. 拉取云端 | 弹「本地与云端冲突」框；选「保留本地」后提示「已保留本地，未做改动」，**不得**报「同步成功」 | 手动 |
| TC-E8 | 拉取不回环覆盖云端 | 1. 拉取云端 2. 观察 8 秒内是否触发自动上传 | 拉取后 8 秒抑制窗口内**不自动上传**（`suppressAutoUpload(8000)`），避免把校验丢弃的条目反写回云端 | **自动**（需 stub fetch + 计时） |

#### F 组：平台限制场景（**必测，且不得当作缺陷去「修」**）

| 编号 | 场景 | 操作步骤 | 预期结果（可判定） | 验证方式 |
|---|---|---|---|---|
| TC-F1 | 正式安装版无请求级明细 | 1. 安装打包 CRX 2. 访问带广告站点 3. 看报告页与日志页 | 「被拦域名」「详细日志」「趋势图」**为空**；UI 有明确说明文字解释原因（feedback 权限对商店安装版被忽略）。**这是平台限制** | 手动（**本轮未实测**） |
| TC-F2 | 正式版「本站已拦截」可用 | 1. 正式版打开弹窗 2. 看「本站已拦截」 | 数字 **≥ 0 且随实际拦截增长**（走 activeTab + `getMatchedRules({tabId})`）；不因限流而报错 | 手动（**本轮未实测**） |
| TC-F3 | 反馈 API 不可用时降级而非报错 | 1. `onRuleMatchedDebug` 不存在时加载扩展 | background 打印「onRuleMatchedDebug 不可用」；**扩展不崩**，统计页显示降级说明 | **自动**（`chrome.declarativeNetRequest.onRuleMatchedDebug` 为 undefined 时） |
| TC-F4 | `getAvailableConstants()` 不存在 | 1. Chrome 156 上探测该 API | `typeof === "undefined"`；**代码不得因此崩溃**，须回落到直接读 API 对象上的 `MAX_*` 常量 | **自动**（probe.js 已实现两种取法） |
| TC-F5 | `updateDynamicRules` 整批原子性 | 1. 池子灌到 29,900 2. 一次提交 200 条 | 抛错「Dynamic rule count exceeded.」；**规则总数一条不变**（仍 29,900，不部分生效）。**【实测】确认整批拒绝** | **自动** |
| TC-F6 | 同 ID 同时出现在 remove 与 add | 1. 一次调用中 `removeRuleIds:[X]` 且 `addRules` 含 `X` 2. 查规则 | **Chrome 156 实测：接受，规则存在**。⚠️ `docs/ARCHITECTURE.md` §二第 1 条称此写法「不可靠、必须拆成两次调用」——**该结论与本机实测不符**（`background.js` 的 `applyUserRules`/`applySubscriptionText` 用的正是单次调用形式，实际工作正常）。**文档需按实测修订，不要据此「修」代码** | **自动** |

### 7.3 上线前检查单（12 项）

> 逐项勾选。**任何一项为 ☐ 或 ✗，不得发布。**
> 每项写明「怎么验」——必须是能跑出明确结论的命令或可观察现象。

| # | 检查项 | 怎么验 | 判定标准 | 状态 |
|---|---|---|---|---|
| 1 | **静态校验与单元测试全绿** | `npm run verify` | 退出码 0；check 0 错误；149 项断言 0 失败。**check 的每条警告都要逐条看过并确认是有意为之**（当前 1 条：`popup.js` 的 `featureList`，已确认有意） | ☐ |
| 2 | **规则集 ID 与锚定一致** | `node tools/check.mjs` | `rules/*.json` 的每个 ruleId 落在 `STATIC_RULE_SETS` 区间内；所有 `regexFilter` 以 `^` 开头 `$` 结尾；redirect 规则带 `redirect` 字段 | ☐ |
| 3 | **端到端自检三项通过** | `node tools/probe-cdp.mjs` | 输出中：静态规则命中 ✓、content script 已注入 ✓、URL 参数清理生效 ✓。**三项任一为 ✗ 立即停止发布** | ☐ |
| 4 | **动态规则占用有余量** | 同上，看「当前规则占用」 | 占用率 **< 90%**。≥90% 时新增订阅或规则会触发整批失败（probe-dnr 会直接标红） | ☐ |
| 5 | **反馈 API 状态已记录** | 同上，看「请求级反馈可用性」 | 记录 `getMatchedRules()` 是否可用、`onRuleMatchedDebug` 是否存在。**两种模式结果不同是正常的，但发布说明里必须写清楚正式版的能力边界** | ☐ |
| 6 | **生产配置与开发配置一致** | 人工比对 `src/shared/auth.js` 顶部的 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 与生产环境 | 域名、key、项目 ID 三项全对；**不得有 test/prod 混用** | ☐ |
| 7 | **敏感配置不在项目目录** | `ls -la .keys/` + `find . -name "*.pem" -o -name "*.key"` | 项目目录内**只有公钥**（`derived-public.pem`）；私钥必须在 `D:\AdShield-Keys\adblocker.pem` 或 `ADSHIELD_KEY` 指向的路径。**`pack.ps1` 找不到 key 会直接失败，这是好设计，不要绕过** | ☐ |
| 8 | **打包产物内容正确** | 解压 `adblocker-v<版本>.zip` 后与 `adblocker/` 目录**逐文件比对**（大小 + 哈希） | 文件数一致（参考：2.9.96 为 31 项）；**不含** `_metadata/`、不含 `tools/`、`package.json`、`pack.ps1`；`rules/` 与 `src/` 齐全 | ☐ |
| 9 | **扩展 ID 与预期一致** | `.\pack.ps1 v<版本> -ExpectedId gbkfkgfigndbbbdaiffebegiiddoikin` | 脚本打印的 ID 与 `-ExpectedId` **完全相同**；ID 变了 = 换密钥 = 老用户收不到更新，**立即停止** | ☐ |
| 10 | **manifest 版本号已更新** | 打开 `adblocker/manifest.json` 看 `version` | 与发布版本号一致（`pack.ps1` 会自动改写，但改完要**再确认一次**，别信脚本） | ☐ |
| 11 | **核心闭环人工过一遍** | 未打包模式加载扩展，手动走：①访问带广告站点看拦截 ②暂停本站看三层同时放行 ③加一条 `\|\|example.com^` 看生效 ④拾取器点一个元素 ⑤设置页「立即更新」订阅 | 五步**全部**达到 7.2 中对应用例的预期结果。**尤其第 ④⑤ 步，自动化覆盖为 0，只能靠人** | ☐ |
| 12 | **回滚方案已就绪** | 见下方回滚模板 | 出问题后 **10 分钟内能回到上一版**。⚠️ **本项目是「工作区 + git 仓库」两个目录**（见下方），回滚**有两条路**：git 回退（快，但要先同步仓库→工作区）+ 重打包上一版（兜底）。**两条都要事先演练过** | ☐ |

#### 回滚方案模板

> ⚠️ **本项目是「两个目录」结构**（2026-11-01 实测纠正）：
>
> | 目录 | 角色 |
> |---|---|
> | `D:\AdShield 广告拦截器\` | **工作区**，打包源（`pack.ps1` 从这里打 CRX/ZIP），代码实际编辑处 |
> | `D:\temp-adshield-repo\` | **git 仓库**，发布用的 git 历史在这里 |
>
> **工作区本身不是 git 仓库**（在 `D:\AdShield 广告拦截器` 里跑 `git rev-parse` 会报
> `not a git repository`）—— 但**这不代表没有版本控制**，仓库在另一个目录。
> 回滚命令要 `cd D:\temp-adshield-repo` 执行。
>
> **同步用 `tools/sync-repo.mjs`**（工作区 → 仓库，含逐字节校验）。别手工 cp。

```
回滚步骤：
1. 留档（发布前就做，不是出事后再找）
   上一版 zip: adblocker-v<上一版本>.zip        ← 必须事先留档
   上一版 crx: adblocker-v<上一版本>.crx        ← 必须事先留档
   上一版 commit: cd D:\temp-adshield-repo && git log --oneline -1
   预计时间：0 分钟

2. 代码回滚 —— 路线 A：git 回退（推荐，3 分钟）
   cd D:\temp-adshield-repo
   git log --oneline -5                       ← 找到要回退到的 commit
   git checkout <上一版 commit> -- adblocker/  ← 只回退扩展源码
   然后把仓库内容同步回工作区，再重打包
   预计时间：3 分钟（含同步 + 打包）
   注意：只回退 adblocker/，不要动 docs/ 与 tools/

3. 代码回滚 —— 路线 B：重打包上一版源码（兜底，5 分钟）
   git checkout <上一版 commit> -- adblocker/
   把这份 adblocker/ 覆盖回工作区
   .\pack.ps1 <上一版本> -ExpectedId gbkfkgfigndbbbdaiffebegiiddookin
   预计时间：5 分钟
   注意：pack.ps1 会改写 manifest.json 的 version，跑完记得改回来

4. 数据回滚
   本扩展数据全在用户本地（chrome.storage.local），扩展本身不存用户数据，
   因此**没有数据回滚这一步**。唯一要确认的是：用户自己写的自定义规则
   不会因为换版本而丢失（存储键名未变，跨版本保留）。

5. 验证
   检查点：node tools/probe-cdp.mjs 三项自检全过
   预计时间：2 分钟

总预计回滚时间：约 5~10 分钟（路线 A 更快）
```

### 7.4 本轮改动的验收标准

> 针对「全量代码审查 + 修复 + 重构 + 新增诊断工具」这一轮。
> 每条都写成**能判定通过/不通过**的形式。

#### 7.4.1 六个 Major 修复的验收

| 编号 | 验收标准（可判定） | 当前状态 |
|---|---|---|
| AC-M1 | **正式安装版统计**：正式版下「本站已拦截」有值；被拦域名/逐条日志/趋势图为空且 UI 有降级说明；未打包模式四项齐全；`stats.live` 判定在三处（popup/options/logger）**完全一致**（统一为「只有 `live === true` 才隐藏提示」） | ⚠️ **未打包模式已实测通过；正式安装版本轮未实测**（需装 CRX，见 7.6 第 3 条） |
| AC-M2 | **日志清空**：`clearLogs` 消息走 background；同时清 `__statsBuffer` 与落盘；清空后等待 10 秒日志**不反弹** | ✅ 代码已改，**清空后不反弹的行为无自动化断言**（TC-C6 待补） |
| AC-M3 | **用户规则段位上限**：超过 10000 条时截断到段内（最高 id < 110000）；丢弃条目进 `skipped` 且 reason 可读；用户能看见被丢了多少 | ✅ **实测通过**（15000 条 → applied 10000 / skipped 5000） |
| AC-M4 | **订阅全局预算**：单订阅产出超过全局剩余额度时截断并把丢弃数回传；**截断到空时不下发**（保留该订阅原有规则，不清空） | ✅ 预算逻辑**实测通过**（50000 → 29950，池满 → 预算 0 走「未能应用」分支）。⚠️ 真实 `applySubscriptionText` 的解析分支无自动化 |
| AC-M5 | **host 归一化单一真源**：`shared/host.js` 是唯一实现，7 个文件接入；三层判定（网络/元素/UI）在「存裸域、访问 www」场景下**同时**判定为暂停 | ✅ **实测通过**（27 项断言 + 三层一致性用例） |
| AC-M6 | **拾取器不重复写**：`picker.js` **不得**自己 `storage.set("adshield_user_rules")`；规则本体只经 `saveUserRules` 消息由 background 写；同批规则**不被全量重写两遍** | ✅ 代码已改（`picker.js:266` 只发消息）。⚠️ **行为无自动化断言**（TC-D4 待补） |

#### 7.4.2 重构类改动的验收

| 编号 | 验收标准（可判定） |
|---|---|
| AC-R1 | **单一真源收敛**：`npm run check` 确认——`normalizeHost`/`isValidHost` 只在 `shared/host.js`；`escapeHtml` 只在 `shared/dom.js`；`DEFAULT_SETTINGS` 只在 `shared/config.js`；`MSG.*` 使用方均从 `adshieldConfig` 解构；`sanitizeCloud*`/`isSafeUserRule` 只在 `shared/validate.js`。**新增第二份实现必须让 check 报错** |
| AC-R2 | **消息协议单一真源**：`MSG` 常量在 `shared/config.js` 定义；background 每个消息类型都有对应分支；**未知类型返回 `{ok:false, error:"unknown type"}` 而不是静默无响应** |
| AC-R3 | **共享模块可独立测试**：`shared/validate.js` 的 14 个导出函数可在 Node 里直接加载调用（不碰 chrome/DOM），`test-validate.mjs` 覆盖到其中每一个。**当前 100 项已覆盖全部导出函数** ✅ |
| AC-R4 | **页面脚本加载顺序**：每个扩展页面的 `<script>` 顺序满足「被依赖者在前」；`logger.html` 的 `modal.js` 排在 `logger.js` 之前。`check.mjs` 第 5 节校验 logger 这一条，其余页面顺序**无自动校验** |

#### 7.4.3 新增诊断工具的验收

| 编号 | 验收标准（可判定） |
|---|---|
| AC-T1 | `node tools/probe-cdp.mjs` **一条命令、零手工操作**完成采集与解读；自启独立 Chrome 实例（临时 profile），**不碰用户日常浏览器**；结束后自动清理 profile |
| AC-T2 | 解读输出必须回答三个问题：①DNR 上限各是多少 ②当前占用多少、按段位怎么分布 ③**功能真的在跑吗**（静态命中 / content script / URL 清理）。第 ③ 项是 LRN-20261031-002 的核心 |
| AC-T3 | `node tools/probe-dnr.mjs <probe.json>` 能离线解读一份已采集的 JSON；占用率 ≥90% 时明确标红 |
| AC-T4 | 探测到 `getAvailableConstants()` 不存在时**不报错**，回落到直接读 API 对象上的 `MAX_*` 常量 |
| AC-T5 | **实测结论**（本机 Chrome 156）：动态 30,000 / 会话 5,000 / 静态规则集总数 100 / 可启用 50 / 正则 1,000 / getMatchedRules 配额 20。**这些数字要写进文档，且注明「以实测为准」** |
| AC-T6 | 探测工具**不污染用户环境**：不改动用户的 `chrome.storage.local`；本次实测用临时 profile，采集结果中「本扩展设置」显示订阅数 4 / 白名单数 0，即全新 profile 的初始状态 |

### 7.5 建议补的自动化测试（按性价比排序）

> 排序依据：**缺陷复现概率 × 修复成本 ÷ 实现成本**。
> 每条给出建议文件、测试点、断言方向（不写完整代码）。

#### 优先级 P0 —— ~~覆盖本轮已发现的真实缺陷~~ → **已由他人落地**，转为「验证护栏」

> 两条 P0 缺陷已由他人修复（12:13~12:20），我复验 PASS。
> 原来的「补测试」需求变成「**确认防线不会被静默改掉**」——下面 ⑨ 记录了实测结果：
> **纯 grep 式防线会漏检**，这是选实现方案时必须知道的。

**① `tools/test-cloud-apply.mjs`（新建）**
补上 `applyCloudData` 这一层的断言——它是 103 项净化测试**与**真实用户数据之间的唯一桥梁，仍无自动化。
- 测试点：①云端 `settings.rulesets` 全为非布尔值 → **本地 rulesets 必须保留**（✅ 已由 `test-validate.mjs` 覆盖，修复后 PASS）；②云端 `rulesets` 不是对象 → 本地保留（当前 PASS）；③云端 `disabledSites` 全非法 → 本地保留（当前 PASS，走 `wiped` 分支）；④云端 `pausedUntil` 全非法 → 本地保留；⑤云端 `subscriptions` 超 20 条 → 断言截断后的条数与 `rejected` 计数；⑥云端 `user_rules` 全含 CSS 突破 → 本地保留
- 断言方向：`applyCloudData(cloud, local, prefs)` 返回的 `s.rulesets` 应 `deepEqual` 本地原值；`keptLocal` 应包含被保护的字段名；`rejected` 各项 count 精确
- 实现要点：把 `applyCloudData` 从 `auth.js` 的 IIFE 里抽成可注入的纯函数（参数化 `chrome.storage` 与 `getAuthState`），否则无法在 Node 里测
- **注意**：这一层现在仍然没有自动化，**只有纯函数层（`sanitizeCloud*`）有护栏**。
  也就是说「净化结果对了」有保证，但「净化结果被正确应用到本地」还没有。

**② `tools/probe-pool-full.mjs`（已建）**
覆盖 TC-B3：动态规则池接近上限时用户规则的存亡。这是**用户数据丢失级别**的问题。
- 测试点：①池 29,995/30,000 时保存 2 条新规则 → **原有用户规则不得被删**（✅ 已覆盖，修复后 PASS，退出码 0）；②`skipped` 必须覆盖全部未应用条目且 reason 可读；③storage 与 DNR 实际生效集**必须一致**；④池未满时行为不变（回归保护）；⑤`updateDynamicRules` 的原子语义（空 addRules = 只删不加；整批超限 = 整批拒绝）
- 断言方向：`getDynamicRules()` 里 `100000~109999` 段的条数与 id 集合；`adshield_user_rules_result.result.applied` / `.skipped`
- 实现要点：真灌 30,000 条规则代价高，**因此做成诊断工具不进 `npm run verify`**；
  退出码即结论（0 = 防线在，1 = 回归了），适合当回归工具或发布前门禁

**⑨ 防御深度的实现选型 —— 纯 grep 式防线会漏检（实测）**

修复本身没有自动护栏，于是自然的想法是「加几条 grep 检查」。我做了**变异测试**
（把防线代码删掉、只留字符串，看检查能不能发现），结论：

| 防线写法 | 变异（删掉守卫逻辑、保留字符串） | 结果 |
|---|---|---|
| `grep "POOL_FULL"` | `background.js` 里删掉 `if (addRules.length === 0 && rules.length > 0)` 守卫，字符串留在别处 | ❌ **漏检**（grep 命中，检查通过） |
| `grep "addRules.length === 0 && rules.length > 0"` | 同上 | ✅ 检出 |
| `grep "Object.keys(clean).length"` | `validate.js` 里把空映射表保护改成无条件赋值 | ✅ 检出（字符串本身被删了） |

**结论**：grep 能守住「**整个保护被删干净**」，守不住「**保护逻辑被改但文案还在**」。
后者恰恰是更可能发生的回归形态（有人为了「简化代码」把守卫改写，或把错误码挪到别处）。

**建议的选型**：
- **能提到纯函数的一律用行为断言**（`test-validate.mjs` 已有 3 条，是正确范式）
- **无法提纯函数的**（`background.js` 依赖 chrome API）→ 用**结构化检查**而不是字符串检查：
  检查守卫条件本身（如 `addRules.length === 0`），必要时配合 `tools/probe-pool-full.mjs` 做端到端确认
- **不要只 grep 一个错误码或文案** —— 它证明不了行为

#### 优先级 P1 —— 补编排层的洞

**③ 把 `test-rules.mjs` 从「逻辑复刻」改成「调用真实代码」**
- 问题：`test-rules.mjs` 自己在第 13 行写了「逻辑改了，这份测试要跟着改」——**这不是防回归，是给回归开了个口子**。M3/M4 是本轮修的两个 Major，护栏却不是真的护栏。
  新增的 `shouldSkipSubmit` 断言方向正确，但它断言的仍是**复刻里的** `shouldSkipSubmit`，
  不是 `background.js` 里那个守卫。**真实守卫被删，这 6 项断言照样绿。**
- 测试点：现有 19 项断言全部保留，改为直接调用 `background.js` 里的 `applyUserRules` / `applySubscriptionText`（同样需要抽出纯函数 + stub chrome API）
- 断言方向：断言值不变，只换执行主体

**④ `tools/test-subs-parse.mjs`（新建）**
覆盖订阅解析的分类分支——这是订阅功能的核心，自动化覆盖为 0。
- 测试点：①纯域名 `\|\|example.com^` → 拦截规则；②`@@\|\|example.com^` → **放行**规则（这条最关键：语义搞反就是「放行变拉黑」）；③路径规则 `/ads/`；④带类型的域名规则 `\|\|x.com^$image` → `resourceTypes:["image"]`；⑤不支持的修饰符（`$document`/`$third-party`/`$removeparam`）→ 跳过并计入 `skipped`；⑥`$` 出现在 URL 里但不是修饰符 → 不误判；⑦重复路径去重；⑧超长（>500 字）与通配符爆炸（>3 个 `*`）→ 过滤；⑨**解析结果为 0 条时不下发**（不清空原规则）；⑩域名/例外/路径三类混排时 ID 段分配不越界
- 断言方向：`addRules` 的 `action.type`（block vs allow）、`condition.requestDomains`、`condition.resourceTypes`；`skipped` 的分类计数

**⑤ `tools/test-stats.mjs`（新建）**
覆盖统计口径——分类逻辑复杂（`classifyRule` 5 级判定 + `byHostCat` 记忆），且正式版路径单独一套。
- 测试点：①静态 ruleId → 类别映射（100→ads、1000→tracking、2000→annoyances、3000~3028→url_clean、4000→malware）；②已知追踪器域名 → tracking；③telemetry/beacon 类域名 → tracking；④动态规则 → ads；⑤**同一被拦域名多次命中归类一致**（`byHostCat` 记忆生效）；⑥`url_clean` 不计入 `total`；⑦`byDate` ≤365 天、`byHour` ≤48 小时、`recentLogs` ≤500 条、`byPage`/`byBlocked` ≤200 条
- 断言方向：把 `classifyRule` / `staticRuleSetCat` 从 `background.js` 抽成纯函数后直接断言返回值

#### 优先级 P2 —— 补功能闭环

**⑥ `tools/test-allowlist.mjs`（新建）**
- 测试点：①`syncSiteAllowlist` 产出规则的完整形态（id 段、`allowAllRequests`、`requestDomains` 归一化裸域、`resourceTypes:["main_frame"]`）；②`example.com` 与 `www.example.com` 去重后只占一条放行规则；③过期 `pausedUntil` 被清理且对应放行规则移除；④`globalPausedUntil` 到期自动恢复（`enabled` 回到 true 且 2000000 规则移除）；⑤全局暂停时订阅规则与用户规则**同时**停用
- 断言方向：动态规则的精确集合

**⑦ `tools/test-picker.mjs`（新建）**
- 测试点：①`buildSelector` 生成的 id 选择器唯一时才用（页面上有重复 id 时降级到 class）；②class 最多取 3 个；③含非法字符的 class 被过滤；④父级回退路径；⑤**写入只发生一次**（断言 `storage.set("adshield_user_rules")` 的调用次数为 0，发出的消息为 1 次）
- 断言方向：需要 jsdom 或轻量 DOM stub；第 ⑤ 项是 M6 修复的真正护栏

**⑧ 把 `probe-cdp.mjs` 纳入发布门禁**
- 做法：在 `package.json` 加 `"verify:full": "npm run verify && node tools/probe-cdp.mjs"`，并让 `probe-cdp.mjs` 在三项自检任一失败时**以非 0 退出码结束**（当前只打印 ✗，退出码仍是 0 —— 这一点在 7.3 第 3 项被当作门禁使用时是危险的）
- 断言方向：退出码即门禁

**⑨ `tools/test-pkg.mjs`（新建）**
- 测试点：①zip 内文件清单与 `adblocker/` 目录一致（逐文件 sha256）；②不含 `_metadata/`、`tools/`、`package.json`、`pack.ps1`；③zip 内 manifest 的 version 与发布版本一致；④CRX3 头里解析出的扩展 ID 与预期一致
- 断言方向：可复用 `pack.ps1` 里那段 CRX3 解析逻辑（把它抽成脚本或 PS 模块）

#### 优先级 P3 —— 暂不建议做

- **端到端 UI 自动化（Playwright/Cypress）**：MV3 扩展的 chrome://extensions 页无法自动化；页面本身的自动化收益低于维护成本。小团队不建议引入。
- **性能压测**：本扩展没有服务端，不适用。
- **i18n 相关测试**：i18n 本身还没做（LRN-20261031-004 未闭环），做了也白做。

### 7.6 本轮实测发现的问题 —— **四条全部已修复并复验（2026-11-01 12:30 更新）**

> 以下四条都是本轮**跑出来的**，不是读码猜测。
>
> **状态更新**：四条均已在 12:13~12:20 的修复轮次中落地，我用**当前工作区**重新复现验证，
> **全部 FAIL → PASS**。修复由他人落地（赵擎同步告知），我负责验证与补护栏。
> 原始复现数据保留在下文，作为「回归了能认出来」的基准。

#### 第 1 条 · 动态规则池满时，用户已有的自定义规则会被删掉 —— ✅ 已修复并复验

**原始复现（修复前，实测）**：
1. 清空动态规则，灌到 29,995 / 30,000（上限）
2. 通过真实 `saveUserRules` 消息保存 2 条用户规则

```
poolBefore: 29995  →  poolAfter: 29990
用户规则段 100000~109999：保存前 5 条（id 100000~100004） → 保存后 0 条
applied: 0，skipped: 2，reason: "超过 Chrome 动态规则总上限 30000 条"
storage 的 adshield_user_rules: ["||n1.test^","||n2.test^"]   ← 存着，但一条都没生效
```

**机理（读码）**：`background.js` 的预算计算 `budget = max(0, 30000 - usedByOthers - 50)`，
池满时 `budget = 0`，`addRules` 被截断成空；随后仍然执行
`updateDynamicRules({ removeRuleIds: [旧的 5 条], addRules: [] })` —— **旧规则被删、新规则一条没进**。
订阅路径当时有保护（截断到空时 `return` 不下发），**用户规则路径没有** —— 两条路径行为不一致。

**修复（现 `background.js:509-519`）**：截断后为空时**直接 return，不下发**，并给出
`POOL_FULL` 错误码，界面能显示「动态规则池已满，用户自定义规则未能应用（请停用部分订阅或减少规则量）」。

**复验结果（修复后，实测，走真实 `saveUserRules` 路径）**：
```
灌池前用户规则段条数 : 5  (id [100000,100001,100002,100003,100004])
池子灌到             : 29995 / 30000
保存 2 条新规则后    :
  池总数             : 29995        ← 没变（修复前是 29990，被删了 5 条）
  用户规则段条数     : 5  (id 同上)   ← 旧规则保住了（修复前是 0）
  applied            : 0
  skipped            : 3            ← 明确回传，不是静默
```
**TC-B3 由 FAIL 转 PASS。**

#### 第 2 条 · 云端数据被污染时，`settings.rulesets` 会把本地覆盖成空 —— ✅ 已修复并复验

**原始复现（修复前，实测）**：
```
本地 rulesets = {ads:true, tracking:false, annoyances:true, url_clean:true, malware:false}
云端 settings = {rulesets: {ads:"notabool", tracking:"x"}}     ← 全是非布尔值
→ sanitizeCloudSettings 返回 settings.rulesets = {} （空对象，不是 undefined）
→ applyCloudData 执行 Object.assign(s, stRes.settings) → s.rulesets = {}
→ 再经 getSettings() 的 Object.assign({}, DEFAULT_SETTINGS.rulesets, {}) 
   → 全部回落成默认值 true
结果：用户手动关掉的 tracking 与 malware 被静默重开
```

**机理（修复前，读码）**：`validate.js` 里 `rulesets` 逐项过滤后无条件
`res.settings.rulesets = clean`（哪怕 `clean` 是空对象），于是「有内容但全非法」变成了
「一个合法的空值」。而 `auth.js` 的 `wiped` 兜底只作用于**数组字段**
（`disabledSites` / `pausedUntil` / `subscriptions` / `user_rules`），
**`settings.rulesets` 不在其列**，`Object.assign` 无条件覆盖。

**对照组（当时实测通过）**：云端 `rulesets` 是字符串 `"ads"`（非对象）时，
`res.settings.rulesets` 不被设置，本地**正常保留**。`disabledSites` 全非法时走 `wiped` 分支，
本地**正常保留**。**只有「对象且全非法」这一种形态会漏。**

**与文档的出入**：`docs/ARCHITECTURE.md` §五写的是「云端某个字段有内容但校验后一个都不剩时，保留本地原值。否则一条全非法的行就能把用户的白名单清空。」——`rulesets` 恰好落在这个承诺之外。

**修复（现 `validate.js:237-242`）**：空映射表不再被接受。

```js
if (Object.keys(clean).length) res.settings.rulesets = clean;
else res.rejected++;
```

**复验结果（修复后，实测，四种形态）**：
| 云端 rulesets | 复验结果 |
|---|---|
| `{ads:"notabool",tracking:"x"}` 对象全非法（缺陷原始形态） | ✅ 本地保留，`rejected=3` |
| `"ads"` 字符串（非对象） | ✅ 本地保留，`rejected=1` |
| `{ads:true,tracking:false}` 部分合法 | ✅ 正常覆盖 |
| `{ads:false,...}` 全 false（用户主动全关） | ✅ **正常覆盖**（这是必须保留的能力） |
| `{}` 空对象 | ✅ 本地保留，`rejected=1` |

**端到端复验（真实浏览器，走 `applyCloudData` 的覆盖逻辑）**：
```
S1 本地基线 rulesets : {ads:true, tracking:false, annoyances:true, url_clean:true, malware:false}
S2 喂污染云端行后     : {ads:true, tracking:false, annoyances:true, url_clean:true, malware:false}  ← 未被覆盖
   sanitizeCloudSettings("rulesets" in settings) = false  → 本地保留
   settingsRejected = 3
   disabledSites 走 wiped 分支 → keptLocal = ["disabledSites"]  ← 白名单也保住了
S3 getState 合并后    : {ads:true, tracking:false, annoyances:true, url_clean:true, malware:false}  ← 仍是用户设的值
```
**TC-E5 由 FAIL 转 PASS。**

**注意一个容易改坏的边界**：修复用的是 `Object.keys(clean).length`（**键数**），
而不是「值是否全 false」。必须保持这样 —— 否则「用户主动把 5 个规则集全关掉」
这种合法操作会被误判成脏数据而保留本地旧值。**这条边界已实测确认。**

#### 第 3 条 · 正式安装版的统计差异，本轮仍未实测 —— ⏳ P1 证据缺口（**唯一未闭环的一条**）

**事实（已核实）**：
- Chrome 官方权限表原文：`declarativeNetRequestFeedback` —— *"This permission is for use with
  unpacked extensions and is ignored for extensions installed from the Chrome Web Store."*
- 未打包模式**实测**：反馈 API 完全可用，`live:true`，明细齐全
- 官方文档对 `onRuleMatchedDebug` 的表述是 *"Only available for unpacked extensions with the
  declarativeNetRequestFeedback permission"* —— **关键词是 unpacked，不是「商店安装」**
- REVIEW 报告自己把「正式安装版（打包 CRX）的反馈 API 差异」列为**仍未实测**
- 本轮所有实测均在**未打包模式**下完成（`Extensions.loadUnpacked`）

**未解的问题**：本扩展的发布形态是**自签名 CRX**（用户手动安装，不走商店）。
官方文档一处按「商店安装」措辞、一处按「unpacked」措辞，**自签名 CRX 属于哪一种，
文档没有明确说明**。而 `AGENTS.md` §7 与 `REVIEW` 都已把「正式版无请求级明细」写成
**已知平台限制**并要求「别去修它」——如果这个前提对自签名 CRX 不成立，
那么**整个 M1 修复的方案前提就有问题**（UI 会一直告诉正式版用户「你看不到明细」，
而他们其实看得到；反过来如果成立，则当前实现是对的）。

**要做的**：发布前装一次 CRX 实测一次，把结论写进 `AGENTS.md` §7。
**在实测之前，「正式版无明细」这条只能算「基于官方文档的推断」，不能算已验证事实。**
**我无法在无头环境完成这一步**（装不了带签名的 CRX），需要真机 + 一次 CRX 安装。

#### 第 4 条 · `adshield_user_cosmetic` 有第二个写入者 —— ✅ 已修复

**原始事实（修复前，读码）**：`AGENTS.md` §0「六条硬性约定」下的第 1 条「Storage 键的单一写入者」表声明
`adshield_user_cosmetic` 的唯一权威写入者是 `background.js` 的 `applyUserRules`。
但 `options.js` 的删除按钮当时也直接写了这个键：

```js
// options.js（修复前）
const arr = cur.adshield_user_cosmetic || [];
arr.splice(idx, 1);
await chrome.storage.local.set({ "adshield_user_cosmetic": arr });   // ← 第二个写入者
```

**为什么当时没出事（读码）**：紧接着的 `saveUserRules` 会让 `applyUserRules` 从
`adshield_user_rules` 重新推导 `cosmetic` 并整体覆盖该键。由于删除时也同步从
`adshield_user_rules` 里摘掉了对应行，最终状态是收敛的、正确的。**属于约定偏离，不是功能缺陷。**

**但它有两个真实代价**：
① 多一次无谓的 storage 写 + 一次 `storage.onChanged` 事件 → `cosmetic.js` 的
监听器会因此多跑一轮 `reloadUserRules`，在删除瞬间可能短暂渲染出与最终态不一致的选择器集合；
② 下一个人若照 `AGENTS.md` 的表去理解这个键，会以为只有 background 写它，
从而写出第三处写入 —— 这正是 M6（拾取器重复写）当初的成因模式。

**修复（现 `options.js` 删除按钮）**：改为**只发 `saveUserRules` 消息**，不再自己写这个键，
并留了注释说明为什么不能自己写：
```js
// 规则本体交给 background 写：这边再 set 一次会和应用流程抢同一个键。
// adshield_user_cosmetic 同理 —— 它的权威写入者是 background 的 applyUserRules，
// 它会根据 adshield_user_rules 里剩下的 ## 规则重算并覆盖。
// 这页面自己写一次会造成两个写入者竞争：删掉的规则可能被 background 的重算带回来。
await chrome.runtime.sendMessage({ type: "saveUserRules", rules: userRules });
```
**`AGENTS.md` 的单一写入者表因此保持准确，不用改。**

**另有一道自动化护栏**：`tools/check.mjs` 第 4c 节「storage 键的单一写入者」现在会
扫描全部 JS 文件，发现任何**非 background** 的文件直接 `storage.local.set({ "<key>" ... })`
就报错。这条护栏同时覆盖 `adshield_settings` / `adshield_user_rules` /
`adshield_user_cosmetic` / `adshield_stats` 四个键 —— 下一个人再写第三处写入会被直接拦住。

### 7.7 补的护栏与工具（本轮新增）

| 产物 | 类型 | 作用 | 怎么用 |
|---|---|---|---|
| `tools/probe-pool-full.mjs` | **可复用诊断工具** | 池满时旧用户规则是否保住；`updateDynamicRules` 的真实原子语义；整批超限是否原子拒绝 | `node tools/probe-pool-full.mjs`，**退出码 0 = 防线在，1 = 回归了**。不进 `npm run verify`（要真把池子灌到 29,995 条，代价高） |
| `tools/check.mjs` 第 4c 节 | 静态检查 | storage 键的单一写入者（4 个键） | 已在 `npm run check` 里，自动生效 |
| `tools/check.mjs` 第 4d 节 | 静态检查 | 共享模块的解构完整性（「用到但没解构」→ ReferenceError，语法检查查不出来） | 已在 `npm run check` 里，自动生效 |
| `tools/test-validate.mjs` | 单元测试 | rulesets 空映射表 / 全非法不被接受（新增 3 项，共 103 项） | 已在 `npm test` 里 |
| `tools/test-rules.mjs` | 单元测试 | `shouldSkipSubmit` 语义：池满时必须标记为不下发（新增 6 项，共 19 项） | 已在 `npm test` 里 |

> ⚠️ **`test-rules.mjs` 仍是逻辑复刻**，不是调用真实代码。
> 新增的 `shouldSkipSubmit` 断言与真实守卫条件一致，但复刻与实现仍是两份。
> 这是 7.5 P1 第 ③ 条建议的后续项 —— 把复刻换成真实调用。

### 7.8 交接给下一个人的一句话

> 交接给下一个人：
> **自动化的洞在编排层，不在纯函数层。** 现在的断言守住了「输入进来是否干净」
> 和「防线还在不在」，但**还没守住「防线被改掉时能认出来」**——
> `test-rules.mjs` 仍是复刻，改了真实代码它不会红。
> 动手改 `background.js` 的任何一条编排逻辑（订阅更新 / 统计分类 / 云端应用）之前，
> **先跑 `node tools/probe-pool-full.mjs`**（退出码即结论），
> 再看 **7.5 P1 第 ③ 条**（复刻改真实调用）。
> 7.6 里四条已闭环，**只剩第 3 条（正式安装版统计）仍是未验证的推断**，
> 发布前必须装一次 CRX 实测。
