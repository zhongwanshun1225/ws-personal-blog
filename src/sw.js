/**
 * WS Blog Service Worker
 *
 * 策略（刻意保守，避免把「该最新的内容」缓存成旧的）：
 *   · 页面导航          —— 网络优先，失败退缓存，再退离线页
 *   · assets/ 静态资源  —— 先用缓存、后台更新（stale-while-revalidate）
 *   · 云接口 /.cloud/   —— 完全不拦，登录 / 评论 / 后台的数据必须实时
 *   · 跨域请求          —— 不拦
 *
 * 镜像域名（github.io）只负责跳转，不会注册本 SW（app.js 里有 origin 校验）。
 */

(function () {
  'use strict';

  var VERSION = 'wsblog-v6';
  var SCOPE_URL = new URL(self.registration.scope);
  var ROOT = SCOPE_URL.pathname;

  /* 预缓存清单：只放「每个页面都要用、体积又小」的资源。
     KaTeX / Mermaid / marked / highlight 都不在这里 —— 它们是按需加载的，
     离线时拉不到就走各自的降级（公式显示源码、图表展开源码），不影响阅读。 */
  var CORE = [
    ROOT + 'assets/main.css',
    ROOT + 'assets/theme.js',
    ROOT + 'assets/i18n.js',
    ROOT + 'assets/vendor-map.js',
    ROOT + 'assets/app.js',
    ROOT + 'assets/banner.js',
    ROOT + 'assets/analytics.js',
    ROOT + 'assets/idle.js',
    ROOT + 'assets/onboard.js',
    ROOT + 'offline.html',
  ];

  self.addEventListener('install', function (event) {
    event.waitUntil(
      caches
        .open(VERSION)
        .then(function (cache) {
          return Promise.all(
            CORE.map(function (url) {
              return cache.add(new Request(url, { cache: 'reload' })).catch(function () {
                /* 单个资源失败不阻塞安装 */
              });
            })
          );
        })
        .then(function () {
          return self.skipWaiting();
        })
    );
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(
      caches
        .keys()
        .then(function (keys) {
          return Promise.all(
            keys.map(function (key) {
              return key === VERSION ? null : caches.delete(key);
            })
          );
        })
        .then(function () {
          return self.clients.claim();
        })
    );
  });

  function isCloudApi(url) {
    return url.pathname.indexOf('/.cloud/') !== -1;
  }

  self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;

    var url;
    try {
      url = new URL(request.url);
    } catch (err) {
      return;
    }
    if (url.origin !== location.origin) return;
    if (isCloudApi(url)) return;

    /* 页面导航：网络优先，离线退缓存，最后退离线页 */
    if (request.mode === 'navigate' || (request.headers.get('accept') || '').indexOf('text/html') !== -1) {
      event.respondWith(
        fetch(request)
          .then(function (response) {
            var copy = response.clone();
            caches.open(VERSION).then(function (cache) {
              cache.put(request, copy);
            });
            return response;
          })
          .catch(function () {
            return caches.match(request).then(function (hit) {
              if (hit) return hit;
              return caches.match(ROOT + 'offline.html').then(function (offline) {
                return offline || new Response('离线', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
              });
            });
          })
      );
      return;
    }

    /* 其余同源 GET：先用缓存、后台更新 */
    event.respondWith(
      caches.open(VERSION).then(function (cache) {
        return cache.match(request).then(function (hit) {
          var fetching = fetch(request)
            .then(function (response) {
              if (response && response.status === 200 && response.type === 'basic') {
                cache.put(request, response.clone());
              }
              return response;
            })
            .catch(function () {
              return hit;
            });
          return hit || fetching;
        });
      })
    );
  });
})();
