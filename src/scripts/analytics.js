/* analytics.js —— 访问上报（B10）
 *
 * 服务端那一半早就有了：page_views_log 表 + page_view_log() RPC（对 anon 授权）+
 * admin_analytics() 读侧面板。缺的是「谁去调 page_view_log」—— 本文件补上这一环，
 * 否则后台的 PV / UV / 来源 / UA 面板永远是空的。
 *
 * 隐私设计（与云端表结构一致，务必别改坏）：
 *   · 不采 IP、不采完整 UA —— 只上报 UA 字符串，服务端用 ua_family() 归成大类后落库；
 *   · 会话标识是「每天轮换的随机串」，存 sessionStorage，换标签页/换天就换新；
 *     不上报任何账号信息，登录与否都不影响；
 *   · 尊重 Do Not Track，也允许用户用 localStorage 里的 wsblog:analytics=off 永久退出；
 *   · 私有页面（后台 / 投稿 / 账户 / 登录 / 预览）不上报，避免把管理行为算进 PV。
 *
 * 服务端还有两条兜底：同一会话同一路径 30 分钟内只记一次（防刷新灌水）、
 * 路径必须形如 /xxx（挡掉脏数据）。
 */
(function () {
  'use strict';

  var OPT_OUT_KEY = 'wsblog:analytics';
  var SESSION_KEY = 'wsblog:pv:sid';

  /* 这些页面不属于「公开阅读」，不上报 */
  var SKIP = ['admin.html', 'write.html', 'account.html', 'login.html', 'preview.html'];

  function skipPage() {
    var last = (location.pathname.split('/').pop() || '').toLowerCase();
    if (SKIP.indexOf(last) !== -1) return true;
    /* 预览页带 noindex，作为第二重保险 */
    var robots = document.querySelector('meta[name="robots"]');
    if (robots && /noindex/i.test(robots.getAttribute('content') || '')) return true;
    return false;
  }

  function optedOut() {
    try {
      if (localStorage.getItem(OPT_OUT_KEY) === 'off') return true;
    } catch (e) {
      /* 读不了 localStorage（隐私模式）就当没退出，但下面还会尊重 DNT */
    }
    var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
    return dnt === '1' || dnt === 'yes';
  }

  /* 会话指纹：随机 + 当天日期 → SHA-256 前 32 位。
     为什么加日期：同一个人第二天再来看会被算成新的会话，符合 UV 的直觉，
     也避免长期可追踪的稳定标识（这是我们愿意放弃的精度）。 */
  function sessionId() {
    var raw = '';
    try {
      raw = sessionStorage.getItem(SESSION_KEY) || '';
      if (!raw) {
        raw = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, raw);
      }
    } catch (e) {
      raw = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    var seed = raw + '|' + new Date().toISOString().slice(0, 10);
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      return window.crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(seed))
        .then(function (buf) {
          var bytes = new Uint8Array(buf);
          var out = '';
          for (var i = 0; i < 16; i++) out += (bytes[i] + 256).toString(16).slice(1);
          return out;
        })
        .catch(function () {
          return simpleHash(seed);
        });
    }
    return Promise.resolve(simpleHash(seed));
  }

  /* crypto.subtle 只在安全上下文（https / localhost）可用；降级用法还是散列，
     不是明文 —— 足以满足「不做长期可追踪标识」这条。 */
  function simpleHash(text) {
    var h1 = 0x811c9dc5, h2 = 0x1000193;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      h1 = ((h1 ^ c) * 16777619) >>> 0;
      h2 = ((h2 + c) * 2654435761) >>> 0;
    }
    return (h1.toString(16) + h2.toString(16)).slice(0, 32);
  }

  function send() {
    var cloud = window.WSBlogCloud;
    if (!cloud || typeof cloud.ready !== 'function' || typeof cloud.db !== 'function') return;
    if (typeof cloud.cloud === 'function' && !cloud.cloud()) return;

    cloud
      .ready()
      .then(function () {
        return sessionId();
      })
      .then(function (sid) {
        return cloud.db().rpc('page_view_log', {
          p_path: location.pathname || '/',
          p_referrer: document.referrer || null,
          p_ua: navigator.userAgent || null,
          p_session: sid,
        });
      })
      .catch(function () {
        /* 统计失败绝不打扰用户，也不打 console.warn —— 本地 403 是预期噪音 */
      });
  }

  function boot() {
    if (skipPage() || optedOut()) return;
    /* 等首屏稳定后再发，别和关键资源抢带宽 */
    if (document.readyState === 'complete') send();
    else window.addEventListener('load', send, { once: true });
  }

  window.WSBlogAnalytics = {
    /* 供设置页 / 调试用 */
    optOut: function () {
      try {
        localStorage.setItem(OPT_OUT_KEY, 'off');
      } catch (e) {
        /* 忽略 */
      }
    },
    optIn: function () {
      try {
        localStorage.removeItem(OPT_OUT_KEY);
      } catch (e) {
        /* 忽略 */
      }
    },
    enabled: function () {
      return !optedOut();
    },
    track: send,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
