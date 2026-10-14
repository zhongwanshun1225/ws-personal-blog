/**
 * 新读者「完善资料」引导（缺口 M15）。
 *
 * 为什么需要：新注册的用户资料是空的，评论时 author_name 会被服务端固化成
 * 「读者」—— 本人完全不知道，直到看见自己的评论顶着别人的名字。所以在资料
 * 补齐之前，给一次明确的引导：
 *
 *   · 在个人中心（页面上有 [data-onboard-target]）→ 高亮资料面板 + 一条内联提示，
 *     不弹卡片（人已经到了，再弹一层反而挡路）；
 *   · 在其他任意页面 → 底部弹一张引导卡，一键跳到个人中心；
 *   · 点「以后再说」后本机不再提示（localStorage），但换设备还会提醒一次。
 *
 * 判定条件与 my_account() 一致：nickname 为空，或还没有头像。
 * 依赖：assets/cloud.js。文案：assets/i18n.js 的 onboard.*
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var KEY = 'wsblog:onboard:v1';

  function t(key, fallback) {
    if (typeof window.__wsT === 'function') {
      var str = window.__wsT(key, fallback);
      if (str) return str;
    }
    return fallback || key;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function readFlag() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch (err) {
      return {};
    }
  }

  function writeFlag(value) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(value));
    } catch (err) {
      /* 隐私模式下静默失败：本次会话内不重复提示即可 */
    }
  }

  /* 当前页是否已经具备资料表单 —— 是的话就只做高亮，不再弹卡 */
  function targetPanel() {
    return document.querySelector('[data-onboard-target]');
  }

  function isIncomplete(profile) {
    var row = profile || {};
    var nickname = String(row.nickname == null ? '' : row.nickname).trim();
    var avatar = String(row.avatar_url == null ? '' : row.avatar_url).trim();
    return !nickname || !avatar;
  }

  function removeCard() {
    var node = document.querySelector('[data-onboard]');
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function highlight() {
    var panel = targetPanel();
    if (!panel) return;
    panel.classList.add('is-onboard');
    if (panel.querySelector('[data-onboard-inline]')) return;
    var note = document.createElement('p');
    note.className = 'onboard-inline';
    note.setAttribute('data-onboard-inline', '');
    note.innerHTML =
      '<strong>' + esc(t('onboard.title', '先把资料补上')) + '</strong>' +
      '<span>' + esc(t('onboard.text', '填好昵称和头像，你的评论才会显示成你自己的名字。')) + '</span>' +
      '<button class="link-btn" type="button" data-onboard-inline-dismiss>' +
      esc(t('onboard.later', '知道了')) +
      '</button>';
    panel.insertBefore(note, panel.firstChild);
    var btn = note.querySelector('[data-onboard-inline-dismiss]');
    if (btn) {
      btn.addEventListener('click', function () {
        writeFlag({ dismissed: true });
        note.parentNode && note.parentNode.removeChild(note);
        panel.classList.remove('is-onboard');
      });
    }
  }

  function showCard() {
    if (document.querySelector('[data-onboard]')) return;
    var node = document.createElement('div');
    node.className = 'onboard-card';
    node.setAttribute('data-onboard', '');
    node.innerHTML =
      '<div class="onboard-card__body">' +
      '<strong class="onboard-card__title">' + esc(t('onboard.title', '先把资料补上')) + '</strong>' +
      '<span class="onboard-card__text">' +
      esc(t('onboard.text', '填好昵称和头像，你的评论才会显示成你自己的名字。')) +
      '</span></div>' +
      '<div class="onboard-card__actions">' +
      '<button class="btn btn--primary btn--sm" type="button" data-onboard-go>' +
      esc(t('onboard.cta', '去完善资料')) +
      '</button>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-onboard-later>' +
      esc(t('onboard.later', '以后再说')) +
      '</button>' +
      '</div>';

    document.body.appendChild(node);

    var go = node.querySelector('[data-onboard-go]');
    if (go) {
      go.addEventListener('click', function () {
        location.href = C.root + 'account.html';
      });
    }
    var later = node.querySelector('[data-onboard-later]');
    if (later) {
      later.addEventListener('click', function () {
        writeFlag({ dismissed: true });
        removeCard();
      });
    }
  }

  /** 给外部（个人中心保存成功后）主动复检一次。 */
  function check(profile) {
    if (!C.currentUser()) {
      removeCard();
      return Promise.resolve(false);
    }
    if (profile) return apply(profile);
    return C.db()
      .from('profiles')
      .select('nickname, avatar_url')
      .eq('owner_id', C.currentUid())
      .maybeSingle()
      .then(function (res) {
        return apply((res && res.data) || null);
      })
      .catch(function () {
        return false;
      });
  }

  function apply(profile) {
    if (!isIncomplete(profile)) {
      writeFlag({ done: true });
      removeCard();
      var panel = targetPanel();
      if (panel) {
        panel.classList.remove('is-onboard');
        var inline = panel.querySelector('[data-onboard-inline]');
        if (inline && inline.parentNode) inline.parentNode.removeChild(inline);
      }
      return false;
    }
    var flag = readFlag();
    if (flag.dismissed || flag.done) {
      removeCard();
      return false;
    }
    if (targetPanel()) highlight();
    else showCard();
    return true;
  }

  C.booted().then(function () {
    if (!C.currentUser()) return;
    check();
  });

  window.WSBlogOnboard = {
    check: check,
    reset: function () {
      writeFlag({});
    },
  };
})();
