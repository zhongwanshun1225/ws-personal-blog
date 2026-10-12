---
title: PostgreSQL 索引没生效？先排查这 6 个原因
date: 2026-09-21
tags: [PostgreSQL, 数据库, 性能]
summary: 明明建了索引，EXPLAIN 里却依然是 Seq Scan。这篇文章按排查顺序整理了 6 类最常见的原因，附可直接复制的诊断 SQL。
draft: false
---

## 先看 EXPLAIN，别猜

排查索引问题的第一步永远是拿真实计划：

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT id, email
FROM users
WHERE tenant_id = 42 AND status = 'active'
ORDER BY created_at DESC
LIMIT 20;
```

`ANALYZE` 会真的执行语句（注意写操作的副作用），`BUFFERS` 告诉你命中了多少缓存块。看到 `Seq Scan` 再往下读。

## 原因一：条件列的类型不匹配

这是最常见也最隐蔽的一种。表里 `phone` 是 `varchar`，查询却传了数字：

```sql
-- 索引在 phone 上，但这里用不了
SELECT * FROM users WHERE phone = 13800138000;
```

PostgreSQL 会把 `phone` 隐式转换成数值，**列上套了函数，索引自然失效**。正确写法：

```sql
SELECT * FROM users WHERE phone = '13800138000';
```

> [!CAUTION]
> ORM 里尤其容易踩。比如某些驱动会把 `id` 统一序列化成字符串，如果列是 `bigint`，就会触发同样的隐式转换。

## 原因二：在索引列上做了运算

```sql
-- ✗ 索引用不上
WHERE date_trunc('day', created_at) = '2026-09-21'

-- ✓ 改成范围查询，索引可用
WHERE created_at >= '2026-09-21' AND created_at < '2026-09-22'
```

如果业务上确实高频按"某天"筛选，那就建表达式索引：

```sql
CREATE INDEX idx_users_created_day
  ON users ((date_trunc('day', created_at)));
```

## 原因三：联合索引的列顺序不对

联合索引 `(a, b, c)` 遵循**最左前缀**原则。下面这条用不上它：

```sql
-- 索引是 (tenant_id, status, created_at)
WHERE status = 'active';   -- ✗ 跳过了 tenant_id
```

更微妙的是"能用但只用了前半段"：

```sql
WHERE tenant_id = 42 AND created_at > now() - interval '7 days';
```

这里 `tenant_id` 能用上，但 `created_at` 用不上——因为中间的 `status` 断了。这种情况建议单独补一个索引：

```sql
CREATE INDEX idx_users_tenant_created
  ON users (tenant_id, created_at DESC);
```

> [!TIP]
> 加索引前先问一句：**"这条 SQL 的 WHERE 条件里，哪些列的组合是固定的？"** 按选择性从高到低排列，通常就是正确的列顺序。

## 原因四：统计信息过期

PostgreSQL 的代价估算依赖 `pg_statistic`。如果表刚批量导入过数据而没跑统计，优化器可能误判"全表扫描更便宜"：

```sql
ANALYZE users;

-- 看最后一次统计时间
SELECT relname, last_analyze, last_autoanalyze, n_mod_since_analyze
FROM pg_stat_user_tables
WHERE relname = 'users';
```

`n_mod_since_analyze` 这个数字很大，就说明该调整自动统计的频率了：

```sql
ALTER TABLE users SET (autovacuum_analyze_scale_factor = 0.02);
```

## 原因五：返回的行数实在太多

如果一个条件会命中全表 30% 的行，优化器走全表扫描**是对的**——随机 I/O 的成本比顺序扫描高得多。

判断标准是 **选择率（selectivity）**：

```sql
SELECT count(*) FILTER (WHERE status = 'active') * 1.0 / count(*) AS ratio
FROM users;
```

如果这个比值超过 5%~10%，就别指望走索引了，应该从业务上收窄查询范围（分页、加时间窗口）。

## 原因六：索引本身没建成功

`CREATE INDEX CONCURRENTLY` 失败时会留下一个 **invalid** 索引：它占空间、拖慢写入，但查询完全用不上。

```sql
SELECT indexrelid::regclass AS index_name, indisvalid, indisready
FROM pg_index
WHERE NOT indisvalid OR NOT indisready;
```

发现 invalid 的直接重建：

```sql
DROP INDEX CONCURRENTLY idx_users_email;
CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
```

## 快速自查清单

| 序号 | 检查项 | 一句话判断 |
| --- | --- | --- |
| 1 | 类型是否一致 | 列和参数类型必须完全相同 |
| 2 | 列上是否套了函数 | 有函数就改用范围条件或表达式索引 |
| 3 | 最左前缀是否成立 | 联合索引不能跳过中间列 |
| 4 | 统计信息是否新鲜 | `n_mod_since_analyze` 过大就手写 ANALYZE |
| 5 | 选择率是否过低 | 命中超过 10% 的行就别怪优化器 |
| 6 | 索引是否 valid | `pg_index.indisvalid = false` 就是废索引 |

## 小结

索引问题九成出在**"我以为等价，优化器不认"**上。养成两个习惯基本就能躲开大部分坑：

- 写 SQL 前用 `EXPLAIN` 看一眼，不要等上线才发现；
- 线上开启 `log_min_duration_statement`，让慢查询自己浮出来。
