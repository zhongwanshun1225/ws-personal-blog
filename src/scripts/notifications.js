/**
 * 通知中心（notifications.html）。
 *
 * 数据全部来自服务端 my_notifications(p_limit, p_offset, p_unread)：
 *   { total, unread, shown, rows[] }
 * 收件人边界由数据库按 auth.uid() 收口，前端拿不到别人的通知。
 *
 * 支持：全部 / 未读 筛选、逐条标为已读、全部标为已读、删除单条、清空、加载更多。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var root = document.querySelector('[data-notify-page]');
  if (!root) return;

  var ROOT = window.__ROOT__ || '';
  var PAGE_SIZE = 20;

  function q(selector) {
    return root.querySelector(selector);
  }

  var listEl = q('[data-notify-list]');
  var moreBtn = q('[data-notify-more]');
  var readAllBtn = q('[data-notify-read-all]');
  var clearBtn = q('[data-notify-clear]');
  var summaryEl = q('[data-notify-summary]');
  var unreadChip = q('[data-notify-unread-chip]');
  var gateEl = q('[data-notify-gate]');

  var filter = 'all';
  var offset = 0;
  var total = 0;
  var shown = 0;
  var unreadTotal = 0;
  var loading = false;
  var ready = false;

  /* ---------------- 图标与文案 ---------------- */

  function svg(paths) {
    return (
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      paths + '</svg>'
    );
  }

  var KIND_META = {
    comment: {
      label: '评论',
      cls: 'comment',
      icon: svg('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-2.9-.4L4 21l1.4-4.1A8.2 8.2 0 0 1 3 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"></path>'),
    },
    reply: {
      label: '回复',
      cls: 'reply',
      icon: svg('<path d="M9 14 4 9l5-5"></path><path d="M4 9h9a7 7 0 0 1 7 7v4"></path>'),
    },
    post_approved: {
      label: '已通过',
      cls: 'approved',
      icon: svg('<path d="M20 6 9 17l-5-5"></path>'),
    },
    post_rejected: {
      label: '未通过',
      cls: 'rejected',
      icon: svg('<path d="M18 6 6 18"></path><path d="M6 6l12 12"></path>'),
    },
    post_pending: {
      label: '待审核',
      cls: 'pending',
      icon: svg('<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>'),
    },
    post_unpublished: {
      label: '已下架',
      cls: 'unpublished',
      icon: svg('<path d="M4 4l16 16"></path><path d="M9.9 5.1A9 9 0 0 1 21 12c-.4 1.3-1.2 2.5-2.3 3.4"></path><path d="M6.1 7.3A9.3 9.3 0 0 0 3 12c1.5 3.5 5 6 9 6 1.1 0 2.2-.2 3.2-.6"></path>'),
    },
  };

  /* ---------------- 小工具 ---------------- */

  function relativeTime(value) {
    if (!value) return '';
    var then = new Date(value).getTime();
    if (isNaN(then)) return '';
    var diff = Date.now() - then;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 30 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    return C.formatDate(value);
  }

  function linkHref(link) {
    if (!link) return '';
    if (/^https?:\/\//i.test(link)) return link;
    return ROOT + String(link).replace(/^\//, '');
  }

  function setSummary() {
    if (summaryEl) {
      summaryEl.textContent = total
        ? '（共 ' + total + ' 条，未读 ' + unreadTotal + ' 条）'
        : '';
    }
    if (unreadChip) unreadChip.textContent = String(unreadTotal);
  }

  /* ---------------- 渲染 ---------------- */

  function rowHtml(item) {
    var meta = KIND_META[item.kind] || { label: item.kind || '通知', cls: 'comment', icon: '' };
    var unread = !item.read_at;
    var href = linkHref(item.link);
    return (
      '<li class="notif' + (unread ? ' is-unread' : '') + '" data-notif-id="' + item.id + '">' +
      '<span class="notif__icon notif__icon--' + meta.cls + '">' + meta.icon + '</span>' +
      '<div class="notif__body">' +
      '<div class="notif__head">' +
      '<span class="notif__kind notif__kind--' + meta.cls + '">' + C.escapeHtml(meta.label) + '</span>' +
      '<span class="notif__title">' + C.escapeHtml(item.title || '') + '</span>' +
      '<span class="notif__time">' + C.escapeHtml(relativeTime(item.created_at)) + '</span>' +
      '</div>' +
      (item.body ? '<p class="notif__text">' + C.escapeHtml(item.body) + '</p>' : '') +
      '<div class="notif__actions">' +
      (href
        ? '<a class="link-btn" href="' + C.escapeHtml(href) + '" data-notif-open="' + item.id + '">查看</a>'
        : '') +
      (unread
        ? '<button class="link-btn" type="button" data-notif-read="' + item.id + '">标为已读</button>'
        : '') +
      '<button class="link-btn link-btn--danger" type="button" data-notif-del="' + item.id + '">删除</button>' +
      '</div>' +
      '</div></li>'
    );
  }

  function renderEmpty() {
    if (!listEl) return;
    var message = filter === 'unread'
      ? '没有未读通知，都看过了。'
      : '还没有通知。有人评论或回复你、投稿有结果时会出现在这里。';
    listEl.innerHTML = '<li class="notif-empty">' + C.escapeHtml(message) + '</li>';
  }

  function bindRows() {
    Array.prototype.forEach.call(root.querySelectorAll('[data-notif-read]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-notif-read'));
        btn.disabled = true;
        markRead(id);
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-notif-del]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-notif-del'));
        btn.disabled = true;
        removeOne(id);
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-notif-open]'), function (a) {
      a.addEventListener('click', function () {
        /* 点「查看」顺手标为已读（失败也不拦跳转） */
        var id = Number(a.getAttribute('data-notif-open'));
        if (a.closest('.notif') && a.closest('.notif').classList.contains('is-unread')) {
          C.db().rpc('notify_mark_read', { p_id: id, p_all: false }).catch(function () {});
          if (window.WSBlogNotify) window.WSBlogNotify.refresh();
        }
      });
    });
  }

  function appendRows(rows) {
    if (!listEl) return;
    if (!rows.length) {
      if (!shown) renderEmpty();
      return;
    }
    var html = rows.map(rowHtml).join('');
    if (!shown) listEl.innerHTML = html;
    else listEl.insertAdjacentHTML('beforeend', html);
    bindRows();
  }

  /* ---------------- 数据 ---------------- */

  function load(reset) {
    if (loading || !ready) return Promise.resolve();
    loading = true;
    if (reset) {
      offset = 0;
      shown = 0;
      if (listEl) listEl.innerHTML = '<li class="notif-empty">加载中…</li>';
    }
    if (moreBtn) moreBtn.disabled = true;

    return C.db()
      .rpc('my_notifications', {
        p_limit: PAGE_SIZE,
        p_offset: offset,
        p_unread: filter === 'unread',
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var data = (res && res.data) || {};
        var rows = data.rows || [];
        total = Number(data.total) || 0;
        unreadTotal = Number(data.unread) || 0;
        shown = Number(data.shown) || shown + rows.length;
        offset += rows.length;
        appendRows(rows);
        setSummary();
        if (moreBtn) moreBtn.hidden = offset >= shown;
        if (window.WSBlogNotify) window.WSBlogNotify.setUnread(unreadTotal);
      })
      .catch(function (err) {
        console.warn('[notify] 通知加载失败', err && err.message);
        if (listEl) {
          listEl.innerHTML = '<li class="notif-empty">通知加载失败，请刷新重试。</li>';
        }
      })
      .then(function () {
        loading = false;
        if (moreBtn) moreBtn.disabled = false;
      });
  }

  function markRead(id) {
    return C.db()
      .rpc('notify_mark_read', { p_id: id, p_all: false })
      .then(function (res) {
        if (res && res.error) throw res.error;
        return load(true);
      })
      .catch(function () {
        load(true);
      });
  }

  function removeOne(id) {
    if (!window.confirm('删除这条通知？')) {
      load(true);
      return Promise.resolve();
    }
    return C.db()
      .rpc('notify_clear', { p_id: id, p_all: false })
      .then(function (res) {
        if (res && res.error) throw res.error;
        return load(true);
      })
      .catch(function () {
        load(true);
      });
  }

  /* ---------------- 交互 ---------------- */

  if (moreBtn) {
    moreBtn.addEventListener('click', function () {
      load(false);
    });
  }

  if (readAllBtn) {
    readAllBtn.addEventListener('click', function () {
      if (!unreadTotal) {
        C.toast('没有未读通知');
        return;
      }
      readAllBtn.disabled = true;
      C.db()
        .rpc('notify_mark_read', { p_all: true })
        .then(function (res) {
          if (res && res.error) throw res.error;
          C.toast('已全部标为已读');
          return load(true);
        })
        .catch(function (err) {
          C.toast((err && err.message) || '操作失败');
        })
        .then(function () {
          readAllBtn.disabled = false;
        });
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      if (!window.confirm('清空全部通知？此操作不可恢复。')) return;
      clearBtn.disabled = true;
      C.db()
        .rpc('notify_clear', { p_all: true })
        .then(function (res) {
          if (res && res.error) throw res.error;
          C.toast('通知已清空');
          return load(true);
        })
        .catch(function (err) {
          C.toast((err && err.message) || '操作失败');
        })
        .then(function () {
          clearBtn.disabled = false;
        });
    });
  }

  Array.prototype.forEach.call(root.querySelectorAll('[data-notify-filter]'), function (btn) {
    btn.addEventListener('click', function () {
      filter = btn.getAttribute('data-notify-filter') || 'all';
      Array.prototype.forEach.call(root.querySelectorAll('[data-notify-filter]'), function (other) {
        other.classList.toggle('is-active', other === btn);
      });
      load(true);
    });
  });

  C.booted().then(function () {
    if (!C.currentUser()) {
      if (gateEl) gateEl.removeAttribute('hidden');
      var list = q('[data-notify-list]');
      if (list) list.setAttribute('hidden', '');
      var foot = q('.notif-foot');
      if (foot) foot.setAttribute('hidden', '');
      if (readAllBtn) readAllBtn.disabled = true;
      if (clearBtn) clearBtn.disabled = true;
      return;
    }
    ready = true;
    load(true);
  });

  C.onSessionChange(function () {
    if (C.currentUser() && !ready) {
      ready = true;
      load(true);
    }
  });
})();
