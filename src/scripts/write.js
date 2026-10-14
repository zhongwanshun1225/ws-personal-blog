/**
 * 用户投稿页。
 *
 * 普通登录用户在这里写文章，只能落成 draft（草稿）或 pending（待审核）两种状态 ——
 * 想直接写 published 会被数据库的 RLS 策略拒绝，审核权只属于管理员。
 *
 * 状态流转：
 *   draft ──提交审核──▶ pending ──管理员通过──▶ published（前台可见）
 *                        └──管理员驳回──▶ rejected（附理由，作者改完可再投）
 *
 * 已发布文章的修改走另一条通道（author_update_post RPC，不是直连表）：
 *   · 受信任作者（管理员，或被站长逐个开启 can_publish 的账号）→ 改完立即生效
 *   · 其他作者 → 落进 cloud_posts.edit_* 暂存列，线上版本全程照旧展示，
 *     站长在后台「待审改稿」里通过后才替换
 * 之所以必须走 RPC：RLS 的 posts_own_update 只允许改非 published 行，
 * 放宽它会同时把「直接改成 published」的口子一起打开（那张表没有 BEFORE UPDATE 守卫）。
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
  var fieldSchedule = q('[data-write-schedule]');
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
  /* 编辑器载入时云端已有的期望发布时间（ISO 串）；用来判断作者有没有改过，
     只有改过才去调 author_set_publish_at，避免每次提交都多打一次接口。 */
  var editingPublishAt = '';
  var myPosts = [];
  /* 当前账号是否有「改稿直接生效」权限（来自 my_account().can_publish）；
     仅用来把提示语文案说准，真正的判定在 author_update_post 里 */
  var myCanPublish = false;

  /* 本地草稿控制器（draft.js 注入；脚本缺失时退化为不自动保存） */
  var draftCtrl = null;
  var pendingDraft = null;
  var DRAFT_NS = 'write';

  var STATUS_META = {
    draft: { label: '草稿', cls: 'status-badge--draft' },
    pending: { label: '待审核', cls: 'status-badge--pending' },
    published: { label: '已发布', cls: 'status-badge--published' },
    scheduled: { label: '定时发布', cls: 'status-badge--scheduled' },
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

  /* ---------------- A3 定时发布：本地时间 ↔ ISO ----------------
     datetime-local 的 value 是「本地墙钟时间」，直接 new Date() 会被当 UTC 解析，
     在 +08:00 会差 8 小时。这里手工拼 ISO，交给服务端按带时区的字符串解析。 */
  function localInputToIso(value) {
    var text = String(value || '').trim();
    if (!text) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text);
    if (!m) return null;
    var date = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0
    );
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  function isoToLocalInput(value) {
    if (!value) return '';
    var date = new Date(value);
    if (isNaN(date.getTime())) return '';
    function pad(n) { return String(n).padStart(2, '0'); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  /** 把「当前正在编辑哪一篇」广播给同页的扩展脚本（A4 预览链接 / A5 修订历史）。 */
  function broadcastEditorState(row) {
    try {
      document.dispatchEvent(new CustomEvent('wsblog:editor', {
        detail: {
          slug: editingSlug,
          status: editingStatus,
          title: (row && row.title) || (fieldTitle && fieldTitle.value) || '',
          canPublish: !!myCanPublish,
        },
      }));
    } catch (e) { /* 老浏览器不支持 CustomEvent 构造器时静默跳过 */ }
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

  function renderNote(status, note, row) {
    if (!noteBox) return;
    var html = '';
    if (status === 'pending') {
      html = '<strong>等待站长审核。</strong>审核通过后文章会出现在前台；在此之前你仍然可以修改，改完记得重新提交。';
    } else if (status === 'rejected') {
      html = '<strong>这篇投稿没有通过。</strong>' +
        (note ? '站长给的理由：' + esc(note) : '站长没有填写理由。') +
        ' 修改之后可以重新提交审核。';
    } else if (status === 'published') {
      var editPending = !!(row && row.edit_submitted_at);
      var editRejected = !!(row && !row.edit_submitted_at && row.edit_review_note);
      html = '<strong>这篇已经发布了。</strong>可以直接在这里改 —— ' +
        (myCanPublish
          ? '你的账号已开启「改稿直接生效」，提交后线上立即更新。'
          : '提交后进入待审：<strong>审核期间线上仍是现在的版本</strong>，' +
            '读者看到的是原文，站长通过后才替换成你的新版本。') +
        (editPending ? ' 你已经提交过一版修改，正在等站长审核。' : '') +
        (editRejected ? ' 上次修改被驳回：' + esc(row.edit_review_note) : '');
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

  /** 已发布 / 已定时的文章 slug 不让改：RPC 不接受改 slug，放开只会让人以为链接跟着变了。 */
  function applyLockState() {
    setFormLocked(false);
    if ((editingStatus === 'published' || editingStatus === 'scheduled') && fieldSlug) {
      fieldSlug.disabled = true;
    }
  }

  /** 已发布 / 已定时的文章没有「保存草稿」这一步（改稿只有提交一个动作），按钮跟着换。 */
  function applyActionButtons() {
    var live = editingStatus === 'published' || editingStatus === 'scheduled';
    if (saveBtn) {
      saveBtn.hidden = live;
      saveBtn.disabled = false;
    }
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = live ? '提交修改' : '提交审核';
    }
  }

  function resetForm() {
    editingSlug = '';
    editingStatus = '';
    editingPublishAt = '';
    if (form) form.reset();
    if (formTitle) formTitle.textContent = '新建投稿';
    if (previewBox) {
      previewBox.innerHTML = '';
      previewBox.setAttribute('hidden', '');
    }
    applyLockState();
    applyActionButtons();
    renderNote('');
    if (history.replaceState) history.replaceState(null, '', 'write.html');
    broadcastEditorState(null);
  }

  function loadIntoEditor(slug) {
    return C.db()
      .from('cloud_posts')
      .select('title, slug, summary, tags, content_md, status, review_note, updated_at,' +
              ' publish_at,' +
              ' edit_title, edit_summary, edit_content_md, edit_tags,' +
              ' edit_submitted_at, edit_review_note')
      .eq('slug', slug)
      .maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var row = res && res.data;
        if (!row) throw new Error('找不到这篇投稿，可能已被删除');
        editingSlug = row.slug;
        editingStatus = row.status || 'draft';
        /* 已发布文章：主字段是线上那一版，edit_* 是待审 / 被驳回的那一版。
           作者从「修改」进来，多半是要接着改 edit_* 那版，所以优先载入它。 */
        var useEdit = editingStatus === 'published' &&
          (!!row.edit_submitted_at || !!row.edit_review_note) &&
          !!(row.edit_content_md || row.edit_title);
        if (fieldTitle) fieldTitle.value = (useEdit ? row.edit_title : row.title) || '';
        if (fieldSlug) fieldSlug.value = row.slug || '';
        if (fieldSummary) fieldSummary.value = (useEdit ? row.edit_summary : row.summary) || '';
        if (fieldTags) fieldTags.value = tagsToText(useEdit ? row.edit_tags : row.tags);
        if (fieldContent) fieldContent.value = (useEdit ? row.edit_content_md : row.content_md) || '';
        if (formTitle) {
          formTitle.textContent = (editingStatus === 'published' ? '修改已发布：' : '编辑：') +
            (row.title || '');
        }
        if (previewBox) {
          previewBox.innerHTML = '';
          previewBox.setAttribute('hidden', '');
        }
        if (fieldSchedule) fieldSchedule.value = isoToLocalInput(row.publish_at);
        editingPublishAt = row.publish_at || '';
        applyLockState();
        applyActionButtons();
        renderNote(editingStatus, row.review_note, row);
        broadcastEditorState(row);
        return row;
      });
  }

  function readForm(status) {
    var data = {
      title: (fieldTitle && fieldTitle.value || '').trim(),
      slug: slugify((fieldSlug && fieldSlug.value) || (fieldTitle && fieldTitle.value) || ''),
      summary: (fieldSummary && fieldSummary.value || '').trim(),
      tags: tagsToArray(fieldTags && fieldTags.value),
      content_md: (fieldContent && fieldContent.value) || '',
      status: status,
      updated_at: new Date().toISOString(),
    };
    /* A3：期望发布时间。留空 = NULL（由站长在审核时决定；不写 null 是因为
       PostgREST 的 update 里显式 null 才会清掉旧值，这里是有意为之）。 */
    if (fieldSchedule) {
      data.publish_at = localInputToIso(fieldSchedule.value);
    }
    return data;
  }

  /** author_update_post 的 error 码 → 人话。 */
  var EDIT_ERRORS = {
    unauthenticated: '登录状态已过期，请重新登录',
    inactive: '账号已被禁用，暂时不能修改文章',
    not_found: '找不到这篇文章，或者你不是作者',
    not_published: '这篇文章还没发布，请走普通的草稿 / 投稿流程',
    title_required: '标题不能为空',
    content_required: '正文不能为空',
    forbidden_published: '这篇文章已经在线上，改发布时间需要「改稿直接生效」权限，找站长开一下。',
    bad_time: '发布时间看不懂，重新选一下。',
  };

  /** A3：作者改动了「期望发布时间」时，单独同步一次（author_update_post 不管这列）。
      非受信任作者在已发布文章上会被服务端拒掉，这时给出人话提示而不是静默失败。 */
  function syncSchedule() {
    if (!fieldSchedule) return Promise.resolve();
    var want = localInputToIso(fieldSchedule.value);
    var before = editingPublishAt ? new Date(editingPublishAt).getTime() : 0;
    var after = want ? new Date(want).getTime() : 0;
    if (before === after) return Promise.resolve();
    return C.db().rpc('author_set_publish_at', {
      p_slug: editingSlug,
      p_at: want || '',
    })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var out = res && res.data;
        if (out && out.ok === true) {
          var when = out.publish_at ? formatWhen(out.publish_at) : '立即（等审核通过）';
          toast(out.status === 'scheduled' ? '已安排在 ' + when + ' 自动上线' : '发布时间已更新：' + when);
          return;
        }
        toast(EDIT_ERRORS[out && out.error] || '发布时间没能保存');
      })
      .catch(function (err) {
        toast((err && (err.message || err.error_description)) || '发布时间没能保存');
      });
  }

  /** 已发布文章的改稿：走 author_update_post，由服务端决定「直接生效」还是「进待审」。 */
  function savePublishedEdit() {
    if (busy) return;
    if (C.requireLogin()) return;
    if (C.requireActive()) return;

    var data = readForm(editingStatus);
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

    var keyBefore = draftKeyNow();

    return C.db().rpc('author_update_post', {
      p_slug: editingSlug,
      p_title: data.title,
      p_summary: data.summary,
      p_content_md: data.content_md,
      p_tags: data.tags,
      p_submit: true,
    })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var out = res && res.data;
        var result = out && typeof out === 'object' ? out : {};
        if (result.ok !== true) {
          throw new Error(EDIT_ERRORS[result.error] || '提交失败（' + (result.error || '未知错误') + '）');
        }
        var direct = result.mode === 'direct';
        toast(direct ? '修改已生效，线上已更新' : '修改已提交，站长通过后替换线上版本');
        /* 已经落到云端（或待审）了，本地草稿使命完成 */
        if (keyBefore && window.WSBlogDraft) window.WSBlogDraft.remove(keyBefore);
        hideDraftBanner();
        if (draftCtrl) draftCtrl.markSaved(direct ? '已生效' : '已提交待审');
        return syncSchedule().then(function () { return loadIntoEditor(editingSlug); });
      })
      .then(function () { return loadMine(); })
      .catch(function (err) {
        toast((err && (err.message || err.error_description)) || '提交失败');
      })
      .then(function () {
        busy = false;
        if (submitBtn) submitBtn.disabled = false;
      });
  }

  function save(status) {
    if (busy) return;
    /* 已发布 / 已定时的文章没有草稿态，只有「提交修改」一条路 */
    if (editingSlug && (editingStatus === 'published' || editingStatus === 'scheduled')) {
      return savePublishedEdit();
    }
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
        applyLockState();
        applyActionButtons();
        /* 已落到云端，本地草稿使命完成 */
        if (keyBefore && window.WSBlogDraft) window.WSBlogDraft.remove(keyBefore);
        hideDraftBanner();
        if (draftCtrl) {
          draftCtrl.markSaved(status === 'pending' ? '已提交审核' : '已保存到云端');
        }
        editingPublishAt = (rows[0] && rows[0].publish_at) || '';
        broadcastEditorState(rows[0]);
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
      if (editingStatus === 'published') return; /* 已发布走「提交修改」，没有草稿态 */
      if (editingStatus === 'pending') {
        toast('已撤回为草稿，改完记得重新提交');
      }
      save('draft');
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      if (editingStatus !== 'published') {
        save('pending');
        return;
      }
      if (!window.confirm(
        '提交对已发布文章的修改？\n\n' +
        (myCanPublish
          ? '你的账号已开启「改稿直接生效」，提交后线上立即更新。'
          : '提交后进入待审：审核期间线上仍是现在的版本，读者不受影响，站长通过后才替换。')
      )) return;
      savePublishedEdit();
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
    var editPending = !!post.edit_submitted_at;
    var editRejected = !editPending && !!post.edit_review_note;

    return (
      '<li class="stack-item" data-my-post-row="' + esc(post.slug) + '">' +
      '<div class="stack-item__head">' +
      '<span class="stack-item__title">' + esc(post.title) + '</span>' +
      statusBadge(post.status) +
      (editPending ? '<span class="status-badge status-badge--pending">修改待审</span>' : '') +
      '<span class="stack-item__time">' + esc(timeLabel) + '</span>' +
      '</div>' +
      '<div class="stack-item__text mono">' + esc(post.slug) + '</div>' +
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
      (isPublished
        ? '<a class="link-btn" href="' + esc(postUrl(post.slug)) + '">阅读</a>' +
          '<button class="link-btn" type="button" data-my-post-edit="' + esc(post.slug) + '">' +
          (editPending ? '查看修改' : '修改') + '</button>'
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

  /* 「我的投稿」原来写死 50 条，超出的静默消失（V3）。
     现在按需扩展，并在可能被截断时把「加载更多」摆出来。 */
  var mineLimit = 50;
  var MINE_STEP = 50;

  function loadMine() {
    var uid = C.currentUid();
    if (!uid) return Promise.resolve([]);
    return C.db()
      .from('cloud_posts')
      .select('slug, title, status, review_note, created_at, updated_at, published_at,' +
              ' edit_submitted_at, edit_review_note')
      .eq('author_id', uid)
      .order('updated_at', { ascending: false })
      .limit(mineLimit)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var list = (res && res.data) || [];
        myPosts = list;
        setText(countEl, list.length);
        if (listEl) {
          var more = list.length >= mineLimit
            ? '<li class="stack-more"><button class="link-btn" type="button" data-mine-more>' +
              C.escapeHtml(typeof window.__wsT === 'function' ? window.__wsT('account.loadMore', '加载更多') : '加载更多') +
              '</button></li>'
            : '';
          listEl.innerHTML = list.length
            ? list.map(mineRow).join('') + more
            : '<li class="stack-empty">还没有投稿，写一篇试试。</li>';
          var moreBtn = listEl.querySelector('[data-mine-more]');
          if (moreBtn) {
            moreBtn.addEventListener('click', function () {
              moreBtn.disabled = true;
              mineLimit += MINE_STEP;
              loadMine();
            });
          }
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

  applyActionButtons();

  C.booted().then(function () {
    if (C.requireLogin()) return null;
    /* 先问一次权限，好让「立即生效 / 进待审」的提示语说准；
       拿不到也不影响功能 —— 真正的判定在 author_update_post 里。 */
    return C.db().rpc('my_account')
      .then(function (res) {
        var acc = res && res.data;
        myCanPublish = !!(acc && typeof acc === 'object' && acc.can_publish);
      })
      .catch(function () { /* 沿用默认措辞 */ });
  }).then(function () {
    if (!C.currentUid()) return null;
    var slug = slugParam();
    var chain = slug
      ? loadIntoEditor(slug).catch(function (err) {
          toast((err && err.message) || '这篇投稿打不开');
          resetForm();
          return null;
        })
      : Promise.resolve(null);
    return chain.then(function (row) {
      /* 编辑器就位后再接自动保存，避免初始化过程写进一份空草稿 */
      setupDraft();
      checkLocalDraft(row);
      return loadMine();
    });
  });
})();
