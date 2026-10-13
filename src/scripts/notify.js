/**
 * 顶栏通知铃铛。
 *
 * 有未读通知时显示红色数字徽标；点击进入「通知中心」（notifications.html）。
 * 未读数走服务端 notify_unread_count()（以登录态为边界），
 * 页面加载后立即取一次，之后每 90 秒、以及每次切回标签页时刷新。
 *
 * 只在接入云端的页面注入（layout.py 里与 cloud.js 同批加载）。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var ROOT = window.__ROOT__ || '';
  var POLL_MS = 90000;

  var slot = document.querySelector('[data-notify-slot]');
  var timer = null;
  var unread = 0;
  var booted = false;

  var BELL_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"></path>' +
    '<path d="M13.7 20a2 2 0 0 1-3.4 0"></path></svg>';

  function render() {
    if (!slot) return;
    if (!booted || !C.currentUser()) {
      slot.innerHTML = '';
      slot.setAttribute('hidden', '');
      return;
    }
    slot.removeAttribute('hidden');
    var badge = unread > 0
      ? '<span class="notify-bell__badge">' + (unread > 99 ? '99+' : unread) + '</span>'
      : '';
    slot.innerHTML =
      '<a class="notify-bell" href="' + ROOT + 'notifications.html" ' +
      'aria-label="通知中心' + (unread > 0 ? '（' + unread + ' 条未读）' : '') + '" ' +
      'title="通知中心' + (unread > 0 ? '：' + unread + ' 条未读' : '') + '">' +
      BELL_ICON + badge + '</a>';
  }

  function poll() {
    if (!slot || !booted) return Promise.resolve(0);
    if (!C.currentUser()) {
      unread = 0;
      render();
      return Promise.resolve(0);
    }
    return C.db()
      .rpc('notify_unread_count')
      .then(function (res) {
        if (res && res.error) throw res.error;
        var value = res && res.data;
        unread = typeof value === 'number' ? value : Number(value) || 0;
        render();
        return unread;
      })
      .catch(function (err) {
        /* 未读数拉取失败不影响页面；静默即可 */
        console.warn('[notify] 未读数读取失败', err && err.message);
        return unread;
      });
  }

  function schedule() {
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(function () {
      if (document.visibilityState === 'visible') poll();
    }, POLL_MS);
  }

  C.booted().then(function () {
    if (!slot) return;
    booted = true;
    poll();
    schedule();
  });

  C.onSessionChange(function () {
    if (booted) poll();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && booted) poll();
  });

  window.WSBlogNotify = {
    refresh: poll,
    setUnread: function (value) {
      unread = Math.max(0, Number(value) || 0);
      render();
      return unread;
    },
    getUnread: function () {
      return unread;
    },
  };
})();
