// AdShield 共享 DOM 工具
//
// 背景（2026-11-01 审查 N1/N4）：项目里有 5 份 escapeHtml 实现，
// 其中 options.js 内部就有两份几乎逐字符相同的（escapeHtmlSimple / escapeHtml），
// 另有 4 处 Blob 下载各自写一遍，且 revokeObjectURL 的时机不一致——
// 其中 2 处是「立即 revoke」，而下载是异步的，部分 Chrome 版本会拿到空文件。
// 这里收敛成一份。
(function () {
  const ROOT = typeof globalThis !== "undefined" ? globalThis : self;

  // HTML 转义。null/undefined → 空串（auth.js 那份的语义最正确，保留）
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /**
   * 下载 Blob 为文件。
   * @param {Blob} blob
   * @param {string} filename
   *
   * 为什么延迟 1 秒才 revokeObjectURL：
   *   浏览器的下载是异步启动的，立即 revoke 会让部分 Chrome 版本拿到 0 字节文件。
   *   项目里原先 5 处下载有 2 处立即 revoke、2 处延迟 1000ms、1 处不 revoke，
   *   统一成延迟释放。
   */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** 下载 JSON 对象 */
  function downloadJson(obj, filename) {
    downloadBlob(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }), filename);
  }

  /** 下载 CSV（带 BOM，保证 Excel 正确识别 UTF-8 中文） */
  function downloadCsv(rows, filename) {
    const csv = "﻿" + rows.join("\r\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
  }

  /** 下载纯文本 */
  function downloadText(text, filename) {
    downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), filename);
  }

  ROOT.adshieldDom = { escapeHtml, downloadBlob, downloadJson, downloadCsv, downloadText };
})();
