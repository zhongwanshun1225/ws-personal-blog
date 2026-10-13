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
  var draftBanner = q('[data-draft-banner]');
  var draftBannerText = q('[data-draft-banner-text]');
  var draftRestoreBtn = q('[data-draft-restore]');
  var draftDiscardBtn = q('[data-draft-discard]');
  var statusEl = q('[data-write-status]');

  var busy = false;
  var editingSlug = '';
  var editingStatus = '';
  var myPosts = [];

  /* 本地草稿控制器（draft.js 注入；脚本缺失时退化为不自动保存） */
  var draftCtrl = null;
  var pendingDraft = null;
  var DRAFT_NS = 'write';

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

  /* ---------------- 本地草稿（自动保存 / 恢复） ---------------- */

  function draftKeyNow() {
    return window.WSBlogDraft
      ? window.WSBlogDraft.key(DRAFT_NS, editingSlug)
      : '';
  }

  function collectDraft() {
    return {
      title: (fieldTitle && fieldTitle.value) || '',
      slug: (fieldSlug && fieldSlug.value) || '',
      summary: (fieldSummary && fieldSummary.value) || '',
      tags: (fieldTags && fieldTags.value) || '',
      content_md: (fieldContent && fieldContent.value) || '',
    };
  }

  function draftEmpty(data) {
    return !(
      String(data.title || '').trim() || String(data.content_md || '').trim()
    );
  }

  function setStatus(text, level) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.setAttribute('data-level', level || 'idle');
  }

  function setupDraft() {
    if (!window.WSBlogDraft || draftCtrl) return;
    draftCtrl = window.WSBlogDraft.attach({
      form: form,
      keyFn: draftKeyNow,
      collect: collectDraft,
      isEmpty: draftEmpty,
      onStatus: setStatus,
    });
  }

  function formatWhen(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function hideDraftBanner() {
    pendingDraft = null;
    if (draftBanner) draftBanner.setAttribute('hidden', '');
  }

  function showDraftBanner(data) {
    pendingDraft = data;
    if (!draftBanner) return;
    var title = String(data.title || '').trim() || '（未命名）';
    var size = String(data.content_md || '').length;
    if (draftBannerText) {
      draftBannerText.textContent =
        '检测到本机保存的草稿「' + title + '」（' + size + ' 字，' +
        formatWhen(data.savedAt) + '），比云端版本更新。要恢复吗？';
    }
    draftBanner.removeAttribute('hidden');
  }

  /**
   * 检查本地草稿是否值得提示恢复。
   * cloudRow 为云端已加载的记录（新建时传 null）。
   * 判断依据：本地 savedAt 晚于云端 updated_at，且内容确实不同。
   */
  function checkLocalDraft(cloudRow) {
    if (!window.WSBlogDraft || !form) return;
    var key = draftKeyNow();
    if (!key) return;
    var data = window.WSBlogDraft.read(key);
    hideDraftBanner();
    if (!data || draftEmpty(data)) {
      if (data) window.WSBlogDraft.remove(key);
      return;
    }
    var localAt = Date.parse(data.savedAt || '');
    var cloudAt = cloudRow && cloudRow.updated_at ? Date.parse(cloudRow.updated_at) : NaN;
    if (!isNaN(cloudAt) && !isNaN(localAt) && localAt <= cloudAt) {
      /* 云端才是最新的，本地只是旧影子 */
      window.WSBlogDraft.remove(key);
      return;
    }
    /* 内容一致时不必打扰用户 */
    var cloudText = cloudRow
      ? [
          cloudRow.title || '',
          tagsToText(cloudRow.tags),
          cloudRow.summary || '',
          cloudRow.content_md || '',
        ].join('\u0000')
      : '\u0000';
    var localText = [
      data.title || '', data.tags || '', data.summary || '', data.content_md || '',
    ].join('\u0000');
    if (cloudRow && cloudText === localText) {
      window.WSBlogDraft.remove(key);
      return;
    }
    showDraftBanner(data);
  }

  function applyDraft(data) {
    if (fieldTitle) fieldTitle.value = data.title || '';
    if (fieldSlug) fieldSlug.value = data.slug || '';
    if (fieldSummary) fieldSummary.value = data.summary || '';
    if (fieldTags) fieldTags.value = data.tags || '';
    if (fieldContent) fieldContent.value = data.content_md || '';
    if (previewBox) {
      previewBox.innerHTML = '';
      previewBox.setAttribute('hidden', '');
    }
    if (formTitle && !editingSlug) formTitle.textContent = '新建投稿';
    hideDraftBanner();
    setStatus('已恢复本机草稿 · ' + formatWhen(data.savedAt), 'saved');
  }

  if (draftRestoreBtn) {
    draftRestoreBtn.addEventListener('click', function () {
      if (!pendingDraft) return;
      applyDraft(pendingDraft);
      if (fieldTitle) fieldTitle.focus();
    });
  }

  if (draftDiscardBtn) {
    draftDiscardBtn.addEventListener('click', function () {
      var key = draftKeyNow();
      if (key && window.WSBlogDraft) window.WSBlogDraft.remove(key);
      hideDraftBanner();
      setStatus('', 'idle');
      toast('已丢弃本机草稿');
    });
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
      .select('title, slug, summary, tags, content_md, status, review_note, updated_at')
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

    /* 保存前记住本地草稿的 key：新建文章时 key 会随 slug 变化，旧的也要清掉 */
    var keyBefore = draftKeyNow();

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
        /* 已落到云端，本地草稿使命完成 */
        if (keyBefore && window.WSBlogDraft) window.WSBlogDraft.remove(keyBefore);
        hideDraftBanner();
        if (draftCtrl) {
          draftCtrl.markSaved(status === 'pending' ? '已提交审核' : '已保存到云端');
        }
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
        if (!window.confirm('清空当前表单？本机自动保存的草稿也会一并清除。')) return;
      }
      if (draftCtrl) draftCtrl.discard();
      hideDraftBanner();
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
          .then(function (row) {
            checkLocalDraft(row);
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
          return null;
        })
      : Promise.resolve(null);
    chain.then(function (row) {
      /* 编辑器就位后再接自动保存，避免初始化过程写进一份空草稿 */
      setupDraft();
      checkLocalDraft(row);
      return loadMine();
    });
  });
})();
