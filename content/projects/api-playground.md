---
title: API Playground
description: 浏览器里就能用的接口调试面板。保存请求集合、环境变量切换、响应对比，数据全部存在本地 IndexedDB。
date: 2026-05-20
stack: [TypeScript, React, IndexedDB, Vite]
tags: [工具, 前端]
status: 维护中
featured: false
order: 3
repo: ""
demo: ""
---

## 为什么又造一个 Postman

因为团队里很多人不愿意为了一次调试去注册账号、装桌面客户端。而把内网接口发到第三方在线工具上，安全上也不合适。

这个工具的目标很明确：**打开网页即用，数据不出浏览器**。

## 核心能力

| 功能 | 说明 |
| --- | --- |
| 请求集合 | 按项目分组，支持导入导出 JSON |
| 环境变量 | `{{baseUrl}}` 风格插值，多环境一键切换 |
| 响应对比 | 两次响应做结构化 diff，调接口时很有用 |
| 本地持久化 | IndexedDB 存储，换浏览器需手动导出 |
| 请求历史 | 保留最近 200 条，支持回放 |

## 一些实现细节

### 环境变量插值

递归替换字符串里的 `{{key}}`，找不到就原样保留（并且高亮提示），避免静默失败：

```ts
export function interpolate(input: unknown, vars: Record<string, string>): unknown {
  if (typeof input === 'string') {
    return input.replace(/\{\{(\w+)\}\}/g, (raw, key) =>
      key in vars ? vars[key] : raw
    );
  }
  if (Array.isArray(input)) return input.map((v) => interpolate(v, vars));
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, interpolate(v, vars)])
    );
  }
  return input;
}
```

### 响应 diff 用 LCS 而不是全量比较

直接比较 JSON 字符串毫无意义——只要字段顺序变了就"全不相等"。用最长公共子序列找出真正变动的行：

```ts
function diffLines(a: string[], b: string[]) {
  // 标准 LCS 动态规划，返回 {type: 'same'|'add'|'del', value} 的序列
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // ...回溯生成 diff
}
```

### 跨域怎么办

浏览器直接发请求绕不开 CORS。方案是提供两个模式：

1. **直连**（默认）：适合已经配好 CORS 的接口；
2. **代理**：通过一个自部署的转发服务，把请求打到内网。

> [!CAUTION]
> 代理模式会带上 token 转发，**绝不要部署在公网**。文档里我用最醒目的方式标注了这一点，但仍然有人忽略——这大概是最让人头疼的部分。

## 已知限制

- 不支持 WebSocket 长连接调试（在看 `@msgpack/msgpack` 的解码方案）
- gRPC 完全没做
- 大响应（> 20MB）会让 diff 卡住，加了截断保护但体验一般

## 学习收获

这个项目让我真正理解了 IndexedDB 的事务模型。最大的教训是：**不要试图用 IndexedDB 做关系型建模**。我一开始设计了 5 个 store 并建立索引关联，结果每次查询都要手动 join，代码复杂度爆炸。后来砍成 2 个 store、把关联数据直接内联，代码量减少了 40%，性能反而更好。
