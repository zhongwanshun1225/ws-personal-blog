/**
 * 本地草稿（自动保存 + 恢复）。
 *
 * 用途：编辑长文时把内容定期写进 localStorage，防止切页 / 崩溃 / 手滑刷新导致稿件全丢。
 * 这里只负责「存储原语 + 自动保存接线」，具体收哪些字段、怎么恢复由各页面决定。
 *
 * 约定：
 *   · key 形如 wsblog:draft:v2:<命名空间>:<标识>，命名空间区分投稿页与后台编辑器
 *   · 超过 30 天的本地草稿自动清理（避免残留陈旧内容）
 *   · 所有 localStorage 访问都包了 try/catch —— 隐私模式下不可用时静默退化为「不自动保存」
 */

(function () {
  'use strict';

  var PREFIX = 'wsblog:draft:v2:';
  var MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  var DEBOUNCE_MS = 1200;

  function key(namespace, id) {
    return PREFIX + namespace + ':' + (id || 'new');
  }

  function safeGet(storageKey) {
    try {
      return window.localStorage.getItem(storageKey);
    } catch (err) {
      return null;
    }
  }

  function safeSet(storageKey, value) {
    try {
      window.localStorage.setItem(storageKey, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  function safeRemove(storageKey) {
    try {
      window.localStorage.removeItem(storageKey);
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 读取本地草稿；不存在、已损坏或已过期返回 null（顺带清理垃圾）。 */
  function read(storageKey) {
    var raw = safeGet(storageKey);
    if (!raw) return null;
    var data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      safeRemove(storageKey);
      return null;
    }
    if (!data || typeof data !== 'object') {
      safeRemove(storageKey);
      return null;
    }
    var savedAt = Date.parse(data.savedAt || '');
    if (isNaN(savedAt) || Date.now() - savedAt > MAX_AGE) {
      safeRemove(storageKey);
      return null;
    }
    return data;
  }

  function write(storageKey, data) {
    var payload = data || {};
    payload.savedAt = new Date().toISOString();
    return safeSet(storageKey, JSON.stringify(payload));
  }

  function remove(storageKey) {
    return safeRemove(storageKey);
  }

  /**
   * 给一个表单接上自动保存。
   *
   * opts.form     表单元素（监听 input/change）
   * opts.keyFn    () => storageKey，允许随当前编辑对象变化
   * opts.collect  () => 要落盘的普通对象
   * opts.isEmpty  (data) => boolean，true 时清除本地草稿而不是写入
   * opts.onStatus (text, level) => void，用于回显「已自动保存 · 14:03」
   * opts.onFlush  (data) => void，离开页面前最后一次落盘时的回调（可选）
   */
  function attach(opts) {
    var form = opts.form;
    if (!form) return null;

    var timer = null;
    var storageAvailable = true;
    var dirty = false;

    function persist() {
      var data = opts.collect() || {};
      var storageKey = opts.keyFn();
      if (opts.isEmpty && opts.isEmpty(data)) {
        remove(storageKey);
        if (opts.onStatus) opts.onStatus('', 'idle');
        return;
      }
      var ok = write(storageKey, data);
      if (!ok) storageAvailable = false;
      if (opts.onStatus) {
        opts.onStatus(
          ok ? '已自动保存到本机 · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '本机不可用，自动保存已关闭',
          ok ? 'saved' : 'error'
        );
      }
    }

    function schedule() {
      dirty = true;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(persist, DEBOUNCE_MS);
    }

    function flush() {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (!dirty) return;
      persist();
      dirty = false;
      if (opts.onFlush) opts.onFlush(opts.collect() || {});
    }

    form.addEventListener('input', schedule);
    form.addEventListener('change', schedule);

    /* 切走标签页 / 关闭窗口前把待写入的改动落盘（同步写，一定来得及） */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('beforeunload', function (event) {
      flush();
      if (dirty && !storageAvailable) {
        /* 隐私模式下写不进去，只能拦一下提醒用户 */
        event.preventDefault();
        event.returnValue = '';
        return '';
      }
      return undefined;
    });

    /* 兜底：长时间停留但没有输入事件时不至于一直不落盘 */
    var ticker = window.setInterval(function () {
      if (dirty) persist();
    }, 20000);

    return {
      flush: flush,
      /** 云端保存成功后调用：清掉本地草稿并复位状态 */
      markSaved: function (statusText) {
        if (timer) {
          window.clearTimeout(timer);
          timer = null;
        }
        dirty = false;
        remove(opts.keyFn());
        if (opts.onStatus) opts.onStatus(statusText || '已保存到云端', 'saved');
      },
      /** 用户主动丢弃本地草稿 */
      discard: function () {
        if (timer) {
          window.clearTimeout(timer);
          timer = null;
        }
        dirty = false;
        remove(opts.keyFn());
        if (opts.onStatus) opts.onStatus('', 'idle');
      },
      isDirty: function () {
        return dirty;
      },
      dispose: function () {
        if (ticker) window.clearInterval(ticker);
      },
    };
  }

  window.WSBlogDraft = {
    key: key,
    read: read,
    write: write,
    remove: remove,
    attach: attach,
    MAX_AGE: MAX_AGE,
  };
})();
