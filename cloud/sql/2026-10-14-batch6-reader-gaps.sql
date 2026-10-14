-- =====================================================================
-- 第六批：注册读者缺口 M2–M16 的云端支撑
-- 日期：2026-10-14
--
-- 覆盖：
--   M2  评论限时编辑（edited_at + 15 分钟窗口，服务端强制）
--   M3  评论顶 / 踩（comment_votes + comment_vote RPC）
--   M4  @提及 → 给被提及者推站内通知
--   M5  登录邮箱变更申请（profiles.pending_email* + 管理员处理 RPC）
--   M6  登录设备管理（user_sessions + session_touch / session_kill_others）
--   M7  数据导出（export_my_data）与账号注销（delete_my_account）
--   M9  邮箱归属验证标记（profiles.email_verified_at + mark_email_verified）
--   M10 收藏分组 / 私密（post_bookmarks.folder / is_private）
--   M11 阅读历史 / 继续阅读（reading_history）
--   M13 评论举报（comment_reports）与拉黑（user_blocks）
--
-- 约定（沿用前五批）：
--   · 新表一律 ENABLE ROW LEVEL SECURITY + 显式 GRANT（漏 GRANT 会得到
--     形似策略失效的 42501）；写操作能走 RPC 的就不给表级权限。
--   · SECURITY DEFINER 函数必须 SET search_path 且 REVOKE EXECUTE FROM PUBLIC。
--   · plpgsql 里临时表要先 DROP TABLE IF EXISTS，否则同事务内二次调用报 42P07。
--   · CREATE OR REPLACE VIEW 只能在末尾追加列，改列集合必须 DROP 重建。
--
-- 执行：单条语句逐条执行（REST/MCP 通道一次只接受一条语句）。
-- =====================================================================


-- ---------------------------------------------------------------------
-- S1. comments 增加 edited_at（M2）
-- ---------------------------------------------------------------------
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS edited_at timestamptz;


-- ---------------------------------------------------------------------
-- S2. profiles 增加邮箱验证 / 邮箱变更申请字段（M5 / M9）
--     email_verified_at  邮箱归属已验证的时间（由 mark_email_verified 写入）
--     pending_email      用户申请变更到的新邮箱（尚未生效）
--     pending_email_at   申请时间
--     pending_email_note 用户填写的补充说明
-- ---------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_verified_at   timestamptz,
  ADD COLUMN IF NOT EXISTS pending_email       text,
  ADD COLUMN IF NOT EXISTS pending_email_at    timestamptz,
  ADD COLUMN IF NOT EXISTS pending_email_note  text;


-- ---------------------------------------------------------------------
-- S3. profiles_guard：把服务端托管字段一并冻住（M5 / M9）
--     否则用户可以直接 UPDATE profiles 把自己标成「已验证」，
--     或者绕过 apply 流程自己改 pending_email 的状态语义。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT public.is_admin() THEN
      NEW.can_publish := false;
      -- 新注册的用户一律未验证、无待处理申请
      NEW.email_verified_at  := NULL;
      NEW.pending_email      := NULL;
      NEW.pending_email_at   := NULL;
      NEW.pending_email_note := NULL;
    END IF;
  ELSE
    IF NEW.can_publish IS DISTINCT FROM OLD.can_publish AND NOT public.is_admin() THEN
      NEW.can_publish := OLD.can_publish;
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      NEW.created_at := OLD.created_at;
    END IF;
    -- status 只允许管理员改（注销走 delete_my_account，它自己是 SECURITY DEFINER）
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT public.is_admin() THEN
      NEW.status := OLD.status;
    END IF;
    -- 邮箱验证状态与待处理申请：普通用户不得直接改
    IF NOT public.is_admin() THEN
      IF NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at THEN
        NEW.email_verified_at := OLD.email_verified_at;
      END IF;
      IF NEW.pending_email IS DISTINCT FROM OLD.pending_email THEN
        NEW.pending_email := OLD.pending_email;
      END IF;
      IF NEW.pending_email_at IS DISTINCT FROM OLD.pending_email_at THEN
        NEW.pending_email_at := OLD.pending_email_at;
      END IF;
      IF NEW.pending_email_note IS DISTINCT FROM OLD.pending_email_note THEN
        NEW.pending_email_note := OLD.pending_email_note;
      END IF;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$function$;


-- ---------------------------------------------------------------------
-- S4. is_active：注销后的账号（status='deleted'）与禁用一样不能再写
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_active(p_uid text DEFAULT NULL::text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE owner_id = COALESCE(NULLIF(p_uid, ''), auth.uid()::text)
      AND status IN ('disabled', 'deleted')
  )
$function$;


-- ---------------------------------------------------------------------
-- S5. my_account：补 email_verified_at / pending_email（M5 / M9 / M15）
--     M15（完善资料引导）用 nickname 是否为空判断，已经在返回值里。
-- ---------------------------------------------------------------------
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
      'nickname', (SELECT p.nickname FROM public.profiles p WHERE p.owner_id = auth.uid()::text),
      'can_publish', COALESCE((SELECT p.can_publish FROM public.profiles p WHERE p.owner_id = auth.uid()::text), false),
      'email_verified_at', (SELECT p.email_verified_at FROM public.profiles p WHERE p.owner_id = auth.uid()::text),
      'pending_email', (SELECT p.pending_email FROM public.profiles p WHERE p.owner_id = auth.uid()::text),
      'pending_email_at', (SELECT p.pending_email_at FROM public.profiles p WHERE p.owner_id = auth.uid()::text)
    )
  END
$function$;


-- ---------------------------------------------------------------------
-- S6. post_bookmarks 增加分组与私密（M10）
-- ---------------------------------------------------------------------
ALTER TABLE public.post_bookmarks
  ADD COLUMN IF NOT EXISTS folder     text,
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------
-- S7. post_stats_public：私密收藏不计入公开的收藏数（M10）
--     视图列集合不变，CREATE OR REPLACE 合法。
-- ---------------------------------------------------------------------
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
  LEFT JOIN (SELECT post_slug, count(*) AS bookmarks FROM post_bookmarks WHERE is_private IS NOT TRUE GROUP BY 1) b
         ON b.post_slug = s.post_slug
  LEFT JOIN (SELECT post_slug, count(*) AS comments  FROM comments WHERE status = 'visible' GROUP BY 1) c
         ON c.post_slug = s.post_slug;

GRANT SELECT ON public.post_stats_public TO anon, authenticated;


-- ---------------------------------------------------------------------
-- S8. comment_votes：评论顶 / 踩（M3）
--     · 一人一条评论只有一票（UNIQUE），-1 = 踩，1 = 顶
--     · 表级只给「自己的行」读写；聚合数字由 post_comments（SECURITY DEFINER）出
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comment_votes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comment_id bigint NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  owner_id   text   NOT NULL DEFAULT auth.uid(),
  value      smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comment_votes_key  UNIQUE (comment_id, owner_id),
  CONSTRAINT comment_votes_value_chk CHECK (value IN (-1, 1))
);

CREATE INDEX IF NOT EXISTS comment_votes_comment_idx ON public.comment_votes (comment_id);

ALTER TABLE public.comment_votes ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.comment_votes TO anon, authenticated;
GRANT ALL ON public.comment_votes TO service_role;

DROP POLICY IF EXISTS comment_votes_own_all ON public.comment_votes;
CREATE POLICY comment_votes_own_all ON public.comment_votes FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid() AND public.is_active());

DROP POLICY IF EXISTS comment_votes_admin_all ON public.comment_votes;
CREATE POLICY comment_votes_admin_all ON public.comment_votes FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ---------------------------------------------------------------------
-- S9. comment_reports：评论举报（M13）
--     举报人只能看到自己提交的；管理员看全部并处理。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comment_reports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comment_id  bigint NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  post_slug   text   NOT NULL,
  reporter_id text   NOT NULL DEFAULT auth.uid(),
  reason      text   NOT NULL DEFAULT 'other',
  note        text,
  status      text   NOT NULL DEFAULT 'open',
  handled_by  text,
  handled_at  timestamptz,
  handle_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comment_reports_key UNIQUE (comment_id, reporter_id),
  CONSTRAINT comment_reports_reason_chk CHECK (reason IN ('spam', 'abuse', 'ad', 'illegal', 'offtopic', 'other')),
  CONSTRAINT comment_reports_status_chk CHECK (status IN ('open', 'resolved', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS comment_reports_status_idx ON public.comment_reports (status, created_at DESC);

ALTER TABLE public.comment_reports ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.comment_reports TO anon, authenticated;
GRANT ALL ON public.comment_reports TO service_role;

DROP POLICY IF EXISTS comment_reports_own_read ON public.comment_reports;
CREATE POLICY comment_reports_own_read ON public.comment_reports FOR SELECT
  USING (reporter_id = auth.uid());

DROP POLICY IF EXISTS comment_reports_own_insert ON public.comment_reports;
CREATE POLICY comment_reports_own_insert ON public.comment_reports FOR INSERT
  WITH CHECK (reporter_id = auth.uid() AND public.is_active());

DROP POLICY IF EXISTS comment_reports_admin_all ON public.comment_reports;
CREATE POLICY comment_reports_admin_all ON public.comment_reports FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ---------------------------------------------------------------------
-- S10. user_blocks：拉黑（M13）
--      只在客户端生效（被拉黑者的评论在你这里隐藏），不是全站封禁。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_blocks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id     text   NOT NULL DEFAULT auth.uid(),
  blocked_id   text   NOT NULL,
  blocked_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_blocks_key        UNIQUE (owner_id, blocked_id),
  CONSTRAINT user_blocks_not_self   CHECK (blocked_id <> owner_id)
);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_blocks TO anon, authenticated;
GRANT ALL ON public.user_blocks TO service_role;

DROP POLICY IF EXISTS user_blocks_own_all ON public.user_blocks;
CREATE POLICY user_blocks_own_all ON public.user_blocks FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid() AND public.is_active());

DROP POLICY IF EXISTS user_blocks_admin_read ON public.user_blocks;
CREATE POLICY user_blocks_admin_read ON public.user_blocks FOR SELECT
  USING (public.is_admin());


-- ---------------------------------------------------------------------
-- S11. reading_history：阅读进度 / 继续阅读（M11）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reading_history (
  owner_id   text NOT NULL DEFAULT auth.uid(),
  post_slug  text NOT NULL,
  title      text,
  percent    smallint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, post_slug),
  CONSTRAINT reading_history_percent_chk CHECK (percent BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS reading_history_recent_idx ON public.reading_history (owner_id, updated_at DESC);

ALTER TABLE public.reading_history ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reading_history TO anon, authenticated;
GRANT ALL ON public.reading_history TO service_role;

DROP POLICY IF EXISTS reading_history_own_all ON public.reading_history;
CREATE POLICY reading_history_own_all ON public.reading_history FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid() AND public.is_active());


-- ---------------------------------------------------------------------
-- S12. user_sessions：登录设备（M6）
--      只存「本站在这台设备上的登录记录」，不是云平台的真实会话表 ——
--      所以「退出其他设备」是协作式的软踢出：对方下次访问站点时被登出。
--      session_key 由浏览器生成并存 localStorage，服务端只认这个随机串。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_sessions (
  session_key  text PRIMARY KEY,
  owner_id     text NOT NULL DEFAULT auth.uid(),
  label        text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS user_sessions_owner_idx ON public.user_sessions (owner_id, last_seen_at DESC);

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- 表级一律不给客户端：读、写都只能走 S15/S16 两个 RPC
REVOKE ALL ON public.user_sessions FROM anon, authenticated;
GRANT ALL ON public.user_sessions TO service_role;

-- 管理员可看（用于排查），但看不到 session_key 之外的敏感信息 —— 本来也没有
DROP POLICY IF EXISTS user_sessions_admin_read ON public.user_sessions;
CREATE POLICY user_sessions_admin_read ON public.user_sessions FOR SELECT
  USING (public.is_admin());


-- ---------------------------------------------------------------------
-- S13. comments_stamp_author：加入 15 分钟编辑窗口（M2）与 @提及（M4）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.comments_stamp_author()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_nickname   text;
  v_parent     public.comments;
  v_word       text;
  v_recent_1m  int;
  v_recent_10m int;
  v_admin      boolean := public.is_admin();
  v_edited     boolean := false;
  v_link       text;
  v_mention    text;
  v_uid        text;
  v_takes      int := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.owner_id := auth.uid()::text;
  END IF;
  IF NEW.owner_id IS NULL OR NEW.owner_id = '' THEN
    RAISE EXCEPTION '评论必须由登录用户提交' USING ERRCODE = '42501';
  END IF;

  -- ---- 内容归一（先做，后面窗口判定与敏感词都依赖它）----
  NEW.content := btrim(coalesce(NEW.content, ''));
  IF char_length(NEW.content) = 0 THEN
    RAISE EXCEPTION '评论内容不能为空' USING ERRCODE = '23514';
  END IF;
  NEW.content := left(NEW.content, 1000);

  IF TG_OP = 'UPDATE' THEN
    v_edited := NEW.content IS DISTINCT FROM OLD.content;
  END IF;

  -- ---- 非管理员：身份字段不可改，状态不可自批 ----
  IF TG_OP = 'UPDATE' AND NOT v_admin THEN
    NEW.owner_id   := OLD.owner_id;
    NEW.post_slug  := OLD.post_slug;
    NEW.parent_id  := OLD.parent_id;
    -- 关键修复（第四批）：此前 comments_own_all 策略允许用户改自己行的 status，
    -- 等于可以自己把待审评论改成 visible。这里一律沿用旧状态。
    NEW.status     := OLD.status;
  END IF;

  -- ---- M2：限时编辑（15 分钟，服务端强制）----
  IF TG_OP = 'UPDATE' AND v_edited AND NOT v_admin THEN
    IF OLD.created_at < now() - interval '15 minutes' THEN
      RAISE EXCEPTION '评论发表超过 15 分钟后不能再修改，可以删除后重新发表。'
        USING ERRCODE = 'P0001', HINT = 'EDIT_WINDOW_CLOSED';
    END IF;
    NEW.edited_at := now();
    -- 改过内容就重新排队，避免「先过审、再偷换内容」
    IF OLD.status <> 'pending' THEN
      NEW.status := 'pending';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.edited_at := OLD.edited_at;
  END IF;

  -- ---- 频率限制（仅新增；管理员豁免）----
  IF TG_OP = 'INSERT' AND NOT v_admin THEN
    SELECT count(*) INTO v_recent_1m
      FROM public.comments
     WHERE owner_id = NEW.owner_id AND created_at >= now() - interval '60 seconds';
    IF v_recent_1m >= 5 THEN
      RAISE EXCEPTION '发言太快了，请等一分钟后再试。'
        USING ERRCODE = 'P0001', HINT = 'RATE_LIMIT_1M';
    END IF;

    SELECT count(*) INTO v_recent_10m
      FROM public.comments
     WHERE owner_id = NEW.owner_id AND created_at >= now() - interval '10 minutes';
    IF v_recent_10m >= 20 THEN
      RAISE EXCEPTION '最近十分钟的评论太多了，请稍后再来。'
        USING ERRCODE = 'P0001', HINT = 'RATE_LIMIT_10M';
    END IF;
  END IF;

  -- ---- 昵称固化：不信客户端传的 author_name ----
  SELECT NULLIF(btrim(coalesce(nickname, '')), '') INTO v_nickname
    FROM public.profiles WHERE owner_id = NEW.owner_id;

  IF v_nickname IS NOT NULL THEN
    NEW.author_name := left(v_nickname, 60);
  ELSIF TG_OP = 'UPDATE' AND NULLIF(btrim(coalesce(OLD.author_name, '')), '') IS NOT NULL THEN
    NEW.author_name := left(OLD.author_name, 60);
  ELSE
    NEW.author_name := '读者';
  END IF;

  -- ---- 敏感词：命中即标记 flag_reason（取最长命中词）----
  SELECT w.word INTO v_word
    FROM public.comment_banned_words w
   WHERE position(lower(w.word) IN lower(NEW.content)) > 0
   ORDER BY char_length(w.word) DESC
   LIMIT 1;
  NEW.flag_reason := CASE WHEN v_word IS NULL THEN NULL ELSE '命中敏感词：' || left(v_word, 40) END;

  -- ---- 状态定稿 ----
  IF TG_OP = 'INSERT' THEN
    IF v_admin THEN
      NEW.status := CASE
        WHEN NEW.status IS NULL OR NEW.status NOT IN ('visible', 'hidden', 'pending') THEN 'visible'
        ELSE NEW.status
      END;
    ELSE
      NEW.status := 'pending';
    END IF;
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;

  -- ---- 父评论校验（只允许回复顶层评论）----
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.comments WHERE id = NEW.parent_id;
    IF NOT FOUND
       OR v_parent.post_slug IS DISTINCT FROM NEW.post_slug
       OR v_parent.parent_id IS NOT NULL
       OR v_parent.id = NEW.id THEN
      NEW.parent_id := NULL;
    END IF;
  END IF;

  -- ---- M4：@提及 → 通知被提及者（最多 5 人，仅新增时）----
  IF TG_OP = 'INSERT' THEN
    v_link := CASE
      WHEN NEW.post_slug LIKE 'cloud:%' THEN 'post.html?slug=' || substr(NEW.post_slug, 7)
      ELSE 'posts/' || NEW.post_slug || '.html'
    END;

    FOR v_mention IN
      SELECT DISTINCT m[1]
        FROM regexp_matches(NEW.content, '@([^[:space:]@,.;:!?()<>\[\]/|]{1,40})', 'g') AS m
       LIMIT 5
    LOOP
      SELECT p.owner_id INTO v_uid
        FROM public.profiles p
       WHERE p.nickname = v_mention
         AND p.status = 'active'
       LIMIT 1;

      IF v_uid IS NOT NULL AND v_uid <> NEW.owner_id THEN
        PERFORM public.notify_push(
          v_uid,
          'mention',
          COALESCE(NEW.author_name, '有人') || ' 在评论里提到了你',
          left(NEW.content, 200),
          v_link,
          NEW.owner_id,
          NEW.author_name,
          NEW.post_slug
        );
        v_takes := v_takes + 1;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END
$function$;


-- ---------------------------------------------------------------------
-- S14. post_comments：补 author_id / edited_at / 顶踩数字（M2 / M3 / M13）
--      返回列集合变了，必须先 DROP 再建。
--      author_id 是 UUID，本来就已经公开（作者主页 authors/<owner_id>.html），
--      客户端要靠它做「拉黑后隐藏此人评论」。
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.post_comments(text);

CREATE OR REPLACE FUNCTION public.post_comments(p_slug text)
RETURNS TABLE(
  id bigint, parent_id bigint, author_name text, author_id text, content text,
  created_at timestamptz, edited_at timestamptz, is_mine boolean, status text,
  up_count int, down_count int, my_vote smallint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT c.id,
         c.parent_id,
         c.author_name,
         c.owner_id AS author_id,
         c.content,
         c.created_at,
         c.edited_at,
         (c.owner_id = auth.uid()) AS is_mine,
         c.status,
         COALESCE(v.up_count, 0)::int       AS up_count,
         COALESCE(v.down_count, 0)::int     AS down_count,
         COALESCE(v.my_vote, 0)::smallint   AS my_vote
    FROM public.comments c
    LEFT JOIN (
      SELECT cv.comment_id,
             count(*) FILTER (WHERE cv.value = 1)  AS up_count,
             count(*) FILTER (WHERE cv.value = -1) AS down_count,
             max(CASE WHEN cv.owner_id = auth.uid() THEN cv.value END) AS my_vote
        FROM public.comment_votes cv
       GROUP BY cv.comment_id
    ) v ON v.comment_id = c.id
   WHERE c.post_slug = p_slug
     -- 别人的待审/隐藏评论不返回；自己的照常返回带着 status
     AND (c.status = 'visible' OR c.owner_id = auth.uid())
   ORDER BY c.created_at DESC
   LIMIT 300
$function$;

REVOKE EXECUTE ON FUNCTION public.post_comments(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_comments(text) TO anon, authenticated;


-- ---------------------------------------------------------------------
-- S15. comment_vote：顶 / 踩 / 取消（M3）
--      p_value = 1 顶、-1 踩、0 取消。同一值再点一次 = 取消（幂等切换）。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.comment_vote(p_comment_id bigint, p_value smallint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid    text := auth.uid()::text;
  v_value  smallint := CASE WHEN p_value IS NULL THEN 0
                            WHEN p_value > 0 THEN 1
                            WHEN p_value < 0 THEN -1
                            ELSE 0 END;
  v_old    smallint;
  v_up     int;
  v_down   int;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  IF NOT public.is_active() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_disabled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.comments c WHERE c.id = p_comment_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT cv.value INTO v_old
    FROM public.comment_votes cv
   WHERE cv.comment_id = p_comment_id AND cv.owner_id = v_uid;

  IF v_value = 0 OR v_old = v_value THEN
    DELETE FROM public.comment_votes
     WHERE comment_id = p_comment_id AND owner_id = v_uid;
    v_value := 0;
  ELSIF v_old IS NULL THEN
    INSERT INTO public.comment_votes (comment_id, owner_id, value)
    VALUES (p_comment_id, v_uid, v_value);
  ELSE
    UPDATE public.comment_votes
       SET value = v_value, updated_at = now()
     WHERE comment_id = p_comment_id AND owner_id = v_uid;
  END IF;

  SELECT count(*) FILTER (WHERE cv.value = 1),
         count(*) FILTER (WHERE cv.value = -1)
    INTO v_up, v_down
    FROM public.comment_votes cv
   WHERE cv.comment_id = p_comment_id;

  RETURN jsonb_build_object('ok', true, 'up', COALESCE(v_up, 0),
                            'down', COALESCE(v_down, 0), 'my_vote', v_value);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.comment_vote(bigint, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comment_vote(bigint, smallint) TO authenticated;


-- ---------------------------------------------------------------------
-- S16. request_email_change：提交登录邮箱变更申请（M5）
--      云平台只开放「邮箱+密码」登录、SDK 没有改邮箱接口 —— 登录邮箱
--      只能在云控制台改。所以这里做成「站内申请 → 管理员处理」的闭环：
--      用户用当前密码自证身份后提交，管理员收到通知并在后台处理。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_email_change(p_new_email text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid   text := auth.uid()::text;
  v_email text := lower(btrim(COALESCE(p_new_email, '')));
  v_note  text := NULLIF(left(btrim(COALESCE(p_note, '')), 200), '');
  v_name  text;
  v_admin text;
  v_taken int;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  IF NOT public.is_active() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_disabled');
  END IF;
  IF v_email = '' OR char_length(v_email) > 254
     OR v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_email');
  END IF;
  IF v_email = lower(COALESCE(auth.email(), '')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'same_email');
  END IF;

  -- 已被其他账号占用就直接说，避免管理员改完才发现冲突
  SELECT count(*) INTO v_taken
    FROM auth.users u
   WHERE lower(u.email::text) = v_email
     AND u.id::text <> v_uid;
  IF v_taken > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'email_taken');
  END IF;

  UPDATE public.profiles
     SET pending_email      = v_email,
         pending_email_at   = now(),
         pending_email_note = v_note
   WHERE owner_id = v_uid;

  IF NOT FOUND THEN
    INSERT INTO public.profiles (owner_id, pending_email, pending_email_at, pending_email_note)
    VALUES (v_uid, v_email, now(), v_note);
  END IF;

  SELECT COALESCE(p.nickname, split_part(COALESCE(auth.email(), ''), '@', 1), '读者')
    INTO v_name
    FROM public.profiles p
   WHERE p.owner_id = v_uid;

  FOR v_admin IN SELECT unnest(public.admin_recipient_ids(v_uid))
  LOOP
    PERFORM public.notify_push(
      v_admin,
      'email_request',
      '有用户申请更换登录邮箱',
      COALESCE(v_name, '读者') || '（' || COALESCE(auth.email(), '') || '）申请改为 ' || v_email
        || CASE WHEN v_note IS NULL THEN '' ELSE '；说明：' || v_note END,
      'admin.html',
      v_uid,
      v_name,
      NULL
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'pending_email', v_email);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.request_email_change(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_email_change(text, text) TO authenticated;


-- ---------------------------------------------------------------------
-- S17. admin_resolve_email_change：管理员处理邮箱变更申请（M5）
--      approve：清掉待处理字段 + 标记已验证（管理员在控制台改完后点）
--      reject ：清掉待处理字段并回一条通知
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_resolve_email_change(
  p_owner text, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_note   text := NULLIF(left(btrim(COALESCE(p_note, '')), 200), '');
  v_target text := btrim(COALESCE(p_owner, ''));
  v_new    text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_action NOT IN ('approve', 'reject') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_action');
  END IF;

  SELECT p.pending_email INTO v_new
    FROM public.profiles p WHERE p.owner_id = v_target;

  IF v_new IS NULL OR v_new = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_request');
  END IF;

  UPDATE public.profiles
     SET pending_email      = NULL,
         pending_email_at   = NULL,
         pending_email_note = NULL,
         email_verified_at  = CASE WHEN v_action = 'approve' THEN now() ELSE email_verified_at END
   WHERE owner_id = v_target;

  PERFORM public.notify_push(
    v_target,
    CASE WHEN v_action = 'approve' THEN 'email_changed' ELSE 'email_change_rejected' END,
    CASE WHEN v_action = 'approve' THEN '登录邮箱已更新' ELSE '邮箱变更申请未通过' END,
    CASE WHEN v_action = 'approve'
      THEN '站长已把你的登录邮箱改为 ' || v_new || '。下次登录请使用新邮箱。'
      ELSE '站长未通过你的邮箱变更申请（申请改为 ' || v_new || '）。'
           || COALESCE(' 原因：' || v_note, '')
    END,
    'account.html',
    NULL,
    NULL,
    NULL
  );

  PERFORM public.audit_log(
    CASE WHEN v_action = 'approve' THEN 'email_change_approve' ELSE 'email_change_reject' END,
    'profile', v_target, COALESCE(v_note, v_new), jsonb_build_object('pending_email', v_new));

  RETURN jsonb_build_object('ok', true, 'action', v_action);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_resolve_email_change(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_email_change(text, text, text) TO authenticated;


-- ---------------------------------------------------------------------
-- S18. mark_email_verified：邮箱归属已验证（M9）
--      前端用云平台的邮箱验证码（sendOtp / verifyOtp）确认用户确实能收到
--      这个邮箱的邮件，验证通过后调这里打标记。
--      ⚠️ 这一步是「客户端自证」：服务端没有独立的邮箱验证接口，
--         所以标记只用于界面提示，不作为任何权限依据。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_email_verified()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  UPDATE public.profiles
     SET email_verified_at = now()
   WHERE owner_id = v_uid;

  IF NOT FOUND THEN
    INSERT INTO public.profiles (owner_id, email_verified_at)
    VALUES (v_uid, now());
  END IF;

  RETURN jsonb_build_object('ok', true, 'email_verified_at', now());
END
$function$;

REVOKE EXECUTE ON FUNCTION public.mark_email_verified() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_email_verified() TO authenticated;


-- ---------------------------------------------------------------------
-- S19. session_touch：登记 / 刷新本机登录记录（M6）
--      返回 { ok, revoked, sessions[] }。revoked = true 时前端立即登出，
--      这就是「在别处点了退出其他设备」之后的效果（软踢出）。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.session_touch(
  p_key text, p_label text DEFAULT NULL, p_ua text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid     text := auth.uid()::text;
  v_key     text := btrim(COALESCE(p_key, ''));
  v_label   text := NULLIF(left(btrim(COALESCE(p_label, '')), 60), '');
  v_ua      text := NULLIF(left(btrim(COALESCE(p_ua, '')), 200), '');
  v_revoked timestamptz;
  v_rows    jsonb;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  IF v_key = '' OR char_length(v_key) < 8 OR char_length(v_key) > 80 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_key');
  END IF;

  INSERT INTO public.user_sessions (session_key, owner_id, label, user_agent)
  VALUES (v_key, v_uid, v_label, v_ua)
  ON CONFLICT (session_key) DO UPDATE
     SET owner_id     = EXCLUDED.owner_id,
         label        = COALESCE(EXCLUDED.label, public.user_sessions.label),
         user_agent   = COALESCE(EXCLUDED.user_agent, public.user_sessions.user_agent),
         last_seen_at = now(),
         -- 换了账号（同一浏览器换人登录）就当作一台新设备，重置撤销状态
         revoked_at   = CASE WHEN public.user_sessions.owner_id IS DISTINCT FROM EXCLUDED.owner_id
                             THEN NULL ELSE public.user_sessions.revoked_at END,
         created_at   = CASE WHEN public.user_sessions.owner_id IS DISTINCT FROM EXCLUDED.owner_id
                             THEN now() ELSE public.user_sessions.created_at END
  RETURNING revoked_at INTO v_revoked;

  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT session_key, label, user_agent, created_at, last_seen_at,
             (session_key = v_key) AS is_current
        FROM public.user_sessions
       WHERE owner_id = v_uid
         AND revoked_at IS NULL
       ORDER BY last_seen_at DESC
       LIMIT 20
    ) t;

  RETURN jsonb_build_object('ok', true, 'revoked', v_revoked IS NOT NULL,
                            'current', v_key, 'sessions', v_rows);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.session_touch(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_touch(text, text, text) TO authenticated;


-- ---------------------------------------------------------------------
-- S20. session_kill_others：退出其他设备（M6）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.session_kill_others(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid   text := auth.uid()::text;
  v_key   text := btrim(COALESCE(p_key, ''));
  v_count int;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  UPDATE public.user_sessions
     SET revoked_at = now()
   WHERE owner_id = v_uid
     AND revoked_at IS NULL
     AND session_key <> v_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'killed', v_count);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.session_kill_others(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_kill_others(text) TO authenticated;


-- ---------------------------------------------------------------------
-- S21. export_my_data：导出我自己的全部数据（M7）
--      只出「我」的数据，聚合在一个 JSON 里由浏览器下载。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.export_my_data()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid   text := auth.uid()::text;
  v_email text := COALESCE(auth.email(), '');
  v_out   jsonb;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  SELECT jsonb_build_object(
    'exported_at', now(),
    'format', 'ws-blog-reader-export@1',
    'account', jsonb_build_object(
      'uid', v_uid,
      'email', v_email,
      'profile', COALESCE((SELECT to_jsonb(p) - 'owner_id' FROM public.profiles p WHERE p.owner_id = v_uid), 'null'::jsonb)
    ),
    'posts', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) - 'author_id' ORDER BY t.created_at)
        FROM (SELECT slug, title, summary, content_md, tags, status, created_at, updated_at, published_at
                FROM public.cloud_posts WHERE author_id = v_uid) t), '[]'::jsonb),
    'comments', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
        FROM (SELECT id, post_slug, parent_id, content, status, created_at, edited_at
                FROM public.comments WHERE owner_id = v_uid) t), '[]'::jsonb),
    'likes', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
        FROM (SELECT post_slug, created_at FROM public.post_likes WHERE owner_id = v_uid) t), '[]'::jsonb),
    'bookmarks', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
        FROM (SELECT post_slug, title, folder, is_private, created_at
                FROM public.post_bookmarks WHERE owner_id = v_uid) t), '[]'::jsonb),
    'comment_votes', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
        FROM (SELECT comment_id, value, created_at FROM public.comment_votes WHERE owner_id = v_uid) t), '[]'::jsonb),
    'reading_history', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.updated_at)
        FROM (SELECT post_slug, title, percent, updated_at FROM public.reading_history WHERE owner_id = v_uid) t), '[]'::jsonb),
    'blocks', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
        FROM (SELECT blocked_id, blocked_name, created_at FROM public.user_blocks WHERE owner_id = v_uid) t), '[]'::jsonb),
    'reports', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
        FROM (SELECT comment_id, post_slug, reason, note, status, created_at
                FROM public.comment_reports WHERE reporter_id = v_uid) t), '[]'::jsonb),
    'notifications', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
        FROM (SELECT kind, title, body, link, read_at, created_at
                FROM public.notifications WHERE recipient_id = v_uid) t), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.export_my_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_my_data() TO authenticated;


-- ---------------------------------------------------------------------
-- S22. delete_my_account：注销账号（M7）
--      · 内容侧真删：投稿、评论、点赞、收藏、投票、阅读历史、拉黑、举报、通知
--      · profiles 保留一行但清空个人资料、置 status='deleted'（is_active() 变 false）
--      · 云平台上的登录账号本函数删不掉（S3：平台不开放删除用户），
--        所以返回里明确告诉前端「登录账号本身仍需站长在控制台移除」。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_my_account(p_confirm text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid     text := auth.uid()::text;
  v_email   text := COALESCE(auth.email(), '');
  v_want    text := upper(btrim(COALESCE(p_confirm, '')));
  c_posts   int := 0;
  c_cmts    int := 0;
  c_likes   int := 0;
  c_marks   int := 0;
  c_votes   int := 0;
  c_reads   int := 0;
  c_blocks  int := 0;
  c_reports int := 0;
  c_notify  int := 0;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  -- 二次确认的口令必须由用户手输，避免误触把账号清空
  IF v_want <> 'DELETE' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'confirm_required');
  END IF;

  DELETE FROM public.cloud_posts WHERE author_id = v_uid;
  GET DIAGNOSTICS c_posts = ROW_COUNT;

  DELETE FROM public.comments WHERE owner_id = v_uid;
  GET DIAGNOSTICS c_cmts = ROW_COUNT;

  -- 被删掉的评论如果还有子回复，把它们的 parent_id 摘掉，避免楼层指向空
  UPDATE public.comments c
     SET parent_id = NULL
   WHERE c.parent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.comments pc WHERE pc.id = c.parent_id);

  DELETE FROM public.post_likes WHERE owner_id = v_uid;
  GET DIAGNOSTICS c_likes = ROW_COUNT;

  DELETE FROM public.post_bookmarks WHERE owner_id = v_uid;
  GET DIAGNOSTICS c_marks = ROW_COUNT;

  DELETE FROM public.comment_votes WHERE owner_id = v_uid;
  GET DIAGNOSTICS c_votes = ROW_COUNT;

  DELETE FROM public.reading_history WHERE owner_id = v_uid;
  GET DIAGNOSTICS c_reads = ROW_COUNT;

  DELETE FROM public.user_blocks WHERE owner_id = v_uid;
  GET DIAGNOSTICS c_blocks = ROW_COUNT;

  DELETE FROM public.comment_reports WHERE reporter_id = v_uid;
  GET DIAGNOSTICS c_reports = ROW_COUNT;

  DELETE FROM public.user_sessions WHERE owner_id = v_uid;

  DELETE FROM public.notifications WHERE recipient_id = v_uid;
  GET DIAGNOSTICS c_notify = ROW_COUNT;

  -- 资料行保留（作为「已注销」墓碑），但抹掉个人信息
  INSERT INTO public.profiles (owner_id, nickname, avatar_url, bio, status,
                               pending_email, pending_email_at, pending_email_note)
  VALUES (v_uid, NULL, NULL, NULL, 'deleted', NULL, NULL, NULL)
  ON CONFLICT (owner_id) DO UPDATE
     SET nickname           = NULL,
         avatar_url         = NULL,
         bio                = NULL,
         status             = 'deleted',
         can_publish        = false,
         pending_email      = NULL,
         pending_email_at   = NULL,
         pending_email_note = NULL,
         updated_at         = now();

  PERFORM public.audit_log('account_delete', 'user', v_uid, v_email,
    jsonb_build_object('posts', c_posts, 'comments', c_cmts, 'likes', c_likes,
                       'bookmarks', c_marks, 'votes', c_votes, 'reads', c_reads,
                       'blocks', c_blocks, 'reports', c_reports, 'notifications', c_notify));

  RETURN jsonb_build_object(
    'ok', true,
    'removed', jsonb_build_object(
      'posts', c_posts, 'comments', c_cmts, 'likes', c_likes, 'bookmarks', c_marks,
      'votes', c_votes, 'reading_history', c_reads, 'blocks', c_blocks,
      'reports', c_reports, 'notifications', c_notify
    ),
    'login_account_remains', true
  );
END
$function$;

REVOKE EXECUTE ON FUNCTION public.delete_my_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_my_account(text) TO authenticated;


-- ---------------------------------------------------------------------
-- S23. admin_reports_page：后台举报列表（M13）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_reports_page(
  p_status text DEFAULT NULL, p_limit int DEFAULT 30, p_offset int DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit  int  := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset int  := GREATEST(COALESCE(p_offset, 0), 0);
  v_status text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_total  bigint;
  v_open   bigint;
  v_rows   jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  DROP TABLE IF EXISTS _rp;
  CREATE TEMP TABLE _rp ON COMMIT DROP AS
  SELECT r.id, r.comment_id, r.post_slug, r.reason, r.note, r.status,
         r.created_at, r.handled_at, r.handle_note,
         r.reporter_id,
         (SELECT COALESCE(NULLIF(btrim(p.nickname), ''), split_part(COALESCE(u.email::text, ''), '@', 1), '读者')
            FROM auth.users u LEFT JOIN public.profiles p ON p.owner_id = u.id::text
           WHERE u.id::text = r.reporter_id) AS reporter_name,
         c.author_name AS comment_author,
         c.content     AS comment_content,
         c.owner_id    AS comment_author_id,
         c.status      AS comment_status
    FROM public.comment_reports r
    LEFT JOIN public.comments c ON c.id = r.comment_id
   WHERE v_status IS NULL OR r.status = v_status;

  SELECT count(*) INTO v_total FROM _rp;
  SELECT count(*) INTO v_open FROM public.comment_reports WHERE status = 'open';

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (SELECT id, comment_id, post_slug, reason, note, status, created_at,
                 handled_at, handle_note, reporter_name, comment_author,
                 comment_content, comment_author_id, comment_status
            FROM _rp ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'open', v_open,
                            'rows', v_rows, 'limit', v_limit, 'offset', v_offset);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_reports_page(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reports_page(text, int, int) TO authenticated;


-- ---------------------------------------------------------------------
-- S24. admin_resolve_report：处理举报（M13）
--      p_action：resolved（已处理）/ dismissed（不予处理）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_resolve_report(
  p_id bigint, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_note   text := NULLIF(left(btrim(COALESCE(p_note, '')), 200), '');
  v_owner  text;
  v_kind   text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_action NOT IN ('resolved', 'dismissed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_action');
  END IF;

  UPDATE public.comment_reports
     SET status      = v_action,
         handled_by  = auth.uid()::text,
         handled_at  = now(),
         handle_note = v_note
   WHERE id = p_id
     AND status = 'open'
  RETURNING reporter_id INTO v_owner;

  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  v_kind := CASE WHEN v_action = 'resolved' THEN 'report_resolved' ELSE 'report_dismissed' END;

  PERFORM public.notify_push(
    v_owner, v_kind,
    CASE WHEN v_action = 'resolved' THEN '你的举报已被处理' ELSE '你的举报暂不处理' END,
    CASE WHEN v_action = 'resolved' THEN '站长已处理你举报的评论。'
         ELSE '站长看过你举报的评论，决定暂不处理。' END
      || COALESCE(' 说明：' || v_note, ''),
    'index.html', NULL, NULL, NULL
  );

  PERFORM public.audit_log('comment_report_' || v_action, 'comment_report',
    p_id::text, v_note, NULL);

  RETURN jsonb_build_object('ok', true, 'action', v_action);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_resolve_report(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_report(bigint, text, text) TO authenticated;


-- ---------------------------------------------------------------------
-- S25. admin_users_page：带上邮箱验证状态与待处理的邮箱变更（M5 / M9）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_users_page(
  p_search text DEFAULT NULL, p_status text DEFAULT NULL,
  p_limit int DEFAULT 30, p_offset int DEFAULT 0)
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
         COALESCE(p.can_publish, false) AS can_publish,
         p.email_verified_at,
         p.pending_email,
         p.pending_email_at,
         p.pending_email_note,
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
      OR COALESCE(p.pending_email, '') ILIKE '%' || v_search || '%'
    )
    AND (
      v_status IS NULL
      OR (v_status = 'disabled' AND COALESCE(p.status, 'active') = 'disabled')
      OR (v_status = 'deleted'  AND COALESCE(p.status, 'active') = 'deleted')
      OR (v_status = 'active'   AND COALESCE(p.status, 'active') NOT IN ('disabled', 'deleted'))
      OR (v_status = 'email'    AND COALESCE(p.pending_email, '') <> '')
      OR (v_status = 'admin'
          AND EXISTS (SELECT 1 FROM public.admin_emails a WHERE lower(a.email) = lower(u.email::text)))
    );

  SELECT count(*) INTO v_total FROM _au;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT owner_id, email, nickname, avatar_url, bio, status, can_publish, is_admin, is_self,
             created_at, last_login, comment_count, like_count,
             email_verified_at, pending_email, pending_email_at, pending_email_note
      FROM _au ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_users_page(text, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_users_page(text, text, int, int) TO authenticated;


-- ---------------------------------------------------------------------
-- S26. admin_stats：补举报待办与邮箱变更申请数（后台角标用）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT CASE WHEN public.is_admin() THEN jsonb_build_object(
    'users', (SELECT count(*) FROM auth.users u WHERE u.email IS NOT NULL AND u.project = COALESCE((SELECT uu.project FROM auth.users uu WHERE uu.id::text = auth.uid()::text LIMIT 1), u.project)),
    'disabled_users', (SELECT count(*) FROM public.profiles WHERE status = 'disabled'),
    'deleted_users', (SELECT count(*) FROM public.profiles WHERE status = 'deleted'),
    'comments', (SELECT count(*) FROM public.comments),
    'hidden', (SELECT count(*) FROM public.comments WHERE status = 'hidden'),
    'pending_comments', (SELECT count(*) FROM public.comments WHERE status = 'pending'),
    'likes', (SELECT count(*) FROM public.post_likes),
    'posts', (SELECT count(*) FROM public.cloud_posts WHERE status = 'published'),
    'drafts', (SELECT count(*) FROM public.cloud_posts WHERE status = 'draft'),
    'pending', (SELECT count(*) FROM public.cloud_posts WHERE status = 'pending'),
    'rejected', (SELECT count(*) FROM public.cloud_posts WHERE status = 'rejected'),
    'edit_pending', (SELECT count(*) FROM public.cloud_posts WHERE edit_submitted_at IS NOT NULL),
    'today_comments', (SELECT count(*) FROM public.comments WHERE created_at >= now() - interval '24 hours'),
    'views', (SELECT COALESCE(sum(views), 0) FROM public.post_views),
    'open_reports', (SELECT count(*) FROM public.comment_reports WHERE status = 'open'),
    'email_requests', (SELECT count(*) FROM public.profiles WHERE COALESCE(pending_email, '') <> '')
  ) ELSE NULL END
$function$;


-- =====================================================================
-- 回滚（如需）：
--   DROP FUNCTION IF EXISTS public.admin_resolve_report(bigint, text, text);
--   DROP FUNCTION IF EXISTS public.admin_reports_page(text, int, int);
--   DROP FUNCTION IF EXISTS public.delete_my_account(text);
--   DROP FUNCTION IF EXISTS public.export_my_data();
--   DROP FUNCTION IF EXISTS public.session_kill_others(text);
--   DROP FUNCTION IF EXISTS public.session_touch(text, text, text);
--   DROP FUNCTION IF EXISTS public.mark_email_verified();
--   DROP FUNCTION IF EXISTS public.admin_resolve_email_change(text, text, text);
--   DROP FUNCTION IF EXISTS public.request_email_change(text, text);
--   DROP FUNCTION IF EXISTS public.comment_vote(bigint, smallint);
--   DROP TABLE IF EXISTS public.comment_votes, public.comment_reports,
--                        public.user_blocks, public.reading_history, public.user_sessions;
--   ALTER TABLE public.comments      DROP COLUMN IF EXISTS edited_at;
--   ALTER TABLE public.post_bookmarks DROP COLUMN IF EXISTS folder, DROP COLUMN IF EXISTS is_private;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS email_verified_at,
--        DROP COLUMN IF EXISTS pending_email, DROP COLUMN IF EXISTS pending_email_at,
--        DROP COLUMN IF EXISTS pending_email_note;
--   （post_comments / comments_stamp_author / my_account / admin_users_page /
--     admin_stats / is_active / profiles_guard 需按第五批归档重建）
-- =====================================================================
