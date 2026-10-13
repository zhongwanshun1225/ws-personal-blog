-- =====================================================================
-- WS Blog · 第四批（公开主页 / 安全设置 / 作者改稿 / 评论预审） 2026-10-13
--
-- 四件事：
--   A. 公开用户主页 —— profiles_public 只暴露 active 用户；posts_public 增
--                       author_id 以便文章署名链到作者主页。
--   B. 受信任作者 —— profiles.can_publish；管理员可逐个开启「改稿直接生效」。
--   C. 作者改稿不断线 —— cloud_posts 增 edit_* 影子副本。已发布文章被改时，
--                       受信任作者直接覆盖主字段；其他作者写入 edit_* 待审，
--                       主字段（线上版本）全程保持可见，不再需要下架。
--   D. 评论预审前置 —— 新评论默认 pending（触发器强制，不信客户端）；
--                       敏感词命中标记 flag_reason；双窗口频率限制；
--                       并修掉「作者可把自己评论改成 visible」的自批漏洞。
--
-- 设计要点：
--   * 一律走 RPC，客户端对 cloud_posts / comments 的表级权限不扩宽。
--     author_update_post / admin_review_edit 都是 SECURITY DEFINER，
--     内部用 auth.uid() / is_admin() 判定，比放宽 RLS 更好审。
--   * 客户端报什么 status 都不算数：comments_stamp_author 在 BEFORE INSERT
--     强制降级为 pending（管理员除外），在 BEFORE UPDATE 强制沿用 OLD.status。
--   * edit_* 列不出现在任何公开视图里，待审内容不会泄漏到前台。
--
-- 应用方式：一条一条执行（REST 通道一次只接受一条语句）。
-- =====================================================================


-- ---------------------------------------------------------------------
-- A1. 公开视图：profiles_public 只含 active；posts_public 增 author_id
-- ---------------------------------------------------------------------
-- profiles_public 此前没有过滤 status，被禁用用户的资料也会出现在公开主页上；
-- 这里补上过滤。视图内不暴露 status 列本身，只用来筛选。
CREATE OR REPLACE VIEW public.profiles_public AS
SELECT owner_id, nickname, avatar_url, bio
FROM public.profiles
WHERE status = 'active';

-- author_id 追加在列尾（CREATE OR REPLACE VIEW 只允许在尾部加列）。
-- 暴露作者 id 是「文章署名 → 作者主页」的必要代价：id 为不透明数字串，
-- 不含邮箱等 PII；且只有已发布文章的作者才会因此被枚举到。
CREATE OR REPLACE VIEW public.posts_public AS
SELECT id, slug, title, summary, tags, content_md, published_at, created_at, updated_at, author_id
FROM public.cloud_posts
WHERE status = 'published';


-- ---------------------------------------------------------------------
-- B1. 受信任作者标记
-- ---------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_publish boolean NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------
-- C1. 改稿影子副本（待审内容，永不进公开视图）
-- ---------------------------------------------------------------------
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS edit_title        text;
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS edit_summary      text;
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS edit_content_md   text;
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS edit_tags         text[];
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS edit_submitted_at timestamptz;
ALTER TABLE public.cloud_posts ADD COLUMN IF NOT EXISTS edit_review_note  text;

CREATE INDEX IF NOT EXISTS cloud_posts_edit_pending_idx
  ON public.cloud_posts (edit_submitted_at) WHERE edit_submitted_at IS NOT NULL;


-- ---------------------------------------------------------------------
-- D1. 评论预审所需的结构
-- ---------------------------------------------------------------------
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS flag_reason text;

-- 默认值改成 pending 只是「第一道」；真正生效的是 C2/D2 里的触发器，
-- 因为客户端可以显式传 status='visible' 绕过默认值。
ALTER TABLE public.comments ALTER COLUMN status SET DEFAULT 'pending';


-- ---------------------------------------------------------------------
-- D2. 敏感词表（仅服务端与管理员 RPC 可读）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comment_banned_words (
  word       text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.comment_banned_words FROM anon, authenticated;

-- 只做「标记 + 留待审」，不自动隐藏，所以宁可宽一点：误标记的代价只是
-- 审核时多一条提示，漏标记的代价是垃圾评论直接挂在线上。
INSERT INTO public.comment_banned_words (word) VALUES
  ('加微信'), ('微信号'), ('加 wx'), ('加vx'), ('加VX'), ('加qq'), ('加QQ'), ('V信'),
  ('私聊'), ('私信我'), ('代刷'), ('刷单'), ('返利'), ('日赚'), ('月入过万'),
  ('免费领取'), ('点击链接'), ('领取优惠'), ('办证'), ('发票'), ('小额贷款'),
  ('博彩'), ('赌场'), ('澳门'), ('色情'), ('裸聊'), ('加群'), ('引流'),
  ('http://'), ('https://'), ('www.')
ON CONFLICT (word) DO NOTHING;


-- ---------------------------------------------------------------------
-- B2. profiles_guard：保护 can_publish + 拒绝 INSERT 时自带该标记
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  -- 受信任标记只能由管理员通过 admin_set_can_publish 改动
  IF TG_OP = 'INSERT' THEN
    IF NOT public.is_admin() THEN
      NEW.can_publish := false;
    END IF;
  ELSE
    IF NEW.can_publish IS DISTINCT FROM OLD.can_publish AND NOT public.is_admin() THEN
      NEW.can_publish := OLD.can_publish;
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      NEW.created_at := OLD.created_at;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT public.is_admin() THEN
      NEW.status := OLD.status;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$function$;


-- ---------------------------------------------------------------------
-- D3. comments_stamp_author：预审强制 + 敏感词 + 频率限制 + 修自批漏洞
--     （这是本批最关键的一个函数，替代原先的版本）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.comments_stamp_author()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_nickname  text;
  v_parent    public.comments;
  v_word      text;
  v_recent_1m int;
  v_recent_10m int;
  v_admin     boolean := public.is_admin();
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.owner_id := auth.uid()::text;
  END IF;
  IF NEW.owner_id IS NULL OR NEW.owner_id = '' THEN
    RAISE EXCEPTION '评论必须由登录用户提交' USING ERRCODE = '42501';
  END IF;

  -- ---- 非管理员：身份字段不可改，状态不可自批 ----
  IF TG_OP = 'UPDATE' AND NOT v_admin THEN
    NEW.owner_id   := OLD.owner_id;
    NEW.post_slug  := OLD.post_slug;
    NEW.parent_id  := OLD.parent_id;
    -- 关键修复：此前 comments_own_all 策略允许用户改自己行的 status，
    -- 等于可以自己把待审评论改成 visible。这里一律沿用旧状态。
    NEW.status     := OLD.status;
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

  -- ---- 内容校验 ----
  NEW.content := btrim(coalesce(NEW.content, ''));
  IF char_length(NEW.content) = 0 THEN
    RAISE EXCEPTION '评论内容不能为空' USING ERRCODE = '23514';
  END IF;
  NEW.content := left(NEW.content, 1000);

  -- ---- 敏感词：命中即标记 flag_reason（取最长命中词，便于审核判断）----
  SELECT w.word INTO v_word
    FROM public.comment_banned_words w
   WHERE position(lower(w.word) IN lower(NEW.content)) > 0
   ORDER BY char_length(w.word) DESC
   LIMIT 1;
  NEW.flag_reason := CASE WHEN v_word IS NULL THEN NULL ELSE '命中敏感词：' || left(v_word, 40) END;

  -- ---- 状态定稿（放在敏感词之后，管理员可直接发；其他人一律 pending）----
  IF TG_OP = 'INSERT' THEN
    IF v_admin THEN
      -- 管理员自己发评论可以直接可见
      NEW.status := CASE
        WHEN NEW.status IS NULL OR NEW.status NOT IN ('visible', 'hidden', 'pending') THEN 'visible'
        ELSE NEW.status
      END;
    ELSE
      NEW.status := 'pending';
    END IF;
  ELSE
    -- 非管理员改了内容 → 重新回到待审，避免「先过审再偷换内容」
    IF NOT v_admin AND NEW.content IS DISTINCT FROM OLD.content AND OLD.status = 'visible' THEN
      NEW.status := 'pending';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
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

  RETURN NEW;
END
$function$;


-- ---------------------------------------------------------------------
-- D4. post_comments：返回 status，并把「自己的待审评论」也带回来
--     签名（返回列）变了，必须先 DROP 再建
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.post_comments(text);

CREATE OR REPLACE FUNCTION public.post_comments(p_slug text)
RETURNS TABLE(
  id bigint, parent_id bigint, author_name text, content text,
  created_at timestamptz, is_mine boolean, status text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT c.id, c.parent_id, c.author_name, c.content, c.created_at,
         (c.owner_id = auth.uid()) AS is_mine,
         c.status
    FROM public.comments c
   WHERE c.post_slug = p_slug
     -- 别人的待审/隐藏评论不返回；自己的则照常返回带着 status，
     -- 这样作者能看到自己的评论「审核中」，而不是以为发丢了。
     AND (c.status = 'visible' OR c.owner_id = auth.uid())
   ORDER BY c.created_at DESC
   LIMIT 300
$function$;

REVOKE EXECUTE ON FUNCTION public.post_comments(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_comments(text) TO anon, authenticated;


-- ---------------------------------------------------------------------
-- D5. notify_on_comment 改为 INSERT/UPDATE 双触发，只在「变成可见」时通知
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_comment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_actor         text := COALESCE(auth.uid()::text, NEW.owner_id);
  v_actor_name    text := COALESCE(NULLIF(btrim(NEW.author_name), ''), '读者');
  v_ref           text := NEW.post_slug;
  v_slug          text;
  v_title         text;
  v_link          text;
  v_post_author   text;
  v_parent_author text;
  v_rec           text;
  v_excerpt       text := left(btrim(NEW.content), 120);
BEGIN
  -- 未通过审核的评论不产生任何通知：否则每发一条待审评论都会打扰站长，
  -- 而被回复的人也看不到内容。审核通过时（UPDATE → visible）才通知。
  IF NEW.status IS DISTINCT FROM 'visible' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.status = 'hidden'
       AND OLD.status IS DISTINCT FROM 'hidden'
       AND NEW.owner_id IS NOT NULL THEN
      PERFORM public.notify_push(
        NEW.owner_id, 'comment_hidden',
        '你的评论没有通过审核',
        COALESCE(NULLIF(btrim(NEW.flag_reason), ''),
                 '可能是含广告或不适合公开的内容，修改后可以重新提交。'),
        'posts/' || CASE WHEN NEW.post_slug LIKE 'cloud:%' THEN substr(NEW.post_slug, 7) ELSE NEW.post_slug END || '.html',
        v_actor, COALESCE(public.display_name_for(v_actor), '站长'), NEW.post_slug);
    END IF;
    RETURN NEW;
  END IF;

  -- 本来就已经是可见的（例如只改了内容之外的东西），避免重复通知
  IF TG_OP = 'UPDATE' AND OLD.status = 'visible' THEN
    RETURN NEW;
  END IF;

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

  IF NEW.parent_id IS NOT NULL THEN
    SELECT owner_id INTO v_parent_author FROM public.comments WHERE id = NEW.parent_id;
    IF v_parent_author IS NOT NULL AND v_parent_author <> v_actor THEN
      PERFORM public.notify_push(
        v_parent_author, 'reply',
        v_actor_name || ' 回复了你的评论',
        v_excerpt, v_link, v_actor, v_actor_name, v_ref);
    END IF;
  END IF;

  IF v_post_author IS NOT NULL
     AND v_post_author <> v_actor
     AND v_post_author IS DISTINCT FROM v_parent_author THEN
    PERFORM public.notify_push(
      v_post_author, 'comment',
      v_actor_name || ' 评论了《' || v_title || '》',
      v_excerpt, v_link, v_actor, v_actor_name, v_ref);
  END IF;

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
  AFTER INSERT OR UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_comment();


-- ---------------------------------------------------------------------
-- D6. admin_comments_page：修正「已隐藏」的口径 + 返回 flag_reason
--     此前 v_status='hidden' 被当成 status <> 'visible'，会把 pending 也算进
--     「已隐藏」；现在 pending 独立成一档。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_comments_page(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit  integer DEFAULT 30,
  p_offset integer DEFAULT 0
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
  SELECT c.id, c.parent_id, c.post_slug, c.author_name, c.content, c.status,
         c.flag_reason, c.created_at,
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
      OR c.status = v_status
    );

  SELECT count(*) INTO v_total FROM _ac;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT id, parent_id, post_slug, author_name, content, status, flag_reason,
             created_at, parent_author
      FROM _ac ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;


-- ---------------------------------------------------------------------
-- D7. admin_stats：待审评论独立计数，「已隐藏」不再混入 pending
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
    'views', (SELECT COALESCE(sum(views), 0) FROM public.post_views)
  ) ELSE NULL END
$function$;


-- ---------------------------------------------------------------------
-- D8. 敏感词管理 RPC（仅管理员）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_comment_words()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT CASE WHEN public.is_admin() THEN COALESCE(
    (SELECT jsonb_agg(w.word ORDER BY w.word) FROM public.comment_banned_words w),
    '[]'::jsonb) ELSE NULL END
$function$;

CREATE OR REPLACE FUNCTION public.admin_add_comment_word(p_word text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_word text := lower(left(btrim(coalesce(p_word, '')), 40));
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF char_length(v_word) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty');
  END IF;
  INSERT INTO public.comment_banned_words (word) VALUES (v_word)
  ON CONFLICT (word) DO NOTHING;
  PERFORM public.audit_log('comment_word_add', 'comment_word', v_word, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'word', v_word);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_comment_word(p_word text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_word text := lower(btrim(coalesce(p_word, '')));
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  DELETE FROM public.comment_banned_words WHERE word = v_word;
  PERFORM public.audit_log('comment_word_remove', 'comment_word', v_word, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_comment_words() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_add_comment_word(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_remove_comment_word(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_comment_words() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_comment_word(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_comment_word(text) TO authenticated;


-- ---------------------------------------------------------------------
-- C2. author_update_post：作者改稿的唯一入口（仅处理已发布文章）
--     返回 mode='direct'（受信任，已直接生效）或 'pending'（已提交待审，
--     线上版本不受影响）。非已发布文章返回 error='not_published'，
--     前端继续走原有的草稿/投稿保存路径。
--
-- ⚠️ p_submit 目前是**保留参数**：函数体一律按「提交」处理（前端也总是传 true）。
--    它留着是为了将来支持「先存一版不提交」，不要因为「没用到」就删 ——
--    删掉会改变函数签名，得 DROP FUNCTION 再建，白白制造一次迁移。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.author_update_post(
  p_slug       text,
  p_title      text,
  p_summary    text DEFAULT NULL,
  p_content_md text DEFAULT NULL,
  p_tags       jsonb DEFAULT NULL,
  p_submit     boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid     text := auth.uid()::text;
  v_row     public.cloud_posts;
  v_title   text := left(btrim(coalesce(p_title, '')), 120);
  v_summary text := left(btrim(coalesce(p_summary, '')), 300);
  v_content text := coalesce(p_content_md, '');
  v_tags    text[];
  v_trusted boolean;
  v_name    text;
  v_rec     text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  IF NOT public.is_active() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inactive');
  END IF;
  IF char_length(v_title) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'title_required');
  END IF;
  IF char_length(btrim(v_content)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'content_required');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = p_slug;
  IF NOT FOUND OR v_row.author_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.status <> 'published' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_published', 'status', v_row.status);
  END IF;

  v_tags := CASE
    WHEN p_tags IS NULL THEN v_row.tags
    ELSE ARRAY(
      SELECT left(btrim(x), 40)
        FROM jsonb_array_elements_text(p_tags) AS x
       WHERE btrim(x) <> ''
       LIMIT 12)
  END;

  v_trusted := public.is_admin()
    OR COALESCE((SELECT p.can_publish FROM public.profiles p WHERE p.owner_id = v_uid), false);
  v_name := COALESCE(public.display_name_for(v_uid), '作者');

  IF v_trusted THEN
    UPDATE public.cloud_posts
       SET title = v_title,
           summary = NULLIF(v_summary, ''),
           content_md = v_content,
           tags = v_tags,
           updated_at = now()
     WHERE id = v_row.id;

    -- 直接生效也要让站长知道线上文章被改过（可追溯）
    FOR v_rec IN SELECT x FROM unnest(public.admin_recipient_ids(v_uid)) AS x LOOP
      PERFORM public.notify_push(
        v_rec, 'post_edited',
        '《' || v_title || '》已被作者直接修改',
        '该账号已开启「改稿直接生效」，线上版本已更新，无需审核。',
        'posts/' || v_row.slug || '.html', v_uid, v_name, v_row.slug);
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'mode', 'direct', 'slug', v_row.slug);
  END IF;

  UPDATE public.cloud_posts
     SET edit_title = v_title,
         edit_summary = NULLIF(v_summary, ''),
         edit_content_md = v_content,
         edit_tags = v_tags,
         edit_submitted_at = now(),
         edit_review_note = NULL
   WHERE id = v_row.id;

  FOR v_rec IN SELECT x FROM unnest(public.admin_recipient_ids(v_uid)) AS x LOOP
    PERFORM public.notify_push(
      v_rec, 'post_edit_pending',
      '改稿待审核：《' || v_title || '》',
      '线上版本不受影响，仍在正常展示；通过后才会替换。',
      'admin.html', v_uid, v_name, v_row.slug);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'mode', 'pending', 'slug', v_row.slug);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.author_update_post(text, text, text, text, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.author_update_post(text, text, text, text, jsonb, boolean) TO authenticated;


-- ---------------------------------------------------------------------
-- C3. admin_review_edit：审核改稿（通过=用 edit_* 覆盖主字段；驳回=留理由）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_review_edit(
  p_slug   text,
  p_action text,
  p_note   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid   text := auth.uid()::text;
  v_row   public.cloud_posts;
  v_note  text := left(btrim(coalesce(p_note, '')), 300);
  v_actor text := COALESCE(public.display_name_for(v_uid), '站长');
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = p_slug;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.edit_submitted_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_pending_edit');
  END IF;

  IF p_action = 'approve' THEN
    UPDATE public.cloud_posts
       SET title            = COALESCE(NULLIF(btrim(v_row.edit_title), ''), title),
           summary          = v_row.edit_summary,
           content_md       = COALESCE(v_row.edit_content_md, content_md),
           tags             = COALESCE(v_row.edit_tags, tags),
           edit_title = NULL, edit_summary = NULL, edit_content_md = NULL,
           edit_tags = NULL, edit_submitted_at = NULL, edit_review_note = NULL,
           reviewed_by = v_uid, reviewed_at = now(), updated_at = now()
     WHERE id = v_row.id;
  ELSIF p_action = 'reject' THEN
    UPDATE public.cloud_posts
       SET edit_submitted_at = NULL,
           edit_review_note  = COALESCE(NULLIF(v_note, ''), '站长没有填写理由。'),
           reviewed_by = v_uid, reviewed_at = now()
     WHERE id = v_row.id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
  END IF;

  PERFORM public.audit_log('review_edit_' || p_action, 'cloud_post', p_slug, v_note, NULL);

  IF v_row.author_id IS NOT NULL THEN
    IF p_action = 'approve' THEN
      PERFORM public.notify_push(
        v_row.author_id, 'post_edit_approved',
        '《' || COALESCE(NULLIF(btrim(v_row.edit_title), ''), v_row.title) || '》的修改已通过',
        '线上版本已更新为你提交的新内容。',
        'posts/' || v_row.slug || '.html', v_uid, v_actor, v_row.slug);
    ELSE
      PERFORM public.notify_push(
        v_row.author_id, 'post_edit_rejected',
        '《' || v_row.title || '》的修改未通过',
        COALESCE(NULLIF(v_note, ''), '站长没有填写理由，修改后可以重新提交。'),
        'write.html?slug=' || v_row.slug, v_uid, v_actor, v_row.slug);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'action', p_action, 'slug', p_slug);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_review_edit(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_edit(text, text, text) TO authenticated;


-- ---------------------------------------------------------------------
-- C4. admin_posts_page：带上改稿待审信息，便于后台单列一区
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_posts_page(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit  integer DEFAULT 20,
  p_offset integer DEFAULT 0
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
  SELECT p.id, p.slug, p.title, p.summary, p.status, p.author_id, p.tags,
         p.created_at, p.updated_at, p.published_at, p.review_note, p.reviewed_at,
         p.edit_submitted_at, p.edit_review_note,
         COALESCE(NULLIF(btrim(p.edit_title), ''), p.title) AS edit_title,
         COALESCE(pr.nickname, '') AS nickname,
         COALESCE(au.email::text, '') AS email
  FROM public.cloud_posts p
  LEFT JOIN public.profiles pr ON pr.owner_id = p.author_id
  LEFT JOIN auth.users au ON au.id::text = p.author_id
  WHERE (
      v_search IS NULL
      OR p.title ILIKE '%' || v_search || '%'
      OR p.slug ILIKE '%' || v_search || '%'
      OR COALESCE(p.summary, '') ILIKE '%' || v_search || '%'
      OR COALESCE(pr.nickname, '') ILIKE '%' || v_search || '%'
      OR COALESCE(au.email::text, '') ILIKE '%' || v_search || '%'
    )
    AND (
      v_status IS NULL
      OR (v_status = 'reviewed' AND (p.status = 'rejected' OR (p.status = 'published' AND p.reviewed_at IS NOT NULL)))
      OR (v_status = 'published' AND p.status = 'published')
      OR (v_status = 'edit_pending' AND p.edit_submitted_at IS NOT NULL)
      OR (v_status NOT IN ('reviewed', 'published', 'edit_pending') AND p.status = v_status)
    );

  SELECT count(*) INTO v_total FROM _ap;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT id, slug, title, summary, status, author_id, tags, created_at, updated_at,
             published_at, review_note, reviewed_at, edit_submitted_at, edit_review_note,
             edit_title, nickname, email
      FROM _ap
     ORDER BY (status = 'pending') DESC, (edit_submitted_at IS NOT NULL) DESC, updated_at DESC
     LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;


-- ---------------------------------------------------------------------
-- B3. admin_users_page 带上 can_publish；新增 admin_set_can_publish
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_users_page(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit  integer DEFAULT 30,
  p_offset integer DEFAULT 0
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
         COALESCE(p.can_publish, false) AS can_publish,
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
      SELECT owner_id, email, nickname, avatar_url, bio, status, can_publish, is_admin, is_self,
             created_at, last_login, comment_count, like_count
      FROM _au ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_can_publish(p_owner text, p_can boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_owner text := btrim(coalesce(p_owner, ''));
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_owner = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty');
  END IF;

  INSERT INTO public.profiles (owner_id, can_publish)
  VALUES (v_owner, COALESCE(p_can, false))
  ON CONFLICT (owner_id) DO UPDATE SET can_publish = COALESCE(p_can, false), updated_at = now();

  PERFORM public.audit_log(
    CASE WHEN p_can THEN 'grant_can_publish' ELSE 'revoke_can_publish' END,
    'profile', v_owner, NULL, NULL);

  RETURN jsonb_build_object('ok', true, 'owner_id', v_owner, 'can_publish', COALESCE(p_can, false));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_set_can_publish(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_can_publish(text, boolean) TO authenticated;


-- ---------------------------------------------------------------------
-- B4. my_account 带上 can_publish，前端据此提示「直接生效 / 需审核」
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
      'can_publish', COALESCE((SELECT p.can_publish FROM public.profiles p WHERE p.owner_id = auth.uid()::text), false)
    )
  END
$function$;


-- ---------------------------------------------------------------------
-- C6. admin_post_edit_detail：后台审核改稿时做「新旧全文对照」
--     通过前必须让管理员看清「即将上线的内容」，否则只能盲批。
--     返回 pending=false 表示这篇当前没有待审改稿（按钮已失效的场景）。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_post_edit_detail(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_row public.cloud_posts%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT * INTO v_row FROM public.cloud_posts c WHERE c.slug = p_slug;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'slug', v_row.slug,
    'pending', v_row.edit_submitted_at IS NOT NULL,
    'submitted_at', v_row.edit_submitted_at,
    'title', v_row.title,
    'summary', COALESCE(v_row.summary, ''),
    'content_md', COALESCE(v_row.content_md, ''),
    'tags', COALESCE(v_row.tags, '[]'::jsonb),
    'edit_title', COALESCE(NULLIF(btrim(v_row.edit_title), ''), v_row.title),
    'edit_summary', COALESCE(v_row.edit_summary, COALESCE(v_row.summary, '')),
    'edit_content_md', COALESCE(v_row.edit_content_md, v_row.content_md, '')
  );
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_post_edit_detail(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_post_edit_detail(text) TO authenticated;
