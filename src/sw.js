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

  var VERSION = 'wsblog-v7';
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

    /* ---------- 链接预取：`<link rel=prefetch as=document>` 发出的请求 ----------
       页面悬停链接时 app.js 会预取目标 HTML。这类请求必须**写进 SW 缓存**，
       否则下面的导航分支（网络优先）不会复用它，预取等于白做。
       注意用 no-cors 之外的正常 fetch 拿完整响应体，失败就静默放弃。 */
    if (request.destination === 'document' && request.headers.get('sec-purpose') === 'prefetch') {
      event.respondWith(
        caches.open(VERSION).then(function (cache) {
          return fetch(request)
            .then(function (response) {
              if (response && response.status === 200 && response.type === 'basic') {
                cache.put(request, response.clone());
              }
              return response;
            })
            .catch(function () {
              // 预取失败不该冒泡成错误，回一个空 204 让浏览器静默丢弃
              return new Response('', { status: 204 });
            });
        })
      );
      return;
    }

    /* 页面导航：网络优先，离线退缓存，最后退离线页。
     *
     * ⚠️ 为什么导航**不能**改成「缓存优先」：本站内容靠构建期更新，
     * 用户最需要的就是「一刷新就看到新文章」。若先用缓存，改过的页面会滞后一次访问。
     * 所以这里坚持网络优先 —— 但补一个关键优化：
     *
     * 页面里的链接预取（app.js::prefetchOnIntent）会发出 `rel=prefetch` 的请求，
     * **它也会经过 SW**。若不特殊处理，预取的响应只会落到浏览器 HTTP 缓存，
     * 而导航走 fetch() 时仍要等一次网络往返 —— 预取就白做了。
     * 因此把预取响应**同时写进 SW 缓存**；导航时若网络迟迟不响应（慢网 / 弱信号），
     * 就先用缓存的那份立即渲染，网络结果回来后替换缓存供下次使用。
     * 这样：快网仍是最新的（网络优先），慢网也不再盯着白屏。 */
    if (request.mode === 'navigate' || (request.headers.get('accept') || '').indexOf('text/html') !== -1) {
      event.respondWith(
        caches.open(VERSION).then(function (cache) {
          return cache.match(request).then(function (cached) {
            var network = fetch(request).then(function (response) {
              if (response && response.status === 200 && response.type === 'basic') {
                cache.put(request, response.clone());
              }
              return response;
            });

            if (!cached) return network;

            /* 有缓存副本时给它一个很短的宽限期（250ms）：
               网络在这之内完成就用新的，否则先拿缓存顶上，避免白屏。
               250ms 是权衡 —— 再短起不到遮挡作用，再长会让「明明能快」的场景变慢。 */
            return Promise.race([
              network,
              new Promise(function (resolve) {
                setTimeout(function () {
                  resolve(cached);
                }, 250);
              }),
            ]).catch(function () {
              return cached || caches.match(ROOT + 'offline.html');
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
