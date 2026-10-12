/**
 * 登录 / 注册页逻辑。
 *
 * 三种入口收敛在同一表单上：
 *   · 普通用户 —— 注册或登录，进入用户身份
 *   · 管理员   —— 登录后校验白名单，通过则进入管理员身份
 *   · 管理员也可以选「普通用户」入口登录，之后随时在顶栏切换身份
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
  var signedInWrap = q('[data-signed-in]');
  var titleEl = q('[data-auth-title]');
  var leadEl = q('[data-auth-lead]');

  var role = 'user'; /* 'user' | 'admin' */
  var method = 'password'; /* 'password' | 'otp' */
  var pendingOtp = null; /* { email, verificationId, isExistingUser } */
  var countdownTimer = null;
  var busy = false;

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

  /* ---------------- 外部参数 ---------------- */

  function nextUrl() {
    var params = new URLSearchParams(location.search);
    var next = params.get('next') || '';
    /* 只允许站内相对路径，避免被构造成开放重定向 */
    if (next.charAt(0) === '/' && next.charAt(1) !== '/') return C.root + next.replace(/^\//, '');
    return C.root + 'index.html';
  }

  function wantedRole() {
    var params = new URLSearchParams(location.search);
    return params.get('role') === 'admin' ? 'admin' : 'user';
  }

  /* ---------------- 身份切换 ---------------- */

  function applyRole(next, persist) {
    role = next === 'admin' ? 'admin' : 'user';
    qa('[data-role]').forEach(function (btn) {
      var active = btn.getAttribute('data-role') === role;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (titleEl) titleEl.textContent = role === 'admin' ? '管理员登录' : '登录 / 注册';
    if (leadEl) {
      leadEl.textContent =
        role === 'admin'
          ? '管理员登录后会校验白名单。同一个账号也可以改用「普通用户」身份登录。'
          : '注册后可以评论、点赞与收藏文章。管理员请切换到「管理员」入口。';
    }
    if (persist && C.setIdentity) C.setIdentity(role === 'admin' ? 'admin' : 'user');
    document.documentElement.setAttribute('data-auth-role', role);
  }

  qa('[data-role]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      showError('');
      applyRole(btn.getAttribute('data-role'), false);
    });
  });

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
    var label = method === 'otp' ? '登录 / 注册' : '登录';
    if (submitBtn && !busy) {
      submitBtn.textContent = role === 'admin' ? '以管理员身份登录' : label;
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

  function afterLogin(roleWanted) {
    return C.refresh().then(function () {
      if (roleWanted === 'admin') {
        if (!C.isAdminSync()) {
          return C.signOut().then(function () {
            showError('这个账号没有管理员权限，已自动退出。你可以改用「普通用户」身份登录。');
            applyRole('user', false);
            setBusy(false);
          });
        }
        return C.setIdentity('admin').then(function () {
          location.href = C.root + 'admin.html';
        });
      }
      C.setIdentity('user');
      return new Promise(function (resolve) {
        location.href = nextUrl();
        resolve();
      });
    });
  }

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
          return afterLogin(role);
        })
        .catch(function (err) {
          setBusy(false);
          showError(friendly(err, '登录失败，请稍后重试'));
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
        return afterLogin(role);
      })
      .catch(function (err) {
        setBusy(false);
        showError(friendly(err, '验证码校验失败'));
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

  applyRole(wantedRole(), false);
  applyMethod('password');
  checkOrigin();
  bindSignedIn();

  C.booted().then(function () {
    if (renderSignedIn()) {
      C.onSessionChange(function () {
        renderSignedIn();
      });
      return;
    }
    /* 已登录的普通用户访问管理员入口时，直接把身份切过去更顺手 */
    var params = new URLSearchParams(location.search);
    if (params.get('role') === 'admin' && C.isAdminSync() && !C.isAdminMode()) {
      applyRole('admin', false);
    }
  });
})();
