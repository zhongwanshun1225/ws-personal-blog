/**
 * 登录态闲置超时（自动退出）。
 *
 * 规则：已登录用户连续 5 分钟没有任何操作 → 自动登出，跳回登录页并说明原因。
 *
 * 为什么放在前端而不是云端：本站的会话由云平台 SDK 持有，平台侧不提供
 * 「闲置多久自动吊销」的配置。共享电脑场景（网吧 / 办公室 / 演示机）下，
 * 人走了页面还挂着，风险是**这台浏览器仍能被操作**——这正是前端要解决的问题。
 * 因此这里做的是「前端主动交还会话」，登出会真正调用平台 signOut()，
 * 不是把界面藏起来自欺欺人。
 *
 * 两个必须避开的坑：
 * 1. **后台轮询会伪装成"用户活跃"**：admin.js 有定时刷新、notifications.js 有轮询，
 *    它们发的 fetch 不该续期，否则人走了页面仍永不超时。所以只监听**用户真实输入事件**，
 *    完全不挂钩 XHR/fetch。
 * 2. **草稿没保存就登出会丢内容**：write.js 的草稿有 1200ms 防抖。超时时先主动
 *    触发一次刷盘（若页面暴露了刷盘钩子）并留出宽限期，再执行登出。
 */
(function () {
  'use strict';

  /** 闲置阈值：5 分钟。 */
  var IDLE_MS = 5 * 60 * 1000;

  /** 倒计时提示提前量：剩最后 60 秒时给出可视警告，并可点「继续使用」续期。 */
  var WARN_MS = 60 * 1000;

  /** 登出前的宽限期：给草稿刷盘留时间。 */
  var GRACE_MS = 600;

  /** 只认这些**用户真实输入**事件 —— 不包含任何脚本触发的网络活动。 */
  var ACTIVITY_EVENTS = [
    'mousedown',
    'mousemove',
    'wheel',
    'keydown',
    'touchstart',
    'touchmove',
    'pointerdown',
    'focusin',
  ];

  var REDIRECT_FLAG = 'wsblog:idle-logout';

  /** 登录态判定：只有真登录了才需要计时，游客页面不打扰。 */
  function isLoggedIn() {
    var c = window.WSBlogCloud;
    if (!c || typeof c.currentUser !== 'function') return false;
    try {
      return !!c.currentUser();
    } catch (err) {
      return false;
    }
  }

  /** 登录页 / 注册相关页不启用，避免刚打开就触发。 */
  function onAuthPage() {
    var p = location.pathname;
    return /(?:^|\/)(?:login)\.html$/i.test(p);
  }

  var timer = null;
  var warnTimer = null;
  var lastActive = 0;
  var warned = false;
  var signingOut = false;
  var bound = false;

  function clearTimers() {
    clearTimeout(timer);
    clearTimeout(warnTimer);
    timer = null;
    warnTimer = null;
  }

  function hideWarn() {
    var el = document.querySelector('[data-idle-warn]');
    if (el) {
      el.removeAttribute('data-show');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  /** 剩余秒数的可视警告（同一套 toast 区域，做成常驻条 + 续期按钮）。 */
  function showWarn(secondsLeft) {
    var el = document.querySelector('[data-idle-warn]');
    if (!el) return;
    var text = el.querySelector('[data-idle-text]');
    if (text) {
      text.textContent =
        '你已 ' + Math.round((IDLE_MS - secondsLeft * 1000) / 60000) + ' 分钟没有操作，' +
        secondsLeft + ' 秒后将自动退出登录。';
    }
    el.setAttribute('data-show', '');
    el.setAttribute('aria-hidden', 'false');
    warned = true;
  }

  /** 记一次活跃：重置倒计时，并撤掉警告。 */
  function markActive() {
    if (!isLoggedIn() || signingOut) return;
    lastActive = Date.now();
    if (warned) hideWarn();
    warned = false;
    clearTimers();
    // 提前 60 秒示警，而不是等到 0 秒直接踢人 —— 正在写长文时被静默登出最恼人。
    warnTimer = setTimeout(function () {
      if (!isLoggedIn() || signingOut) return;
      showWarn(Math.round(WARN_MS / 1000));
    }, IDLE_MS - WARN_MS);
    timer = setTimeout(idleLogout, IDLE_MS);
  }

  /**
   * 尽量保住用户的输入：优先调用页面自己注册的刷盘钩子，
   * 其次广播一个自定义事件让 draft.js 之类的模块响应。
   * 都不是阻塞式的 —— 拿不到就靠宽限期兜底。
   */
  function flushPendingWork() {
    try {
      if (window.WSBlogDraft && typeof window.WSBlogDraft.flush === 'function') {
        window.WSBlogDraft.flush();
      }
    } catch (err) {
      /* 刷盘失败不能挡住登出 */
    }
    try {
      window.dispatchEvent(new CustomEvent('wsblog:before-idle-logout'));
    } catch (err) {
      /* 老浏览器没有 CustomEvent 构造器：忽略 */
    }
  }

  function idleLogout() {
    if (signingOut) return;
    signingOut = true;
    clearTimers();
    hideWarn();
    flushPendingWork();

    var c = window.WSBlogCloud;
    var finish = function () {
      try {
        sessionStorage.setItem(REDIRECT_FLAG, '1');
      } catch (err) {
        /* 隐私模式：退化为不带提示跳转 */
      }
      var next = location.pathname + location.search;
      var root = typeof c.rootPath === 'function' ? c.rootPath() : '';
      location.href = root + 'login.html?idle=1&next=' + encodeURIComponent(next);
    };

    // 宽限期：给上面的刷盘动作一点落盘时间，再真正登出。
    setTimeout(function () {
      if (c && typeof c.signOut === 'function') {
        c.signOut().then(finish, finish);
      } else {
        finish();
      }
    }, GRACE_MS);
  }

  function bind() {
    if (bound) return;
    bound = true;
    ACTIVITY_EVENTS.forEach(function (name) {
      // 捕获阶段 + 被动监听：不阻塞滚动，也不漏掉冒泡被阻止的输入。
      document.addEventListener(name, markActive, { passive: true, capture: true });
    });
    // 回到这个标签页也算活跃（切走期间不该被计时踢掉）。
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) markActive();
    });
    // 续期按钮
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest('[data-idle-continue]')) {
        markActive();
      }
    });
  }

  function start() {
    if (onAuthPage()) return;
    if (!isLoggedIn()) return;
    bind();
    markActive();
  }

  /** 登录态变化时同步启停：登出后停表，登录后开始计时。 */
  function watchSession() {
    var c = window.WSBlogCloud;
    if (!c || typeof c.onSessionChange !== 'function') return;
    c.onSessionChange(function (session) {
      if (session) {
        signingOut = false;
        if (!bound) start();
        else markActive();
      } else {
        clearTimers();
        hideWarn();
      }
    });
  }

  function init() {
    watchSession();
    var boot = window.WSBlogCloud && window.WSBlogCloud.booted;
    if (typeof boot === 'function') {
      boot().then(start, start);
    } else {
      start();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 供登录页读取跳转原因；也便于自动化测试断言常量。
  window.WSBlogIdle = {
    IDLE_MS: IDLE_MS,
    WARN_MS: WARN_MS,
    markActive: markActive,
    isLoggedIn: isLoggedIn,
    takeRedirectReason: function () {
      try {
        var flag = sessionStorage.getItem(REDIRECT_FLAG);
        if (flag) sessionStorage.removeItem(REDIRECT_FLAG);
        return flag ? 'idle' : '';
      } catch (err) {
        return '';
      }
    },
  };
})();
