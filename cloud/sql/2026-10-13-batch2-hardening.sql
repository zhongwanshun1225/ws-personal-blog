-- =====================================================================
-- WS Blog · 第二批安全加固（1.4 浏览量白名单 / 1.5 公开视图 / 1.7a 审计日志
--                        / 1.7c profiles.status 保护 / 1.7d 时间字段防伪造）
--
-- 兼容性说明：
--   * 1.5 的三个旧公开读策略（posts_public_read / profiles_read_all /
--     likes_read_all）在本文件中【不删除】—— 视图与旧策略先并存，
--     待前端全部切换到视图并重新发布后，再执行
--     2026-10-13-batch2b-retire-policies.sql 撤销，保证零中断上线。
--   * post_view 的返回类型不变（bigint），可直接 CREATE OR REPLACE。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.4a 已知 slug 白名单（防 post_views 被随机 slug 撑表）
-- 静态文章 slug 由构建期生成 slug-manifest.json，管理员打开后台时经
-- admin_sync_slugs() 全量同步；云端文章不经此表（post_view 直接查 cloud_posts）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.known_slugs (
  slug       text PRIMARY KEY,
  kind       text        NOT NULL DEFAULT 'static',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 存量浏览数据里的静态 slug 直接导入，避免上线即停计
INSERT INTO public.known_slugs (slug, kind)
SELECT DISTINCT post_slug, 'static' FROM public.post_views
WHERE post_slug NOT LIKE 'cloud:%'
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1.4b post_view 重写：slug 校验 + 白名单（原为无校验的 SQL 函数）
--   * cloud:<slug> 必须对应已发布云文章
--   * 其余 slug 必须在 known_slugs（静态文章清单）
--   * 不满足时返回当前计数但不写入 —— 匿名脚本无法再灌入任意行
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_view(p_slug text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_clean text;
  v_views bigint;
BEGIN
  v_clean := left(btrim(coalesce(p_slug, '')), 200);
  IF v_clean = '' THEN
    RETURN 0;
  END IF;

  IF v_clean LIKE 'cloud:%' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cloud_posts
      WHERE slug = substr(v_clean, 7) AND status = 'published'
    ) THEN
      RETURN COALESCE((SELECT views FROM public.post_views WHERE post_slug = v_clean), 0);
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.known_slugs WHERE slug = v_clean) THEN
      RETURN COALESCE((SELECT views FROM public.post_views WHERE post_slug = v_clean), 0);
    END IF;
  END IF;

  INSERT INTO public.post_views (post_slug, views)
  VALUES (v_clean, 1)
  ON CONFLICT (post_slug)
  DO UPDATE SET views = public.post_views.views + 1, updated_at = now()
  RETURNING views INTO v_views;
  RETURN v_views;
END
$function$;

-- 1.4c 只读计数：前端同一会话内重复访问不再自增，只读取当前值
CREATE OR REPLACE FUNCTION public.post_view_read(p_slug text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT views FROM public.post_views
     WHERE post_slug = left(btrim(coalesce(p_slug, '')), 200)),
    0)
$function$;

-- 1.4d 管理员同步静态 slug 清单（打开后台时静默调用）
CREATE OR REPLACE FUNCTION public.admin_sync_slugs(p_slugs jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_row   jsonb;
  v_slug  text;
  v_total integer;
  v_in    integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_slugs IS NULL OR jsonb_typeof(p_slugs) <> 'array' THEN
    RAISE EXCEPTION 'expected json array' USING ERRCODE = '22023';
  END IF;

  CREATE TEMP TABLE _sync_slugs (slug text PRIMARY KEY) ON COMMIT DROP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_slugs) LOOP
    v_slug := left(btrim(coalesce(v_row ->> 'slug', v_row #>> '{}', '')), 200);
    IF v_slug <> '' THEN
      INSERT INTO _sync_slugs (slug) VALUES (v_slug) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_in FROM _sync_slugs;

  DELETE FROM public.known_slugs
   WHERE kind = 'static' AND slug NOT IN (SELECT slug FROM _sync_slugs);

  INSERT INTO public.known_slugs (slug, kind)
  SELECT slug, 'static' FROM _sync_slugs
  ON CONFLICT (slug) DO UPDATE SET updated_at = now();

  SELECT count(*) INTO v_total FROM public.known_slugs;

  PERFORM public.audit_log(
    'slugs_sync', 'site', NULL, NULL,
    jsonb_build_object('received', v_in, 'total', v_total)
  );
  RETURN v_total;
END
$function$;

-- ---------------------------------------------------------------------
-- 1.7a 管理操作审计日志
--   * 表只对管理员可读（RLS + 仅 GRANT SELECT 给 authenticated）
--   * 写入只能经 SECURITY DEFINER 的 audit_log / 触发器，客户端无 INSERT 权限
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    text,
  actor_email text,
  action      text        NOT NULL,
  target_type text,
  target_id   text,
  note        text,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.admin_audit_log FROM anon, authenticated;
GRANT SELECT ON public.admin_audit_log TO authenticated;

CREATE POLICY audit_admin_read ON public.admin_audit_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx
  ON public.admin_audit_log (created_at DESC);

-- 统一写入入口；EXECUTE 从 PUBLIC 收回，客户端不能直接伪造日志
CREATE OR REPLACE FUNCTION public.audit_log(
  p_action      text,
  p_target_type text,
  p_target_id   text,
  p_note        text  DEFAULT NULL,
  p_payload     jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  INSERT INTO public.admin_audit_log
    (actor_id, actor_email, action, target_type, target_id, note, payload)
  VALUES
    (auth.uid()::text, auth.email(), p_action, p_target_type, p_target_id, p_note, p_payload);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.audit_log(text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1.7a 五个管理 RPC 补审计（返回类型不变，直接 OR REPLACE）
-- ---------------------------------------------------------------------
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

  PERFORM public.audit_log(
    'post_review', 'cloud_post', btrim(p_slug),
    p_action || coalesce(' / ' || NULLIF(btrim(COALESCE(p_note, '')), ''), ''),
    jsonb_build_object('action', p_action, 'note', p_note)
  );

  RETURN jsonb_build_object('ok', true, 'slug', btrim(p_slug), 'action', p_action);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_user_status(p_owner text, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RETURN false;
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'disabled') THEN
    RETURN false;
  END IF;
  IF p_owner IS NULL OR p_owner = '' OR p_owner = auth.uid()::text THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id::text = p_owner) THEN
    RETURN false;
  END IF;

  INSERT INTO public.profiles (owner_id, nickname, status, updated_at)
  SELECT u.id::text, COALESCE(NULLIF(u.name, ''), split_part(u.email, '@', 1)), p_status, now()
  FROM auth.users u
  WHERE u.id::text = p_owner
  ON CONFLICT (owner_id) DO UPDATE
    SET status = EXCLUDED.status, updated_at = now();

  PERFORM public.audit_log('user_status', 'user', p_owner, p_status,
    jsonb_build_object('status', p_status));
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_user(p_owner text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RETURN false;
  END IF;
  IF p_owner IS NULL OR p_owner = '' OR p_owner = auth.uid()::text THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id::text = p_owner) THEN
    RETURN false;
  END IF;

  DELETE FROM public.comments WHERE owner_id = p_owner;
  DELETE FROM public.post_likes WHERE owner_id = p_owner;
  DELETE FROM public.post_bookmarks WHERE owner_id = p_owner;

  UPDATE public.comments SET parent_id = NULL
   WHERE parent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.comments c WHERE c.id = parent_id);

  INSERT INTO public.profiles (owner_id, nickname, avatar_url, bio, status, updated_at)
  VALUES (p_owner, NULL, NULL, NULL, 'disabled', now())
  ON CONFLICT (owner_id) DO UPDATE
    SET nickname = NULL, avatar_url = NULL, bio = NULL, status = 'disabled', updated_at = now();

  PERFORM public.audit_log('user_delete', 'user', p_owner, NULL,
    jsonb_build_object('cleared', 'comments/likes/bookmarks/profile'));
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_add_email(p_email text, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR position('@' in p_email) < 2 THEN
    RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.admin_emails(email, note)
  VALUES (lower(trim(p_email)), p_note)
  ON CONFLICT (email) DO UPDATE SET note = EXCLUDED.note;

  PERFORM public.audit_log('admin_add', 'admin_email', lower(trim(p_email)), p_note, NULL);
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_email(p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF lower(trim(p_email)) = lower(coalesce(auth.email(), '')) THEN
    RAISE EXCEPTION 'cannot remove your own admin rights' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.admin_emails WHERE email = lower(trim(p_email));

  PERFORM public.audit_log('admin_remove', 'admin_email', lower(trim(p_email)), NULL, NULL);
  RETURN true;
END
$function$;

-- ---------------------------------------------------------------------
-- 1.7a 表级删除/状态变更审计（删帖、删评论、评论显隐——走 RLS 的操作无 RPC 可挂）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_cloud_post_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  INSERT INTO public.admin_audit_log (actor_id, actor_email, action, target_type, target_id, payload)
  VALUES (
    auth.uid()::text, auth.email(), 'post_delete', 'cloud_post', OLD.slug,
    jsonb_build_object('title', OLD.title, 'status', OLD.status, 'author_id', OLD.author_id)
  );
  RETURN OLD;
END
$function$;

DROP TRIGGER IF EXISTS cloud_posts_audit_trg ON public.cloud_posts;
CREATE TRIGGER cloud_posts_audit_trg
  AFTER DELETE ON public.cloud_posts
  FOR EACH ROW EXECUTE FUNCTION public.audit_cloud_post_delete();

CREATE OR REPLACE FUNCTION public.audit_comments_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.admin_audit_log (actor_id, actor_email, action, target_type, target_id, payload)
    VALUES (
      auth.uid()::text, auth.email(), 'comment_delete', 'comment', OLD.id::text,
      jsonb_build_object('post_slug', OLD.post_slug, 'owner_id', OLD.owner_id,
                         'excerpt', left(OLD.content, 80))
    );
    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.admin_audit_log (actor_id, actor_email, action, target_type, target_id, payload)
    VALUES (
      auth.uid()::text, auth.email(), 'comment_status', 'comment', NEW.id::text,
      jsonb_build_object('post_slug', NEW.post_slug, 'from', OLD.status, 'to', NEW.status)
    );
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS comments_audit_trg ON public.comments;
CREATE TRIGGER comments_audit_trg
  AFTER DELETE OR UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.audit_comments_change();

-- ---------------------------------------------------------------------
-- 1.7c + 1.7d profiles 写入防护
--   * status 只有管理员能改（原来仅靠 is_active() 快照兜底，太脆）
--   * created_at 不可伪造；updated_at 服务端定稿
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    NEW.created_at := OLD.created_at;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT public.is_admin() THEN
    NEW.status := OLD.status;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS profiles_guard_trg ON public.profiles;
CREATE TRIGGER profiles_guard_trg
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();

-- ---------------------------------------------------------------------
-- 1.5 公开读取改视图（列级收敛）
--   * 视图为 definer 语义：内部按 owner 绕过 RLS，但只暴露白名单列；
--     基表的敏感列（review_note/reviewed_by/author_id、profiles.status）不出视图。
--   * 与旧策略并存的过渡期内匿名两条路都能读；batch2b 删旧策略后只剩视图。
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.posts_public AS
SELECT id, slug, title, summary, tags, content_md, published_at, created_at, updated_at
FROM public.cloud_posts
WHERE status = 'published';

GRANT SELECT ON public.posts_public TO anon, authenticated;

CREATE OR REPLACE VIEW public.profiles_public AS
SELECT owner_id, nickname, avatar_url, bio
FROM public.profiles;

GRANT SELECT ON public.profiles_public TO anon, authenticated;
