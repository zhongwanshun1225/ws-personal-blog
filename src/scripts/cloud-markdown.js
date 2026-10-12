/**
 * 运行期 Markdown 渲染（对齐构建期产物）。
 *
 * 管理员在后台写的文章、以及历史评论，都是运行期才拿到正文的，
 * 所以这里复刻一遍构建期（wsblog/markdown.py）的处理规则：
 * 标题锚点、提示块、代码块外壳与复制按钮、表格滚动容器、外链图标 —— 视觉完全一致。
 *
 * 独立成文件是为了让「后台预览」与「在线文章阅读页」共用同一实现，
 * 避免两处渲染结果不一致。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  function escapeHtml(text) {
    return C.escapeHtml(text);
  }

  var CALLOUTS = {
    note: { label: '说明', icon: '◆' },
    tip: { label: '提示', icon: '✦' },
    important: { label: '重要', icon: '❢' },
    warning: { label: '注意', icon: '▲' },
    caution: { label: '警告', icon: '■' },
  };

  var LANG_LABELS = {
    js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript',
    py: 'Python', python: 'Python', bash: 'Bash', sh: 'Shell', shell: 'Shell', zsh: 'Zsh',
    powershell: 'PowerShell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI',
    css: 'CSS', scss: 'SCSS', html: 'HTML', xml: 'XML', md: 'Markdown', markdown: 'Markdown',
    sql: 'SQL', go: 'Go', rust: 'Rust', java: 'Java', c: 'C', cpp: 'C++', dockerfile: 'Dockerfile',
    diff: 'Diff', text: 'Text',
  };

  function slugify(text) {
    var value = String(text || '').trim().toLowerCase();
    value = value.replace(/[\s\u3000]+/g, '-');
    value = value.replace(/[^0-9a-z\u4e00-\u9fa5-]+/g, '');
    value = value.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    return value || 'section';
  }

  /* 去掉脚本 / 内联事件，避免云端内容把任意代码带进访客浏览器。
     管理员本身是可信任的，但账号被盗时不该连带打穿全站。 */
  function sanitize(node) {
    var banned = ['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base'];
    Array.prototype.forEach.call(node.querySelectorAll(banned.join(',')), function (el) {
      el.parentNode.removeChild(el);
    });
    Array.prototype.forEach.call(node.querySelectorAll('*'), function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name.indexOf('on') === 0) el.removeAttribute(attr.name);
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      });
    });
  }

  var usedIds = {};

  function uniqueId(base) {
    if (Object.prototype.hasOwnProperty.call(usedIds, base)) {
      usedIds[base] += 1;
      return base + '-' + usedIds[base];
    }
    usedIds[base] = 0;
    return base;
  }

  function decorate(node) {
    /* 标题：加锚点 id 与 # 链接 */
    Array.prototype.forEach.call(node.querySelectorAll('h1, h2, h3, h4, h5, h6'), function (heading) {
      var depth = Number(heading.tagName.slice(1));
      var id = uniqueId(slugify(heading.textContent));
      heading.id = id;
      if (depth >= 2 && depth <= 4) {
        var anchor = document.createElement('a');
        anchor.className = 'heading-anchor';
        anchor.href = '#' + id;
        anchor.setAttribute('aria-label', '锚点链接');
        anchor.textContent = '#';
        heading.appendChild(anchor);
      }
    });

    /* 代码块：套上带语言标签与复制按钮的外壳 */
    Array.prototype.forEach.call(node.querySelectorAll('pre > code'), function (code) {
      var pre = code.parentNode;
      var lang = '';
      var match = /(?:^|\s)language-([\w+#-]+)/.exec(code.className || '');
      if (match) lang = match[1].toLowerCase();
      var label = LANG_LABELS[lang] || (lang ? lang.toUpperCase() : 'Text');

      if (window.hljs) {
        code.classList.add('hljs');
        try {
          window.hljs.highlightElement(code);
        } catch (err) {
          /* 语言不支持时保留纯文本 */
        }
      }

      var block = document.createElement('div');
      block.className = 'code-block';
      block.setAttribute('data-lang', lang);
      block.innerHTML =
        '<div class="code-block__bar">' +
        '<span class="code-block__dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<span class="code-block__lang">' + escapeHtml(label) + '</span>' +
        '<button class="code-block__copy" type="button" data-copy aria-label="复制代码">复制</button>' +
        '</div>';

      var preWrap = document.createElement('pre');
      preWrap.className = 'code-block__pre';
      preWrap.appendChild(code);
      block.appendChild(preWrap);
      pre.parentNode.replaceChild(block, pre);
    });

    /* 提示块：> [!TIP] */
    Array.prototype.forEach.call(node.querySelectorAll('blockquote'), function (quote) {
      var first = quote.querySelector('p');
      if (!first) return;
      var match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?([\s\S]*)$/i.exec(
        first.textContent
      );
      if (!match) return;
      var kind = match[1].toLowerCase();
      var meta = CALLOUTS[kind];
      if (!meta) return;

      /* 用原始 HTML 重建首段，保留其中的行内标记 */
      var rest = match[2];
      var rebuilt = window.marked ? window.marked.parseInline(rest) : escapeHtml(rest);
      first.innerHTML = rebuilt;

      var box = document.createElement('div');
      box.className = 'callout callout--' + kind;
      box.innerHTML =
        '<div class="callout__title"><span class="callout__icon">' + meta.icon + '</span>' +
        meta.label + '</div>';
      var body = document.createElement('div');
      body.className = 'callout__body';
      while (quote.firstChild) body.appendChild(quote.firstChild);
      box.appendChild(body);
      quote.parentNode.replaceChild(box, quote);
    });

    /* 表格：套横向滚动容器 */
    Array.prototype.forEach.call(node.querySelectorAll('table'), function (table) {
      if (table.parentNode && table.parentNode.classList.contains('table-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });

    /* 外链：新窗口打开并加图标 */
    Array.prototype.forEach.call(node.querySelectorAll('a[href^="http"]'), function (link) {
      if (link.hostname === location.hostname) return;
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      var icon = document.createElement('span');
      icon.className = 'ext-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '↗';
      link.appendChild(icon);
    });
  }

  /* 从渲染结果里收集 h2/h3，生成与静态文章同款的目录 */
  function buildToc(root, target, title) {
    if (!target) return;
    var items = [];
    Array.prototype.forEach.call(root.querySelectorAll('h2, h3'), function (heading) {
      var depth = Number(heading.tagName.slice(1));
      if (depth < 2 || depth > 3) return;
      items.push({
        id: heading.id,
        text: heading.textContent.replace(/#+$/, '').trim(),
        depth: depth,
      });
    });
    /* 目录少于 3 条时意义不大，保持隐藏 */
    if (items.length < 3) {
      target.setAttribute('hidden', '');
      target.innerHTML = '';
      return;
    }
    target.removeAttribute('hidden');
    target.innerHTML =
      '<div class="toc__title">' + escapeHtml(title || 'On this page') + '</div>' +
      '<ul class="toc__list">' +
      items
        .map(function (item) {
          return (
            '<li><a class="toc__link" data-depth="' + item.depth + '" href="#' +
            escapeHtml(item.id) + '">' + escapeHtml(item.text) + '</a></li>'
          );
        })
        .join('') +
      '</ul>';
  }

  function renderMarkdown(markdown, options) {
    usedIds = {};
    var source = String(markdown || '');
    if (!window.marked) return '<p>' + escapeHtml(source).replace(/\n/g, '<br>') + '</p>';
    var html = window.marked.parse(source, { gfm: true, breaks: false });
    var holder = document.createElement('div');
    holder.innerHTML = html;
    sanitize(holder);
    decorate(holder);
    var opts = options || {};
    if (opts.tocTarget) buildToc(holder, opts.tocTarget, opts.tocTitle);
    return holder.innerHTML;
  }

  window.WSBlogCloudMarkdown = { render: renderMarkdown };
})();
