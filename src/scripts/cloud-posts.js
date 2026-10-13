/**
 * 云端文章：列表页（posts.html）与阅读页（post.html）。
 *
 * 正文是运行期从云端拉取的，所以这里复用与构建期一致的 Markdown 渲染规则：
 * 标题锚点、提示块、代码块外壳与复制按钮、表格滚动容器、外链图标 —— 视觉上和静态文章一致。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var listRoot = document.querySelector('[data-cloud-posts]');
  var detailRoot = document.querySelector('[data-cloud-post]');
  if (!listRoot && !detailRoot) return;

  function q(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function qa(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  function escapeHtml(text) {
    return C.escapeHtml(text);
  }

  /* ---------------- Markdown 渲染 ---------------- */

  /* 具体实现在 cloud-markdown.js（后台预览与阅读页共用同一份规则） */
  function renderMarkdown(markdown) {
    return window.WSBlogCloudMarkdown.render(markdown);
  }

  /* ---------------- 工具 ---------------- */

  function formatDate(value) {
    return C.formatDate(value) || '';
  }

  function readingTime(text) {
    var length = String(text || '').replace(/\s+/g, '').length;
    return Math.max(1, Math.round(length / 350));
  }

  function tagsOf(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      return value
        .replace(/^\{|\}$/g, '')
        .split(',')
        .map(function (item) {
          return item.trim().replace(/^"|"$/g, '');
        })
        .filter(Boolean);
    }
    return [];
  }

  /* ---------------- 列表页 ---------------- */

  /* 每页条数。文章多了之后一次渲染上百张卡片会明显拖慢首屏，
     所以列表改为客户端分页，页号同步到 ?page=（可分享、可后退）。 */
  var PAGE_SIZE = 10;
  var allPosts = [];
  var currentPage = 1;

  function readPageParam() {
    try {
      var n = parseInt(new URLSearchParams(location.search).get('page'), 10);
      return n > 1 ? n : 1;
    } catch (e) {
      return 1;
    }
  }

  function syncPageParam(page) {
    if (!window.history || !history.replaceState) return;
    try {
      var url = new URL(location.href);
      if (page > 1) url.searchParams.set('page', String(page));
      else url.searchParams.delete('page');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    } catch (e) {
      /* 忽略 */
    }
  }

  function itemHtml(post) {
    var tags = tagsOf(post.tags);
    var chips = tags
      .map(function (tag) {
        return '<span class="tag">' + escapeHtml(tag) + '</span>';
      })
      .join('');
    return (
      '<li class="post-item">' +
      '<div class="post-item__link">' +
      '<div class="post-item__date">' +
      escapeHtml(formatDate(post.published_at || post.created_at)) +
      '<span>' + readingTime(post.content_md) + ' 分钟</span>' +
      '</div>' +
      '<div class="post-item__main">' +
      '<h3 class="post-item__title">' +
      '<a class="stretch-link" href="' + C.root + 'post.html?slug=' +
      encodeURIComponent(post.slug) + '">' + escapeHtml(post.title) + '</a>' +
      '</h3>' +
      '<p class="post-item__summary">' + escapeHtml(post.summary || '') + '</p>' +
      '<div class="post-item__meta">' + chips + '</div>' +
      '</div></div></li>'
    );
  }

  function renderPagination(pagerEl, totalPages) {
    if (!pagerEl) return;
    if (totalPages <= 1) {
      pagerEl.setAttribute('hidden', '');
      pagerEl.innerHTML = '';
      return;
    }
    pagerEl.removeAttribute('hidden');

    function link(page, label, rel, disabled) {
      if (disabled) return '<span class="pagination__link is-disabled">' + label + '</span>';
      return (
        '<a class="pagination__link" data-page="' + page + '"' +
        (rel ? ' rel="' + rel + '"' : '') +
        ' href="?page=' + page + '">' + label + '</a>'
      );
    }

    var numbers = [];
    for (var n = 1; n <= totalPages; n += 1) {
      if (n === 1 || n === totalPages || Math.abs(n - currentPage) <= 2) numbers.push(n);
      else if (numbers.length && numbers[numbers.length - 1] !== '…') numbers.push('…');
    }

    var parts = [link(currentPage - 1, '← 上一页', 'prev', currentPage <= 1)];
    numbers.forEach(function (n) {
      if (n === '…') parts.push('<span class="pagination__gap">…</span>');
      else if (n === currentPage)
        parts.push('<span class="pagination__link is-current" aria-current="page">' + n + '</span>');
      else parts.push(link(n, String(n), '', false));
    });
    parts.push(link(currentPage + 1, '下一页 →', 'next', currentPage >= totalPages));

    pagerEl.innerHTML = parts.join('');
  }

  function renderPage() {
    if (!listRoot) return;
    var listEl = q('[data-cloud-post-list]', listRoot);
    var emptyEl = q('[data-cloud-empty]', listRoot);
    var countEl = q('[data-cloud-count]', listRoot);
    var pagerEl = q('[data-cloud-pagination]', listRoot);

    var total = allPosts.length;
    if (countEl) countEl.textContent = String(total);

    if (!total) {
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) emptyEl.removeAttribute('hidden');
      if (pagerEl) pagerEl.setAttribute('hidden', '');
      return;
    }
    if (emptyEl) emptyEl.setAttribute('hidden', '');

    var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    var start = (currentPage - 1) * PAGE_SIZE;
    if (listEl) listEl.innerHTML = allPosts.slice(start, start + PAGE_SIZE).map(itemHtml).join('');
    renderPagination(pagerEl, totalPages);
  }

  function goToPage(page) {
    var totalPages = Math.max(1, Math.ceil(allPosts.length / PAGE_SIZE));
    var target = Math.min(Math.max(1, page), totalPages);
    if (target === currentPage) return;
    currentPage = target;
    syncPageParam(currentPage);
    renderPage();
    var head = q('.page-head', listRoot);
    if (head && head.scrollIntoView) head.scrollIntoView({ block: 'start' });
  }

  function bindPagination() {
    if (!listRoot) return;
    var pagerEl = q('[data-cloud-pagination]', listRoot);
    if (pagerEl) {
      pagerEl.addEventListener('click', function (e) {
        var link = e.target.closest('[data-page]');
        if (!link) return;
        e.preventDefault();
        goToPage(parseInt(link.getAttribute('data-page'), 10) || 1);
      });
    }
    window.addEventListener('popstate', function () {
      var page = readPageParam();
      if (page === currentPage) return;
      currentPage = page;
      renderPage();
    });
  }

  function loadList() {
    var statusEl = q('[data-cloud-status]', listRoot);
    C.db()
      .from('posts_public')
      .select('id, slug, title, summary, tags, content_md, published_at, created_at')
      .order('published_at', { ascending: false })
      .limit(200)
      .then(function (res) {
        if (res && res.error) throw res.error;
        if (statusEl) statusEl.setAttribute('hidden', '');
        allPosts = (res && res.data) || [];
        currentPage = readPageParam();
        renderPage();
      })
      .catch(function (err) {
        console.warn('[cloud-posts] 列表加载失败', err && err.message);
        if (statusEl) {
          statusEl.textContent = '文章列表加载失败，请刷新重试。';
          statusEl.removeAttribute('hidden');
        }
      });
  }

  /* ---------------- 阅读页 ---------------- */

  function notFound(message) {
    var bodyEl = q('[data-cloud-body]', detailRoot);
    var headEl = q('[data-cloud-head]', detailRoot);
    var interactEl = q('[data-interact]', detailRoot);
    if (headEl) headEl.innerHTML =
      '<span class="eyebrow">404</span>' +
      '<h1 class="article-head__title">文章不存在</h1>' +
      '<p class="article-head__summary">' + escapeHtml(message) + '</p>';
    if (bodyEl) bodyEl.innerHTML =
      '<p>这篇文章可能已被删除，或者还没有发布。</p>' +
      '<p><a class="btn btn--primary" href="' + C.root + 'posts.html">返回文章列表</a></p>';
    if (interactEl) interactEl.setAttribute('hidden', '');
    document.title = '文章不存在 · ' + document.title;
  }

  function renderDetail(post) {
    var headEl = q('[data-cloud-head]', detailRoot);
    var bodyEl = q('[data-cloud-body]', detailRoot);
    var tags = tagsOf(post.tags);
    var published = post.published_at || post.created_at;

    document.title = post.title + ' · ' + (C.config.siteName || document.title.split(' · ')[1] || '');
    var desc = document.querySelector('meta[name="description"]');
    if (desc && post.summary) desc.setAttribute('content', post.summary);

    if (headEl) {
      headEl.innerHTML =
        '<span class="eyebrow">' + escapeHtml(tags[0] || '在线发布') + '</span>' +
        '<h1 class="article-head__title">' + escapeHtml(post.title) + '</h1>' +
        '<div class="article-head__meta">' +
        /* 署名占位：昵称要另取一次（profiles_public），拿到才显示 */
        '<span data-cloud-author hidden></span>' +
        '<span class="meta-text">' + escapeHtml(formatDate(published)) + '</span>' +
        '<span class="meta-dot"></span>' +
        '<span class="meta-text">' + readingTime(post.content_md) + ' 分钟阅读</span>' +
        '<span class="meta-dot"></span>' +
        '<span class="meta-text">' + String(post.content_md || '').length + ' 字</span>' +
        '</div>' +
        (post.summary ? '<p class="article-head__summary">' + escapeHtml(post.summary) + '</p>' : '') +
        (tags.length
          ? '<div class="chip-row" style="margin-top:18px">' +
            tags.map(function (tag) { return '<span class="tag">' + escapeHtml(tag) + '</span>'; }).join('') +
            '</div>'
          : '');
    }
    if (bodyEl) {
      bodyEl.innerHTML = renderMarkdown(post.content_md, {
        tocTarget: q('[data-cloud-toc]', detailRoot),
      });
    }

    loadPostNav(post.slug);
    loadAuthor(post.author_id);
    bindTocSpy();

    /* 交给互动模块接管（云端文章的 post_slug 统一加 cloud: 前缀） */
    if (window.WSBlogInteract) {
      window.WSBlogInteract.init('cloud:' + post.slug, post.title);
    }
  }

  /** 署名：作者主页由构建期生成（authors/<owner_id>.html）。
   *  昵称在 profiles_public 视图里（不含邮箱等 PII），拿不到就干脆不署名 ——
   *  宁可少一行，也不要出现「null」或空链接。 */
  function loadAuthor(authorId) {
    var host = q('[data-cloud-author]', detailRoot);
    if (!host || !authorId) return;
    C.db()
      .from('profiles_public')
      .select('nickname')
      .eq('owner_id', String(authorId))
      .maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var name = (res && res.data && res.data.nickname) || '';
        if (!String(name).trim()) return;
        host.innerHTML =
          '<a class="author-link" href="' + C.root + 'authors/' +
          encodeURIComponent(String(authorId)) + '.html">' + escapeHtml(name) + '</a>' +
          '<span class="meta-dot"></span>';
        host.removeAttribute('hidden');
      })
      .catch(function (err) {
        console.warn('[cloud-posts] 作者昵称加载失败', err && err.message);
      });
  }

  /* 目录滚动高亮（与静态文章页 app.js 的行为一致） */
  function bindTocSpy() {
    var links = qa('.toc__link');
    if (!links.length) return;
    var headings = links
      .map(function (link) {
        return document.getElementById(link.getAttribute('href').slice(1));
      })
      .filter(Boolean);
    if (!headings.length) return;

    function update() {
      var active = headings[0];
      for (var i = 0; i < headings.length; i += 1) {
        if (headings[i].getBoundingClientRect().top <= 130) active = headings[i];
      }
      links.forEach(function (link) {
        link.classList.toggle('is-active', link.getAttribute('href') === '#' + active.id);
      });
    }

    var ticking = false;
    window.addEventListener(
      'scroll',
      function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
          update();
          ticking = false;
        });
      },
      { passive: true }
    );
    update();
  }

  /* 上一篇 / 下一篇：按发布时间排序的全部已发布文章里找前后位置 */
  function loadPostNav(slug) {
    var navEl = q('[data-cloud-postnav]', detailRoot);
    if (!navEl) return;
    C.db()
      .from('posts_public')
      .select('slug, title')
      .order('published_at', { ascending: false })
      .limit(500)
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        var index = -1;
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i].slug === slug) {
            index = i;
            break;
          }
        }
        if (index < 0) return;

        function link(item, isNext) {
          if (!item) return '';
          return (
            '<a class="post-nav__item' + (isNext ? ' post-nav__item--next' : '') +
            '" href="' + C.root + 'post.html?slug=' + encodeURIComponent(item.slug) + '">' +
            '<span class="post-nav__label">' + (isNext ? '下一篇 →' : '← 上一篇') + '</span>' +
            '<span class="post-nav__title">' + escapeHtml(item.title) + '</span></a>'
          );
        }

        /* 列表按时间倒序：上一篇 = 更新的（index-1），下一篇 = 更早的（index+1） */
        var prev = link(rows[index - 1], false);
        var next = link(rows[index + 1], true);
        if (!prev && !next) return;
        navEl.innerHTML = '<div class="post-nav">' + prev + next + '</div>';
      })
      .catch(function (err) {
        console.warn('[cloud-posts] 上下篇加载失败', err && err.message);
      });
  }

  function loadDetail() {
    var params = new URLSearchParams(location.search);
    var slug = (params.get('slug') || '').trim();
    if (!slug) {
      notFound('链接里没有指定文章。');
      return;
    }
    C.db()
      .from('posts_public')
      .select('id, slug, title, summary, tags, content_md, published_at, created_at, author_id')
      .eq('slug', slug)
      .maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        if (!res || !res.data) {
          notFound('没有找到这篇文章。');
          return;
        }
        renderDetail(res.data);
      })
      .catch(function (err) {
        console.warn('[cloud-posts] 文章加载失败', err && err.message);
        notFound('文章加载失败，请刷新重试。');
      });
  }

  /* ---------------- 启动 ---------------- */

  C.booted().then(function () {
    if (listRoot) {
      bindPagination();
      loadList();
    }
    if (detailRoot) loadDetail();
  });
})();
