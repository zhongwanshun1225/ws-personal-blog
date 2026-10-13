/**
 * 用户投稿页。
 *
 * 普通登录用户在这里写文章，只能落成 draft（草稿）或 pending（待审核）两种状态 ——
 * 想直接写 published 会被数据库的 RLS 策略拒绝，审核权只属于管理员。
 *
 * 状态流转：
 *   draft ──提交审核──▶ pending ──管理员通过──▶ published（前台可见，作者只读）
 *                        └──管理员驳回──▶ rejected（附理由，作者改完可再投）
 *
 * 已发布的文章在本页只读：RLS 的 posts_own_update 明确禁止作者改 published 行。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var root = document.querySelector('[data-write]');
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
  var saveBtn = q('[data-post-save]');
  var submitBtn = q('[data-post-submit]');
  var resetBtn = q('[data-post-reset]');
  var previewBtn = q('[data-post-preview]');
  var imageBtn = q('[data-post-image]');
  var previewBox = q('[data-post-preview-box]');
  var noteBox = q('[data-write-note]');
  var listEl = q('[data-my-posts]');
  var countEl = q('[data-my-post-count]');

  var busy = false;
  var editingSlug = '';
  var editingStatus = '';
  var myPosts = [];

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
      .map(function (item) { return item.trim(); })
      .filter(Boolean);
  }

  function tagsToText(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'string') {
      return value.replace(/^\{|\}$/g, '').replace(/["']/g, '')
        .split(',').map(function (s) { return s.trim(); }).filter(Boolean).join(', ');
    }
    return '';
  }

  function setText(node, value) {
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function postUrl(slug) {
    return 'post.html?slug=' + encodeURIComponent(slug);
  }

  function slugParam() {
    var match = /[?&]slug=([^&]+)/.exec(location.search || '');
    return match ? decodeURIComponent(match[1]) : '';
  }

  /* ---------------- 提示条 ---------------- */

  function renderNote(status, note) {
    if (!noteBox) return;
    var html = '';
    if (status === 'pending') {
      html = '<strong>等待站长审核。</strong>审核通过后文章会出现在前台；在此之前你仍然可以修改，改完记得重新提交。';
    } else if (status === 'rejected') {
      html = '<strong>这篇投稿没有通过。</strong>' +
        (note ? '站长给的理由：' + esc(note) : '站长没有填写理由。') +
        ' 修改之后可以重新提交审核。';
    } else if (status === 'published') {
      html = '<strong>这篇已经发布了。</strong>已发布的文章不能在这里修改，需要改动请联系站长先下架。';
    }
    if (!html) {
      noteBox.setAttribute('hidden', '');
      noteBox.innerHTML = '';
      return;
    }
    noteBox.className = 'write-note' + (status === 'rejected' ? ' write-note--danger' : '');
    noteBox.innerHTML = html;
    noteBox.removeAttribute('hidden');
  }

  /* ---------------- 编辑器 ---------------- */

  function setFormLocked(locked) {
    [fieldTitle, fieldSlug, fieldSummary, fieldTags, fieldContent].forEach(function (el) {
      if (el) el.disabled = locked;
    });
    [saveBtn, submitBtn, resetBtn, imageBtn].forEach(function (btn) {
      if (btn) btn.disabled = locked;
    });
  }

  function resetForm() {
    editingSlug = '';
    editingStatus = '';
    if (form) form.reset();
    if (formTitle) formTitle.textContent = '新建投稿';
    if (previewBox) {
      previewBox.innerHTML = '';
      previewBox.setAttribute('hidden', '');
    }
    if (submitBtn) submitBtn.textContent = '提交审核';
    setFormLocked(false);
    renderNote('');
    if (history.replaceState) history.replaceState(null, '', 'write.html');
  }

  function loadIntoEditor(slug) {
    return C.db()
      .from('cloud_posts')
      .select('title, slug, summary, tags, content_md, status, review_note')
      .eq('slug', slug)
      .maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var row = res && res.data;
        if (!row) throw new Error('找不到这篇投稿，可能已被删除');
        editingSlug = row.slug;
        editingStatus = row.status || 'draft';
        if (fieldTitle) fieldTitle.value = row.title || '';
        if (fieldSlug) fieldSlug.value = row.slug || '';
        if (fieldSummary) fieldSummary.value = row.summary || '';
        if (fieldTags) fieldTags.value = tagsToText(row.tags);
        if (fieldContent) fieldContent.value = row.content_md || '';
        if (formTitle) formTitle.textContent = '编辑：' + (row.title || '');
        if (previewBox) {
          previewBox.innerHTML = '';
          previewBox.setAttribute('hidden', '');
        }
        var locked = editingStatus === 'published';
        setFormLocked(locked);
        renderNote(editingStatus, row.review_note);
        if (locked && submitBtn) submitBtn.textContent = '已发布';
        return row;
      });
  }

  function readForm(status) {
    return {
      title: (fieldTitle && fieldTitle.value || '').trim(),
      slug: slugify((fieldSlug && fieldSlug.value) || (fieldTitle && fieldTitle.value) || ''),
      summary: (fieldSummary && fieldSummary.value || '').trim(),
      tags: tagsToArray(fieldTags && fieldTags.value),
      content_md: (fieldContent && fieldContent.value) || '',
      status: status,
      updated_at: new Date().toISOString(),
    };
  }

  function save(status) {
    if (busy) return;
    if (C.requireLogin()) return;
    if (C.requireActive()) return;

    var data = readForm(status);
    if (!data.title) {
      toast('先写个标题吧');
      if (fieldTitle) fieldTitle.focus();
      return;
    }
    if (!data.content_md.trim()) {
      toast('正文还是空的');
      if (fieldContent) fieldContent.focus();
      return;
    }

    busy = true;
    if (saveBtn) saveBtn.disabled = true;
    if (submitBtn) submitBtn.disabled = true;

    var request;
    if (editingSlug) {
      request = C.db().from('cloud_posts').update(data).eq('slug', editingSlug).select();
    } else {
      data.author_id = C.currentUid() || undefined;
      request = C.db().from('cloud_posts').insert(data).select();
    }

    return request
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = res && res.data;
        if (!rows || !rows.length) throw new Error('保存失败：数据库没有返回记录（可能没有权限）');
        editingSlug = rows[0].slug;
        editingStatus = status;
        toast(status === 'pending' ? '已提交审核，等待站长确认' : '草稿已保存');
        if (history.replaceState) {
          history.replaceState(null, '', 'write.html?slug=' + encodeURIComponent(editingSlug));
        }
        renderNote(status, '');
        if (formTitle) formTitle.textContent = '编辑：' + (data.title || '');
        setFormLocked(false);
        return loadMine();
      })
      .catch(function (err) {
        var msg = (err && (err.message || err.error_description)) || '保存失败';
        if (/duplicate|23505|unique/i.test(msg)) {
          msg = '这个短链（slug）已经被占用了，换一个再试';
        }
        toast(msg);
      })
      .then(function () {
        busy = false;
        if (saveBtn) saveBtn.disabled = false;
        if (submitBtn) submitBtn.disabled = false;
      });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      if (editingStatus === 'pending') {
        toast('已撤回为草稿，改完记得重新提交');
      }
      save('draft');
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      if (editingStatus === 'published') {
        toast('已发布的文章不能重复提交');
        return;
      }
      save('pending');
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (fieldTitle && (fieldTitle.value || (fieldContent && fieldContent.value))) {
        if (!window.confirm('清空当前表单？未保存的内容会丢失。')) return;
      }
      resetForm();
    });
  }

  /* ---------------- 图片与预览 ---------------- */

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

  var imageBusy = false;
  if (imageBtn) {
    imageBtn.addEventListener('click', function () {
      if (C.requireActive()) return;
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
      if (!previewBox.hasAttribute('hidden')) {
        previewBox.setAttribute('hidden', '');
        return;
      }
      previewBox.removeAttribute('hidden');
      previewBox.innerHTML = window.WSBlogCloudMarkdown
        ? window.WSBlogCloudMarkdown.render(text)
        : '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
    });
  }

  /* ---------------- 我的投稿 ---------------- */

  function mineRow(post) {
    var meta = STATUS_META[post.status] || {};
    var timeLabel = post.status === 'published'
      ? '发布于 ' + C.formatDate(post.published_at || post.updated_at)
      : '更新于 ' + C.formatDate(post.updated_at || post.created_at);
    var isPending = post.status === 'pending';
    var isPublished = post.status === 'published';

    return (
      '<li class="stack-item" data-my-post-row="' + esc(post.slug) + '">' +
      '<div class="stack-item__head">' +
      '<span class="stack-item__title">' + esc(post.title) + '</span>' +
      statusBadge(post.status) +
      '<span class="stack-item__time">' + esc(timeLabel) + '</span>' +
      '</div>' +
      '<div class="stack-item__text mono">' + esc(post.slug) + '</div>' +
      (post.status === 'rejected' && post.review_note
        ? '<p class="stack-item__note">未通过理由：' + esc(post.review_note) + '</p>'
        : '') +
      '<div class="stack-item__actions">' +
      (isPublished
        ? '<a class="link-btn" href="' + esc(postUrl(post.slug)) + '">阅读</a>'
        : '<button class="link-btn" type="button" data-my-post-edit="' + esc(post.slug) + '">编辑</button>') +
      (isPending
        ? '<button class="link-btn" type="button" data-my-post-withdraw="' + esc(post.slug) + '">撤回</button>'
        : '') +
      (isPublished
        ? ''
        : '<button class="link-btn link-btn--danger" type="button" data-my-post-delete="' + esc(post.slug) + '">删除</button>') +
      '</div>' +
      '</li>'
    );
  }

  function bindMine() {
    qa('[data-my-post-edit]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-my-post-edit');
        loadIntoEditor(slug)
          .then(function () {
            if (fieldTitle) fieldTitle.focus();
            root.scrollIntoView({ behavior: 'smooth', block: 'start' });
          })
          .catch(function (err) {
            toast((err && err.message) || '打不开这篇投稿');
          });
      });
    });

    qa('[data-my-post-withdraw]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-my-post-withdraw');
        btn.disabled = true;
        C.db().from('cloud_posts')
          .update({ status: 'draft', updated_at: new Date().toISOString() })
          .eq('slug', slug).select()
          .then(function (res) {
            if (res && res.error) throw res.error;
            toast('已撤回为草稿');
            if (editingSlug === slug) loadIntoEditor(slug);
            return loadMine();
          })
          .catch(function (err) {
            toast((err && err.message) || '撤回失败');
            btn.disabled = false;
          });
      });
    });

    qa('[data-my-post-delete]', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-my-post-delete');
        if (!window.confirm('确定删除投稿「' + slug + '」吗？删除后无法恢复。')) return;
        btn.disabled = true;
        C.db().from('cloud_posts').delete().eq('slug', slug).select()
          .then(function (res) {
            if (res && res.error) throw res.error;
            toast('投稿已删除');
            if (editingSlug === slug) resetForm();
            return loadMine();
          })
          .catch(function (err) {
            toast((err && err.message) || '删除失败');
            btn.disabled = false;
          });
      });
    });
  }

  function loadMine() {
    var uid = C.currentUid();
    if (!uid) return Promise.resolve([]);
    return C.db()
      .from('cloud_posts')
      .select('slug, title, status, review_note, created_at, updated_at, published_at')
      .eq('author_id', uid)
      .order('updated_at', { ascending: false })
      .limit(50)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var list = (res && res.data) || [];
        myPosts = list;
        setText(countEl, list.length);
        if (listEl) {
          listEl.innerHTML = list.length
            ? list.map(mineRow).join('')
            : '<li class="stack-empty">还没有投稿，写一篇试试。</li>';
        }
        bindMine();
        return list;
      })
      .catch(function (err) {
        console.warn('[write] 我的投稿加载失败', err && err.message);
        if (listEl) listEl.innerHTML = '<li class="stack-empty">投稿列表加载失败，请刷新重试。</li>';
        return [];
      });
  }

  /* ---------------- 启动 ---------------- */

  C.booted().then(function () {
    if (C.requireLogin()) return;
    var slug = slugParam();
    var chain = slug
      ? loadIntoEditor(slug).catch(function (err) {
          toast((err && err.message) || '这篇投稿打不开');
          resetForm();
        })
      : Promise.resolve(null);
    chain.then(function () {
      return loadMine();
    });
  });
})();
