/* write-ext.js —— 投稿页的 A3 定时发布 / A4 预览分享链接 / A5 修订历史
 *
 * 与 write.js 的分工：
 *   write.js 管「写与提交」这条主链路；本文件只负责旁边那三个面板。
 *   两者通过 document 上的 `wsblog:editor` 事件通信（write.js 每次载入 /
 *   重置 / 保存后都会广播当前 slug 与状态），所以不需要改 write.js 的内部变量。
 *
 * 后端的三个 RPC（都要求登录）：
 *   post_preview_create / post_preview_list / post_preview_revoke   —— A4
 *   post_revisions_list / post_revisions_get / post_revision_restore —— A5
 *   author_set_publish_at                                            —— A3（改稿场景）
 */
(function () {
  'use strict';

  var C = window.WSBlogCloud;
  var root = document.querySelector('[data-preview-panel]') || document.querySelector('[data-preview-list]');
  if (!root && !document.querySelector('[data-revisions-panel]')) return;

  function q(sel) { return document.querySelector(sel); }

  function esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(message) {
    if (C && C.toast) C.toast(message);
  }

  function relTime(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '';
    var diff = Math.round((Date.now() - date.getTime()) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.round(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.round(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.round(diff / 86400) + ' 天前';
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0');
  }

  var slug = '';
  var status = '';
  var watching = null;

  /* ---------------- A4 预览链接 ---------------- */

  var PREVIEW_ERR = {
    unauthenticated: '登录状态已过期，请重新登录',
    inactive: '账号已被禁用',
    not_found: '先保存草稿，才能生成预览链接',
    forbidden: '这不是你的文章',
    bad_request: '参数不对，重试一次',
  };

  function previewRow(row) {
    var url = location.origin + location.pathname.replace(/write\.html$/, 'preview.html') +
      '?token=' + encodeURIComponent(row.token);
    var dead = row.revoked || row.expired;
    return (
      '<li class="stack-item' + (dead ? ' is-dead' : '') + '" data-preview-token="' + esc(row.token) + '">' +
      '<div class="stack-item__main">' +
      '<span class="stack-item__title">' + esc(row.title || '（无标题）') + '</span>' +
      '<span class="stack-item__meta">' +
      (row.revoked ? '已撤销 · ' : row.expired ? '已过期 · ' : '有效 · ') + relTime(row.created_at) +
      '</span>' +
      '</div>' +
      '<div class="stack-item__actions">' +
      (dead ? '' : '<button class="btn btn--ghost btn--xs" type="button" data-preview-copy>复制</button>') +
      (dead ? '' : '<button class="btn btn--ghost btn--xs" type="button" data-preview-open>打开</button>') +
      (dead ? '' : '<button class="btn btn--ghost btn--xs" type="button" data-preview-kill>撤销</button>') +
      '</div>' +
      '<input class="preview-url" type="text" readonly value="' + esc(url) + '" hidden>' +
      '</li>'
    );
  }

  function loadPreviews() {
    var list = q('[data-preview-list]');
    if (!list) return Promise.resolve();
    if (!slug) {
      list.innerHTML = '<li class="stack-empty">保存草稿后可用</li>';
      return Promise.resolve();
    }
    return C.db().rpc('post_preview_list', { p_slug: slug })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var data = res && res.data;
        if (!data || data.ok !== true) throw new Error(data && data.error);
        var rows = data.rows || [];
        if (!rows.length) {
          list.innerHTML = '<li class="stack-empty">还没有预览链接</li>';
          return;
        }
        list.innerHTML = rows.map(previewRow).join('');
      })
      .catch(function () {
        list.innerHTML = '<li class="stack-empty">预览链接加载失败</li>';
      });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return Promise.resolve(ok);
  }

  function bindPreview() {
    var list = q('[data-preview-list]');
    var createBtn = q('[data-preview-create]');
    var daysSel = q('[data-preview-days]');

    if (createBtn) {
      createBtn.addEventListener('click', function () {
        if (!slug) {
          toast('先保存草稿，再生成预览链接');
          return;
        }
        createBtn.disabled = true;
        var days = parseInt((daysSel && daysSel.value) || '7', 10) || 7;
        C.db().rpc('post_preview_create', { p_slug: slug, p_days: days })
          .then(function (res) {
            if (res && res.error) throw res.error;
            var data = res && res.data;
            if (!data || data.ok !== true) {
              toast(PREVIEW_ERR[(data && data.error) || ''] || '生成失败');
              return;
            }
            var url = location.origin + location.pathname.replace(/write\.html$/, 'preview.html') +
              '?token=' + data.token;
            return copyText(url).then(function (ok) {
              toast(ok ? '预览链接已复制到剪贴板' : '预览链接已生成，在下方列表里复制');
              return loadPreviews();
            });
          })
          .catch(function (err) {
            toast((err && (err.message || err.error_description)) || '生成失败');
          })
          .then(function () { createBtn.disabled = false; });
      });
    }

    if (!list) return;
    list.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      var item = btn.closest('[data-preview-token]');
      if (!item) return;
      var token = item.getAttribute('data-preview-token');
      var input = item.querySelector('.preview-url');
      var url = input ? input.value : '';

      if (btn.hasAttribute('data-preview-copy')) {
        copyText(url).then(function (ok) { toast(ok ? '已复制' : '复制失败，请手动选中'); });
        return;
      }
      if (btn.hasAttribute('data-preview-open')) {
        window.open(url, '_blank', 'noopener');
        return;
      }
      if (btn.hasAttribute('data-preview-kill')) {
        if (!window.confirm('撤销这条预览链接？\n对方再打开就会看到「链接已失效」。')) return;
        btn.disabled = true;
        C.db().rpc('post_preview_revoke', { p_token: token })
          .then(function (res) {
            if (res && res.error) throw res.error;
            toast('已撤销');
            return loadPreviews();
          })
          .catch(function () {
            toast('撤销失败');
            btn.disabled = false;
          });
      }
    });
  }

  /* ---------------- A5 修订历史 ---------------- */

  var KIND_LABEL = {
    initial: '初版',
    before_update: '改动前',
    snapshot: '快照',
  };

  var currentRevision = null;

  function revisionRow(row) {
    return (
      '<li class="stack-item" data-revision-id="' + esc(row.id) + '">' +
      '<div class="stack-item__main">' +
      '<span class="stack-item__title">' + esc(row.title || '（无标题）') +
      (row.is_current ? ' <span class="chip chip--tiny">当前版</span>' : '') + '</span>' +
      '<span class="stack-item__meta">' + esc(KIND_LABEL[row.kind] || row.kind) + ' · ' +
      esc(relTime(row.saved_at)) + ' · ' + esc(row.words) + ' 字</span>' +
      '</div>' +
      '<div class="stack-item__actions">' +
      '<button class="btn btn--ghost btn--xs" type="button" data-revision-open>看</button>' +
      (row.is_current ? '' : '<button class="btn btn--ghost btn--xs" type="button" data-revision-apply>回滚</button>') +
      '</div>' +
      '</li>'
    );
  }

  function loadRevisions() {
    var list = q('[data-revision-list]');
    if (!list) return Promise.resolve();
    if (!slug) {
      list.innerHTML = '<li class="stack-empty">保存草稿后可用</li>';
      return Promise.resolve();
    }
    return C.db().rpc('post_revisions_list', { p_slug: slug, p_limit: 20 })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var data = res && res.data;
        if (!data || data.ok !== true) throw new Error(data && data.error);
        var rows = data.rows || [];
        if (!rows.length) {
          list.innerHTML = '<li class="stack-empty">还没有历史版本（第一次保存后才会有）</li>';
          return;
        }
        list.innerHTML = rows.map(revisionRow).join('');
      })
      .catch(function () {
        list.innerHTML = '<li class="stack-empty">修订历史加载失败</li>';
      });
  }

  function openRevision(id, btn) {
    var view = q('[data-revision-view]');
    var titleEl = q('[data-revision-title]');
    var bodyEl = q('[data-revision-body]');
    return C.db().rpc('post_revisions_get', { p_slug: slug, p_id: Number(id) })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var data = res && res.data;
        if (!data || data.ok !== true) {
          toast('读不到这一版');
          return;
        }
        currentRevision = data;
        if (titleEl) {
          titleEl.textContent = (data.title || '（无标题）') + ' · ' +
            (KIND_LABEL[data.kind] || data.kind) + ' · ' + relTime(data.saved_at);
        }
        if (bodyEl) bodyEl.textContent = data.content_md || '';
        if (view) view.removeAttribute('hidden');
        if (btn && btn.closest) {
          var li = btn.closest('[data-revision-id]');
          if (li) li.classList.add('is-open');
        }
      })
      .catch(function () { toast('读不到这一版'); });
  }

  function restoreRevision(id) {
    if (!window.confirm(
      '回滚到这一版？\n\n' +
      '受信任作者立即生效；其他作者会转成待审，线上版本不受影响。\n' +
      '回滚前当前的版本也会被存进历史，所以可以再滚回来。'
    )) return;
    return C.db().rpc('post_revision_restore', { p_slug: slug, p_id: Number(id) })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var data = res && res.data;
        if (!data || data.ok !== true) {
          toast('回滚失败：' + ((data && data.error) || '未知错误'));
          return;
        }
        toast(data.mode === 'direct' ? '已回滚并生效' : '回滚内容已提交审核');
        var view = q('[data-revision-view]');
        if (view) view.setAttribute('hidden', '');
        return Promise.all([loadRevisions()]);
      })
      .catch(function (err) {
        toast((err && (err.message || err.error_description)) || '回滚失败');
      });
  }

  function bindRevisions() {
    var list = q('[data-revision-list]');
    var closeBtn = q('[data-revision-close]');
    var restoreBtn = q('[data-revision-restore]');
    var view = q('[data-revision-view]');

    if (closeBtn && view) {
      closeBtn.addEventListener('click', function () { view.setAttribute('hidden', ''); });
    }
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function () {
        if (!currentRevision) return;
        restoreBtn.disabled = true;
        restoreRevision(currentRevision.id).then(function () { restoreBtn.disabled = false; });
      });
    }
    if (!list) return;
    list.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      var item = btn.closest('[data-revision-id]');
      if (!item) return;
      var id = item.getAttribute('data-revision-id');
      if (btn.hasAttribute('data-revision-open')) { openRevision(id, btn); return; }
      if (btn.hasAttribute('data-revision-apply')) {
        btn.disabled = true;
        restoreRevision(id).then(function () { btn.disabled = false; });
      }
    });
  }

  /* ---------------- 状态联动 ---------------- */

  function refreshFor(slugNow) {
    slug = slugNow || '';
    if (watching) { loadPreviews(); loadRevisions(); }
  }

  function boot() {
    if (!C) return;
    bindPreview();
    bindRevisions();

    document.addEventListener('wsblog:editor', function (ev) {
      var detail = (ev && ev.detail) || {};
      status = detail.status || '';
      if (watching) refreshFor(detail.slug);
    });

    return C.booted().then(function () {
      var session = C.getSession && C.getSession();
      if (!session) return;
      watching = true;
      /* write.js 是 defer 脚本，正常情况下它已经跑过一轮并广播了事件；
         这里再主动拉一次，避免事件早于本脚本注册时漏掉。 */
      var fromUrl = /[?&]slug=([^&#]+)/.exec(location.search);
      if (fromUrl) refreshFor(decodeURIComponent(fromUrl[1]));
      else { loadPreviews(); loadRevisions(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
