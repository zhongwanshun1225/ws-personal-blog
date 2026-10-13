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

  /* 内容区禁用标签：能执行代码、能伪装站点 UI、或能做 DOM clobbering 的一律摘掉。
     投稿是开放的，管理员又会在后台预览投稿，所以这里必须比"只防 script"更严。 */
  var BANNED_TAGS = [
    'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
    'style', 'link', 'meta', 'base', 'template', 'noscript',
    'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'fieldset',
    'svg', 'math',
  ];

  /* 承载 URL 的属性：出现危险协议就整条摘掉（不只看 href/src）。 */
  var URL_ATTRS = [
    'href', 'src', 'srcset', 'xlink:href', 'action', 'formaction', 'poster', 'ping',
    'background', 'dynsrc', 'lowsrc', 'longdesc', 'usemap', 'manifest', 'profile',
    'archive', 'codebase', 'classid', 'cite', 'itemtype', 'data', 'srcdoc',
  ];

  /* 先剥掉控制字符与各类空白再判协议，挡掉 "java\tscript:"、"&#106;avascript:" 这类绕过 */
  function dangerousUrl(value) {
    var squashed = String(value == null ? '' : value).replace(
      /[\u0000-\u0020\u007f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g,
      ''
    );
    /* data: 只放行图片（data:image/svg+xml 在 <img> 里不能执行脚本，但仍禁止出现在链接上） */
    if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)[;,]/i.test(squashed)) return false;
    return /^(?:javascript|vbscript|data|blob|filesystem|about|chrome|jar):/i.test(squashed);
  }

  /* 去掉脚本 / 内联事件 / 危险协议，避免云端内容把任意代码带进访客浏览器。
     管理员本身是可信任的，但账号被盗、或普通用户投稿被预览时，不该连带打穿全站。

     ⚠️ 这是一个「黑名单」净化器，只作为最后一道兜底。真正安全的前提是
     调用方在使用本文件返回值之前不得再做二次 HTML 解析（见 decorate 的注释）。 */
  function sanitize(node) {
    Array.prototype.forEach.call(node.querySelectorAll(BANNED_TAGS.join(',')), function (el) {
      el.parentNode.removeChild(el);
    });
    Array.prototype.forEach.call(node.querySelectorAll('*'), function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        /* 内联事件处理器 */
        if (name.indexOf('on') === 0) {
          el.removeAttribute(attr.name);
          return;
        }
        /* id / name 可用于 DOM clobbering，正文里没有正当用途
           （标题锚点由 decorate 在净化之后追加） */
        if (name === 'id' || name === 'name') {
          el.removeAttribute(attr.name);
          return;
        }
        /* style 可做覆盖层钓鱼、也可用 CSS 外链做访问探测 */
        if (name === 'style') {
          el.removeAttribute(attr.name);
          return;
        }
        if (URL_ATTRS.indexOf(name) >= 0 && dangerousUrl(attr.value)) {
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

  /* 在**已净化**的 DOM 上摘掉首段开头的 [!TIP] 标记文本，其余子节点原样保留。
     绝不能用 innerHTML / marked 重建这一段 —— 那等于把已经清理过的内容
     再解析一次，HTML 实体会在此期间被解码成真标签，从而绕过 sanitize。
     （历史缺陷：`first.innerHTML = marked.parseInline(first.textContent)` 造成的存储型 XSS。） */
  function stripCalloutMarker(paragraph, kind) {
    var marker = new RegExp('^\\s*\\[!' + kind + '\\]\\s*\\n?', 'i');
    var walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (marker.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue.replace(marker, '');
        return;
      }
      /* 标记一定落在段落最前面的那个文本节点上；碰到非空文本就说明不在这一段 */
      if (node.nodeValue.replace(/\s+/g, '') !== '') return;
    }
  }

  function decorate(node) {
    /* 图片（V19）：marked 输出的 <img> 没有懒加载属性，正文里一堆插图时
       首屏会一起抢带宽。统一补上；已经在首屏之外的图尤其受益。 */
    Array.prototype.forEach.call(node.querySelectorAll('img'), function (img) {
      if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy');
      if (!img.getAttribute('decoding')) img.setAttribute('decoding', 'async');
    });

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
      var match = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(first.textContent);
      if (!match) return;
      var kind = match[1].toLowerCase();
      var meta = CALLOUTS[kind];
      if (!meta) return;

      /* 只就地删掉开头那截标记，不重建 HTML（详见 stripCalloutMarker 注释） */
      stripCalloutMarker(first, kind);

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

  /* ---------------- 公式 / 图表（V12） ----------------
   * 构建期（wsblog/markdown.py）会把这些抽成占位容器；这里是同一套规则的
   * 客户端版本，供「后台预览」与「云文章详情」使用 —— 两边看到的排版一致。
   *
   * 哨兵用私用区字符（U+E000 / U+E001 / U+E002 / U+E003）：
   * 它们在 Markdown 里不会自然出现，也不会被 marked 转义掉。
   */
  var SENT_L = '\uE000';
  var SENT_R = '\uE001';
  var STASH_L = '\uE002';
  var STASH_R = '\uE003';

  function extractMath(source) {
    var stash = [];
    var math = [];
    var mathSeq = 0;

    function pushStash(text) {
      stash.push(text);
      return STASH_L + (stash.length - 1) + STASH_R;
    }

    /* 1) 先保护围栏代码块与行内代码：里面的 $ 不是公式 */
    var masked = source
      .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|$)/gm, pushStash)
      .replace(/`[^`\n]*`/g, pushStash);

    /* 2) 块级 $$…$$ */
    masked = masked.replace(/\$\$(?:[ \t]*\n)?([\s\S]+?)\$\$/g, function (_all, tex) {
      var token = SENT_L + 'BM' + mathSeq++ + SENT_R;
      math.push({ token: token, tex: tex, block: true });
      return token;
    });

    /* 3) 行内 $…$：前后不能是反斜杠/空白，结尾不能直接跟数字（避免 $5 到 $9） */
    masked = masked.replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)\$(?!\d)/g, function (_all, lead, tex) {
      if (!tex.replace(/\s/g, '')) return lead + _all.slice(lead.length);
      var token = SENT_L + 'IM' + mathSeq++ + SENT_R;
      math.push({ token: token, tex: tex, block: false });
      return lead + token;
    });

    /* 4) 还原被保护起来的代码 */
    var restored = masked.replace(new RegExp(STASH_L + '(\\d+)' + STASH_R, 'g'), function (_all, idx) {
      return stash[parseInt(idx, 10)] || '';
    });
    return { source: restored, math: math };
  }

  function applyMath(html, math) {
    if (!math.length) return html;
    math.forEach(function (entry) {
      var payload = escapeHtml(entry.tex);
      if (entry.block) {
        /* 块级公式独占一段时把外层 <p> 剥掉，否则 <div> 嵌在 <p> 里会被解析器拆散 */
        html = html.replace(
          new RegExp('<p>\\s*' + entry.token + '\\s*</p>', 'g'),
          entry.token
        );
      }
      html = html.split(entry.token).join(
        entry.block
          ? '<div class="math-block" data-tex="' + payload + '" data-display="1">' + payload + '</div>'
          : '<span class="math-inline" data-tex="' + payload + '">' + payload + '</span>'
      );
    });
    return html;
  }

  /* ```mermaid 代码块（marked 已经把它渲染成 <pre><code class="language-mermaid">） */
  function transformMermaid(holder) {
    var found = false;
    Array.prototype.forEach.call(holder.querySelectorAll('pre > code'), function (code) {
      if (found) return;
      if (!/(?:^|\s)language-mermaid\b/.test(code.className || '')) return;
      var pre = code.parentNode;
      var block = document.createElement('div');
      block.className = 'mermaid-block';
      block.setAttribute('data-mermaid', '');
      block.innerHTML =
        '<div class="mermaid-block__bar">' +
        '<span class="mermaid-block__label">Mermaid</span>' +
        '<button class="mermaid-block__src-toggle" type="button" data-mermaid-toggle ' +
        'aria-expanded="false">查看源码</button>' +
        '</div>' +
        '<pre class="mermaid-block__src" data-mermaid-src></pre>' +
        '<div class="mermaid-block__out" data-mermaid-out aria-busy="true"></div>';
      /* 源码用 textContent 写入，避免把图里的标签当成 HTML */
      block.querySelector('[data-mermaid-src]').textContent = code.textContent;
      pre.parentNode.replaceChild(block, pre);
      found = true;
    });
    return found;
  }

  function renderMarkdown(markdown, options) {
    usedIds = {};
    var source = String(markdown || '');
    if (!window.marked) return '<p>' + escapeHtml(source).replace(/\n/g, '<br>') + '</p>';
    var extracted = extractMath(source);
    var html = window.marked.parse(extracted.source, { gfm: true, breaks: false });
    html = applyMath(html, extracted.math);
    var holder = document.createElement('div');
    holder.innerHTML = html;
    sanitize(holder);
    decorate(holder);
    transformMermaid(holder);
    var opts = options || {};
    if (opts.tocTarget) buildToc(holder, opts.tocTarget, opts.tocTitle);
    /* 不在这里调 WSBlogMath.scan()：此刻 HTML 还只是个字符串，没进 DOM。
       math.js 用 MutationObserver 盯着新插入的 [data-tex] / [data-mermaid]，
       调用方把返回值写进页面后会自动被接管。 */
    return holder.innerHTML;
  }

  window.WSBlogCloudMarkdown = { render: renderMarkdown };
})();
