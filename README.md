# AdShield 广告拦截器

> 轻量、隐私优先的广告与追踪拦截扩展，基于 Manifest V3 开发。

[![Version](https://img.shields.io/badge/version-2.0.0-blue)]()
[![Manifest](https://img.shields.io/badge/Manifest-V3-green)]()
[![License](https://img.shields.io/badge/license-MIT-orange)]()

## ✨ 功能特性

| 特性 | 说明 |
|------|------|
| 🚫 **广告拦截** | 拦截横幅、弹窗、视频贴片、信息流广告 |
| 🛡 **追踪防护** | 阻止网站和第三方收集您的浏览行为 |
| 🧹 **URL 清理** | 自动去除 utm_*、gclid、fbclid 等追踪参数 |
| 👁 **元素隐藏** | 隐藏页面中的广告容器占位，让版面清爽 |
| 🕵 **反广告检测** | 规避网站的 AdBlock 检测脚本，不再被"请关闭广告拦截"困扰 |
| 🦠 **恶意防护** | 拦截浏览器挖矿脚本与已知恶意/欺诈分发域名 |
| ⚙️ **规则管理** | 支持 AdGuard / uBlock 风格自定义规则 |
| 📊 **拦截统计** | 分类趋势图、Top 域名榜（数据仅本地存储） |

## 📦 安装

### 从 Edge 商店安装（推荐）

> 🚧 **上架中**，敬请期待

### 开发者模式加载

1. 下载本仓库的 Release zip 包
2. 打开 `chrome://extensions/`（Edge 用 `edge://extensions/`）
3. 开启右上角 **开发者模式**
4. 点 **加载已解压的扩展程序**，选择解压后的目录
5. 加载提示选 **保留**

## 🎯 使用说明

### 弹窗

- 点击扩展图标 → 查看本站 / 今日 / 累计拦截数
- 右上角开关 → 全局启用 / 暂停
- 菜单 → 加入白名单、查看日志、打开设置

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt+A` | 全局暂停 / 恢复 |
| `Alt+S` | 当前网站暂停 / 恢复 |

### 右键菜单

在网页空白处右键 → 可直接：暂停本站 / 恢复 / 隐藏元素 / 打开设置

### 自定义规则

在「设置 → 规则管理」里添加，支持以下语法：

```
! 这是注释
||ads.example.com^      域名拦截（含子域）
/banner/                路径片段拦截
@@||mysite.com^         例外规则（放行）
example.com##.ad        元素隐藏（仅该站）
##.global-ad            元素隐藏（全站）
```

## 🔒 隐私承诺

- ✅ **所有数据存储于本地浏览器**，不上传任何信息
- ✅ **不收集任何用户数据**（无埋点、无分析、无遥测）
- ✅ **不发起任何网络请求**（除用户主动添加的规则订阅外）
- ✅ **不使用远程代码**（所有 JS 随扩展打包）
- ✅ 完整隐私政策见 [PRIVACY.md](./PRIVACY.md)

## 🛠 技术栈

- **Manifest V3**
- **declarativeNetRequest** — 网络层拦截
- **Content Scripts** — 元素隐藏 / 拾取器
- **Service Worker** — 后台逻辑
- **原生 JavaScript**，无第三方框架

## 📁 目录结构

```
adblocker/
├── manifest.json          # 扩展配置
├── icons/                 # 图标（16/32/48/128）
├── rules/                 # 拦截规则
│   ├── ads.json           # 广告域名
│   ├── tracking.json      # 追踪域名
│   ├── annoyances.json    # 干扰内容
│   ├── url-tracking.json  # URL 参数清理
│   └── malware.json       # 恶意域名
└── src/
    ├── background.js      # 后台服务
    ├── popup.*            # 弹窗
    ├── options.*          # 设置页
    ├── logger.*           # 详细日志
    └── content/           # 内容脚本
```

## ❓ 常见问题

**Q1: 为什么有些广告没被拦？**

A: 规则库持续更新中。你可以通过「设置 → 规则管理」添加自定义规则，或者访问我们的 GitHub Issues 反馈。

**Q2: 会不会影响网页加载速度？**

A: 不会。所有拦截在浏览器网络层完成，不注入页面脚本。

**Q3: 统计数字一直是 0？**

A: 统计功能依赖浏览器调试 API，仅在开发者模式加载扩展时有效。

**Q4: 如何完全卸载？**

A: 在扩展管理页点「移除」即可。所有本地数据会一并删除。

## 📄 许可证

MIT License

## 💬 反馈

- 有问题？提 [GitHub Issue](https://github.com/guihuo125/adshield/issues)
- 邮箱：guihuo125@users.noreply.github.com

---

**如果这个项目对你有帮助，欢迎给个 ⭐ Star！**