/* preview.js —— A4 草稿预览分享页（preview.html?token=…）
 *
 * 内容来自 post_preview_get(token)：一张只读快照，公开可读但 token 是
 * 128 位随机十六进制，服务端不提供任何列表接口，所以无法被批量枚举。
 *
 * 页面刻意不做静态化：正文可能还没发布，构建期把它写进 dist/ 就等于
 * 提前公开了。
 */
(function () {
  'use strict';

  var C = window.WSBlogCloud;
  var root = document.querySelector('[data-preview]');

  function qa(sel) {
    return document.querySelectorAll(sel);
  }

  function show(sel, on) {
    qa(sel).forEach(function (node) {
      if (on) node.removeAttribute('hidden');
      else node.setAttribute('hidden', '');
    });
  }

  function token() {
    var m = /[?&]token=([^&#]+)/.exec(location.search);
    if (m) return decodeURIComponent(m[1]);
    // 支持 #token=xxx（有些邮件客户端会把查询串吃掉）
    m = /[#&]token=([^&#]+)/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : '';
  }

  var ERROR_TEXT = {
    not_found: '链接不存在或已被作者删除。',
    revoked: '作者已经撤销了这条预览链接。',
    expired: '预览链接已过期。可以让作者在编辑器里重新生成一条。',
    default: '链接可能已过期、被撤销，或地址不完整。',
  };

  function fail(code) {
    show('[data-preview-status]', false);
    show('[data-preview-body]', false);
    show('[data-preview-error]', true);
    var node = document.querySelector('[data-preview-error-text]');
    if (node) node.textContent = ERROR_TEXT[code] || ERROR_TEXT.default;
    document.title = '预览链接不可用';
  }

  function render(data) {
    var titleEl = document.querySelector('[data-preview-title]');
    if (titleEl) titleEl.textContent = data.title || '(无标题)';

    var summaryEl = document.querySelector('[data-preview-summary]');
    if (summaryEl && data.summary) {
      summaryEl.textContent = data.summary;
      summaryEl.removeAttribute('hidden');
    }

    var authorEl = document.querySelector('[data-preview-author]');
    if (authorEl) authorEl.textContent = data.author_name || '作者';

    var expiryEl = document.querySelector('[data-preview-expiry]');
    if (expiryEl && data.expires_at) {
      var when = new Date(data.expires_at);
      if (!isNaN(when.getTime())) {
        expiryEl.textContent =
          '链接有效至 ' +
          when.getFullYear() +
          '-' +
          String(when.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(when.getDate()).padStart(2, '0') +
          ' ' +
          String(when.getHours()).padStart(2, '0') +
          ':' +
          String(when.getMinutes()).padStart(2, '0');
      }
    }

    var tagsEl = document.querySelector('[data-preview-tags]');
    if (tagsEl) {
      var tags = Array.isArray(data.tags) ? data.tags : [];
      tagsEl.textContent = '';
      tags.forEach(function (tag) {
        var span = document.createElement('span');
        span.className = 'tag-chip tag-chip--plain';
        span.textContent = String(tag);
        tagsEl.appendChild(span);
      });
      if (!tags.length) tagsEl.setAttribute('hidden', '');
    }

    var bodyEl = document.querySelector('[data-preview-content]');
    if (bodyEl) {
      var md = window.WSBlogCloudMarkdown;
      if (md && typeof md.render === 'function') {
        bodyEl.innerHTML = md.render(data.content_md || '');
        if (typeof md.enhance === 'function') {
          try {
            md.enhance(bodyEl);
          } catch (e) {
            /* 增强失败不影响正文 */
          }
        }
      } else {
        // 没有渲染器时退化成纯文本，至少让人看到内容
        bodyEl.textContent = data.content_md || '';
      }
    }

    document.title = (data.title || '预览') + ' · 预览';
    show('[data-preview-status]', false);
    show('[data-preview-body]', true);
  }

  function boot() {
    if (!root) return;
    var tk = token();
    if (!tk) {
      fail('default');
      return;
    }
    if (!C) {
      fail('default');
      return;
    }
    C.booted()
      .then(function () {
        return C.db().rpc('post_preview_get', { p_token: tk });
      })
      .then(function (res) {
        var data = res && res.data;
        if (!data || data.ok !== true) {
          fail((data && data.error) || 'default');
          return;
        }
        render(data);
      })
      .catch(function () {
        show('[data-preview-status]', false);
        show('[data-preview-error]', true);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
