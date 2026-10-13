-- ============================================================
-- WS Blog · 用户管理能力（2026-10-13）
--
-- 背景：登录沿用云服务内置认证（邮箱 + 密码 / 邮箱验证码），
--       密码由平台以 bcrypt 加密托管（auth.users.password，$2a$ 前缀），
--       本站既看不到也无法代改 —— 因此「禁用 / 删除」作用于本站数据层，
--       「重置密码」由用户在登录页「忘记密码」自助完成。
--
-- 应用：wbapp_4Kq5LMrPlZrJl7t1FUig3H
-- 执行方式：逐条（每条一个语句）在云数据库执行；含多条语句的用 DO 块包住。
-- 幂等性：全部使用 IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS，可重复执行。
-- ============================================================

-- ---------- 1. 用户状态字段 ----------
-- active（默认）/ disabled：被禁用的账号仍可登录浏览，但不能写任何数据。
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- ---------- 2. 是否可用（供 RLS 与函数共用）----------
-- 没有 profiles 行的新用户视为可用；传入 p_uid 可查他人。
CREATE OR REPLACE FUNCTION public.is_active(p_uid text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE owner_id = COALESCE(NULLIF(p_uid, ''), auth.uid()::text)
      AND status = 'disabled'
  )
$function$;

-- ---------- 3. 当前账号状态 ----------
-- 前端用来判断「我是否被禁用」，未登录返回 NULL。
CREATE OR REPLACE FUNCTION public.my_account()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    ELSE jsonb_build_object(
      'uid', auth.uid()::text,
      'email', COALESCE(auth.email(), ''),
      'is_admin', public.is_admin(),
      'is_active', public.is_active(),
      'status', COALESCE((SELECT p.status FROM public.profiles p WHERE p.owner_id = auth.uid()::text), 'active'),
      'nickname', (SELECT p.nickname FROM public.profiles p WHERE p.owner_id = auth.uid()::text)
    )
  END
$function$;

-- ---------- 4. 写操作策略：加一层 is_active 校验 ----------
-- USING 保持原样（读 / 删不受影响），WITH CHECK 增加账号状态判断，
-- 于是被禁用的账号即使拿着有效登录态也无法插入 / 更新数据。
DO $do$
BEGIN
  DROP POLICY IF EXISTS comments_own_all ON public.comments;
  CREATE POLICY comments_own_all ON public.comments FOR ALL
    USING (owner_id = auth.uid()::text)
    WITH CHECK (owner_id = auth.uid()::text AND public.is_active());

  DROP POLICY IF EXISTS likes_own_all ON public.post_likes;
  CREATE POLICY likes_own_all ON public.post_likes FOR ALL
    USING (owner_id = auth.uid()::text)
    WITH CHECK (owner_id = auth.uid()::text AND public.is_active());

  DROP POLICY IF EXISTS bookmarks_own_all ON public.post_bookmarks;
  CREATE POLICY bookmarks_own_all ON public.post_bookmarks FOR ALL
    USING (owner_id = auth.uid()::text)
    WITH CHECK (owner_id = auth.uid()::text AND public.is_active());

  DROP POLICY IF EXISTS profiles_own_all ON public.profiles;
  CREATE POLICY profiles_own_all ON public.profiles FOR ALL
    USING (owner_id = auth.uid()::text)
    WITH CHECK (owner_id = auth.uid()::text AND public.is_active());

  DROP POLICY IF EXISTS comments_admin_all ON public.comments;
  CREATE POLICY comments_admin_all ON public.comments FOR ALL
    USING (public.is_admin())
    WITH CHECK (public.is_admin() AND public.is_active());

  DROP POLICY IF EXISTS posts_admin_all ON public.cloud_posts;
  CREATE POLICY posts_admin_all ON public.cloud_posts FOR ALL
    USING (public.is_admin())
    WITH CHECK (public.is_admin() AND public.is_active());
END
$do$;

-- ---------- 5. 用户列表（返回类型已变，先 DROP 再建）----------
DROP FUNCTION IF EXISTS public.admin_users();

-- 以 auth.users 为主表，这样「注册了但还没填资料」的账号也能被管理。
-- project 过滤用当前登录账号的 project 兜底，避免取不到时列出别处用户。
CREATE OR REPLACE FUNCTION public.admin_users()
RETURNS TABLE(
  owner_id text,
  email text,
  nickname text,
  avatar_url text,
  bio text,
  status text,
  is_admin boolean,
  is_self boolean,
  created_at timestamp with time zone,
  last_login timestamp with time zone,
  comment_count bigint,
  like_count bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT u.id::text AS owner_id,
         u.email::text AS email,
         p.nickname,
         p.avatar_url,
         p.bio,
         COALESCE(p.status, 'active') AS status,
         EXISTS (SELECT 1 FROM public.admin_emails a WHERE lower(a.email) = lower(u.email::text)) AS is_admin,
         (u.id::text = auth.uid()::text) AS is_self,
         COALESCE(p.created_at, u.created_at) AS created_at,
         u.last_login,
         (SELECT count(*) FROM public.comments c WHERE c.owner_id = u.id::text) AS comment_count,
         (SELECT count(*) FROM public.post_likes l WHERE l.owner_id = u.id::text) AS like_count
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.owner_id = u.id::text
  WHERE public.is_admin()
    AND u.email IS NOT NULL
    AND u.project = COALESCE((SELECT uu.project FROM auth.users uu WHERE uu.id::text = auth.uid()::text LIMIT 1), u.project)
  ORDER BY COALESCE(p.created_at, u.created_at) DESC
  LIMIT 500
$function$;

-- ---------- 6. 禁用 / 启用账号 ----------
-- 不允许操作自己（防止管理员把自己锁死）。
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

  RETURN true;
END
$function$;

-- ---------- 7. 删除用户 ----------
-- 平台上的登录账号无法删除，所以「删除」= 清空本站内容 + 清空资料 + 禁用账号，
-- 该用户再次登录时会以「已禁用 + 空资料」出现在列表里，而不是重新变成正常用户。
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

  -- 被删掉的评论若是别人的回复对象，把这些回复提升为顶层评论，避免悬空 parent_id
  UPDATE public.comments SET parent_id = NULL
   WHERE parent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.comments c WHERE c.id = parent_id);

  INSERT INTO public.profiles (owner_id, nickname, avatar_url, bio, status, updated_at)
  VALUES (p_owner, NULL, NULL, NULL, 'disabled', now())
  ON CONFLICT (owner_id) DO UPDATE
    SET nickname = NULL, avatar_url = NULL, bio = NULL, status = 'disabled', updated_at = now();

  RETURN true;
END
$function$;

-- ---------- 8. 概览统计：用户数改用 auth.users 口径，并新增禁用数 ----------
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
    'posts', (SELECT count(*) FROM public.cloud_posts),
    'drafts', (SELECT count(*) FROM public.cloud_posts WHERE status <> 'published'),
    'today_comments', (SELECT count(*) FROM public.comments WHERE created_at >= now() - interval '24 hours'),
    'views', (SELECT COALESCE(sum(views), 0) FROM public.post_views)
  ) ELSE NULL END
$function$;
