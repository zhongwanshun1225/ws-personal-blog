/**
 * 管理员后台。
 *
 * 四个面板：文章管理（在线写 / 编辑 / 发布 / 删除）、评论管理（隐藏 / 恢复 / 删除）、
 * 用户列表、管理员邮箱白名单。
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
  var previewBox = q('[data-post-preview-box]');
  var postsBody = q('[data-admin-posts]');
  var postCountEl = q('[data-post-count]');
  var usersBody = q('[data-admin-users]');
  var commentsBody = q('[data-admin-comments]');
  var commentCountEl = q('[data-comment-total]');
  var emailsBody = q('[data-admin-emails]');
  var emailInput = q('[data-admin-email-input]');
  var emailNote = q('[data-admin-email-note]');
  var emailAddBtn = q('[data-admin-email-add]');

  var busy = false;
  var editingSlug = '';
  var allComments = [];
  var commentFilter = 'all';

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
  }

  qa('[data-admin-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      showPanel(btn.getAttribute('data-admin-tab'));
    });
  });

  /* ---------------- 概览数据 ---------------- */

  function loadStats() {
    return api(C.db().rpc('admin_stats'), '概览数据加载失败').then(function (data) {
      var stats = data && typeof data === 'object' ? data : {};
      setText(q('[data-stat-users]'), stats.users || 0);
      setText(q('[data-stat-comments]'), stats.comments || 0);
      setText(q('[data-stat-hidden]'), stats.hidden || 0);
      setText(q('[data-stat-likes]'), stats.likes || 0);
      setText(q('[data-stat-posts]'), stats.posts || 0);
      setText(q('[data-stat-drafts]'), stats.drafts || 0);
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
        resetForm();
        return Promise.all([loadPosts(), loadStats()]);
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
  if (resetBtn) resetBtn.addEventListener('click', resetForm);

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

  function postRow(post) {
    var isPublished = post.status === 'published';
    var badge = isPublished
      ? '<span class="status-badge" data-status="published">已发布</span>'
      : '<span class="status-badge" data-status="draft">草稿</span>';
    return (
      '<tr data-post-row="' + esc(post.slug) + '">' +
      '<td><div class="admin-cell__title">' + esc(post.title) + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(post.slug) + '</div></td>' +
      '<td>' + badge + '</td>' +
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

  function loadPosts() {
    return api(
      C.db().from('cloud_posts').select('id, slug, title, status, updated_at, created_at').order('updated_at', { ascending: false }).limit(200),
      '文章列表加载失败'
    ).then(function (rows) {
      var list = rows || [];
      setText(postCountEl, list.length);
      if (!postsBody) return list;
      postsBody.innerHTML = list.length
        ? list.map(postRow).join('')
        : '<tr><td colspan="4" class="admin-empty">还没有文章，用左边的编辑器写下第一篇。</td></tr>';
      bindPostActions(list);
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
        var post = bySlug[btn.getAttribute('data-post-edit')];
        if (!post) return;
        editingSlug = post.slug;
        api(C.db().from('cloud_posts').select('title, slug, summary, tags, content_md, status').eq('slug', post.slug).maybeSingle(), '读取文章失败')
          .then(function (row) {
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
        return Promise.all([loadPosts(), loadStats()]);
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
            return Promise.all([loadPosts(), loadStats()]);
          })
          .catch(function () {});
      });
    });
  }

  /* ---------------- 评论管理 ---------------- */

  function commentRow(item) {
    var hidden = item.status && item.status !== 'visible';
    return (
      '<tr data-comment-row="' + esc(item.id) + '">' +
      '<td><div class="admin-cell__title">' + esc(item.author_name || '匿名读者') + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(item.post_slug) + '</div></td>' +
      '<td class="admin-cell__text">' + esc(item.content) + '</td>' +
      '<td class="admin-cell__sub">' + esc(C.formatDateTime(item.created_at)) + '</td>' +
      '<td>' + (hidden ? '<span class="status-badge" data-status="hidden">已隐藏</span>' : '<span class="status-badge" data-status="published">显示中</span>') + '</td>' +
      '<td class="admin-cell__actions">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-comment-toggle="' + esc(item.id) + '" data-next="' + (hidden ? 'visible' : 'hidden') + '">' +
      (hidden ? '恢复' : '隐藏') + '</button>' +
      '<button class="btn btn--danger btn--sm" type="button" data-comment-remove="' + esc(item.id) + '">删除</button>' +
      '</td></tr>'
    );
  }

  function renderComments() {
    if (!commentsBody) return;
    var list = allComments.filter(function (item) {
      if (commentFilter === 'all') return true;
      var hidden = item.status && item.status !== 'visible';
      return commentFilter === 'hidden' ? hidden : !hidden;
    });
    commentsBody.innerHTML = list.length
      ? list.map(commentRow).join('')
      : '<tr><td colspan="5" class="admin-empty">' + (allComments.length ? '这个筛选下没有评论。' : '还没有评论。') + '</td></tr>';
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
      C.db().from('comments').select('id, post_slug, author_name, content, status, created_at').order('created_at', { ascending: false }).limit(300),
      '评论加载失败'
    ).then(function (rows) {
      allComments = rows || [];
      setText(commentCountEl, allComments.length);
      renderComments();
      return allComments;
    });
  }

  qa('[data-comment-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      commentFilter = btn.getAttribute('data-comment-filter') || 'all';
      qa('[data-comment-filter]').forEach(function (other) {
        other.classList.toggle('is-active', other === btn);
      });
      renderComments();
    });
  });

  /* ---------------- 用户列表 ---------------- */

  function loadUsers() {
    return api(C.db().rpc('admin_users'), '用户列表加载失败').then(function (rows) {
      var list = rows || [];
      if (!usersBody) return list;
      usersBody.innerHTML = list.length
        ? list.map(function (user) {
            return (
              '<tr>' +
              '<td><div class="admin-cell__title">' + esc(user.nickname || '未命名') + '</div>' +
              '<div class="admin-cell__sub mono">' + esc(user.owner_id) + '</div></td>' +
              '<td class="admin-cell__text">' + esc(user.bio || '—') + '</td>' +
              '<td class="admin-cell__sub">' + esc(String(user.comment_count || 0)) + ' 条评论 / ' + esc(String(user.like_count || 0)) + ' 次点赞</td>' +
              '<td class="admin-cell__sub">' + esc(C.formatDate(user.created_at)) + '</td>' +
              '</tr>'
            );
          }).join('')
        : '<tr><td colspan="4" class="admin-empty">还没有用户注册。</td></tr>';
      return list;
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
    return Promise.all([loadStats(), loadPosts(), loadComments(), loadUsers(), loadEmails()]);
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

  /* ---------------- 启动 ---------------- */

  resetForm();

  C.booted().then(function () {
    if (!C.guardAdmin()) return;
    showPanel('posts');
    refreshAll();
  });
})();
