/**
 * 个人中心：资料、邮箱、登录设备、投稿、评论、收藏、阅读历史、黑名单、数据与账号。
 *
 * 所有查询都依赖 RLS 按 owner_id 自动收敛，前端不自己过滤「这行是不是我的」——
 * 那只是展示层的判断，不是安全边界。
 *
 * 本文件在第六批（缺口 M2–M16）新增/改动：
 *   M2  评论 15 分钟内就地编辑（窗口由服务端 comments_stamp_author 强制）
 *   M5  邮箱变更申请（request_email_change；密码自证靠一次登录校验完成，
 *      因为云平台只给「邮箱+密码」登录，没有改邮箱接口）
 *   M6  登录设备列表与「退出其他设备」（session_touch / session_kill_others）
 *   M7  数据导出（export_my_data）与账号注销（delete_my_account）
 *   M9  邮箱验证（sendOtp → verifyOtp → mark_email_verified）
 *   M10 收藏分组与私密（post_bookmarks.folder / is_private）
 *   M11 最近阅读（reading_history）
 *   M12 头像裁剪入口（交给 avatar-crop.js）
 *   M13 黑名单管理（user_blocks）
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var page = document.querySelector('[data-account]');
  if (!page) return;

  function q(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function qa(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  var esc = C.escapeHtml;
  var toast = C.toast;

  /* 文案（V13）：字典在 assets/i18n.js。__wsT 不做占位符替换，这里补一层。 */
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

  /* ---------------- DOM ---------------- */

  var nicknameInput = q('[data-profile-nickname]');
  var avatarInput = q('[data-profile-avatar]');
  var bioInput = q('[data-profile-bio]');
  var saveBtn = q('[data-profile-save]');
  var avatarPreview = q('[data-profile-avatar-preview]');
  var emailEl = q('[data-account-email]');
  var emailStatusEl = q('[data-email-status]');
  var roleEl = q('[data-account-role]');
  var sinceEl = q('[data-account-since]');
  var joinedEl = q('[data-account-joined]');
  var pendingEl = q('[data-account-pending]');
  var commentsEl = q('[data-my-comments]');
  var bookmarksEl = q('[data-my-bookmarks]');
  var folderBarEl = q('[data-folder-bar]');
  var myPostsEl = q('[data-my-posts]');
  var myPostCountEl = q('[data-my-post-count]');
  var readingEl = q('[data-my-reading]');
  var blocksEl = q('[data-my-blocks]');
  var identitySwitch = q('[data-account-identity]');

  /* 邮箱区块 */
  var emailReadonly = q('[data-email-readonly]');
  var emailBadge = q('[data-email-badge]');
  var emailVerifyBtn = q('[data-email-verify]');
  var emailVerifyBox = q('[data-email-verify-box]');
  var emailCodeEl = q('[data-email-code]');
  var emailCodeSend = q('[data-email-code-send]');
  var emailCodeSubmit = q('[data-email-code-submit]');
  var emailVerifyNote = q('[data-email-verify-note]');
  var emailNewEl = q('[data-email-new]');
  var emailPasswordEl = q('[data-email-password]');
  var emailNoteEl = q('[data-email-change-note]');
  var emailChangeSubmit = q('[data-email-change-submit]');

  /* 登录设备 */
  var sessionListEl = q('[data-session-list]');
  var sessionKillBtn = q('[data-session-kill]');

  /* 数据与账号 */
  var exportBtn = q('[data-export-data]');
  var deleteBtn = q('[data-delete-account]');
  var deleteModal = q('[data-delete-modal]');
  var deleteConfirmEl = q('[data-delete-confirm]');
  var deleteSubmitBtn = q('[data-delete-submit]');
  var deleteCancelBtn = q('[data-delete-cancel]');

  /* ---------------- 通用小工具 ---------------- */

  var profile = null;
  var accountState = null;

  function emptyRow(text) {
    return '<li class="stack-empty">' + esc(text) + '</li>';
  }

  function badge(text, cls) {
    return '<span class="badge ' + (cls || 'badge--muted') + '">' + esc(text) + '</span>';
  }

  /** 把 post_slug 还原成可点击的文章地址。云端文章带 cloud: 前缀。 */
  function postUrl(slug) {
    if (!slug) return C.root + 'index.html';
    if (slug.indexOf('cloud:') === 0) {
      return C.root + 'post.html?slug=' + encodeURIComponent(slug.slice(6));
    }
    return C.root + 'posts/' + slug + '.html';
  }

  function postLabel(slug) {
    if (!slug) return '文章';
    if (slug.indexOf('cloud:') === 0) return slug.slice(6);
    return slug;
  }

  function initials(text) {
    var value = String(text || '?').trim();
    return esc(value.slice(0, 1).toUpperCase() || '?');
  }

  function currentEmail() {
    var fromState = accountState && accountState.email;
    if (fromState) return String(fromState);
    var user = C.currentUser();
    return String((user && (user.email || user.phone)) || '');
  }

  function isSessionGone(err) {
    return /no active session|unauthenticated|not authenticated|jwt/i.test(
      String((err && err.message) || err || '')
    );
  }

  function errorMessage(err, fallback) {
    var message = String((err && (err.message || err.error_description)) || '');
    if (isSessionGone(err)) return '登录状态已过期，请重新登录后再试';
    return message || fallback;
  }

  /* ---------------- 列表分页（V3） ----------------
   * 「我的投稿 / 我的评论 / 我的收藏」原来各自写死一个 limit（30 / 100 / 100），
   * 超出的部分**静默消失** —— 用户看到的就是「我明明有更多评论」。
   * 现在改成：按需扩展 limit（offset 语义），并且在被截断时把「已显示最近 N 条」
   * 和「加载更多」明说给用户。数据量不大（个人维度），不需要真正游标分页。
   */
  var listState = {
    posts: { limit: 30, step: 30 },
    comments: { limit: 100, step: 100 },
    bookmarks: { limit: 100, step: 100 },
    reading: { limit: 20, step: 20 },
    blocks: { limit: 50, step: 50 },
  };

  function moreRow(kind) {
    return (
      '<li class="stack-more">' +
      '<button class="link-btn" type="button" data-list-more="' + kind + '">' +
      esc(t('account.loadMore', '加载更多')) +
      '</button></li>'
    );
  }

  function truncationNote(kind, shown) {
    return '<li class="stack-note">' + esc(fill('account.showingRecent', '已显示最近 {n} 条', { n: shown })) + '</li>';
  }

  /* 返回 true 表示「可能还有更多」：拉满一页就认为被截断了 */
  function maybeMore(kind, shown) {
    return shown >= listState[kind].limit;
  }

  var LOADERS = {
    posts: function () { return loadMyPosts(); },
    comments: function () { return loadComments(); },
    bookmarks: function () { return loadBookmarks(); },
    reading: function () { return loadReading(); },
    blocks: function () { return loadBlocks(); },
  };

  function bindMoreButtons() {
    [myPostsEl, commentsEl, bookmarksEl, readingEl, blocksEl].forEach(function (el) {
      if (!el) return;
      el.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-list-more]') : null;
        if (!btn) return;
        e.preventDefault();
        var kind = btn.getAttribute('data-list-more');
        if (!listState[kind] || !LOADERS[kind]) return;
        listState[kind].limit += listState[kind].step;
        btn.disabled = true;
        LOADERS[kind]();
      });
    });
  }

  /* ---------------- 资料 ---------------- */

  function renderProfile() {
    var user = C.currentUser();
    var name = (profile && profile.nickname) || C.displayName() || '读者';
    var avatar = profile && profile.avatar_url;

    if (nicknameInput) nicknameInput.value = (profile && profile.nickname) || '';
    if (avatarInput) avatarInput.value = avatar || '';
    if (bioInput) bioInput.value = (profile && profile.bio) || '';
    if (emailEl) emailEl.textContent = currentEmail() || '—';
    if (roleEl) roleEl.textContent = C.isAdminMode() ? '管理员' : '普通用户';
    if (sinceEl) {
      sinceEl.textContent = profile && profile.created_at ? C.formatDate(profile.created_at) : '—';
    }
    if (joinedEl) {
      var joined = (user && (user.created_at || user.createdAt)) || (profile && profile.created_at);
      joinedEl.textContent = joined ? C.formatDate(joined) : '—';
    }
    if (avatarPreview) {
      avatarPreview.innerHTML = avatar
        ? '<img src="' + esc(avatar) + '" alt="" loading="lazy">'
        : initials(name);
    }
    var heroName = q('[data-account-name]');
    if (heroName) heroName.textContent = name;
    var heroBio = q('[data-account-bio]');
    if (heroBio) heroBio.textContent = (profile && profile.bio) || '还没有填写简介。';

    if (emailStatusEl) {
      if (accountState && accountState.email_verified_at) {
        emailStatusEl.removeAttribute('hidden');
        emailStatusEl.textContent = t('account.emailVerified', '已验证');
      } else {
        emailStatusEl.removeAttribute('hidden');
        emailStatusEl.textContent = t('account.emailUnverified', '未验证');
      }
    }

    if (identitySwitch) {
      if (C.isAdminSync()) {
        identitySwitch.removeAttribute('hidden');
        identitySwitch.textContent = C.isAdminMode() ? '切换为普通用户身份' : '切换到管理员身份';
      } else {
        identitySwitch.setAttribute('hidden', '');
      }
    }
  }

  function loadProfile() {
    var uid = C.currentUid();
    if (!uid) return Promise.resolve(null);
    return C.db()
      .from('profiles')
      .select('owner_id, nickname, avatar_url, bio, created_at, status,' +
              ' email_verified_at, pending_email, pending_email_at')
      .eq('owner_id', uid)
      .maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        profile = res.data || null;
        return profile;
      });
  }

  function saveProfile() {
    if (C.requireActive()) return;
    var payload = {
      nickname: ((nicknameInput && nicknameInput.value) || '').trim().slice(0, 40),
      avatar_url: ((avatarInput && avatarInput.value) || '').trim().slice(0, 500),
      bio: ((bioInput && bioInput.value) || '').trim().slice(0, 300),
      updated_at: new Date().toISOString(),
    };
    if (!payload.nickname) {
      toast('请填写昵称');
      return;
    }
    var uid = C.currentUid();
    if (!uid) {
      toast('登录状态已失效，请重新登录');
      return;
    }
    if (saveBtn) saveBtn.disabled = true;

    /* 先尝试更新；影响 0 行说明还没建过资料行，再插入。
       不写 owner_id —— 由 DEFAULT auth.uid() 填，避免与 RLS 冲突。 */
    C.db()
      .from('profiles')
      .update(payload)
      .eq('owner_id', uid)
      .select()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        if (rows.length) {
          profile = rows[0];
          return profile;
        }
        return C.db()
          .from('profiles')
          .insert(payload)
          .select()
          .then(function (inserted) {
            if (inserted && inserted.error) {
              if (inserted.error.code === '23505') return loadProfile();
              throw inserted.error;
            }
            var created = (inserted && inserted.data) || [];
            if (!created.length) throw new Error('资料保存失败，请稍后重试');
            profile = created[0];
            return profile;
          });
      })
      .then(function () {
        renderProfile();
        toast('资料已保存');
        /* 资料补齐后要让新手引导复检，否则它还挂在那儿（M15） */
        if (window.WSBlogOnboard) window.WSBlogOnboard.check(profile);
        return C.refresh();
      })
      .catch(function (err) {
        console.warn('[account] 资料保存失败', err && err.message);
        toast(errorMessage(err, '保存失败，请稍后重试'));
      })
      .then(function () {
        if (saveBtn) saveBtn.disabled = false;
      });
  }

  if (saveBtn) saveBtn.addEventListener('click', saveProfile);

  /* 头像上传（M12）：走裁剪弹窗，落到存储的是 256×256 的 JPEG，不是手机原图 */
  var avatarUploadBtn = q('[data-avatar-upload]');
  if (avatarUploadBtn) {
    avatarUploadBtn.addEventListener('click', function () {
      if (C.requireActive()) return;
      var uid = C.currentUid();
      if (!uid) {
        toast('登录状态已失效，请重新登录');
        return;
      }
      if (!window.WSBlogAvatar) {
        toast('上传模块未加载，请刷新后重试');
        return;
      }
      window.WSBlogAvatar.pick({ uid: uid, filename: 'avatar-' + uid })
        .then(function (res) {
          if (!res) return; /* 用户取消 */
          if (avatarInput && res.url) {
            avatarInput.value = res.url;
            avatarInput.dispatchEvent(new Event('input'));
          }
          toast(t('account.avatarPending', '头像已上传，点「保存资料」生效'));
        })
        .catch(function (err) {
          toast(errorMessage(err, t('account.cropFail', '裁剪失败，请重试')));
        });
    });
  }

  if (avatarInput) {
    avatarInput.addEventListener('input', function () {
      if (!avatarPreview) return;
      var value = avatarInput.value.trim();
      avatarPreview.innerHTML = value
        ? '<img src="' + esc(value) + '" alt="" loading="lazy">'
        : initials((nicknameInput && nicknameInput.value) || C.displayName());
    });
  }

  /* ---------------- 邮箱：验证与变更申请（M5 / M9） ---------------- */

  var pendingVerify = null;
  var verifyTimer = null;

  function renderEmail() {
    var email = currentEmail();
    if (emailReadonly) emailReadonly.value = email || '';
    if (emailBadge) {
      emailBadge.removeAttribute('hidden');
      emailBadge.textContent = accountState && accountState.email_verified_at
        ? t('account.emailVerified', '已验证')
        : t('account.emailUnverified', '未验证');
    }
    if (pendingEl) {
      var pending = accountState && accountState.pending_email;
      if (pending) {
        pendingEl.removeAttribute('hidden');
        pendingEl.textContent = fill('account.emailPending', '已提交申请：改为 {email}，等站长处理', { email: pending });
      } else {
        pendingEl.setAttribute('hidden', '');
        pendingEl.textContent = '';
      }
    }
    if (emailEl) emailEl.textContent = email || '—';
    if (emailVerifyBtn) {
      var verified = !!(accountState && accountState.email_verified_at);
      emailVerifyBtn.disabled = verified || !email;
      emailVerifyBtn.textContent = verified
        ? t('account.emailVerified', '已验证')
        : t('account.emailVerify', '验证邮箱');
    }
  }

  function loadEmailState() {
    return C.db()
      .rpc('my_account')
      .then(function (res) {
        if (res && res.error) throw res.error;
        accountState = res && res.data ? res.data : null;
        /* 顺手把 cloud.js 的账号缓存刷新，顶栏与「已禁用」提示都依赖它 */
        return C.loadAccount();
      })
      .then(function () {
        renderEmail();
        renderProfile();
        return accountState;
      })
      .catch(function (err) {
        console.warn('[account] 账号状态读取失败', err && err.message);
        renderEmail();
        return null;
      });
  }

  if (emailVerifyBtn) {
    emailVerifyBtn.addEventListener('click', function () {
      if (!emailVerifyBox) return;
      if (emailVerifyBox.hasAttribute('hidden')) {
        emailVerifyBox.removeAttribute('hidden');
        if (emailCodeEl) emailCodeEl.focus();
      } else {
        emailVerifyBox.setAttribute('hidden', '');
      }
    });
  }

  function startVerifyCountdown(btn, seconds) {
    var left = seconds;
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    btn.disabled = true;
    var tick = function () {
      if (left <= 0) {
        clearInterval(verifyTimer);
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      btn.textContent = original + '（' + left + '）';
      left -= 1;
    };
    tick();
    verifyTimer = setInterval(tick, 1000);
  }

  if (emailCodeSend) {
    emailCodeSend.addEventListener('click', function () {
      var email = currentEmail();
      if (!email) {
        toast('还没有读到你的邮箱，请刷新重试');
        return;
      }
      emailCodeSend.disabled = true;
      C.sendOtp({ email: email })
        .then(function (res) {
          if (res && res.error) throw res.error;
          var data = (res && res.data) || {};
          pendingVerify = {
            email: email,
            verificationId: data.verificationId,
            isExistingUser: data.isExistingUser !== false,
          };
          if (emailVerifyNote) {
            emailVerifyNote.textContent = fill('account.emailVerifySend', '验证码已发送到 {email}，10 分钟内有效。', { email: email });
          }
          startVerifyCountdown(emailCodeSend, 60);
        })
        .catch(function (err) {
          emailCodeSend.disabled = false;
          toast(errorMessage(err, '验证码发送失败，请稍后重试'));
        });
    });
  }

  if (emailCodeSubmit) {
    emailCodeSubmit.addEventListener('click', function () {
      var code = ((emailCodeEl && emailCodeEl.value) || '').trim();
      if (!pendingVerify) {
        toast('请先点「发送验证码」');
        return;
      }
      if (!code) {
        toast('请输入收到的验证码');
        return;
      }
      emailCodeSubmit.disabled = true;
      C.verifyOtp({
        email: pendingVerify.email,
        verificationId: pendingVerify.verificationId,
        isExistingUser: pendingVerify.isExistingUser,
        token: code,
      })
        .then(function (res) {
          if (res && res.error) throw res.error;
          /* 平台只负责「人确实能收到这个邮箱的信」；归属标记存在我们自己的表里。
             这一步是客户端自证，仅用于界面提示，不作为权限依据。 */
          return C.db().rpc('mark_email_verified');
        })
        .then(function (res) {
          if (res && res.error) throw res.error;
          pendingVerify = null;
          if (emailCodeEl) emailCodeEl.value = '';
          if (emailVerifyBox) emailVerifyBox.setAttribute('hidden', '');
          toast(t('account.emailVerifyOk', '邮箱已验证'));
          return loadEmailState();
        })
        .catch(function (err) {
          toast(errorMessage(err, t('account.emailVerifyFail', '验证失败，请检查验证码')));
        })
        .then(function () {
          emailCodeSubmit.disabled = false;
        });
    });
  }

  /* 变更申请的错误码 → 文案（服务端返回的是机器可读的 code） */
  var EMAIL_ERRORS = {
    invalid_email: function () { return t('account.emailInvalid', '请填写有效的新邮箱'); },
    same_email: function () { return t('account.emailSame', '新邮箱和当前邮箱一样'); },
    email_taken: function () { return t('account.emailTaken', '这个邮箱已被其他账号使用'); },
    account_disabled: function () { return '此账号已被禁用，无法提交申请'; },
    unauthenticated: function () { return '登录状态已过期，请重新登录'; },
  };

  if (emailChangeSubmit) {
    emailChangeSubmit.addEventListener('click', function () {
      if (C.requireActive()) return;
      var next = ((emailNewEl && emailNewEl.value) || '').trim().toLowerCase();
      var password = (emailPasswordEl && emailPasswordEl.value) || '';
      var note = ((emailNoteEl && emailNoteEl.value) || '').trim();
      var current = currentEmail();

      if (!next || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(next)) {
        toast(t('account.emailInvalid', '请填写有效的新邮箱'));
        return;
      }
      if (next === current.toLowerCase()) {
        toast(t('account.emailSame', '新邮箱和当前邮箱一样'));
        return;
      }
      if (!password) {
        toast(t('account.emailNeedPassword', '请先填写当前密码'));
        return;
      }

      emailChangeSubmit.disabled = true;
      /* 密码自证：服务端不存密码，能验证密码的只有登录接口。
         用当前邮箱 + 输入密码登录一次，成功即证明是本人；失败直接中止。 */
      C.signInWithPassword(current, password)
        .then(function (res) {
          if (res && res.error) throw res.error;
          return C.db().rpc('request_email_change', {
            p_new_email: next,
            p_note: note || null,
          });
        })
        .then(function (res) {
          if (res && res.error) throw res.error;
          var data = (res && res.data) || {};
          if (data.ok !== true) {
            var mapper = EMAIL_ERRORS[data.error];
            throw new Error(mapper ? mapper() : t('account.emailFail', '提交失败，请稍后重试'));
          }
          if (emailNewEl) emailNewEl.value = '';
          if (emailPasswordEl) emailPasswordEl.value = '';
          if (emailNoteEl) emailNoteEl.value = '';
          toast(t('account.emailSent', '申请已提交，站长会收到通知'));
          return loadEmailState();
        })
        .catch(function (err) {
          var message = String((err && err.message) || '');
          if (/password|credential|invalid_grant|invalid login/i.test(message)) {
            toast(t('account.emailWrongPassword', '当前密码不正确'));
          } else {
            toast(errorMessage(err, t('account.emailFail', '提交失败，请稍后重试')));
          }
        })
        .then(function () {
          emailChangeSubmit.disabled = false;
        });
    });
  }

  /* ---------------- 登录设备（M6） ---------------- */

  function sessionRow(item) {
    var ua = String(item.user_agent || '');
    var detail = ua.length > 90 ? ua.slice(0, 90) + '…' : ua;
    return (
      '<li class="stack-item">' +
      '<div class="stack-item__head">' +
      '<span class="stack-item__title">' + esc(item.label || '未知设备') + '</span>' +
      (item.is_current ? badge(t('account.sessionCurrent', '本机'), 'badge--ok') : '') +
      '<span class="stack-item__time">' +
      esc(C.formatDateTime(item.last_seen_at || item.created_at)) +
      '</span>' +
      '</div>' +
      (detail ? '<p class="stack-item__note mono">' + esc(detail) + '</p>' : '') +
      '</li>'
    );
  }

  function loadSessions() {
    if (!sessionListEl) return Promise.resolve();
    return C.touchSession()
      .then(function (data) {
        if (!data || data.ok !== true) {
          sessionListEl.innerHTML = emptyRow(t('account.sessionFail', '读取登录设备失败'));
          return;
        }
        var rows = data.sessions || [];
        sessionListEl.innerHTML = rows.length
          ? rows.map(sessionRow).join('')
          : emptyRow(t('account.sessionNone', '没有其他设备'));
      })
      .catch(function (err) {
        console.warn('[account] 登录设备加载失败', err && err.message);
        sessionListEl.innerHTML = emptyRow(t('account.sessionFail', '读取登录设备失败'));
      });
  }

  if (sessionKillBtn) {
    sessionKillBtn.addEventListener('click', function () {
      if (!window.confirm(t('account.sessionKillConfirm', '让其他设备退出登录？'))) return;
      sessionKillBtn.disabled = true;
      C.db()
        .rpc('session_kill_others', { p_key: C.sessionKey() })
        .then(function (res) {
          if (res && res.error) throw res.error;
          var data = (res && res.data) || {};
          if (data.ok !== true) throw new Error(t('account.sessionFail', '读取登录设备失败'));
          toast(fill('account.sessionKilled', '已退出 {n} 台设备', { n: data.killed || 0 }));
          return loadSessions();
        })
        .catch(function (err) {
          toast(errorMessage(err, '操作失败，请稍后重试'));
        })
        .then(function () {
          sessionKillBtn.disabled = false;
        });
    });
  }

  /* ---------------- 我的投稿 ---------------- */

  var POST_STATUS = {
    draft: { label: '草稿', cls: 'status-badge--draft' },
    pending: { label: '待审核', cls: 'status-badge--pending' },
    published: { label: '已发布', cls: 'status-badge--published' },
    rejected: { label: '未通过', cls: 'status-badge--rejected' },
  };

  function myPostsRow(post) {
    var meta = POST_STATUS[post.status] || {};
    var published = post.status === 'published';
    var editHref = 'write.html?slug=' + encodeURIComponent(post.slug);
    var editPending = !!post.edit_submitted_at;
    var editRejected = !editPending && !!post.edit_review_note;
    return (
      '<li class="stack-item">' +
      '<div class="stack-item__head">' +
      '<span class="stack-item__title">' + esc(post.title) + '</span>' +
      '<span class="status-badge ' + (meta.cls || '') + '">' + esc(meta.label || post.status) + '</span>' +
      (editPending ? '<span class="status-badge status-badge--pending">修改待审</span>' : '') +
      '<span class="stack-item__time">' + esc(C.formatDate(post.updated_at || post.created_at)) + '</span>' +
      '</div>' +
      (post.status === 'rejected' && post.review_note
        ? '<p class="stack-item__note">未通过理由：' + esc(post.review_note) + '</p>'
        : '') +
      (editPending
        ? '<p class="stack-item__note">修改已提交，等站长审核。审核期间线上仍是原版本，读者不受影响。</p>'
        : '') +
      (editRejected
        ? '<p class="stack-item__note">上次修改被驳回：' + esc(post.edit_review_note) + '</p>'
        : '') +
      '<div class="stack-item__actions">' +
      (published
        ? '<a class="link-btn" href="' + esc(postUrl(post.slug)) + '">阅读</a>' +
          '<a class="link-btn" href="' + esc(editHref) + '">' + (editPending ? '查看修改' : '修改') + '</a>'
        : '<a class="link-btn" href="' + esc(editHref) + '">编辑</a>') +
      '</div>' +
      '</li>'
    );
  }

  function loadMyPosts() {
    var uid = C.currentUid();
    if (!uid || !myPostsEl) return Promise.resolve([]);
    return C.db()
      .from('cloud_posts')
      .select('slug, title, status, review_note, created_at, updated_at, published_at,' +
              ' edit_submitted_at, edit_review_note')
      .eq('author_id', uid)
      .order('updated_at', { ascending: false })
      .limit(listState.posts.limit)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var list = (res && res.data) || [];
        if (myPostCountEl) myPostCountEl.textContent = String(list.length);
        myPostsEl.innerHTML = list.length
          ? list.map(myPostsRow).join('') +
            (maybeMore('posts', list.length) ? truncationNote('posts', list.length) + moreRow('posts') : '')
          : '<li class="stack-empty">还没有投稿，<a href="write.html">写第一篇</a>。</li>';
        return list;
      })
      .catch(function (err) {
        console.warn('[account] 投稿加载失败', err && err.message);
        myPostsEl.innerHTML = emptyRow('投稿列表加载失败，请刷新重试。');
        return [];
      });
  }

  /* ---------------- 我的评论（M2 就地编辑） ---------------- */

  var EDIT_WINDOW_MS = 15 * 60 * 1000;

  /* 服务端超窗时 RAISE ... HINT = 'EDIT_WINDOW_CLOSED'：HINT 会落在 error.hint
     而不是 message 里，两处都要看，否则改一下中文文案这条分支就失效。 */
  function editWindowClosed(err) {
    var text = [err && err.message, err && err.hint, err && err.details].join(' ');
    return /EDIT_WINDOW_CLOSED|15 minutes|15 分钟/i.test(text);
  }

  function renderBody(content) {
    if (window.WSBlogInteract && typeof window.WSBlogInteract.renderBody === 'function') {
      return window.WSBlogInteract.renderBody(content);
    }
    return esc(content);
  }

  function commentStatusBadge(item) {
    if (item.status === 'pending') return badge(t('interact.pending', '待审'), 'badge--muted');
    if (item.status === 'hidden') return badge('已隐藏', 'badge--muted');
    return '';
  }

  function commentsRow(item) {
    var editable = Date.now() - new Date(item.created_at).getTime() < EDIT_WINDOW_MS;
    return (
      '<li class="stack-item" data-comment-row="' + item.id + '">' +
      '<div class="stack-item__head">' +
      '<a class="stack-item__title" href="' + esc(postUrl(item.post_slug)) + '">' +
      esc(postLabel(item.post_slug)) +
      '</a>' +
      commentStatusBadge(item) +
      (item.edited_at ? badge(t('interact.edited', '已编辑'), 'badge--muted') : '') +
      '<span class="stack-item__time">' + esc(C.formatDate(item.created_at)) + '</span>' +
      '</div>' +
      '<div class="stack-item__text" data-comment-body>' + renderBody(item.content) + '</div>' +
      '<div class="stack-item__actions">' +
      (editable
        ? '<button class="link-btn" type="button" data-comment-edit="' + item.id + '">' +
          esc(t('interact.edit', '编辑')) + '</button>'
        : '') +
      '<button class="link-btn" type="button" data-delete-comment="' + item.id + '">删除</button>' +
      '</div>' +
      '</li>'
    );
  }

  function loadComments() {
    if (!commentsEl) return Promise.resolve();
    var uid = C.currentUid();
    if (!uid) return Promise.resolve();
    return C.db()
      .from('comments')
      .select('id, post_slug, content, status, created_at, edited_at')
      .eq('owner_id', uid)
      .order('created_at', { ascending: false })
      .limit(listState.comments.limit)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        if (!rows.length) {
          commentsEl.innerHTML = '<li class="stack-empty">还没有发表过评论。</li>';
          return;
        }
        commentsEl.innerHTML =
          rows.map(commentsRow).join('') +
          (maybeMore('comments', rows.length) ? truncationNote('comments', rows.length) + moreRow('comments') : '');
        bindCommentActions();
      })
      .catch(function (err) {
        console.warn('[account] 评论加载失败', err && err.message);
        commentsEl.innerHTML = emptyRow('评论加载失败，请刷新重试。');
      });
  }

  function bindCommentActions() {
    qa('[data-delete-comment]', commentsEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-delete-comment');
        if (!window.confirm(t('interact.confirmDelete', '确定删除这条评论吗？'))) return;
        btn.disabled = true;
        C.db()
          .from('comments')
          .delete()
          .eq('id', id)
          .select()
          .then(function (res) {
            if (res && res.error) throw res.error;
            var rows = (res && res.data) || [];
            if (!rows.length) throw new Error('删除没有生效');
            toast(t('interact.deleted', '评论已删除'));
            return loadComments();
          })
          .catch(function (err) {
            btn.disabled = false;
            toast(errorMessage(err, t('interact.deleteFail', '删除失败')));
          });
      });
    });

    qa('[data-comment-edit]', commentsEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-comment-edit');
        var li = commentsEl.querySelector('[data-comment-row="' + id + '"]');
        if (!li) return;
        var body = li.querySelector('[data-comment-body]');
        var actions = li.querySelector('.stack-item__actions');
        if (!body || !actions || body.getAttribute('data-editing')) return;
        var original = body.textContent || '';
        body.setAttribute('data-editing', '1');
        body.innerHTML =
          '<textarea class="field__input" rows="3" maxlength="1000" data-comment-edit-input></textarea>' +
          '<span class="field__note">' + esc(t('interact.editWindow', '发表后 15 分钟内可以修改')) + '</span>';
        var input = body.querySelector('[data-comment-edit-input]');
        if (input) {
          input.value = original;
          input.focus();
        }
        actions.innerHTML =
          '<button class="btn btn--primary btn--sm" type="button" data-comment-save="' + id + '">' +
          esc(t('interact.editSave', '保存修改')) + '</button>' +
          '<button class="btn btn--ghost btn--sm" type="button" data-comment-cancel>' +
          esc(t('interact.editCancel', '放弃修改')) + '</button>';

        var cancel = actions.querySelector('[data-comment-cancel]');
        if (cancel) cancel.addEventListener('click', function () { loadComments(); });

        var save = actions.querySelector('[data-comment-save]');
        if (save) {
          save.addEventListener('click', function () {
            var content = ((input && input.value) || '').trim();
            if (!content) {
              toast(t('interact.editEmpty', '内容不能为空'));
              return;
            }
            save.disabled = true;
            C.db()
              .from('comments')
              .update({ content: content })
              .eq('id', id)
              .select()
              .then(function (res) {
                if (res && res.error) throw res.error;
                var rows = (res && res.data) || [];
                if (!rows.length) throw new Error('修改没有生效');
                /* 非管理员改内容会被触发器等降级为待审 —— 这是刻意设计，要告诉用户 */
                if (rows[0].status === 'pending') toast(t('interact.editReReview', '修改已提交，站长重新审核后显示'));
                else toast('已保存');
                return loadComments();
              })
              .catch(function (err) {
                save.disabled = false;
                if (editWindowClosed(err)) {
                  toast(t('interact.editExpired', '超过 15 分钟了，改不了；可以删除后重新发表。'));
                } else {
                  toast(errorMessage(err, t('interact.editFail', '修改失败，请稍后重试')));
                }
              });
          });
        }
      });
    });
  }

  /* ---------------- 我的收藏：分组与私密（M10） ---------------- */

  var FOLDER_STORE = 'wsblog:bookmark-folders';
  var bookmarkFilter = '';
  var bookmarkRows = [];

  function readExtraFolders() {
    try {
      var raw = window.localStorage.getItem(FOLDER_STORE);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string' && x; }) : [];
    } catch (err) {
      return [];
    }
  }

  function writeExtraFolders(list) {
    try {
      window.localStorage.setItem(FOLDER_STORE, JSON.stringify(list.slice(0, 40)));
    } catch (err) {
      /* 隐私模式：分组名仍写进收藏行，只是这里记不住空分组 */
    }
  }

  /** 全部分组 = 数据里出现过的 + 本机记着但暂时空着的。 */
  function allFolders() {
    var seen = {};
    var list = [];
    readExtraFolders().forEach(function (name) {
      if (!seen[name]) { seen[name] = 1; list.push(name); }
    });
    bookmarkRows.forEach(function (row) {
      var name = (row.folder || '').trim();
      if (name && !seen[name]) { seen[name] = 1; list.push(name); }
    });
    return list;
  }

  function folderCounts() {
    var counts = {};
    bookmarkRows.forEach(function (row) {
      var name = (row.folder || '').trim();
      counts[name] = (counts[name] || 0) + 1;
    });
    return counts;
  }

  function renderFolderBar() {
    if (!folderBarEl) return;
    var folders = allFolders();
    var counts = folderCounts();
    var total = bookmarkRows.length;
    var html =
      '<button class="chip' + (bookmarkFilter === '' ? ' is-active' : '') + '" type="button" data-folder="">' +
      esc(t('account.folderAll', '全部')) + '（' + total + '）</button>';
    folders.forEach(function (name) {
      html +=
        '<button class="chip' + (bookmarkFilter === name ? ' is-active' : '') +
        '" type="button" data-folder="' + esc(name) + '">' +
        esc(name) + '（' + (counts[name] || 0) + '）</button>';
    });
    html +=
      '<button class="chip chip--dashed" type="button" data-folder-new>' +
      esc(t('account.folderNew', '新建分组')) + '</button>';
    folderBarEl.innerHTML = html;

    qa('[data-folder]', folderBarEl).forEach(function (chip) {
      chip.addEventListener('click', function () {
        bookmarkFilter = chip.getAttribute('data-folder') || '';
        renderFolderBar();
        renderBookmarks();
      });
    });
    var addBtn = folderBarEl.querySelector('[data-folder-new]');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var name = window.prompt(t('account.folderName', '分组名'), '');
        if (name == null) return;
        name = String(name).trim().slice(0, 20);
        if (!name) return;
        var extra = readExtraFolders();
        if (extra.indexOf(name) < 0) {
          extra.push(name);
          writeExtraFolders(extra);
        }
        toast(t('account.folderSaved', '已更新分组'));
        renderFolderBar();
      });
    }
  }

  function bookmarkRow(item) {
    var folders = allFolders();
    var options = '<option value="">' + esc(t('account.folderNone', '未分组')) + '</option>';
    folders.forEach(function (name) {
      options +=
        '<option value="' + esc(name) + '"' + ((item.folder || '') === name ? ' selected' : '') + '>' +
        esc(name) + '</option>';
    });
    return (
      '<li class="stack-item" data-bookmark-row="' + item.id + '">' +
      '<div class="stack-item__head">' +
      '<a class="stack-item__title" href="' + esc(postUrl(item.post_slug)) + '">' +
      esc(item.title || postLabel(item.post_slug)) +
      '</a>' +
      (item.is_private
        ? badge(t('account.bookmarkPrivate', '私密'), 'badge--muted')
        : badge(t('account.bookmarkPublic', '公开'), 'badge--ok')) +
      '<span class="stack-item__time">' + esc(C.formatDate(item.created_at)) + '</span>' +
      '</div>' +
      '<div class="stack-item__actions">' +
      '<label class="inline-field">' +
      '<span class="inline-field__label">' + esc(t('account.folderMove', '移动到分组')) + '</span>' +
      '<select class="field__input field__input--select field__input--sm" data-bookmark-folder="' + item.id + '">' +
      options +
      '</select>' +
      '</label>' +
      '<button class="link-btn" type="button" data-bookmark-private="' + item.id + '" data-private="' +
      (item.is_private ? '1' : '0') + '">' +
      esc(item.is_private
        ? t('account.bookmarkPrivateOff', '取消私密')
        : t('account.bookmarkPrivateOn', '设为私密')) +
      '</button>' +
      '<button class="link-btn" type="button" data-delete-bookmark="' + item.id + '">取消收藏</button>' +
      '</div>' +
      '</li>'
    );
  }

  function renderBookmarks() {
    if (!bookmarksEl) return;
    var rows = bookmarkRows.filter(function (item) {
      if (!bookmarkFilter) return true;
      return (item.folder || '') === bookmarkFilter;
    });
    if (!bookmarkRows.length) {
      bookmarksEl.innerHTML = emptyRow(t('account.bookmarkEmpty', '还没有收藏任何文章。'));
      return;
    }
    if (!rows.length) {
      bookmarksEl.innerHTML = emptyRow(t('account.bookmarkEmptyFolder', '这个分组里还没有内容。'));
      return;
    }
    bookmarksEl.innerHTML =
      rows.map(bookmarkRow).join('') +
      (bookmarkFilter ? '' : maybeMore('bookmarks', bookmarkRows.length)
        ? truncationNote('bookmarks', bookmarkRows.length) + moreRow('bookmarks')
        : '');
    bindBookmarkActions();
  }

  function loadBookmarks() {
    if (!bookmarksEl) return Promise.resolve();
    return C.db()
      .from('post_bookmarks')
      .select('id, post_slug, title, folder, is_private, created_at')
      .order('created_at', { ascending: false })
      .limit(listState.bookmarks.limit)
      .then(function (res) {
        if (res && res.error) throw res.error;
        bookmarkRows = (res && res.data) || [];
        renderFolderBar();
        renderBookmarks();
      })
      .catch(function (err) {
        console.warn('[account] 收藏加载失败', err && err.message);
        bookmarksEl.innerHTML = emptyRow('收藏加载失败，请刷新重试。');
      });
  }

  function bindBookmarkActions() {
    qa('[data-delete-bookmark]', bookmarksEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-delete-bookmark');
        btn.disabled = true;
        C.db()
          .from('post_bookmarks')
          .delete()
          .eq('id', id)
          .select()
          .then(function (res) {
            if (res && res.error) throw res.error;
            var rows = (res && res.data) || [];
            if (!rows.length) throw new Error('取消收藏没有生效');
            toast('已取消收藏');
            return loadBookmarks();
          })
          .catch(function (err) {
            btn.disabled = false;
            toast(errorMessage(err, '操作失败'));
          });
      });
    });

    qa('[data-bookmark-folder]', bookmarksEl).forEach(function (select) {
      select.addEventListener('change', function () {
        var id = select.getAttribute('data-bookmark-folder');
        var value = select.value || null;
        select.disabled = true;
        C.db()
          .from('post_bookmarks')
          .update({ folder: value })
          .eq('id', id)
          .select()
          .then(function (res) {
            if (res && res.error) throw res.error;
            var rows = (res && res.data) || [];
            if (!rows.length) throw new Error(t('account.folderFail', '更新分组失败'));
            bookmarkRows = bookmarkRows.map(function (item) {
              if (String(item.id) !== String(id)) return item;
              return rows[0];
            });
            toast(t('account.folderSaved', '已更新分组'));
            renderFolderBar();
            renderBookmarks();
          })
          .catch(function (err) {
            toast(errorMessage(err, t('account.folderFail', '更新分组失败')));
            select.disabled = false;
          });
      });
    });

    qa('[data-bookmark-private]', bookmarksEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-bookmark-private');
        var next = btn.getAttribute('data-private') !== '1';
        btn.disabled = true;
        C.db()
          .from('post_bookmarks')
          .update({ is_private: next })
          .eq('id', id)
          .select()
          .then(function (res) {
            if (res && res.error) throw res.error;
            var rows = (res && res.data) || [];
            if (!rows.length) throw new Error('操作失败');
            bookmarkRows = bookmarkRows.map(function (item) {
              if (String(item.id) !== String(id)) return item;
              return rows[0];
            });
            toast(next ? t('account.bookmarkPrivate', '私密') : t('account.bookmarkPublic', '公开'));
            renderBookmarks();
          })
          .catch(function (err) {
            btn.disabled = false;
            toast(errorMessage(err, '操作失败'));
          });
      });
    });
  }

  /* ---------------- 最近阅读（M11） ---------------- */

  function readingRow(item) {
    var percent = Math.max(0, Math.min(100, Number(item.percent) || 0));
    var href = postUrl(item.post_slug) + (item.post_slug.indexOf('cloud:') === 0 ? '&' : '?') + 'continue=1';
    return (
      '<li class="stack-item" data-reading-row="' + esc(item.post_slug) + '">' +
      '<div class="stack-item__head">' +
      '<a class="stack-item__title" href="' + esc(href) + '">' +
      esc(item.title || postLabel(item.post_slug)) +
      '</a>' +
      '<span class="stack-item__time">' + esc(C.formatDate(item.updated_at)) + '</span>' +
      '</div>' +
      '<div class="progress"><span class="progress__bar" style="width:' + percent + '%"></span></div>' +
      '<div class="stack-item__actions">' +
      '<span class="stack-item__note">' + esc(fill('reading.progress', '已读 {n}%', { n: percent })) + '</span>' +
      '<a class="link-btn" href="' + esc(href) + '">' +
      esc(percent >= 99 ? t('reading.restart', '从头开始') : t('reading.continue', '继续阅读')) +
      '</a>' +
      '<button class="link-btn" type="button" data-reading-remove="' + esc(item.post_slug) + '">移除</button>' +
      '</div>' +
      '</li>'
    );
  }

  function loadReading() {
    if (!readingEl) return Promise.resolve();
    return C.db()
      .from('reading_history')
      .select('post_slug, title, percent, updated_at')
      .order('updated_at', { ascending: false })
      .limit(listState.reading.limit)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        readingEl.innerHTML = rows.length
          ? rows.map(readingRow).join('') +
            (maybeMore('reading', rows.length) ? truncationNote('reading', rows.length) + moreRow('reading') : '')
          : emptyRow(t('reading.empty', '还没有阅读记录。'));
        qa('[data-reading-remove]', readingEl).forEach(function (btn) {
          btn.addEventListener('click', function () {
            var slug = btn.getAttribute('data-reading-remove');
            btn.disabled = true;
            C.db()
              .from('reading_history')
              .delete()
              .eq('owner_id', C.currentUid())
              .eq('post_slug', slug)
              .then(function (res) {
                if (res && res.error) throw res.error;
                return loadReading();
              })
              .catch(function (err) {
                btn.disabled = false;
                toast(errorMessage(err, '操作失败'));
              });
          });
        });
      })
      .catch(function (err) {
        console.warn('[account] 阅读记录加载失败', err && err.message);
        readingEl.innerHTML = emptyRow('阅读记录加载失败，请刷新重试。');
      });
  }

  /* ---------------- 黑名单（M13） ---------------- */

  function loadBlocks() {
    if (!blocksEl) return Promise.resolve();
    return C.db()
      .from('user_blocks')
      .select('id, blocked_id, blocked_name, created_at')
      .order('created_at', { ascending: false })
      .limit(listState.blocks.limit)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        blocksEl.innerHTML = rows.length
          ? rows
              .map(function (item) {
                return (
                  '<li class="stack-item">' +
                  '<div class="stack-item__head">' +
                  '<span class="stack-item__title">' + esc(item.blocked_name || item.blocked_id) + '</span>' +
                  '<span class="stack-item__time">' + esc(C.formatDate(item.created_at)) + '</span>' +
                  '</div>' +
                  '<div class="stack-item__actions">' +
                  '<button class="link-btn" type="button" data-block-remove="' + item.id + '">' +
                  esc(t('account.blockRemove', '取消拉黑')) + '</button>' +
                  '</div>' +
                  '</li>'
                );
              })
              .join('') +
              (maybeMore('blocks', rows.length) ? truncationNote('blocks', rows.length) + moreRow('blocks') : '')
          : emptyRow(t('account.blocksEmpty', '还没有拉黑任何人。'));

        qa('[data-block-remove]', blocksEl).forEach(function (btn) {
          btn.addEventListener('click', function () {
            btn.disabled = true;
            C.db()
              .from('user_blocks')
              .delete()
              .eq('id', btn.getAttribute('data-block-remove'))
              .select()
              .then(function (res) {
                if (res && res.error) throw res.error;
                var del = (res && res.data) || [];
                if (!del.length) throw new Error('操作失败');
                toast(t('account.blockRemoved', '已取消拉黑'));
                return loadBlocks();
              })
              .catch(function (err) {
                btn.disabled = false;
                toast(errorMessage(err, '操作失败'));
              });
          });
        });
      })
      .catch(function (err) {
        console.warn('[account] 黑名单加载失败', err && err.message);
        blocksEl.innerHTML = emptyRow('黑名单加载失败，请刷新重试。');
      });
  }

  /* ---------------- 数据导出（M7） ---------------- */

  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      exportBtn.disabled = true;
      C.db()
        .rpc('export_my_data')
        .then(function (res) {
          if (res && res.error) throw res.error;
          var data = res && res.data;
          if (!data || typeof data !== 'object' || data.ok === false) {
            throw new Error(t('account.exportEmpty', '没有拿到数据，请稍后重试'));
          }
          var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var link = document.createElement('a');
          link.href = url;
          link.download = 'ws-blog-export-' + C.formatDate(new Date()) + '.json';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
          toast(t('account.exportDone', '已开始下载'));
        })
        .catch(function (err) {
          toast(errorMessage(err, t('account.exportFail', '导出失败，请稍后重试')));
        })
        .then(function () {
          exportBtn.disabled = false;
        });
    });
  }

  /* ---------------- 账号注销（M7） ---------------- */

  function openDeleteModal() {
    if (!deleteModal) return;
    deleteModal.removeAttribute('hidden');
    document.body.classList.add('is-modal-open');
    if (deleteConfirmEl) {
      deleteConfirmEl.value = '';
      deleteConfirmEl.focus();
    }
  }

  function closeDeleteModal() {
    if (!deleteModal) return;
    deleteModal.setAttribute('hidden', '');
    document.body.classList.remove('is-modal-open');
  }

  if (deleteBtn) deleteBtn.addEventListener('click', openDeleteModal);
  if (deleteCancelBtn) deleteCancelBtn.addEventListener('click', closeDeleteModal);
  if (deleteModal) {
    deleteModal.addEventListener('click', function (e) {
      if (e.target === deleteModal) closeDeleteModal();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && deleteModal && !deleteModal.hasAttribute('hidden')) closeDeleteModal();
  });

  if (deleteSubmitBtn) {
    deleteSubmitBtn.addEventListener('click', function () {
      var word = ((deleteConfirmEl && deleteConfirmEl.value) || '').trim().toUpperCase();
      if (word !== 'DELETE') {
        toast(t('account.deleteNeedWord', '请输入 DELETE 以确认'));
        return;
      }
      deleteSubmitBtn.disabled = true;
      C.db()
        .rpc('delete_my_account', { p_confirm: 'DELETE' })
        .then(function (res) {
          if (res && res.error) throw res.error;
          var data = (res && res.data) || {};
          if (data.ok !== true) throw new Error(t('account.deleteFail', '注销失败，请稍后重试'));
          closeDeleteModal();
          toast(t('account.deleteDone', '账号已注销，正在退出…'));
          /* 云平台上的登录账号删不掉，得留在控制台处理 —— 明确告诉用户下一步 */
          if (data.login_account_remains) {
            setTimeout(function () {
              window.alert(t('account.deleteRemains', '内容已全部清空。登录账号本身由云平台托管，如需彻底移除请联系站长。'));
            }, 600);
          }
          return C.signOut().then(function () {
            setTimeout(function () {
              location.href = C.root + 'index.html';
            }, 1200);
          });
        })
        .catch(function (err) {
          toast(errorMessage(err, t('account.deleteFail', '注销失败，请稍后重试')));
        })
        .then(function () {
          deleteSubmitBtn.disabled = false;
        });
    });
  }

  /* ---------------- 安全设置：已登录状态下改密码 ----------------
     走 auth.resetPasswordForOld（当前密码做 sudo 校验），完成后会话保持有效，
     不需要再登录一次。校验放在前端只为省一次往返，真正的判定在服务端。 */

  var passwordOldEl = q('[data-password-old]');
  var passwordNewEl = q('[data-password-new]');
  var passwordConfirmEl = q('[data-password-confirm]');
  var passwordSaveBtn = q('[data-password-save]');

  if (passwordSaveBtn) {
    passwordSaveBtn.addEventListener('click', function () {
      var oldPw = (passwordOldEl && passwordOldEl.value) || '';
      var newPw = (passwordNewEl && passwordNewEl.value) || '';
      var confirmPw = (passwordConfirmEl && passwordConfirmEl.value) || '';

      if (!oldPw) {
        toast('请输入当前密码');
        return;
      }
      if (newPw.length < 8) {
        toast('新密码至少 8 位');
        return;
      }
      if (newPw === oldPw) {
        toast('新密码不能和当前密码相同');
        return;
      }
      if (newPw !== confirmPw) {
        toast('两次输入的新密码不一致');
        return;
      }

      passwordSaveBtn.disabled = true;
      passwordSaveBtn.textContent = '提交中…';
      C.changePassword(oldPw, newPw)
        .then(function (res) {
          if (res && res.error) throw res.error;
          [passwordOldEl, passwordNewEl, passwordConfirmEl].forEach(function (el) {
            if (el) el.value = '';
          });
          toast('密码已更新，下次登录请用新密码');
        })
        .catch(function (err) {
          var message = String((err && err.message) || '');
          if (isSessionGone(err)) {
            toast('登录状态已过期，请重新登录后再改密码');
          } else if (/password|credential|invalid|mismatch/i.test(message)) {
            toast('当前密码不正确');
          } else {
            toast(message || '修改失败，请稍后重试');
          }
        })
        .then(function () {
          passwordSaveBtn.disabled = false;
          passwordSaveBtn.textContent = '修改密码';
        });
    });
  }

  /* ---------------- 身份与退出 ---------------- */

  if (identitySwitch) {
    identitySwitch.addEventListener('click', function () {
      var target = C.isAdminMode() ? 'user' : 'admin';
      identitySwitch.disabled = true;
      C.setIdentity(target).then(function (ok) {
        identitySwitch.disabled = false;
        if (!ok) return;
        renderProfile();
        toast(target === 'admin' ? '已切换为管理员身份' : '已切换为普通用户身份');
        if (target === 'admin') location.href = C.root + 'admin.html';
      });
    });
  }

  var signOutBtn = q('[data-account-signout]');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', function () {
      signOutBtn.disabled = true;
      C.signOut().then(function () {
        location.href = C.root + 'index.html';
      });
    });
  }

  /* ---------------- 启动 ---------------- */

  C.booted().then(function () {
    if (!C.currentUser()) {
      location.href = C.root + 'login.html?next=' + encodeURIComponent('/account.html');
      return;
    }
    bindMoreButtons();
    renderProfile();
    renderEmail();

    loadProfile()
      .then(function () {
        renderProfile();
      })
      .catch(function (err) {
        console.warn('[account] 资料加载失败', err && err.message);
      });

    loadEmailState();
    loadSessions();
    loadComments();
    loadBookmarks();
    loadMyPosts();
    loadReading();
    loadBlocks();
  });
})();
