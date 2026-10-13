/**
 * 个人中心：资料编辑、我的评论、我的收藏。
 *
 * 所有查询都依赖 RLS 按 owner_id 自动收敛，前端不自己过滤「这行是不是我的」——
 * 那只是展示层的判断，不是安全边界。
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

  var nicknameInput = q('[data-profile-nickname]');
  var avatarInput = q('[data-profile-avatar]');
  var bioInput = q('[data-profile-bio]');
  var saveBtn = q('[data-profile-save]');
  var avatarPreview = q('[data-profile-avatar-preview]');
  var emailEl = q('[data-account-email]');
  var roleEl = q('[data-account-role]');
  var sinceEl = q('[data-account-since]');
  var joinedEl = q('[data-account-joined]');
  var commentsEl = q('[data-my-comments]');
  var bookmarksEl = q('[data-my-bookmarks]');
  var identitySwitch = q('[data-account-identity]');

  var profile = null;

  function toast(message) {
    C.toast(message);
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
    return C.escapeHtml(value.slice(0, 1).toUpperCase() || '?');
  }

  /* ---------------- 资料 ---------------- */

  function renderProfile() {
    var user = C.currentUser();
    var name = (profile && profile.nickname) || C.displayName() || '读者';
    var avatar = profile && profile.avatar_url;

    if (nicknameInput) nicknameInput.value = (profile && profile.nickname) || '';
    if (avatarInput) avatarInput.value = avatar || '';
    if (bioInput) bioInput.value = (profile && profile.bio) || '';
    if (emailEl) emailEl.textContent = (user && (user.email || user.phone)) || '—';
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
        ? '<img src="' + C.escapeHtml(avatar) + '" alt="" loading="lazy">'
        : initials(name);
    }
    var heroName = q('[data-account-name]');
    if (heroName) heroName.textContent = name;
    var heroBio = q('[data-account-bio]');
    if (heroBio) heroBio.textContent = (profile && profile.bio) || '还没有填写简介。';

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
      .select('owner_id, nickname, avatar_url, bio, created_at')
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
      nickname: (nicknameInput && nicknameInput.value || '').trim().slice(0, 40),
      avatar_url: (avatarInput && avatarInput.value || '').trim().slice(0, 500),
      bio: (bioInput && bioInput.value || '').trim().slice(0, 300),
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
        return C.refresh();
      })
      .catch(function (err) {
        console.warn('[account] 资料保存失败', err && err.message);
        toast((err && err.message) || '保存失败，请稍后重试');
      })
      .then(function () {
        if (saveBtn) saveBtn.disabled = false;
      });
  }

  if (saveBtn) saveBtn.addEventListener('click', saveProfile);

  /* 头像上传：传到云存储后回填地址，仍需点「保存资料」落库 */
  var avatarUploadBtn = q('[data-avatar-upload]');
  if (avatarUploadBtn) {
    avatarUploadBtn.addEventListener('click', function () {
      if (!window.WSBlogUpload) {
        toast('上传模块未加载');
        return;
      }
      if (C.requireActive()) return;
      var uid = C.currentUid();
      if (!uid) {
        toast('登录状态已失效，请重新登录');
        return;
      }
      avatarUploadBtn.disabled = true;
      var original = avatarUploadBtn.textContent;
      avatarUploadBtn.textContent = '上传中…';
      window.WSBlogUpload.pickAndUpload({
        accept: 'image/*',
        maxMB: 2,
        folder: 'avatars',
        filename: 'avatar-' + uid,
        upsert: true,
      })
        .then(function (res) {
          if (avatarInput) {
            avatarInput.value = res.url;
            avatarInput.dispatchEvent(new Event('input'));
          }
          toast('头像已上传，点「保存资料」生效');
        })
        .catch(function (err) {
          toast((err && (err.message || err.error_description)) || '头像上传失败');
        })
        .then(function () {
          avatarUploadBtn.disabled = false;
          avatarUploadBtn.textContent = original;
        });
    });
  }

  if (avatarInput) {
    avatarInput.addEventListener('input', function () {
      if (!avatarPreview) return;
      var value = avatarInput.value.trim();
      avatarPreview.innerHTML = value
        ? '<img src="' + C.escapeHtml(value) + '" alt="" loading="lazy">'
        : initials((nicknameInput && nicknameInput.value) || C.displayName());
    });
  }

  /* ---------------- 我的投稿 ---------------- */

  var myPostsEl = q('[data-my-posts]');
  var myPostCountEl = q('[data-my-post-count]');

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
    return (
      '<li class="stack-item">' +
      '<div class="stack-item__head">' +
      '<span class="stack-item__title">' + C.escapeHtml(post.title) + '</span>' +
      '<span class="status-badge ' + (meta.cls || '') + '">' + C.escapeHtml(meta.label || post.status) + '</span>' +
      '<span class="stack-item__time">' + C.escapeHtml(C.formatDate(post.updated_at || post.created_at)) + '</span>' +
      '</div>' +
      (post.status === 'rejected' && post.review_note
        ? '<p class="stack-item__note">未通过理由：' + C.escapeHtml(post.review_note) + '</p>'
        : '') +
      '<div class="stack-item__actions">' +
      (published
        ? '<a class="link-btn" href="' + C.escapeHtml(postUrl(post.slug)) + '">阅读</a>'
        : '<a class="link-btn" href="' + C.escapeHtml(editHref) + '">编辑</a>') +
      '</div>' +
      '</li>'
    );
  }

  function loadMyPosts() {
    var uid = C.currentUid();
    if (!uid || !myPostsEl) return Promise.resolve([]);
    return C.db()
      .from('cloud_posts')
      .select('slug, title, status, review_note, created_at, updated_at, published_at')
      .eq('author_id', uid)
      .order('updated_at', { ascending: false })
      .limit(30)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var list = (res && res.data) || [];
        if (myPostCountEl) myPostCountEl.textContent = String(list.length);
        myPostsEl.innerHTML = list.length
          ? list.map(myPostsRow).join('')
          : '<li class="stack-empty">还没有投稿，<a href="write.html">写第一篇</a>。</li>';
        return list;
      })
      .catch(function (err) {
        console.warn('[account] 投稿加载失败', err && err.message);
        myPostsEl.innerHTML = '<li class="stack-empty">投稿列表加载失败，请刷新重试。</li>';
        return [];
      });
  }

  /* ---------------- 我的评论 ---------------- */

  function loadComments() {
    if (!commentsEl) return Promise.resolve();
    var uid = C.currentUid();
    if (!uid) return Promise.resolve();
    return C.db()
      .from('comments')
      .select('id, post_slug, content, status, created_at')
      .eq('owner_id', uid)
      .order('created_at', { ascending: false })
      .limit(100)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        if (!rows.length) {
          commentsEl.innerHTML = '<li class="stack-empty">还没有发表过评论。</li>';
          return;
        }
        commentsEl.innerHTML = rows
          .map(function (item) {
            return (
              '<li class="stack-item" data-comment-row="' + item.id + '">' +
              '<div class="stack-item__head">' +
              '<a class="stack-item__title" href="' + C.escapeHtml(postUrl(item.post_slug)) + '">' +
              C.escapeHtml(postLabel(item.post_slug)) + '</a>' +
              '<span class="stack-item__time">' + C.escapeHtml(C.formatDate(item.created_at)) + '</span>' +
              (item.status && item.status !== 'visible'
                ? '<span class="badge badge--muted">已隐藏</span>'
                : '') +
              '</div>' +
              '<p class="stack-item__text">' + C.escapeHtml(item.content) + '</p>' +
              '<button class="link-btn" type="button" data-delete-comment="' + item.id + '">删除</button>' +
              '</li>'
            );
          })
          .join('');
        bindCommentDeletes();
      })
      .catch(function (err) {
        console.warn('[account] 评论加载失败', err && err.message);
        commentsEl.innerHTML = '<li class="stack-empty">评论加载失败，请刷新重试。</li>';
      });
  }

  function bindCommentDeletes() {
    qa('[data-delete-comment]', commentsEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-delete-comment');
        if (!window.confirm('确定删除这条评论吗？')) return;
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
            toast('评论已删除');
            return loadComments();
          })
          .catch(function (err) {
            btn.disabled = false;
            toast((err && err.message) || '删除失败');
          });
      });
    });
  }

  /* ---------------- 我的收藏 ---------------- */

  function loadBookmarks() {
    if (!bookmarksEl) return Promise.resolve();
    return C.db()
      .from('post_bookmarks')
      .select('id, post_slug, title, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        if (!rows.length) {
          bookmarksEl.innerHTML = '<li class="stack-empty">还没有收藏任何文章。</li>';
          return;
        }
        bookmarksEl.innerHTML = rows
          .map(function (item) {
            return (
              '<li class="stack-item" data-bookmark-row="' + item.id + '">' +
              '<div class="stack-item__head">' +
              '<a class="stack-item__title" href="' + C.escapeHtml(postUrl(item.post_slug)) + '">' +
              C.escapeHtml(item.title || postLabel(item.post_slug)) + '</a>' +
              '<span class="stack-item__time">' + C.escapeHtml(C.formatDate(item.created_at)) + '</span>' +
              '</div>' +
              '<button class="link-btn" type="button" data-delete-bookmark="' + item.id + '">取消收藏</button>' +
              '</li>'
            );
          })
          .join('');
        bindBookmarkDeletes();
      })
      .catch(function (err) {
        console.warn('[account] 收藏加载失败', err && err.message);
        bookmarksEl.innerHTML = '<li class="stack-empty">收藏加载失败，请刷新重试。</li>';
      });
  }

  function bindBookmarkDeletes() {
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
            toast((err && err.message) || '操作失败');
          });
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
    renderProfile();
    loadProfile()
      .then(function () {
        renderProfile();
      })
      .catch(function (err) {
        console.warn('[account] 资料加载失败', err && err.message);
      });
    loadComments();
    loadBookmarks();
    loadMyPosts();
  });
})();
