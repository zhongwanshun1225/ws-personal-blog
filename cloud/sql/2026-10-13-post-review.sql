-- =====================================================================
-- 用户投稿 + 管理员审核（2026-10-13）
--
-- 状态机：
--   draft（作者草稿）→ pending（提交待审）→ published（管理员通过，前台可见）
--                                          ↘ rejected（驳回，附 review_note 理由）
-- 管理员自己写的文章不受审核限制（posts_admin_all 仍可直接 published）。
-- 已在云端执行并验证（匿名插入返回 401，探针未落库）。
-- =====================================================================

-- 1) 审核字段 ----------------------------------------------------------------

ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS reviewed_at timestamp with time zone;
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS reviewed_by text;
CREATE INDEX IF NOT EXISTS posts_author_idx ON public.cloud_posts (author_id, updated_at DESC);

-- 2) 作者侧 RLS（与管理员策略 OR 关系） ---------------------------------------
--    insert：只能落 draft / pending，直接写 published 会被拒
--    update：published 行作者改不动（USING），新状态也只能是三态之一
--    delete：published 行作者删不动，要删先请管理员下架

DO $do$
BEGIN
  DROP POLICY IF EXISTS posts_own_read ON public.cloud_posts;
  CREATE POLICY posts_own_read ON public.cloud_posts FOR SELECT
    USING (author_id = auth.uid());

  DROP POLICY IF EXISTS posts_own_insert ON public.cloud_posts;
  CREATE POLICY posts_own_insert ON public.cloud_posts FOR INSERT
    WITH CHECK (author_id = auth.uid() AND public.is_active() AND status IN ('draft', 'pending'));

  DROP POLICY IF EXISTS posts_own_update ON public.cloud_posts;
  CREATE POLICY posts_own_update ON public.cloud_posts FOR UPDATE
    USING (author_id = auth.uid() AND status <> 'published')
    WITH CHECK (author_id = auth.uid() AND public.is_active() AND status IN ('draft', 'pending', 'rejected'));

  DROP POLICY IF EXISTS posts_own_delete ON public.cloud_posts;
  CREATE POLICY posts_own_delete ON public.cloud_posts FOR DELETE
    USING (author_id = auth.uid() AND status <> 'published');
END
$do$;

-- 3) 审核动作（仅管理员；approve=通过并发布 / reject=驳回 / unpublish=下架） ----

CREATE OR REPLACE FUNCTION public.admin_review_post(p_slug text, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_exists boolean;
BEGIN
  IF NOT public.is_admin() OR NOT public.is_active() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_slug IS NULL OR btrim(p_slug) = '' OR p_action IS NULL
     OR p_action NOT IN ('approve', 'reject', 'unpublish') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
  END IF;

  SELECT true INTO v_exists FROM public.cloud_posts WHERE slug = btrim(p_slug);
  IF v_exists IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF p_action = 'approve' THEN
    UPDATE public.cloud_posts
       SET status = 'published',
           published_at = COALESCE(published_at, now()),
           review_note = NULL,
           reviewed_at = now(),
           reviewed_by = auth.uid()::text,
           updated_at = now()
     WHERE slug = btrim(p_slug);
  ELSIF p_action = 'reject' THEN
    UPDATE public.cloud_posts
       SET status = 'rejected',
           published_at = NULL,
           review_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
           reviewed_at = now(),
           reviewed_by = auth.uid()::text,
           updated_at = now()
     WHERE slug = btrim(p_slug);
  ELSE
    UPDATE public.cloud_posts
       SET status = 'draft',
           published_at = NULL,
           reviewed_at = now(),
           reviewed_by = auth.uid()::text,
           updated_at = now()
     WHERE slug = btrim(p_slug);
  END IF;

  RETURN jsonb_build_object('ok', true, 'slug', btrim(p_slug), 'action', p_action);
END
$function$;

-- 4) 后台文章列表（全部文章 + 作者信息，待审排最前） ---------------------------

DROP FUNCTION IF EXISTS public.admin_posts();
CREATE OR REPLACE FUNCTION public.admin_posts()
RETURNS TABLE(
  id bigint,
  slug text,
  title text,
  summary text,
  status text,
  author_id text,
  author_name text,
  author_email text,
  is_own boolean,
  tags text[],
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  published_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  review_note text,
  body_length integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT p.id,
         p.slug,
         p.title,
         p.summary,
         p.status,
         p.author_id,
         COALESCE(NULLIF(pr.nickname, ''), NULLIF(u.name, ''), split_part(COALESCE(u.email::text, ''), '@', 1)) AS author_name,
         u.email::text AS author_email,
         (p.author_id = auth.uid()::text) AS is_own,
         p.tags,
         p.created_at,
         p.updated_at,
         p.published_at,
         p.reviewed_at,
         p.review_note,
         length(COALESCE(p.content_md, ''))::integer AS body_length
  FROM public.cloud_posts p
  LEFT JOIN public.profiles pr ON pr.owner_id = p.author_id
  LEFT JOIN auth.users u ON u.id::text = p.author_id
  WHERE public.is_admin()
  ORDER BY (p.status = 'pending') DESC, p.updated_at DESC
  LIMIT 300
$function$;

-- 5) 概览统计：posts 只算已发布，新增 pending / rejected 计数 ------------------

CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT CASE WHEN public.is_admin() THEN jsonb_build_object(
    'users', (SELECT count(*) FROM auth.users u WHERE u.email IS NOT NULL AND u.project = COALESCE((SELECT uu.project FROM auth.users uu WHERE uu.id::text = auth.uid()::text LIMIT 1), u.project)),
    'disabled_users', (SELECT count(*) FROM public.profiles WHERE status = 'disabled'),
    'comments', (SELECT count(*) FROM public.comments),
    'hidden', (SELECT count(*) FROM public.comments WHERE status <> 'visible'),
    'likes', (SELECT count(*) FROM public.post_likes),
    'posts', (SELECT count(*) FROM public.cloud_posts WHERE status = 'published'),
    'drafts', (SELECT count(*) FROM public.cloud_posts WHERE status = 'draft'),
    'pending', (SELECT count(*) FROM public.cloud_posts WHERE status = 'pending'),
    'rejected', (SELECT count(*) FROM public.cloud_posts WHERE status = 'rejected'),
    'today_comments', (SELECT count(*) FROM public.comments WHERE created_at >= now() - interval '24 hours'),
    'views', (SELECT COALESCE(sum(views), 0) FROM public.post_views)
  ) ELSE NULL END
$function$;
