/**
 * 登录 / 注册页逻辑。
 *
 * 只有一个入口：不预选身份，直接填账号密码（或邮箱验证码）登录。
 * 登录成功后按账号本身的权限分流：
 *   · 普通账号        → 直接以普通用户身份进入（默认回到站内来源页）
 *   · 管理员账号      → 多一步「选择进入身份」：以普通用户浏览 / 进入后台管理
 *
 * 登录方式：邮箱 + 密码、邮箱验证码（首次注册需同时设置密码）。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  function q(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function qa(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  var form = q('[data-auth-form]');
  var emailInput = q('[name="email"]');
  var passwordInput = q('[name="password"]');
  var codeInput = q('[name="code"]');
  var signupPasswordInput = q('[name="signupPassword"]');
  var sendCodeBtn = q('[data-send-code]');
  var submitBtn = q('[data-auth-submit]');
  var errorBox = q('[data-auth-error]');
  var noticeBox = q('[data-auth-notice]');
  var formWrap = q('[data-auth-form-wrap]');
  var pickWrap = q('[data-identity-pick]');
  var signedInWrap = q('[data-signed-in]');

  var method = 'password'; /* 'password' | 'otp' */
  var pendingOtp = null; /* { email, verificationId, isExistingUser } */
  var countdownTimer = null;
  var busy = false;
  var pickBusy = false;


  /* ---------------- 提示 ---------------- */

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message || '';
    if (message) errorBox.removeAttribute('hidden');
    else errorBox.setAttribute('hidden', '');
  }

  function showNotice(message) {
    if (!noticeBox) return;
    noticeBox.textContent = message || '';
    if (message) noticeBox.removeAttribute('hidden');
    else noticeBox.setAttribute('hidden', '');
  }

  function setBusy(value, label) {
    busy = value;
    if (submitBtn) {
      submitBtn.disabled = value;
      if (value) {
        submitBtn.dataset.idle = submitBtn.textContent;
        submitBtn.textContent = label || '处理中…';
      } else if (submitBtn.dataset.idle) {
        submitBtn.textContent = submitBtn.dataset.idle;
      }
    }
  }

  function friendly(err, fallback) {
    if (!err) return fallback || '操作失败，请稍后重试';
    var kind = err.kind || '';
    var message = err.message || '';
    if (kind === 'invalid_grant' || kind === 'unauthenticated') return '邮箱或密码不正确';
    if (kind === 'network' || kind === 'backend-unavailable') return '网络异常，请检查连接后重试';
    if (kind === 'rate_limit' || kind === 'too_many_requests' || /429|too many/i.test(message)) {
      return '操作太频繁，请稍后再试';
    }
    if (/invalid login|invalid credentials|wrong password/i.test(message)) return '邮箱或密码不正确';
    if (/password/i.test(message) && /required|missing/i.test(message)) return '首次注册需要设置密码';
    if (/expired|invalid.*(code|token)/i.test(message)) return '验证码不正确或已过期，请重新获取';
    return message || fallback || '操作失败，请稍后重试';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function t(key, fallback) {
    if (typeof window.__wsT === 'function') {
      var str = window.__wsT(key, fallback);
      if (str) return str;
    }
    return fallback || key;
  }

  function fill(key, fallback, vars) {
    var text = t(key, fallback);
    if (!vars) return text;
    Object.keys(vars).forEach(function (name) {
      text = text.split('{' + name + '}').join(String(vars[name]));
    });
    return text;
  }

  /* ---------------- 第三方登录（M8） ----------------
   * 走 SDK 的 signInWithOAuth：它会先把 PKCE 的 code_verifier 存进 sessionStorage，
   * 再整页跳到 oauthRelayBaseUrl 中转；授权完成后浏览器回到本页
   * （redirectTo 默认取 origin + pathname），URL 上带 code / state / provider_id，
   * 这时调 handleOAuthCallback() 换会话。
   *
   * ⚠️ provider 只列实测可用的：wechat（跳微信扫码页）与 google（跳 Google 授权页）。
   *    workbuddy 这个 provider 目前中转会返回 400「WorkBuddy login could not be
   *    completed」，所以界面上不暴露它（SDK 支持不代表中转可用）。
   */

  var oauthWrap = q('[data-oauth]');
  var oauthButtons = q('[data-oauth-buttons]');
  var oauthBusy = false;

  var OAUTH_PROVIDERS = [
    { id: 'wechat', key: 'auth.oauthWechat', fallback: '微信' },
    { id: 'google', key: 'auth.oauthGoogle', fallback: 'Google' },
  ];

  function renderOAuth() {
    if (!oauthWrap || !oauthButtons) return;
    var auth = C.cloud ? C.cloud().auth : null;
    if (!auth || typeof auth.signInWithOAuth !== 'function' || !C.config || !C.config.oauthRelayBaseUrl) {
      oauthWrap.setAttribute('hidden', '');
      return;
    }
    oauthWrap.removeAttribute('hidden');
    oauthButtons.innerHTML = OAUTH_PROVIDERS.map(function (item) {
      return (
        '<button class="btn btn--ghost btn--sm oauth-btn oauth-btn--' + item.id + '" type="button" ' +
        'data-oauth-provider="' + item.id + '">' +
        esc(t(item.key, item.fallback)) +
        '</button>'
      );
    }).join('');

    qa('[data-oauth-provider]', oauthButtons).forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (oauthBusy) return;
        startOAuth(btn.getAttribute('data-oauth-provider'));
      });
    });
  }

  function startOAuth(provider) {
    var auth = C.cloud().auth;
    oauthBusy = true;
    showError('');
    showNotice(t('auth.oauthPending', '正在跳转…'));
    qa('[data-oauth-provider]', oauthButtons).forEach(function (btn) {
      btn.disabled = true;
    });
    auth
      .signInWithOAuth({ provider: provider })
      .then(function (res) {
        if (res && res.error) throw res.error;
        /* 正常路径下浏览器已经跳走了，走不到这里 */
      })
      .catch(function (err) {
        oauthBusy = false;
        qa('[data-oauth-provider]', oauthButtons).forEach(function (btn) {
          btn.disabled = false;
        });
        showNotice('');
        showError(friendly(err, t('auth.oauthFail', '第三方登录失败，请重试或改用邮箱登录')));
      });
  }

  /** URL 上带着授权码回来时才算 OAuth 回调。 */
  function isOAuthCallback() {
    var params = new URLSearchParams(location.search);
    return !!params.get('code') && params.get('provider_id') === 'custom-oauth';
  }

  function handleOAuthCallback() {
    var auth = C.cloud().auth;
    if (typeof auth.handleOAuthCallback !== 'function') return Promise.resolve(false);
    setBusy(true, '正在完成登录…');
    return auth
      .handleOAuthCallback()
      .then(function (res) {
        if (res && res.error) throw res.error;
        if (!res || !res.data) throw new Error(t('auth.oauthCallbackFail', '第三方登录没有完成，请重新试一次'));
        return afterLogin().then(function () {
          return true;
        });
      })
      .catch(function (err) {
        setBusy(false);
        showError(friendly(err, t('auth.oauthCallbackFail', '第三方登录没有完成，请重新试一次')));
        /* 把回调参数清掉，否则刷新页面会反复重试同一个失效的 code */
        try {
          window.history.replaceState(null, '', location.pathname);
        } catch (e) {
          /* 忽略 */
        }
        return false;
      });
  }

  /* ---------------- 登录失败次数锁定（M14） ----------------
   * 这是**前端**的减速带，不是安全边界：真正的防爆破靠服务端限流。
   * 目的是别让「对着一个邮箱狂试密码」在页面上毫无代价地连续发生。
   * 只存在本机 localStorage，换设备或清缓存即失效 —— 所以文案里也明说了。
   */

  var LOCK_KEY = 'wsblog:auth-lock:v1';
  var MAX_FAILS = 5;
  var LOCK_MS = 5 * 60 * 1000;

  var lockBox = q('[data-auth-lock]');
  var lockTimer = null;

  function lockStore() {
    try {
      var raw = window.localStorage.getItem(LOCK_KEY);
      var data = raw ? JSON.parse(raw) : null;
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      return {};
    }
  }

  function saveLockStore(data) {
    try {
      window.localStorage.setItem(LOCK_KEY, JSON.stringify(data));
    } catch (err) {
      /* 隐私模式：本次会话内不记失败次数 */
    }
  }

  function lockKey(email) {
    return String(email || '').trim().toLowerCase();
  }

  function lockState(email) {
    var store = lockStore();
    return store[lockKey(email)] || { fails: 0, until: 0 };
  }

  /** 记一次失败；达到阈值就给这个邮箱上一把 5 分钟的锁。 */
  function noteFail(email) {
    var store = lockStore();
    var key = lockKey(email);
    var record = store[key] || { fails: 0, until: 0 };
    record.fails = (record.fails || 0) + 1;
    if (record.fails >= MAX_FAILS) {
      record.fails = 0;
      record.until = Date.now() + LOCK_MS;
    }
    store[key] = record;
    saveLockStore(store);
    return record;
  }

  function clearFail(email) {
    var store = lockStore();
    delete store[lockKey(email)];
    saveLockStore(store);
  }

  /** 认证类错误才计失败；断网、限流不算，否则网络抖动也会把人锁住。 */
  function isAuthFailure(err) {
    var kind = (err && err.kind) || '';
    var message = String((err && err.message) || '');
    if (kind === 'invalid_grant' || kind === 'unauthenticated') return true;
    if (kind === 'network' || kind === 'backend-unavailable' || kind === 'rate_limit') return false;
    return /invalid login|invalid credentials|wrong password|invalid_grant/i.test(message);
  }

  function hideLock() {
    if (lockTimer) {
      clearInterval(lockTimer);
      lockTimer = null;
    }
    if (!lockBox) return;
    lockBox.setAttribute('hidden', '');
    lockBox.textContent = '';
    if (submitBtn && !busy) submitBtn.disabled = false;
  }

  /** 锁定中 → 倒计时并禁用提交；未锁定但已有失败 → 提示还剩几次。 */
  function applyLock(email) {
    if (!lockBox) return;
    var state = lockState(email);
    if (state.until && state.until > Date.now()) {
      var tick = function () {
        var left = Math.ceil((state.until - Date.now()) / 1000);
        if (left <= 0) {
          hideLock();
          showNotice('');
          return;
        }
        lockBox.removeAttribute('hidden');
        lockBox.innerHTML =
          '<strong>' + esc(t('auth.lockTitle', '尝试次数过多，已暂时锁定')) + '</strong>' +
          '<span>' + esc(fill('auth.lockWait', '请等 {n} 秒后再试', { n: left })) + '</span>' +
          '<small>' + esc(t('auth.lockSaved', '为了减少无效尝试，本站会在本机记录失败次数')) + '</small>';
        if (submitBtn) submitBtn.disabled = true;
      };
      if (lockTimer) clearInterval(lockTimer);
      tick();
      lockTimer = setInterval(tick, 1000);
      return;
    }
    hideLock();
    if (state.fails > 0) {
      lockBox.removeAttribute('hidden');
      lockBox.innerHTML =
        '<span>' +
        esc(fill('auth.lockLeft', '还剩 {n} 次机会，之后会锁定 5 分钟', { n: MAX_FAILS - state.fails })) +
        '</span>';
    }
  }

  /* ---------------- 外部参数 ---------------- */

  function nextUrl() {
    var params = new URLSearchParams(location.search);
    var next = params.get('next') || '';
    /* 只允许站内相对路径，避免被构造成开放重定向 */
    if (next.charAt(0) === '/' && next.charAt(1) !== '/') return C.root + next.replace(/^\//, '');
    return C.root + 'index.html';
  }

  /* ---------------- 登录方式切换 ---------------- */

  function applyMethod(next) {
    method = next === 'otp' ? 'otp' : 'password';
    qa('[data-tab]').forEach(function (btn) {
      var active = btn.getAttribute('data-tab') === method;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    qa('[data-panel]').forEach(function (panel) {
      if (panel.getAttribute('data-panel') === method) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
    if (submitBtn && !busy) {
      submitBtn.textContent = method === 'otp' ? '登录 / 注册' : '登录';
      delete submitBtn.dataset.idle;
    }
    showError('');
  }

  qa('[data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      applyMethod(btn.getAttribute('data-tab'));
    });
  });

  /* ---------------- 登录成功后的收尾 ---------------- */

  /** 展示「选择进入身份」——只有白名单里的管理员账号会走到这里。 */
  function showIdentityPick() {
    var user = C.currentUser();
    var mail = q('[data-pick-email]');
    if (mail) mail.textContent = (user && (user.email || user.phone)) || '当前账号';
    if (formWrap) formWrap.setAttribute('hidden', '');
    if (signedInWrap) signedInWrap.setAttribute('hidden', '');
    if (pickWrap) pickWrap.removeAttribute('hidden');
    setBusy(false);
    showError('');
  }

  function enterAs(target) {
    return C.setIdentity(target).then(function (ok) {
      pickBusy = false;
      if (!ok) return;
      if (target === 'admin') {
        location.href = C.root + 'admin.html';
        return;
      }
      var params = new URLSearchParams(location.search);
      location.href = params.get('next') ? nextUrl() : C.root + 'account.html';
    });
  }

  qa('[data-pick]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (pickBusy) return;
      pickBusy = true;
      showError('');
      enterAs(btn.getAttribute('data-pick') === 'admin' ? 'admin' : 'user');
    });
  });

  var pickSignOut = q('[data-pick-signout]');
  if (pickSignOut) {
    pickSignOut.addEventListener('click', function () {
      pickSignOut.disabled = true;
      C.signOut().then(function () {
        location.reload();
      });
    });
  }

  /** 登录成功后按账号权限分流。 */
  function afterLogin() {
    return C.refresh().then(function () {
      if (C.isAdminSync()) {
        showIdentityPick();
        return;
      }
      C.setIdentity('user');
      location.href = nextUrl();
    });
  }

  /* ---------------- 忘记密码（自助重置） ---------------- */

  var resetWrap = q('[data-reset-wrap]');
  var resetForm = q('[data-reset-form]');
  var resetEmailInput = q('[name="resetEmail"]');
  var resetCodeInput = q('[name="resetCode"]');
  var resetPasswordInput = q('[name="resetPassword"]');
  var resetPassword2Input = q('[name="resetPassword2"]');
  var resetSendBtn = q('[data-reset-send]');
  var resetSubmitBtn = q('[data-reset-submit]');
  var resetErrorBox = q('[data-reset-error]');
  var resetNoticeBox = q('[data-reset-notice]');

  var resetHandle = null; /* resetPasswordForEmail 返回的 { updateUser } */
  var resetSendTimer = null;
  var resetLeft = 0;

  function showResetError(message) {
    if (!resetErrorBox) return;
    resetErrorBox.textContent = message || '';
    if (message) resetErrorBox.removeAttribute('hidden');
    else resetErrorBox.setAttribute('hidden', '');
  }

  function showResetNotice(message) {
    if (!resetNoticeBox) return;
    resetNoticeBox.textContent = message || '';
    if (message) resetNoticeBox.removeAttribute('hidden');
    else resetNoticeBox.setAttribute('hidden', '');
  }

  /** 在「登录表单 / 身份选择 / 已登录 / 重置密码」之间切换。 */
  function showReset(on) {
    if (!resetWrap) return;
    if (on) {
      resetWrap.removeAttribute('hidden');
      [formWrap, pickWrap, signedInWrap].forEach(function (el) {
        if (el) el.setAttribute('hidden', '');
      });
      if (resetEmailInput) {
        if (!resetEmailInput.value) resetEmailInput.value = (emailInput && emailInput.value || '').trim();
        if (resetEmailInput.value && resetCodeInput) resetCodeInput.focus();
        else resetEmailInput.focus();
      }
      return;
    }
    resetWrap.setAttribute('hidden', '');
    if (C.currentUser()) {
      if (signedInWrap) signedInWrap.removeAttribute('hidden');
    } else if (formWrap) {
      formWrap.removeAttribute('hidden');
    }
  }

  function onSendResetCode() {
    var email = (resetEmailInput && resetEmailInput.value || '').trim();
    if (!email || email.indexOf('@') < 1) {
      showResetError('请填写注册时用的邮箱');
      if (resetEmailInput) resetEmailInput.focus();
      return;
    }
    if (resetSendTimer) return;

    showResetError('');
    showResetNotice('');
    resetSendBtn.disabled = true;
    resetSendBtn.textContent = '发送中…';

    C.resetPasswordForEmail(email)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var handle = res && res.data;
        if (!handle || typeof handle.updateUser !== 'function') {
          throw new Error('云端没有返回重置凭证，请稍后重试');
        }
        resetHandle = handle;
        showResetNotice('验证码已发送到 ' + email + '，10 分钟内有效。');
        if (resetCodeInput) resetCodeInput.focus();

        resetLeft = 60;
        resetSendBtn.textContent = resetLeft + 's 后重发';
        resetSendTimer = setInterval(function () {
          resetLeft -= 1;
          if (resetLeft <= 0) {
            clearInterval(resetSendTimer);
            resetSendTimer = null;
            resetSendBtn.disabled = false;
            resetSendBtn.textContent = '重新发送';
            return;
          }
          resetSendBtn.textContent = resetLeft + 's 后重发';
        }, 1000);
      })
      .catch(function (err) {
        resetSendBtn.disabled = false;
        resetSendBtn.textContent = '获取验证码';
        showResetError(friendly(err, '验证码发送失败，请稍后重试'));
      });
  }

  function onResetSubmit(event) {
    if (event) event.preventDefault();
    var code = (resetCodeInput && resetCodeInput.value || '').trim();
    var password = (resetPasswordInput && resetPasswordInput.value) || '';
    var confirm = (resetPassword2Input && resetPassword2Input.value) || '';

    if (!resetHandle) {
      showResetError('请先获取邮箱验证码');
      return;
    }
    if (!code) {
      showResetError('请填写邮件里收到的验证码');
      if (resetCodeInput) resetCodeInput.focus();
      return;
    }
    if (password.length < 6) {
      showResetError('新密码至少 6 位');
      if (resetPasswordInput) resetPasswordInput.focus();
      return;
    }
    if (password !== confirm) {
      showResetError('两次输入的新密码不一致');
      if (resetPassword2Input) resetPassword2Input.focus();
      return;
    }

    showResetError('');
    resetSubmitBtn.disabled = true;
    resetSubmitBtn.textContent = '提交中…';

    resetHandle.updateUser({ nonce: code, password: password })
      .then(function (res) {
        if (res && res.error) throw res.error;
        resetHandle = null;
        showResetNotice('密码已重置，正在登录…');
        return afterLogin();
      })
      .catch(function (err) {
        resetSubmitBtn.disabled = false;
        resetSubmitBtn.textContent = '重置密码并登录';
        showResetError(friendly(err, '重置失败，请检查验证码是否正确'));
      });
  }

  var forgotBtn = q('[data-auth-forgot]');
  if (forgotBtn) {
    forgotBtn.addEventListener('click', function () {
      showReset(true);
    });
  }
  var resetBackBtn = q('[data-reset-back]');
  if (resetBackBtn) {
    resetBackBtn.addEventListener('click', function () {
      showReset(false);
    });
  }
  if (resetSendBtn) resetSendBtn.addEventListener('click', onSendResetCode);
  if (resetForm) resetForm.addEventListener('submit', onResetSubmit);

  function onSubmit(event) {
    if (event) event.preventDefault();
    if (busy) return;

    var email = (emailInput && emailInput.value || '').trim();
    if (!email || email.indexOf('@') < 1) {
      showError('请填写有效的邮箱地址');
      if (emailInput) emailInput.focus();
      return;
    }
    showError('');

    if (method === 'password') {
      var password = (passwordInput && passwordInput.value) || '';
      if (!password) {
        showError('请输入密码');
        if (passwordInput) passwordInput.focus();
        return;
      }
      setBusy(true, '登录中…');
      C.signInWithPassword(email, password)
        .then(function (res) {
          if (res && res.error) throw res.error;
          clearFail(email);
          hideLock();
          return afterLogin();
        })
        .catch(function (err) {
          setBusy(false);
          showError(friendly(err, '登录失败，请稍后重试'));
          if (isAuthFailure(err)) {
            noteFail(email);
            applyLock(email);
          }
        });
      return;
    }

    /* 邮箱验证码 */
    var code = (codeInput && codeInput.value || '').trim();
    if (!code) {
      showError('请填写邮箱里收到的验证码');
      if (codeInput) codeInput.focus();
      return;
    }
    if (!pendingOtp || pendingOtp.email !== email) {
      showError('请先点击「获取验证码」，且不要更换邮箱');
      return;
    }
    var signupPassword = (signupPasswordInput && signupPasswordInput.value) || '';
    var saved = pendingOtp;
    setBusy(true, '验证中…');
    C.verifyOtp({
      email: saved.email,
      verificationId: saved.verificationId,
      isExistingUser: saved.isExistingUser,
      token: code,
      password: saved.isExistingUser ? undefined : signupPassword || undefined,
    })
      .then(function (res) {
        if (res && res.error) throw res.error;
        pendingOtp = null;
        clearFail(email);
        hideLock();
        return afterLogin();
      })
      .catch(function (err) {
        setBusy(false);
        showError(friendly(err, '验证码校验失败'));
        if (isAuthFailure(err)) {
          noteFail(email);
          applyLock(email);
        }
      });
  }

  if (form) form.addEventListener('submit', onSubmit);

  /* ---------------- 获取验证码 ---------------- */

  function startCountdown(seconds) {
    var left = seconds;
    if (countdownTimer) clearInterval(countdownTimer);
    sendCodeBtn.disabled = true;
    sendCodeBtn.textContent = left + ' 秒后可重发';
    countdownTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        sendCodeBtn.disabled = false;
        sendCodeBtn.textContent = '重新获取';
        return;
      }
      sendCodeBtn.textContent = left + ' 秒后可重发';
    }, 1000);
  }

  if (sendCodeBtn) {
    sendCodeBtn.addEventListener('click', function () {
      var email = (emailInput && emailInput.value || '').trim();
      if (!email || email.indexOf('@') < 1) {
        showError('请先填写有效的邮箱地址');
        if (emailInput) emailInput.focus();
        return;
      }
      showError('');
      sendCodeBtn.disabled = true;
      sendCodeBtn.textContent = '发送中…';
      C.sendOtp({ email: email })
        .then(function (res) {
          if (res && res.error) throw res.error;
          var data = (res && res.data) || {};
          pendingOtp = {
            email: email,
            verificationId: data.verificationId,
            isExistingUser: data.isExistingUser === true,
          };
          showNotice('验证码已发送到 ' + email + '，10 分钟内有效。');
          startCountdown(60);
        })
        .catch(function (err) {
          sendCodeBtn.disabled = false;
          sendCodeBtn.textContent = '重新获取';
          showError(friendly(err, '验证码发送失败，请稍后重试'));
        });
    });
  }

  /* ---------------- 已登录状态 ---------------- */

  function renderSignedIn() {
    var user = C.currentUser();
    if (!user || !signedInWrap) return false;
    if (formWrap) formWrap.setAttribute('hidden', '');
    signedInWrap.removeAttribute('hidden');

    var name = q('[data-signed-in-name]');
    var mail = q('[data-signed-in-mail]');
    var roleBox = q('[data-signed-in-role]');
    var adminLink = q('[data-signed-in-admin]');
    var switchBtn = q('[data-signed-in-switch]');

    if (name) name.textContent = C.displayName() || '已登录';
    if (mail) mail.textContent = user.email || user.phone || '';
    if (roleBox) roleBox.textContent = C.isAdminMode() ? '管理员身份' : '普通用户身份';
    if (adminLink) {
      if (C.isAdminSync()) adminLink.removeAttribute('hidden');
      else adminLink.setAttribute('hidden', '');
    }
    if (switchBtn) {
      if (C.isAdminSync()) {
        switchBtn.removeAttribute('hidden');
        switchBtn.textContent = C.isAdminMode() ? '切换为普通用户身份' : '切换到管理员身份';
      } else {
        switchBtn.setAttribute('hidden', '');
      }
    }
    return true;
  }

  function bindSignedIn() {
    var switchBtn = q('[data-signed-in-switch]');
    if (switchBtn) {
      switchBtn.addEventListener('click', function () {
        var target = C.isAdminMode() ? 'user' : 'admin';
        switchBtn.disabled = true;
        C.setIdentity(target).then(function (ok) {
          switchBtn.disabled = false;
          if (!ok) return;
          location.href = C.root + (target === 'admin' ? 'admin.html' : 'account.html');
        });
      });
    }
    var outBtn = q('[data-signed-in-signout]');
    if (outBtn) {
      outBtn.addEventListener('click', function () {
        outBtn.disabled = true;
        C.signOut().then(function () {
          location.reload();
        });
      });
    }
  }

  /* ---------------- 启动 ---------------- */

  /* 站点域名与云端应用域名不一致时，登录会被服务端 Origin 校验拒绝 —— 提前说清楚 */
  function checkOrigin() {
    var expected = C.config && C.config.siteOrigin;
    if (!expected) return;
    if (location.origin !== expected) {
      showNotice(
        '当前访问域名是 ' + location.origin + '，而登录服务只接受 ' + expected +
        '。请用正确域名打开本站，否则登录会失败。'
      );
    }
  }

  applyMethod('password');
  checkOrigin();
  bindSignedIn();
  renderOAuth();

  /* 换一个邮箱就按那个邮箱的记录重新评估锁定状态 */
  if (emailInput) {
    emailInput.addEventListener('input', function () {
      applyLock(emailInput.value);
    });
  }

  /* OAuth 回调优先：URL 上带着授权码回来时，由它决定跳到哪儿 */
  if (isOAuthCallback()) {
    handleOAuthCallback();
    return;
  }

  applyLock(emailInput ? emailInput.value : '');

  C.booted().then(function () {
    if (renderSignedIn()) {
      C.onSessionChange(function () {
        renderSignedIn();
      });
    }
  });
})();
