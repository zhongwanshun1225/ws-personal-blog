/* banner.js —— 站内公告条与维护模式（B15）
 *
 * 两件事：
 *   1. 公告条：构建期已把当时的内容烘进 HTML（没有 JS 也能看到）；
 *      这里用 settings_public() 再拉一次，站长在后台改完立刻生效。
 *      关掉后按「内容指纹」记在 localStorage，同一篇公告不再打扰。
 *   2. 维护模式：设置里打开后给全站盖一层遮罩。管理员可以用
 *      ?maintenance=off 绕过（需要服务端确认为管理员，否则只是徒劳）。
 *
 * 为什么要带 ?maintenance=off 且要验管理员：遮罩本身是纯前端的「软窗帘」，
 * 挡不住直接调 API 的人。它的用途是给读者一个明确交代、避免看到半成品；
 * 但站长自己必须能在维护期间进来检查和关掉它，所以留这个后门并且要求
 * 服务端确认身份 —— 光知道参数不能绕过。
 */
(function () {
  'use strict';

  var ROOT = window.__ROOT__ || '';
  var DISMISS_KEY = 'wsblog:announce:dismissed';
  var BYPASS = 'maintenance=off';

  function t(key) {
    var i18n = window.WSBlogI18n;
    if (i18n && typeof i18n.t === 'function') return i18n.t(key);
    return key;
  }

  function hasBypass() {
    return location.search.indexOf(BYPASS) !== -1 || location.hash.indexOf(BYPASS) !== -1;
  }

  function fingerprint(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  function remembered() {
    try {
      return localStorage.getItem(DISMISS_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function remember(value) {
    try {
      localStorage.setItem(DISMISS_KEY, value);
    } catch (e) {
      /* 隐私模式写不了 localStorage，本次会话内仍然生效 */
    }
  }

  /* ---------------- 公告条 ---------------- */

  function renderAnnouncement(cfg) {
    var box = document.querySelector('[data-announce]');
    if (!box) return;
    var textEl = box.querySelector('[data-announce-text]');

    if (!cfg || !cfg.active || !cfg.text) {
      box.setAttribute('hidden', '');
      return;
    }
    var mark = fingerprint(cfg.text);
    if (remembered() === mark) {
      box.setAttribute('hidden', '');
      return;
    }

    box.classList.remove('announce--warn', 'announce--success');
    if (cfg.level === 'warn') box.classList.add('announce--warn');
    if (cfg.level === 'success') box.classList.add('announce--success');

    if (textEl) {
      textEl.textContent = cfg.text;
      textEl.removeAttribute('data-i18n');
    }
    box.removeAttribute('hidden');

    var closeBtn = box.querySelector('[data-announce-close]');
    if (closeBtn && !closeBtn.__wsBound) {
      closeBtn.__wsBound = true;
      closeBtn.addEventListener('click', function () {
        var current = box.querySelector('[data-announce-text]');
        remember(fingerprint(current ? current.textContent : ''));
        box.setAttribute('hidden', '');
      });
    }
  }

  /* ---------------- 维护模式 ---------------- */

  function sessionExists() {
    var C = window.WSBlogCloud;
    if (!C || typeof C.getSession !== 'function') return false;
    try {
      return !!C.getSession();
    } catch (e) {
      return false;
    }
  }

  function isStaff(cb) {
    var C = window.WSBlogCloud;
    if (!C || typeof C.db !== 'function') {
      cb(false);
      return;
    }
    C.db()
      .rpc('my_admin_role')
      .then(function (res) {
        var role = res && res.data;
        cb(role === 'admin' || role === 'editor');
      })
      .catch(function () {
        cb(false);
      });
  }

  function renderMaintenance(cfg) {
    var box = document.querySelector('[data-maintenance]');
    if (!box) return;
    if (!cfg || !cfg.active) {
      box.setAttribute('hidden', '');
      return;
    }
    var textEl = box.querySelector('[data-maintenance-text]');
    if (textEl && cfg.message) {
      textEl.textContent = cfg.message;
      textEl.removeAttribute('data-i18n');
    }

    if (!hasBypass() || !sessionExists()) {
      box.removeAttribute('hidden');
      document.documentElement.classList.add('is-maintenance');
      return;
    }
    // 带绕过参数且已登录：再问一次服务端确认是不是管理员
    isStaff(function (ok) {
      if (ok) {
        box.setAttribute('hidden', '');
        document.documentElement.classList.remove('is-maintenance');
        var hint = box.querySelector('.maintenance__hint');
        if (hint) hint.setAttribute('hidden', '');
        if (window.WSBlogCloud && window.WSBlogCloud.toast) {
          window.WSBlogCloud.toast('维护模式已为你隐藏（管理员）');
        }
        return;
      }
      box.removeAttribute('hidden');
      document.documentElement.classList.add('is-maintenance');
    });
  }

  /* ---------------- 拉取公开设置 ---------------- */

  function fetchSettings() {
    var cfg = window.__CLOUD__;
    if (!cfg || !cfg.endpoint || !cfg.publishableKey) return Promise.resolve(null);
    return fetch(cfg.endpoint.replace(/\/+$/, '') + '/.cloud/database/rest/rpc/settings_public', {
      method: 'POST',
      headers: {
        'x-wb-webapp-access-key': cfg.publishableKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  function boot() {
    var announceBox = document.querySelector('[data-announce]');
    var maintenanceBox = document.querySelector('[data-maintenance]');

    // 构建期烘的那份已经渲染好了；这里先处理「已关过的公告」，
    // 避免拉取失败时又冒出来一次。
    if (announceBox && !announceBox.hasAttribute('hidden')) {
      var baked = announceBox.querySelector('[data-announce-text]');
      if (baked && remembered() === fingerprint(baked.textContent)) {
        announceBox.setAttribute('hidden', '');
      }
    }

    fetchSettings().then(function (settings) {
      if (!settings) {
        // 拿不到就尊重构建期的兜底（维护遮罩已经在 HTML 里了）
        if (maintenanceBox && !maintenanceBox.hasAttribute('hidden')) {
          document.documentElement.classList.add('is-maintenance');
        }
        return;
      }
      var annRaw = settings['banner.announcement'];
      renderAnnouncement(
        annRaw && typeof annRaw === 'object'
          ? {
              active: !!annRaw.active,
              text: String(annRaw.text || ''),
              level: String(annRaw.level || 'info'),
            }
          : null
      );
      var mntRaw = settings['banner.maintenance'];
      renderMaintenance(
        mntRaw && typeof mntRaw === 'object'
          ? { active: !!mntRaw.active, message: String(mntRaw.message || '') }
          : null
      );
    });

    // 切语言时把静态文案换掉；公告正文是站长写的内容，不做翻译。
    document.addEventListener('wsblog:langchange', function () {
      var hint = document.querySelector('.maintenance__hint');
      if (hint) hint.textContent = t('maintenance.adminHint');
      var title = document.querySelector('.maintenance__title');
      if (title) title.textContent = t('maintenance.title');
      var close = document.querySelector('[data-announce-close]');
      if (close) close.setAttribute('aria-label', t('banner.close'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
