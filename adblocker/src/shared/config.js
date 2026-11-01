// AdShield 默认设置与消息协议 —— 全项目单一真源
//
// 背景（2026-11-01 审查 N2/N3）：
//   - DEFAULT_SETTINGS 此前在 background.js / options.js / popup.js 各写一份，
//     而且已经漂移：background 那份多了 5 个字段（subscriptions / notifyOnBlock /
//     subscriptionInterval / assistedSites / lastSubscriptionCheck）。
//     虽然读取时用 Object.assign(stored) 兜住了数据，但新增字段时漏改一处就会埋雷。
//   - 消息类型此前是散落在各文件里的字符串字面量，background 侧是一个 20+ 分支的
//     if/else 链，没有任何声明。新增消息时容易拼错且无处可查。
//
// 这里把两者集中，各文件只引用不重定义。
(function () {
  const ROOT = typeof globalThis !== "undefined" ? globalThis : self;

  /** 设置项默认值（storage 里的对象会覆盖这些） */
  const DEFAULT_SETTINGS = {
    enabled: true,
    disabledSites: [],       // 永久白名单（host 归一化后的裸域名）
    pausedUntil: {},         // 定时暂停 { host: 到期时间戳 }
    globalPausedUntil: 0,
    rulesets: { ads: true, tracking: true, annoyances: true, url_clean: true, malware: true },
    antiDetect: true,
    assist: true,
    showBadge: true,
    theme: "auto",
    notifyOnBlock: false,    // 拦截时发系统通知
    assistedSites: [],       // 浏览助手触发历史 [{ host, ts, until, reason }]
    subscriptions: [],       // [{ id, name, url, enabled, lastUpdate, lastCount, lastError }]
    subscriptionInterval: 24,// 自动更新间隔（小时），0 = 关闭
    lastSubscriptionCheck: 0
  };

  /** 规则集定义（三个页面共用，避免文案与颜色漂移） */
  const RULESETS = [
    { id: "ads",         label: "广告拦截", desc: "拦截横幅、弹窗、视频贴片等展示广告",        color: "#FD3638" },
    { id: "tracking",    label: "追踪防护", desc: "阻止第三方跨站追踪器收集您的浏览行为",      color: "#A78BFA" },
    { id: "annoyances",  label: "干扰过滤", desc: "屏蔽推送请求、弹窗挂件、反拦截检测脚本",    color: "#F79009" },
    { id: "url_clean",   label: "URL 清理", desc: "自动去除链接里的 utm 等追踪参数",           color: "#00AEF0" },
    { id: "malware",     label: "恶意防护", desc: "拦截浏览器挖矿脚本与已知恶意/欺诈分发域名", color: "#7F1D1D" }
  ];

  /** 统计分类（popup 圆环 / options 报告页共用） */
  const CATS = [
    { key: "ads",         label: "广告", color: "#FD3638" },
    { key: "tracking",    label: "追踪", color: "#A78BFA" },
    { key: "annoyances",  label: "干扰", color: "#F79009" },
    { key: "url_clean",   label: "URL",  color: "#00AEF0" },
    { key: "malware",     label: "恶意", color: "#7F1D1D" }
  ];

  /** 分类 key 列表（popup 圆环遍历用，只需要字符串） */
  const CAT_KEYS = CATS.map(c => c.key);

  /** 分类 key → 中文标签（popup 芯片用） */
  const CAT_LABELS = CATS.reduce((m, c) => { m[c.key] = c.label; return m; }, {});

  /** 分类 key → 颜色（popup 芯片用） */
  const CAT_COLORS = CATS.reduce((m, c) => { m[c.key] = c.color; return m; }, {});

  /**
   * background 消息类型。
   * 新增消息时：先在这里加常量，再在 background 的 handleOtherMessage 里加分支。
   */
  const MSG = {
    // 通用
    PING: "ping",
    GET_STATE: "getState",
    // 设置开关
    TOGGLE_GLOBAL: "toggleGlobal",
    TOGGLE_SITE: "toggleSite",
    TOGGLE_RULESET: "toggleRuleset",
    SET_FEATURE: "setFeature",
    SET_SUBSCRIPTION_INTERVAL: "setSubscriptionInterval",
    // 统计
    GET_STATS: "getStats",
    GET_TAB_STATS: "getTabStats",
    RESET_STATS: "resetStats",
    CLEAR_LOGS: "clearLogs",
    // 用户规则
    GET_USER_RULES: "getUserRules",
    SAVE_USER_RULES: "saveUserRules",
    // 订阅
    GET_SUBSCRIPTIONS: "getSubscriptions",
    SAVE_SUBSCRIPTION: "saveSubscription",
    SAVE_SUBSCRIPTIONS_BATCH: "saveSubscriptionsBatch",
    REMOVE_SUBSCRIPTION: "removeSubscription",
    CLEAR_SUBSCRIPTION_UPDATE_FLAG: "clearSubscriptionUpdateFlag",
    CHECK_SUBSCRIPTION_UPDATES: "checkSubscriptionUpdates",
    UPDATE_ALL_SUBSCRIPTIONS: "updateAllSubscriptions",
    RESTORE_DEFAULT_SUBSCRIPTIONS: "restoreDefaultSubscriptions",
    // 浏览助手
    ASSIST_DETECTED: "assistDetected"
  };

  ROOT.adshieldConfig = { DEFAULT_SETTINGS, RULESETS, CATS, CAT_KEYS, CAT_LABELS, CAT_COLORS, MSG };
})();
