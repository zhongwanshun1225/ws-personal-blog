/**
 * 外观设置：主题模式（跟随系统 / 浅色 / 深色）+ 强调色方案。
 *
 * 与 <head> 里的内联脚本共用同一份 localStorage（wsblog:appearance）：
 * 内联脚本负责首屏防闪烁，这里负责面板交互、系统主题跟随与状态同步。
 * 纯原生 JS，无依赖。
 */

(function () {
  'use strict';

  var KEY = 'wsblog:appearance';
  var MODES = ['auto', 'light', 'dark'];
  var ACCENTS = ['teal', 'blue', 'violet', 'amber', 'rose'];
  var DEFAULT = { mode: 'auto', accent: 'teal' };
  var THEME_COLOR = { dark: '#0a0c11', light: '#f6f8fa' };

  var doc = document;
  var root = doc.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  /* ================= 状态读写 ================= */
  function read() {
    var out = { mode: DEFAULT.mode, accent: DEFAULT.accent };
    var raw = null;
    try {
      raw = window.localStorage.getItem(KEY);
    } catch (e) {
      raw = null;
    }
    if (!raw) return out;
    try {
      var parsed = JSON.parse(raw) || {};
      if (MODES.indexOf(parsed.mode) >= 0) out.mode = parsed.mode;
      if (ACCENTS.indexOf(parsed.accent) >= 0) out.accent = parsed.accent;
    } catch (e) {
      /* 配置损坏时静默回落到默认值 */
    }
    return out;
  }

  function write() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* 隐私模式下写入会失败，不影响本次会话的显示 */
    }
  }

  var state = read();

  /* 把 mode 解析成确定的 light / dark */
  function resolved() {
    if (state.mode === 'light' || state.mode === 'dark') return state.mode;
    return mq && mq.matches ? 'dark' : 'light';
  }

  /* ================= 应用 ================= */
  function apply(announce) {
    var theme = resolved();

    root.setAttribute('data-theme', theme);
    if (state.accent && state.accent !== DEFAULT.accent) {
      root.setAttribute('data-accent', state.accent);
    } else {
      root.removeAttribute('data-accent');
    }

    var meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[theme] || THEME_COLOR.dark);

    sync();

    if (announce) {
      try {
        window.dispatchEvent(
          new CustomEvent('ws:appearance', {
            detail: { theme: theme, mode: state.mode, accent: state.accent },
          })
        );
      } catch (e) {
        /* 老浏览器不支持 CustomEvent 构造器时忽略 */
      }
    }
  }

  /* ================= 面板 ================= */
  var wrap = doc.querySelector('[data-appearance]');
  var trigger = wrap ? wrap.querySelector('[data-appearance-open]') : null;
  var panel = wrap ? wrap.querySelector('[data-appearance-panel]') : null;

  var segBtns = panel ? toArray(panel.querySelectorAll('[data-appearance-mode]')) : [];
  var swatches = panel ? toArray(panel.querySelectorAll('[data-appearance-accent]')) : [];

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  function sync() {
    segBtns.forEach(function (btn) {
      btn.setAttribute('aria-checked', btn.getAttribute('data-appearance-mode') === state.mode ? 'true' : 'false');
    });
    swatches.forEach(function (btn) {
      btn.setAttribute(
        'aria-checked',
        btn.getAttribute('data-appearance-accent') === state.accent ? 'true' : 'false'
      );
    });
  }

  function setOpen(open) {
    if (!panel || !trigger) return;
    if (open) {
      panel.removeAttribute('hidden');
      trigger.setAttribute('aria-expanded', 'true');
    } else {
      panel.setAttribute('hidden', '');
      trigger.setAttribute('aria-expanded', 'false');
    }
  }

  if (trigger && panel) {
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(panel.hasAttribute('hidden'));
    });

    /* 点击面板内部不关闭（选项自己要处理点击） */
    panel.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    doc.addEventListener('click', function () {
      if (!panel.hasAttribute('hidden')) setOpen(false);
    });

    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hasAttribute('hidden')) {
        setOpen(false);
        trigger.focus();
      }
    });
  }

  segBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-appearance-mode');
      if (MODES.indexOf(mode) < 0 || mode === state.mode) return;
      state.mode = mode;
      write();
      apply(true);
    });
  });

  swatches.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var accent = btn.getAttribute('data-appearance-accent');
      if (ACCENTS.indexOf(accent) < 0 || accent === state.accent) return;
      state.accent = accent;
      write();
      apply(true);
    });
  });

  /* 跟随系统时，监听系统配色变化 */
  if (mq) {
    var onSystemChange = function () {
      if (state.mode === 'auto') apply(true);
    };
    if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
    else if (mq.addListener) mq.addListener(onSystemChange);
  }

  /* 首次同步（内联脚本已经设过属性，这里只补齐面板选中态与 meta） */
  apply(false);

  /* 暴露给其他脚本/调试：例如图表重绘时读取当前主题 */
  window.__wsAppearance = {
    get: function () {
      return { mode: state.mode, accent: state.accent, theme: resolved() };
    },
    set: function (patch) {
      patch = patch || {};
      if (MODES.indexOf(patch.mode) >= 0) state.mode = patch.mode;
      if (ACCENTS.indexOf(patch.accent) >= 0) state.accent = patch.accent;
      write();
      apply(true);
    },
    reset: function () {
      state = { mode: DEFAULT.mode, accent: DEFAULT.accent };
      write();
      apply(true);
    },
  };
})();
