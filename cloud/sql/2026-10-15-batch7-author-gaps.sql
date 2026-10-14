-- =====================================================================
-- batch7 (A) 作者侧缺口：A3 定时发布 / A4 草稿预览分享链接 / A5 修订历史与回滚
-- 2026-10-15
--
-- 设计要点
--  · A3：cloud_posts 加 publish_at。审核通过时若 publish_at 在未来 → status='scheduled'；
--        到点由 publish_scheduled_posts() 翻为 published。posts_public 同时用
--        「status 在 (published,scheduled)」+「publish_at 到点」两个条件兜底，
--        即使没人调用翻转函数，到点也会自动可见（自愈，不依赖定时任务）。
--  · A4：post_previews 存一份内容快照 + 随机 token，公开页凭 token 读，可撤销/过期。
--  · A5：post_revisions 在 cloud_posts 内容变化前自动存快照（INSERT 存初版），
--        可列出 / 查看 / 回滚；回滚走 author_update_post 以复用「受信任直改 / 其余转待审」规则。
--
-- 约定：SECURITY DEFINER 一律 SET search_path TO 'public','auth'
-- =====================================================================

-- ---------- 0. 基础列 ----------
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS publish_at timestamptz;
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS weight integer NOT NULL DEFAULT 0;

ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS ip_hash text;
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS ua_family text;
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS spam_score integer NOT NULL DEFAULT 0;
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS spam_flags text[];

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_editor boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS cloud_posts_publish_at_idx ON public.cloud_posts (publish_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS cloud_posts_order_idx ON public.cloud_posts (pinned DESC, weight DESC, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS comments_spam_idx ON public.comments (spam_score DESC) WHERE spam_score > 0;

-- ---------- 1. posts_public：只暴露真正到点的文章，并补排序字段 ----------
CREATE OR REPLACE VIEW public.posts_public AS
 SELECT id, slug, title, summary, tags, content_md, published_at, created_at,
        updated_at, author_id, series, pinned, weight, publish_at
   FROM public.cloud_posts
  WHERE status IN ('published', 'scheduled')
    AND (publish_at IS NULL OR publish_at <= now());

GRANT SELECT ON public.posts_public TO anon, authenticated;

-- ---------- 2. 到点发布 ----------
CREATE OR REPLACE FUNCTION public.publish_scheduled_posts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.cloud_posts
     SET status = 'published',
         published_at = COALESCE(publish_at, now()),
         updated_at = now()
   WHERE status = 'scheduled'
     AND publish_at IS NOT NULL
     AND publish_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;

GRANT EXECUTE ON FUNCTION public.publish_scheduled_posts() TO anon, authenticated;

-- ---------- 3. A4 预览分享 ----------
CREATE TABLE IF NOT EXISTS public.post_previews (
  token      text PRIMARY KEY,
  slug       text NOT NULL,
  title      text NOT NULL,
  summary    text,
  content_md text NOT NULL,
  tags       text[] NOT NULL DEFAULT '{}',
  author_id  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  revoked    boolean NOT NULL DEFAULT false
);

ALTER TABLE public.post_previews ENABLE ROW LEVEL SECURITY;
-- 故意不建任何策略：只允许通过下面的 SECURITY DEFINER 函数访问，防止被批量列举。

CREATE INDEX IF NOT EXISTS post_previews_slug_idx ON public.post_previews (slug, created_at DESC);

CREATE OR REPLACE FUNCTION public.post_preview_create(p_slug text, p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid  text := auth.uid()::text;
  v_row  public.cloud_posts;
  v_days integer := GREATEST(1, LEAST(COALESCE(p_days, 7), 90));
  v_tok  text;
  v_exp  timestamptz;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  IF NOT public.is_active() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inactive');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = btrim(COALESCE(p_slug, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.author_id <> v_uid AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  v_tok := encode(gen_random_bytes(16), 'hex');
  v_exp := now() + (v_days || ' days')::interval;

  INSERT INTO public.post_previews (token, slug, title, summary, content_md, tags, author_id, expires_at)
  VALUES (
    v_tok,
    v_row.slug,
    -- 有待审改稿时，预览看的是「将要上线的那一版」，否则看现版
    COALESCE(NULLIF(btrim(v_row.edit_title), ''), v_row.title),
    COALESCE(v_row.edit_summary, v_row.summary),
    COALESCE(v_row.edit_content_md, v_row.content_md),
    COALESCE(v_row.edit_tags, v_row.tags),
    v_uid,
    v_exp
  );

  RETURN jsonb_build_object('ok', true, 'token', v_tok, 'expires_at', v_exp, 'days', v_days);
END
$function$;

GRANT EXECUTE ON FUNCTION public.post_preview_create(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_preview_list(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_row public.cloud_posts;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = btrim(COALESCE(p_slug, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.author_id <> v_uid AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_out
    FROM (
      SELECT jsonb_build_object(
               'token', token,
               'expires_at', expires_at,
               'created_at', created_at,
               'revoked', revoked,
               'expired', (expires_at <= now()),
               'title', title
             ) AS x
        FROM public.post_previews
       WHERE slug = v_row.slug
       ORDER BY created_at DESC
       LIMIT 20
    ) t;

  RETURN jsonb_build_object('ok', true, 'rows', v_out);
END
$function$;

GRANT EXECUTE ON FUNCTION public.post_preview_list(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_preview_revoke(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_row public.post_previews;
  v_n   integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  SELECT * INTO v_row FROM public.post_previews WHERE token = btrim(COALESCE(p_token, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.author_id <> v_uid AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  UPDATE public.post_previews SET revoked = true WHERE token = v_row.token;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'revoked', v_n);
END
$function$;

GRANT EXECUTE ON FUNCTION public.post_preview_revoke(text) TO authenticated;

-- 公开读取：凭 token 看内容，无需登录（这就是「分享链接」的意义）
CREATE OR REPLACE FUNCTION public.post_preview_get(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_row public.post_previews;
  v_name text;
BEGIN
  SELECT * INTO v_row FROM public.post_previews WHERE token = btrim(COALESCE(p_token, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.revoked THEN
    RETURN jsonb_build_object('ok', false, 'error', 'revoked');
  END IF;
  IF v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;

  v_name := COALESCE(public.display_name_for(v_row.author_id), '作者');

  RETURN jsonb_build_object(
    'ok', true,
    'title', v_row.title,
    'summary', v_row.summary,
    'content_md', v_row.content_md,
    'tags', v_row.tags,
    'slug', v_row.slug,
    'author_name', v_name,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at
  );
END
$function$;

GRANT EXECUTE ON FUNCTION public.post_preview_get(text) TO anon, authenticated;

-- ---------- 4. A5 修订历史 ----------
CREATE TABLE IF NOT EXISTS public.post_revisions (
  id         bigserial PRIMARY KEY,
  slug       text NOT NULL,
  title      text NOT NULL,
  summary    text,
  content_md text NOT NULL,
  tags       text[] NOT NULL DEFAULT '{}',
  author_id  text,
  kind       text NOT NULL DEFAULT 'snapshot',
  saved_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.post_revisions ENABLE ROW LEVEL SECURITY;
-- 同样不建策略，只走 SECURITY DEFINER 函数。

CREATE INDEX IF NOT EXISTS post_revisions_slug_idx ON public.post_revisions (slug, saved_at DESC);

CREATE OR REPLACE FUNCTION public.snapshot_post_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_keep integer := 30;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- 只有内容真的变了才存快照，避免改状态 / 改置顶也刷出一条历史
    IF NEW.title IS NOT DISTINCT FROM OLD.title
       AND COALESCE(NEW.summary, '') IS NOT DISTINCT FROM COALESCE(OLD.summary, '')
       AND NEW.content_md IS NOT DISTINCT FROM OLD.content_md
       AND NEW.tags IS NOT DISTINCT FROM OLD.tags THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.post_revisions (slug, title, summary, content_md, tags, author_id, kind)
    VALUES (OLD.slug, OLD.title, OLD.summary, OLD.content_md, OLD.tags, OLD.author_id, 'before_update');
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.post_revisions (slug, title, summary, content_md, tags, author_id, kind)
    VALUES (NEW.slug, NEW.title, NEW.summary, NEW.content_md, NEW.tags, NEW.author_id, 'initial');
  END IF;

  DELETE FROM public.post_revisions
   WHERE slug = COALESCE(NEW.slug, OLD.slug)
     AND id NOT IN (
       SELECT id FROM public.post_revisions
        WHERE slug = COALESCE(NEW.slug, OLD.slug)
        ORDER BY saved_at DESC, id DESC
        LIMIT v_keep
     );

  RETURN COALESCE(NEW, OLD);
END
$function$;

DROP TRIGGER IF EXISTS cloud_posts_revision_trg ON public.cloud_posts;
CREATE TRIGGER cloud_posts_revision_trg
  AFTER INSERT OR UPDATE ON public.cloud_posts
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_post_revision();

CREATE OR REPLACE FUNCTION public.post_revisions_list(p_slug text, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_row public.cloud_posts;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = btrim(COALESCE(p_slug, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.author_id <> v_uid AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'saved_at' DESC), '[]'::jsonb) INTO v_out
    FROM (
      SELECT jsonb_build_object(
               'id', r.id,
               'title', r.title,
               'kind', r.kind,
               'saved_at', r.saved_at,
               'words', char_length(r.content_md),
               'is_current', (r.title = v_row.title AND r.content_md = v_row.content_md)
             ) AS x
        FROM public.post_revisions r
       WHERE r.slug = v_row.slug
       ORDER BY r.saved_at DESC, r.id DESC
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 60))
    ) t;

  RETURN jsonb_build_object('ok', true, 'rows', v_out);
END
$function$;

GRANT EXECUTE ON FUNCTION public.post_revisions_list(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_revisions_get(p_slug text, p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_row public.cloud_posts;
  v_rev public.post_revisions;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = btrim(COALESCE(p_slug, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.author_id <> v_uid AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT * INTO v_rev FROM public.post_revisions WHERE id = p_id AND slug = v_row.slug;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'revision_not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_rev.id,
    'title', v_rev.title,
    'summary', v_rev.summary,
    'content_md', v_rev.content_md,
    'tags', v_rev.tags,
    'saved_at', v_rev.saved_at,
    'kind', v_rev.kind
  );
END
$function$;

GRANT EXECUTE ON FUNCTION public.post_revisions_get(text, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_revision_restore(p_slug text, p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid   text := auth.uid()::text;
  v_row   public.cloud_posts;
  v_rev   public.post_revisions;
  v_res   jsonb;
  v_tags  jsonb;
  v_trust boolean;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  IF NOT public.is_active() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inactive');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = btrim(COALESCE(p_slug, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.author_id <> v_uid AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT * INTO v_rev FROM public.post_revisions WHERE id = p_id AND slug = v_row.slug;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'revision_not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_tags FROM unnest(v_rev.tags) AS x;

  v_trust := public.is_staff()
    OR COALESCE((SELECT p.can_publish FROM public.profiles p WHERE p.owner_id = v_row.author_id), false);

  IF v_trust THEN
    UPDATE public.cloud_posts
       SET title = v_rev.title,
           summary = v_rev.summary,
           content_md = v_rev.content_md,
           tags = v_rev.tags,
           updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('ok', true, 'mode', 'direct', 'slug', v_row.slug, 'restored_from', v_rev.id);
  END IF;

  -- 普通作者：复用「改稿待审」通道，线上版本不被回滚打断
  v_res := public.author_update_post(
    v_row.slug, v_rev.title, v_rev.summary, v_rev.content_md, v_tags, true
  );
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('restored_from', v_rev.id);
END
$function$;

GRANT EXECUTE ON FUNCTION public.post_revision_restore(text, bigint) TO authenticated;
