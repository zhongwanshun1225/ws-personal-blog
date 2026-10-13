-- =====================================================================
-- 第五批：游客侧缺口 V2 / V6 / V7 / V11 / V15 的云端支撑
-- 日期：2026-10-13
--
-- 背景：游客侧的「热门排序 / 列表互动数 / 最新评论 / 系列 / 订阅」都需要
-- 云端数据，但匿名角色目前只能读到 post_views 一张表：
--   · comments / post_likes / post_bookmarks 上有 RLS，匿名 SELECT 返回
--     HTTP 200 + `[]`（不报错），所以「查不到」和「没有数据」看起来一样。
-- 本批沿用 posts_public / profiles_public 的思路：**只新增只读视图**，
-- 不动现有表结构与策略；再给订阅功能加一张写只走 RPC 的表。
--
-- 执行顺序（MCP 单次只允许一条语句）：
--   S1  ADD COLUMN → S2 posts_public（依赖 S1 的列）
--   S3/S4 两个视图 → GRANT
--   S5..S15 订阅表 + 三个 RPC + GRANT
-- =====================================================================


-- S1. cloud_posts 增加 series（系列 / 专栏）--------------------------------
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS series text;


-- S2. posts_public 带上 series -------------------------------------------
--     CREATE OR REPLACE VIEW 只能在**末尾**追加列，所以 series 放最后。
CREATE OR REPLACE VIEW public.posts_public AS
 SELECT id, slug, title, summary, tags, content_md,
        published_at, created_at, updated_at, author_id, series
   FROM cloud_posts
  WHERE status = 'published'::text;

GRANT SELECT ON public.posts_public TO anon, authenticated;


-- S3. post_stats_public：每篇的互动计数 -----------------------------------
--     构建期用它把阅读 / 点赞 / 收藏 / 评论数烘焙进静态页与列表卡片。
--     只出聚合数字，不含任何用户身份字段。
--     阅读量沿用 post_views 的真实值；其余三项 COUNT 后 COALESCE 归零。
CREATE OR REPLACE VIEW public.post_stats_public AS
WITH slugs AS (
  SELECT post_slug FROM post_views
  UNION SELECT post_slug FROM post_likes
  UNION SELECT post_slug FROM post_bookmarks
  UNION SELECT post_slug FROM comments WHERE status = 'visible'
)
SELECT s.post_slug,
       COALESCE(v.views, 0)      AS views,
       COALESCE(l.likes, 0)      AS likes,
       COALESCE(b.bookmarks, 0)  AS bookmarks,
       COALESCE(c.comments, 0)   AS comments
  FROM slugs s
  LEFT JOIN post_views v ON v.post_slug = s.post_slug
  LEFT JOIN (SELECT post_slug, count(*) AS likes     FROM post_likes     GROUP BY 1) l ON l.post_slug = s.post_slug
  LEFT JOIN (SELECT post_slug, count(*) AS bookmarks FROM post_bookmarks GROUP BY 1) b ON b.post_slug = s.post_slug
  LEFT JOIN (SELECT post_slug, count(*) AS comments  FROM comments WHERE status = 'visible' GROUP BY 1) c
         ON c.post_slug = s.post_slug;

GRANT SELECT ON public.post_stats_public TO anon, authenticated;


-- S4. comments_public：站点动态用（只出可见评论的摘要） --------------------
--     刻意只给 excerpt（截断到 200 字）而不是全文：首页区块只需要一句摘要，
--     读者点进去看全文。不暴露 owner_id / 邮箱等任何 PII。
CREATE OR REPLACE VIEW public.comments_public AS
 SELECT c.id,
        c.post_slug,
        COALESCE(NULLIF(btrim(c.author_name), ''), '读者') AS author_name,
        left(btrim(c.content), 200) AS excerpt,
        c.created_at
   FROM public.comments c
  WHERE c.status = 'visible'::text;

GRANT SELECT ON public.comments_public TO anon, authenticated;


-- S5. subscribers：邮件订阅表 --------------------------------------------
--     只存邮箱 + 语言 + 状态 + 退订令牌。**不给 anon 任何表的直接权限**，
--     写入只能走 S8 的 subscribe_add()（SECURITY DEFINER），这样：
--       · 匿名无法枚举邮箱（没有 SELECT 权限，也无法判断某邮箱是否存在）
--       · 规范化与去重都在服务端做
CREATE TABLE IF NOT EXISTS public.subscribers (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email           text NOT NULL,
  lang            text NOT NULL DEFAULT 'zh-CN',
  -- pending：已登记、尚未发确认信（当前没有发信服务，全部停在 pending）
  -- subscribed：确认后开始投递；unsubscribed：已退订
  status          text NOT NULL DEFAULT 'pending',
  token           text NOT NULL DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 32),
  source          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz,
  CONSTRAINT subscribers_email_key    UNIQUE (email),
  CONSTRAINT subscribers_email_shape  CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
                                                AND char_length(email) <= 254),
  CONSTRAINT subscribers_status_chk   CHECK (status IN ('pending', 'subscribed', 'unsubscribed')),
  CONSTRAINT subscribers_lang_chk     CHECK (lang IN ('zh-CN', 'en'))
);


-- S6. 订阅表开启 RLS（先 GRANT 后 POLICY，缺 GRANT 会得到形似策略失效的 42501）
ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;


-- S7. 客户端一律无直接权限：读、写、改、删都只能走 RPC
REVOKE ALL ON public.subscribers FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscribers TO service_role;


-- S8. subscribe_add：登记订阅（匿名可调） ---------------------------------
--     重复邮箱不报错、不透露是否已存在（避免邮箱枚举），统一返回 {ok:true}。
CREATE OR REPLACE FUNCTION public.subscribe_add(p_email text, p_lang text DEFAULT 'zh-CN')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_email text := lower(btrim(COALESCE(p_email, '')));
  v_lang  text := CASE WHEN COALESCE(p_lang, '') = 'en' THEN 'en' ELSE 'zh-CN' END;
BEGIN
  IF v_email = '' OR char_length(v_email) > 254 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_email');
  END IF;
  IF v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_email');
  END IF;

  INSERT INTO public.subscribers (email, lang, status, source)
  VALUES (v_email, v_lang, 'pending', 'web')
  ON CONFLICT (email) DO NOTHING;

  -- 已退订的邮箱再次订阅 → 回到 pending（等确认信）
  UPDATE public.subscribers
     SET status = 'pending',
         unsubscribed_at = NULL
   WHERE email = v_email
     AND status = 'unsubscribed';

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.subscribe_add(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscribe_add(text, text) TO anon, authenticated;


-- S9. subscribe_remove：凭令牌退订（将来放进邮件页脚） ---------------------
CREATE OR REPLACE FUNCTION public.subscribe_remove(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_token text := btrim(COALESCE(p_token, ''));
  v_rows  int;
BEGIN
  IF v_token = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  UPDATE public.subscribers
     SET status = 'unsubscribed',
         unsubscribed_at = now()
   WHERE token = v_token
     AND status <> 'unsubscribed';
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object('ok', v_rows > 0);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.subscribe_remove(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscribe_remove(text) TO anon, authenticated;


-- S10. admin_subscribers_page：后台看订阅名单（只读、分页） ---------------
--      不开表级 SELECT，邮箱只经这个函数出给管理员。
CREATE OR REPLACE FUNCTION public.admin_subscribers_page(p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit  int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_total  bigint;
  v_rows   jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT count(*) INTO v_total FROM public.subscribers;

  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT email, lang, status, created_at
        FROM public.subscribers
       ORDER BY created_at DESC
       LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total,
                            'rows', v_rows, 'limit', v_limit, 'offset', v_offset);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_subscribers_page(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_subscribers_page(int, int) TO authenticated;


-- =====================================================================
-- 回滚（如需）：
--   DROP VIEW IF EXISTS public.comments_public;
--   DROP VIEW IF EXISTS public.post_stats_public;
--   DROP FUNCTION IF EXISTS public.subscribe_add(text, text);
--   DROP FUNCTION IF EXISTS public.subscribe_remove(text);
--   DROP FUNCTION IF EXISTS public.admin_subscribers_page(int, int);
--   DROP TABLE IF EXISTS public.subscribers;
--   -- posts_public 回滚成不带 series 的定义；cloud_posts.series 可保留（加列无害）
-- =====================================================================
