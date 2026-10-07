// AdShield 元素隐藏引擎 v2
(function () {
  if (window.__adshield_cosmetic_installed__) return;
  window.__adshield_cosmetic_installed__ = true;

  const STYLE_ID = "__adshield_cosmetic__";
  const host = location.hostname;  // 与 storage 一致，不再剥离 www

  const GENERIC_SELECTORS = [
    '[id^="google_ads_"]',
    '[id^="aswift_"]',
    '[id^="div-gpt-ad"]',
    '[class^="ad-slot"]',
    '[class^="ad-banner"]',
    '[class*=" ad-banner"]',
    '[class*="advertisement"]',
    '[class*="adsbygoogle"]',
    'ins.adsbygoogle',
    '[data-ad-slot]',
    '[data-ad-client]',
    '[id*="taboola"]',
    '[class*="outbrain"]',
    '[id^="BAIDU_SSP"]',
    '[class*="baidu-ad"]',
    '[class*="tanx"]',
    '[class*="cpro"]',
    '[id^="cproIframe"]',
    '[class^="ad-"]',
    '[class*=" ad-"]',
    'iframe[src*="doubleclick"]',
    'iframe[src*="/ads/"]',
    'iframe[src*="googlesyndication"]',
    'iframe[src*="amazon-adsystem"]',
    'iframe[src*="taboola"]',
    'iframe[src*="outbrain"]',
    // 百度联盟（搜狐、网易、各大门户的文字广告 iframe）
    'iframe[src*="pos.baidu.com"]',
    'iframe[src*="cpro.baidu.com"]',
    'iframe[src*="cbjs.baidu.com"]',
    'iframe[src*="baidu.com/s?"]',
    'iframe[src*="baidustatic"]',
    // 百度联盟文字广告（li.textAd 这类）
    '[class*="textAd"]',
    '[class*="text-ad"]',
    '[class*="text_ad"]',
    // 广点通 iframe
    'iframe[src*="gdt.qq.com"]',
    'iframe[src*="e.qq.com"]',
    // 阿里妈妈
    'iframe[src*="tanx.com"]',
    'iframe[src*="alimama.com"]',
    // 腾讯广点通（出现在很多国内站点）
    '.gdt-text-container',
    '.gdt-banner-content',
    '[class^="gdt-"]',
    // 网易广告通用
    '[class*="channel_ad_2016"]',
    '[class*="channel_relative_2016"]',
    '[class*="mod_js_ad"]',
    '[class*="mod_index_ad"]',
    '[class^="index_ad_"]',
    '[class*="index_closeAdSign"]',
    // 搜狐广告框架（也常见于其他国内门户）
    '.god-mark',
    '.big-god',
    'a.swf-top',
    '[class*=" god-cut"]',
    '[class*="god-cut "]',
    '.god-cut',
    '.god-head',
    '.godR',
    '[id^="columnAd"]',
    '[id^="sideAd"]',
    // 下载 APP 浮层（今日头条、UC、百度等常见套路）
    '.download-panel',
    '.ttp-popup-container',
    '.download-app-wrapper',
    '.download-app-banner',
    '[class*="download-app-banner"]',
    '.tool-item.download'
  ];

  const SITE_RULES = [
    { domain: "bilibili.com", selectors: ['.ad-report', '.video-page-special-card-small', '.slide-ad-exp', '.bili-video-card__info--ad', '.pop-live-small-mode'] },
    { domain: "zhihu.com", selectors: ['.Card[data-za-detail-view-path-module="AdItem"]', '.Pc-card.AdItem', '.AdItem', '.HotItem-ad'] },
    { domain: "weibo.com", selectors: ['.woo-box-item[adid]', '[action-type="feed_list_ad"]', '.card-wrap[adid]', '.WB_feed_detail .W_ad'] },
    { domain: "baidu.com", selectors: ['#content_left > .result[data-click*="ad"]', '.ec_ad', '.ec-tuiguang', '[data-tuiguang]'] },
    { domain: "youtube.com", selectors: ['#player-ads', 'ytd-promoted-sparkles-web-renderer', 'ytd-display-ad-renderer', 'ytd-promoted-video-renderer', 'ytd-in-feed-ad-layout-renderer', '#masthead-ad', 'ytd-banner-promo-renderer'] },
    { domain: "youku.com", selectors: ['.youku-ad', '#ykPlayer .ad', '.h5-ext-layer', '.advertise-layer'] },
    { domain: "iqiyi.com", selectors: ['.qy-player-ad', '.cupid-public', '.iqp-ad', '.qy-ad'] },
    { domain: "v.qq.com", selectors: ['.txp_ad', '.txp_ad_link', '.player_ad'] },
    { domain: "douyin.com", selectors: ['[data-e2e="feed-ad"]', '[data-e2e="video-card-ad"]'] },
    { domain: "sogou.com", selectors: ['.vrwrap-ad', '.rb-ad'] },
    { domain: "so.com", selectors: ['.res-ad', '.ad-zb'] },
    { domain: "tieba.baidu.com", selectors: ['.j_ad', '.d_ads', '.ad_border'] },
    { domain: "douban.com", selectors: ['.ad-item', '.ad-banner'] },
    { domain: "xiaohongshu.com", selectors: ['.note-item[data-ad]', '.ad-card'] },
    { domain: "toutiao.com", selectors: ['.feed-card-article-l-ad', '.download-panel', '.ttp-popup-container', '.download-app-wrapper', '.download-app-banner', '.tool-item.download'] },
    { domain: "163.com", selectors: ['.gb-final-mod-ad', '.n-ad', '.mod_ad', '.post_ad', '.ad_item', '#js-ad', '.AD_area', '[class*="channel_ad_2016"]', '[class*="channel_relative_2016"]', '[class*="mod_js_ad"]', '[class*="mod_index_ad"]', '[class^="index_ad_"]', '[class*="index_closeAdSign"]', '.gdt-text-container', '.gdt-banner-content', '[class^="gdt-"]'] },
    { domain: "sina.com.cn", selectors: ['.ad-banner', '.blk_ad', '.AdBox'] },
    { domain: "sohu.com", selectors: ['.gg300', '.gg200', '.float-ad', '.ad_banner', '.god-mark', '.big-god', 'a.swf-top', '.god-cut', '.god-head', '.godR', '[id^="columnAd"]', '[id^="sideAd"]', '.pic.ad-focus', '.mon-common', '.textAd', 'li.textAd', '[class*="textAd"]', '[class*="text-ad"]'] },
    { domain: "ifeng.com", selectors: ['.ad_box', '.ifeng_ad'] },
    { domain: "thepaper.cn", selectors: ['.news_ad', '.ad_con'] },
    { domain: "taobao.com", selectors: ['.J_Ad', '.tb-ad'] },
    { domain: "jd.com", selectors: ['.J_ad', '.J_AD'] },
    { domain: "amazon.com", selectors: ['.s-result-item[data-component-type*="sponsored"]', '[data-component-type="sp-sponsored-result"]', '.AdHolder', '#sponsoredProducts2_feature_div'] },
    { domain: "twitter.com", selectors: ['[data-testid="placementTracking"]'] },
    { domain: "x.com", selectors: ['[data-testid="placementTracking"]'] },
    { domain: "reddit.com", selectors: ['shreddit-ad-post', '.promotedlink'] },
    { domain: "facebook.com", selectors: ['[aria-label="Sponsored"]'] },
    { domain: "nga.cn", selectors: ['.ad-item'] },
    { domain: "v2ex.com", selectors: ['.adsbygoogle', '[id^="gg_"]'] }
  ];

  function buildCss(userSelectors) {
    const parts = [];
    for (const sel of GENERIC_SELECTORS) parts.push(sel + "{display:none !important;}");
    for (const rule of SITE_RULES) {
      if (host === rule.domain || host.endsWith("." + rule.domain)) {
        for (const sel of rule.selectors) parts.push(sel + "{display:none !important;}");
      }
    }
    // 用户自定义的 ## 选择器（已过滤到当前站点）
    if (Array.isArray(userSelectors)) {
      for (const sel of userSelectors) parts.push(sel + "{display:none !important;}");
    }
    return parts.join("\n");
  }

  // 从用户规则中筛选出适用于当前站点的 ## 规则
  // 语法：example.com##.ad  /  example.com,*.foo.com##.ad  /  ##.ad（全局）
  function pickUserSelectors(userRules) {
    if (!Array.isArray(userRules)) return [];
    const result = [];
    for (const raw of userRules) {
      if (typeof raw !== "string") continue;
      const idx = raw.indexOf("##");
      if (idx < 0) continue;
      const domainsPart = raw.slice(0, idx).trim();
      const selector = raw.slice(idx + 2).trim();
      if (!selector) continue;

      // 全局规则（##selector）
      if (!domainsPart) { result.push(selector); continue; }

      // 域名列表规则（domain1,domain2##selector）
      const domains = domainsPart.split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
      for (const d of domains) {
        const pure = d.replace(/^~/, "").replace(/^\*\./, "");
        // ~domain 表示"除了该域名"
        if (d.startsWith("~")) continue;
        if (host === pure || host.endsWith("." + pure)) { result.push(selector); break; }
      }
    }
    return result;
  }

  let __userSelectors = [];

  function injectStyle() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();   // 重新注入（选择器可能变化）
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = buildCss(__userSelectors);
    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyle() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  function shouldApply(s) {
    if (!s) return true;
    if (s.enabled === false) return false;
    // 元素隐藏已改为始终启用（不再有独立开关）
    if (Array.isArray(s.disabledSites) && s.disabledSites.includes(host)) return false;
    const until = (s.pausedUntil || {})[host];
    if (until && until > Date.now()) return false;
    return true;
  }

  function apply(s) {
    if (shouldApply(s)) injectStyle();
    else removeStyle();
  }

  function reloadUserRules(settings) {
    chrome.storage.local.get(["adshield_user_rules", "adshield_user_cosmetic"], (store) => {
      const lines = (store.adshield_user_rules || []).filter(l => typeof l === "string" && l.includes("##"));
      const cosmetic = store.adshield_user_cosmetic || [];
      const all = Array.from(new Set([...lines, ...cosmetic]));
      __userSelectors = pickUserSelectors(all);
      removeStyle();
      apply(settings);
    });
  }

  // 首次
  chrome.storage.local.get("adshield_settings", (store) => {
    const s = store.adshield_settings || {};
    reloadUserRules(s);
    if (s.assist !== false && s.enabled !== false) detectAdBlockScripts();
  });

  // ============ 浏览助手：检测页面的"反广告拦截"脚本 ============
  // 这些大型站点自有反拦截逻辑（常用于 UI 完整性），自动暂停反而会破坏页面
  // 所以跳过检测——用户可手动在 popup 里暂停
  const ASSIST_SKIP_HOSTS = [
    // 国内
    "bilibili.com", "zhihu.com", "weibo.com", "douyin.com",
    "toutiao.com", "xiaohongshu.com", "kuaishou.com",
    "taobao.com", "tmall.com", "jd.com", "pinduoduo.com",
    "163.com", "sohu.com", "sina.com.cn", "qq.com", "ifeng.com",
    "baidu.com", "360.cn", "sogou.com",
    "iqiyi.com", "youku.com", "v.qq.com", "mgtv.com",
    "bilibili.tv", "acfun.cn",
    // 国际
    "youtube.com", "twitter.com", "x.com", "facebook.com",
    "instagram.com", "reddit.com", "twitch.tv", "netflix.com",
    "amazon.com", "ebay.com", "google.com", "github.com",
    // AdShield 自己的站点
    "j3.ink", "github.io", "guihuo125.github.io"
  ];

  function detectAdBlockScripts() {
    const host = location.hostname;
    // 大站跳过检测（避免破坏 UI）
    if (ASSIST_SKIP_HOSTS.some(h => host === h || host.endsWith("." + h))) {
      console.log("[AdShield 浏览助手] 大站跳过检测:", host);
      return;
    }
    let triggered = false;

    function trigger(reason) {
      if (triggered) return;
      triggered = true;
      try {
        chrome.runtime.sendMessage({ type: "assistDetected", host, reason });
        console.log("[AdShield 浏览助手] 检测到反拦截脚本:", host, "原因:", reason);
        showAssistNotice();
      } catch (e) {}
    }

    // ---- 1) window 全局变量检测（最准确）----
    // 大部分检测脚本会在 window 上暴露状态
    const DETECT_GLOBALS_TRUE = [
      "adblockDetected", "adBlockDetected", "adblockerDetected",
      "isAdBlockEnabled", "adBlockEnabled"
    ];
    const DETECT_GLOBALS_FALSE = [
      "canRunAds", "canShowAds", "adsEnabled", "adsVisible"
    ];
    function checkGlobals() {
      for (const key of DETECT_GLOBALS_TRUE) {
        try {
          if (window[key] === true) { trigger("global:" + key); return; }
        } catch (e) {}
      }
      for (const key of DETECT_GLOBALS_FALSE) {
        try {
          if (window[key] === false) { trigger("global:" + key + "=false"); return; }
        } catch (e) {}
      }
    }

    // ---- 2) 脚本源码检测（中准确度）----
    // 检查 script 标签里的函数名/特征串
    const DETECT_PATTERNS = [
      /\bfuckadblock\b/i,
      /\bblockadblock\b/i,
      /\bAdBlockDetector\b/i,
      /\bdetectAdBlock\b/i,
      /\bcheckAdBlock\b/i
      // 注意：去掉 adblock[-._]?detect 这类宽泛正则，避免误伤大型站点
    ];
    function checkScripts() {
      try {
        const scripts = document.querySelectorAll("script:not([src])");
        for (const sc of scripts) {
          const code = (sc.textContent || "").slice(0, 30000);
          for (const re of DETECT_PATTERNS) {
            if (re.test(code)) { trigger("script"); return; }
          }
        }
        // 检查外部脚本的 src（只匹配明确的反拦截库名）
        const extScripts = document.querySelectorAll("script[src]");
        for (const sc of extScripts) {
          const src = (sc.src || "").toLowerCase();
          if (/fuckadblock|blockadblock|adblock-detector\.js/.test(src)) {
            trigger("script:src"); return;
          }
        }
      } catch (e) {}
    }

    // ---- 3) 页面文本检测（低准确度，只做兜底）----
    // 只在明确针对用户的提示语上触发
    const TEXT_SIGNS = [
      "检测到广告拦截", "广告拦截检测", "请关闭广告拦截", "关闭广告屏蔽",
      "请关闭广告屏蔽插件", "请关闭 AdBlock",
      "please disable your adblock", "please turn off your adblock",
      "disable adblock to continue", "we noticed you're using an adblocker"
    ];
    function checkText() {
      try {
        // 只在可见的正文块里找（不在 <code>/<pre>/<article> 里，避免误报文章）
        const zones = document.querySelectorAll("body > div, body > section, main, [role='dialog']");
        for (const z of zones) {
          const t = (z.textContent || "").slice(0, 20000);
          for (const s of TEXT_SIGNS) {
            if (t.includes(s)) { trigger("text:" + s); return; }
          }
        }
      } catch (e) {}
    }

    // ---- 4) DOM Mutation 持续监控（30 秒）----
    function watchDOM() {
      let timer = 0;
      const obs = new MutationObserver(() => {
        if (triggered) { obs.disconnect(); return; }
        if (timer) return;
        timer = setTimeout(() => {
          timer = 0;
          checkGlobals();
          checkScripts();
        }, 300);
      });
      try {
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
      setTimeout(() => obs.disconnect(), 30000);
      window.addEventListener("pagehide", () => obs.disconnect(), { once: true });
    }

    // ---- 页面浮条通知（提示用户）----
    function showAssistNotice() {
      try {
        if (document.getElementById("__adshield_assist_notice__")) return;
        if (!document.body) return;
        const bar = document.createElement("div");
        bar.id = "__adshield_assist_notice__";
        bar.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;background:#fff;border:1px solid #e0e2e5;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.15);padding:12px 16px;font-family:'Inter',-apple-system,'Microsoft YaHei',sans-serif;font-size:13px;color:#202225;display:flex;align-items:flex-start;gap:10px;max-width:340px";
        bar.innerHTML =
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#f79009" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px">' +
          '<path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z"/>' +
          '<line x1="12" y1="9" x2="12" y2="13"/>' +
          '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
          '</svg>' +
          '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600">检测到反拦截脚本</div>' +
          '<div style="font-size:11.5px;color:#636568;margin-top:3px;line-height:1.5">AdShield 已为本站暂时暂停，以免页面异常。可在扩展菜单中恢复。</div>' +
          '</div>' +
          '<button style="background:none;border:none;cursor:pointer;color:#88898c;font-size:18px;line-height:1;padding:0;margin-top:-2px" data-close>×</button>';
        document.body.appendChild(bar);
        bar.querySelector("[data-close]").addEventListener("click", () => bar.remove());
        setTimeout(() => { try { bar.remove(); } catch (e) {} }, 5000);
      } catch (e) {}
    }

    // ---- 执行检测 ----
    checkGlobals();
    checkScripts();
    checkText();
    setTimeout(checkGlobals, 1000);
    setTimeout(checkScripts, 1500);
    setTimeout(checkText, 2000);
    setTimeout(checkGlobals, 4000);
    setTimeout(checkScripts, 4500);
    setTimeout(checkText, 5000);
    watchDOM();
  }

  // 设置 / 用户规则变更实时响应
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.adshield_settings) {
      reloadUserRules(changes.adshield_settings.newValue);
    }
    if (changes.adshield_user_rules || changes.adshield_user_cosmetic) {
      chrome.storage.local.get("adshield_settings", (store) => {
        reloadUserRules(store.adshield_settings || {});
      });
    }
  });

  // 动态 DOM 补扫（防抖：避免高频变更触发重读 storage）
  let __cosmeticTimer = 0;
  const obs = new MutationObserver(() => {
    if (__cosmeticTimer) return;
    __cosmeticTimer = setTimeout(() => {
      __cosmeticTimer = 0;
      if (!document.getElementById(STYLE_ID) && document.head) {
        chrome.storage.local.get("adshield_settings", (store) => {
          apply(store.adshield_settings);
        });
      }
    }, 150);
  });
  obs.observe(document.documentElement, { childList: true, subtree: false });
  window.addEventListener("pagehide", () => {
    obs.disconnect();
    if (__cosmeticTimer) clearTimeout(__cosmeticTimer);
  }, { once: true });
})();
