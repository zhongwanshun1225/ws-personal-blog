-- =====================================================================
-- WS Blog · 第三批（运营闭环） 2026-10-13
--
-- 三件事：
--   A. 站内通知系统  —— 评论/回复通知作者与站长；投稿审核结果通知作者；
--                       新投稿待审通知站长。互动闭环补上第 2 环。
--   B. 后台列表分页与搜索 —— admin_posts_page / admin_comments_page /
--                       admin_users_page，全部服务端分页 + 关键词 + 状态筛选。
--   C. 顺手修一个洞 —— admin_audit_log 建表时漏了 ENABLE ROW LEVEL SECURITY，
--                       策略形同虚设（任何已登录用户可读全部审计日志）。
--
-- 设计要点：
--   * 通知写入只能经 SECURITY DEFINER 触发器；客户端对 notifications 表
--     没有任何表级权限，读取/标记已读/删除一律走 RPC，全部以 auth.uid() 为边界。
--   * 收件人去重：同一事件里「被回复人 / 文章作者 / 全体管理员」三方取并集，
--     自己给自己不发（notify_push 内部统一拦截）。
--   * 分页函数返回 jsonb {ok,total,rows}，前端一次拿全所需信息。
--   * 全部语句幂等（IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS）。
--
-- 应用方式：一条一条执行（REST 通道一次只接受一条语句）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- A1. 通知表
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id text        NOT NULL,
  kind         text        NOT NULL,
  title        text        NOT NULL,
  body         text,
  link         text,
  actor_id     text,
  actor_name   text,
  post_slug    text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_recipient_idx
  ON public.notifications (recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON public.notifications (recipient_id) WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- 表级权限：只 REVOKE，不 GRANT —— 客户端一律走 RPC，直连打表会 42501。
-- 四个通知 RPC（my_notifications / notify_unread_count / notify_mark_read / notify_clear）
-- 均为 SECURITY DEFINER，且函数体内自行以 `recipient_id = auth.uid()` 收窄
-- （auth.uid() 为空时直接返回），所以不需要任何表级授权。
-- 不给 authenticated 表权限比给更强：SECURITY DEFINER 函数以表属主身份运行、
-- 不受 RLS 约束，真正拦住跨用户访问的是函数体内的 uid 过滤，而非 RLS。
-- ⚠️ 2026-10-13 上线后实测（aclexplode on relacl）：线上该表 ACL 只含表属主与
--    service_role，authenticated / anon 无任何表权限 —— 与本节声明一致。
REVOKE ALL ON public.notifications FROM anon, authenticated;

-- 以下三条策略目前不会被执行到（表级已无权限），保留作为「将来若放开表级
-- SELECT/UPDATE/DELETE 时的行级兜底」，不要删。

DROP POLICY IF EXISTS notifications_own_read ON public.notifications;
CREATE POLICY notifications_own_read ON public.notifications FOR SELECT
  TO authenticated USING (recipient_id = auth.uid()::text);

DROP POLICY IF EXISTS notifications_own_update ON public.notifications;
CREATE POLICY notifications_own_update ON public.notifications FOR UPDATE
  TO authenticated
  USING (recipient_id = auth.uid()::text)
  WITH CHECK (recipient_id = auth.uid()::text);

DROP POLICY IF EXISTS notifications_own_delete ON public.notifications;
CREATE POLICY notifications_own_delete ON public.notifications FOR DELETE
  TO authenticated USING (recipient_id = auth.uid()::text);

-- ---------------------------------------------------------------------
-- A2. 通知行防篡改：只有 read_at 可被收件人改动
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notifications_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;
  NEW.recipient_id := OLD.recipient_id;
  NEW.kind         := OLD.kind;
  NEW.title        := OLD.title;
  NEW.body         := OLD.body;
  NEW.link         := OLD.link;
  NEW.actor_id     := OLD.actor_id;
  NEW.actor_name   := OLD.actor_name;
  NEW.post_slug    := OLD.post_slug;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS notifications_guard_trg ON public.notifications;
CREATE TRIGGER notifications_guard_trg
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_guard();

-- ---------------------------------------------------------------------
-- A3. 显示名解析（触发器中给「谁发起的」填一个人类可读的名字）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.display_name_for(p_uid text)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT COALESCE(
    NULLIF(btrim(p.nickname), ''),
    NULLIF(u.name, ''),
    NULLIF(split_part(COALESCE(u.email::text, ''), '@', 1), ''),
    '某位用户')
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.owner_id = u.id::text
  WHERE u.id::text = p_uid
$function$;

REVOKE EXECUTE ON FUNCTION public.display_name_for(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- A4. 管理员收件人清单（同 project，可排除某个 uid）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_recipient_ids(p_exclude text DEFAULT NULL)
RETURNS text[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT COALESCE(array_agg(DISTINCT u.id::text), ARRAY[]::text[])
  FROM auth.users u
  JOIN public.admin_emails a ON lower(a.email) = lower(u.email::text)
  WHERE u.email IS NOT NULL
    AND u.project = COALESCE(
      (SELECT uu.project FROM auth.users uu WHERE uu.id::text = auth.uid()::text LIMIT 1),
      u.project)
    AND (p_exclude IS NULL OR u.id::text <> p_exclude)
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_recipient_ids(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- A5. 统一写入入口（只允许触发器/其他 definer 函数调用）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_push(
  p_recipient  text,
  p_kind       text,
  p_title      text,
  p_body       text DEFAULT NULL,
  p_link       text DEFAULT NULL,
  p_actor_id   text DEFAULT NULL,
  p_actor_name text DEFAULT NULL,
  p_post_slug  text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_id bigint;
BEGIN
  IF p_recipient IS NULL OR btrim(p_recipient) = '' THEN
    RETURN NULL;
  END IF;
  -- 自己的动作不给自己发通知
  IF p_recipient = COALESCE(auth.uid()::text, '') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notifications
    (recipient_id, kind, title, body, link, actor_id, actor_name, post_slug)
  VALUES
    (btrim(p_recipient), left(p_kind, 40), left(p_title, 200), left(p_body, 500),
     left(p_link, 300), p_actor_id, left(p_actor_name, 60), left(p_post_slug, 200))
  RETURNING id INTO v_id;

  RETURN v_id;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.notify_push(text, text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- A6. 评论 / 回复 → 通知
--   收件人 = {被回复人, 文章作者, 全体管理员} − {自己}
--   被回复人收到的是「回复」，其余收到「评论」
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_comment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_actor        text := COALESCE(auth.uid()::text, NEW.owner_id);
  v_actor_name   text := COALESCE(NULLIF(btrim(NEW.author_name), ''), '读者');
  v_ref          text := NEW.post_slug;
  v_slug         text;
  v_title        text;
  v_link         text;
  v_post_author  text;
  v_parent_author text;
  v_rec          text;
  v_excerpt      text := left(btrim(NEW.content), 120);
BEGIN
  v_slug := CASE WHEN v_ref LIKE 'cloud:%' THEN substr(v_ref, 7) ELSE v_ref END;

  SELECT author_id, title INTO v_post_author, v_title
    FROM public.cloud_posts WHERE slug = v_slug;
  IF v_title IS NULL THEN
    v_title := v_slug;
  END IF;

  v_link := CASE
    WHEN v_ref LIKE 'cloud:%' THEN 'post.html?slug=' || v_slug
    ELSE 'posts/' || v_slug || '.html'
  END;

  -- 1) 被回复的人
  IF NEW.parent_id IS NOT NULL THEN
    SELECT owner_id INTO v_parent_author FROM public.comments WHERE id = NEW.parent_id;
    IF v_parent_author IS NOT NULL AND v_parent_author <> v_actor THEN
      PERFORM public.notify_push(
        v_parent_author, 'reply',
        v_actor_name || ' 回复了你的评论',
        v_excerpt, v_link, v_actor, v_actor_name, v_ref);
    END IF;
  END IF;

  -- 2) 文章作者（云端文章才有）
  IF v_post_author IS NOT NULL
     AND v_post_author <> v_actor
     AND v_post_author IS DISTINCT FROM v_parent_author THEN
    PERFORM public.notify_push(
      v_post_author, 'comment',
      v_actor_name || ' 评论了《' || v_title || '》',
      v_excerpt, v_link, v_actor, v_actor_name, v_ref);
  END IF;

  -- 3) 站长（静态文章没有作者，这里是唯一出口）
  FOR v_rec IN
    SELECT x FROM unnest(public.admin_recipient_ids(v_actor)) AS x
     WHERE x <> COALESCE(v_parent_author, '')
       AND x <> COALESCE(v_post_author, '')
  LOOP
    PERFORM public.notify_push(
      v_rec, 'comment',
      v_actor_name || ' 评论了《' || v_title || '》',
      v_excerpt, v_link, v_actor, v_actor_name, v_ref);
  END LOOP;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS comments_notify_trg ON public.comments;
CREATE TRIGGER comments_notify_trg
  AFTER INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_comment();

-- ---------------------------------------------------------------------
-- A7. 文章状态流转 → 通知
--   draft/pending → pending       : 通知站长「有新投稿待审」
--   → published                   : 通知作者「已通过」
--   → rejected                    : 通知作者「未通过 + 理由」
--   published → draft             : 通知作者「已下架」
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_post_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_actor      text := COALESCE(auth.uid()::text, NEW.author_id);
  v_actor_name text;
  v_link       text;
  v_rec        text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  v_actor_name := COALESCE(public.display_name_for(v_actor), '站长');
  v_link := 'write.html?slug=' || NEW.slug;

  -- 作者侧
  IF NEW.author_id IS NOT NULL AND NEW.author_id <> v_actor THEN
    IF NEW.status = 'published' THEN
      PERFORM public.notify_push(
        NEW.author_id, 'post_approved',
        '投稿《' || NEW.title || '》已通过',
        '站长已审核通过，文章现在可以在前台看到了。',
        'post.html?slug=' || NEW.slug, v_actor, v_actor_name, NEW.slug);
    ELSIF NEW.status = 'rejected' THEN
      PERFORM public.notify_push(
        NEW.author_id, 'post_rejected',
        '投稿《' || NEW.title || '》未通过',
        COALESCE(NULLIF(btrim(NEW.review_note), ''), '站长没有填写理由，修改后可以重新提交。'),
        v_link, v_actor, v_actor_name, NEW.slug);
    ELSIF NEW.status = 'draft' AND OLD.status = 'published' THEN
      PERFORM public.notify_push(
        NEW.author_id, 'post_unpublished',
        '文章《' || NEW.title || '》已下架',
        '站长把它转回了草稿，前台暂时不可见。',
        v_link, v_actor, v_actor_name, NEW.slug);
    END IF;
  END IF;

  -- 站长侧：新投稿待审
  IF NEW.status = 'pending' AND OLD.status <> 'pending' THEN
    FOR v_rec IN SELECT x FROM unnest(public.admin_recipient_ids(v_actor)) AS x LOOP
      PERFORM public.notify_push(
        v_rec, 'post_pending',
        '新投稿待审核：《' || NEW.title || '》',
        left(COALESCE(NULLIF(btrim(NEW.summary), ''), '作者没有填写摘要。'), 200),
        'admin.html', v_actor, v_actor_name, NEW.slug);
    END LOOP;
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS cloud_posts_notify_trg ON public.cloud_posts;
CREATE TRIGGER cloud_posts_notify_trg
  AFTER UPDATE ON public.cloud_posts
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_post_status();

-- ---------------------------------------------------------------------
-- A8. 通知读取 RPC
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_notifications(
  p_limit  int     DEFAULT 20,
  p_offset int     DEFAULT 0,
  p_unread boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid    text := auth.uid()::text;
  v_limit  int  := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_offset int  := GREATEST(COALESCE(p_offset, 0), 0);
  v_total  int;
  v_unread int;
  v_shown  int;
  v_rows   jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('total', 0, 'unread', 0, 'shown', 0, 'rows', '[]'::jsonb);
  END IF;

  SELECT count(*), count(*) FILTER (WHERE read_at IS NULL)
    INTO v_total, v_unread
    FROM public.notifications WHERE recipient_id = v_uid;

  DROP TABLE IF EXISTS _mn;
  CREATE TEMP TABLE _mn ON COMMIT DROP AS
  SELECT id, kind, title, body, link, actor_name, post_slug, read_at, created_at
  FROM public.notifications
  WHERE recipient_id = v_uid
    AND (NOT COALESCE(p_unread, false) OR read_at IS NULL);

  SELECT count(*) INTO v_shown FROM _mn;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT * FROM _mn ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object(
    'total', v_total, 'unread', v_unread, 'shown', v_shown, 'rows', v_rows,
    'limit', v_limit, 'offset', v_offset);
END
$function$;

CREATE OR REPLACE FUNCTION public.notify_unread_count()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT CASE WHEN auth.uid() IS NULL THEN 0 ELSE (
    SELECT count(*)::integer FROM public.notifications
    WHERE recipient_id = auth.uid()::text AND read_at IS NULL
  ) END
$function$;

CREATE OR REPLACE FUNCTION public.notify_mark_read(p_id bigint DEFAULT NULL, p_all boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.notifications
     SET read_at = now()
   WHERE recipient_id = auth.uid()::text
     AND read_at IS NULL
     AND (COALESCE(p_all, false) OR id = p_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;

CREATE OR REPLACE FUNCTION public.notify_clear(p_id bigint DEFAULT NULL, p_all boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM public.notifications
   WHERE recipient_id = auth.uid()::text
     AND (COALESCE(p_all, false) OR id = p_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.my_notifications(int, int, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.notify_unread_count() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.notify_mark_read(bigint, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.notify_clear(bigint, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.my_notifications(int, int, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_unread_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_mark_read(bigint, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_clear(bigint, boolean) TO authenticated;

-- ---------------------------------------------------------------------
-- B1. 后台文章分页 + 搜索 + 状态筛选
--   p_status: NULL/'all' | 'pending' | 'draft' | 'published' | 'rejected'
--            | 'reviewed'（已处理过：驳回 或 通过且留下审核时间）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_posts_page(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit  int  DEFAULT 20,
  p_offset int  DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit  int  := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset int  := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_status text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_total  int;
  v_rows   jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  DROP TABLE IF EXISTS _ap;
  CREATE TEMP TABLE _ap ON COMMIT DROP AS
  SELECT p.id, p.slug, p.title, p.summary, p.status, p.author_id,
         COALESCE(NULLIF(pr.nickname, ''), NULLIF(u.name, ''),
                  split_part(COALESCE(u.email::text, ''), '@', 1)) AS author_name,
         u.email::text AS author_email,
         (p.author_id = auth.uid()::text) AS is_own,
         p.tags, p.created_at, p.updated_at, p.published_at, p.reviewed_at, p.review_note,
         length(COALESCE(p.content_md, ''))::integer AS body_length
  FROM public.cloud_posts p
  LEFT JOIN public.profiles pr ON pr.owner_id = p.author_id
  LEFT JOIN auth.users u ON u.id::text = p.author_id
  WHERE (
      v_search IS NULL
      OR p.title ILIKE '%' || v_search || '%'
      OR p.slug ILIKE '%' || v_search || '%'
      OR COALESCE(p.summary, '') ILIKE '%' || v_search || '%'
      OR COALESCE(pr.nickname, '') ILIKE '%' || v_search || '%'
      OR COALESCE(u.email::text, '') ILIKE '%' || v_search || '%'
    )
    AND (
      v_status IS NULL
      OR (v_status = 'reviewed'
          AND (p.status = 'rejected' OR (p.status = 'published' AND p.reviewed_at IS NOT NULL)))
      OR (v_status <> 'reviewed' AND p.status = v_status)
    );

  SELECT count(*) INTO v_total FROM _ap;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.sort_pending DESC, t.updated_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT *, (status = 'pending') AS sort_pending
      FROM _ap
      ORDER BY (status = 'pending') DESC, updated_at DESC
      LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

-- ---------------------------------------------------------------------
-- B2. 后台评论分页 + 搜索 + 状态筛选（p_status: all|visible|hidden）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_comments_page(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit  int  DEFAULT 30,
  p_offset int  DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit  int  := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset int  := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_status text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_total  int;
  v_rows   jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  DROP TABLE IF EXISTS _ac;
  CREATE TEMP TABLE _ac ON COMMIT DROP AS
  SELECT c.id, c.parent_id, c.post_slug, c.author_name, c.content, c.status, c.created_at,
         (SELECT pc.author_name FROM public.comments pc WHERE pc.id = c.parent_id) AS parent_author
  FROM public.comments c
  WHERE (
      v_search IS NULL
      OR COALESCE(c.author_name, '') ILIKE '%' || v_search || '%'
      OR c.content ILIKE '%' || v_search || '%'
      OR c.post_slug ILIKE '%' || v_search || '%'
    )
    AND (
      v_status IS NULL
      OR (v_status = 'hidden' AND c.status <> 'visible')
      OR (v_status = 'visible' AND c.status = 'visible')
      OR (v_status NOT IN ('hidden', 'visible') AND c.status = v_status)
    );

  SELECT count(*) INTO v_total FROM _ac;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT * FROM _ac ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

-- ---------------------------------------------------------------------
-- B3. 后台用户分页 + 搜索（p_status: all|active|disabled|admin）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_users_page(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit  int  DEFAULT 30,
  p_offset int  DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit  int  := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset int  := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_status text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_total  int;
  v_rows   jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  DROP TABLE IF EXISTS _au;
  CREATE TEMP TABLE _au ON COMMIT DROP AS
  SELECT u.id::text AS owner_id,
         u.email::text AS email,
         p.nickname, p.avatar_url, p.bio,
         COALESCE(p.status, 'active') AS status,
         EXISTS (SELECT 1 FROM public.admin_emails a WHERE lower(a.email) = lower(u.email::text)) AS is_admin,
         (u.id::text = auth.uid()::text) AS is_self,
         COALESCE(p.created_at, u.created_at) AS created_at,
         u.last_login,
         (SELECT count(*) FROM public.comments c WHERE c.owner_id = u.id::text) AS comment_count,
         (SELECT count(*) FROM public.post_likes l WHERE l.owner_id = u.id::text) AS like_count
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.owner_id = u.id::text
  WHERE u.email IS NOT NULL
    AND u.project = COALESCE(
      (SELECT uu.project FROM auth.users uu WHERE uu.id::text = auth.uid()::text LIMIT 1),
      u.project)
    AND (
      v_search IS NULL
      OR u.email::text ILIKE '%' || v_search || '%'
      OR COALESCE(p.nickname, '') ILIKE '%' || v_search || '%'
      OR u.id::text ILIKE '%' || v_search || '%'
    )
    AND (
      v_status IS NULL
      OR (v_status = 'disabled' AND COALESCE(p.status, 'active') = 'disabled')
      OR (v_status = 'active' AND COALESCE(p.status, 'active') <> 'disabled')
      OR (v_status = 'admin'
          AND EXISTS (SELECT 1 FROM public.admin_emails a WHERE lower(a.email) = lower(u.email::text)))
    );

  SELECT count(*) INTO v_total FROM _au;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT * FROM _au ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_posts_page(text, text, int, int) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_comments_page(text, text, int, int) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_users_page(text, text, int, int) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_posts_page(text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_comments_page(text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_users_page(text, text, int, int) TO authenticated;

-- ---------------------------------------------------------------------
-- C. 补上 admin_audit_log 漏开的 RLS（此前策略未生效）
-- ---------------------------------------------------------------------
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_admin_read ON public.admin_audit_log;
CREATE POLICY audit_admin_read ON public.admin_audit_log FOR SELECT
  TO authenticated USING (public.is_admin());
