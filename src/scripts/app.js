/**
 * 站点交互脚本。
 * 纯原生 JS，无任何外部依赖，体积小、可离线运行。
 *
 * 包含：移动端菜单 / 站内搜索（Ctrl K）/ 标签筛选 /
 *      目录滚动高亮 / 代码复制 / 阅读进度 / 回到顶部 / 进场动画
 */

(function () {
  'use strict';

  var ROOT = (typeof window.__ROOT__ === 'string' ? window.__ROOT__ : '') || '';
  var doc = document;
  var $ = function (sel, ctx) {
    return (ctx || doc).querySelector(sel);
  };
  var $$ = function (sel, ctx) {
    return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel));
  };

  /* ================= 轻提示 ================= */
  var toastEl = $('[data-toast]');
  var toastTimer = null;
  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.setAttribute('data-show', '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.removeAttribute('data-show');
    }, 1900);
  }
  /* 云端脚本复用同一个提示条，避免两套实现互相打断 */
  window.__wsToast = toast;

  /* ================= 文案（V13） =================
   * 界面文案的字典与切换逻辑都在 assets/i18n.js（由 wsblog/i18n.py 生成），
   * 这里只做一个薄封装：拿不到就退回中文原文，绝不让 JS 报错影响功能。
   */
  function t(key, fallback) {
    var i18n = window.WSBlogI18n;
    if (i18n && typeof i18n.t === 'function') {
      var text = i18n.t(key);
      if (text && text !== key) return text;
    }
    return fallback == null ? key : fallback;
  }
  window.__wsT = t;

  /* ================= 移动端菜单 ================= */
  (function () {
    var toggle = $('[data-nav-toggle]');
    var panel = $('[data-mobile-nav]');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', function () {
      var open = panel.hasAttribute('data-open');
      if (open) {
        panel.removeAttribute('data-open');
        toggle.setAttribute('aria-expanded', 'false');
      } else {
        panel.setAttribute('data-open', '');
        toggle.setAttribute('aria-expanded', 'true');
      }
    });

    doc.addEventListener('click', function (e) {
      if (!panel.hasAttribute('data-open')) return;
      if (panel.contains(e.target) || toggle.contains(e.target)) return;
      panel.removeAttribute('data-open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  })();

  /* ================= 平台化快捷键提示 ================= */
  (function () {
    var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    $$('.search-trigger kbd').forEach(function (el) {
      el.textContent = isMac ? '⌘ K' : 'Ctrl K';
    });
  })();

  /* ================= 文章分享 ================= */
  (function () {
    var blocks = $$('[data-share]');
    if (!blocks.length) return;

    function canonicalUrl() {
      var link = doc.querySelector('link[rel="canonical"]');
      var href = link && link.getAttribute('href');
      return href && /^https?:/i.test(href) ? href : location.href;
    }

    function pageTitle() {
      var node = doc.querySelector('[data-post-title]');
      var title = node && node.getAttribute('data-post-title');
      if (title) return title;
      var head = doc.querySelector('.article-head__title');
      if (head && head.textContent.trim()) return head.textContent.trim();
      return (doc.title || '').split(' · ')[0] || doc.title || '';
    }

    function copyText(text, block) {
      function ok() { toast(t('common.linkCopied', '链接已复制')); }
      function fail() { toast(t('common.linkCopyFailed', '复制失败，请手动复制地址栏')); }
      function fallback() {
        try {
          var ta = doc.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
          doc.body.appendChild(ta);
          ta.select();
          var done = doc.execCommand('copy');
          doc.body.removeChild(ta);
          done ? ok() : fail();
        } catch (err) {
          fail();
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok).catch(fallback);
      } else {
        fallback();
      }
    }

    // 云文章详情页的标题是异步写入的，所以分享链接与标题在「每次交互前」重算，
    // 而不是只在加载时算一次（否则分享出去的会是「加载中…」或干脆是空标题）。
    function refresh(block) {
      var url = canonicalUrl();
      var title = pageTitle();
      var weibo = block.querySelector('[data-share-action="weibo"]');
      var x = block.querySelector('[data-share-action="x"]');
      if (weibo) {
        weibo.href =
          'https://service.weibo.com/share/share.php?url=' +
          encodeURIComponent(url) +
          '&title=' +
          encodeURIComponent(title);
      }
      if (x) {
        x.href =
          'https://twitter.com/intent/tweet?url=' +
          encodeURIComponent(url) +
          '&text=' +
          encodeURIComponent(title);
      }
      return { url: url, title: title };
    }

    blocks.forEach(function (block) {
      if (!navigator.share) {
        var nativeBtn = block.querySelector('[data-share-action="native"]');
        if (nativeBtn) nativeBtn.remove();
      }
      refresh(block);

      block.addEventListener('mouseenter', function () { refresh(block); });
      block.addEventListener('focusin', function () { refresh(block); });

      block.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-share-action]');
        if (!btn) return;
        var action = btn.getAttribute('data-share-action');
        var meta = refresh(block);

        if (action === 'copy') {
          e.preventDefault();
          copyText(meta.url);
        } else if (action === 'native') {
          e.preventDefault();
          if (navigator.share) {
            navigator.share({ title: meta.title, url: meta.url }).catch(function () {});
          }
        }
      });
    });
  })();

  /* ================= 站内搜索 ================= */
  (function () {
    var overlay = $('[data-search-overlay]');
    var input = $('[data-search-input]');
    var resultsBox = $('[data-search-results]');
    if (!overlay || !input || !resultsBox) return;

    var indexPromise = null;
    var items = [];
    var activeIndex = -1;
    var currentResults = [];

    /* 全文分片（V16）：元数据索引里只有标题 / 摘要 / 标签，正文按片按需拉。
       bodyLoaded / bodyItems 记录已经拉到的分片，bodyLoading 防止重复并发。 */
    var textShardCount = 0;
    var bodyLoaded = 0;
    var bodyLoading = false;
    var bodyByUrl = {};

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function escapeRegExp(str) {
      return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function loadIndex() {
      if (indexPromise) return indexPromise;
      indexPromise = fetch(ROOT + 'search-index.json')
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          textShardCount = parseInt(data.textShards, 10) || 0;
          items = (data.items || []).map(function (it) {
            return {
              kind: it.kind,
              title: it.title || '',
              url: it.url || '',
              summary: it.summary || '',
              tags: it.tags || [],
              date: it.date || '',
              text: '',
              // 元数据层的检索串（不含正文 —— 正文要等分片到位再补）
              haystack: (
                (it.title || '') +
                ' ' +
                (it.tags || []).join(' ') +
                ' ' +
                (it.summary || '')
              ).toLowerCase(),
              titleLower: (it.title || '').toLowerCase(),
              tagsLower: (it.tags || []).join(' ').toLowerCase()
            };
          });
          return items;
        })
        .catch(function (err) {
          console.warn('[search] 索引加载失败', err);
          items = [];
          return items;
        });
      return indexPromise;
    }

    /* ---------- 全文分片（V16） ----------
       逐片拉取，每拉到一片就把「正文命中」的结果补进当前列表。
       两处提前收手，避免把整份正文白拉一遍：
         · bodyActive 为假（没在搜索）—— 不拉；
         · 结果已经够 RESULT_LIMIT 条 —— 先不拉，等用户改了关键词再看。
       任何一片失败（404 / 断网 / SW 缓存了旧索引）直接收手，不影响已有结果。 */
    var bodyActive = false;
    var bodyProgress = null;

    function pumpBodies() {
      if (bodyLoading || !bodyActive) return;
      if (bodyLoaded >= textShardCount) return;
      if (currentResults.length >= RESULT_LIMIT) return;

      bodyLoading = true;
      fetch(ROOT + 'search-index/text-' + (bodyLoaded + 1) + '.json')
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (rows) {
          (rows || []).forEach(function (row) {
            if (row && row.url) bodyByUrl[row.url] = String(row.text || '').toLowerCase();
          });
          bodyLoaded += 1;
        })
        .catch(function () {
          /* 分片缺失就当作「没有更多正文」，别无限重试 */
          bodyLoaded = textShardCount;
        })
        .then(function () {
          bodyLoading = false;
          if (bodyProgress) bodyProgress();
          pumpBodies();
        });
    }

    function scoreItem(item, terms) {
      var score = 0;
      for (var i = 0; i < terms.length; i++) {
        var term = terms[i];
        if (item.haystack.indexOf(term) === -1) return 0; // 必须全部命中
        if (item.titleLower.indexOf(term) !== -1) score += 12;
        else if (item.tagsLower.indexOf(term) !== -1) score += 7;
        else score += 2;
      }
      // 短标题通常更相关
      score += Math.max(0, 4 - item.title.length / 14);
      return score;
    }

    function makeSnippet(item, terms) {
      /* 摘要优先；摘要是命中不了关键词（说明这条是正文命中）时用正文片段，
         否则用户看到的高亮会是空的 —— 「命中但看不出为什么命中」最劝退。 */
      var source = item.summary || '';
      var lower = source.toLowerCase();
      var found = false;
      for (var i = 0; i < terms.length; i++) {
        if (lower.indexOf(terms[i]) !== -1) { found = true; break; }
      }
      if (!found && bodyByUrl[item.url]) {
        source = bodyByUrl[item.url];
        lower = source;
      }
      var pos = -1;
      for (var j = 0; j < terms.length; j++) {
        var p = lower.indexOf(terms[j]);
        if (p !== -1 && (pos === -1 || p < pos)) pos = p;
      }
      if (pos === -1) {
        return source.slice(0, 110);
      }
      var start = Math.max(0, pos - 34);
      var end = Math.min(source.length, pos + 84);
      return (start > 0 ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '');
    }

    function highlight(text, terms) {
      var safe = escapeHtml(text);
      if (!terms.length) return safe;
      var pattern = terms.map(function (t) {
        return escapeRegExp(escapeHtml(t));
      }).filter(Boolean).join('|');
      if (!pattern) return safe;
      try {
        return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
      } catch (e) {
        return safe;
      }
    }

    /* 元数据层检索：标题 / 标签 / 摘要。命中即可立刻出结果，不等正文。 */
    function collectMeta(terms, limit) {
      var scored = [];
      for (var i = 0; i < items.length; i++) {
        var s = scoreItem(items[i], terms);
        if (s > 0) scored.push({ item: items[i], score: s });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored.slice(0, limit).map(function (r) { return r.item; });
    }

    /* 正文层检索：只在已经拉到的那几片里找，且跳过元数据已经命中的 */
    function collectBody(terms, seen, limit) {
      var hits = [];
      for (var i = 0; i < items.length && hits.length < limit; i++) {
        var item = items[i];
        if (seen[item.url]) continue;
        var body = bodyByUrl[item.url];
        if (!body) continue;
        var ok = true;
        for (var j = 0; j < terms.length; j++) {
          if (body.indexOf(terms[j]) === -1) { ok = false; break; }
        }
        if (ok) hits.push(item);
      }
      return hits;
    }

    var RESULT_LIMIT = 12;

    function paint(terms, query, searching) {
      if (!currentResults.length) {
        resultsBox.innerHTML =
          '<div class="search-empty">' + escapeHtml(t('search.noMatch', '没有找到与「{q}」相关的内容')).split('{q}').join(escapeHtml(query)) + '</div>';
        return;
      }
      var html = currentResults
        .map(function (it, idx) { return resultHtml(it, terms, idx === activeIndex); })
        .join('');
      if (searching) {
        /* 正文还在逐片到达：说清楚「还有结果在路上」，别让用户以为搜完了 */
        html += '<div class="search-note">' + escapeHtml(t('search.searchingBody', '正在检索正文…')) + '</div>';
      }
      resultsBox.innerHTML = html;
      wireResults();
    }

    function render(query) {
      var q = query.trim().toLowerCase();
      resultsBox.innerHTML = '';

      if (!q) {
        /* 没在搜索就不该继续拉正文分片 */
        bodyActive = false;
        bodyProgress = null;
        activeIndex = -1;
        currentResults = [];
        var hint = items.slice(0, 5);
        if (!hint.length) {
          resultsBox.innerHTML = '<div class="search-empty">' + escapeHtml(t('search.startTyping', '输入关键词开始搜索')) + '</div>';
          return;
        }
        resultsBox.innerHTML =
          '<div style="padding:10px 14px 6px;font:500 .68rem/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--text-faint)">' +
          escapeHtml(t('search.recent', '最近更新')) +
          '</div>' +
          hint.map(function (it) { return resultHtml(it, []); }).join('');
        wireResults();
        return;
      }

      var terms = q.split(/\s+/).filter(Boolean);
      currentResults = collectMeta(terms, RESULT_LIMIT);
      activeIndex = currentResults.length ? 0 : -1;

      /* 每来一片正文就补一次结果；闭包捕获的是**本次**的 terms / query，
         所以旧查询的补片只影响旧结果集，不会污染新查询。 */
      bodyProgress = function () {
        var seen = {};
        currentResults.forEach(function (it) { seen[it.url] = true; });
        var extra = collectBody(terms, seen, RESULT_LIMIT - currentResults.length);
        if (extra.length) {
          currentResults = currentResults.concat(extra);
          if (activeIndex === -1) activeIndex = 0;
        }
        paint(terms, query, bodyLoaded < textShardCount && currentResults.length < RESULT_LIMIT);
      };

      bodyActive = true;
      var searching = textShardCount > bodyLoaded && currentResults.length < RESULT_LIMIT;
      paint(terms, query, searching);
      pumpBodies();
    }

    function resultHtml(item, terms, isActive) {
      var kindLabel =
        item.kind === 'post'
          ? t('search.kindPost', '文章')
          : item.kind === 'cloud_post'
          ? t('search.kindCloudPost', '在线文章')
          : item.kind === 'project'
          ? t('search.kindProject', '项目')
          : t('search.kindTag', '标签');
      return (
        '<a class="search-result' + (isActive ? ' is-active' : '') + '" href="' + ROOT + item.url + '">' +
        '<p class="search-result__title">' + highlight(item.title, terms) +
        '<span class="search-kind">' + escapeHtml(kindLabel) + '</span></p>' +
        '<p class="search-result__snippet">' + highlight(makeSnippet(item, terms), terms) + '</p>' +
        '</a>'
      );
    }

    function wireResults() {
      $$('.search-result', resultsBox).forEach(function (el, idx) {
        el.addEventListener('mouseenter', function () {
          setActive(idx);
        });
      });
    }

    function setActive(idx) {
      var nodes = $$('.search-result', resultsBox);
      if (!nodes.length) return;
      activeIndex = (idx + nodes.length) % nodes.length;
      nodes.forEach(function (n, i) {
        n.classList.toggle('is-active', i === activeIndex);
      });
      var active = nodes[activeIndex];
      if (active && active.scrollIntoView) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }

    /* ---------- 地址栏同步（?q=）----------
       搜索状态写进 URL，才能「把搜索结果发给别人 / 刷新不丢 / 后退能退出搜索」。
       用 replaceState 而不是 pushState：逐字输入不该在历史里堆几十条记录，
       否则用户按后退要按上百次才能离开页面。 */
    function syncUrl(query) {
      if (!window.history || !history.replaceState) return;
      try {
        var url = new URL(window.location.href);
        var value = (query || '').trim();
        if (value) url.searchParams.set('q', value);
        else url.searchParams.delete('q');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      } catch (e) {
        /* 忽略 */
      }
    }

    function queryFromUrl() {
      try {
        return new URLSearchParams(window.location.search).get('q') || '';
      } catch (e) {
        return '';
      }
    }

    function open(prefill, skipUrl) {
      overlay.setAttribute('data-open', '');
      doc.body.style.overflow = 'hidden';
      input.value = prefill || '';
      render(input.value);
      if (!skipUrl) syncUrl(input.value);
      loadIndex().then(function () {
        if (overlay.hasAttribute('data-open')) render(input.value);
      });
      setTimeout(function () { input.focus(); }, 30);
    }

    function close(skipUrl) {
      overlay.removeAttribute('data-open');
      doc.body.style.overflow = '';
      input.value = '';
      activeIndex = -1;
      if (!skipUrl) syncUrl('');
    }

    $$('[data-search-open]').forEach(function (btn) {
      btn.addEventListener('click', function () { open(); });
    });

    // 前进 / 后退：地址栏里有 q 就开搜索并回填，没有就关掉
    window.addEventListener('popstate', function () {
      var q = queryFromUrl();
      if (q) open(q, true);
      else if (overlay.hasAttribute('data-open')) close(true);
    });

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    var debounceTimer = null;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var value = input.value;
      syncUrl(value);
      debounceTimer = setTimeout(function () { render(value); }, 90);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(activeIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(activeIndex - 1);
      } else if (e.key === 'Enter') {
        var nodes = $$('.search-result', resultsBox);
        var target = nodes[activeIndex];
        if (target && target.href) {
          e.preventDefault();
          window.location.href = target.href;
        }
      }
    });

    doc.addEventListener('keydown', function (e) {
      var isOpen = overlay.hasAttribute('data-open');
      var key = e.key;

      if ((e.ctrlKey || e.metaKey) && key && key.toLowerCase() === 'k') {
        e.preventDefault();
        isOpen ? close() : open();
        return;
      }

      if (key === 'Escape' && isOpen) {
        e.preventDefault();
        close();
        return;
      }

      if (!isOpen && key === '/') {
        var tag = (e.target && e.target.tagName) || '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !e.target.isContentEditable) {
          e.preventDefault();
          open();
        }
      }
    });

    // 支持从地址栏带参数直达搜索，例如 /index.html?q=性能
    var initialQuery = queryFromUrl();
    if (initialQuery) open(initialQuery, true);
  })();

  /* ================= 首页标签筛选 ================= */
  (function () {
    var row = $('[data-filter-row]');
    var list = $('[data-post-list]');
    if (!row || !list) return;

    var emptyState = $('[data-empty-state]');
    var items = $$('.post-item', list);

    row.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-filter]');
      if (!btn) return;

      var filter = btn.getAttribute('data-filter');
      $$('.chip', row).forEach(function (c) { c.classList.remove('is-active'); });
      btn.classList.add('is-active');

      var visible = 0;
      items.forEach(function (item) {
        var tags = (item.getAttribute('data-tags') || '').split(/\s+/);
        var match = filter === 'all' || tags.indexOf(filter) !== -1;
        item.hidden = !match;
        if (match) visible++;
      });

      if (emptyState) emptyState.hidden = visible !== 0;
    });
  })();

  /* ================= 目录滚动高亮 ================= */
  (function () {
    var toc = $('[data-toc]');
    var article = $('[data-article]');
    if (!toc || !article) return;

    var links = $$('.toc__link', toc);
    if (!links.length) return;

    var map = {};
    var headings = [];
    links.forEach(function (link) {
      var id = decodeURIComponent(link.getAttribute('href').slice(1));
      var el = doc.getElementById(id);
      if (!el) return;
      map[id] = link;
      headings.push(el);
    });
    if (!headings.length) return;

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var link = map[entry.target.id];
          if (!link) return;
          links.forEach(function (l) { l.classList.remove('is-active'); });
          link.classList.add('is-active');
        });
      },
      { rootMargin: '-72px 0px -72% 0px', threshold: 0 }
    );

    headings.forEach(function (h) { observer.observe(h); });
  })();

  /* ================= 代码复制 ================= */
  (function () {
    function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        var ta = doc.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        try {
          doc.execCommand('copy');
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          doc.body.removeChild(ta);
        }
      });
    }

    doc.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-copy]');
      if (!btn) return;

      var block = btn.closest('.code-block');
      var code = block && block.querySelector('code');
      if (!code) return;

      copyText(code.innerText).then(
        function () {
          btn.textContent = t('common.copied', '已复制');
          btn.classList.add('is-done');
          toast(t('code.copied', '代码已复制到剪贴板'));
          setTimeout(function () {
            btn.textContent = t('common.copy', '复制');
            btn.classList.remove('is-done');
          }, 1600);
        },
        function () {
          btn.textContent = t('common.copyFailedShort', '复制失败');
          setTimeout(function () { btn.textContent = t('common.copy', '复制'); }, 1600);
        }
      );
    });
  })();

  /* ================= 通用「复制某个值」按钮 =================
   * 用途：订阅页复制 RSS 地址、后台复制分享链接等。按钮上写 data-copy-value="要复制的内容"，
   * 不依赖任何 DOM 结构，比 data-copy（只认代码块）通用。
   */
  (function () {
    function fallbackCopy(text) {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      doc.body.appendChild(ta);
      ta.select();
      var done = false;
      try { done = doc.execCommand('copy'); } catch (err) { done = false; }
      doc.body.removeChild(ta);
      return done;
    }

    doc.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-copy-value]');
      if (!btn) return;
      e.preventDefault();

      var text = btn.getAttribute('data-copy-value') || '';
      if (!text) return;

      function ok() { toast(t('common.copied', '已复制')); }
      function fail() { toast(t('common.copyFailed', '复制失败，请手动复制')); }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, function () {
          fallbackCopy(text) ? ok() : fail();
        });
      } else {
        fallbackCopy(text) ? ok() : fail();
      }
    });
  })();

  /* ================= 归档：排序 + 加载更多（V2 / V3 / V15） =================
   * 数据来自第 1 页内联的 <script type="application/json" data-archive-feed>。
   * 为什么这么做：静态站的翻页是「多份 HTML」，而排序与增量展示都需要
   * 跨页数据。服务端渲染好的分页仍然在（无 JS / 爬虫走那条路），但页面
   * 里带了这份清单时，浏览器端就接管排序与「加载更多」，不再整页跳走。
   */
  (function () {
    var list = $('[data-archive-list]');
    var feedNode = doc.querySelector('[data-archive-feed]');
    var toolbar = $('[data-archive-toolbar]');
    if (!list || !feedNode) return;

    var feed = null;
    try {
      feed = JSON.parse(feedNode.textContent || '');
    } catch (err) {
      /* 数据坏了就整个跳过：服务端渲染的分页照常可用 */
      return;
    }
    if (!feed || !feed.items || !feed.items.length) return;

    var items = feed.items;
    var pageSize = feed.pageSize > 0 ? feed.pageSize : items.length;
    var shown = Math.min(pageSize, items.length);
    var order = 'latest';

    var moreBtn = $('[data-load-more]');
    var moreNote = $('[data-load-more-note]');
    var pager = $('.pagination');

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function metricBits(item) {
      var bits = [];
      if (item.views) bits.push(item.views + ' <span data-i18n="list.metricViews">' + escapeHtml(t('list.metricViews', '阅读')) + '</span>');
      if (item.likes) bits.push(item.likes + ' <span data-i18n="list.metricLikes">' + escapeHtml(t('list.metricLikes', '点赞')) + '</span>');
      if (item.comments) bits.push(item.comments + ' <span data-i18n="list.metricComments">' + escapeHtml(t('list.metricComments', '评论')) + '</span>');
      return bits.join(' · ');
    }

    function itemHtml(item) {
      var read = item.minutes
        ? '<span class="archive-item__read">' + item.minutes +
          ' <span data-i18n="common.minutes">' + escapeHtml(t('common.minutes', '分钟')) + '</span></span>'
        : '';
      return (
        '<a class="archive-item" href="' + ROOT + escapeHtml(item.url) + '" data-hot="' + (item.hot || 0) + '">' +
        '<span class="archive-item__date">' + escapeHtml(item.date) + '</span>' +
        '<span class="archive-item__title">' + escapeHtml(item.title) + '</span>' +
        read +
        '<span class="archive-item__metrics">' + metricBits(item) + '</span>' +
        '</a>'
      );
    }

    /* 当前该显示哪些条目：先按排序取整份清单，再截到 shown 条 */
    function currentItems() {
      if (order === 'hot') {
        /* 热度相同（多为 0）时用原顺序兜底，保证排序稳定、不会来回跳 */
        return items
          .map(function (item, index) { return { item: item, index: index }; })
          .sort(function (a, b) {
            return (b.item.hot || 0) - (a.item.hot || 0) || a.index - b.index;
          })
          .slice(0, shown)
          .map(function (entry) { return entry.item; });
      }
      return items.slice(0, shown);
    }

    function render() {
      var visible = currentItems();
      var groups = [];
      var index = {};
      visible.forEach(function (item) {
        var year = String(item.year || (item.date || '').slice(0, 4));
        if (!(year in index)) {
          index[year] = groups.length;
          groups.push({ year: year, items: [] });
        }
        groups[index[year]].items.push(item);
      });

      var html = groups
        .map(function (group) {
          var rows = group.items.map(function (item) { return '    ' + itemHtml(item); }).join('\n');
          var count = group.items.length;
          /* data-i18n-args 让「切语言」时这段数字也一起跟着翻译 */
          var countText = escapeHtml(t('archive.postsCount', '{n} 篇')).replace('{n}', String(count));
          return (
            '<section class="archive-year">\n' +
            '  <h2 class="archive-year__title">' + escapeHtml(group.year) + ' ' +
            '<span data-i18n="archive.postsCount" data-i18n-args="' + count + '">' +
            countText + '</span></h2>\n' +
            '  <div class="archive-list">\n' + rows + '\n  </div>\n' +
            '</section>'
          );
        })
        .join('\n');

      list.innerHTML = html || '';

      if (moreBtn) {
        if (shown < items.length) moreBtn.removeAttribute('hidden');
        else moreBtn.setAttribute('hidden', '');
      }
      if (moreNote) {
        if (shown >= items.length && items.length > pageSize) moreNote.removeAttribute('hidden');
        else moreNote.setAttribute('hidden', '');
      }
      /* 语言切换后再把新插入的节点补上翻译 */
      var i18n = window.WSBlogI18n;
      if (i18n && typeof i18n.apply === 'function') i18n.apply(i18n.lang);
    }

    function setOrder(next, persist) {
      if (next !== 'hot' && next !== 'latest') return;
      order = next;
      if (toolbar) {
        $$('[data-sort]', toolbar).forEach(function (btn) {
          var on = btn.getAttribute('data-sort') === order;
          btn.classList.toggle('is-active', on);
          btn.setAttribute('aria-checked', on ? 'true' : 'false');
        });
      }
      if (persist !== false && window.history && window.history.replaceState) {
        try {
          var url = new URL(window.location.href);
          if (order === 'hot') url.searchParams.set('sort', 'hot');
          else url.searchParams.delete('sort');
          window.history.replaceState(null, '', url.toString());
        } catch (err) {
          /* 老浏览器没有 URL 构造器：只是不能分享排序后的链接，不影响使用 */
        }
      }
      render();
    }

    if (toolbar) {
      toolbar.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-sort]');
        if (!btn) return;
        setOrder(btn.getAttribute('data-sort'));
      });
    }

    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        shown = Math.min(shown + pageSize, items.length);
        render();
      });
    }

    /* JS 接管后服务端分页就多余了（「加载更多」能一直翻到底）。
       保留链接只会让同一条内容有两个入口，藏掉它的同时不影响无 JS 场景。 */
    if (pager && items.length > pageSize) pager.setAttribute('hidden', '');

    var initial = '';
    try {
      initial = new URL(window.location.href).searchParams.get('sort') || '';
    } catch (err) {
      initial = /[?&]sort=hot/.test(window.location.search) ? 'hot' : '';
    }
    setOrder(initial === 'hot' ? 'hot' : 'latest', false);
  })();

  /* ================= 阅读进度 + 回到顶部 ================= */
  (function () {
    var bar = $('#readProgress');
    var toTop = $('[data-to-top]');

    function onScroll() {
      var top = window.scrollY || doc.documentElement.scrollTop;
      var height = doc.documentElement.scrollHeight - window.innerHeight;
      if (bar && height > 0) {
        bar.style.width = Math.min(100, Math.max(0, (top / height) * 100)) + '%';
      }
      if (toTop) {
        if (top > 560) toTop.setAttribute('data-visible', '');
        else toTop.removeAttribute('data-visible');
      }
    }

    var ticking = false;
    window.addEventListener(
      'scroll',
      function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
          onScroll();
          ticking = false;
        });
      },
      { passive: true }
    );
    onScroll();

    if (toTop) {
      toTop.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  })();

  /* ================= 进场动画 ================= */
  (function () {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var targets = $$('.reveal');
    if (!targets.length) return;

    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (t) { t.classList.add('is-in'); });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry, i) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          setTimeout(function () { el.classList.add('is-in'); }, i * 60);
          obs.unobserve(el);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
    );

    targets.forEach(function (t) { observer.observe(t); });
  })();

  /* ================= 移动端目录折叠 ================= */
  (function () {
    doc.addEventListener('click', function (e) {
      var title = e.target.closest('.toc__title');
      if (!title) return;
      var toc = title.closest('.toc');
      if (toc) toc.classList.toggle('is-open');
    });
  })();

  /* ================= 图片点击放大 ================= */
  (function () {
    doc.addEventListener('click', function (e) {
      var img = e.target.closest('.prose img');
      if (!img) return;
      var src = img.getAttribute('src');
      if (!src) return;

      var layer = doc.createElement('div');
      layer.style.cssText =
        'position:fixed;inset:0;z-index:300;background:rgba(5,7,11,.9);display:flex;align-items:center;justify-content:center;padding:4vh 4vw;cursor:zoom-out;backdrop-filter:blur(4px)';
      var big = doc.createElement('img');
      big.src = src;
      big.style.cssText = 'max-width:100%;max-height:92vh;border-radius:12px;border:1px solid #2c3644';
      layer.appendChild(big);
      layer.addEventListener('click', function () { doc.body.removeChild(layer); });
      doc.body.appendChild(layer);

      doc.addEventListener(
        'keydown',
        function esc(ev) {
          if (ev.key === 'Escape' && layer.parentNode) {
            doc.body.removeChild(layer);
            doc.removeEventListener('keydown', esc);
          }
        }
      );
    });
  })();

  /* ================= PWA：Service Worker 注册 ================= */
  (function () {
    if (!('serviceWorker' in navigator)) return;
    // 镜像域名只负责跳转到正式域名，不要在那边缓存页面 ——
    // 判断方式：canonical 指向的源和当前源不一致，就说明这是镜像。
    var canonicalLink = doc.querySelector('link[rel="canonical"]');
    var canonicalHref = canonicalLink && canonicalLink.getAttribute('href');
    if (canonicalHref) {
      try {
        if (new URL(canonicalHref, location.href).origin !== location.origin) return;
      } catch (err) {
        return;
      }
    }
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(ROOT + 'sw.js').catch(function (err) {
        console.warn('[sw] 注册失败', err && err.message);
      });
    });
  })();

  /* ================= 链接预取：缩短「点击 → 新页面出现」的等待 =================
     本站是多页静态站，每次跳转都要重新下载一份 HTML + 解析渲染。
     切换时那「白屏一下」的时长，一多半就是这段网络往返。

     做法：用户把鼠标停在站内链接上（或触摸开始）时，提前把目标 HTML 拉进浏览器缓存。
     等到真正点击时页面已在缓存里，导航几乎是瞬时的 —— 与上面的 View Transition
     叠加后，「点一下 → 新页面淡入」就连成一片，不再有中间空白。

     刻意保守的几处（这里错一步就会拖慢全站或造成无谓请求）：
     · 只预取**同源 + HTML 页面**：脚本、图片、RSS、外链、锚点、下载链接一律跳过；
     · 只在**用户有明确意图**时触发（悬停 / 触摸 / 键盘聚焦），不做「进页面就预取全部链接」那种
       一次性几十个请求的做法 —— 那会抢首屏带宽，反而更慢；
     · 悬停后**等一小会儿**再发请求：鼠标只是从链接上扫过不该触发；
     · 同一 URL 只取一次（用 Set 记账），失败静默 —— 预取是纯优化，绝不能影响正常导航；
     · 省流模式 / 慢速连接下整体关闭（saveData 或 2G）；
     · 用 `<link rel="prefetch">` 而非 fetch()：交给浏览器调度，优先级低、不占关键路径，
       且命中后能直接被后续导航复用（fetch 还要自己管 HTTP 缓存）。
     ==================================================================== */
  (function prefetchOnIntent() {
    // 支持度与「该不该省流量」的前置判断，任一不满足就整体不启用
    var conn = navigator.connection;
    if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;

    var seen = Object.create(null);
    var hoverTimer = null;
    var HOVER_DELAY = 65; // ms：略长于鼠标扫过的停留，短到几乎无感

    function shouldPrefetch(a) {
      if (!a || !a.href) return false;
      // 带 target/download/rel=external 的、锚点跳转的都不是「切换页面」
      if (a.hasAttribute('download')) return false;
      var rel = (a.getAttribute('rel') || '').toLowerCase();
      if (rel.indexOf('external') >= 0 || rel.indexOf('nofollow') >= 0) return false;
      if (a.target && a.target !== '_self') return false;

      var url;
      try {
        url = new URL(a.href, location.href);
      } catch (e) {
        return false;
      }
      if (url.origin !== location.origin) return false;
      // 纯锚点（#foo）是页内跳转，不需要新页面
      if (url.pathname === location.pathname && url.search === location.search && url.hash) return false;
      // 只预取「看起来是页面」的路径：去掉 query/hash 后以 .html 结尾或是目录
      var p = url.pathname;
      if (!/\.html?$/i.test(p) && !/\/$/.test(p)) return false;
      // 后台 / 登录 / 个人中心等需要鉴权的页面不预取：
      // 未登录时它们会先渲染登录页，预取反而没有意义，还会多打一次 RPC
      if (/\/(admin|write|account|login|notifications|preview|subscribe)\.html?$/i.test(p)) return false;
      return true;
    }

    function prefetch(a) {
      if (!shouldPrefetch(a)) return;
      var key = a.href;
      if (seen[key]) return;
      seen[key] = true;

      var link = doc.createElement('link');
      link.rel = 'prefetch';
      link.href = key;
      // as=document 让浏览器按「导航」语义处理（会被 HTTP 缓存复用）
      link.as = 'document';
      // 预取失败是常态（断网、被取消），不要冒泡成控制台报错
      link.onerror = function () {
        delete seen[key];
      };
      (doc.head || doc.documentElement).appendChild(link);
    }

    function onPointerOver(e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        prefetch(a);
      }, HOVER_DELAY);
    }

    function onIntent(e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (a) prefetch(a);
    }

    doc.addEventListener('pointerover', onPointerOver, { passive: true });
    // 触摸/键盘意图没有「悬停」阶段，直接预取（仍受 shouldPrefetch 约束）
    doc.addEventListener('touchstart', onIntent, { passive: true });
    doc.addEventListener('focusin', onIntent);
    // 指针离开链接时取消待发的预取，避免扫过一串链接触发一堆请求
    doc.addEventListener('pointerout', function () {
      clearTimeout(hoverTimer);
    }, { passive: true });
  })();

  /* ================= 静态站点提示（localhost 之外的 file:// 场景） ================= */
  (function () {
    if (window.location.protocol !== 'file:') return;
    if (!doc.querySelector('[data-search-open]')) return;
    // file:// 下 fetch 会被浏览器拦截，搜索索引无法加载，这里提前说明
    doc.addEventListener('click', function handler(e) {
      if (!e.target.closest('[data-search-open]')) return;
      doc.removeEventListener('click', handler);
      setTimeout(function () {
        toast('建议用本地服务器打开以获得完整功能');
      }, 400);
    });
  })();
})();
