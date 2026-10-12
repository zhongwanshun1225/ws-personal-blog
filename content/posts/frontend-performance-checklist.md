---
title: 前端性能优化：按收益排序的 12 条清单
date: 2026-08-30
tags: [前端, 性能优化, Web]
summary: 不讲"要减少请求数"这种正确的废话。这份清单按「改动成本 / 实际收益」排序，每条都附上了可量化的验证方法。
draft: false
---

## 先说结论

性能优化的第一原则是**先测量**。没有数据的优化等于换一种方式碰运气。

我习惯先跑一遍实验室数据，再看真实用户数据：

```bash
# 实验室：Lighthouse 更适合定位单页问题
npx lighthouse https://example.com --preset=desktop --view

# 线上：看 Core Web Vitals 的真实分布
# LCP / INP / CLS 都应关注 P75 分位，而不是平均值
```

> [!IMPORTANT]
> **平均值会骗人**。一个 LCP 平均值 1.8s 的站点，完全可能是 "90% 用户 1.2s + 10% 用户 7s"。永远看 P75 和 P95。

## 一、高收益，低改动

### 1. 给静态资源加长缓存 + 内容指纹

这是投入产出比最高的一条，没有之一。文件名里带 hash，然后放心地把缓存时间拉到一年：

```nginx
location /assets/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
```

回访用户直接命中本地缓存，网络耗时归零。

### 2. 图片用现代格式并按需尺寸下发

```html
<picture>
  <source type="image/avif" srcset="hero-800.avif 800w, hero-1600.avif 1600w" sizes="100vw">
  <source type="image/webp" srcset="hero-800.webp 800w, hero-1600.webp 1600w" sizes="100vw">
  <img src="hero-800.jpg" alt="封面" width="800" height="450" loading="lazy" decoding="async">
</picture>
```

三个关键点：AVIF/WebP 通常能省 40%~70% 体积；`srcset` 避免手机下载桌面大图；**写上 `width`/`height` 能直接消掉图片引起的 CLS**。

### 3. 字体用 `font-display: swap` 并预加载关键字体

```css
@font-face {
  font-family: 'Inter';
  src: url('/fonts/inter.woff2') format('woff2');
  font-display: swap;      /* 先用系统字体渲染，字体到了再换 */
  unicode-range: U+0000-00FF;  /* 只加载需要的字符集 */
}
```

```html
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
```

> [!TIP]
> 如果预算允许，**考虑直接用系统字体栈**。这是唯一能让你省掉 100% 字体网络成本的方案，而且在中文场景下收益巨大：
>
> ```
> -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
> ```

## 二、中等成本，明显收益

### 4. 拆分首屏关键 CSS 并内联

把首屏渲染必需的样式（约 10~14KB）直接内联进 `<head>`，其余样式异步加载：

```html
<style>/* 首屏关键样式 */</style>
<link rel="preload" href="/assets/main.css" as="style" onload="this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="/assets/main.css"></noscript>
```

能显著改善 FCP，代价是需要一个构建步骤来自动提取。

### 5. 路由级代码分割，而不是组件级

很多人一上来就 `React.lazy` 拆得极细，结果拆出几百个 chunk，HTTP/2 下反而更慢。

合理的粒度是**按路由拆**：

```jsx
const routes = [
  { path: '/', component: lazy(() => import('./pages/Home')) },
  { path: '/dashboard', component: lazy(() => import('./pages/Dashboard')) },
];
```

判断标准：**用户在当前页面停留期间，有多大比例会进入下一个 chunk？** 低于 30% 才值得拆。

### 6. 长列表用虚拟滚动

渲染 5000 行 DOM 会让任何优化手段失效。只渲染视口内的 20 行：

```js
// 核心思路：容器高度 = 总行数 × 行高，实际只渲染可见区间的元素
const start = Math.floor(scrollTop / ITEM_HEIGHT);
const end = start + Math.ceil(viewportHeight / ITEM_HEIGHT);
const visible = items.slice(start, end);
```

大多数业务场景，`@tanstack/virtual` 就够用，不必手写。

### 7. 把昂贵的计算挪出主线程

超过 50ms 的同步任务就会阻塞交互，直接拉高 INP。用 Web Worker 搬走：

```js
// main.js
const worker = new Worker(new URL('./heavy.worker.js', import.meta.url), { type: 'module' });
worker.postMessage(payload);
worker.onmessage = (e) => render(e.data);
```

```js
// heavy.worker.js
self.onmessage = (e) => {
  self.postMessage(expensiveCompute(e.data));
};
```

## 三、需要架构配合

### 8. 用 `content-visibility` 跳过屏外渲染

```css
.below-the-fold {
  content-visibility: auto;
  contain-intrinsic-size: 0 600px;   /* 必须给，否则滚动条会跳 */
}
```

浏览器直接跳过屏外内容的布局与绘制。对长文档类页面效果最明显。

### 9. 接口聚合，减少瀑布式请求

```text
✗ 串行：page → (user) → (orders) → (coupons)   3 个 RTT
✓ 并行：page → user + orders + coupons         1 个 RTT
```

能在 BFF 层合并就合并；不能就用 `Promise.all` 并行发起，注意别把鉴权 token 的获取也串进去。

### 10. 首屏数据做 SSR/SSG 直出

CSR 的首屏必然经历「下载 JS → 执行 → 请求数据 → 渲染」四步。SSR/SSG 把前两步的结果直接写进 HTML，LCP 通常能从 3s+ 降到 1s 以内。

### 11. 预连接第三方域名

```html
<link rel="preconnect" href="https://cdn.example.com" crossorigin>
<link rel="dns-prefetch" href="https://analytics.example.com">
```

每个第三方域名都要走一次 DNS + TCP + TLS，`preconnect` 能把这部分提前。但**别滥用**——同时开超过 4 个会互相抢带宽。

### 12. 监控真实用户指标，而不是只看实验室数据

```js
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.entryType === 'largest-contentful-paint') {
      report('LCP', entry.startTime);
    }
  }
}).observe({ type: 'largest-contentful-paint', buffered: true });
```

实验室数据只能证明"理论上快了"，RUM 才能证明"用户真的感觉快了"。

## 收益 / 成本对照表

| 措施 | 改动成本 | 预期收益 | 优先做 |
| --- | --- | --- | --- |
| 长缓存 + 指纹 | 低 | 高 | ★★★ |
| 图片现代格式 | 低 | 高 | ★★★ |
| 字体优化 | 低 | 中高 | ★★★ |
| 关键 CSS 内联 | 中 | 中高 | ★★ |
| 路由级分割 | 中 | 中 | ★★ |
| 虚拟滚动 | 中 | 高（长列表） | ★★ |
| Worker 卸载计算 | 中 | 中 | ★ |
| `content-visibility` | 低 | 中 | ★★ |
| 接口聚合 | 高 | 高 | ★★ |
| SSR / SSG | 高 | 很高 | ★ |

## 最后一句

别一次全上。**挑两条改动成本最低的做完，测一次数据，再决定下一步。** 性能优化是迭代过程，不是一次性任务。
