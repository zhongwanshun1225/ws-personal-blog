/**
 * 管理后台 · 扩展面板（B2–B17）。
 *
 * 与 admin.js 的分工：
 *   admin.js 管原有面板（文章 / 审核 / 评论 / 举报 / 用户 / 管理员白名单 / 操作日志），
 *   本文件管后来新增的面板：批量操作、垃圾评论、媒体库、统计与访问、站点设置、
 *   通知与邮件、数据与备份、安全与健康。
 *
 * 两者只通过两个约定交互，互不感知内部实现：
 *   1. admin.js 每次列表重渲染后会调 window.WSBlogAdminExt.onList(kind, rows)，
 *      批量栏据此重算「本页可选数量」「已选是否还在本页」；
 *   2. admin.js 的 refreshAll() 会调 window.WSBlogAdminExt.refresh()。
 *
 * 该文件在 admin.js 之前加载（defer 按顺序），所以 onList 可能先于本文件定义被调用 ——
 * admin.js 里取了 window.WSBlogAdminExt 才调，尚未定义时自然跳过，首次 refresh 会补上。
 *
 * 权限边界：本文件的显隐判断只为体验服务，真正的边界在每个 RPC 自己的
 * is_admin() / is_staff() 里；前端拿到的角色（C.myRole()）只决定「哪些面板藏起来」。
 */
(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;
  var root = document.querySelector('[data-admin]');
  if (!root) return;

  var esc = C.escapeHtml;
  var toast = C.toast;

  function q(selector, scope) {
    return (scope || root).querySelector(selector);
  }

  function qa(selector, scope) {
    return Array.prototype.slice.call((scope || root).querySelectorAll(selector));
  }

  function setText(node, value) {
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function api(promise, fallbackMessage) {
    return promise.then(function (res) {
      if (res && res.error) throw res.error;
      return res && res.data;
    }).catch(function (err) {
      toast((err && err.message) || fallbackMessage || '操作失败');
      throw err;
    });
  }

  /** 服务端统一返回 {ok, error, ...}；这里把 ok=false 也当失败抛出，少写重复判断。 */
  function rpc(name, params, fallbackMessage) {
    return api(C.db().rpc(name, params || {}), fallbackMessage).then(function (data) {
      var payload = data && typeof data === 'object' ? data : {};
      if (payload.ok !== true) throw new Error(payload.error || fallbackMessage || '操作失败');
      return payload;
    });
  }

  function emptyBox(title, hint) {
    return (
      '<div class="admin-empty"><span class="admin-empty__title">' + esc(title) + '</span>' +
      (hint ? '<span class="admin-empty__hint">' + esc(hint) + '</span>' : '') + '</div>'
    );
  }

  function dt(value) {
    return value ? C.formatDateTime(value) : '—';
  }

  function csvCell(value) {
    var text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stamp() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  /** 简易确认框：涉及删除/降权时统一走这里，避免各处 window.confirm 文案不一致。 */
  function confirmDanger(message) {
    return window.confirm(message);
  }

  /* ==================================================================
   * 角色分档（B11）：编辑看不到用户管理、管理员白名单、数据导出、操作日志
   * ================================================================== */

  var ADMIN_ONLY_PANELS = ['users', 'admins', 'data', 'audit'];

  function applyRole() {
    var role = C.myRole ? C.myRole() : 'user';
    root.setAttribute('data-role', role);
    var isAdmin = role === 'admin';
    qa('[data-admin-tab]').forEach(function (btn) {
      var panel = btn.getAttribute('data-admin-tab');
      if (!isAdmin && ADMIN_ONLY_PANELS.indexOf(panel) >= 0) {
        btn.setAttribute('hidden', '');
        /* 如果当前正停在这个面板上，退回到文章管理，避免露出空壳 */
        var section = q('[data-admin-panel="' + panel + '"]');
        if (section && !section.hasAttribute('hidden')) {
          var fallback = q('[data-admin-tab="posts"]');
          if (fallback) fallback.click();
        }
      }
    });
    var hint = q('[data-admin-role-hint]');
    if (hint) {
      hint.textContent = role === 'admin' ? '管理员' : role === 'editor' ? '编辑' : '无后台权限';
    }
    return role;
  }

  /* ==================================================================
   * B2 批量操作
   * ================================================================== */

  /* 每个面板「本页可批量作用的对象」怎么取 id、能做哪些动作。
     动作名必须与 admin_bulk 里的分支一一对应。 */
  var BULK = {
    posts: {
      tbody: '[data-admin-posts]',
      ids: function (row) {
        return row.getAttribute('data-post-row') || '';
      },
      selectAll: '[data-post-select-all]',
      adminOnly: ['delete'],
      actions: [
        { action: 'publish', label: '批量发布' },
        { action: 'unpublish', label: '批量转草稿' },
        { action: 'pin', label: '置顶' },
        { action: 'unpin', label: '取消置顶' },
        { action: 'delete', label: '删除', danger: true },
      ],
    },
    comments: {
      tbody: '[data-admin-comments]',
      ids: function (row) {
        return row.getAttribute('data-comment-row') || '';
      },
      selectAll: '[data-comment-select-all]',
      actions: [
        { action: 'approve', label: '批量通过' },
        { action: 'hide', label: '批量隐藏' },
        { action: 'spam', label: '标为垃圾' },
        { action: 'ham', label: '标为非垃圾' },
        { action: 'delete', label: '删除', danger: true },
      ],
    },
    reports: {
      tbody: '[data-admin-reports]',
      ids: function (row) {
        return row.getAttribute('data-report-row') || '';
      },
      selectAll: '[data-report-select-all]',
      actions: [
        { action: 'resolve', label: '批量标记已处理' },
        { action: 'dismiss', label: '批量忽略' },
      ],
    },
    users: {
      tbody: '[data-admin-users]',
      ids: function (row) {
        return row.getAttribute('data-user-row') || '';
      },
      selectAll: '[data-user-select-all]',
      adminOnly: ['disable', 'enable'],
      actions: [
        { action: 'disable', label: '批量禁用', danger: true },
        { action: 'enable', label: '批量启用' },
      ],
    },
    spam: {
      tbody: '[data-admin-spam]',
      ids: function (row) {
        return row.getAttribute('data-spam-row') || '';
      },
      selectAll: '[data-spam-select-all]',
      /* 垃圾队列复用评论的批量动作，但 kind 仍然是 comments */
      kind: 'comments',
      actions: [
        { action: 'ham', label: '判为正常' },
        { action: 'hide', label: '批量隐藏' },
        { action: 'delete', label: '删除', danger: true },
      ],
    },
  };

  var currentPanel = 'posts';
  /* 选定状态按「面板」存，切换面板不清空 —— 但动作只作用于当前面板的选中项 */
  var picked = {};
  Object.keys(BULK).forEach(function (key) { picked[key] = {}; });

  var bulkBar = q('[data-bulkbar]');
  var bulkCountEl = q('[data-bulk-count]');
  var bulkScopeEl = q('[data-bulk-scope]');
  var bulkActionsEl = q('[data-bulk-actions]');
  var bulkClearBtn = q('[data-bulk-clear]');

  function bulkConfig() {
    return BULK[currentPanel] || null;
  }

  function selectedIds() {
    var conf = bulkConfig();
    if (!conf) return [];
    return Object.keys(picked[currentPanel] || {});
  }

  function renderBulkBar() {
    if (!bulkBar) return;
    var conf = bulkConfig();
    var ids = selectedIds();
    if (!conf || !ids.length) {
      bulkBar.setAttribute('hidden', '');
      return;
    }
    var role = C.myRole ? C.myRole() : 'user';
    var isAdmin = role === 'admin';
    bulkBar.removeAttribute('hidden');
    setText(bulkCountEl, ids.length);
    var scopeLabel = {
      posts: '文章', comments: '评论', reports: '举报', users: '用户', spam: '垃圾评论',
    }[currentPanel] || '';
    setText(bulkScopeEl, '（' + scopeLabel + '）');
    bulkActionsEl.innerHTML = conf.actions.map(function (item) {
      if (!isAdmin && conf.adminOnly && conf.adminOnly.indexOf(item.action) >= 0) return '';
      return (
        '<button class="btn ' + (item.danger ? 'btn--danger' : 'btn--ghost') + ' btn--sm" type="button" ' +
        'data-bulk-run="' + esc(item.action) + '">' + esc(item.label) + '</button>'
      );
    }).join('');
    qa('[data-bulk-run]', bulkActionsEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        runBulk(btn.getAttribute('data-bulk-run'), btn);
      });
    });
  }

  var DANGER_HINT = {
    delete: '删除后无法恢复（评论与文章都是物理删除）。',
    disable: '禁用后对方仍能登录浏览，但无法评论、点赞、收藏或修改资料。',
    unpublish: '下架后前台立即不可见，作者会收到通知。',
  };

  function runBulk(action, btn) {
    var conf = bulkConfig();
    if (!conf) return;
    var ids = selectedIds();
    if (!ids.length) return;
    var label = (conf.actions.filter(function (a) { return a.action === action; })[0] || {}).label || action;
    var count = ids.length;
    if (!confirmDanger(label + '：共 ' + count + ' 项？\n\n' + (DANGER_HINT[action] || ''))) return;
    if (btn) btn.disabled = true;
    rpc('admin_bulk', {
      p_kind: conf.kind || currentPanel,
      p_action: action,
      p_ids: ids,
    }, '批量操作失败').then(function (data) {
      toast(label + '：已处理 ' + (data.affected != null ? data.affected : count) + ' 项');
      picked[currentPanel] = {};
      syncSelectAll();
      renderBulkBar();
      refreshPanelData();
      return extRefresh();
    }).catch(function () {}).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function panelTbody() {
    var conf = bulkConfig();
    return conf ? q(conf.tbody) : null;
  }

  /** 勾选框变化后更新「已选」：只认当前面板的 tbody，避免误采其它面板的残留节点。 */
  function onPickChange(ev) {
    var input = ev.target;
    if (!input || !input.getAttribute || !input.getAttribute('data-pick')) return;
    var kind = input.getAttribute('data-pick');
    if (kind !== currentPanel && !(kind === 'comments' && currentPanel === 'spam')) return;
    var id = input.value;
    if (!picked[currentPanel]) picked[currentPanel] = {};
    if (input.checked) picked[currentPanel][id] = true;
    else delete picked[currentPanel][id];
    syncSelectAll();
    renderBulkBar();
  }

  /** 全选框 → 本页所有行；同时把「已选但已翻页离开」的项清掉，避免误操作到看不见的行。 */
  function syncSelectAll() {
    var conf = bulkConfig();
    if (!conf) return;
    var all = q(conf.selectAll);
    if (!all) return;
    var boxes = qa('input[data-pick]', q(conf.tbody) || root);
    var checked = boxes.filter(function (box) { return box.checked; }).length;
    all.checked = boxes.length > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }

  function bindSelectAll() {
    Object.keys(BULK).forEach(function (panel) {
      var conf = BULK[panel];
      var all = q(conf.selectAll);
      if (!all) return;
      all.addEventListener('change', function () {
        var tbody = q(conf.tbody);
        if (!tbody) return;
        var next = all.checked;
        if (!picked[panel]) picked[panel] = {};
        qa('input[data-pick]', tbody).forEach(function (box) {
          if (panel === currentPanel) box.checked = next;
          if (next) picked[panel][box.value] = true;
          else delete picked[panel][box.value];
        });
        if (panel === currentPanel) {
          renderBulkBar();
        }
      });
    });
  }

  root.addEventListener('change', onPickChange);

  if (bulkClearBtn) {
    bulkClearBtn.addEventListener('click', function () {
      picked[currentPanel] = {};
      var tbody = panelTbody();
      if (tbody) {
        qa('input[data-pick]', tbody).forEach(function (box) { box.checked = false; });
      }
      syncSelectAll();
      renderBulkBar();
    });
  }

  /* admin.js 每次重渲染列表后都会调这里：清空该面板的选中（DOM 已经换了）。 */
  function onList(kind, rows) {
    var panel = kind === 'comments' && currentPanel === 'spam' ? 'spam' : kind;
    if (!picked[panel]) picked[panel] = {};
    picked[panel] = {};
    if (panel === currentPanel) {
      renderBulkBar();
      syncSelectAll();
    }
    return rows;
  }

  /* ==================================================================
   * B8 排序 / 权重 / 定时（行内「排序」按钮）
   * ================================================================== */

  var flagsDialog = null;

  function openFlagsDialog(slug, btn) {
    var current = null;
    api(
      C.db().from('cloud_posts')
        .select('title, slug, pinned, weight, publish_at, status')
        .eq('slug', slug).maybeSingle(),
      '读取文章设置失败'
    ).then(function (row) {
      if (!row) throw new Error('文章不存在');
      current = row;
      showFlagsDialog(row, btn);
    }).catch(function () {});
  }

  function showFlagsDialog(row, btn) {
    if (flagsDialog) {
      flagsDialog.remove();
      document.body.classList.remove('is-modal-open');
      flagsDialog = null;
    }
    /* 复用全站通用弹窗的类名（.modal 是遮罩、.modal__panel 是卡片），
       不再另起一套，样式与其它弹窗天然一致。 */
    var box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML =
      '<div class="modal__panel" role="dialog" aria-modal="true" aria-label="排序与定时">' +
      '<h2 class="modal__title">排序与定时</h2>' +
      '<p class="modal__quote">' + esc(row.title || row.slug) + '</p>' +
      '<div class="form-grid">' +
      '<label class="field field--switch">' +
      '<input type="checkbox" data-flags-pinned' + (row.pinned ? ' checked' : '') + '>' +
      '<span class="field__label">置顶（排在列表最前）</span>' +
      '</label>' +
      '<label class="field field--full">' +
      '<span class="field__label">排序权重（-1000 ~ 1000，越大越靠前）</span>' +
      '<input class="field__input" type="number" min="-1000" max="1000" step="10" data-flags-weight ' +
      'value="' + esc(String(row.weight == null ? 0 : row.weight)) + '">' +
      '</label>' +
      '<label class="field field--full">' +
      '<span class="field__label">定时发布时间（留空 = 立即，按当前时区）</span>' +
      '<input class="field__input" type="datetime-local" data-flags-at value="' +
      esc(localInput(row.publish_at)) + '">' +
      '<span class="field__hint">' +
      '填未来时间：文章会先藏起来，到点自动上线（A3）。清空则恢复为按状态直接可见。' +
      '</span>' +
      '</label>' +
      '</div>' +
      '<div class="modal__actions">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-modal-close>取消</button>' +
      '<button class="btn btn--primary btn--sm" type="button" data-flags-save>保存</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(box);
    document.body.classList.add('is-modal-open');
    flagsDialog = box;

    function close() {
      if (flagsDialog === box) flagsDialog = null;
      document.body.classList.remove('is-modal-open');
      box.remove();
    }

    qa('[data-modal-close]', box).forEach(function (el) {
      el.addEventListener('click', close);
    });
    box.addEventListener('click', function (ev) {
      if (ev.target === box) close();
    });

    var saveBtn = q('[data-flags-save]', box);
    saveBtn.addEventListener('click', function () {
      var at = localInputToIso(q('[data-flags-at]', box).value);
      saveBtn.disabled = true;
      rpc('admin_set_post_flags', {
        p_slug: row.slug,
        p_pinned: q('[data-flags-pinned]', box).checked,
        p_weight: Number(q('[data-flags-weight]', box).value) || 0,
        /* 空串 = 显式清除定时；null 会被当成「不改」 */
        p_publish_at: at,
      }, '保存失败').then(function () {
        toast('已保存排序与定时设置');
        close();
        if (btn) btn.disabled = false;
        return extRefresh();
      }).catch(function () {
        saveBtn.disabled = false;
      });
    });
  }

  function localInput(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function localInputToIso(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    var date = new Date(text);
    return isNaN(date.getTime()) ? '' : date.toISOString();
  }

  /* 行内「排序」按钮由 admin.js 渲染，这里用事件委托接管（列表重渲染也不用重绑）。 */
  root.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-post-flags]') : null;
    if (!btn) return;
    ev.preventDefault();
    btn.disabled = true;
    openFlagsDialog(btn.getAttribute('data-post-flags'), btn);
  });

  /* ==================================================================
   * B17 垃圾评论队列
   * ================================================================== */

  var spamState = { page: 1, pageSize: 30, total: 0 };
  var spamBody = q('[data-admin-spam]');
  var spamPagerEl = q('[data-spam-pager]');
  var spamBadgeEl = q('[data-spam-badge]');

  var FLAG_LABEL = {
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

  function spamRow(item) {
    var flags = Array.isArray(item.spam_flags) ? item.spam_flags : [];
    var score = Number(item.spam_score || 0);
    var cls = score >= 7 ? 'status-badge--rejected' : 'status-badge--pending';
    return (
      '<tr data-spam-row="' + esc(item.id) + '">' +
      '<td class="admin-table__pick">' +
      '<input type="checkbox" data-pick="comments" value="' + esc(item.id) + '" aria-label="选择该评论">' +
      '</td>' +
      '<td><div class="admin-cell__title">' + esc(item.author_name || '匿名读者') + '</div>' +
      '<div class="admin-cell__sub mono">' + esc(item.post_slug) + '</div></td>' +
      '<td class="admin-cell__text">' + esc(item.content) + '</td>' +
      '<td><span class="status-badge ' + cls + '">' + esc(String(score)) + ' 分</span>' +
      (flags.length
        ? '<div class="admin-cell__sub">' + esc(flags.map(function (f) { return FLAG_LABEL[f] || f; }).join(' · ')) + '</div>'
        : '') +
      '</td>' +
      '<td class="admin-cell__sub mono">' +
      esc(item.ua_family || '未知 UA') +
      (item.ip_hint ? '<div title="IP 指纹前 12 位（不可逆，仅用于归并）">IP ' + esc(item.ip_hint) + '</div>' : '') +
      (Number(item.same_ip || 0) > 1 ? '<div>同 IP 共 ' + esc(String(item.same_ip)) + ' 条</div>' : '') +
      '</td>' +
      '<td class="admin-cell__actions">' +
      '<button class="btn btn--primary btn--sm" type="button" data-spam-ham="' + esc(item.id) + '">判为正常</button>' +
      '<button class="btn btn--ghost btn--sm" type="button" data-spam-hide="' + esc(item.id) + '">隐藏</button>' +
      '<button class="btn btn--danger btn--sm" type="button" data-spam-del="' + esc(item.id) + '">删除</button>' +
      '</td></tr>'
    );
  }

  function loadSpam() {
    if (!spamBody) return Promise.resolve(null);
    return api(C.db().rpc('admin_spam_page', {
      p_limit: spamState.pageSize,
      p_offset: (spamState.page - 1) * spamState.pageSize,
    }), '垃圾评论加载失败').then(function (data) {
      var page = data && typeof data === 'object' ? data : {};
      if (page.ok !== true) throw new Error(page.error || '垃圾评论加载失败');
      var rows = page.rows || [];
      var total = Number(page.total) || 0;
      var totalPages = Math.max(1, Math.ceil(total / spamState.pageSize));
      if (spamState.page > totalPages) {
        spamState.page = totalPages;
        return loadSpam();
      }
      spamState.total = total;
      setText(q('[data-spam-hold]'), page.hold_score);
      setText(q('[data-spam-hide]'), page.auto_hide_score);
      if (spamBadgeEl) {
        if (total > 0) {
          spamBadgeEl.textContent = String(total);
          spamBadgeEl.removeAttribute('hidden');
        } else {
          spamBadgeEl.setAttribute('hidden', '');
        }
      }
      spamBody.innerHTML = rows.length
        ? rows.map(spamRow).join('')
        : emptyRowHtml(6, '队列是空的', '有命中敏感词或高频刷屏的评论时会自动收进来。');
      renderPager(spamPagerEl, spamState, loadSpam);
      /* 队列里勾的是评论，但选中状态记在 spam 这格上 */
      picked.spam = {};
      renderBulkBar();
      syncSelectAll();
      return rows;
    });
  }

  function emptyRowHtml(colspan, title, hint) {
    return (
      '<tr><td colspan="' + colspan + '" class="admin-empty">' +
      '<span class="admin-empty__title">' + esc(title) + '</span>' +
      (hint ? '<span class="admin-empty__hint">' + esc(hint) + '</span>' : '') +
      '</td></tr>'
    );
  }

  /** 与 admin.js 的 renderPager 同口径（两份实现是有意的：ext 不依赖 admin.js 内部函数）。 */
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
        if (state.page > 1) { state.page -= 1; reload(); }
      });
    }
    if (next) {
      next.addEventListener('click', function () {
        if (state.page < totalPages) { state.page += 1; reload(); }
      });
    }
  }

  if (spamBody) {
    spamBody.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-spam-ham') || btn.getAttribute('data-spam-hide') || btn.getAttribute('data-spam-del');
      if (!id) return;
      var action = btn.hasAttribute('data-spam-ham') ? 'ham'
        : btn.hasAttribute('data-spam-hide') ? 'hide' : 'delete';
      if (action === 'delete' && !confirmDanger('删除这条评论？删除后无法恢复。')) return;
      btn.disabled = true;
      rpc('admin_bulk', { p_kind: 'comments', p_action: action, p_ids: [String(id)] }, '操作失败')
        .then(function () {
          toast(action === 'ham' ? '已判为正常' : action === 'hide' ? '已隐藏' : '已删除');
          return Promise.all([loadSpam(), loadSpamBadgeOnly()]);
        })
        .catch(function () {})
        .then(function () { btn.disabled = false; });
    });
  }

  /** 徽标口径：只关心「有多少条被打了分」，所以直接读一页拿 total 即可。 */
  function loadSpamBadgeOnly() {
    if (!spamBadgeEl) return Promise.resolve();
    return api(C.db().rpc('admin_spam_page', { p_limit: 1, p_offset: 0 }), '')
      .then(function (data) {
        var total = Number((data && data.total) || 0);
        if (total > 0) {
          spamBadgeEl.textContent = String(total);
          spamBadgeEl.removeAttribute('hidden');
        } else {
          spamBadgeEl.setAttribute('hidden', '');
        }
      })
      .catch(function () {});
  }

  /* ==================================================================
   * B7 媒体库
   * ================================================================== */

  var mediaState = { search: '', folder: '', page: 1, pageSize: 24, total: 0 };
  var mediaGrid = q('[data-media-grid]');
  var mediaPagerEl = q('[data-media-pager]');
  var mediaFoldersLoaded = false;

  function mediaCard(item) {
    var isImage = /^image\//.test(String(item.mime || '')) || /\.(png|jpe?g|gif|webp|avif)$/i.test(item.path || '');
    var thumb = isImage
      ? '<img src="' + esc(item.url) + '" alt="" loading="lazy" decoding="async">'
      : '<span class="media-card__ext">' + esc((String(item.name || item.path).split('.').pop() || '?').slice(0, 4)) + '</span>';
    return (
      '<figure class="media-card" data-media-id="' + esc(item.id) + '">' +
      '<div class="media-card__thumb">' + thumb + '</div>' +
      '<figcaption class="media-card__meta">' +
      '<span class="media-card__name" title="' + esc(item.path) + '">' + esc(item.name || item.path) + '</span>' +
      '<span class="media-card__sub">' +
      esc(window.WSBlogChart ? window.WSBlogChart.humanBytes(item.size) : String(item.size || 0)) +
      ' · ' + esc(item.folder || '未分组') +
      '</span>' +
      '</figcaption>' +
      '<div class="media-card__actions">' +
      '<button class="btn btn--ghost btn--xs" type="button" data-media-copy="' + esc(item.url) + '">复制链接</button>' +
      '<button class="btn btn--ghost btn--xs" type="button" data-media-open="' + esc(item.url) + '">打开</button>' +
      '<button class="btn btn--danger btn--xs" type="button" data-media-del="' + esc(item.id) +
      '" data-path="' + esc(item.path) + '">删除</button>' +
      '</div>' +
      '</figure>'
    );
  }

  function loadMediaFolders() {
    var sel = q('[data-media-folder]');
    if (!sel) return Promise.resolve();
    return api(C.db().rpc('media_folders'), '分组加载失败').then(function (data) {
      var rows = (data && data.rows) || [];
      var keep = sel.value;
      sel.innerHTML = '<option value="">全部分组</option>' + rows.map(function (row) {
        return '<option value="' + esc(row.folder) + '">' + esc(row.folder) + '（' + esc(String(row.count)) + '）</option>';
      }).join('');
      if (keep) sel.value = keep;
      mediaFoldersLoaded = true;
    }).catch(function () {});
  }

  function loadMedia() {
    if (!mediaGrid) return Promise.resolve(null);
    return api(C.db().rpc('media_page', {
      p_search: mediaState.search || null,
      p_folder: mediaState.folder || null,
      p_limit: mediaState.pageSize,
      p_offset: (mediaState.page - 1) * mediaState.pageSize,
    }), '媒体加载失败').then(function (data) {
      var page = data && typeof data === 'object' ? data : {};
      if (page.ok !== true) throw new Error(page.error || '媒体加载失败');
      var rows = page.rows || [];
      var total = Number(page.total) || 0;
      var totalPages = Math.max(1, Math.ceil(total / mediaState.pageSize));
      if (mediaState.page > totalPages) {
        mediaState.page = totalPages;
        return loadMedia();
      }
      mediaState.total = total;
      setText(q('[data-media-total]'), total);
      setText(q('[data-media-size]'), window.WSBlogChart ? window.WSBlogChart.humanBytes(page.total_size) : String(page.total_size || 0));
      mediaGrid.innerHTML = rows.length
        ? rows.map(mediaCard).join('')
        : emptyBox(mediaState.search || mediaState.folder ? '没有匹配的文件' : '媒体库还是空的',
                   mediaState.search || mediaState.folder ? '换个关键词或分组试试。' : '点右上角「上传图片」开始归档。');
      renderPager(mediaPagerEl, mediaState, loadMedia);
      if (!mediaFoldersLoaded) loadMediaFolders();
      return rows;
    });
  }

  if (mediaGrid) {
    mediaGrid.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      if (btn.hasAttribute('data-media-open')) {
        window.open(btn.getAttribute('data-media-open'), '_blank', 'noopener');
        return;
      }
      if (btn.hasAttribute('data-media-copy')) {
        copyText(btn.getAttribute('data-media-copy')).then(function (ok) {
          toast(ok ? '链接已复制' : '复制失败，请手动选中');
        });
        return;
      }
      if (btn.hasAttribute('data-media-del')) {
        var id = btn.getAttribute('data-media-del');
        var path = btn.getAttribute('data-path');
        if (!confirmDanger('从媒体库删除这个文件？\n\n只会删掉记录；如果文章里已经引用了它，' +
          '图片仍会显示（存储对象保留，避免文章出现坏图）。')) return;
        btn.disabled = true;
        rpc('media_delete', { p_id: Number(id) }, '删除失败').then(function () {
          toast('已从媒体库移除');
          mediaFoldersLoaded = false;
          return loadMedia();
        }).catch(function () {
          btn.disabled = false;
        });
        return;
      }
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(area);
    return Promise.resolve(ok);
  }

  var mediaSearchEl = q('[data-media-search]');
  if (mediaSearchEl) {
    var mediaTimer = null;
    mediaSearchEl.addEventListener('input', function () {
      if (mediaTimer) window.clearTimeout(mediaTimer);
      mediaTimer = window.setTimeout(function () {
        var value = mediaSearchEl.value.trim();
        if (value === mediaState.search) return;
        mediaState.search = value;
        mediaState.page = 1;
        loadMedia();
      }, 350);
    });
  }
  var mediaFolderEl = q('[data-media-folder]');
  if (mediaFolderEl) {
    mediaFolderEl.addEventListener('change', function () {
      mediaState.folder = mediaFolderEl.value || '';
      mediaState.page = 1;
      loadMedia();
    });
  }
  var mediaUploadBtn = q('[data-media-upload]');
  if (mediaUploadBtn) {
    mediaUploadBtn.addEventListener('click', function () {
      if (!window.WSBlogUpload) {
        toast('上传模块未加载');
        return;
      }
      mediaUploadBtn.disabled = true;
      window.WSBlogUpload.pickAndUpload({
        accept: 'image/*',
        folder: 'media',
        maxMB: 8,
      }).then(function (result) {
        /* 上传成功后登记进媒体库：目的是让「上传过的图」有一份可浏览的清单。
           登记失败不影响图片本身已可用，所以单独提示。 */
        return rpc('media_register', {
          p_path: result.path,
          p_url: result.url,
          p_name: result.path.split('/').pop(),
          p_mime: null,
          p_size: null,
          p_folder: mediaState.folder || 'media',
        }, '登记到媒体库失败').then(function () {
          toast('已上传并登记');
          mediaFoldersLoaded = false;
          return loadMedia();
        });
      }).catch(function (err) {
        if (err && err.message && err.message !== '未选择文件') toast(err.message);
      }).then(function () {
        mediaUploadBtn.disabled = false;
      });
    });
  }

  /* ==================================================================
   * B9 / B10 统计与访问
   * ================================================================== */

  var statsDaysEl = q('[data-stats-days]');
  var trendState = { comments: 0, posts: 0, views: 0, users: 0 };

  function loadStatsTrend() {
    var days = Number((statsDaysEl && statsDaysEl.value) || 30);
    var chart = window.WSBlogChart;
    if (!chart) return Promise.resolve();
    return api(C.db().rpc('admin_stats_trend', { p_days: days }), '趋势加载失败').then(function (data) {
      var rows = (data && data.rows) || [];
      var labels = rows.map(function (row) { return String(row.day).slice(5); });
      var sums = { comments: 0, posts: 0, views: 0, users: 0 };
      rows.forEach(function (row) {
        sums.comments += Number(row.comments || 0);
        sums.posts += Number(row.posts || 0);
        sums.views += Number(row.views || 0);
        sums.users += Number(row.users || 0);
      });
      trendState = sums;
      setText(q('[data-trend-comments]'), sums.comments);
      setText(q('[data-trend-posts]'), sums.posts);
      setText(q('[data-trend-views]'), sums.views.toLocaleString());
      setText(q('[data-trend-users]'), sums.users);
      chart.line(q('[data-stats-chart]'), {
        labels: labels,
        height: 190,
        empty: '这个区间还没有数据',
        series: [
          {
            name: '浏览量', color: 'var(--accent)',
            points: rows.map(function (row) { return Number(row.views || 0); }),
          },
          {
            name: '评论', color: 'var(--violet, #a78bfa)',
            points: rows.map(function (row) { return Number(row.comments || 0); }),
          },
          {
            name: '新用户', color: 'var(--amber, #fbbf24)',
            points: rows.map(function (row) { return Number(row.users || 0); }),
          },
        ],
      });
      return data;
    }).catch(function () {});
  }

  var TOP_COLORS = ['var(--accent)', '#60a5fa', '#a78bfa', '#fbbf24', '#fb7185'];

  function loadTopPosts() {
    var chart = window.WSBlogChart;
    if (!chart) return Promise.resolve();
    return api(C.db().rpc('admin_top_posts', { p_limit: 12 }), '热门文章加载失败').then(function (data) {
      var rows = (data && data.rows) || [];
      chart.bars(q('[data-top-posts]'), {
        empty: '还没有浏览量数据',
        rows: rows.map(function (row, index) {
          return {
            label: row.title || row.post_slug,
            value: Number(row.views || 0),
            hint: '点赞 ' + (row.likes || 0) + ' · 评论 ' + (row.comments || 0) + ' · 收藏 ' + (row.bookmarks || 0),
            color: TOP_COLORS[index % TOP_COLORS.length],
          };
        }),
      });
      return data;
    }).catch(function () {});
  }

  function loadAnalytics() {
    var days = Number((statsDaysEl && statsDaysEl.value) || 30);
    var chart = window.WSBlogChart;
    if (!chart) return Promise.resolve();
    return api(C.db().rpc('admin_analytics', { p_days: days }), '访问分析加载失败').then(function (data) {
      var payload = data && typeof data === 'object' ? data : {};
      setText(q('[data-an-pv]'), Number(payload.total_pv || 0).toLocaleString());
      setText(q('[data-an-uv]'), Number(payload.total_uv || 0).toLocaleString());
      setText(q('[data-an-bot]'), Number(payload.bot_pv || 0).toLocaleString());

      var series = payload.series || [];
      chart.line(q('[data-an-series]'), {
        labels: series.map(function (row) { return String(row.day).slice(5); }),
        height: 170,
        empty: '暂无访问记录',
        series: [
          { name: 'PV', color: 'var(--accent)', points: series.map(function (r) { return Number(r.pv || 0); }) },
          { name: 'UV', color: '#60a5fa', points: series.map(function (r) { return Number(r.uv || 0); }) },
        ],
      });
      chart.bars(q('[data-an-paths]'), {
        empty: '暂无访问记录',
        limit: 10,
        rows: (payload.paths || []).map(function (row) {
          return { label: row.path, value: Number(row.pv || 0), hint: 'UV ' + (row.uv || 0) };
        }),
      });
      chart.bars(q('[data-an-referrers]'), {
        empty: '暂无外部来源',
        rows: (payload.referrers || []).map(function (row) {
          return { label: row.host, value: Number(row.n || 0) };
        }),
      });
      chart.bars(q('[data-an-uas]'), {
        empty: '暂无记录',
        rows: (payload.uas || []).map(function (row) {
          return { label: row.family, value: Number(row.n || 0) };
        }),
      });
      return payload;
    }).catch(function () {});
  }

  if (statsDaysEl) {
    statsDaysEl.addEventListener('change', function () {
      loadStatsTrend();
      loadAnalytics();
    });
  }

  /* ==================================================================
   * B6 / B15 / B16 站点设置（含公告、维护、阈值、通知、模板）
   * ================================================================== */

  var settingsCache = { values: {}, defaults: {} };

  function settingValue(key) {
    if (Object.prototype.hasOwnProperty.call(settingsCache.values, key)) return settingsCache.values[key];
    return settingsCache.defaults[key];
  }

  /** 缺省值在 SQL 里是 {value, public} 结构，取出来用；已保存的值直接就是值本身。 */
  function defaultOf(key) {
    return settingsCache.defaults[key];
  }

  function loadSettings() {
    return api(C.db().rpc('admin_settings_get'), '站点设置加载失败').then(function (data) {
      var payload = data && typeof data === 'object' ? data : {};
      if (payload.ok !== true) throw new Error(payload.error || '站点设置加载失败');
      settingsCache.values = {};
      Object.keys(payload.rows || {}).forEach(function (key) {
        settingsCache.values[key] = payload.rows[key].value;
      });
      settingsCache.defaults = {};
      Object.keys(payload.defaults || {}).forEach(function (key) {
        var entry = payload.defaults[key] || {};
        settingsCache.defaults[key] = entry.value;
      });
      renderSettings();
      renderTemplates();
      return payload;
    }).catch(function () {});
  }

  function renderSettings() {
    /* 标量输入：data-set="key"（无 data-key） */
    qa('[data-set]', root).forEach(function (el) {
      var key = el.getAttribute('data-set');
      var sub = el.getAttribute('data-key');
      var value = settingValue(key);
      if (sub) {
        el.value = (value && value[sub] != null) ? value[sub] : '';
      } else {
        el.value = value == null ? '' : value;
      }
    });
    qa('[data-set-num]', root).forEach(function (el) {
      var value = settingValue(el.getAttribute('data-set-num'));
      el.value = value == null ? '' : value;
    });
    /* 布尔开关：data-set-bool="key"（标量）或 data-set-flag="key" data-key="sub"（对象内字段） */
    qa('[data-set-bool]', root).forEach(function (el) {
      el.checked = settingValue(el.getAttribute('data-set-bool')) === true;
    });
    qa('[data-set-flag]', root).forEach(function (el) {
      var value = settingValue(el.getAttribute('data-set-flag'));
      el.checked = !!(value && value[el.getAttribute('data-key')]);
    });
    /* 事件勾选（数组） */
    var kinds = settingValue('notify.kinds');
    var kindsWrap = q('[data-notify-kinds]');
    if (kindsWrap && Array.isArray(kinds)) {
      qa('input[type="checkbox"]', kindsWrap).forEach(function (box) {
        box.checked = kinds.indexOf(box.value) >= 0;
      });
    }
  }

  var TEMPLATE_KEYS = [
    'mail.tpl.comment', 'mail.tpl.submission', 'mail.tpl.report',
    'mail.tpl.email_request', 'mail.tpl.system',
  ];
  var activeTemplate = TEMPLATE_KEYS[0];

  function renderTemplates() {
    var subjectEl = q('[data-tpl-subject]');
    var bodyEl = q('[data-tpl-body]');
    if (!subjectEl || !bodyEl) return;
    var tpl = settingValue(activeTemplate) || {};
    subjectEl.value = tpl.subject || '';
    bodyEl.value = tpl.body || '';
  }

  qa('[data-tpl-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeTemplate = btn.getAttribute('data-tpl-tab') || TEMPLATE_KEYS[0];
      qa('[data-tpl-tab]').forEach(function (other) {
        var active = other === btn;
        other.classList.toggle('is-active', active);
        other.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderTemplates();
    });
  });

  var tplSaveBtn = q('[data-tpl-save]');
  if (tplSaveBtn) {
    tplSaveBtn.addEventListener('click', function () {
      tplSaveBtn.disabled = true;
      rpc('admin_settings_set', {
        p_key: activeTemplate,
        p_value: {
          subject: (q('[data-tpl-subject]').value || '').trim(),
          body: q('[data-tpl-body]').value || '',
        },
      }, '模板保存失败').then(function () {
        toast('模板已保存');
        return loadSettings();
      }).catch(function () {}).then(function () {
        tplSaveBtn.disabled = false;
      });
    });
  }

  var tplResetBtn = q('[data-tpl-reset]');
  if (tplResetBtn) {
    tplResetBtn.addEventListener('click', function () {
      if (!window.confirm('恢复这个模板的默认内容？')) return;
      var fallback = defaultOf(activeTemplate);
      if (!fallback) {
        toast('拿不到默认模板');
        return;
      }
      tplResetBtn.disabled = true;
      rpc('admin_settings_set', { p_key: activeTemplate, p_value: fallback }, '恢复失败')
        .then(function () {
          toast('已恢复默认');
          return loadSettings();
        })
        .catch(function () {})
        .then(function () { tplResetBtn.disabled = false; });
    });
  }

  /* 每个「保存」按钮只负责自己那块面板：收集 → 合并成整键 → 逐个写回。
     为什么不按单个输入框写：banner.announcement 是一个对象，逐字段写会互相覆盖。 */
  qa('[data-settings-save]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = btn.closest('.panel');
      if (!panel) return;
      var patch = {};

      function ensure(key) {
        if (!patch[key]) {
          var existing = settingValue(key);
          patch[key] = (existing && typeof existing === 'object' && !Array.isArray(existing))
            ? JSON.parse(JSON.stringify(existing))
            : {};
        }
        return patch[key];
      }

      qa('[data-set]', panel).forEach(function (el) {
        var key = el.getAttribute('data-set');
        var sub = el.getAttribute('data-key');
        if (sub) ensure(key)[sub] = el.value;
        else patch[key] = el.value;
      });
      qa('[data-set-num]', panel).forEach(function (el) {
        var raw = Number(el.value);
        patch[el.getAttribute('data-set-num')] = isNaN(raw) ? 0 : raw;
      });
      qa('[data-set-bool]', panel).forEach(function (el) {
        patch[el.getAttribute('data-set-bool')] = el.checked;
      });
      qa('[data-set-flag]', panel).forEach(function (el) {
        ensure(el.getAttribute('data-set-flag'))[el.getAttribute('data-key')] = el.checked;
      });
      /* 通知事件是多选数组，单独收集 */
      var kindsWrap = q('[data-notify-kinds]', panel);
      if (kindsWrap) {
        patch['notify.kinds'] = qa('input[type="checkbox"]', kindsWrap)
          .filter(function (box) { return box.checked; })
          .map(function (box) { return box.value; });
      }

      var keys = Object.keys(patch);
      if (!keys.length) return;
      btn.disabled = true;
      Promise.all(keys.map(function (key) {
        return rpc('admin_settings_set', { p_key: key, p_value: patch[key] }, '保存失败');
      })).then(function () {
        toast('已保存 ' + keys.length + ' 项设置');
        return loadSettings();
      }).catch(function () {}).then(function () {
        btn.disabled = false;
      });
    });
  });

  var genSecretBtn = q('[data-notify-gen-secret]');
  if (genSecretBtn) {
    genSecretBtn.addEventListener('click', function () {
      var bytes = new Uint8Array(24);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      var secret = Array.prototype.map.call(bytes, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
      var input = q('[data-set="notify.worker_secret"]');
      if (input) input.value = secret.slice(0, 40);
      toast('已生成，记得点保存');
    });
  }
  var copySecretBtn = q('[data-notify-copy-secret]');
  if (copySecretBtn) {
    copySecretBtn.addEventListener('click', function () {
      var input = q('[data-set="notify.worker_secret"]');
      if (!input || !input.value) {
        toast('还没有密钥');
        return;
      }
      copyText(input.value).then(function (ok) { toast(ok ? '已复制' : '复制失败'); });
    });
  }

  /* ==================================================================
   * B3 站外投递队列
   * ================================================================== */

  var outboxState = { status: 'all', page: 1, pageSize: 30, total: 0 };
  var outboxBody = q('[data-admin-outbox]');
  var outboxPagerEl = q('[data-outbox-pager]');
  var outboxBadgeEl = q('[data-outbox-badge]');

  var OUTBOX_STATE = {
    pending: { label: '待发', cls: 'status-badge--pending' },
    failed: { label: '失败', cls: 'status-badge--rejected' },
    sent: { label: '已送达', cls: 'status-badge--published' },
  };

  var OUTBOX_KIND = {
    comment: '新评论', submission: '新投稿', report: '举报',
    email_request: '邮箱申请', mention: '提及', system: '系统',
    post_approved: '投稿通过', post_rejected: '投稿未通过',
    post_pending: '待审核', post_unpublished: '已下架',
    comment_reply: '评论回复', reply: '回复',
  };

  function outboxRow(item) {
    var meta = OUTBOX_STATE[item.state] || { label: item.state, cls: '' };
    return (
      '<tr data-outbox-row="' + esc(item.id) + '">' +
      '<td class="admin-cell__sub mono">' + esc(dt(item.created_at)) + '</td>' +
      '<td>' + esc(OUTBOX_KIND[item.kind] || item.kind) + '</td>' +
      '<td><div class="admin-cell__title">' + esc(item.title) + '</div>' +
      (item.link ? '<div class="admin-cell__sub mono">' + esc(item.link) + '</div>' : '') +
      (item.last_error ? '<div class="admin-cell__flag">' + esc(String(item.last_error).slice(0, 160)) + '</div>' : '') +
      '</td>' +
      '<td><span class="status-badge ' + meta.cls + '">' + esc(meta.label) + '</span>' +
      '<div class="admin-cell__sub">第 ' + esc(String(item.attempts || 0)) + ' 次尝试</div></td>' +
      '<td class="admin-cell__sub">' + esc(item.next_try_at ? dt(item.next_try_at) : '—') + '</td>' +
      '<td class="admin-cell__actions">' +
      (item.sent_at
        ? '<span class="admin-cell__sub">' + esc(dt(item.sent_at)) + '</span>'
        : '<button class="btn btn--ghost btn--sm" type="button" data-outbox-retry="' + esc(item.id) + '">重试</button>') +
      '</td></tr>'
    );
  }

  function loadOutbox() {
    if (!outboxBody) return Promise.resolve(null);
    return api(C.db().rpc('admin_outbox_page', {
      p_status: outboxState.status === 'all' ? null : outboxState.status,
      p_limit: outboxState.pageSize,
      p_offset: (outboxState.page - 1) * outboxState.pageSize,
    }), '投递队列加载失败').then(function (data) {
      var page = data && typeof data === 'object' ? data : {};
      if (page.ok !== true) throw new Error(page.error || '投递队列加载失败');
      var rows = page.rows || [];
      var total = Number(page.total) || 0;
      var totalPages = Math.max(1, Math.ceil(total / outboxState.pageSize));
      if (outboxState.page > totalPages) {
        outboxState.page = totalPages;
        return loadOutbox();
      }
      outboxState.total = total;
      setText(q('[data-outbox-pending]'), page.pending || 0);
      setText(q('[data-outbox-failed]'), page.failed || 0);
      setText(q('[data-outbox-sent]'), page.sent || 0);
      if (outboxBadgeEl) {
        var urgent = Number(page.failed || 0) + Number(page.pending || 0);
        if (urgent > 0) {
          outboxBadgeEl.textContent = String(urgent);
          outboxBadgeEl.removeAttribute('hidden');
        } else {
          outboxBadgeEl.setAttribute('hidden', '');
        }
      }
      outboxBody.innerHTML = rows.length
        ? rows.map(outboxRow).join('')
        : emptyRowHtml(6, '队列是空的', '没部署云函数 ws-notify 时，站内通知照常，只是不会推到站外。');
      renderPager(outboxPagerEl, outboxState, loadOutbox);
      return rows;
    });
  }

  qa('[data-outbox-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      outboxState.status = btn.getAttribute('data-outbox-filter') || 'all';
      outboxState.page = 1;
      qa('[data-outbox-filter]').forEach(function (other) {
        other.classList.toggle('is-active', other === btn);
      });
      loadOutbox();
    });
  });

  if (outboxBody) {
    outboxBody.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-outbox-retry]') : null;
      if (!btn) return;
      btn.disabled = true;
      rpc('admin_outbox_retry', { p_id: Number(btn.getAttribute('data-outbox-retry')) }, '重试失败')
        .then(function () {
          toast('已重置为待发，等待下一次投递');
          return loadOutbox();
        })
        .catch(function () { btn.disabled = false; });
    });
  }

  var outboxRetryAllBtn = q('[data-outbox-retry-all]');
  if (outboxRetryAllBtn) {
    outboxRetryAllBtn.addEventListener('click', function () {
      if (!window.confirm('把所有「未送达」的消息重置为待发？\n\n失败次数会被清零，云函数下次触发时会重试。')) return;
      outboxRetryAllBtn.disabled = true;
      rpc('admin_outbox_retry', { p_id: null }, '重试失败').then(function (data) {
        toast('已重置 ' + (data.reset || 0) + ' 条');
        return loadOutbox();
      }).catch(function () {}).then(function () {
        outboxRetryAllBtn.disabled = false;
      });
    });
  }

  /* ==================================================================
   * B5 数据导出与备份
   * ================================================================== */

  var exportKindEl = q('[data-export-kind]');
  var backupState = { page: 1, pageSize: 20, total: 0 };
  var backupBody = q('[data-backup-list]');
  var backupPagerEl = q('[data-backup-pager]');

  function runExport(kind) {
    return rpc('admin_export', { p_kind: kind }, '导出失败');
  }

  function showExportPreview(payload) {
    var wrap = q('[data-export-preview]');
    var tbody = q('[data-export-tbody]');
    if (!wrap || !tbody) return;
    var counts = payload.counts || {};
    var keys = Object.keys(counts);
    wrap.removeAttribute('hidden');
    tbody.innerHTML = keys.length
      ? keys.map(function (key) {
          return '<tr><td>' + esc(key) + '</td><td>' + esc(String(counts[key])) + ' 行</td></tr>';
        }).join('')
      : emptyRowHtml(2, '没有可导出的数据', '');
  }

  var exportBtn = q('[data-export-run]');
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      var kind = (exportKindEl && exportKindEl.value) || 'all';
      exportBtn.disabled = true;
      runExport(kind).then(function (payload) {
        showExportPreview(payload);
        downloadText(
          'wsblog-export-' + kind + '-' + stamp() + '.json',
          JSON.stringify(payload, null, 2),
          'application/json'
        );
        toast('已导出');
      }).catch(function () {}).then(function () {
        exportBtn.disabled = false;
      });
    });
  }

  var exportCloudBtn = q('[data-export-to-cloud]');
  if (exportCloudBtn) {
    exportCloudBtn.addEventListener('click', function () {
      if (!window.WSBlogUpload || !window.WSBlogUpload.BUCKET) {
        toast('上传模块未加载，无法存到云端');
        return;
      }
      var kind = (exportKindEl && exportKindEl.value) || 'all';
      exportCloudBtn.disabled = true;
      runExport(kind).then(function (payload) {
        showExportPreview(payload);
        var text = JSON.stringify(payload);
        var name = 'backups/' + kind + '-' + stamp() + '.json';
        var blob = new Blob([text], { type: 'application/json' });
        var file = new File([blob], name.split('/').pop(), { type: 'application/json' });
        var bucket = C.storage().from(window.WSBlogUpload.BUCKET);
        return bucket.upload(name, file, { upsert: true, cacheControl: '3600' })
          .then(function (res) {
            if (res && res.error) throw res.error;
            var pub = bucket.getPublicUrl(name);
            var url = (pub && pub.data && pub.data.publicUrl) || '';
            return rpc('admin_backup_record', {
              p_kind: kind,
              p_path: name,
              p_url: url,
              p_size: blob.size,
              p_row_counts: payload.counts || {},
              p_note: null,
            }, '登记备份失败');
          })
          .then(function () {
            toast('已存为云端备份');
            return loadBackups();
          });
      }).catch(function () {}).then(function () {
        exportCloudBtn.disabled = false;
      });
    });
  }

  function loadBackups() {
    if (!backupBody) return Promise.resolve(null);
    return api(C.db().rpc('admin_backups_page', {
      p_limit: backupState.pageSize,
      p_offset: (backupState.page - 1) * backupState.pageSize,
    }), '备份列表加载失败').then(function (data) {
      var page = data && typeof data === 'object' ? data : {};
      if (page.ok !== true) throw new Error(page.error || '备份列表加载失败');
      var rows = page.rows || [];
      var total = Number(page.total) || 0;
      var totalPages = Math.max(1, Math.ceil(total / backupState.pageSize));
      if (backupState.page > totalPages) {
        backupState.page = totalPages;
        return loadBackups();
      }
      backupState.total = total;
      backupBody.innerHTML = rows.length
        ? rows.map(function (item) {
            return (
              '<tr>' +
              '<td class="admin-cell__sub mono">' + esc(dt(item.created_at)) + '</td>' +
              '<td>' + esc(item.kind || 'all') + '</td>' +
              '<td class="admin-cell__sub mono">' + esc(item.path || '—') + '</td>' +
              '<td class="admin-cell__sub">' +
              esc(window.WSBlogChart ? window.WSBlogChart.humanBytes(item.size) : String(item.size || 0)) +
              '</td>' +
              '<td class="admin-cell__actions">' +
              (item.url
                ? '<button class="btn btn--ghost btn--sm" type="button" data-backup-copy="' + esc(item.url) + '">复制链接</button>' +
                  '<a class="btn btn--ghost btn--sm" href="' + esc(item.url) + '" target="_blank" rel="noopener">下载</a>'
                : '') +
              '<button class="btn btn--danger btn--sm" type="button" data-backup-del="' + esc(item.id) + '">删除</button>' +
              '</td></tr>'
            );
          }).join('')
        : emptyRowHtml(5, '还没有备份', '点上面的「导出并存为云端备份」留一份。');
      renderPager(backupPagerEl, backupState, loadBackups);
      return rows;
    });
  }

  if (backupBody) {
    backupBody.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      if (btn.hasAttribute('data-backup-copy')) {
        copyText(btn.getAttribute('data-backup-copy')).then(function (ok) { toast(ok ? '已复制' : '复制失败'); });
        return;
      }
      if (btn.hasAttribute('data-backup-del')) {
        if (!confirmDanger('删除这条备份记录？\n\n存储里的文件会保留，只是不再能在后台看到。')) return;
        btn.disabled = true;
        rpc('admin_backup_delete', { p_id: Number(btn.getAttribute('data-backup-del')) }, '删除失败')
          .then(function () {
            toast('已删除记录');
            return loadBackups();
          })
          .catch(function () { btn.disabled = false; });
      }
    });
  }

  /* ==================================================================
   * B13 二次验证（TOTP）
   * ================================================================== */

  var twofaStateEl = q('[data-twofa-state]');
  var twofaDotEl = q('[data-twofa-dot]');
  var twofaActionsEl = q('[data-twofa-actions]');
  var twofaSetupEl = q('[data-twofa-setup]');
  var twofaSecretEl = q('[data-twofa-secret]');
  var twofaCodeEl = q('[data-twofa-code]');

  function renderTwofa(status) {
    var enabled = !!(status && status.enabled);
    if (twofaDotEl) twofaDotEl.className = 'twofa__dot' + (enabled ? ' is-on' : '');
    if (twofaStateEl) {
      twofaStateEl.textContent = enabled
        ? '已开启' + (status.last_verified_at ? '（上次验证 ' + dt(status.last_verified_at) + '）' : '')
        : (status && status.pending ? '未完成绑定（生成了密钥但还没确认）' : '未开启');
    }
    if (twofaActionsEl) {
      twofaActionsEl.innerHTML = enabled
        ? '<button class="btn btn--ghost btn--sm" type="button" data-twofa-disable>关闭两步验证</button>'
        : '<button class="btn btn--primary btn--sm" type="button" data-twofa-begin">开始绑定</button>';
      var beginBtn = q('[data-twofa-begin]', twofaActionsEl);
      if (beginBtn) beginBtn.addEventListener('click', beginTwofa);
      var offBtn = q('[data-twofa-disable]', twofaActionsEl);
      if (offBtn) offBtn.addEventListener('click', disableTwofa);
    }
    if (twofaSetupEl && enabled) twofaSetupEl.setAttribute('hidden', '');
  }

  function loadTwofa() {
    if (!twofaStateEl) return Promise.resolve();
    return api(C.db().rpc('totp_status'), '两步验证状态读取失败')
      .then(function (data) {
        var payload = data && typeof data === 'object' ? data : {};
        if (payload.ok !== true) throw new Error(payload.error || '读取失败');
        renderTwofa(payload);
      })
      .catch(function () {
        renderTwofa({ enabled: false });
      });
  }

  function beginTwofa() {
    return api(C.db().rpc('totp_begin'), '生成密钥失败').then(function (data) {
      var payload = data && typeof data === 'object' ? data : {};
      if (payload.ok !== true) {
        toast(payload.error === 'already_enabled' ? '已经开启过了' : (payload.error || '生成失败'));
        return;
      }
      if (twofaSecretEl) twofaSecretEl.textContent = payload.secret || '';
      if (twofaSetupEl) twofaSetupEl.removeAttribute('hidden');
      if (twofaCodeEl) {
        twofaCodeEl.value = '';
        twofaCodeEl.focus();
      }
      toast('用验证器扫入密钥后，输入 6 位动态码确认');
      return payload;
    }).catch(function () {});
  }

  var twofaCopyBtn = q('[data-twofa-copy]');
  if (twofaCopyBtn) {
    twofaCopyBtn.addEventListener('click', function () {
      var secret = twofaSecretEl && twofaSecretEl.textContent;
      if (!secret) return;
      copyText(secret).then(function (ok) { toast(ok ? '密钥已复制' : '复制失败'); });
    });
  }
  var twofaEnableBtn = q('[data-twofa-enable]');
  if (twofaEnableBtn) {
    twofaEnableBtn.addEventListener('click', function () {
      var code = (twofaCodeEl && twofaCodeEl.value || '').trim();
      if (!/^\d{6}$/.test(code)) {
        toast('请输入 6 位数字动态码');
        return;
      }
      twofaEnableBtn.disabled = true;
      api(C.db().rpc('totp_enable', { p_code: code }), '开启失败').then(function (data) {
        var payload = data && typeof data === 'object' ? data : {};
        if (payload.ok !== true) throw new Error(payload.error === 'bad_code' ? '动态码不对，再试一次' : (payload.error || '开启失败'));
        toast('两步验证已开启');
        if (twofaSetupEl) twofaSetupEl.setAttribute('hidden', '');
        return loadTwofa();
      }).catch(function (err) {
        toast((err && err.message) || '开启失败');
      }).then(function () {
        twofaEnableBtn.disabled = false;
      });
    });
  }

  function disableTwofa() {
    if (!window.confirm('关闭两步验证？\n\n敏感操作将不再要求动态码。')) return;
    api(C.db().rpc('totp_disable'), '关闭失败').then(function (data) {
      var payload = data && typeof data === 'object' ? data : {};
      if (payload.ok !== true) throw new Error(payload.error || '关闭失败');
      toast('已关闭两步验证');
      return loadTwofa();
    }).catch(function () {});
  }

  /* ==================================================================
   * B14 站点健康
   * ================================================================== */

  function healthCard(label, value, hint) {
    return (
      '<div class="health-card">' +
      '<div class="health-card__value">' + esc(String(value)) + '</div>' +
      '<div class="health-card__label">' + esc(label) + '</div>' +
      (hint ? '<div class="health-card__hint">' + esc(hint) + '</div>' : '') +
      '</div>'
    );
  }

  var ATTENTION_LABEL = {
    scheduled_due: '到点但还没翻转的定时文章',
    scheduled_upcoming: '等待上线的定时文章',
    outbox_pending: '待投递的站外消息',
    outbox_failed: '投递失败的消息',
    reports_open: '待处理的评论举报',
    email_requests: '待处理的邮箱变更申请',
    expired_previews: '已过期的预览链接（可清理）',
  };

  function loadHealth() {
    var grid = q('[data-health-grid]');
    if (!grid) return Promise.resolve();
    var chart = window.WSBlogChart;
    return api(C.db().rpc('admin_health'), '健康检查失败').then(function (data) {
      var payload = data && typeof data === 'object' ? data : {};
      if (payload.ok !== true) {
        grid.innerHTML = emptyBox('没有权限', '站点健康只对管理员开放。');
        return;
      }
      var db = payload.db || {};
      var rows = payload.rows || {};
      var cfg = payload.config || {};
      setText(q('[data-health-time]'), '检查于 ' + dt(payload.checked_at));
      grid.innerHTML = [
        healthCard('数据库体积', chart ? chart.humanBytes(db.size_bytes) : String(db.size_bytes || 0),
                   db.tables + ' 表 · ' + db.views + ' 视图 · ' + db.functions + ' 函数'),
        healthCard('文章', rows.posts_total, '已发布 ' + rows.posts_published + ' · 草稿 ' + rows.posts_draft + ' · 待审 ' + rows.posts_pending),
        healthCard('评论', rows.comments_total, '待审 ' + rows.comments_pending + ' · 有风险分 ' + rows.comments_spam),
        healthCard('用户', rows.users_total, '已禁用 ' + rows.users_disabled),
        healthCard('订阅', rows.subscribers_confirmed, '已确认的邮件订阅'),
        healthCard('媒体库', rows.media_assets, chart ? chart.humanBytes(rows.media_bytes) : ''),
        healthCard('预览链接', rows.previews_active, '仍有效的分享链接'),
        healthCard('审计记录', rows.audit_rows, '管理操作留痕'),
        healthCard('站外投递', cfg.notify_enabled ? '已启用' : '未启用',
                   cfg.webhook_set ? 'Webhook 已配置' : '还没配置 Webhook'),
        healthCard('维护模式', cfg.maintenance ? '开启中' : '关闭', cfg.announcement ? '公告条开启中' : '无公告'),
      ].join('');

      var att = payload.attention || {};
      var attWrap = q('[data-health-attention]');
      var attList = q('[data-health-attention-list]');
      if (attWrap && attList) {
        var items = Object.keys(att).filter(function (key) { return Number(att[key]) > 0; });
        if (items.length) {
          attWrap.removeAttribute('hidden');
          attList.innerHTML = items.map(function (key) {
            return '<li><strong>' + esc(String(att[key])) + '</strong> · ' + esc(ATTENTION_LABEL[key] || key) + '</li>';
          }).join('');
        } else {
          attWrap.setAttribute('hidden', '');
        }
      }

      var latest = payload.latest || {};
      var latestWrap = q('[data-health-latest]');
      var latestList = q('[data-health-latest-list]');
      if (latestWrap && latestList) {
        var lines = [];
        if (latest.audit && latest.audit.action) {
          lines.push('最近管理操作：' + (latest.audit.action || '') + ' · ' +
            (latest.audit.actor_email || '') + ' · ' + dt(latest.audit.created_at));
        }
        if (latest.comment && latest.comment.author_name) {
          lines.push('最近评论：' + latest.comment.author_name + ' · ' + dt(latest.comment.created_at));
        }
        if (latest.post && latest.post.title) {
          lines.push('最近文章：' + latest.post.title + ' · ' + dt(latest.post.created_at));
        }
        if (lines.length) {
          latestWrap.removeAttribute('hidden');
          latestList.innerHTML = lines.map(function (line) {
            return '<li>' + esc(line) + '</li>';
          }).join('');
        } else {
          latestWrap.setAttribute('hidden', '');
        }
      }
      return payload;
    }).catch(function () {
      grid.innerHTML = emptyBox('检查失败', '稍后重试。');
    });
  }

  var healthRefreshBtn = q('[data-health-refresh]');
  if (healthRefreshBtn) {
    healthRefreshBtn.addEventListener('click', function () {
      healthRefreshBtn.disabled = true;
      loadHealth().then(function () { healthRefreshBtn.disabled = false; });
    });
  }

  /** 构建信息：把「线上到底是哪次构建」也摆在健康面板旁边。 */
  function loadBuildInfo() {
    var grid = q('[data-health-grid]');
    if (!grid) return Promise.resolve();
    var rootPath = window.__ROOT__ || '/';
    return fetch(rootPath + 'assets/build-info.json')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (info) {
        if (!info) return null;
        var card = document.createElement('div');
        card.className = 'health-card';
        card.innerHTML =
          '<div class="health-card__value">' + esc(dt(info.generatedAt)) + '</div>' +
          '<div class="health-card__label">最近一次站点构建</div>' +
          '<div class="health-card__hint">用时 ' + esc(String(info.elapsedMs || 0)) + ' ms · ' +
          esc(String((info.posts && info.posts.total) || 0)) + ' 篇文章</div>';
        grid.appendChild(card);
        return info;
      })
      .catch(function () { return null; });
  }

  /* ==================================================================
   * 面板懒加载：点到哪个面板才拉哪一份数据，避免一进后台打十几个接口
   * ================================================================== */

  var LOADERS = {
    spam: function () { return Promise.all([loadSpam(), loadSettings()]); },
    media: function () { return Promise.all([loadMedia(), loadMediaFolders()]); },
    stats: function () { return Promise.all([loadStatsTrend(), loadTopPosts(), loadAnalytics()]); },
    settings: loadSettings,
    notify: function () { return Promise.all([loadSettings(), loadOutbox()]); },
    data: loadBackups,
    system: function () { return Promise.all([loadTwofa(), loadHealth(), loadBuildInfo()]); },
  };

  var loadedPanels = {};

  function activatePanel(name) {
    currentPanel = name;
    renderBulkBar();
    syncSelectAll();
    var loader = LOADERS[name];
    if (!loader) return;
    if (loadedPanels[name]) return;
    loadedPanels[name] = true;
    loader();
  }

  qa('[data-admin-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      activatePanel(btn.getAttribute('data-admin-tab'));
    });
  });

  /** 批量操作或行内操作后，把当前面板的数据重拉一遍（不重拉全部，省接口）。 */
  function refreshPanelData() {
    var loader = LOADERS[currentPanel];
    loadedPanels[currentPanel] = true;
    if (loader) return loader();
    return Promise.resolve();
  }

  /* ==================================================================
   * 对外接口：onList / refresh
   * ================================================================== */

  function refresh(postsStatus) {
    /* 统一刷新时把「已经打开过」的面板刷新一遍；没打开的不主动拉，
       这样后台的刷新按钮不会因为面板变多而变慢。 */
    var tasks = [];
    Object.keys(LOADERS).forEach(function (name) {
      if (loadedPanels[name]) tasks.push(LOADERS[name]());
    });
    if (!loadedPanels.spam) {
      /* 徽标要一直准确，即使没打开过垃圾面板 */
      tasks.push(loadSpamBadgeOnly());
    }
    return Promise.all(tasks);
  }

  window.WSBlogAdminExt = {
    onList: onList,
    refresh: refresh,
    activatePanel: activatePanel,
  };

  /* ==================================================================
   * 启动
   * ================================================================== */

  bindSelectAll();

  C.booted().then(function () {
    if (!C.isStaff || !C.isStaff()) return;
    applyRole();
    /* 默认停在文章管理，但徽标与角色相关的东西先拉一次 */
    currentPanel = 'posts';
    loadSpamBadgeOnly();
    loadOutboxBadgeOnly();
  });

  function loadOutboxBadgeOnly() {
    if (!outboxBadgeEl) return Promise.resolve();
    return api(C.db().rpc('admin_outbox_page', { p_status: null, p_limit: 1, p_offset: 0 }), '')
      .then(function (data) {
        var urgent = Number((data && data.pending) || 0) + Number((data && data.failed) || 0);
        if (urgent > 0) {
          outboxBadgeEl.textContent = String(urgent);
          outboxBadgeEl.removeAttribute('hidden');
        } else {
          outboxBadgeEl.setAttribute('hidden', '');
        }
      })
      .catch(function () {});
  }
})();
