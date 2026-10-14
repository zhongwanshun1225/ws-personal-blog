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
  var fieldSchedule = q('[data-admin-schedule]');
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
  var editBody = q('[data-admin-edits]');
  var editCountEl = q('[data-edit-count]');
  var editPagerEl = q('[data-edit-pager]');
  var usersBody = q('[data-admin-users]');
  var commentsBody = q('[data-admin-comments]');
  var commentCountEl = q('[data-comment-total]');
  var emailsBody = q('[data-admin-emails]');
  var emailInput = q('[data-admin-email-input]');
  var emailNote = q('[data-admin-email-note]');
  var emailAddBtn = q('[data-admin-email-add]');
  var wordInput = q('[data-word-input]');
  var wordAddBtn = q('[data-word-add]');
  var wordListEl = q('[data-word-list]');
  /* 举报与邮箱变更申请（M13 / M5） */
  var reportsBadgeEl = q('[data-reports-badge]');
  var reportsBody = q('[data-admin-reports]');
  var reportOpenEl = q('[data-report-open]');
  var reportPagerEl = q('[data-report-pager]');
  var emailRequestsBody = q('[data-admin-email-requests]');
  var emailRequestCountEl = q('[data-email-request-count]');

  /* 列表优先：编辑器默认收起，点「写新文章」或行内「编辑」才展开 */
  var editorShell = q('[data-editor-shell]');
  var editorOpenBtn = q('[data-editor-open]');
  var editorCloseBtn = q('[data-editor-close]');

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
  var editState = { page: 1, pageSize: 20, total: 0 };
  var reportsState = { status: 'open', page: 1, pageSize: 30, total: 0 };

  /* 状态徽章：draft / pending / published / scheduled / rejected */
  var STATUS_META = {
    draft: { label: '草稿', cls: 'status-badge--draft' },
    pending: { label: '待审核', cls: 'status-badge--pending' },
    published: { label: '已发布', cls: 'status-badge--published' },
    scheduled: { label: '定时未到', cls: 'status-badge--scheduled' },
    rejected: { label: '未通过', cls: 'status-badge--rejected' },
  };

  /* 评论状态：三档（待审 / 显示中 / 已隐藏） */
  var COMMENT_STATUS_META = {
    pending: { label: '待审', cls: 'status-badge--pending' },
    visible: { label: '显示中', cls: 'status-badge--visible' },
    hidden: { label: '已隐藏', cls: 'status-badge--hidden' },
  };

  function commentStatusBadge(status) {
    var meta = COMMENT_STATUS_META[status] || { label: status || '未知', cls: '' };
    return '<span class="status-badge ' + meta.cls + '">' + esc(meta.label) + '</span>';
  }

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

  /* ---- datetime-local ↔ ISO（A3 定时发布 / B8 排序定时）----
     datetime-local 的 value 是「本地时间、无时区」的字面量，直接扔给
     Postgres 会被当 UTC 解析，于是定时会整体偏 8 小时。这里统一转成 ISO。 */
  function localInputToIso(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    var date = new Date(text);
    return isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function isoToLocalInput(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  /**
   * 统一空态：主文案 + 副提示（原来只有一句灰字，管理员看不出「是没数据还是筛错了」）。
   * 传入 colspan 保持表格结构，窄屏卡片化时这一格会自动跨列。
   */
  function emptyRow(colspan, title, hint) {
    return (
      '<tr><td colspan="' + colspan + '" class="admin-empty">' +
      '<span class="admin-empty__title">' + esc(title) + '</span>' +
      (hint ? '<span class="admin-empty__hint">' + esc(hint) + '</span>' : '') +
      '</td></tr>'
    );
  }

  /**
   * 批量选择用的勾选格（B2）。真正的选择状态由 admin-ext.js 统一维护
   * （它在本文件的刷新钩子上同步），这里只负责把格子画出来 —— 保持
   * 「渲染」与「批量动作」两层解耦，改表格结构不会牵动批量逻辑。
   */
  function pickCell(kind, id) {
    return (
      '<td class="admin-table__pick">' +
      '<input type="checkbox" data-pick="' + esc(kind) + '" value="' + esc(id) + '" ' +
      'aria-label="选择该项">' +
      '</td>'
    );
  }

  /**
   * 与 admin-ext.js（新增的 B2–B17 面板）之间的两个钩子。
   * 分层目的：本文件保持「原有面板」的稳定实现，新面板单独一个文件，
   * 两者只通过这两个函数交互，谁都不用感知对方的内部状态。
   *   onList  —— 每次列表重渲染后同步一次（批量栏据此计算已选/可选）
   *   refresh —— 统一刷新时把新面板也带上
   */
  function notifyExtList(kind, list) {
    var ext = window.WSBlogAdminExt;
    if (ext && typeof ext.onList === 'function') ext.onList(kind, list || []);
  }

  function extRefresh() {
    var ext = window.WSBlogAdminExt;
    if (ext && typeof ext.refresh === 'function') return ext.refresh(postsState.status);
    return Promise.resolve();
  }

  function api(promise, fallbackMessage) {    return promise.then(function (res) {
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
    if (name === 'reports') {
      loadReports();
      loadEmailRequests();
    }
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
    slugs_sync: '同步文章清单',
    comment_report_resolved: '举报已处理',
    comment_report_dismissed: '举报不予处理',
    email_change_approve: '邮箱变更已完成',
    email_change_reject: '邮箱变更被驳回',
    account_delete: '用户注销账号'
  };

  /* 审计日志（B12）：筛选 + 服务端分页 + 导出。
     旧实现是「写死 100 条 + 加载更多」，既搜不了也导不出去。 */
  var auditState = { search: '', action: '', actor: '', from: '', to: '', page: 1, pageSize: 50, total: 0 };

  function auditDetail(item) {
    var detail = '';
    if (item.note) detail += esc(item.note);
    if (item.payload) {
      try {
        var p = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload;
        if (p && typeof p === 'object') {
          var kv = Object.keys(p).map(function (k) {
            var v = p[k];
            if (Array.isArray(v)) v = v.length + ' 项';
            return k + '=' + String(v == null ? '—' : v).slice(0, 60);
          }).join(' · ');
          if (kv) detail += (detail ? ' · ' : '') + esc(kv);
        }
      } catch (err) { /* payload 不是合法 JSON 时忽略 */ }
    }
    return detail || '—';
  }

  function auditParams() {
    return {
      p_search: auditState.search || null,
      p_action: auditState.action || null,
      p_actor: auditState.actor || null,
      p_from: auditState.from || null,
      p_to: auditState.to || null,
    };
  }

  function loadAuditActions() {
    var sel = q('[data-audit-action]');
    if (!sel || sel.getAttribute('data-loaded')) return Promise.resolve();
    return api(C.db().rpc('admin_audit_actions'), '动作清单加载失败').then(function (list) {
      var actions = Array.isArray(list) ? list : [];
      sel.innerHTML = '<option value="">全部动作</option>' + actions.map(function (action) {
        return '<option value="' + esc(action) + '">' + esc(AUDIT_LABELS[action] || action) + '</option>';
      }).join('');
      sel.setAttribute('data-loaded', '1');
    }).catch(function () {});
  }

  function loadAudit() {
    var body = q('[data-audit-log]');
    if (!body) return Promise.resolve(null);
    loadAuditActions();
    var params = auditParams();
    params.p_limit = auditState.pageSize;
    params.p_offset = (auditState.page - 1) * auditState.pageSize;
    return api(C.db().rpc('admin_audit_page', params), '日志加载失败')
      .then(function (data) {
        var page = pageRows(data, '日志加载失败');
        var rows = page.rows || [];
        var total = Number(page.total) || 0;
        var totalPages = Math.max(1, Math.ceil(total / auditState.pageSize));
        if (auditState.page > totalPages) {
          auditState.page = totalPages;
          return loadAudit();
        }
        auditState.total = total;
        setText(q('[data-audit-total]'), total);
        var filtered = auditState.search || auditState.action || auditState.actor || auditState.from || auditState.to;
        body.innerHTML = rows.length
          ? rows.map(function (item) {
              return (
                '<tr>' +
                '<td class="admin-cell__sub mono">' + esc(C.formatDateTime(item.created_at)) + '</td>' +
                '<td class="admin-cell__sub">' + esc(item.actor_email || item.actor_id || '—') + '</td>' +
                '<td>' + esc(AUDIT_LABELS[item.action] || item.action) + '</td>' +
                '<td class="mono admin-cell__sub">' + esc([item.target_type, item.target_id].filter(Boolean).join(':') || '—') + '</td>' +
                '<td class="admin-cell__sub">' + auditDetail(item) + '</td>' +
                '</tr>'
              );
            }).join('')
          : emptyRow(5, filtered ? '没有匹配的操作记录' : '还没有任何管理操作记录',
                     filtered ? '放宽筛选条件再试。' : '删帖、审核、封禁等敏感操作都会自动留痕。');
        var pager = q('[data-audit-pager]');
        auditState.total = total;
        renderPager(pager, auditState, loadAudit);
        return rows;
      })
      .catch(function (err) {
        var message = (err && err.message) || '';
        /* 编辑角色没有审计查看权限：给一句人话，别甩数据库报错 */
        body.innerHTML = emptyRow(
          5,
          /forbidden/i.test(message) ? '当前身份没有查看权限' : '日志加载失败',
          /forbidden/i.test(message) ? '审计日志只对管理员开放。' : message
        );
        return null;
      });
  }

  /* 导出当前筛选结果（最多 200 条，服务端 RPC 的硬上限）。
     不在前端拼全量是因为审计表会一直长，一次性拉全对浏览器与服务端都太重。 */
  function exportAuditCsv(btn) {
    var params = auditParams();
    params.p_limit = 200;
    params.p_offset = 0;
    if (btn) btn.disabled = true;
    return api(C.db().rpc('admin_audit_page', params), '导出失败')
      .then(function (data) {
        var rows = (data && data.rows) || [];
        if (!rows.length) {
          toast('当前筛选没有可导出的记录');
          return;
        }
        var head = ['时间', '操作者', '动作', '对象类型', '对象 ID', '备注', '详情'];
        var lines = [head.join(',')];
        rows.forEach(function (item) {
          var payload = '';
          try {
            payload = item.payload ? JSON.stringify(item.payload) : '';
          } catch (err) { payload = ''; }
          lines.push([
            item.created_at || '',
            item.actor_email || item.actor_id || '',
            AUDIT_LABELS[item.action] || item.action || '',
            item.target_type || '',
            item.target_id || '',
            item.note || '',
            payload,
          ].map(csvCell).join(','));
        });
        /* BOM 让 Excel 正确识别 UTF-8，否则中文全是乱码 */
        downloadText('audit-log.csv', '\ufeff' + lines.join('\r\n'));
        toast('已导出 ' + rows.length + ' 条');
      })
      .catch(function () {})
      .then(function () { if (btn) btn.disabled = false; });
  }

  function csvCell(value) {
    var text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  bindSearch(q('[data-audit-search]'), auditState, function () { auditState.page = 1; loadAudit(); });
  bindSearch(q('[data-audit-actor]'), auditState, function () { auditState.page = 1; loadAudit(); });
  (function () {
    var actionSel = q('[data-audit-action]');
    if (actionSel) {
      actionSel.addEventListener('change', function () {
        auditState.action = actionSel.value || '';
        auditState.page = 1;
        loadAudit();
      });
    }
    var fromEl = q('[data-audit-from]');
    var toEl = q('[data-audit-to]');
    if (fromEl) {
      fromEl.addEventListener('change', function () {
        auditState.from = fromEl.value || '';
        auditState.page = 1;
        loadAudit();
      });
    }
    if (toEl) {
      toEl.addEventListener('change', function () {
        auditState.to = toEl.value || '';
        auditState.page = 1;
        loadAudit();
      });
    }
    var resetBtn = q('[data-audit-reset]');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        auditState.search = '';
        auditState.action = '';
        auditState.actor = '';
        auditState.from = '';
        auditState.to = '';
        auditState.page = 1;
        [q('[data-audit-search]'), q('[data-audit-actor]'), q('[data-audit-from]'), q('[data-audit-to]')]
          .forEach(function (el) { if (el) el.value = ''; });
        var sel = q('[data-audit-action]');
        if (sel) sel.value = '';
        loadAudit();
      });
    }
    var exportBtn = q('[data-audit-export]');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () { exportAuditCsv(exportBtn); });
    }
  })();

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

  /** 「举报与申请」标签上的待办数 = 待处理举报 + 待处理邮箱申请。 */
  function setReportsBadge(count) {
    if (!reportsBadgeEl) return;
    if (count > 0) {
      reportsBadgeEl.textContent = String(count);
      reportsBadgeEl.removeAttribute('hidden');
    } else {
      reportsBadgeEl.setAttribute('hidden', '');
    }
  }

  function loadStats() {
    return api(C.db().rpc('admin_stats'), '概览数据加载失败').then(function (data) {
      var stats = data && typeof data === 'object' ? data : {};
      setText(q('[data-stat-users]'), stats.users || 0);
      setText(q('[data-stat-disabled]'), stats.disabled_users || 0);
      setText(q('[data-stat-comments]'), stats.comments || 0);
      setText(q('[data-stat-hidden]'), stats.hidden || 0);
      setText(q('[data-stat-pending-comments]'), stats.pending_comments || 0);
      setText(q('[data-stat-likes]'), stats.likes || 0);
      setText(q('[data-stat-posts]'), stats.posts || 0);
      setText(q('[data-stat-drafts]'), stats.drafts || 0);
      setText(q('[data-stat-pending]'), stats.pending || 0);
      setText(q('[data-stat-edit-pending]'), stats.edit_pending || 0);
      setText(q('[data-stat-today]'), stats.today_comments || 0);
      setText(q('[data-stat-views]'), Number(stats.views || 0).toLocaleString());
      /* 徽标口径 = 所有等着审核的东西：新投稿 + 改稿 */
      setReviewBadge(Number(stats.pending || 0) + Number(stats.edit_pending || 0));
      setText(q('[data-stat-open-reports]'), stats.open_reports || 0);
      setText(q('[data-stat-email-requests]'), stats.email_requests || 0);
      setReportsBadge(Number(stats.open_reports || 0) + Number(stats.email_requests || 0));
      return stats;
    });
  }

  /* ---------------- 文章管理 ---------------- */

  function resetForm() {
    editingSlug = '';
    if (form) form.reset();
    if (fieldStatus) fieldStatus.value = 'draft';
    if (fieldSchedule) fieldSchedule.value = '';
    if (formTitle) formTitle.textContent = '写一篇新文章';
    if (previewBox) {
      previewBox.innerHTML = '';
      previewBox.setAttribute('hidden', '');
    }
    if (saveBtn) saveBtn.textContent = '保存草稿';
    broadcastEditor('', 'draft');
  }

  /** 广播当前编辑器状态：write-ext.js 靠这个事件跟着换 slug（A4/A5）。 */
  function broadcastEditor(slug, status) {
    document.dispatchEvent(new CustomEvent('wsblog:editor', {
      detail: {
        slug: slug || '',
        status: status || '',
        scope: 'admin',
        publish_at: localInputToIso(fieldSchedule && fieldSchedule.value),
      },
    }));
  }

  function readForm(status) {
    var next = status || (fieldStatus && fieldStatus.value) || 'draft';
    var payload = {
      title: (fieldTitle && fieldTitle.value || '').trim(),
      slug: slugify((fieldSlug && fieldSlug.value) || (fieldTitle && fieldTitle.value) || ''),
      summary: (fieldSummary && fieldSummary.value || '').trim(),
      tags: tagsToArray(fieldTags && fieldTags.value),
      content_md: (fieldContent && fieldContent.value) || '',
      status: next,
    };
    if (next === 'scheduled' || (fieldSchedule && fieldSchedule.value)) {
      payload.publish_at = localInputToIso(fieldSchedule && fieldSchedule.value) || null;
    }
    return payload;
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
    if (payload.status === 'scheduled') {
      var at = localInputToIso(fieldSchedule && fieldSchedule.value);
      if (!at) {
        toast('定时发布要填发布时间');
        if (fieldSchedule) fieldSchedule.focus();
        return false;
      }
      if (new Date(at).getTime() <= Date.now()) {
        toast('发布时间要在未来；想立刻上线就选「已发布」');
        if (fieldSchedule) fieldSchedule.focus();
        return false;
      }
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
    if (payload.status === 'scheduled') payload.published_at = null;

    var DONE_LABEL = {
      published: '已发布',
      scheduled: '已排期，到点自动上线',
      draft: '草稿已保存',
    };
    var doneText = DONE_LABEL[payload.status] || '已保存';

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
        toast(doneText);
        /* 已落到云端，清掉本机草稿（含新建时用的 new 槽位） */
        clearAdminDraft();
        hideAdminDraftBanner();
        setAdminStatus(doneText + '，已同步到云端', 'saved');
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

  /* 编辑器按需展开：列表是主角，编辑器只在「写新文章 / 编辑某篇」时出现。
     原来的实现把编辑器常驻在列表上方，文章一多要滚很久才看得到列表。 */
  function openEditor() {
    if (!editorShell) return;
    editorShell.removeAttribute('hidden');
    broadcastEditor(editingSlug, fieldStatus && fieldStatus.value);
  }

  function closeEditor() {
    if (editorShell) editorShell.setAttribute('hidden', '');
  }

  if (editorOpenBtn) {
    editorOpenBtn.addEventListener('click', function () {
      resetForm();
      openEditor();
      if (fieldTitle) fieldTitle.focus();
    });
  }
  if (editorCloseBtn) {
    editorCloseBtn.addEventListener('click', function () {
      closeEditor();
    });
  }
  if (fieldSchedule) {
    fieldSchedule.addEventListener('change', function () {
      broadcastEditor(editingSlug, fieldStatus && fieldStatus.value);
    });
  }
  if (fieldStatus) {
    fieldStatus.addEventListener('change', function () {
      /* 选到「定时发布」时把焦点带到时间输入，省一次找控件的动作 */
      if (fieldStatus.value === 'scheduled' && fieldSchedule) fieldSchedule.focus();
      broadcastEditor(editingSlug, fieldStatus.value);
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
    /* admin_posts_page 返回的是 nickname / email（不是 author_name / author_email），
       两种键名都认，避免作者列永远显示「未知作者」。 */
    var mail = post.email || post.author_email || '';
    var name = post.nickname || post.author_name || mail.split('@')[0] || '未知作者';
    return (
      '<td><div class="admin-cell__title">' + esc(name) +
      (post.is_own ? ' <span class="admin-tag">我</span>' : '') + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(mail || post.author_id || '') + '</div></td>'
    );
  }

  /** 排序权重 / 定时发布（B8）：一格里同时给出「置顶、权重、定时」三件信息 */
  function flagsCell(post) {
    var bits = [];
    if (post.pinned) bits.push('<span class="status-badge status-badge--pinned">置顶</span>');
    if (Number(post.weight || 0) !== 0) {
      bits.push('<span class="admin-cell__sub">权重 ' + esc(String(post.weight)) + '</span>');
    }
    if (post.status === 'scheduled' && post.publish_at) {
      bits.push('<div class="admin-cell__sub">定时 ' + esc(C.formatDateTime(post.publish_at)) + '</div>');
    } else if (post.publish_at) {
      bits.push('<div class="admin-cell__sub">发布时间 ' + esc(C.formatDateTime(post.publish_at)) + '</div>');
    }
    if (!bits.length) bits.push('<span class="admin-cell__sub">—</span>');
    return '<td>' + bits.join(' ') + '</td>';
  }

  function postRow(post) {
    var isPublished = post.status === 'published';
    var isScheduled = post.status === 'scheduled';
    return (
      '<tr data-post-row="' + esc(post.slug) + '">' +
      pickCell('posts', post.id) +
      '<td><div class="admin-cell__title">' + esc(post.title) + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(post.slug) + '</div>' +
      (post.edit_submitted_at ? '<div class="admin-cell__flag">有改稿待审</div>' : '') + '</td>' +
      authorCell(post) +
      '<td>' + statusBadge(post.status) + '</td>' +
      flagsCell(post) +
      '<td class="admin-cell__sub">' + esc(C.formatDate(post.updated_at || post.created_at)) + '</td>' +
      '<td class="admin-cell__actions">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-post-edit="' + esc(post.slug) + '">编辑</button>' +
      (isPublished || isScheduled
        ? '<button class="btn btn--ghost btn--sm" type="button" data-post-unpublish="' + esc(post.slug) + '">转草稿</button>'
        : '<button class="btn btn--ghost btn--sm" type="button" data-post-publish-row="' + esc(post.slug) + '">发布</button>') +
      '<button class="btn btn--ghost btn--sm" type="button" data-post-flags="' + esc(post.slug) + '">排序</button>' +
      '<button class="btn btn--danger btn--sm" type="button" data-post-delete="' + esc(post.slug) + '">删除</button>' +
      '</td></tr>'
    );
  }

  /** 把某篇文章载入左侧编辑器（文章管理与内容审核共用）。 */
  function loadIntoEditor(slug) {
    editingSlug = slug;
    return api(
      C.db().from('cloud_posts')
        .select('title, slug, summary, tags, content_md, status, review_note, publish_at')
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
      if (fieldSchedule) fieldSchedule.value = isoToLocalInput(row.publish_at);
      if (formTitle) formTitle.textContent = '编辑：' + (row.title || '');
      if (saveBtn) saveBtn.textContent = '保存修改';
      if (previewBox) {
        previewBox.innerHTML = '';
        previewBox.setAttribute('hidden', '');
      }
      if (fieldContent) fieldContent.focus();
      /* 载入后检查是否有比云端更新的本机草稿 */
      checkAdminDraft();
      /* 通知 write-ext.js 换 slug（预览链接 / 修订历史跟着切） */
      broadcastEditor(row.slug, row.status);
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
          : emptyRow(7, filtered ? '没有匹配的文章' : '还没有文章',
                     filtered ? '换个关键词或状态试试。' : '点右上角「写新文章」写下第一篇。');
      }
      bindPostActions(list);
      notifyExtList('posts', list);
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
        openEditor();
        loadIntoEditor(slug)
          .then(function () {
            if (editorShell) editorShell.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      api(
        C.db().rpc('admin_posts_page', {
          p_search: null,
          p_status: 'edit_pending',
          p_limit: editState.pageSize,
          p_offset: (editState.page - 1) * editState.pageSize,
        }),
        '待审改稿加载失败'
      ),
    ]).then(function (results) {
      var pendingPage = pageRows(results[0], '待审核列表加载失败');
      var reviewedPage = pageRows(results[1], '已处理列表加载失败');
      var editPage = pageRows(results[2], '待审改稿加载失败');
      var pending = pendingPage.rows || [];
      var handled = reviewedPage.rows || [];
      var edits = editPage.rows || [];

      pendingState.total = Number(pendingPage.total) || 0;
      reviewedState.total = Number(reviewedPage.total) || 0;
      editState.total = Number(editPage.total) || 0;

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
      var editPages = Math.max(1, Math.ceil(editState.total / editState.pageSize));
      if (editState.page > editPages) {
        editState.page = editPages;
        return loadReview();
      }

      setText(reviewCountEl, pendingState.total);
      setText(editCountEl, editState.total);
      /* 徽标 = 所有等着你点头的事：新投稿 + 改稿 */
      setReviewBadge(pendingState.total + editState.total);

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
      if (editBody) {
        editBody.innerHTML = edits.length
          ? edits.map(editRow).join('')
          : '<tr><td colspan="4" class="admin-empty">当前没有待审的改稿。</td></tr>';
      }
      bindReviewActions();
      renderPager(reviewPagerEl, pendingState, loadReview);
      renderPager(reviewedPagerEl, reviewedState, loadReview);
      renderPager(editPagerEl, editState, loadReview);
      return { pending: pendingState.total, reviewed: reviewedState.total, edits: editState.total };
    });
  }

  /** 一行待审改稿：新标题 vs 原标题对照，避免通过时不知道自己点头的是什么。 */
  function editRow(post) {
    var newTitle = post.edit_title || post.title;
    var changedTitle = newTitle !== post.title;
    return (
      '<tr data-edit-row="' + esc(post.slug) + '">' +
      '<td><div class="admin-cell__title">' + esc(newTitle) + '</div>' +
      (changedTitle
        ? '<div class="admin-cell__sub">原标题：' + esc(post.title) + '</div>'
        : '<div class="admin-cell__sub">标题未改，仅内容/标签有改动</div>') +
      '</td>' +
      '<td><div>' + esc(post.nickname || '—') + '</div>' +
      '<div class="admin-cell__sub">' + esc(post.email || '') + '</div></td>' +
      '<td class="admin-cell__sub">' + esc(C.formatDateTime(post.edit_submitted_at)) + '</td>' +
      '<td class="admin-cell__actions">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-edit-view="' + esc(post.slug) + '">看原文</button>' +
      '<button class="btn btn--primary btn--sm" type="button" data-edit-approve="' + esc(post.slug) + '">通过</button>' +
      '<button class="btn btn--danger btn--sm" type="button" data-edit-reject="' + esc(post.slug) + '">驳回</button>' +
      '</td></tr>'
    );
  }

  /** 审核一次改稿（approve / reject），成功后刷新审核区与统计。 */
  function reviewEdit(slug, action, note) {
    return api(
      C.db().rpc('admin_review_edit', { p_slug: slug, p_action: action, p_note: note || null }),
      action === 'approve' ? '通过失败' : '驳回失败'
    ).then(function (data) {
      var res = data && typeof data === 'object' ? data : {};
      if (res.ok === false) {
        throw new Error(res.error === 'no_pending_edit' ? '这篇的改稿已经被处理过了' : '操作被拒绝');
      }
      toast(action === 'approve' ? '改稿已通过，线上版本已更新' : '改稿已驳回');
      return Promise.all([loadReview(), loadStats(), loadPosts()]);
    });
  }

  /** 在该行下方展开「驳回理由」输入行。
   *  opts.colspan 列数（投稿表 5 列、改稿表 4 列）
   *  opts.placeholder 输入框提示语
   *  opts.onConfirm(note) 点「确认驳回」时执行，需返回 Promise */
  function openRejectForm(slug, row, opts) {
    var cfg = opts || {};
    var colspan = cfg.colspan || 5;
    if (!cfg.onConfirm) {
      cfg.onConfirm = function (note) { return review(slug, 'reject', note); };
    }
    var opened = q('[data-review-reject-form]');
    if (opened) opened.parentNode.removeChild(opened);
    var tr = document.createElement('tr');
    tr.setAttribute('data-review-reject-form', slug);
    tr.innerHTML =
      '<td colspan="' + colspan + '"><div class="review-reject">' +
      '<textarea class="field__input" rows="2" maxlength="200" data-review-note ' +
      'placeholder="' + esc(cfg.placeholder || '驳回理由（会展示给作者，留空也可以）') + '"></textarea>' +
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
      cfg.onConfirm(textarea ? textarea.value : '').catch(function () {
        confirmBtn.disabled = false;
      });
    });
  }

  /** 对照面板里的一栏：标题 + 摘要 + 正文（Markdown 渲染）。 */
  function editDiffBlock(label, title, summary, content) {
    var md = window.WSBlogCloudMarkdown;
    var body = (md && typeof md.render === 'function')
      ? md.render(content || '')
      : '<pre>' + esc(content || '') + '</pre>';
    return (
      '<div class="edit-diff__col">' +
      '<div class="edit-diff__label">' + esc(label) + '</div>' +
      '<h4 class="edit-diff__title">' + esc(title || '（无标题）') + '</h4>' +
      (summary ? '<p class="edit-diff__summary">' + esc(summary) + '</p>' : '') +
      '<div class="edit-diff__body">' + body + '</div>' +
      '</div>'
    );
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
        openEditor();
        loadIntoEditor(slug)
          .then(function (row) {
            if (!previewBox || !fieldContent) return;
            previewBox.removeAttribute('hidden');
            previewBox.innerHTML = window.WSBlogCloudMarkdown
              ? window.WSBlogCloudMarkdown.render(fieldContent.value)
              : '<p>' + esc(fieldContent.value).replace(/\n/g, '<br>') + '</p>';
            if (editorShell) editorShell.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

    /* ---- 待审改稿：看改动 / 通过 / 驳回 ---- */

    qa('[data-edit-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-edit-view');
        var host = btn.closest('[data-edit-row]');
        if (!host) return;
        /* 再点一次收起，省得并排堆一屏 */
        var opened = q('[data-edit-diff="' + slug + '"]');
        if (opened) { opened.parentNode.removeChild(opened); return; }
        btn.disabled = true;
        api(C.db().rpc('admin_post_edit_detail', { p_slug: slug }), '打开改稿对照失败')
          .then(function (data) {
            var d = data && typeof data === 'object' ? data : {};
            if (d.ok === false) throw new Error('这篇改稿已经被处理过了');
            var tr = document.createElement('tr');
            tr.setAttribute('data-edit-diff', slug);
            tr.innerHTML =
              '<td colspan="4"><div class="edit-diff">' +
              editDiffBlock('通过后上线（新）', d.edit_title, d.edit_summary, d.edit_content_md) +
              editDiffBlock('读者当前看到（旧）', d.title, d.summary, d.content_md) +
              '</div></td>';
            host.parentNode.insertBefore(tr, host.nextSibling);
          })
          .catch(function () { /* api() 已提示 */ })
          .then(function () { btn.disabled = false; });
      });
    });

    qa('[data-edit-approve]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-edit-approve');
        if (!window.confirm(
          '通过「' + slug + '」的修改？\n\n' +
          '通过后线上文章立即替换为新版本；' +
          '如果没点过「看改动」，建议先看一眼再决定。'
        )) return;
        btn.disabled = true;
        reviewEdit(slug, 'approve').catch(function () { btn.disabled = false; });
      });
    });

    qa('[data-edit-reject]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-edit-reject');
        var row = btn.closest('[data-edit-row]');
        if (!row) return;
        openRejectForm(slug, row, {
          colspan: 4,
          placeholder: '驳回理由（会发给作者，例如「和现有文章重复」「链接失效」）',
          onConfirm: function (note) { return reviewEdit(slug, 'reject', note); },
        });
      });
    });
  }

  /* ---------------- 评论管理 ---------------- */

  /* 反垃圾打点（B17）：只展示评分与命中项，不替管理员下判断 */
  var SPAM_FLAG_LABEL = {
    banned_word: '敏感词',
    link: '含链接',
    repeat: '重复刷屏',
    burst: '短时高频',
    same_ip: '同 IP 多次',
    no_ua: '无 UA',
    manual: '人工标垃圾',
    short: '过短',
    cyrillic: '西里尔字母',
    keyword: '关键词',
  };

  function riskCell(item) {
    var score = Number(item.spam_score || 0);
    if (!score) return '<td class="admin-cell__sub">—</td>';
    var flags = Array.isArray(item.spam_flags) ? item.spam_flags : [];
    var labels = flags.map(function (flag) {
      return SPAM_FLAG_LABEL[flag] || flag;
    });
    var cls = score >= 7 ? 'status-badge--rejected' : 'status-badge--pending';
    return (
      '<td>' +
      '<span class="status-badge ' + cls + '">风险 ' + esc(String(score)) + '</span>' +
      (labels.length ? '<div class="admin-cell__sub">' + esc(labels.join(' · ')) + '</div>' : '') +
      (item.ua_family ? '<div class="admin-cell__sub mono">' + esc(item.ua_family) + '</div>' : '') +
      '</td>'
    );
  }

  function commentRow(item) {
    var status = item.status || 'visible';
    var pending = status === 'pending';
    var visible = status === 'visible';
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
    /* 敏感词命中提示：留在内容下面，审核时不用再去猜为什么被标 */
    var flag = item.flag_reason
      ? '<div class="admin-cell__flag">⚠ ' + esc(item.flag_reason) + '</div>'
      : '';
    return (
      '<tr data-comment-row="' + esc(item.id) + '">' +
      pickCell('comments', item.id) +
      '<td><div class="admin-cell__title">' + esc(item.author_name || '匿名读者') + '</div>' +
      parentReply +
      '<div class="admin-cell__sub mono">' + esc(item.post_slug) + '</div></td>' +
      '<td class="admin-cell__text">' + esc(item.content) + flag + '</td>' +
      riskCell(item) +
      '<td class="admin-cell__sub">' + esc(C.formatDateTime(item.created_at)) + '</td>' +
      '<td>' + commentStatusBadge(status) + '</td>' +
      '<td class="admin-cell__actions">' +
      (pending
        ? '<button class="btn btn--primary btn--sm" type="button" data-comment-toggle="' + esc(item.id) + '" data-next="visible">通过</button>'
        : '<button class="btn btn--ghost btn--sm" type="button" data-comment-toggle="' + esc(item.id) + '" data-next="' +
          (visible ? 'hidden' : 'visible') + '">' + (visible ? '隐藏' : '恢复') + '</button>') +
      (Number(item.spam_score || 0) > 0
        ? '<button class="btn btn--ghost btn--sm" type="button" data-comment-ham="' + esc(item.id) +
          '" title="判为正常：清除风险分并恢复显示">非垃圾</button>'
        : '') +
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
      : emptyRow(7, filtered ? '这个筛选下没有评论' : '还没有评论',
                 filtered ? '换个关键词或状态试试。' : '读者发评论后会出现在这里等你过审。');
    bindCommentActions();
    notifyExtList('comments', list);
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

    /* 判为正常（B17）：清掉风险分并恢复显示。走 admin_bulk 的 ham 分支，
       这样「清分」的动作只在一处实现，人工与批量不会有分歧。 */
    qa('[data-comment-ham]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        api(C.db().rpc('admin_bulk', {
          p_kind: 'comments',
          p_action: 'ham',
          p_ids: [String(btn.getAttribute('data-comment-ham'))],
        }), '操作失败').then(function (data) {
          if (!data || data.ok !== true) throw new Error('操作未生效');
          toast('已标记为非垃圾并恢复显示');
          return Promise.all([loadComments(), loadStats()]);
        }).catch(function () {}).then(function () {
          btn.disabled = false;
        });
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

  /* ---------------- 敏感词 / 频率限制提示 ---------------- */

  /** 拉取敏感词清单并渲染成可删除的标签。
   *  命中敏感词不会自动隐藏评论，只是给待审列表加一条「为什么被标」的理由；
   *  真正的第一道闸门是「所有新评论默认 pending」。 */
  function loadCommentWords() {
    if (!wordListEl) return Promise.resolve([]);
    return api(C.db().rpc('admin_comment_words'), '敏感词加载失败').then(function (data) {
      var words = Array.isArray(data) ? data : [];
      wordListEl.innerHTML = words.length
        ? words.map(function (word) {
            return (
              '<button class="chip chip--removable" type="button" data-word-remove="' + esc(word) +
              '" title="点击移除">' + esc(word) + '<span class="chip__x" aria-hidden="true">×</span></button>'
            );
          }).join('')
        : '<span class="admin-empty">还没有敏感词。加几个常见的引流词，命中后会在待审列表里标红提示。</span>';
      bindWordActions();
      return words;
    });
  }

  function bindWordActions() {
    qa('[data-word-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var word = btn.getAttribute('data-word-remove');
        if (!window.confirm('移除敏感词「' + word + '」？\n移除后命中的评论不再被标记。')) return;
        btn.disabled = true;
        api(C.db().rpc('admin_remove_comment_word', { p_word: word }), '移除失败')
          .then(function (res) {
            var r = res && typeof res === 'object' ? res : {};
            if (r.ok === false) throw new Error('移除失败');
            toast('已移除「' + word + '」');
            return loadCommentWords();
          })
          .catch(function () { btn.disabled = false; });
      });
    });
  }

  if (wordAddBtn && wordInput) {
    var submitWord = function () {
      var word = (wordInput.value || '').trim();
      if (!word) {
        toast('先输入要拦截的词');
        wordInput.focus();
        return;
      }
      wordAddBtn.disabled = true;
      api(C.db().rpc('admin_add_comment_word', { p_word: word }), '添加失败')
        .then(function (res) {
          var r = res && typeof res === 'object' ? res : {};
          if (r.ok === false) throw new Error(r.error === 'empty' ? '请填写要拦截的词' : '添加失败');
          toast('已添加「' + r.word + '」');
          wordInput.value = '';
          return loadCommentWords();
        })
        .catch(function () {})
        .then(function () { wordAddBtn.disabled = false; });
    };
    wordAddBtn.addEventListener('click', submitWord);
    wordInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitWord();
      }
    });
  }

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
      : user.status === 'deleted'
        ? '<span class="status-badge status-badge--hidden">已注销</span>'
        : '<span class="status-badge status-badge--published">正常</span>';
    var roleBadge = user.is_admin
      ? '<span class="status-badge status-badge--admin">管理员</span>'
      : user.is_editor
        ? '<span class="status-badge status-badge--editor">编辑</span>'
        : '<span class="status-badge">普通用户</span>';

    /* 两步验证（B13）：管理员可以帮忘记验证器的同事关掉，避免「人锁在外面」 */
    var totpCell = user.totp_enabled
      ? '<span class="status-badge status-badge--published">已开启</span>' +
        (user.is_admin && !user.is_self
          ? '<button class="btn btn--ghost btn--xs" type="button" data-user-totp-off="' + esc(uid) + '">重置</button>'
          : '')
      : '<span class="admin-cell__sub">未开启</span>';

    /* 编辑角色开关（B11）：能审稿、能管评论，但看不到用户与导出 */
    var editorBtn = user.is_admin || user.is_self
      ? ''
      : '<button class="btn btn--ghost btn--xs" type="button" data-user-editor="' + esc(uid) +
        '" data-next="' + (user.is_editor ? 'false' : 'true') + '" ' +
        'title="编辑可审核稿件与管理评论，但看不到用户管理、导出与备份">' +
        (user.is_editor ? '取消编辑' : '设为编辑') + '</button>';

    /* 邮箱状态：是否已验证 + 是否有待站长处理的变更申请（M5 / M9） */
    var emailCell =
      (user.email_verified_at
        ? '<span class="status-badge status-badge--published">已验证</span>'
        : '<span class="status-badge">未验证</span>') +
      (user.pending_email
        ? '<div class="admin-cell__sub">申请改为 <span class="mono">' + esc(user.pending_email) +
          '</span>（待处理）</div>'
        : '');

    /* 改稿权限：管理员天然具备（函数里 is_admin() 短路），无需再授；授了也没意义 */
    var canPublish = user.can_publish === true;
    var publishCell;
    if (user.is_admin) {
      publishCell = '<span class="status-badge status-badge--admin" title="管理员改稿一律直接生效">管理员默认</span>';
    } else if (user.is_self) {
      publishCell = '<span class="admin-cell__sub">—</span>';
    } else {
      publishCell =
        '<button class="btn btn--' + (canPublish ? 'ghost' : 'primary') + ' btn--sm" type="button" ' +
        'data-user-can-publish="' + esc(uid) + '" data-next="' + (canPublish ? 'false' : 'true') + '" ' +
        'title="授权后该用户修改已发布文章无需审核，改完立即上线">' +
        (canPublish ? '已授权 · 收回' : '授权直接改稿') + '</button>';
    }

    var actions;
    if (user.is_self) {
      actions = '<span class="admin-cell__sub">当前登录账号</span>';
    } else {
      actions =
        '<button class="btn btn--ghost btn--sm" type="button" data-user-toggle="' + esc(uid) +
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
      pickCell('users', uid) +
      '<td><div class="admin-cell__user">' + avatar +
      '<div><div class="admin-cell__title">' + esc(name) +
      (user.is_self ? ' <span class="admin-tag">我</span>' : '') + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(uid) + '</div></div></div></td>' +
      '<td class="admin-cell__sub mono">' + esc(email || '—') + '</td>' +
      '<td>' + emailCell + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td>' + roleBadge + editorBtn + '</td>' +
      '<td>' + publishCell + '</td>' +
      '<td>' + totpCell + '</td>' +
      '<td class="admin-cell__sub">' + esc(String(user.post_count || 0)) + ' 篇</td>' +
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
        : emptyRow(12, filtered ? '没有匹配的账号' : '还没有用户注册',
                   filtered ? '换个关键词或角色试试。' : '第一位注册的读者会出现在这里。');
      bindUserActions(list);
      notifyExtList('users', list);
      renderPager(userPagerEl, usersState, loadUsers);
      return list;
    });
  }

  function bindUserActions(list) {
    /* 注意：这里必须用 data-user-toggle，不能用 data-user-status ——
       工具条里的筛选 <select data-user-status> 先于表格出现，
       选择筛选项时浏览器会在 select 上冒泡 click，属性同名会把筛选当按钮点。 */
    qa('[data-user-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-user-toggle');
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

    qa('[data-user-editor]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-user-editor');
        var next = btn.getAttribute('data-next') === 'true';
        if (!window.confirm(
          next
            ? '把该账号设为「编辑」？\n\n编辑可以审核稿件、管理评论与举报，但看不到用户管理、数据导出与备份。'
            : '取消该账号的编辑角色？'
        )) return;
        btn.disabled = true;
        api(C.db().rpc('admin_set_flags', { p_owner: uid, p_can_publish: null, p_is_editor: next }), '设置失败')
          .then(function (data) {
            var res = data && typeof data === 'object' ? data : {};
            if (res.ok === false) throw new Error('操作未生效：' + (res.error || '未知错误'));
            toast(next ? '已设为编辑' : '已取消编辑角色');
            return loadUsers();
          })
          .catch(function () {})
          .then(function () { btn.disabled = false; });
      });
    });

    /* 救援：帮忙关掉无法自拔的 2FA（B13）。只在管理员看别人时出现 */
    qa('[data-user-totp-off]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-user-totp-off');
        if (!window.confirm('关闭该账号的两步验证？\n\n用于对方丢失验证器又没法登录的场景；关闭后请提醒对方重新绑定。')) return;
        btn.disabled = true;
        api(C.db().rpc('admin_disable_totp', { p_owner: uid }), '重置失败')
          .then(function (data) {
            var res = data && typeof data === 'object' ? data : {};
            if (res.ok === false) throw new Error('重置失败：' + (res.error || '未知错误'));
            toast('已关闭该账号的两步验证');
            return loadUsers();
          })
          .catch(function () {})
          .then(function () { btn.disabled = false; });
      });
    });

    qa('[data-user-can-publish]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-user-can-publish');
        var next = btn.getAttribute('data-next') === 'true';
        if (!window.confirm(
          next
            ? '授权该用户「直接改稿」？\n\n他/她修改已发布文章后会立即生效，不再经过你审核。'
            : '收回该用户的「直接改稿」权限？\n\n收回后他/她的修改会转为待审，线上仍显示旧版本。'
        )) return;
        btn.disabled = true;
        api(C.db().rpc('admin_set_can_publish', { p_owner: uid, p_can: next }), '设置失败')
          .then(function (data) {
            var res = data && typeof data === 'object' ? data : {};
            if (res.ok === false) throw new Error('操作未生效（该账号可能不存在）');
            toast(next ? '已授权直接改稿' : '已收回改稿权限');
            return loadUsers();
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

  /* ---------------- 举报与邮箱变更申请（M13 / M5） ----------------
     两件事放同一个面板：都要站长人工处理，且都有站内通知兜底。
       · 举报：读者在文章页提交 → 这里处理（已处理 / 不予处理）→ 自动回通知举报人
       · 邮箱变更：云平台不开放改邮箱接口，用户在个人中心提交申请，
         站长去云控制台改完再回来点「已完成」，用户会收到通知
   */

  var REPORT_REASONS = {
    spam: '垃圾信息',
    abuse: '辱骂攻击',
    ad: '广告引流',
    illegal: '违法违规',
    offtopic: '与内容无关',
    other: '其他',
  };

  var REPORT_STATUS = {
    open: { label: '待处理', cls: 'status-badge--pending' },
    resolved: { label: '已处理', cls: 'status-badge--published' },
    dismissed: { label: '已忽略', cls: 'status-badge--hidden' },
  };

  function commentSnippet(text) {
    var value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return value.length > 80 ? value.slice(0, 80) + '…' : value;
  }

  function reportRow(item) {
    var status = REPORT_STATUS[item.status] || { label: item.status, cls: '' };
    var actions =
      item.status === 'open'
        ? '<button class="btn btn--primary btn--sm" type="button" data-report-resolve="' + item.id +
          '" data-action="resolved">已处理</button>' +
          '<button class="btn btn--ghost btn--sm" type="button" data-report-resolve="' + item.id +
          '" data-action="dismissed">不予处理</button>'
        : '<span class="admin-cell__sub">' + esc(item.handle_note || '—') + '</span>';
    return (
      '<tr data-report-row="' + item.id + '">' +
      pickCell('reports', item.id) +
      '<td class="admin-cell__sub">' + esc(item.reporter_name || '读者') + '</td>' +
      '<td><div class="admin-cell__title">' + esc(item.comment_author || '—') + '</div>' +
      '<div class="admin-cell__sub">' + esc(commentSnippet(item.comment_content)) + '</div>' +
      (item.post_slug ? '<div class="admin-cell__sub mono">' + esc(item.post_slug) + '</div>' : '') +
      '</td>' +
      '<td>' + esc(REPORT_REASONS[item.reason] || item.reason || '其他') +
      (item.note ? '<div class="admin-cell__sub">' + esc(item.note) + '</div>' : '') + '</td>' +
      '<td class="admin-cell__sub">' + esc(C.formatDateTime(item.created_at)) + '</td>' +
      '<td><span class="status-badge ' + status.cls + '">' + esc(status.label) + '</span></td>' +
      '<td class="admin-cell__actions">' + actions + '</td>' +
      '</tr>'
    );
  }

  function loadReports() {
    if (!reportsBody) return Promise.resolve(null);
    return api(
      C.db().rpc('admin_reports_page', {
        p_status: reportsState.status === 'all' ? null : reportsState.status,
        p_limit: reportsState.pageSize,
        p_offset: (reportsState.page - 1) * reportsState.pageSize,
      }),
      '举报列表加载失败'
    ).then(function (data) {
      var page = pageRows(data, '举报列表加载失败');
      var list = page.rows || [];
      var total = Number(page.total) || 0;
      var totalPages = Math.max(1, Math.ceil(total / reportsState.pageSize));
      if (reportsState.page > totalPages) {
        reportsState.page = totalPages;
        return loadReports();
      }
      reportsState.total = total;
      setText(reportOpenEl, page.open || 0);
      setText(q('[data-stat-open-reports]'), page.open || 0);
      reportsBody.innerHTML = list.length
        ? list.map(reportRow).join('')
        : emptyRow(7, reportsState.status === 'open' ? '没有待处理的举报' : '没有符合条件的举报',
                   reportsState.status === 'open' ? '读者举报后会出现在这里。' : '换个状态筛选试试。');
      bindReportActions();
      notifyExtList('reports', list);
      renderPager(reportPagerEl, reportsState, loadReports);
      return list;
    });
  }

  function bindReportActions() {
    qa('[data-report-resolve]', reportsBody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-report-resolve'));
        var action = btn.getAttribute('data-action');
        var note = window.prompt(
          action === 'resolved' ? '处理说明（会发给举报人，可留空）' : '不处理的理由（会发给举报人，可留空）',
          ''
        );
        if (note == null) return;
        btn.disabled = true;
        api(
          C.db().rpc('admin_resolve_report', { p_id: id, p_action: action, p_note: note || null }),
          '处理失败'
        )
          .then(function (data) {
            if (!data || data.ok !== true) throw new Error((data && data.error) || '处理失败');
            toast(action === 'resolved' ? '已标记为已处理' : '已标记为不予处理');
            return Promise.all([loadReports(), loadStats()]);
          })
          .catch(function () {
            btn.disabled = false;
          });
      });
    });
  }

  qa('[data-report-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      reportsState.status = btn.getAttribute('data-report-filter') || 'open';
      reportsState.page = 1;
      qa('[data-report-filter]').forEach(function (other) {
        other.classList.toggle('is-active', other === btn);
      });
      loadReports();
    });
  });

  function emailRequestRow(user) {
    var uid = user.owner_id || '';
    var name = user.nickname || String(user.email || '').split('@')[0] || '未命名';
    return (
      '<tr data-email-request="' + esc(uid) + '">' +
      '<td><div class="admin-cell__title">' + esc(name) + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(uid) + '</div></td>' +
      '<td class="admin-cell__sub mono">' + esc(user.email || '—') + '</td>' +
      '<td class="admin-cell__sub mono">' + esc(user.pending_email || '—') + '</td>' +
      '<td class="admin-cell__sub">' + esc(user.pending_email_note || '—') + '</td>' +
      '<td class="admin-cell__sub">' +
      esc(user.pending_email_at ? C.formatDateTime(user.pending_email_at) : '—') +
      '</td>' +
      '<td class="admin-cell__actions">' +
      '<button class="btn btn--primary btn--sm" type="button" data-email-approve="' + esc(uid) +
      '">已完成</button>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-email-reject="' + esc(uid) +
      '">驳回</button>' +
      '</td>' +
      '</tr>'
    );
  }

  /** 申请列表复用用户分页 RPC 的 p_status='email' 口径，不额外写接口。 */
  function loadEmailRequests() {
    if (!emailRequestsBody) return Promise.resolve(null);
    return api(
      C.db().rpc('admin_users_page', {
        p_search: null,
        p_status: 'email',
        p_limit: 50,
        p_offset: 0,
      }),
      '邮箱变更申请加载失败'
    ).then(function (data) {
      var page = pageRows(data, '邮箱变更申请加载失败');
      var list = page.rows || [];
      setText(emailRequestCountEl, Number(page.total) || 0);
      setText(q('[data-stat-email-requests]'), Number(page.total) || 0);
      emailRequestsBody.innerHTML = list.length
        ? list.map(emailRequestRow).join('')
        : '<tr><td colspan="6" class="admin-empty">没有待处理的邮箱变更申请。</td></tr>';
      bindEmailRequestActions();
      return list;
    });
  }

  function bindEmailRequestActions() {
    qa('[data-email-approve]', emailRequestsBody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-email-approve');
        if (!window.confirm('确认已经在云控制台把该用户的登录邮箱改好了？确定后会通知申请人。')) return;
        btn.disabled = true;
        api(
          C.db().rpc('admin_resolve_email_change', { p_owner: uid, p_action: 'approve', p_note: null }),
          '处理失败'
        )
          .then(function (data) {
            if (!data || data.ok !== true) throw new Error((data && data.error) || '处理失败');
            toast('已标记为完成，申请人会收到通知');
            return Promise.all([loadEmailRequests(), loadUsers(), loadStats()]);
          })
          .catch(function () {
            btn.disabled = false;
          });
      });
    });

    qa('[data-email-reject]', emailRequestsBody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-email-reject');
        var note = window.prompt('驳回理由（会发给申请人，可留空）', '');
        if (note == null) return;
        btn.disabled = true;
        api(
          C.db().rpc('admin_resolve_email_change', { p_owner: uid, p_action: 'reject', p_note: note || null }),
          '处理失败'
        )
          .then(function (data) {
            if (!data || data.ok !== true) throw new Error((data && data.error) || '处理失败');
            toast('已驳回，申请人会收到通知');
            return Promise.all([loadEmailRequests(), loadUsers(), loadStats()]);
          })
          .catch(function () {
            btn.disabled = false;
          });
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
      loadCommentWords(),
      loadUsers(),
      loadEmails(),
      loadReports(),
      loadEmailRequests(),
      extRefresh(),
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
