/**
 * 文章互动：点赞、收藏、评论。
 *
 * 静态文章与云端文章共用这一套逻辑，以 post_slug 作为区分：
 *   · 静态文章  → 文件名 slug，例如 400-lines-static-site-generator
 *   · 云端文章  → cloud:<slug>
 *
 * 初始化有两条路径：
 *   1. 页面 HTML 上直接写好了 data-post-slug（静态文章页）→ 自动初始化
 *   2. 由别的脚本在取到数据后调用 window.WSBlogInteract.init(slug, title)
 *      （云端文章页 post.html 的正文是运行时拉取的，属于这种情况）
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var root = document.querySelector('[data-interact]');
  if (!root) return;

  function q(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function qa(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  var likeBtn = q('[data-like]', root);
  var likeCount = q('[data-like-count]', root);
  var bookmarkBtn = q('[data-bookmark]', root);
  var bookmarkLabel = q('[data-bookmark-label]', root);
  var listEl = q('[data-comment-list]', root);
  var countEl = q('[data-comment-count]', root);
  var formEl = q('[data-comment-form]', root);
  var inputEl = q('[data-comment-input]', root);
  var submitEl = q('[data-comment-submit]', root);
  var gateEl = q('[data-comment-gate]', root);
  var viewsEl = q('[data-views-count]', root);
  var replyBar = q('[data-reply-bar]', root);
  var replyName = q('[data-reply-name]', root);
  var replyCancel = q('[data-reply-cancel]', root);

  var slug = '';
  var postTitle = '';
  var inited = false;
  var state = { likes: 0, liked: false, bookmarked: false, comments: 0, views: 0 };
  /* 回复目标：null = 直接评论文章；{ id, name } = 回复某条评论 */
  var replyTarget = null;
  var profile = null;
  var busyLike = false;
  var busyBookmark = false;

  function toast(message) {
    C.toast(message);
  }

  function goLogin() {
    location.href =
      C.root + 'login.html?next=' + encodeURIComponent(location.pathname + location.search);
  }

  function relativeTime(value) {
    if (!value) return '';
    var then = new Date(value).getTime();
    if (isNaN(then)) return '';
    var diff = Date.now() - then;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 30 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    return C.formatDate(value);
  }

  /* ---------------- 点赞 / 收藏 ---------------- */

  function renderActions() {
    if (likeBtn) {
      likeBtn.classList.toggle('is-active', state.liked);
      likeBtn.setAttribute('aria-pressed', state.liked ? 'true' : 'false');
      likeBtn.disabled = busyLike;
    }
    if (likeCount) likeCount.textContent = String(state.likes);
    if (bookmarkBtn) {
      bookmarkBtn.classList.toggle('is-active', state.bookmarked);
      bookmarkBtn.setAttribute('aria-pressed', state.bookmarked ? 'true' : 'false');
      bookmarkBtn.disabled = busyBookmark;
    }
    if (bookmarkLabel) bookmarkLabel.textContent = state.bookmarked ? '已收藏' : '收藏';
  }

  function renderCounts() {
    if (countEl) countEl.textContent = String(state.comments);
    if (viewsEl) viewsEl.textContent = String(state.views);
  }

  /* 回复模式：提示条 + 输入框 placeholder + 提交按钮文案 */
  function setReplyTarget(target) {
    replyTarget = target || null;
    if (replyBar) {
      if (replyTarget) {
        replyBar.removeAttribute('hidden');
        if (replyName) replyName.textContent = replyTarget.name;
      } else {
        replyBar.setAttribute('hidden', '');
      }
    }
    if (inputEl) {
      inputEl.placeholder = replyTarget
        ? '回复 @' + replyTarget.name + ' …'
        : '写下你的看法…';
    }
  }

  function readState() {
    if (!inited) return Promise.resolve(state);
    return C.db()
      .rpc('post_interaction', { p_slug: slug })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var data = res && res.data;
        if (data && typeof data === 'object') {
          state.likes = Number(data.likes) || 0;
          state.liked = data.liked === true;
          state.bookmarked = data.bookmarked === true;
          state.comments = Number(data.comments) || 0;
          state.views = Number(data.views) || 0;
        }
        renderActions();
        renderCounts();
        return state;
      })
      .catch(function (err) {
        console.warn('[interact] 互动状态读取失败', err && err.message);
        renderActions();
        return state;
      });
  }

  /* 浏览量：同一浏览器会话内同一篇只计一次（sessionStorage 去重），
     重复访问改走只读的 post_view_read，不再向服务端 +1。 */
  function countView() {
    var key = 'wsblog:viewed:' + slug;
    var counted = false;
    try {
      counted = window.sessionStorage.getItem(key) === '1';
    } catch (err) {
      /* 隐私模式下 sessionStorage 可能不可用，退化为每次都计 */
    }
    C.db()
      .rpc(counted ? 'post_view_read' : 'post_view', { p_slug: slug })
      .then(function (res) {
        if (!counted) {
          try {
            window.sessionStorage.setItem(key, '1');
          } catch (err) { /* 忽略 */ }
        }
        var rows = res && res.data;
        var value = Array.isArray(rows) ? rows[0] : rows;
        var num = typeof value === 'number' ? value : Number(value && value.post_view);
        if (!isNaN(num) && num > 0) {
          state.views = num;
          renderCounts();
        }
      })
      .catch(function () {
        /* 浏览量统计失败不影响阅读 */
      });
  }

  function toggleLike() {
    if (busyLike || !inited) return;
    if (!C.currentUser()) {
      toast('登录后才能点赞');
      goLogin();
      return;
    }
    if (C.requireActive()) return;
    busyLike = true;
    renderActions();
    var wasLiked = state.liked;
    var action = wasLiked
      ? C.db().from('post_likes').delete().eq('post_slug', slug).select()
      : C.db().from('post_likes').insert({ post_slug: slug }).select();

    action
      .then(function (res) {
        if (res && res.error) {
          /* 唯一约束冲突 = 之前已经点过，按成功处理 */
          if (res.error.code === '23505') return null;
          throw res.error;
        }
        var rows = (res && res.data) || [];
        /* RLS 会把「不是我的行」过滤掉，返回空数组即代表没生效 */
        if (rows.length === 0) throw new Error(wasLiked ? '取消点赞没有生效' : '点赞没有生效');
        return readState();
      })
      .then(function () {
        busyLike = false;
        renderActions();
        toast(state.liked ? '已点赞' : '已取消点赞');
      })
      .catch(function (err) {
        busyLike = false;
        renderActions();
        console.warn('[interact] 点赞失败', err && err.message);
        toast((err && err.message) || '操作失败，请稍后重试');
      });
  }

  function toggleBookmark() {
    if (busyBookmark || !inited) return;
    if (!C.currentUser()) {
      toast('登录后才能收藏');
      goLogin();
      return;
    }
    if (C.requireActive()) return;
    busyBookmark = true;
    renderActions();
    var wasBookmarked = state.bookmarked;
    var action = wasBookmarked
      ? C.db().from('post_bookmarks').delete().eq('post_slug', slug).select()
      : C.db().from('post_bookmarks').insert({ post_slug: slug, title: postTitle }).select();

    action
      .then(function (res) {
        if (res && res.error) {
          if (res.error.code === '23505') return null;
          throw res.error;
        }
        var rows = (res && res.data) || [];
        if (rows.length === 0) {
          throw new Error(wasBookmarked ? '取消收藏没有生效' : '收藏没有生效');
        }
        return readState();
      })
      .then(function () {
        busyBookmark = false;
        renderActions();
        toast(state.bookmarked ? '已加入收藏' : '已取消收藏');
      })
      .catch(function (err) {
        busyBookmark = false;
        renderActions();
        console.warn('[interact] 收藏失败', err && err.message);
        toast((err && err.message) || '操作失败，请稍后重试');
      });
  }

  /* ---------------- 评论 ---------------- */

  function commentItem(item, replies) {
    var name = item.author_name || '匿名读者';
    var replyBtn =
      '<button class="comment__reply" type="button" data-comment-reply="' + item.id +
      '" data-comment-reply-name="' + C.escapeHtml(name) + '">回复</button>';
    var repliesHtml = '';
    if (replies && replies.length) {
      repliesHtml =
        '<ul class="comment__replies">' +
        replies
          .map(function (child) {
            return commentItem(child, null);
          })
          .join('') +
        '</ul>';
    }
    /* 服务端把新评论置为 pending；这里只回显状态，不做任何判断，
       免得前端以为「发出去了就是上线了」。 */
    var pending = item.status === 'pending';
    var badge = pending
      ? '<span class="comment__badge">审核中</span>'
      : '';
    return (
      '<li class="comment' + (pending ? ' comment--pending' : '') + '" data-comment="' + item.id + '">' +
      '<span class="comment__avatar">' + C.escapeHtml(name.slice(0, 1).toUpperCase()) + '</span>' +
      '<div class="comment__body">' +
      '<div class="comment__head">' +
      '<span class="comment__name">' + C.escapeHtml(name) + '</span>' +
      badge +
      '<span class="comment__time">' + C.escapeHtml(relativeTime(item.created_at)) + '</span>' +
      replyBtn +
      (item.is_mine
        ? '<button class="comment__delete" type="button" data-comment-delete="' + item.id + '">删除</button>'
        : '') +
      '</div>' +
      '<p class="comment__text">' + C.escapeHtml(item.content).replace(/\n/g, '<br>') + '</p>' +
      repliesHtml +
      '</div></li>'
    );
  }

  /* 平铺行 → 两级楼中楼：顶层按时间倒序，回复按时间正序挂在父评论下 */
  function renderComments(rows) {
    if (!rows.length) {
      listEl.innerHTML = '<li class="comment-empty">还没有评论，来说点什么吧。</li>';
      return;
    }
    var top = [];
    var children = {};
    rows.forEach(function (item) {
      if (item.parent_id) {
        (children[item.parent_id] = children[item.parent_id] || []).push(item);
      } else {
        top.push(item);
      }
    });
    listEl.innerHTML = top
      .map(function (item) {
        var replies = (children[item.id] || []).slice().reverse();
        return commentItem(item, replies);
      })
      .join('');
    bindCommentActions();
  }

  function loadComments() {
    if (!listEl || !inited) return Promise.resolve();
    return C.db()
      .rpc('post_comments', { p_slug: slug })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        renderComments(rows);
        state.comments = rows.length;
        renderCounts();
      })
      .catch(function (err) {
        console.warn('[interact] 评论加载失败', err && err.message);
        listEl.innerHTML = '<li class="comment-empty">评论暂时加载失败，请刷新重试。</li>';
      });
  }

  function bindCommentActions() {
    bindDeletes();
    /* 回复按钮：未登录先去登录 */
    qa('[data-comment-reply]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!C.currentUser()) {
          toast('登录后才能回复');
          goLogin();
          return;
        }
        setReplyTarget({
          id: Number(btn.getAttribute('data-comment-reply')),
          name: btn.getAttribute('data-comment-reply-name') || '',
        });
        if (inputEl) inputEl.focus();
      });
    });
  }

  function bindDeletes() {
    qa('[data-comment-delete]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-comment-delete');
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
            if (rows.length === 0) throw new Error('只能删除自己的评论');
            toast('评论已删除');
            return loadComments();
          })
          .catch(function (err) {
            btn.disabled = false;
            toast((err && err.message) || '删除失败，请稍后重试');
          });
      });
    });
  }

  function submitComment(event) {
    if (event) event.preventDefault();
    if (!inited) return;
    if (!C.currentUser()) {
      toast('登录后才能评论');
      goLogin();
      return;
    }
    if (C.requireActive()) return;
    var content = ((inputEl && inputEl.value) || '').trim();
    if (!content) {
      toast('评论内容不能为空');
      return;
    }
    if (content.length > 1000) {
      toast('评论最多 1000 字');
      return;
    }
    if (submitEl) submitEl.disabled = true;
    var wasReply = !!(replyTarget && replyTarget.id);
    var payload = {
      post_slug: slug,
      content: content,
      author_name: (profile && profile.nickname) || C.displayName() || '读者',
    };
    /* 回复模式：带上父评论 id（只允许回复顶层评论，避免层级过深） */
    if (replyTarget && replyTarget.id) payload.parent_id = replyTarget.id;
    C.db()
      .from('comments')
      .insert(payload)
      .select()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        if (rows.length === 0) throw new Error('评论没有保存成功，请稍后重试');
        if (inputEl) inputEl.value = '';
        setReplyTarget(null);
        /* 用服务端回写的 status 决定文案：普通读者的评论会先进待审，
           不能提示「已发布」——那会让人以为线上已经能看到。 */
        var needReview = rows[0] && rows[0].status === 'pending';
        if (needReview) {
          toast(wasReply ? '回复已提交，站长通过后显示' : '评论已提交，站长通过后显示');
        } else {
          toast(wasReply ? '回复已发布' : '评论已发布');
        }
        return loadComments();
      })
      .catch(function (err) {
        var message = (err && err.message) || '';
        if (/发言太快|评论太多|RATE_LIMIT/.test(message)) {
          /* 服务端的原因已经是给人看的，直接透出，别包一层「评论失败」 */
          toast(message.replace(/^[A-Z0-9]+:\s*/, ''));
        } else {
          toast(message || '评论失败，请稍后重试');
        }
      })
      .then(function () {
        if (submitEl) submitEl.disabled = false;
      });
  }

  /* ---------------- 登录态渲染 ---------------- */

  function renderForSession() {
    var signedIn = !!C.currentUser();
    if (gateEl) {
      if (signedIn) gateEl.setAttribute('hidden', '');
      else gateEl.removeAttribute('hidden');
    }
    if (formEl) {
      if (signedIn) formEl.removeAttribute('hidden');
      else formEl.setAttribute('hidden', '');
    }
  }

  function loadProfile() {
    var uid = C.currentUid();
    if (!uid) {
      profile = null;
      return Promise.resolve(null);
    }
    return C.db()
      .from('profiles')
      .select('nickname, avatar_url')
      .eq('owner_id', uid)
      .maybeSingle()
      .then(function (res) {
        profile = res && !res.error && res.data ? res.data : null;
        return profile;
      })
      .catch(function () {
        profile = null;
        return null;
      });
  }

  /* ---------------- 初始化 ---------------- */

  function init(slugValue, titleValue) {
    if (inited || !slugValue) return false;
    inited = true;
    slug = slugValue;
    postTitle = titleValue || '';
    root.setAttribute('data-post-slug', slug);
    renderForSession();
    renderActions();
    readState();
    countView();
    loadComments();
    loadProfile();
    return true;
  }

  if (likeBtn) likeBtn.addEventListener('click', toggleLike);
  if (bookmarkBtn) bookmarkBtn.addEventListener('click', toggleBookmark);
  if (formEl) formEl.addEventListener('submit', submitComment);
  if (replyCancel) {
    replyCancel.addEventListener('click', function () {
      setReplyTarget(null);
    });
  }

  C.onSessionChange(function () {
    if (!inited) return;
    renderForSession();
    loadProfile();
    readState();
  });

  C.booted().then(function () {
    init(root.getAttribute('data-post-slug'), root.getAttribute('data-post-title'));
  });

  window.WSBlogInteract = { init: init, isReady: function () { return inited; } };
})();
