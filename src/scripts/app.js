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
      function ok() { toast('链接已复制'); }
      function fail() { toast('复制失败，请手动复制地址栏'); }
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
          items = (data.items || []).map(function (it) {
            return {
              kind: it.kind,
              title: it.title || '',
              url: it.url || '',
              summary: it.summary || '',
              tags: it.tags || [],
              text: it.text || '',
              date: it.date || '',
              // 预先拼好一个全量检索串，省去每次查询都拼接
              haystack: (
                (it.title || '') +
                ' ' +
                (it.tags || []).join(' ') +
                ' ' +
                (it.summary || '') +
                ' ' +
                (it.text || '')
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
      var source = item.summary || item.text || '';
      var lower = source.toLowerCase();
      var pos = -1;
      for (var i = 0; i < terms.length; i++) {
        var p = lower.indexOf(terms[i]);
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

    function render(query) {
      var q = query.trim().toLowerCase();
      resultsBox.innerHTML = '';

      if (!q) {
        activeIndex = -1;
        currentResults = [];
        var hint = items.slice(0, 5);
        if (!hint.length) {
          resultsBox.innerHTML = '<div class="search-empty">输入关键词开始搜索</div>';
          return;
        }
        resultsBox.innerHTML =
          '<div style="padding:10px 14px 6px;font:500 .68rem/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--text-faint)">最近更新</div>' +
          hint.map(function (it) { return resultHtml(it, []); }).join('');
        wireResults();
        return;
      }

      var terms = q.split(/\s+/).filter(Boolean);
      var scored = [];
      for (var i = 0; i < items.length; i++) {
        var s = scoreItem(items[i], terms);
        if (s > 0) scored.push({ item: items[i], score: s });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      currentResults = scored.slice(0, 12).map(function (r) { return r.item; });
      activeIndex = currentResults.length ? 0 : -1;

      if (!currentResults.length) {
        resultsBox.innerHTML =
          '<div class="search-empty">没有找到与「' + escapeHtml(query) + '」相关的内容</div>';
        return;
      }

      resultsBox.innerHTML = currentResults
        .map(function (it, idx) { return resultHtml(it, terms, idx === 0); })
        .join('');
      wireResults();
    }

    function resultHtml(item, terms, isActive) {
      var kindLabel = item.kind === 'post' ? '文章' : item.kind === 'project' ? '项目' : '标签';
      return (
        '<a class="search-result' + (isActive ? ' is-active' : '') + '" href="' + ROOT + item.url + '">' +
        '<p class="search-result__title">' + highlight(item.title, terms) +
        '<span class="search-kind">' + kindLabel + '</span></p>' +
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
          btn.textContent = '已复制';
          btn.classList.add('is-done');
          toast('代码已复制到剪贴板');
          setTimeout(function () {
            btn.textContent = '复制';
            btn.classList.remove('is-done');
          }, 1600);
        },
        function () {
          btn.textContent = '复制失败';
          setTimeout(function () { btn.textContent = '复制'; }, 1600);
        }
      );
    });
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
