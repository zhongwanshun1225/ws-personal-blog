/**
 * 管理员后台。
 *
 * 五个面板：文章管理（在线写 / 编辑 / 发布 / 删除）、内容审核（用户投稿的通过 / 驳回）、
 * 评论管理（隐藏 / 恢复 / 删除）、用户管理、管理员邮箱白名单。
 *
 * 投稿状态机：
 *   draft（作者草稿）→ pending（提交待审）→ published（审核通过，前台可见）
 *                                          ↘ rejected（驳回，作者可见理由并改稿重投）
 *   管理员自己写的文章不走审核，可直接 draft ↔ published。
 *
 * 权限说明（两层，缺一不可）：
 *   1. 服务端 RLS + SECURITY DEFINER 函数 —— 非管理员调用会被数据库直接拒绝
 *   2. 本脚本的守卫 —— 未登录跳登录页；白名单账号自动切到管理员身份；非白名单账号退回首页
 * 前端的守卫只是体验优化，真正的边界在数据库。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var root = document.querySelector('[data-admin]');
  if (!root) return;

  function q(selector, scope) {
    return (scope || root).querySelector(selector);
  }

  function qa(selector, scope) {
    return Array.prototype.slice.call((scope || root).querySelectorAll(selector));
  }

  var esc = C.escapeHtml;
  var toast = C.toast;

  /* ---------------- 元素 ---------------- */

  var form = q('[data-post-form]');
  var formTitle = q('[data-editor-title]');
  var fieldTitle = q('[name="title"]');
  var fieldSlug = q('[name="slug"]');
  var fieldSummary = q('[name="summary"]');
  var fieldTags = q('[name="tags"]');
  var fieldContent = q('[name="content_md"]');
  var fieldStatus = q('[name="status"]');
  var saveBtn = q('[data-post-save]');
  var publishBtn = q('[data-post-publish]');
  var resetBtn = q('[data-post-reset]');
  var previewBtn = q('[data-post-preview]');
  var imageBtn = q('[data-post-image]');
  var previewBox = q('[data-post-preview-box]');
  var postsBody = q('[data-admin-posts]');
  var postCountEl = q('[data-post-count]');
  var reviewBody = q('[data-admin-review]');
  var reviewedBody = q('[data-admin-reviewed]');
  var reviewCountEl = q('[data-review-count]');
  var reviewBadgeEl = q('[data-review-badge]');
  var usersBody = q('[data-admin-users]');
  var commentsBody = q('[data-admin-comments]');
  var commentCountEl = q('[data-comment-total]');
  var emailsBody = q('[data-admin-emails]');
  var emailInput = q('[data-admin-email-input]');
  var emailNote = q('[data-admin-email-note]');
  var emailAddBtn = q('[data-admin-email-add]');

  /* 分页与搜索控件 */
  var postSearchEl = q('[data-post-search]');
  var postStatusEl = q('[data-post-status]');
  var postPagerEl = q('[data-post-pager]');
  var commentSearchEl = q('[data-comment-search]');
  var commentPagerEl = q('[data-comment-pager]');
  var userSearchEl = q('[data-user-search]');
  var userStatusEl = q('[data-user-status]');
  var userPagerEl = q('[data-user-pager]');
  var reviewPagerEl = q('[data-review-pager]');
  var reviewedPagerEl = q('[data-reviewed-pager]');

  /* 后台编辑器本地草稿 */
  var adminDraftBanner = q('[data-admin-draft-banner]');
  var adminDraftText = q('[data-admin-draft-text]');
  var adminDraftRestore = q('[data-admin-draft-restore]');
  var adminDraftDiscard = q('[data-admin-draft-discard]');
  var adminStatusEl = q('[data-admin-status]');

  var busy = false;
  var editingSlug = '';
  var allComments = [];
  var allUsers = [];
  var allPosts = [];
  var pendingAdminDraft = null;
  var adminDraft = null;

  /* 三个列表各自的分页 / 筛选状态（服务端分页，见 admin_posts_page 等 RPC） */
  var postsState = { search: '', status: 'all', page: 1, pageSize: 20, total: 0 };
  var commentsState = { search: '', status: 'all', page: 1, pageSize: 30, total: 0 };
  var usersState = { search: '', status: 'all', page: 1, pageSize: 30, total: 0 };
  var pendingState = { page: 1, pageSize: 20, total: 0 };
  var reviewedState = { page: 1, pageSize: 20, total: 0 };

  /* 状态徽章：draft / pending / published / rejected */
  var STATUS_META = {
    draft: { label: '草稿', cls: 'status-badge--draft' },
    pending: { label: '待审核', cls: 'status-badge--pending' },
    published: { label: '已发布', cls: 'status-badge--published' },
    rejected: { label: '未通过', cls: 'status-badge--rejected' },
  };

  function statusBadge(status) {
    var meta = STATUS_META[status] || { label: status || '未知', cls: '' };
    return '<span class="status-badge ' + meta.cls + '">' + esc(meta.label) + '</span>';
  }

  /* ---------------- 小工具 ---------------- */

  function slugify(text) {
    return String(text || '')
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'post';
  }

  function tagsToArray(value) {
    return String(value || '')
      .split(/[,，、\s]+/)
      .map(function (item) {
        return item.trim();
      })
      .filter(Boolean);
  }

  function tagsToText(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'string') {
      return value.replace(/^\{|\}$/g, '').replace(/["']/g, '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).join(', ');
    }
    return '';
  }

  function setText(node, value) {
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function api(promise, fallbackMessage) {
    return promise.then(function (res) {
      if (res && res.error) throw res.error;
      return res && res.data;
    }).catch(function (err) {
      var message = (err && err.message) || fallbackMessage || '操作失败';
      toast(message);
      throw err;
    });
  }

  /** 从分页 RPC 的返回里取出 rows，顺带做错误判定。 */
  function pageRows(data, fallbackMessage) {
    var payload = data && typeof data === 'object' ? data : {};
    if (payload.ok !== true) throw new Error(payload.error || fallbackMessage || '加载失败');
    return payload;
  }

  /** 通用分页条：上一页 / 页码 / 下一页。 */
  function renderPager(el, state, reload) {
    if (!el) return;
    var totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (!state.total) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML =
      '<button class="btn btn--ghost btn--sm" type="button" data-pager-prev' +
      (state.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span class="admin-pager__info">第 ' + state.page + ' / ' + totalPages + ' 页 · 共 ' +
      state.total + ' 条</span>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-pager-next' +
      (state.page >= totalPages ? ' disabled' : '') + '>下一页</button>';
    var prev = el.querySelector('[data-pager-prev]');
    var next = el.querySelector('[data-pager-next]');
    if (prev) {
      prev.addEventListener('click', function () {
        if (state.page > 1) {
          state.page -= 1;
          reload();
        }
      });
    }
    if (next) {
      next.addEventListener('click', function () {
        if (state.page < totalPages) {
          state.page += 1;
          reload();
        }
      });
    }
  }

  /** 搜索框防抖：输入停顿后再查，避免每敲一个字打一次库。 */
  function bindSearch(input, state, reload, delay) {
    if (!input) return;
    var timer = null;
    input.addEventListener('input', function () {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        var value = input.value.trim();
        if (value === state.search) return;
        state.search = value;
        state.page = 1;
        reload();
      }, delay || 350);
    });
  }

  function bindSelect(select, state, reload) {
    if (!select) return;
    select.addEventListener('change', function () {
      state.status = select.value || 'all';
      state.page = 1;
      reload();
    });
  }

  /* ---------------- 后台编辑器的本地草稿 ---------------- */

  var ADMIN_DRAFT_NS = 'admin';

  function adminDraftKey() {
    return window.WSBlogDraft
      ? window.WSBlogDraft.key(ADMIN_DRAFT_NS, editingSlug)
      : '';
  }

  function setAdminStatus(text, level) {
    if (!adminStatusEl) return;
    adminStatusEl.textContent = text || '';
    adminStatusEl.setAttribute('data-level', level || 'idle');
  }

  function collectAdminDraft() {
    return {
      title: (fieldTitle && fieldTitle.value) || '',
      slug: (fieldSlug && fieldSlug.value) || '',
      summary: (fieldSummary && fieldSummary.value) || '',
      tags: (fieldTags && fieldTags.value) || '',
      content_md: (fieldContent && fieldContent.value) || '',
      status: (fieldStatus && fieldStatus.value) || 'draft',
    };
  }

  function setupAdminDraft() {
    if (!window.WSBlogDraft || adminDraft || !form) return;
    adminDraft = window.WSBlogDraft.attach({
      form: form,
      keyFn: adminDraftKey,
      collect: collectAdminDraft,
      isEmpty: function (data) {
        return !(String(data.title || '').trim() || String(data.content_md || '').trim());
      },
      onStatus: setAdminStatus,
    });
  }

  function hideAdminDraftBanner() {
    pendingAdminDraft = null;
    if (adminDraftBanner) adminDraftBanner.setAttribute('hidden', '');
  }

  function checkAdminDraft() {
    if (!window.WSBlogDraft || !form) return;
    var key = adminDraftKey();
    if (!key) return;
    var data = window.WSBlogDraft.read(key);
    hideAdminDraftBanner();
    if (!data) return;
    if (!(String(data.title || '').trim() || String(data.content_md || '').trim())) {
      window.WSBlogDraft.remove(key);
      return;
    }
    /* 编辑器里已有内容且与本地草稿一致时，不必提示 */
    var current = collectAdminDraft();
    var same = ['title', 'slug', 'summary', 'tags', 'content_md'].every(function (k) {
      return String(current[k] || '') === String(data[k] || '');
    });
    if (same) {
      window.WSBlogDraft.remove(key);
      return;
    }
    pendingAdminDraft = data;
    if (adminDraftText) {
      var when = new Date(data.savedAt);
      adminDraftText.textContent =
        '检测到本机保存的草稿「' + (String(data.title || '').trim() || '（未命名）') + '」（' +
        String(data.content_md || '').length + ' 字，' +
        (isNaN(when.getTime()) ? '' : when.toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })) + '）。要恢复吗？';
    }
    if (adminDraftBanner) adminDraftBanner.removeAttribute('hidden');
  }

  function clearAdminDraft() {
    if (!window.WSBlogDraft) return;
    window.WSBlogDraft.remove(window.WSBlogDraft.key(ADMIN_DRAFT_NS, editingSlug));
    window.WSBlogDraft.remove(window.WSBlogDraft.key(ADMIN_DRAFT_NS, ''));
  }

  if (adminDraftRestore) {
    adminDraftRestore.addEventListener('click', function () {
      if (!pendingAdminDraft) return;
      var data = pendingAdminDraft;
      if (fieldTitle) fieldTitle.value = data.title || '';
      if (fieldSlug) fieldSlug.value = data.slug || '';
      if (fieldSummary) fieldSummary.value = data.summary || '';
      if (fieldTags) fieldTags.value = data.tags || '';
      if (fieldContent) fieldContent.value = data.content_md || '';
      if (fieldStatus && data.status) fieldStatus.value = data.status;
      hideAdminDraftBanner();
      setAdminStatus('已恢复本机草稿', 'saved');
      if (fieldTitle) fieldTitle.focus();
    });
  }

  if (adminDraftDiscard) {
    adminDraftDiscard.addEventListener('click', function () {
      clearAdminDraft();
      hideAdminDraftBanner();
      setAdminStatus('', 'idle');
      toast('已丢弃本机草稿');
    });
  }

  /* ---------------- 面板切换 ---------------- */

  function showPanel(name) {
    qa('[data-admin-tab]').forEach(function (btn) {
      var active = btn.getAttribute('data-admin-tab') === name;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    qa('[data-admin-panel]').forEach(function (panel) {
      if (panel.getAttribute('data-admin-panel') === name) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
    if (name === 'audit') loadAudit();
  }

  qa('[data-admin-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      showPanel(btn.getAttribute('data-admin-tab'));
    });
  });

  /* ---------------- 操作日志（服务端审计留痕） ---------------- */

  var AUDIT_LABELS = {
    post_delete: '删除文章',
    post_review: '内容审核',
    comment_delete: '删除评论',
    comment_status: '评论显隐',
    user_status: '封禁/解禁',
    user_delete: '删除用户',
    admin_add: '新增管理员',
    admin_remove: '移除管理员',
    slugs_sync: '同步文章清单'
  };

  function loadAudit() {
    var body = q('[data-audit-log]');
    if (!body) return Promise.resolve(null);
    return C.db()
      .from('admin_audit_log')
      .select('id, actor_email, action, target_type, target_id, note, payload, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        body.innerHTML = rows.length
          ? rows.map(function (item) {
              var detail = '';
              if (item.note) detail += esc(item.note);
              if (item.payload) {
                try {
                  var p = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload;
                  var kv = Object.keys(p).map(function (k) {
                    return k + '=' + String(p[k] == null ? '—' : p[k]).slice(0, 60);
                  }).join(' · ');
                  if (kv) detail += (detail ? ' · ' : '') + esc(kv);
                } catch (err) { /* payload 不是合法 JSON 时忽略 */ }
              }
              return (
                '<tr>' +
                '<td class="admin-cell__sub mono">' + esc(C.formatDate(item.created_at)) + '</td>' +
                '<td class="admin-cell__sub">' + esc(item.actor_email || item.target_id || '—') + '</td>' +
                '<td>' + esc(AUDIT_LABELS[item.action] || item.action) + '</td>' +
                '<td class="mono admin-cell__sub">' + esc([item.target_type, item.target_id].filter(Boolean).join(':') || '—') + '</td>' +
                '<td class="admin-cell__sub">' + (detail || '—') + '</td>' +
                '</tr>'
              );
            }).join('')
          : '<tr><td colspan="5" class="admin-empty">还没有任何管理操作记录。</td></tr>';
        return rows;
      })
      .catch(function (err) {
        body.innerHTML = '<tr><td colspan="5" class="admin-empty">日志加载失败：' + esc((err && err.message) || '未知错误') + '</td></tr>';
        return null;
      });
  }

  /* ---------------- 文章 slug 清单同步（供浏览量白名单使用） ---------------- */

  function syncSlugs() {
    var root = window.__ROOT__ || '/';
    return fetch(root + 'assets/slug-manifest.json')
      .then(function (res) {
        return res.ok ? res.json() : { slugs: [] };
      })
      .then(function (manifest) {
        var slugs = (manifest && manifest.slugs) || [];
        if (!slugs.length) return null;
        /* 只同步静态 slug；云端文章的白名单由 post_view 直接查 cloud_posts */
        return C.db().rpc('admin_sync_slugs', { p_slugs: slugs });
      })
      .catch(function () {
        /* 同步失败不影响后台使用；云端文章浏览量不受影响，静态 slug 用存量清单 */
      });
  }

  /* ---------------- 概览数据 ---------------- */

  function setReviewBadge(count) {
    if (!reviewBadgeEl) return;
    if (count > 0) {
      reviewBadgeEl.textContent = String(count);
      reviewBadgeEl.removeAttribute('hidden');
    } else {
      reviewBadgeEl.setAttribute('hidden', '');
    }
  }

  function loadStats() {
    return api(C.db().rpc('admin_stats'), '概览数据加载失败').then(function (data) {
      var stats = data && typeof data === 'object' ? data : {};
      setText(q('[data-stat-users]'), stats.users || 0);
      setText(q('[data-stat-disabled]'), stats.disabled_users || 0);
      setText(q('[data-stat-comments]'), stats.comments || 0);
      setText(q('[data-stat-hidden]'), stats.hidden || 0);
      setText(q('[data-stat-likes]'), stats.likes || 0);
      setText(q('[data-stat-posts]'), stats.posts || 0);
      setText(q('[data-stat-drafts]'), stats.drafts || 0);
      setText(q('[data-stat-pending]'), stats.pending || 0);
      setText(q('[data-stat-today]'), stats.today_comments || 0);
      setText(q('[data-stat-views]'), Number(stats.views || 0).toLocaleString());
      setReviewBadge(Number(stats.pending || 0));
      return stats;
    });
  }

  /* ---------------- 文章管理 ---------------- */

  function resetForm() {
    editingSlug = '';
    if (form) form.reset();
    if (fieldStatus) fieldStatus.value = 'draft';
    if (formTitle) formTitle.textContent = '写一篇新文章';
    if (previewBox) {
      previewBox.innerHTML = '';
      previewBox.setAttribute('hidden', '');
    }
    if (saveBtn) saveBtn.textContent = '保存草稿';
  }

  function readForm(status) {
    return {
      title: (fieldTitle && fieldTitle.value || '').trim(),
      slug: slugify((fieldSlug && fieldSlug.value) || (fieldTitle && fieldTitle.value) || ''),
      summary: (fieldSummary && fieldSummary.value || '').trim(),
      tags: tagsToArray(fieldTags && fieldTags.value),
      content_md: (fieldContent && fieldContent.value) || '',
      status: status || (fieldStatus && fieldStatus.value) || 'draft',
    };
  }

  function validate(payload) {
    if (!payload.title) {
      toast('请填写文章标题');
      if (fieldTitle) fieldTitle.focus();
      return false;
    }
    if (!payload.content_md.trim()) {
      toast('正文不能为空');
      if (fieldContent) fieldContent.focus();
      return false;
    }
    return true;
  }

  function savePost(status) {
    if (busy) return;
    var payload = readForm(status);
    if (!validate(payload)) return;
    busy = true;
    if (saveBtn) saveBtn.disabled = true;
    if (publishBtn) publishBtn.disabled = true;

    payload.updated_at = new Date().toISOString();
    if (payload.status === 'published') payload.published_at = new Date().toISOString();

    var request;
    if (editingSlug) {
      request = C.db().from('cloud_posts').update(payload).eq('slug', editingSlug).select();
    } else {
      payload.author_id = C.currentUid() || undefined;
      request = C.db().from('cloud_posts').insert(payload).select();
    }

    api(request, '保存失败')
      .then(function (rows) {
        if (!rows || !rows.length) throw new Error('保存失败：返回为空（可能没有管理员权限）');
        toast(payload.status === 'published' ? '已发布' : '草稿已保存');
        /* 已落到云端，清掉本机草稿（含新建时用的 new 槽位） */
        clearAdminDraft();
        hideAdminDraftBanner();
        setAdminStatus(payload.status === 'published' ? '已发布到云端' : '已保存到云端', 'saved');
        resetForm();
        return Promise.all([loadPosts(), loadStats(), loadReview()]);
      })
      .catch(function () {
        /* api() 已提示 */
      })
      .then(function () {
        busy = false;
        if (saveBtn) saveBtn.disabled = false;
        if (publishBtn) publishBtn.disabled = false;
      });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      savePost('draft');
    });
  }
  if (publishBtn) {
    publishBtn.addEventListener('click', function () {
      savePost('published');
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (adminDraft) adminDraft.discard();
      clearAdminDraft();
      hideAdminDraftBanner();
      resetForm();
    });
  }

  /* ---------------- 插入图片（上传到云存储） ---------------- */

  var imageBusy = false;

  function insertAtCursor(field, text) {
    if (!field) return;
    var start = field.selectionStart || 0;
    var end = field.selectionEnd || 0;
    var before = field.value.slice(0, start);
    var after = field.value.slice(end);
    var pad = before && !/\n$/.test(before) ? '\n' : '';
    field.value = before + pad + text + after;
    var pos = (before + pad + text).length;
    field.focus();
    field.setSelectionRange(pos, pos);
  }

  if (imageBtn) {
    imageBtn.addEventListener('click', function () {
      if (!window.WSBlogUpload) {
        toast('上传模块未加载');
        return;
      }
      if (imageBusy) return;
      imageBusy = true;
      imageBtn.disabled = true;
      var original = imageBtn.textContent;
      imageBtn.textContent = '上传中…';
      window.WSBlogUpload.pickAndUpload({ accept: 'image/*', maxMB: 8, folder: 'blog' })
        .then(function (res) {
          insertAtCursor(fieldContent, '![](' + res.url + ')\n');
          toast('图片已插入正文');
        })
        .catch(function (err) {
          toast((err && (err.message || err.error_description)) || '图片上传失败');
        })
        .then(function () {
          imageBusy = false;
          imageBtn.disabled = false;
          imageBtn.textContent = original;
        });
    });
  }

  if (previewBtn) {
    previewBtn.addEventListener('click', function () {
      if (!previewBox) return;
      var text = (fieldContent && fieldContent.value) || '';
      if (!text.trim()) {
        toast('正文还是空的');
        return;
      }
      var open = !previewBox.hasAttribute('hidden');
      if (open) {
        previewBox.setAttribute('hidden', '');
        return;
      }
      previewBox.removeAttribute('hidden');
      previewBox.innerHTML = window.WSBlogCloudMarkdown
        ? window.WSBlogCloudMarkdown.render(text)
        : '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
    });
  }

  function authorCell(post) {
    var name = post.author_name || post.author_email || '未知作者';
    return (
      '<td><div class="admin-cell__title">' + esc(name) +
      (post.is_own ? ' <span class="admin-tag">我</span>' : '') + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(post.author_email || post.author_id || '') + '</div></td>'
    );
  }

  function postRow(post) {
    var isPublished = post.status === 'published';
    return (
      '<tr data-post-row="' + esc(post.slug) + '">' +
      '<td><div class="admin-cell__title">' + esc(post.title) + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(post.slug) + '</div></td>' +
      authorCell(post) +
      '<td>' + statusBadge(post.status) + '</td>' +
      '<td class="admin-cell__sub">' + esc(C.formatDate(post.updated_at || post.created_at)) + '</td>' +
      '<td class="admin-cell__actions">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-post-edit="' + esc(post.slug) + '">编辑</button>' +
      (isPublished
        ? '<button class="btn btn--ghost btn--sm" type="button" data-post-unpublish="' + esc(post.slug) + '">转草稿</button>'
        : '<button class="btn btn--ghost btn--sm" type="button" data-post-publish-row="' + esc(post.slug) + '">发布</button>') +
      '<button class="btn btn--danger btn--sm" type="button" data-post-delete="' + esc(post.slug) + '">删除</button>' +
      '</td></tr>'
    );
  }

  /** 把某篇文章载入左侧编辑器（文章管理与内容审核共用）。 */
  function loadIntoEditor(slug) {
    editingSlug = slug;
    return api(
      C.db().from('cloud_posts')
        .select('title, slug, summary, tags, content_md, status, review_note')
        .eq('slug', slug).maybeSingle(),
      '读取文章失败'
    ).then(function (row) {
      if (!row) throw new Error('文章不存在');
      if (fieldTitle) fieldTitle.value = row.title || '';
      if (fieldSlug) fieldSlug.value = row.slug || '';
      if (fieldSummary) fieldSummary.value = row.summary || '';
      if (fieldTags) fieldTags.value = tagsToText(row.tags);
      if (fieldContent) fieldContent.value = row.content_md || '';
      if (fieldStatus) fieldStatus.value = row.status || 'draft';
      if (formTitle) formTitle.textContent = '编辑：' + (row.title || '');
      if (saveBtn) saveBtn.textContent = '保存修改';
      if (previewBox) {
        previewBox.innerHTML = '';
        previewBox.setAttribute('hidden', '');
      }
      if (fieldContent) fieldContent.focus();
      /* 载入后检查是否有比云端更新的本机草稿 */
      checkAdminDraft();
      return row;
    });
  }

  function loadPosts() {
    return api(
      C.db().rpc('admin_posts_page', {
        p_search: postsState.search || null,
        p_status: postsState.status === 'all' ? null : postsState.status,
        p_limit: postsState.pageSize,
        p_offset: (postsState.page - 1) * postsState.pageSize,
      }),
      '文章列表加载失败'
    ).then(function (data) {
      var page = pageRows(data, '文章列表加载失败');
      var list = page.rows || [];
      var total = Number(page.total) || 0;
      var totalPages = Math.max(1, Math.ceil(total / postsState.pageSize));
      if (postsState.page > totalPages) {
        postsState.page = totalPages;
        return loadPosts();
      }
      postsState.total = total;
      allPosts = list;
      setText(postCountEl, total);
      if (postsBody) {
        var filtered = postsState.search || postsState.status !== 'all';
        postsBody.innerHTML = list.length
          ? list.map(postRow).join('')
          : '<tr><td colspan="5" class="admin-empty">' +
            (filtered ? '没有匹配的文章，换个关键词或状态试试。' : '还没有文章，用左边的编辑器写下第一篇。') +
            '</td></tr>';
      }
      bindPostActions(list);
      renderPager(postPagerEl, postsState, loadPosts);
      return list;
    });
  }

  function bindPostActions(list) {
    var bySlug = {};
    list.forEach(function (post) {
      bySlug[post.slug] = post;
    });

    qa('[data-post-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-post-edit');
        if (!bySlug[slug]) return;
        showPanel('posts');
        loadIntoEditor(slug)
          .then(function () {
            root.scrollIntoView({ behavior: 'smooth', block: 'start' });
          })
          .catch(function () { /* api() 已提示 */ });
      });
    });

    function setStatus(slug, status) {
      var patch = { status: status, updated_at: new Date().toISOString() };
      if (status === 'published') patch.published_at = new Date().toISOString();
      return api(C.db().from('cloud_posts').update(patch).eq('slug', slug).select(), '操作失败').then(function (rows) {
        if (!rows || !rows.length) throw new Error('没有权限或文章不存在');
        toast(status === 'published' ? '已发布' : '已转为草稿');
        return Promise.all([loadPosts(), loadStats(), loadReview()]);
      }).catch(function () {});
    }

    qa('[data-post-publish-row]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        setStatus(btn.getAttribute('data-post-publish-row'), 'published');
      });
    });
    qa('[data-post-unpublish]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        setStatus(btn.getAttribute('data-post-unpublish'), 'draft');
      });
    });
    qa('[data-post-delete]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-post-delete');
        if (!window.confirm('确定删除文章「' + slug + '」吗？删除后无法恢复。')) return;
        btn.disabled = true;
        api(C.db().from('cloud_posts').delete().eq('slug', slug).select(), '删除失败')
          .then(function (rows) {
            if (!rows || !rows.length) throw new Error('没有权限或文章不存在');
            toast('文章已删除');
            if (editingSlug === slug) resetForm();
            return Promise.all([loadPosts(), loadStats(), loadReview()]);
          })
          .catch(function () {});
      });
    });
  }

  /* ---------------- 内容审核 ---------------- */

  var REVIEW_VERB = { approve: '已通过并发布', reject: '已驳回', unpublish: '已下架为草稿' };

  function review(slug, action, note) {
    return api(
      C.db().rpc('admin_review_post', { p_slug: slug, p_action: action, p_note: note || null }),
      '审核操作失败'
    ).then(function (res) {
      var payload = res && typeof res === 'object' ? res : {};
      if (payload.ok !== true) throw new Error(payload.error || '审核未生效');
      toast(REVIEW_VERB[action] || '已处理');
      return Promise.all([loadPosts(), loadStats(), loadReview()]);
    });
  }

  function reviewRow(post) {
    var name = post.author_name || post.author_email || '未知作者';
    return (
      '<tr data-review-row="' + esc(post.slug) + '">' +
      '<td><div class="admin-cell__title">' + esc(post.title) + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(post.slug) + '</div>' +
      (post.summary ? '<div class="admin-cell__sub">' + esc(post.summary) + '</div>' : '') +
      '</td>' +
      '<td><div class="admin-cell__title">' + esc(name) + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(post.author_email || '') + '</div></td>' +
      '<td class="admin-cell__sub">' + esc(C.formatDateTime(post.updated_at || post.created_at)) + '</td>' +
      '<td class="admin-cell__sub">' + esc(String(post.body_length || 0)) + ' 字</td>' +
      '<td class="admin-cell__actions">' +
      '<button class="btn btn--primary btn--sm" type="button" data-review-approve="' + esc(post.slug) + '">通过</button>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-review-reject="' + esc(post.slug) + '">驳回</button>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-review-open="' + esc(post.slug) + '">查看</button>' +
      '<button class="btn btn--danger btn--sm" type="button" data-review-delete="' + esc(post.slug) + '">删除</button>' +
      '</td></tr>'
    );
  }

  function reviewedRow(post) {
    var name = post.author_name || post.author_email || '未知作者';
    var restartable = post.status === 'rejected';
    return (
      '<tr data-reviewed-row="' + esc(post.slug) + '">' +
      '<td><div class="admin-cell__title">' + esc(post.title) + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(post.slug) + '</div></td>' +
      '<td><div class="admin-cell__title">' + esc(name) + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(post.author_email || '') + '</div></td>' +
      '<td>' + statusBadge(post.status) +
      (post.review_note ? '<div class="admin-cell__sub">理由：' + esc(post.review_note) + '</div>' : '') +
      '</td>' +
      '<td class="admin-cell__sub">' + esc(C.formatDateTime(post.reviewed_at)) + '</td>' +
      '<td class="admin-cell__actions">' +
      (restartable
        ? '<button class="btn btn--primary btn--sm" type="button" data-review-approve="' + esc(post.slug) + '">通过</button>'
        : '<button class="btn btn--ghost btn--sm" type="button" data-review-unpublish="' + esc(post.slug) + '">下架</button>') +
      '<button class="btn btn--ghost btn--sm" type="button" data-review-open="' + esc(post.slug) + '">查看</button>' +
      '<button class="btn btn--danger btn--sm" type="button" data-review-delete="' + esc(post.slug) + '">删除</button>' +
      '</td></tr>'
    );
  }

  /**
   * 内容审核：待审与已处理各自单独分页拉取（不再复用文章列表的内存快照）。
   */
  function loadReview() {
    return Promise.all([
      api(
        C.db().rpc('admin_posts_page', {
          p_search: null,
          p_status: 'pending',
          p_limit: pendingState.pageSize,
          p_offset: (pendingState.page - 1) * pendingState.pageSize,
        }),
        '待审核列表加载失败'
      ),
      api(
        C.db().rpc('admin_posts_page', {
          p_search: null,
          p_status: 'reviewed',
          p_limit: reviewedState.pageSize,
          p_offset: (reviewedState.page - 1) * reviewedState.pageSize,
        }),
        '已处理列表加载失败'
      ),
    ]).then(function (results) {
      var pendingPage = pageRows(results[0], '待审核列表加载失败');
      var reviewedPage = pageRows(results[1], '已处理列表加载失败');
      var pending = pendingPage.rows || [];
      var handled = reviewedPage.rows || [];

      pendingState.total = Number(pendingPage.total) || 0;
      reviewedState.total = Number(reviewedPage.total) || 0;

      var pendingPages = Math.max(1, Math.ceil(pendingState.total / pendingState.pageSize));
      if (pendingState.page > pendingPages) {
        pendingState.page = pendingPages;
        return loadReview();
      }
      var reviewedPages = Math.max(1, Math.ceil(reviewedState.total / reviewedState.pageSize));
      if (reviewedState.page > reviewedPages) {
        reviewedState.page = reviewedPages;
        return loadReview();
      }

      setText(reviewCountEl, pendingState.total);
      setReviewBadge(pendingState.total);

      if (reviewBody) {
        reviewBody.innerHTML = pending.length
          ? pending.map(reviewRow).join('')
          : '<tr><td colspan="5" class="admin-empty">当前没有待审核的投稿。</td></tr>';
      }
      if (reviewedBody) {
        reviewedBody.innerHTML = handled.length
          ? handled.map(reviewedRow).join('')
          : '<tr><td colspan="5" class="admin-empty">还没有审核记录。</td></tr>';
      }
      bindReviewActions();
      renderPager(reviewPagerEl, pendingState, loadReview);
      renderPager(reviewedPagerEl, reviewedState, loadReview);
      return { pending: pendingState.total, reviewed: reviewedState.total };
    });
  }

  /** 在该行下方展开「驳回理由」输入行。 */
  function openRejectForm(slug, row) {
    var opened = q('[data-review-reject-form]');
    if (opened) opened.parentNode.removeChild(opened);
    var tr = document.createElement('tr');
    tr.setAttribute('data-review-reject-form', slug);
    tr.innerHTML =
      '<td colspan="5"><div class="review-reject">' +
      '<textarea class="field__input" rows="2" maxlength="200" data-review-note ' +
      'placeholder="驳回理由（会展示给作者，留空也可以）"></textarea>' +
      '<div class="review-reject__foot">' +
      '<button class="btn btn--danger btn--sm" type="button" data-review-reject-confirm="' + esc(slug) + '">确认驳回</button>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-review-reject-cancel>取消</button>' +
      '</div></div></td>';
    row.parentNode.insertBefore(tr, row.nextSibling);
    var textarea = tr.querySelector('[data-review-note]');
    if (textarea) textarea.focus();
    tr.querySelector('[data-review-reject-cancel]').addEventListener('click', function () {
      tr.parentNode.removeChild(tr);
    });
    tr.querySelector('[data-review-reject-confirm]').addEventListener('click', function (event) {
      var confirmBtn = event.currentTarget;
      confirmBtn.disabled = true;
      review(slug, 'reject', textarea ? textarea.value : '').catch(function () {
        confirmBtn.disabled = false;
      });
    });
  }

  function bindReviewActions() {
    qa('[data-review-approve]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-review-approve');
        btn.disabled = true;
        review(slug, 'approve').catch(function () { btn.disabled = false; });
      });
    });

    qa('[data-review-unpublish]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-review-unpublish');
        if (!window.confirm('确定把「' + slug + '」下架吗？\n下架后文章会退回草稿状态，前台立即不可见。')) return;
        btn.disabled = true;
        review(slug, 'unpublish').catch(function () { btn.disabled = false; });
      });
    });

    qa('[data-review-reject]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-review-reject');
        var row = btn.closest('[data-review-row]');
        if (row) openRejectForm(slug, row);
      });
    });

    qa('[data-review-open]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-review-open');
        showPanel('posts');
        loadIntoEditor(slug)
          .then(function (row) {
            if (!previewBox || !fieldContent) return;
            previewBox.removeAttribute('hidden');
            previewBox.innerHTML = window.WSBlogCloudMarkdown
              ? window.WSBlogCloudMarkdown.render(fieldContent.value)
              : '<p>' + esc(fieldContent.value).replace(/\n/g, '<br>') + '</p>';
            root.scrollIntoView({ behavior: 'smooth', block: 'start' });
            toast('已载入编辑器，可在此查看全文或直接修改');
            return row;
          })
          .catch(function () { /* api() 已提示 */ });
      });
    });

    qa('[data-review-delete]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-review-delete');
        if (!window.confirm('确定删除投稿「' + slug + '」吗？删除后无法恢复。')) return;
        btn.disabled = true;
        api(C.db().from('cloud_posts').delete().eq('slug', slug).select(), '删除失败')
          .then(function (rows) {
            if (!rows || !rows.length) throw new Error('没有权限或文章不存在');
            toast('投稿已删除');
            if (editingSlug === slug) resetForm();
            return Promise.all([loadPosts(), loadStats(), loadReview()]);
          })
          .catch(function () { btn.disabled = false; });
      });
    });
  }

  /* ---------------- 评论管理 ---------------- */

  function commentRow(item) {
    var hidden = item.status && item.status !== 'visible';
    var parentReply = '';
    if (item.parent_id) {
      /* 父评论可能不在当前页，服务端已把父评论作者名一并带出来 */
      var parentName = item.parent_author || null;
      if (!parentName) {
        var parent = (allComments || []).find(function (row) { return row.id === item.parent_id; });
        parentName = (parent && parent.author_name) || '#' + item.parent_id;
      }
      parentReply = '<div class="admin-cell__sub">↩ 回复 @' + esc(parentName) + '</div>';
    }
    return (
      '<tr data-comment-row="' + esc(item.id) + '">' +
      '<td><div class="admin-cell__title">' + esc(item.author_name || '匿名读者') + '</div>' +
      parentReply +
      '<div class="admin-cell__sub mono">' + esc(item.post_slug) + '</div></td>' +
      '<td class="admin-cell__text">' + esc(item.content) + '</td>' +
      '<td class="admin-cell__sub">' + esc(C.formatDateTime(item.created_at)) + '</td>' +
      '<td>' + (hidden ? '<span class="status-badge status-badge--hidden">已隐藏</span>' : '<span class="status-badge status-badge--visible">显示中</span>') + '</td>' +
      '<td class="admin-cell__actions">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-comment-toggle="' + esc(item.id) + '" data-next="' + (hidden ? 'visible' : 'hidden') + '">' +
      (hidden ? '恢复' : '隐藏') + '</button>' +
      '<button class="btn btn--danger btn--sm" type="button" data-comment-remove="' + esc(item.id) + '">删除</button>' +
      '</td></tr>'
    );
  }

  function renderComments() {
    if (!commentsBody) return;
    var list = allComments || [];
    var filtered = commentsState.search || commentsState.status !== 'all';
    commentsBody.innerHTML = list.length
      ? list.map(commentRow).join('')
      : '<tr><td colspan="5" class="admin-empty">' +
        (filtered ? '这个筛选下没有评论。' : '还没有评论。') + '</td></tr>';
    bindCommentActions();
  }

  function bindCommentActions() {
    qa('[data-comment-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        api(
          C.db().from('comments').update({ status: btn.getAttribute('data-next') }).eq('id', btn.getAttribute('data-comment-toggle')).select(),
          '操作失败'
        ).then(function (rows) {
          if (!rows || !rows.length) throw new Error('没有权限或评论不存在');
          toast('已更新评论状态');
          return Promise.all([loadComments(), loadStats()]);
        }).catch(function () {});
      });
    });

    qa('[data-comment-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.confirm('确定删除这条评论吗？')) return;
        btn.disabled = true;
        api(C.db().from('comments').delete().eq('id', btn.getAttribute('data-comment-remove')).select(), '删除失败')
          .then(function (rows) {
            if (!rows || !rows.length) throw new Error('没有权限或评论不存在');
            toast('评论已删除');
            return Promise.all([loadComments(), loadStats()]);
          })
          .catch(function () {});
      });
    });
  }

  function loadComments() {
    return api(
      C.db().rpc('admin_comments_page', {
        p_search: commentsState.search || null,
        p_status: commentsState.status === 'all' ? null : commentsState.status,
        p_limit: commentsState.pageSize,
        p_offset: (commentsState.page - 1) * commentsState.pageSize,
      }),
      '评论加载失败'
    ).then(function (data) {
      var page = pageRows(data, '评论加载失败');
      var list = page.rows || [];
      var total = Number(page.total) || 0;
      var totalPages = Math.max(1, Math.ceil(total / commentsState.pageSize));
      if (commentsState.page > totalPages) {
        commentsState.page = totalPages;
        return loadComments();
      }
      commentsState.total = total;
      allComments = list;
      setText(commentCountEl, total);
      renderComments();
      renderPager(commentPagerEl, commentsState, loadComments);
      return list;
    });
  }

  qa('[data-comment-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      commentsState.status = btn.getAttribute('data-comment-filter') || 'all';
      commentsState.page = 1;
      qa('[data-comment-filter]').forEach(function (other) {
        other.classList.toggle('is-active', other === btn);
      });
      loadComments();
    });
  });

  /* ---------------- 用户管理 ---------------- */

  /** 复制一段给用户看的重置指引（剪贴板不可用时退回到临时 textarea）。 */
  function copyText(text) {
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      document.body.removeChild(area);
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallback();
      });
    }
    return Promise.resolve(fallback());
  }

  function resetGuide(user) {
    var origin = location.origin + '/';
    return (
      '【密码重置指引】\n' +
      '账号：' + (user.email || '') + '\n' +
      '请打开 ' + origin + 'login.html 点击「忘记密码」，' +
      '用该邮箱获取验证码后设置新密码。\n' +
      '（密码由云平台加密托管，管理员无法直接查看或代改。）'
    );
  }

  function userRow(user) {
    var uid = user.owner_id || '';
    var email = user.email || '';
    var disabled = user.status === 'disabled';
    var name = user.nickname || (email ? email.split('@')[0] : '未命名');
    var avatar = user.avatar_url
      ? '<img class="admin-avatar" src="' + esc(user.avatar_url) + '" alt="" loading="lazy">'
      : '<span class="admin-avatar admin-avatar--text">' + esc(name.slice(0, 1).toUpperCase()) + '</span>';

    var statusBadge = disabled
      ? '<span class="status-badge status-badge--hidden">已禁用</span>'
      : '<span class="status-badge status-badge--published">正常</span>';
    var roleBadge = user.is_admin
      ? '<span class="status-badge status-badge--admin">管理员</span>'
      : '<span class="status-badge">普通用户</span>';

    var actions;
    if (user.is_self) {
      actions = '<span class="admin-cell__sub">当前登录账号</span>';
    } else {
      actions =
        '<button class="btn btn--ghost btn--sm" type="button" data-user-status="' + esc(uid) +
        '" data-next="' + (disabled ? 'active' : 'disabled') + '">' + (disabled ? '启用' : '禁用') + '</button>' +
        '<button class="btn btn--ghost btn--sm" type="button" data-user-admin="' + esc(email) +
        '" data-next="' + (user.is_admin ? 'remove' : 'add') + '">' +
        (user.is_admin ? '取消管理员' : '设为管理员') + '</button>' +
        '<button class="btn btn--ghost btn--sm" type="button" data-user-reset="' + esc(email) + '">重置密码</button>' +
        '<button class="btn btn--danger btn--sm" type="button" data-user-delete="' + esc(uid) +
        '" data-name="' + esc(name) + '">删除用户</button>';
    }

    return (
      '<tr data-user-row="' + esc(uid) + '">' +
      '<td><div class="admin-cell__user">' + avatar +
      '<div><div class="admin-cell__title">' + esc(name) +
      (user.is_self ? ' <span class="admin-tag">我</span>' : '') + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(uid) + '</div></div></div></td>' +
      '<td class="admin-cell__sub mono">' + esc(email || '—') + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td>' + roleBadge + '</td>' +
      '<td class="admin-cell__sub">' + esc(String(user.comment_count || 0)) + ' 评论 · ' +
      esc(String(user.like_count || 0)) + ' 点赞</td>' +
      '<td class="admin-cell__sub">' + esc(C.formatDate(user.created_at)) + '</td>' +
      '<td class="admin-cell__actions">' + actions + '</td>' +
      '</tr>'
    );
  }

  function loadUsers() {
    return api(
      C.db().rpc('admin_users_page', {
        p_search: usersState.search || null,
        p_status: usersState.status === 'all' ? null : usersState.status,
        p_limit: usersState.pageSize,
        p_offset: (usersState.page - 1) * usersState.pageSize,
      }),
      '用户列表加载失败'
    ).then(function (data) {
      var page = pageRows(data, '用户列表加载失败');
      var list = page.rows || [];
      var total = Number(page.total) || 0;
      var totalPages = Math.max(1, Math.ceil(total / usersState.pageSize));
      if (usersState.page > totalPages) {
        usersState.page = totalPages;
        return loadUsers();
      }
      usersState.total = total;
      allUsers = list;
      if (!usersBody) return list;
      var filtered = usersState.search || usersState.status !== 'all';
      usersBody.innerHTML = list.length
        ? list.map(userRow).join('')
        : '<tr><td colspan="7" class="admin-empty">' +
          (filtered ? '没有匹配的账号。' : '还没有用户注册。') + '</td></tr>';
      bindUserActions(list);
      renderPager(userPagerEl, usersState, loadUsers);
      return list;
    });
  }

  function bindUserActions(list) {
    qa('[data-user-status]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-user-status');
        var next = btn.getAttribute('data-next');
        var label = next === 'disabled' ? '禁用' : '启用';
        if (next === 'disabled' && !window.confirm('确定禁用该账号吗？\n禁用后该用户仍能登录浏览，但无法评论、点赞、收藏或修改资料。')) return;
        btn.disabled = true;
        api(C.db().rpc('admin_set_user_status', { p_owner: uid, p_status: next }), label + '失败')
          .then(function (ok) {
            if (ok !== true) throw new Error('操作未生效（不能对自己操作）');
            toast('已' + label + '该账号');
            return Promise.all([loadUsers(), loadStats()]);
          })
          .catch(function () {})
          .then(function () {
            btn.disabled = false;
          });
      });
    });

    qa('[data-user-admin]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var email = btn.getAttribute('data-user-admin');
        var next = btn.getAttribute('data-next');
        var promote = next === 'add';
        if (!window.confirm(
          promote
            ? '把 ' + email + ' 设为管理员？\n对方下次登录后即可进入后台。'
            : '取消 ' + email + ' 的管理员权限？'
        )) return;
        btn.disabled = true;
        var call = promote
          ? C.db().rpc('admin_add_email', { p_email: email, p_note: '后台直接授权' })
          : C.db().rpc('admin_remove_email', { p_email: email });
        api(call, promote ? '设置失败' : '取消失败')
          .then(function () {
            toast(promote ? '已设为管理员' : '已取消管理员');
            return Promise.all([loadUsers(), loadEmails()]);
          })
          .catch(function () {})
          .then(function () {
            btn.disabled = false;
          });
      });
    });

    qa('[data-user-reset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var email = btn.getAttribute('data-user-reset');
        var user = (allUsers || []).find(function (row) {
          return row.email === email;
        }) || { email: email };
        copyText(resetGuide(user)).then(function (ok) {
          toast(ok ? '重置指引已复制，可发给该用户' : '复制失败，请手动告知用户走「忘记密码」');
        });
      });
    });

    qa('[data-user-delete]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-user-delete');
        var name = btn.getAttribute('data-name') || uid;
        if (!window.confirm(
          '确定删除用户「' + name + '」吗？\n\n将删除他/她的全部评论、点赞与收藏，并清空个人资料、禁用账号。\n' +
          '（云平台上的登录账号本身无法删除，如需彻底注销请联系平台。）'
        )) return;
        btn.disabled = true;
        api(C.db().rpc('admin_delete_user', { p_owner: uid }), '删除失败')
          .then(function (ok) {
            if (ok !== true) throw new Error('操作未生效（不能删除自己）');
            toast('用户内容已清空并禁用');
            return Promise.all([loadUsers(), loadStats(), loadComments()]);
          })
          .catch(function () {})
          .then(function () {
            btn.disabled = false;
          });
      });
    });
  }

  /* ---------------- 管理员邮箱白名单 ---------------- */

  function loadEmails() {
    return api(C.db().rpc('admin_list_emails'), '白名单加载失败').then(function (rows) {
      var list = rows || [];
      if (!emailsBody) return list;
      emailsBody.innerHTML = list.length
        ? list.map(function (item) {
            return (
              '<tr data-email-row="' + esc(item.email) + '">' +
              '<td class="mono">' + esc(item.email) + '</td>' +
              '<td class="admin-cell__sub">' + esc(item.note || '—') + '</td>' +
              '<td class="admin-cell__sub">' + esc(C.formatDate(item.created_at)) + '</td>' +
              '<td class="admin-cell__actions">' +
              '<button class="btn btn--danger btn--sm" type="button" data-email-remove="' + esc(item.email) + '">移除</button>' +
              '</td></tr>'
            );
          }).join('')
        : '<tr><td colspan="4" class="admin-empty">白名单还是空的。加上你的邮箱后就可以用管理员身份登录了。</td></tr>';

      qa('[data-email-remove]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var email = btn.getAttribute('data-email-remove');
          if (!window.confirm('确定移除 ' + email + ' 的管理员权限吗？')) return;
          btn.disabled = true;
          api(C.db().rpc('admin_remove_email', { p_email: email }), '移除失败')
            .then(function () {
              toast('已移除');
              return loadEmails();
            })
            .catch(function () {});
        });
      });
      return list;
    });
  }

  if (emailAddBtn) {
    emailAddBtn.addEventListener('click', function () {
      var email = (emailInput && emailInput.value || '').trim();
      if (!email || email.indexOf('@') < 1) {
        toast('请填写有效的邮箱');
        if (emailInput) emailInput.focus();
        return;
      }
      emailAddBtn.disabled = true;
      api(C.db().rpc('admin_add_email', { p_email: email, p_note: (emailNote && emailNote.value || '').trim() || null }), '添加失败')
        .then(function () {
          toast('已加入管理员白名单');
          if (emailInput) emailInput.value = '';
          if (emailNote) emailNote.value = '';
          return loadEmails();
        })
        .catch(function () {})
        .then(function () {
          emailAddBtn.disabled = false;
        });
    });
  }

  /* ---------------- 统一刷新 ---------------- */

  function refreshAll() {
    return Promise.all([
      loadStats(),
      loadPosts(),
      loadReview(),
      loadComments(),
      loadUsers(),
      loadEmails(),
    ]);
  }

  var refreshBtn = q('[data-admin-refresh]');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshBtn.disabled = true;
      refreshAll().then(function () {
        toast('已刷新');
        refreshBtn.disabled = false;
      }).catch(function () {
        refreshBtn.disabled = false;
      });
    });
  }

  /* ---------------- 搜索 / 筛选接线 ---------------- */

  bindSearch(postSearchEl, postsState, loadPosts);
  bindSelect(postStatusEl, postsState, loadPosts);
  bindSearch(commentSearchEl, commentsState, loadComments);
  bindSearch(userSearchEl, usersState, loadUsers);
  bindSelect(userStatusEl, usersState, loadUsers);

  /* ---------------- 启动 ---------------- */

  resetForm();

  C.booted().then(function () {
    if (!C.guardAdmin()) return;
    setupAdminDraft();
    showPanel('posts');
    refreshAll();
    syncSlugs();
  });
})();
