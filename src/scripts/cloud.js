/**
 * 云端能力核心层。
 *
 * 职责：加载并初始化 WorkBuddy 云服务 SDK（CDN 全局形式），
 * 对外提供会话 / 登录 / 登出 / 管理员判定 / 数据库访问，以及顶栏登录态渲染。
 *
 * 依赖（由 layout 注入，defer 顺序保证可用）：
 *   assets/cloud-config.js  → window.__CLOUD__
 *   <CDN> index.global.js   → window.WorkBuddyCloud
 */

(function () {
  'use strict';

  var cfg = window.__CLOUD__;
  if (!cfg || !cfg.endpoint || !cfg.publishableKey) {
    console.warn('[WSBlogCloud] 缺少云端配置，登录相关功能不可用');
    return;
  }

  var ROOT = (typeof window.__ROOT__ === 'string' ? window.__ROOT__ : '') || '';
  var client = null;
  var sdkReady = null;
  var sessionListeners = [];
  var currentSession = null;
  var adminFlag = null; /* null = 未知，true/false = 已判定 */
  var accountInfo = null; /* my_account() 返回：uid / email / is_admin / is_active / status */
  var identity = 'user'; /* 当前使用的身份：'user' | 'admin' */
  var booted = false; /* 会话恢复完成前不渲染顶栏，避免「登录/注册」闪一下又变成用户菜单 */

  var IDENTITY_KEY = 'wsblog.identity';

  function readStoredIdentity() {
    try {
      return window.localStorage.getItem(IDENTITY_KEY) === 'admin' ? 'admin' : 'user';
    } catch (err) {
      return 'user';
    }
  }

  function storeIdentity(value) {
    identity = value === 'admin' ? 'admin' : 'user';
    try {
      window.localStorage.setItem(IDENTITY_KEY, identity);
    } catch (err) {
      /* 隐私模式等场景下静默失败，不影响本次会话 */
    }
  }

  identity = readStoredIdentity();

  /* ---------------- 基础工具 ---------------- */

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(message) {
    if (typeof window.__wsToast === 'function') {
      window.__wsToast(message);
      return;
    }
    var el = document.querySelector('[data-toast]');
    if (!el) return;
    el.textContent = message;
    el.setAttribute('data-show', '');
    clearTimeout(toast.__t);
    toast.__t = setTimeout(function () {
      el.removeAttribute('data-show');
    }, 2200);
  }

  function formatDate(value) {
    if (!value) return '';
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function formatDateTime(value) {
    if (!value) return '';
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    var date = formatDate(d);
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return date + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------------- SDK 加载与初始化 ---------------- */

  function waitForSdk(timeoutMs) {
    if (sdkReady) return sdkReady;
    sdkReady = new Promise(function (resolve, reject) {
      var started = Date.now();
      var limit = timeoutMs || 15000;
      (function poll() {
        if (typeof window.WorkBuddyCloud !== 'undefined') {
          resolve(window.WorkBuddyCloud);
          return;
        }
        if (Date.now() - started > limit) {
          reject(new Error('云端 SDK 加载超时，请检查网络后刷新重试'));
          return;
        }
        setTimeout(poll, 60);
      })();
    });
    return sdkReady;
  }

  function cloud() {
    if (client) return client;
    var sdk = window.WorkBuddyCloud;
    if (!sdk) throw new Error('云端 SDK 尚未就绪');
    client = sdk.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
      publishableKey: cfg.publishableKey,
    });
    return client;
  }

  /* ---------------- 会话 ---------------- */

  function notify() {
    booted = true;
    renderAccountBanner();
    for (var i = 0; i < sessionListeners.length; i++) {
      try {
        sessionListeners[i](currentSession, adminFlag);
      } catch (err) {
        console.error('[WSBlogCloud] 会话回调异常', err);
      }
    }
  }

  function onSessionChange(cb) {
    sessionListeners.push(cb);
    if (booted) cb(currentSession, adminFlag);
  }

  function getSession() {
    return Promise.resolve()
      .then(function () {
        return cloud().auth.getSession();
      })
      .then(function (res) {
        currentSession = (res && res.data) || null;
        return currentSession;
      })
      .catch(function (err) {
        console.warn('[WSBlogCloud] 读取会话失败', err && err.message);
        currentSession = null;
        return null;
      });
  }

  function getUser() {
    return Promise.resolve()
      .then(function () {
        return cloud().auth.getUser();
      })
      .then(function (res) {
        return (res && res.data && res.data.user) || null;
      })
      .catch(function () {
        return null;
      });
  }

  function isAdmin() {
    return Promise.resolve()
      .then(function () {
        return cloud().database.rpc('is_admin');
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        adminFlag = res && res.data === true;
        return adminFlag;
      })
      .catch(function (err) {
        console.warn('[WSBlogCloud] 管理员判定失败', err && err.message);
        adminFlag = false;
        return false;
      });
  }

  /** 读取当前账号状态（是否被禁用等）。失败时视为正常，避免误伤。 */
  function loadAccount() {
    return Promise.resolve()
      .then(function () {
        return cloud().database.rpc('my_account');
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        accountInfo = (res && res.data) || null;
        return accountInfo;
      })
      .catch(function (err) {
        console.warn('[WSBlogCloud] 账号状态读取失败', err && err.message);
        accountInfo = null;
        return null;
      });
  }

  /** 账号是否可用。被管理员禁用后仍能浏览，但不能评论 / 点赞 / 收藏 / 改资料。 */
  function isActive() {
    return accountInfo ? accountInfo.is_active !== false : true;
  }

  /** 写操作前的守卫：被禁用时提示并返回 true（已拦截）。 */
  function requireActive() {
    if (isActive()) return false;
    toast('此账号已被管理员禁用，无法进行该操作');
    return true;
  }

  /** 被禁用时在页面顶部插一条提示，未禁用则移除。 */
  function renderAccountBanner() {
    if (!document.body) return;
    var node = document.querySelector('[data-account-banner]');
    var disabled = !!currentSession && !!accountInfo && accountInfo.is_active === false;

    if (!disabled) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
      return;
    }

    if (!node) {
      node = document.createElement('div');
      node.className = 'account-banner';
      node.setAttribute('data-account-banner', '');
      document.body.insertBefore(node, document.body.firstChild);
    }
    node.innerHTML =
      '<div class="wrap account-banner__inner">' +
      '<span class="account-banner__text">此账号已被管理员禁用，当前只能浏览：' +
      '评论、点赞、收藏与资料修改都已停用。如有疑问请联系站长。</span>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-account-banner-signout>退出登录</button>' +
      '</div>';

    var btn = node.querySelector('[data-account-banner-signout]');
    if (btn) {
      btn.addEventListener('click', function () {
        signOut().then(function () {
          toast('已退出登录');
          location.reload();
        });
      });
    }
  }

  /** 刷新会话 + 管理员标记，并通知订阅者。 */
  function refresh() {
    return getSession()
      .then(function (session) {
        if (!session) {
          adminFlag = false;
          accountInfo = null;
          notify();
          return null;
        }
        return Promise.all([isAdmin(), loadAccount()]).then(function () {
          notify();
          return session;
        });
      })
      .catch(function () {
        adminFlag = false;
        accountInfo = null;
        notify();
        return null;
      });
  }

  function signInWithPassword(email, password) {
    return cloud().auth.signInWithPassword({ email: email, password: password });
  }

  function sendOtp(payload) {
    return cloud().auth.sendOtp(payload);
  }

  function verifyOtp(payload) {
    return cloud().auth.verifyOtp(payload);
  }

  /** 忘记密码：向邮箱发送重置验证码。
   *  返回 { data: { updateUser({ nonce, password }) } }，提交新密码后会自动登录。 */
  function resetPasswordForEmail(email) {
    return cloud().auth.resetPasswordForEmail(email);
  }

  /** 已登录状态下改密码：需要当前密码做 sudo 校验，成功后会话保持有效。
   *  注意 SDK 的入参是驼峰（oldPassword / newPassword），不是文档里的
   *  old_password / new_password —— 以 src/vendor/cloud-sdk.js 的实现为准。 */
  function changePassword(oldPassword, newPassword) {
    return cloud().auth.resetPasswordForOld({
      oldPassword: oldPassword,
      newPassword: newPassword,
    });
  }

  function signOut() {
    return Promise.resolve()
      .then(function () {
        return cloud().auth.signOut();
      })
      .then(function () {
        currentSession = null;
        adminFlag = false;
        notify();
      });
  }

  function db() {
    return cloud().database;
  }

  function storage() {
    return cloud().storage;
  }

  /** 未登录跳转到登录页，返回 true 表示已拦截。 */
  function requireLogin() {
    if (currentSession) return false;
    location.href = ROOT + 'login.html?next=' + encodeURIComponent(location.pathname + location.search);
    return true;
  }

  function currentUser() {
    return (currentSession && currentSession.user) || null;
  }

  function currentUid() {
    var user = currentUser();
    if (!user) return '';
    return user.id || user.uid || user.sub || user.userId || '';
  }

  /** 展示用名称：优先资料页昵称，其次邮箱前缀。 */
  function displayName() {
    var user = currentUser();
    if (!user) return '';
    var email = user.email || user.phone || '';
    var local = email.indexOf('@') > 0 ? email.split('@')[0] : email;
    return user.user_metadata && user.user_metadata.nickname
      ? user.user_metadata.nickname
      : local;
  }

  /** 当前是否处于「管理员身份」。必须同时满足白名单 + 主动选择管理员身份。 */
  function isAdminMode() {
    return adminFlag === true && identity === 'admin';
  }

  /** 切换身份。切到管理员会先校验白名单，失败返回 false。 */
  function setIdentity(mode) {
    if (mode !== 'admin') {
      storeIdentity('user');
      notify();
      return Promise.resolve(true);
    }
    return isAdmin().then(function (ok) {
      if (!ok) {
        toast('这个账号没有管理员权限');
        return false;
      }
      storeIdentity('admin');
      notify();
      return true;
    });
  }

  /* ---------------- 登录设备登记（M6） ----------------
   * 云平台没有会话列表接口，所以「登录设备」是本站自己记的：
   * 每台设备生成一个随机串存 localStorage，每次页面加载调 session_touch 续期。
   * 在个人中心点「退出其他设备」后，那些设备下次访问时会被 session_touch
   * 告知 revoked=true，这里立即登出 —— 协作式软踢出，不是平台级吊销。
   */

  var SESSION_KEY_STORE = 'wsblog:session-key';

  function localSessionKey() {
    var key = '';
    try {
      key = window.localStorage.getItem(SESSION_KEY_STORE) || '';
    } catch (err) {
      key = '';
    }
    if (key) return key;
    try {
      key =
        window.crypto && typeof window.crypto.randomUUID === 'function'
          ? window.crypto.randomUUID()
          : String(Date.now()) + '-' + Math.random().toString(36).slice(2, 12);
    } catch (err) {
      key = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 12);
    }
    try {
      window.localStorage.setItem(SESSION_KEY_STORE, key);
    } catch (err) {
      /* 隐私模式：本次会话内用内存值，下次访问会生成新 key（表现为多一条设备） */
    }
    return key;
  }

  /** 粗略的设备名：只用于列表展示，不作为任何判定依据。 */
  function deviceLabel() {
    var ua = navigator.userAgent || '';
    var os = /Windows/i.test(ua) ? 'Windows'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
      : /Android/i.test(ua) ? 'Android'
      : /Mac OS X/i.test(ua) ? 'macOS'
      : /Linux/i.test(ua) ? 'Linux'
      : '未知系统';
    var browser = /Edg\//i.test(ua) ? 'Edge'
      : /OPR\//i.test(ua) ? 'Opera'
      : /Firefox\//i.test(ua) ? 'Firefox'
      : /Chrome\//i.test(ua) ? 'Chrome'
      : /Safari\//i.test(ua) ? 'Safari'
      : '浏览器';
    return browser + ' · ' + os;
  }

  /** 登记 / 刷新本机登录记录。被踢出时立即登出并提示。 */
  function touchSession() {
    if (!currentSession) return Promise.resolve(null);
    var key = localSessionKey();
    return Promise.resolve()
      .then(function () {
        return db().rpc('session_touch', {
          p_key: key,
          p_label: deviceLabel(),
          p_ua: String(navigator.userAgent || '').slice(0, 200),
        });
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var data = (res && res.data) || null;
        if (data && data.revoked === true) {
          return signOut().then(function () {
            toast('这个设备上的登录已在别处退出，请重新登录');
            return null;
          });
        }
        return data;
      })
      .catch(function (err) {
        console.warn('[WSBlogCloud] 登录设备登记失败', err && err.message);
        return null;
      });
  }

  /** 管理员页面守卫：未登录跳登录页；白名单账号自动切到管理员身份；其余跳首页。 */
  function guardAdmin() {
    if (!currentSession) {
      location.href = ROOT + 'login.html?next=' + encodeURIComponent(location.pathname + location.search);
      return false;
    }
    if (!isAdminMode()) {
      if (adminFlag === true) {
        /* 打开后台本身就是明确意图，没必要再让白名单账号点一次「切换身份」 */
        storeIdentity('admin');
        notify();
        return true;
      }
      toast('这个账号没有管理员权限');
      setTimeout(function () {
        location.href = ROOT + 'index.html';
      }, 900);
      return false;
    }
    return true;
  }

  /* ---------------- 顶栏登录态 ---------------- */

  function renderSlot() {
    if (!booted) return;
    var slots = document.querySelectorAll('[data-auth-slot]');
    if (!slots.length) return;

    /* 白名单被移除后，历史上残留的「管理员身份」要自动回退，避免进入守卫死循环 */
    if (identity === 'admin' && adminFlag !== true) storeIdentity('user');

    var user = currentUser();
    var short = displayName();
    var adminMode = isAdminMode();

    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (!user) {
        slot.innerHTML =
          '<a class="auth-btn" href="' + ROOT + 'login.html">' +
          '<span class="auth-btn__dot"></span>登录 / 注册</a>';
        continue;
      }
      slot.innerHTML =
        '<div class="auth-menu" data-auth-menu>' +
        '<button class="auth-btn auth-btn--user" type="button" data-auth-toggle aria-haspopup="true" aria-expanded="false">' +
        '<span class="auth-btn__avatar">' +
        escapeHtml(short.slice(0, 1).toUpperCase()) +
        '</span>' +
        '<span class="auth-btn__name">' + escapeHtml(short) + '</span>' +
        (adminMode
          ? '<span class="auth-btn__role">管理员</span>'
          : '<span class="auth-btn__role auth-btn__role--user">用户</span>') +
        '</button>' +
        '<div class="auth-dropdown">' +
        '<div class="auth-dropdown__role">当前身份：' + (adminMode ? '管理员' : '普通用户') + '</div>' +
        '<a href="' + ROOT + 'notifications.html">我的通知</a>' +
        '<a href="' + ROOT + 'write.html">写文章</a>' +
        (adminMode
          ? '<a href="' + ROOT + 'admin.html">管理后台</a>' +
            '<a href="' + ROOT + 'account.html">个人中心</a>' +
            '<button type="button" data-identity="user">切换为普通用户</button>'
          : '<a href="' + ROOT + 'account.html">个人中心</a>' +
            (adminFlag ? '<button type="button" data-identity="admin">切换到管理员身份</button>' : '')) +
        '<button type="button" data-auth-signout>退出登录</button>' +
        '</div></div>';
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-auth-toggle]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var menu = btn.closest('[data-auth-menu]');
        var open = menu.hasAttribute('data-open');
        if (open) {
          menu.removeAttribute('data-open');
          btn.setAttribute('aria-expanded', 'false');
        } else {
          menu.setAttribute('data-open', '');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-identity]'), function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-identity');
        btn.disabled = true;
        setIdentity(target).then(function (ok) {
          btn.disabled = false;
          if (!ok) return;
          toast(target === 'admin' ? '已切换为管理员身份' : '已切换为普通用户身份');
          if (target === 'admin') location.href = ROOT + 'admin.html';
        });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-auth-signout]'), function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        signOut().then(function () {
          storeIdentity('user');
          toast('已退出登录');
          location.href = ROOT + 'index.html';
        });
      });
    });
  }

  document.addEventListener('click', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-auth-menu][data-open]'), function (menu) {
      menu.removeAttribute('data-open');
      var btn = menu.querySelector('[data-auth-toggle]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  });

  /* ---------------- 对外接口 ---------------- */

  window.WSBlogCloud = {
    root: ROOT,
    config: cfg,
    ready: waitForSdk,
    cloud: cloud,
    db: db,
    storage: storage,
    escapeHtml: escapeHtml,
    toast: toast,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    getSession: getSession,
    getUser: getUser,
    isAdmin: isAdmin,
    isAdminSync: function () {
      return adminFlag === true;
    },
    isAdminMode: isAdminMode,
    account: function () {
      return accountInfo;
    },
    loadAccount: loadAccount,
    isActive: isActive,
    requireActive: requireActive,
    identity: function () {
      return identity;
    },
    setIdentity: setIdentity,
    guardAdmin: guardAdmin,
    currentUser: currentUser,
    currentUid: currentUid,
    displayName: displayName,
    refresh: refresh,
    signInWithPassword: signInWithPassword,
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
    resetPasswordForEmail: resetPasswordForEmail,
    changePassword: changePassword,
    signOut: signOut,
    requireLogin: requireLogin,
    onSessionChange: onSessionChange,
    renderSlot: renderSlot,
    /* 登录设备（M6） */
    sessionKey: localSessionKey,
    deviceLabel: deviceLabel,
    touchSession: touchSession,
  };

  onSessionChange(renderSlot);

  /* 启动：SDK 就绪后恢复会话并渲染顶栏。
     页面脚本可 await booted() 拿到确定后的登录态，再决定是否跳转。 */
  var bootPromise = waitForSdk()
    .then(function () {
      return refresh();
    })
    .then(function (session) {
      /* 登录设备登记（M6）。失败不影响使用：本地预览的 Origin 会被云端拒绝，
         线上正常；被软踢出时 touchSession 内部会自行登出。 */
      if (session) touchSession();
      return session;
    })
    .catch(function (err) {
      console.warn('[WSBlogCloud] 初始化失败：' + (err && err.message));
      currentSession = null;
      adminFlag = false;
      notify();
      return null;
    });

  window.WSBlogCloud.booted = function () {
    return bootPromise;
  };
})();
