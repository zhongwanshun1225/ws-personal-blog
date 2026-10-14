-- =====================================================================
-- batch7b 作者侧补充：A3 定时发布的作者入口
-- 2026-10-15
--
-- 为什么需要单独一个函数
--  · author_update_post 只服务「已发布文章的改稿」，且校验 status='published'；
--    新投稿走的是前端直接 insert。两条路都不方便追加 publish_at 参数
--    （改签名要先 DROP，风险大），所以单独开一个最小 RPC。
--
-- 安全边界（重要）
--  · cloud_posts.publish_at 会直接影响 posts_public 的可见性
--    （视图条件是 publish_at IS NULL OR publish_at <= now()）。
--    如果放开给普通作者改已发布文章的 publish_at，作者就能把自己的文章
--    改成未来时间，从而「静默下架」——这是绕过审核的越权。
--    → 已发布状态只有 staff / can_publish 作者能改；
--      普通作者只能在 pending / draft / rejected 上登记期望时间，
--      等审核通过时由 admin_review_post 决定 published 还是 scheduled。
-- =====================================================================

CREATE OR REPLACE FUNCTION public.author_set_publish_at(p_slug text, p_at text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid     text := auth.uid()::text;
  v_row     public.cloud_posts;
  v_at      timestamptz;
  v_trusted boolean;
  v_next    text;
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

  IF p_at IS NULL OR btrim(p_at) = '' THEN
    v_at := NULL;
  ELSE
    BEGIN
      v_at := btrim(p_at)::timestamptz;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_time');
    END;
  END IF;

  v_trusted := public.is_staff()
    OR COALESCE((SELECT p.can_publish FROM public.profiles p WHERE p.owner_id = v_uid), false);

  IF v_row.status = 'published' THEN
    IF NOT v_trusted THEN
      RETURN jsonb_build_object('ok', false, 'error', 'forbidden_published');
    END IF;

    v_next := CASE WHEN v_at IS NOT NULL AND v_at > now() THEN 'scheduled' ELSE 'published' END;

    UPDATE public.cloud_posts
       SET publish_at = v_at,
           status = v_next,
           published_at = CASE
                            WHEN v_next = 'published' THEN COALESCE(published_at, v_at, now())
                            ELSE published_at
                          END,
           updated_at = now()
     WHERE id = v_row.id;

    PERFORM public.audit_log('author_set_publish_at', 'cloud_post', v_row.slug, NULL,
                             jsonb_build_object('publish_at', v_at, 'status', v_next));
    RETURN jsonb_build_object('ok', true, 'mode', 'direct', 'status', v_next, 'publish_at', v_at);
  END IF;

  -- 未发布：只登记期望时间，真正的线上状态由审核决定
  UPDATE public.cloud_posts
     SET publish_at = v_at,
         updated_at = now()
   WHERE id = v_row.id;

  PERFORM public.audit_log('author_set_publish_at', 'cloud_post', v_row.slug, NULL,
                           jsonb_build_object('publish_at', v_at, 'status', v_row.status));
  RETURN jsonb_build_object('ok', true, 'mode', 'pending', 'status', v_row.status, 'publish_at', v_at);
END
$function$;

GRANT EXECUTE ON FUNCTION public.author_set_publish_at(text, text) TO authenticated;
