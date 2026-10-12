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

  function renderList(posts) {
    var listEl = q('[data-cloud-post-list]', listRoot);
    var emptyEl = q('[data-cloud-empty]', listRoot);
    var countEl = q('[data-cloud-count]', listRoot);
    if (countEl) countEl.textContent = String(posts.length);

    if (!posts.length) {
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) emptyEl.removeAttribute('hidden');
      return;
    }
    if (emptyEl) emptyEl.setAttribute('hidden', '');
    if (!listEl) return;

    listEl.innerHTML = posts
      .map(function (post) {
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
      })
      .join('');
  }

  function loadList() {
    var statusEl = q('[data-cloud-status]', listRoot);
    C.db()
      .from('cloud_posts')
      .select('id, slug, title, summary, tags, content_md, published_at, created_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(60)
      .then(function (res) {
        if (res && res.error) throw res.error;
        if (statusEl) statusEl.setAttribute('hidden', '');
        renderList((res && res.data) || []);
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
    if (bodyEl) bodyEl.innerHTML = renderMarkdown(post.content_md);

    /* 交给互动模块接管（云端文章的 post_slug 统一加 cloud: 前缀） */
    if (window.WSBlogInteract) {
      window.WSBlogInteract.init('cloud:' + post.slug, post.title);
    }
  }

  function loadDetail() {
    var params = new URLSearchParams(location.search);
    var slug = (params.get('slug') || '').trim();
    if (!slug) {
      notFound('链接里没有指定文章。');
      return;
    }
    C.db()
      .from('cloud_posts')
      .select('id, slug, title, summary, tags, content_md, published_at, created_at')
      .eq('slug', slug)
      .eq('status', 'published')
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
    if (listRoot) loadList();
    if (detailRoot) loadDetail();
  });
})();
