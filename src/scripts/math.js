/*!
 * math.js —— 数学公式（KaTeX）与图表（Mermaid）的按需渲染（V12）
 *
 * 设计要点：
 *  1. 构建期不引入任何库。HTML 里只留下 `<div data-tex="…">` 与
 *     `<div data-mermaid><pre data-mermaid-src>…</pre></div>` 这样的空壳，
 *     真正的排版/画图全部在这里完成。没有公式的页面一个字节都不下载。
 *  2. KaTeX：真的存在 [data-tex] 才去拉 CSS + JS（约 300 KB 原始 / 100 KB 传输）。
 *  3. Mermaid：体量 2.5 MB，所以再退一步 —— 用 IntersectionObserver 等图表
 *     滚到视口附近才加载。首屏没有图表的文章不会为它付流量。
 *  4. 降级：脚本拉取失败时把公式源码原样显示出来（`data-tex` 已经是可读的
 *     LaTeX 源码），而不是留一片空白。Mermaid 失败则展开源码，读者至少能看懂。
 *  5. 主题切换后 Mermaid 需要重画（它的配色是渲染时确定的 SVG 内联样式），
 *     KaTeX 不用（纯 CSS）。
 */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var VENDOR = window.__VENDOR__ || {};

  /* ---------------- 路径解析 ---------------- */

  /* 路径解析：__ROOT__ 是构建期注入的「回到站点根」的相对前缀（"" / "../" / "../../"），
     vendor 映射里存的是相对 assets/ 的路径 —— 两者拼起来才不会因为页面深浅而错。
     （<html data-root> 里是同一个值，作为兜底。） */
  function rootPrefix() {
    if (typeof window.__ROOT__ === 'string') return window.__ROOT__;
    return root.getAttribute('data-root') || '';
  }

  function assetUrl(value) {
    if (!value) return '';
    if (/^(https?:)?\/\//.test(value)) return value;
    return rootPrefix() + 'assets/' + String(value).replace(/^\/+/, '');
  }

  function vendor(name) {
    return assetUrl(VENDOR[name]);
  }

  /* ---------------- 资源加载（同一地址只发一次请求） ---------------- */

  var pending = {};

  function loadScript(src) {
    if (!src) return Promise.reject(new Error('missing src'));
    if (pending[src]) return pending[src];
    pending[src] = new Promise(function (resolve, reject) {
      var tag = doc.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.onload = function () {
        resolve();
      };
      tag.onerror = function () {
        reject(new Error('failed to load ' + src));
      };
      (doc.head || doc.documentElement).appendChild(tag);
    });
    return pending[src];
  }

  function loadStyle(href) {
    if (!href || pending[href]) return;
    pending[href] = true;
    var tag = doc.createElement('link');
    tag.rel = 'stylesheet';
    tag.href = href;
    (doc.head || doc.documentElement).appendChild(tag);
  }

  function currentTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  /* ================= KaTeX ================= */

  var mathRendered = false;

  function pendingMath() {
    return Array.prototype.slice.call(doc.querySelectorAll('[data-tex]:not([data-math-done])'));
  }

  function renderMath() {
    if (!window.katex) return;
    mathRendered = true;
    var nodes = pendingMath();
    nodes.forEach(function (node) {
      var tex = node.getAttribute('data-tex') || '';
      var display = node.hasAttribute('data-display');
      try {
        window.katex.render(tex, node, {
          displayMode: display,
          throwOnError: false,
          strict: false,
          trust: false,
          output: 'html',
        });
        node.setAttribute('data-math-done', '1');
      } catch (err) {
        /* 单条公式炸了不能连累整页：留着源码，标记出来给样式兜底 */
        node.setAttribute('data-math-error', '1');
        node.setAttribute('data-math-done', '1');
      }
    });
    if (nodes.length) document.documentElement.setAttribute('data-math-ready', '1');
  }

  function setupMath() {
    var nodes = pendingMath();
    if (!nodes.length) return;

    if (window.katex) {
      renderMath();
      return;
    }
    loadStyle(vendor('katexCss'));
    loadScript(vendor('katex'))
      .then(renderMath)
      .catch(function () {
        /* 拉不到 KaTeX：把源码留成可读文本（构建期已放进元素里） */
        nodes.forEach(function (node) {
          node.setAttribute('data-math-error', '1');
          node.setAttribute('data-math-done', '1');
        });
      });
  }

  /* ================= Mermaid ================= */

  var mermaidReady = false;
  var mermaidLoading = false;
  var mermaidSeq = 0;
  /* 用 array 而不是重新查询 DOM：已经观察过的块不再重复 observe */
  var mermaidBlocks = [];

  function configureMermaid() {
    if (!window.mermaid) return;
    window.mermaid.initialize({
      startOnLoad: false,
      /* strict：图表里的 HTML 一律当作纯文本，避免把用户内容当 DOM 注入 */
      securityLevel: 'strict',
      theme: currentTheme() === 'light' ? 'default' : 'dark',
      fontFamily: 'inherit',
    });
  }

  function blockSource(block) {
    var pre = block.querySelector('[data-mermaid-src]');
    return pre ? pre.textContent : '';
  }

  function drawBlock(block) {
    if (!window.mermaid) return Promise.resolve();
    var out = block.querySelector('[data-mermaid-out]');
    var source = blockSource(block);
    if (!out || !source) return Promise.resolve();

    mermaidSeq += 1;
    var id = 'ws-mermaid-' + mermaidSeq;
    return window.mermaid
      .render(id, source)
      .then(function (result) {
        out.innerHTML = result && result.svg ? result.svg : '';
        out.removeAttribute('aria-busy');
        block.setAttribute('data-mermaid-ready', '1');
        block.removeAttribute('data-mermaid-error');
      })
      .catch(function () {
        /* 语法错误 / 渲染失败：展开源码，别留一块空白 */
        out.removeAttribute('aria-busy');
        block.setAttribute('data-mermaid-error', '1');
        block.classList.add('is-source-open');
      });
  }

  function drawAll() {
    mermaidReady = true;
    mermaidBlocks.forEach(function (block) {
      if (block.getAttribute('data-mermaid-ready') === '1') return;
      drawBlock(block);
    });
  }

  function ensureMermaid() {
    if (mermaidReady) {
      drawAll();
      return;
    }
    if (mermaidLoading) return;
    mermaidLoading = true;
    loadScript(vendor('mermaid'))
      .then(function () {
        configureMermaid();
        drawAll();
      })
      .catch(function () {
        mermaidBlocks.forEach(function (block) {
          block.setAttribute('data-mermaid-error', '1');
          block.classList.add('is-source-open');
        });
      });
  }

  var revealObserver = null;

  function observe(block) {
    if (typeof IntersectionObserver !== 'function') {
      ensureMermaid();
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            ensureMermaid();
            revealObserver.unobserve(entry.target);
          });
        },
        { rootMargin: '400px 0px' }
      );
    }
    revealObserver.observe(block);
  }

  function setupMermaid() {
    var fresh = Array.prototype.slice.call(
      doc.querySelectorAll('[data-mermaid]:not([data-mermaid-watched])')
    );
    if (!fresh.length) return;

    fresh.forEach(function (block) {
      block.setAttribute('data-mermaid-watched', '1');
      mermaidBlocks.push(block);

      /* 源码折叠：不渲染也能读，且是调试时最有用的一件事 */
      var toggle = block.querySelector('[data-mermaid-toggle]');
      if (toggle) {
        toggle.addEventListener('click', function () {
          var open = block.classList.toggle('is-source-open');
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
      }
      observe(block);
    });
  }

  /* 主题变了 Mermaid 图得重画：它的颜色是渲染期写进 SVG 的 */
  window.addEventListener('ws:appearance', function () {
    if (!mermaidReady) return;
    configureMermaid();
    mermaidBlocks.forEach(function (block) {
      block.removeAttribute('data-mermaid-ready');
      var out = block.querySelector('[data-mermaid-out]');
      if (out) out.setAttribute('aria-busy', 'true');
      drawBlock(block);
    });
  });

  /* ---------------- 启动 ---------------- */

  function scan() {
    setupMath();
    setupMermaid();
  }

  /* 运行期注入的内容（云文章详情、后台预览）拿不到构建期的“有无公式”标记，
     所以这里用 MutationObserver 自动接管后插入的节点，调用方不用记得调 scan()。 */
  function watchDom() {
    if (typeof MutationObserver !== 'function' || !doc.body) return;
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
        scheduled = false;
        scan();
      });
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  function boot() {
    scan();
    watchDom();
  }

  /* 供运行期代码手动触发（不依赖自动观察时用得上） */
  window.WSBlogMath = { scan: scan };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
