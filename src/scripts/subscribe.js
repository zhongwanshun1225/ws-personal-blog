/*!
 * subscribe.js —— 订阅页的邮件登记（V11）
 *
 * 数据落在 services 的 subscribers 表，**只能**通过 SECURITY DEFINER 的
 * subscribe_add RPC 写入（anon 对该表没有任何表级权限，见
 * cloud/sql/2026-10-13-batch5-visitor-gaps.sql）。
 *
 * 两点刻意的设计：
 *  1. 不管这个邮箱是否已存在，服务端都返回同一个 ok:true —— 不泄露「谁订阅过」。
 *     前端的提示文案因此也统一成「已登记」，不去区分新老用户。
 *  2. 站点当前**没有接入发信服务**，所以提交成功后如实说「登记好了，接入后开始投递」，
 *     不假装邮件已经发出去了。
 */
(function () {
  'use strict';

  var doc = document;
  var form = doc.querySelector('[data-subscribe-form]');
  if (!form) return;

  var input = form.querySelector('[data-subscribe-input]');
  var submit = form.querySelector('[data-subscribe-submit]');
  var status = form.querySelector('[data-subscribe-status]');

  function t(key, fallback) {
    if (typeof window.__wsT === 'function') {
      var text = window.__wsT(key, fallback);
      if (text) return text;
    }
    return fallback || key;
  }

  function currentLang() {
    var i18n = window.WSBlogI18n;
    return (i18n && i18n.lang) || '';
  }

  function setStatus(text, kind) {
    if (!status) return;
    status.textContent = text || '';
    if (kind) status.setAttribute('data-state', kind);
    else status.removeAttribute('data-state');
  }

  function busy(on) {
    if (submit) {
      submit.disabled = on;
      submit.classList.toggle('is-loading', on);
    }
    form.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  /* 与脚本同级的客户端校验：服务端还会再校验一次（正则 + 列级 CHECK） */
  var EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/;

  function cloud() {
    var C = window.WSBlogCloud;
    if (!C || typeof C.db !== 'function') return null;
    try {
      return C.db();
    } catch (err) {
      return null;
    }
  }

  function submitEmail(email) {
    var db = cloud();
    if (!db || typeof db.rpc !== 'function') {
      return Promise.reject(new Error('cloud-unavailable'));
    }
    return db.rpc('subscribe_add', { p_email: email, p_lang: currentLang() || null });
  }

  /* 云端 SDK 是异步就绪的；等一下它，拿不到就退化成「连不上」的提示 */
  function waitForCloud() {
    var C = window.WSBlogCloud;
    if (!C) return Promise.resolve(null);
    if (typeof C.booted === 'function') {
      return C.booted().then(
        function () {
          return C;
        },
        function () {
          return C;
        }
      );
    }
    if (typeof C.ready === 'function') return Promise.resolve(C.ready().then(function () { return C; }, function () { return C; }));
    return Promise.resolve(C);
  }

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var email = input ? String(input.value || '').trim() : '';

      if (!email) {
        setStatus(t('subscribe.emailNeedEmail', '先填一个邮箱。'), 'error');
        if (input) input.focus();
        return;
      }
      if (!EMAIL_RE.test(email)) {
        setStatus(t('subscribe.emailInvalid', '邮箱格式看起来不对，检查一下。'), 'error');
        if (input) input.focus();
        return;
      }

      busy(true);
      setStatus(t('subscribe.emailSubmitting', '提交中…'), 'pending');

      waitForCloud()
        .then(function () {
          return submitEmail(email);
        })
        .then(function (result) {
          var data = result && result.data !== undefined ? result.data : result;
          if (data && data.ok === false && data.error === 'invalid_email') {
            setStatus(t('subscribe.emailInvalid', '邮箱格式看起来不对，检查一下。'), 'error');
            return;
          }
          /* 走到这里就等于「登记成功」（新老用户一视同仁，不区分） */
          setStatus(t('subscribe.emailPending', '已登记。'), 'done');
          if (input) input.value = '';
        })
        .catch(function () {
          setStatus(t('subscribe.emailOffline', '暂时连不上服务器，稍后再试；也可以先用 RSS。'), 'error');
        })
        .then(function () {
          busy(false);
        });
    });
  }
})();
