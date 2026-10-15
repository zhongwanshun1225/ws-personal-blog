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
 *
 * 评论侧能力（第六批）：
 *   M2  自己 15 分钟内的评论可以就地编辑（服务端再次强制窗口）
 *   M3  顶层评论顶 / 踩
 *   M4  @昵称高亮；服务端负责解析并给被提及者发通知
 *   M13 举报（进后台举报列表）与拉黑（本地隐藏此人评论）
 *   M16 评论支持 ``` 代码块、`行内代码` 与表情插入
 *   M11 阅读进度落库，回来时给「继续阅读」提示
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
  var emojiToggle = q('[data-emoji-toggle]', root);
  var emojiPicker = q('[data-emoji-picker]', root);
  var codeInsert = q('[data-code-insert]', root);

  var slug = '';
  var postTitle = '';
  var inited = false;
  var state = { likes: 0, liked: false, bookmarked: false, comments: 0, views: 0 };
  /* 回复目标：null = 直接评论文章；{ id, name } = 回复某条评论 */
  var replyTarget = null;
  /* 编辑目标：正在编辑的评论 id（同一时刻只允许一条） */
  var editingId = null;
  var profile = null;
  var busyLike = false;
  var busyBookmark = false;
  var editing = false;

  /* 评论编辑窗口：与服务端 comments_stamp_author 里的 15 分钟保持一致。
     前端只是提前把按钮收起来，真正的拒绝在服务端。 */
  var EDIT_WINDOW_MS = 15 * 60 * 1000;

  /* 被拉黑的作者 id → 名称。只影响本机显示，不是全站封禁。 */
  var blocked = {};
  var blockedShown = false;
  var lastRows = [];

  function t(key, fallback) {
    if (typeof window.__wsT === 'function') return window.__wsT(key, fallback);
    return fallback || key;
  }

  function toast(message) {
    C.toast(message);
  }

  /* 评论内容来自用户，拼进 innerHTML 前必须转义（与 app.js 里的同名工具一致）。 */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  /* ---------------- 评论内容渲染（M16：代码块 / 行内代码 / @提及） ---------------- */

  var FENCE_RE = /```([a-zA-Z0-9_+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  /* 提及的字符集与服务端 comments_stamp_author 的正则保持一致：
     遇到空白与中英文标点即视为昵称结束。 */
  var MENTION_RE = /(^|[\s(])@([^\s@,.;:!?()<>[\]/|，。、；：！？（）【】《》“”‘’…—]{1,40})/g;

  /** 转义之后的文本上做行内格式化：行内代码 → @提及 → 换行。 */
  function inlineFormat(escaped) {
    return escaped
      .replace(/`([^`\n]+)`/g, '<code class="comment__inline">$1</code>')
      .replace(MENTION_RE, '$1<span class="comment__mention">@$2</span>')
      .replace(/\n/g, '<br>');
  }

  /** 把一条评论的纯文本渲染成安全 HTML。整段先按 ``` 切块，块内一律不解析。 */
  function renderCommentBody(content) {
    var text = String(content == null ? '' : content);
    var out = '';
    var last = 0;
    var match;
    FENCE_RE.lastIndex = 0;
    while ((match = FENCE_RE.exec(text))) {
      out += inlineFormat(esc(text.slice(last, match.index)));
      var lang = match[1] || '';
      out +=
        '<pre class="comment__code"' +
        (lang ? ' data-lang="' + esc(lang) + '"' : '') +
        '><code>' + esc(match[2].replace(/\s+$/, '')) + '</code></pre>';
      last = match.index + match[0].length;
    }
    out += inlineFormat(esc(text.slice(last)));
    return out;
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
    if (bookmarkLabel) bookmarkLabel.textContent = state.bookmarked ? t('interact.bookmarked', '已收藏') : t('interact.bookmark', '收藏');
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
        ? t('interact.replyPlaceholder', '回复 {name} …').split('{name}').join(replyTarget.name)
        : t('interact.placeholder', '写下你的看法…');
    }
    if (submitEl) {
      submitEl.textContent = replyTarget
        ? t('interact.submitReply', '发表回复')
        : t('interact.submit', '发表评论');
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
      toast(t('interact.likeNeedLogin', '登录后才能点赞'));
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
        if (rows.length === 0) throw new Error(wasLiked ? t('interact.unlikeFail', '取消点赞没有生效') : t('interact.likeFail', '点赞没有生效'));
        return readState();
      })
      .then(function () {
        busyLike = false;
        renderActions();
        toast(state.liked ? t('interact.liked', '已点赞') : t('interact.like', '点赞'));
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
      toast(t('interact.bookmarkNeedLogin', '登录后才能收藏'));
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
          throw new Error(wasBookmarked ? t('interact.unbookmarkFail', '取消收藏没有生效') : t('interact.bookmarkFail', '收藏没有生效'));
        }
        return readState();
      })
      .then(function () {
        busyBookmark = false;
        renderActions();
        toast(state.bookmarked ? t('interact.bookmarked', '已收藏') : t('interact.bookmark', '收藏'));
      })
      .catch(function (err) {
        busyBookmark = false;
        renderActions();
        console.warn('[interact] 收藏失败', err && err.message);
        toast((err && err.message) || '操作失败，请稍后重试');
      });
  }

  /* ---------------- 评论 ---------------- */

  function withinEditWindow(item) {
    if (!item.created_at) return false;
    var then = new Date(item.created_at).getTime();
    if (isNaN(then)) return false;
    return Date.now() - then < EDIT_WINDOW_MS;
  }

  function isBlocked(item) {
    return !!(item.author_id && blocked[item.author_id]);
  }

  /* 服务端超窗时会 RAISE ... HINT = 'EDIT_WINDOW_CLOSED'：
     PostgREST 把 HINT 放在 error.hint、把提示放在 error.message，
     两边都要看，否则只能靠中文文案匹配，改文案就失效。 */
  function editWindowClosed(err) {
    var text = [err && err.message, err && err.hint, err && err.details].join(' ');
    return /EDIT_WINDOW_CLOSED|15 minutes|15 分钟/i.test(text);
  }

  function commentItem(item, replies) {
    var name = item.author_name || '匿名读者';
    var pending = item.status === 'pending';
    var badge = pending
      ? '<span class="comment__badge">' + esc(t('interact.pendingBadge', '审核中')) + '</span>'
      : '';
    var edited = item.edited_at
      ? '<span class="comment__edited" title="' + esc(C.formatDateTime(item.edited_at)) + '">' +
        esc(t('interact.edited', '已编辑')) + '</span>'
      : '';

    var replyBtn =
      '<button class="comment__reply" type="button" data-comment-reply="' + item.id +
      '" data-comment-reply-name="' + esc(name) + '">' + esc(t('interact.footerReply', '回复')) + '</button>';

    var myVote = Number(item.my_vote) || 0;
    var votes =
      '<span class="comment__votes">' +
      '<button class="comment__vote' + (myVote === 1 ? ' is-active' : '') + '" type="button" data-comment-up="' +
      item.id + '" aria-pressed="' + (myVote === 1 ? 'true' : 'false') + '" title="' +
      esc(t('interact.voteUp', '有用')) + '">▲<span data-up>' + (Number(item.up_count) || 0) + '</span></button>' +
      '<button class="comment__vote' + (myVote === -1 ? ' is-active' : '') + '" type="button" data-comment-down="' +
      item.id + '" aria-pressed="' + (myVote === -1 ? 'true' : 'false') + '" title="' +
      esc(t('interact.voteDown', '没用')) + '">▼<span data-down>' + (Number(item.down_count) || 0) + '</span></button>' +
      '</span>';

    var mineActions = '';
    if (item.is_mine) {
      if (withinEditWindow(item)) {
        mineActions +=
          '<button class="comment__edit" type="button" data-comment-edit="' + item.id +
          '" title="' + esc(t('interact.editWindow', '发表后 15 分钟内可以修改')) + '">' +
          esc(t('interact.edit', '编辑')) + '</button>';
      }
      mineActions +=
        '<button class="comment__delete" type="button" data-comment-delete="' + item.id + '">' +
        esc(t('interact.footerDelete', '删除')) + '</button>';
    } else if (C.currentUser()) {
      mineActions +=
        '<button class="comment__report" type="button" data-comment-report="' + item.id + '">' +
        esc(t('interact.report', '举报')) + '</button>';
      if (item.author_id) {
        mineActions +=
          '<button class="comment__block" type="button" data-comment-block="' + esc(item.author_id) +
          '" data-comment-block-name="' + esc(name) + '">' + esc(t('interact.block', '拉黑')) + '</button>';
      }
    }

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

    return (
      '<li class="comment' + (pending ? ' comment--pending' : '') +
      (isBlocked(item) ? ' comment--blocked' : '') +
      '" data-comment="' + item.id + '" data-author-id="' + esc(item.author_id || '') + '">' +
      '<span class="comment__avatar">' + esc(name.slice(0, 1).toUpperCase()) + '</span>' +
      '<div class="comment__body">' +
      '<div class="comment__head">' +
      '<span class="comment__name">' + esc(name) + '</span>' +
      badge + edited +
      '<span class="comment__time">' + esc(relativeTime(item.created_at)) + '</span>' +
      votes + replyBtn + mineActions +
      '</div>' +
      '<div class="comment__text" data-comment-text="' + item.id + '">' +
      renderCommentBody(item.content) + '</div>' +
      repliesHtml +
      '</div></li>'
    );
  }

  /* 平铺行 → 两级楼中楼：顶层按时间倒序，回复按时间正序挂在父评论下 */
  function renderComments(rows) {
    lastRows = rows || [];
    if (!lastRows.length) {
      listEl.innerHTML = '<li class="comment-empty">' + esc(t('interact.empty', '还没有评论，来说点什么吧。')) + '</li>';
      return;
    }
    var top = [];
    var children = {};
    lastRows.forEach(function (item) {
      if (item.parent_id) {
        (children[item.parent_id] = children[item.parent_id] || []).push(item);
      } else {
        top.push(item);
      }
    });

    var hidden = 0;
    var visibleTop = top.filter(function (item) {
      if (isBlocked(item) && !blockedShown) { hidden += 1; return false; }
      return true;
    });

    var note = '';
    if (hidden > 0 || (blockedShown && hasAnyBlocked())) {
      var label = blockedShown
        ? t('interact.blockedCollapse', '继续隐藏')
        : t('interact.blockedHidden', '已隐藏 {n} 条来自黑名单的评论').split('{n}').join(String(hidden));
      note =
        '<li class="comment-blocked-note"><span>' + esc(label) + '</span>' +
        '<button class="link-btn" type="button" data-blocked-toggle>' +
        esc(blockedShown ? t('interact.blockedCollapse', '继续隐藏') : t('interact.blockedShow', '仍然显示')) +
        '</button></li>';
    }

    listEl.innerHTML =
      note +
      visibleTop
        .map(function (item) {
          var kids = (children[item.id] || []).slice().reverse();
          if (!blockedShown) {
            kids = kids.filter(function (child) { return !isBlocked(child); });
          }
          return commentItem(item, kids);
        })
        .join('');

    if (editingId && !lastRows.some(function (r) { return r.id === editingId; })) editingId = null;
    bindCommentActions();
  }

  function hasAnyBlocked() {
    return lastRows.some(function (row) { return isBlocked(row); });
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
        listEl.innerHTML = '<li class="comment-empty">' + esc(t('interact.loadFail', '评论暂时加载失败，请刷新重试。')) + '</li>';
      });
  }

  /* ---------------- 顶 / 踩（M3） ---------------- */

  function vote(commentId, value, btn) {
    if (!C.currentUser()) {
      toast(t('interact.voteNeedLogin', '登录后才能投票'));
      goLogin();
      return;
    }
    if (C.requireActive()) return;
    if (btn) btn.disabled = true;
    C.db()
      .rpc('comment_vote', { p_comment_id: Number(commentId), p_value: value })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var data = res && res.data;
        if (!data || data.ok !== true) {
          throw new Error((data && data.error) || t('interact.voteFail', '操作失败，请稍后重试'));
        }
        var li = listEl && listEl.querySelector('[data-comment="' + commentId + '"]');
        if (li) {
          var up = li.querySelector('[data-up]');
          var down = li.querySelector('[data-down]');
          var upBtn = li.querySelector('[data-comment-up]');
          var downBtn = li.querySelector('[data-comment-down]');
          if (up) up.textContent = String(data.up);
          if (down) down.textContent = String(data.down);
          var mine = Number(data.my_vote) || 0;
          if (upBtn) {
            upBtn.classList.toggle('is-active', mine === 1);
            upBtn.setAttribute('aria-pressed', mine === 1 ? 'true' : 'false');
          }
          if (downBtn) {
            downBtn.classList.toggle('is-active', mine === -1);
            downBtn.setAttribute('aria-pressed', mine === -1 ? 'true' : 'false');
          }
        }
        var row = lastRows.filter(function (r) { return String(r.id) === String(commentId); })[0];
        if (row) {
          row.up_count = data.up;
          row.down_count = data.down;
          row.my_vote = data.my_vote;
        }
      })
      .catch(function (err) {
        console.warn('[interact] 投票失败', err && err.message);
        toast((err && err.message) || t('interact.voteFail', '操作失败，请稍后重试'));
      })
      .then(function () {
        if (btn) btn.disabled = false;
      });
  }

  /* ---------------- 编辑（M2） ---------------- */

  function startEdit(commentId) {
    var row = lastRows.filter(function (r) { return String(r.id) === String(commentId); })[0];
    if (!row) return;
    if (!withinEditWindow(row)) {
      toast(t('interact.editExpired', '超过 15 分钟了，改不了；可以删除后重新发表。'));
      return;
    }
    editingId = String(commentId);
    var box = listEl.querySelector('[data-comment-text="' + commentId + '"]');
    if (!box) return;
    box.classList.add('comment__text--editing');
    box.innerHTML =
      '<textarea class="comment-form__input comment-edit__input" rows="3" maxlength="1000" data-edit-input="' +
      commentId + '"></textarea>' +
      '<div class="comment-edit__actions">' +
      '<button class="btn btn--primary btn--sm" type="button" data-edit-save="' + commentId + '">' +
      esc(t('interact.editSave', '保存修改')) + '</button>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-edit-cancel="' + commentId + '">' +
      esc(t('interact.editCancel', '放弃修改')) + '</button>' +
      '<span class="field__note">' + esc(t('interact.editWindow', '发表后 15 分钟内可以修改')) + '</span>' +
      '</div>';
    var input = box.querySelector('[data-edit-input]');
    if (input) {
      input.value = row.content || '';
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function cancelEdit(commentId) {
    editingId = null;
    var row = lastRows.filter(function (r) { return String(r.id) === String(commentId); })[0];
    var box = listEl.querySelector('[data-comment-text="' + commentId + '"]');
    if (box && row) {
      box.classList.remove('comment__text--editing');
      box.innerHTML = renderCommentBody(row.content);
    }
  }

  function saveEdit(commentId, btn) {
    var box = listEl.querySelector('[data-comment-text="' + commentId + '"]');
    var input = box && box.querySelector('[data-edit-input]');
    var value = ((input && input.value) || '').trim();
    if (!value) {
      toast(t('interact.editEmpty', '内容不能为空'));
      return;
    }
    if (btn) btn.disabled = true;
    C.db()
      .from('comments')
      .update({ content: value })
      .eq('id', commentId)
      .select()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        if (!rows.length) throw new Error(t('interact.onlyMine', '只能删除自己的评论'));
        editingId = null;
        var back = rows[0].status === 'pending';
        toast(back
          ? t('interact.editReReview', '修改已提交，站长重新审核后显示')
          : t('interact.published', '评论已发布'));
        return loadComments();
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        if (editWindowClosed(err)) {
          toast(t('interact.editExpired', '超过 15 分钟了，改不了；可以删除后重新发表。'));
        } else {
          console.warn('[interact] 编辑失败', (err && err.message) || '');
          toast((err && err.message) || t('interact.editFail', '修改失败，请稍后重试'));
        }
      });
  }

  /* ---------------- 举报（M13） ---------------- */

  var REPORT_REASONS = [
    { value: 'spam', key: 'interact.reportSpam', fallback: '垃圾广告' },
    { value: 'abuse', key: 'interact.reportAbuse', fallback: '人身攻击' },
    { value: 'ad', key: 'interact.reportAd', fallback: '推广营销' },
    { value: 'illegal', key: 'interact.reportIllegal', fallback: '违法违规' },
    { value: 'offtopic', key: 'interact.reportOfftopic', fallback: '无关内容' },
    { value: 'other', key: 'interact.reportOther', fallback: '其他' },
  ];

  function openReport(commentId) {
    var row = lastRows.filter(function (r) { return String(r.id) === String(commentId); })[0];
    if (!row) return;
    if (row.is_mine) {
      toast(t('interact.reportSelf', '不能举报自己的评论'));
      return;
    }
    var options = REPORT_REASONS.map(function (item) {
      return '<option value="' + item.value + '">' + esc(t(item.key, item.fallback)) + '</option>';
    }).join('');
    var modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('data-report-modal', '');
    modal.innerHTML =
      '<div class="modal__panel">' +
      '<h3 class="modal__title">' + esc(t('interact.reportTitle', '举报这条评论')) + '</h3>' +
      '<blockquote class="modal__quote">' + renderCommentBody(row.content) + '</blockquote>' +
      '<label class="field"><span class="field__label">' + esc(t('interact.reportReason', '原因')) + '</span>' +
      '<select class="field__input" data-report-reason>' + options + '</select></label>' +
      '<label class="field"><span class="field__label">' + esc(t('interact.reportNote', '补充说明（可选）')) + '</span>' +
      '<input class="field__input" type="text" maxlength="200" data-report-note></label>' +
      '<div class="modal__actions">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-report-cancel>' +
      esc(t('interact.reportCancel', '取消')) + '</button>' +
      '<button class="btn btn--danger btn--sm" type="button" data-report-submit>' +
      esc(t('interact.reportSubmit', '提交举报')) + '</button>' +
      '</div></div>';
    document.body.appendChild(modal);

    function close() {
      if (modal.parentNode) modal.parentNode.removeChild(modal);
    }

    modal.addEventListener('click', function (e) {
      if (e.target === modal) close();
    });
    modal.querySelector('[data-report-cancel]').addEventListener('click', close);
    var submit = modal.querySelector('[data-report-submit]');
    submit.addEventListener('click', function () {
      var reason = modal.querySelector('[data-report-reason]').value;
      var note = (modal.querySelector('[data-report-note]').value || '').trim();
      submit.disabled = true;
      C.db()
        .from('comment_reports')
        .insert({
          comment_id: row.id,
          post_slug: slug,
          reason: reason,
          note: note || null,
        })
        .select()
        .then(function (res) {
          if (res && res.error) {
            if (res.error.code === '23505') {
              toast(t('interact.reportDone', '你已经举报过这条评论了'));
              close();
              return null;
            }
            throw res.error;
          }
          toast(t('interact.reportSent', '已提交举报，站长会看到'));
          close();
          return null;
        })
        .catch(function (err) {
          submit.disabled = false;
          console.warn('[interact] 举报失败', err && err.message);
          toast((err && err.message) || t('interact.reportFail', '举报失败，请稍后重试'));
        });
    });
  }

  /* ---------------- 拉黑（M13） ---------------- */

  function blockUser(authorId, name) {
    if (!C.currentUser()) {
      toast(t('interact.blockNeedLogin', '登录后才能拉黑'));
      goLogin();
      return;
    }
    if (!authorId) return;
    if (!window.confirm(t('interact.blockConfirm', '拉黑 {name}？拉黑后 ta 的评论在你这里会隐藏，随时可以取消。').split('{name}').join(name))) {
      return;
    }
    C.db()
      .from('user_blocks')
      .insert({ blocked_id: authorId, blocked_name: name })
      .select()
      .then(function (res) {
        if (res && res.error && res.error.code !== '23505') throw res.error;
        blocked[authorId] = name;
        toast(t('interact.blocked', '已拉黑，这个人的评论不再显示'));
        renderComments(lastRows);
      })
      .catch(function (err) {
        console.warn('[interact] 拉黑失败', err && err.message);
        toast((err && err.message) || t('interact.blockFail', '操作失败，请稍后重试'));
      });
  }

  function loadBlocks() {
    if (!C.currentUser()) {
      blocked = {};
      return Promise.resolve();
    }
    return C.db()
      .from('user_blocks')
      .select('blocked_id, blocked_name')
      .then(function (res) {
        if (res && res.error) throw res.error;
        blocked = {};
        ((res && res.data) || []).forEach(function (row) {
          if (row.blocked_id) blocked[row.blocked_id] = row.blocked_name || '';
        });
        return blocked;
      })
      .catch(function () { return blocked; });
  }

  /* ---------------- 阅读进度（M11） ---------------- */

  var progressTimer = null;
  var progressSent = 0;

  function currentPercent() {
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return 100;
    var ratio = window.scrollY / scrollable;
    if (!isFinite(ratio)) return 0;
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
  }

  function saveProgress(force) {
    if (!inited || !C.currentUser()) return;
    var percent = currentPercent();
    if (!force && Math.abs(percent - progressSent) < 5) return;
    progressSent = percent;
    C.db()
      .from('reading_history')
      .upsert(
        {
          post_slug: slug,
          title: postTitle || slug,
          percent: percent,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'owner_id,post_slug' }
      )
      .then(function (res) {
        if (res && res.error) {
          console.warn('[interact] 阅读进度保存失败', res.error.message);
        }
      })
      .catch(function (err) {
        console.warn('[interact] 阅读进度保存失败', err && err.message);
      });
  }

  function scheduleProgress() {
    if (progressTimer) window.clearTimeout(progressTimer);
    progressTimer = window.setTimeout(function () {
      saveProgress(false);
    }, 4000);
  }

  function dismissResume(key) {
    try {
      window.localStorage.setItem(key, '1');
    } catch (err) { /* 忽略 */ }
    var bar = document.querySelector('[data-resume-bar]');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  function showResumeBar(percent) {
    var bar = document.createElement('div');
    bar.className = 'resume-bar';
    bar.setAttribute('data-resume-bar', '');
    bar.innerHTML =
      '<div class="wrap resume-bar__inner">' +
      '<span class="resume-bar__text">' +
      esc(t('reading.resume', '上次读到 {n}%').split('{n}').join(String(percent))) +
      '</span>' +
      '<button class="btn btn--primary btn--sm" type="button" data-resume-go>' +
      esc(t('reading.continue', '继续阅读')) + '</button>' +
      '<button class="link-btn" type="button" data-resume-restart>' +
      esc(t('reading.restart', '从头开始')) + '</button>' +
      '<button class="resume-bar__close" type="button" data-resume-close aria-label="' +
      esc(t('interact.cancel', '取消')) + '">×</button>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);

    var key = 'wsblog:resumeDismissed:' + slug;
    function scrollToPercent() {
      var doc = document.documentElement;
      var scrollable = doc.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, (percent / 100) * scrollable), behavior: 'smooth' });
    }
    var goBtn = bar.querySelector('[data-resume-go]');
    if (goBtn) {
      goBtn.addEventListener('click', function () {
        dismissResume(key);
        scrollToPercent();
      });
    }
    var restart = bar.querySelector('[data-resume-restart]');
    if (restart) {
      restart.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        dismissResume(key);
      });
    }
    var close = bar.querySelector('[data-resume-close]');
    if (close) close.addEventListener('click', function () { dismissResume(key); });
  }

  function loadProgress() {
    if (!C.currentUser()) return Promise.resolve();
    var dismissKey = 'wsblog:resumeDismissed:' + slug;
    var dismissed = false;
    try {
      dismissed = window.localStorage.getItem(dismissKey) === '1';
    } catch (err) { /* 忽略 */ }
    return C.db()
      .from('reading_history')
      .select('percent')
      .eq('post_slug', slug)
      .maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var row = res && res.data;
        if (!row) return;
        var percent = Number(row.percent) || 0;
        if (dismissed) return;
        if (percent >= 5 && percent <= 95) {
          window.setTimeout(function () { showResumeBar(percent); }, 600);
        } else if (percent > 95) {
          /* 已经读完：下次从头开始读就是新的一遍 */
          return;
        }
      })
      .catch(function (err) {
        console.warn('[interact] 阅读进度读取失败', err && err.message);
      });
  }

  /* ---------------- 表情 / 代码插入（M16） ---------------- */

  var EMOJIS = ('😀 😁 😂 🤣 😊 😍 🤔 😅 😉 🙃 😴 😭 😢 😱 😤 ' +
    '👍 👎 👏 🙏 🤝 💪 ✌️ 🎉 🔥 💡 ✅ ❌ ⚠️ 🚀 🐛 📌 📎 ' +
    '❤️ 💯 🍵 ☕ 🌱 🌙 ⭐').split(' ');

  var CODE_LANGS = ['', 'js', 'ts', 'python', 'sql', 'bash', 'json', 'html', 'css', 'go', 'java', 'rust', 'yaml'];

  function insertAtCursor(text) {
    if (!inputEl) return;
    var start = inputEl.selectionStart == null ? inputEl.value.length : inputEl.selectionStart;
    var end = inputEl.selectionEnd == null ? inputEl.value.length : inputEl.selectionEnd;
    var before = inputEl.value.slice(0, start);
    var after = inputEl.value.slice(end);
    inputEl.value = before + text + after;
    var caret = start + text.length;
    try {
      inputEl.setSelectionRange(caret, caret);
    } catch (err) { /* 忽略 */ }
    inputEl.focus();
  }

  function buildEmojiPicker() {
    if (!emojiPicker) return;
    emojiPicker.innerHTML = EMOJIS.map(function (emoji) {
      return '<button class="emoji-picker__item" type="button" data-emoji="' + emoji + '">' + emoji + '</button>';
    }).join('');
    emojiPicker.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-emoji]') : null;
      if (!btn) return;
      e.preventDefault();
      insertAtCursor(btn.getAttribute('data-emoji'));
    });
  }

  function toggleEmoji(force) {
    if (!emojiPicker || !emojiToggle) return;
    var open = force == null ? emojiPicker.hasAttribute('hidden') : force;
    if (open) {
      emojiPicker.removeAttribute('hidden');
      emojiToggle.setAttribute('aria-expanded', 'true');
    } else {
      emojiPicker.setAttribute('hidden', '');
      emojiToggle.setAttribute('aria-expanded', 'false');
    }
  }

  function insertCodeBlock() {
    if (!inputEl) return;
    var wrapped = '```\n' + (inputEl.value && inputEl.selectionStart != null
      ? inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd || inputEl.selectionStart)
      : '') + '\n```';
    insertAtCursor(wrapped);
  }

  /* ---------------- 绑定 ---------------- */

  function bindCommentActions() {
    bindDeletes();
    bindEdits();
    bindVotes();

    qa('[data-comment-reply]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!C.currentUser()) {
          toast(t('interact.replyNeedLogin', '登录后才能回复'));
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

    qa('[data-comment-report]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!C.currentUser()) {
          toast(t('interact.needLogin', '登录后才能评论'));
          goLogin();
          return;
        }
        openReport(btn.getAttribute('data-comment-report'));
      });
    });

    qa('[data-comment-block]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        blockUser(btn.getAttribute('data-comment-block'), btn.getAttribute('data-comment-block-name') || '');
      });
    });

    var toggle = listEl.querySelector('[data-blocked-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        blockedShown = !blockedShown;
        renderComments(lastRows);
      });
    }
  }

  function bindVotes() {
    qa('[data-comment-up]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        vote(btn.getAttribute('data-comment-up'), 1, btn);
      });
    });
    qa('[data-comment-down]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        vote(btn.getAttribute('data-comment-down'), -1, btn);
      });
    });
  }

  function bindEdits() {
    qa('[data-comment-edit]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        startEdit(btn.getAttribute('data-comment-edit'));
      });
    });
    qa('[data-edit-save]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        saveEdit(btn.getAttribute('data-edit-save'), btn);
      });
    });
    qa('[data-edit-cancel]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        cancelEdit(btn.getAttribute('data-edit-cancel'));
      });
    });
  }

  function bindDeletes() {
    qa('[data-comment-delete]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-comment-delete');
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
            if (rows.length === 0) throw new Error(t('interact.onlyMine', '只能删除自己的评论'));
            toast(t('interact.deleted', '评论已删除'));
            return loadComments();
          })
          .catch(function (err) {
            btn.disabled = false;
            toast((err && err.message) || t('interact.deleteFail', '删除失败，请稍后重试'));
          });
      });
    });
  }

  function submitComment(event) {
    if (event) event.preventDefault();
    if (!inited || editing) return;
    if (!C.currentUser()) {
      toast(t('interact.needLogin', '登录后才能评论'));
      goLogin();
      return;
    }
    if (C.requireActive()) return;
    var content = ((inputEl && inputEl.value) || '').trim();
    if (!content) {
      toast(t('interact.needContent', '评论内容不能为空'));
      return;
    }
    if (content.length > 1000) {
      toast(t('interact.tooLong', '评论最多 1000 字'));
      return;
    }
    editing = true;
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
        if (rows.length === 0) throw new Error(t('interact.saveFail', '评论没有保存成功，请稍后重试'));
        if (inputEl) inputEl.value = '';
        setReplyTarget(null);
        toggleEmoji(false);
        /* 用服务端回写的 status 决定文案：普通读者的评论会先进待审，
           不能提示「已发布」——那会让人以为线上已经能看到。 */
        var needReview = rows[0] && rows[0].status === 'pending';
        if (needReview) {
          toast(wasReply ? t('interact.pendingReply', '回复已提交，站长通过后显示') : t('interact.pending', '评论已提交，站长通过后显示'));
        } else {
          toast(wasReply ? t('interact.publishedReply', '回复已发布') : t('interact.published', '评论已发布'));
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
        editing = false;
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
    loadBlocks().then(function () { loadComments(); });
    loadProfile();
    loadProgress();
    /* 从个人中心的「继续阅读」进来时直接定位 */
    if (location.hash === '#resume') {
      loadProgress();
    }
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
  if (emojiToggle) {
    emojiToggle.addEventListener('click', function (e) {
      e.preventDefault();
      toggleEmoji();
    });
  }
  if (codeInsert) {
    codeInsert.addEventListener('click', function (e) {
      e.preventDefault();
      insertCodeBlock();
    });
  }
  buildEmojiPicker();
  document.addEventListener('click', function (e) {
    if (!emojiPicker || emojiPicker.hasAttribute('hidden')) return;
    if (emojiPicker.contains(e.target)) return;
    if (emojiToggle && emojiToggle.contains(e.target)) return;
    toggleEmoji(false);
  });

  window.addEventListener('scroll', function () {
    if (!inited || !C.currentUser()) return;
    scheduleProgress();
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveProgress(true);
  });
  window.addEventListener('beforeunload', function () {
    saveProgress(true);
  });

  C.onSessionChange(function () {
    if (!inited) return;
    renderForSession();
    loadProfile();
    readState();
    loadBlocks().then(function () { loadComments(); });
  });

  C.booted().then(function () {
    init(root.getAttribute('data-post-slug'), root.getAttribute('data-post-title'));
  });

  window.WSBlogInteract = {
    init: init,
    isReady: function () { return inited; },
    /* 供个人中心等外部页面复用同一套评论渲染（代码块 / 提及 / 投票） */
    renderBody: renderCommentBody,
    /* 回归测试出口：commentItem 是闭包，外部抽不出来（依赖 esc / t / withinEditWindow 等
     * 同层函数）。只导出引用、不改任何线上行为；`.preview/comment-thread-test.mjs` 用它。 */
    __test: { commentItem: commentItem },
  };
})();
