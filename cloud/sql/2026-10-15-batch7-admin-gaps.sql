-- =====================================================================
-- batch7 (B) 站点管理员缺口：B2–B17
-- 2026-10-15
--
--  B2  批量操作        admin_bulk()
--  B3  站外通知渠道    notify_outbox + 触发器 + claim/ack/retry（投递由云函数 ws-notify 完成）
--  B5  数据导出/备份   admin_export() + backup_snapshots
--  B6  站点配置在线改  site_settings + settings_public()（构建期合流）+ admin_settings_*
--  B7  媒体库          media_assets + media_register/page/delete
--  B8  置顶/权重/定时  admin_set_post_flags() + admin_posts_page 输出新列
--  B9  统计图表        admin_stats_trend() + admin_top_posts()
--  B10 访问分析        page_views_log + page_view_log() + admin_analytics()
--  B11 角色分档        profiles.is_editor + is_staff() + 审核类函数放行编辑
--  B12 审计筛选导出    admin_audit_page() + admin_audit_actions()
--  B13 二次验证        user_totp + TOTP（pgcrypto hmac-sha1）+ 敏感操作闸门
--  B14 健康检查        admin_health()
--  B15 公告/维护模式   settings：banner.announcement / banner.maintenance
--  B16 邮件模板        settings：mail.tpl.*（渲染结果进 outbox payload）
--  B17 反垃圾          comments.ip_hash/ua_family/spam_score/spam_flags + 评分 + admin_spam_page
--
-- 约定：SECURITY DEFINER 一律 SET search_path TO 'public','auth'
-- =====================================================================

-- =====================================================================
-- 0. 身份：编辑（Editor）与 staff
-- =====================================================================
CREATE OR REPLACE FUNCTION public.is_editor()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT COALESCE((SELECT p.is_editor FROM public.profiles p WHERE p.owner_id = auth.uid()::text), false)
     AND public.is_active()
$function$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT public.is_admin() OR public.is_editor()
$function$;

CREATE OR REPLACE FUNCTION public.my_admin_role()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT CASE
           WHEN public.is_admin() THEN 'admin'
           WHEN public.is_editor() THEN 'editor'
           ELSE 'none'
         END
$function$;

GRANT EXECUTE ON FUNCTION public.my_admin_role() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_flags(p_owner text, p_can_publish boolean, p_is_editor boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_n int;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  PERFORM public.require_totp_gate();
  IF p_owner IS NULL OR btrim(p_owner) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
  END IF;
  IF btrim(p_owner) = auth.uid()::text AND p_is_editor IS TRUE AND NOT p_can_publish THEN
    -- 允许，但记一笔审计，避免误操作静默降权
    NULL;
  END IF;

  UPDATE public.profiles
     SET can_publish = COALESCE(p_can_publish, can_publish),
         is_editor   = COALESCE(p_is_editor, is_editor),
         updated_at  = now()
   WHERE owner_id = btrim(p_owner);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  PERFORM public.audit_log(
    'set_flags', 'profile', btrim(p_owner), NULL,
    jsonb_build_object('can_publish', p_can_publish, 'is_editor', p_is_editor)
  );
  RETURN jsonb_build_object('ok', true, 'can_publish', p_can_publish, 'is_editor', p_is_editor);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_set_flags(text, boolean, boolean) TO authenticated;

-- =====================================================================
-- 1. B6/B15/B16 站点设置（含公告、维护模式、邮件模板、通知渠道）
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.site_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_public  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
-- 无策略：读取走 settings_public()（匿名白名单）与 admin_settings_get()（管理员全量）

CREATE OR REPLACE FUNCTION public.settings_defaults()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_build_object(
    'site.title',       jsonb_build_object('value', '', 'public', true),
    'site.tagline',     jsonb_build_object('value', '', 'public', true),
    'site.description', jsonb_build_object('value', '', 'public', true),
    'site.keywords',    jsonb_build_object('value', '', 'public', true),
    'site.footer_icp',  jsonb_build_object('value', '', 'public', true),
    'contact.email',    jsonb_build_object('value', '', 'public', true),
    'banner.announcement', jsonb_build_object(
        'value', jsonb_build_object('active', false, 'text', '', 'level', 'info', 'until', null),
        'public', true),
    'banner.maintenance', jsonb_build_object(
        'value', jsonb_build_object('active', false, 'message', '站点正在维护，稍后就回来。', 'allow_admin', true),
        'public', true),
    'comment.auto_hide_score', jsonb_build_object('value', 7, 'public', false),
    'comment.hold_score',      jsonb_build_object('value', 4, 'public', false),
    'security.ip_salt',        jsonb_build_object('value', '', 'public', false),
    'security.totp_note',      jsonb_build_object('value', '', 'public', false),
    'notify.enabled',      jsonb_build_object('value', false, 'public', false),
    'notify.kinds',        jsonb_build_object(
        'value', jsonb_build_array('comment','submission','report','email_request','mention'), 'public', false),
    'notify.webhook_url',  jsonb_build_object('value', '', 'public', false),
    'notify.webhook_kind', jsonb_build_object('value', 'auto', 'public', false),
    'notify.worker_secret',jsonb_build_object('value', '', 'public', false),
    'mail.enabled',        jsonb_build_object('value', false, 'public', false),
    'mail.tpl.comment',        jsonb_build_object(
        'value', jsonb_build_object(
          'subject', '【{site}】{post} 收到新评论',
          'body',    '作者：{author}\n内容：{excerpt}\n链接：{link}'),
        'public', false),
    'mail.tpl.submission',     jsonb_build_object(
        'value', jsonb_build_object(
          'subject', '【{site}】新投稿待审核：{title}',
          'body',    '作者：{author}\n摘要：{excerpt}\n后台：{link}'),
        'public', false),
    'mail.tpl.email_request',  jsonb_build_object(
        'value', jsonb_build_object(
          'subject', '【{site}】邮箱变更申请',
          'body',    '用户 {author} 申请把邮箱改为 {target}。\n说明：{excerpt}\n后台：{link}'),
        'public', false),
    'mail.tpl.report',         jsonb_build_object(
        'value', jsonb_build_object(
          'subject', '【{site}】收到评论举报',
          'body',    '举报人：{author}\n原因：{excerpt}\n后台：{link}'),
        'public', false),
    'mail.tpl.system',         jsonb_build_object(
        'value', jsonb_build_object(
          'subject', '【{site}】系统通知',
          'body',    '{title}\n{excerpt}\n{link}'),
        'public', false)
  )
$function$;

-- 匿名可读的白名单设置（顺带把默认值合并进去，前端不用自己兜底）
CREATE OR REPLACE FUNCTION public.settings_public()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_out jsonb := '{}'::jsonb;
  v_rec record;
  v_def jsonb := public.settings_defaults();
BEGIN
  FOR v_rec IN SELECT key, value FROM public.site_settings WHERE is_public LOOP
    v_out := v_out || jsonb_build_object(v_rec.key, v_rec.value);
  END LOOP;

  FOR v_rec IN SELECT key, value FROM jsonb_each(v_def) LOOP
    IF (v_rec.value->>'public')::boolean AND NOT v_out ? v_rec.key THEN
      v_out := v_out || jsonb_build_object(v_rec.key, v_rec.value->'value');
    END IF;
  END LOOP;

  RETURN v_out;
END
$function$;

GRANT EXECUTE ON FUNCTION public.settings_public() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_settings_get()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_map jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, jsonb_build_object('value', value, 'is_public', is_public, 'updated_at', updated_at)), '{}'::jsonb)
    INTO v_map
    FROM public.site_settings;

  RETURN jsonb_build_object('ok', true, 'defaults', public.settings_defaults(), 'rows', v_map);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_settings_get() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_settings_set(p_key text, p_value jsonb, p_is_public boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_key text := btrim(COALESCE(p_key, ''));
  v_pub boolean;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  PERFORM public.require_totp_gate();
  IF v_key = '' OR p_value IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
  END IF;
  IF char_length(v_key) > 60 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_key');
  END IF;

  IF p_is_public IS NULL THEN
    SELECT COALESCE((public.settings_defaults()->v_key->>'public')::boolean, false) INTO v_pub;
  ELSE
    v_pub := p_is_public;
  END IF;
  -- 只有白名单键允许公开，避免把 webhook secret 之类写漏
  IF v_pub AND (public.settings_defaults() ? v_key) IS NOT TRUE THEN
    v_pub := false;
  END IF;

  INSERT INTO public.site_settings (key, value, is_public, updated_at, updated_by)
  VALUES (v_key, p_value, v_pub, now(), auth.uid()::text)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        is_public = EXCLUDED.is_public,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by;

  PERFORM public.audit_log('setting_set', 'site_setting', v_key, NULL,
                           jsonb_build_object('is_public', v_pub, 'value', p_value));
  RETURN jsonb_build_object('ok', true, 'key', v_key, 'is_public', v_pub);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_settings_set(text, jsonb, boolean) TO authenticated;

-- =====================================================================
-- 2. B16 邮件/站外消息模板渲染 + B3 发件箱
-- =====================================================================
CREATE OR REPLACE FUNCTION public.render_template(p_key text, p_vars jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_tpl jsonb;
  v_sub text;
  v_bod text;
  v_k   text;
BEGIN
  SELECT value INTO v_tpl
    FROM public.site_settings
   WHERE key = p_key;

  IF v_tpl IS NULL THEN
    SELECT (public.settings_defaults()->p_key->'value') INTO v_tpl;
  END IF;
  IF v_tpl IS NULL THEN
    RETURN jsonb_build_object('subject', '', 'body', '');
  END IF;

  v_sub := COALESCE(v_tpl->>'subject', '');
  v_bod := COALESCE(v_tpl->>'body', '');

  FOR v_k IN SELECT jsonb_object_keys(COALESCE(p_vars, '{}'::jsonb)) LOOP
    v_sub := replace(v_sub, '{' || v_k || '}', COALESCE(p_vars->>v_k, ''));
    v_bod := replace(v_bod, '{' || v_k || '}', COALESCE(p_vars->>v_k, ''));
  END LOOP;

  RETURN jsonb_build_object('subject', left(v_sub, 200), 'body', left(v_bod, 4000));
END
$function$;

CREATE TABLE IF NOT EXISTS public.notify_outbox (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text,
  link         text,
  recipient_id text,
  template_key text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  next_try_at  timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  sent_at      timestamptz,
  last_error   text
);

ALTER TABLE public.notify_outbox ENABLE ROW LEVEL SECURITY;
-- 无策略：领取/确认走带共享密钥的 SECURITY DEFINER 函数，读取走后端

CREATE INDEX IF NOT EXISTS notify_outbox_pending_idx ON public.notify_outbox (next_try_at) WHERE sent_at IS NULL;

CREATE OR REPLACE FUNCTION public.notify_outbox_enqueue(
  p_kind text, p_title text, p_body text, p_link text, p_recipient text, p_template_key text, p_vars jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_enabled boolean := false;
  v_kinds   jsonb := '[]'::jsonb;
  v_kind    text := left(COALESCE(p_kind, 'system'), 40);
  v_tpl     jsonb;
  v_id      bigint;
  v_site    text;
BEGIN
  SELECT COALESCE((value)::text::boolean, false) INTO v_enabled
    FROM public.site_settings WHERE key = 'notify.enabled';
  IF v_enabled IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT value INTO v_kinds FROM public.site_settings WHERE key = 'notify.kinds';
  IF v_kinds IS NULL THEN
    SELECT public.settings_defaults()->'notify.kinds'->'value' INTO v_kinds;
  END IF;
  IF jsonb_typeof(v_kinds) = 'array' AND NOT (v_kinds ? v_kind) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(NULLIF(btrim(value::text, '"'), ''), '') INTO v_site
    FROM public.site_settings WHERE key = 'site.title';
  IF v_site IS NULL OR v_site = '' THEN
    v_site := 'WS Blog';
  END IF;

  v_tpl := public.render_template(
    COALESCE(p_template_key, 'mail.tpl.system'),
    COALESCE(p_vars, '{}'::jsonb) || jsonb_build_object('site', v_site)
  );

  INSERT INTO public.notify_outbox (kind, title, body, link, recipient_id, template_key, payload)
  VALUES (
    v_kind,
    COALESCE(NULLIF(btrim(v_tpl->>'subject'), ''), left(COALESCE(p_title, '通知'), 200)),
    COALESCE(NULLIF(v_tpl->>'body', ''), left(COALESCE(p_body, ''), 4000)),
    left(COALESCE(p_link, ''), 300),
    p_recipient,
    COALESCE(p_template_key, 'mail.tpl.system'),
    jsonb_build_object(
      'kind', v_kind,
      'title', left(COALESCE(p_title, ''), 200),
      'body', left(COALESCE(p_body, ''), 500),
      'link', left(COALESCE(p_link, ''), 300),
      'recipient', p_recipient,
      'site', v_site,
      'vars', COALESCE(p_vars, '{}'::jsonb)
    )
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.notify_outbox_enqueue(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.outbox_from_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_kind text;
  v_tpl  text;
BEGIN
  -- 只把「站长需要知道的事」送出去；读者之间的回复不打扰
  v_kind := CASE
              WHEN NEW.kind IN ('post_pending', 'post_edit_pending') THEN 'submission'
              WHEN NEW.kind IN ('comment_report', 'report') THEN 'report'
              WHEN NEW.kind = 'email_request' THEN 'email_request'
              WHEN NEW.kind = 'mention' THEN 'mention'
              WHEN NEW.kind IN ('comment', 'reply') THEN 'comment'
              ELSE NULL
            END;
  IF v_kind IS NULL THEN
    RETURN NEW;
  END IF;

  v_tpl := CASE v_kind
             WHEN 'submission' THEN 'mail.tpl.submission'
             WHEN 'report' THEN 'mail.tpl.report'
             WHEN 'email_request' THEN 'mail.tpl.email_request'
             WHEN 'comment' THEN 'mail.tpl.comment'
             ELSE 'mail.tpl.system'
           END;

  PERFORM public.notify_outbox_enqueue(
    v_kind, NEW.title, NEW.body, NEW.link, NEW.recipient_id, v_tpl,
    jsonb_build_object(
      'title', COALESCE(NEW.title, ''),
      'excerpt', left(COALESCE(NEW.body, ''), 300),
      'author', COALESCE(NEW.actor_name, '读者'),
      'post', COALESCE(NEW.post_slug, ''),
      'link', COALESCE(NEW.link, ''),
      'target', COALESCE(NEW.body, '')
    )
  );
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS notifications_outbox_trg ON public.notifications;
CREATE TRIGGER notifications_outbox_trg
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.outbox_from_notification();

-- 云函数用：按共享密钥领取待投递记录
CREATE OR REPLACE FUNCTION public.notify_outbox_claim(p_secret text, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_rows jsonb;
BEGIN
  SELECT COALESCE(value::text, '') INTO v_want FROM public.site_settings WHERE key = 'notify.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT id, kind, title, body, link, payload, attempts, created_at
        FROM public.notify_outbox
       WHERE sent_at IS NULL AND attempts < 8 AND next_try_at <= now()
       ORDER BY created_at
       LIMIT v_limit
    ) t;

  UPDATE public.notify_outbox
     SET attempts = attempts + 1,
         next_try_at = now() + interval '3 minutes'
   WHERE id IN (SELECT (x->>'id')::bigint FROM jsonb_array_elements(v_rows) AS x);

  RETURN jsonb_build_object('ok', true, 'rows', v_rows);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.notify_outbox_claim(text, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_outbox_ack(p_secret text, p_id bigint, p_ok boolean, p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
BEGIN
  SELECT COALESCE(value::text, '') INTO v_want FROM public.site_settings WHERE key = 'notify.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  IF p_ok THEN
    UPDATE public.notify_outbox
       SET sent_at = now(), last_error = NULL, next_try_at = now()
     WHERE id = p_id;
  ELSE
    UPDATE public.notify_outbox
       SET last_error = left(COALESCE(p_error, 'unknown'), 300),
           next_try_at = now() + (least(attempts, 6) * interval '5 minutes')
     WHERE id = p_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.notify_outbox_ack(text, bigint, boolean, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_outbox_page(p_status text DEFAULT NULL, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_status text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_total int;
  v_rows jsonb;
  v_pending int;
  v_failed int;
  v_sent int;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  DROP TABLE IF EXISTS _ob;
  CREATE TEMP TABLE _ob ON COMMIT DROP AS
  SELECT o.id, o.kind, o.title, o.body, o.link, o.recipient_id, o.created_at,
         o.attempts, o.sent_at, o.last_error, o.next_try_at,
         CASE WHEN o.sent_at IS NOT NULL THEN 'sent'
              WHEN o.attempts >= 8 THEN 'failed'
              ELSE 'pending' END AS state
    FROM public.notify_outbox o
   WHERE v_status IS NULL OR (
           (v_status = 'sent' AND o.sent_at IS NOT NULL)
        OR (v_status = 'pending' AND o.sent_at IS NULL AND o.attempts < 8)
        OR (v_status = 'failed' AND o.sent_at IS NULL AND o.attempts >= 8)
         );

  SELECT count(*) INTO v_total FROM _ob;
  SELECT count(*) INTO v_pending FROM public.notify_outbox WHERE sent_at IS NULL AND attempts < 8;
  SELECT count(*) INTO v_failed  FROM public.notify_outbox WHERE sent_at IS NULL AND attempts >= 8;
  SELECT count(*) INTO v_sent    FROM public.notify_outbox WHERE sent_at IS NOT NULL;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM _ob ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'pending', v_pending, 'failed', v_failed, 'sent', v_sent,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_outbox_page(text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_outbox_retry(p_id bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_n int;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  IF p_id IS NULL THEN
    UPDATE public.notify_outbox
       SET attempts = 0, next_try_at = now(), last_error = NULL
     WHERE sent_at IS NULL;
  ELSE
    UPDATE public.notify_outbox
       SET attempts = 0, next_try_at = now(), last_error = NULL
     WHERE id = p_id AND sent_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM public.audit_log('outbox_retry', 'outbox', COALESCE(p_id::text, 'all'), NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'reset', v_n);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_outbox_retry(bigint) TO authenticated;

-- =====================================================================
-- 3. B2 批量操作
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_bulk(p_kind text, p_action text, p_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_kind   text := lower(btrim(COALESCE(p_kind, '')));
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_ids    bigint[];
  v_text_ids text[];
  v_n      int := 0;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF jsonb_typeof(p_ids) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_ids');
  END IF;

  IF v_kind <> 'users' THEN
    SELECT COALESCE(array_agg((x)::bigint), '{}'::bigint[]) INTO v_ids
      FROM jsonb_array_elements_text(p_ids) AS t(x)
     WHERE (x) ~ '^[0-9]+$';
    IF cardinality(v_ids) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_ids');
    END IF;
    IF cardinality(v_ids) > 200 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'too_many');
    END IF;
  END IF;

  IF v_kind = 'comments' THEN
    IF v_action = 'approve' THEN
      UPDATE public.comments SET status = 'visible' WHERE id = ANY(v_ids);
    ELSIF v_action = 'hide' THEN
      UPDATE public.comments SET status = 'hidden' WHERE id = ANY(v_ids);
    ELSIF v_action = 'spam' THEN
      UPDATE public.comments
         SET status = 'hidden',
             spam_score = GREATEST(spam_score, 9),
             spam_flags = (COALESCE(spam_flags, '{}') || ARRAY['manual'])::text[]
       WHERE id = ANY(v_ids);
    ELSIF v_action = 'ham' THEN
      UPDATE public.comments
         SET status = 'visible', spam_score = 0, spam_flags = NULL
       WHERE id = ANY(v_ids);
    ELSIF v_action = 'delete' THEN
      DELETE FROM public.comments WHERE id = ANY(v_ids);
    ELSE
      RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
    END IF;

  ELSIF v_kind = 'posts' THEN
    IF v_action = 'publish' THEN
      UPDATE public.cloud_posts
         SET status = CASE WHEN publish_at IS NOT NULL AND publish_at > now() THEN 'scheduled' ELSE 'published' END,
             published_at = COALESCE(published_at, publish_at, now()),
             updated_at = now()
       WHERE id = ANY(v_ids);
    ELSIF v_action = 'unpublish' THEN
      UPDATE public.cloud_posts SET status = 'draft', published_at = NULL, updated_at = now() WHERE id = ANY(v_ids);
    ELSIF v_action = 'pin' THEN
      UPDATE public.cloud_posts SET pinned = true, updated_at = now() WHERE id = ANY(v_ids);
    ELSIF v_action = 'unpin' THEN
      UPDATE public.cloud_posts SET pinned = false, updated_at = now() WHERE id = ANY(v_ids);
    ELSIF v_action = 'delete' THEN
      IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
      END IF;
      PERFORM public.require_totp_gate();
      DELETE FROM public.cloud_posts WHERE id = ANY(v_ids);
    ELSE
      RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    PERFORM public.audit_log('bulk_' || v_action, 'cloud_post', v_n::text, NULL, to_jsonb(v_ids));
    RETURN jsonb_build_object('ok', true, 'affected', v_n, 'kind', v_kind, 'action', v_action);

  ELSIF v_kind = 'reports' THEN
    IF v_action NOT IN ('resolve', 'dismiss') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
    END IF;
    UPDATE public.comment_reports
       SET status = CASE WHEN v_action = 'resolve' THEN 'resolved' ELSE 'dismissed' END,
           handled_by = auth.uid()::text, handled_at = now()
     WHERE id = ANY(v_ids) AND status = 'open';

  ELSIF v_kind = 'users' THEN
    -- 用户 id 是 uuid 文本，不能按数字解析；单独取一次
    IF NOT public.is_admin() THEN
      RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;
    PERFORM public.require_totp_gate();
    SELECT COALESCE(array_agg(x), '{}'::text[]) INTO v_text_ids
      FROM jsonb_array_elements_text(p_ids) AS t(x)
     WHERE btrim(x) <> '';
    IF cardinality(v_text_ids) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_ids');
    END IF;
    IF v_action = 'disable' THEN
      UPDATE public.profiles SET status = 'disabled', updated_at = now()
       WHERE owner_id = ANY(v_text_ids) AND owner_id <> auth.uid()::text;
    ELSIF v_action = 'enable' THEN
      UPDATE public.profiles SET status = 'active', updated_at = now()
       WHERE owner_id = ANY(v_text_ids);
    ELSE
      RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
    END IF;

  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'bad_kind');
  END IF;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_kind <> 'posts' THEN
    PERFORM public.audit_log('bulk_' || v_action, v_kind, v_n::text, NULL, to_jsonb(v_ids));
  END IF;

  RETURN jsonb_build_object('ok', true, 'affected', v_n, 'kind', v_kind, 'action', v_action);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_bulk(text, text, jsonb) TO authenticated;

-- =====================================================================
-- 4. B5 数据导出与备份
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.backup_snapshots (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  format     text NOT NULL DEFAULT 'json',
  path       text,
  url        text,
  size       bigint,
  row_counts jsonb,
  note       text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.backup_snapshots ENABLE ROW LEVEL SECURITY;
-- 无策略：管理员经 SECURITY DEFINER 函数读写

CREATE OR REPLACE FUNCTION public.admin_export(p_kind text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_kind text := lower(btrim(COALESCE(p_kind, 'all')));
  v_cap  int := 5000;
  v      jsonb := '{}'::jsonb;
  v_n    jsonb := '{}'::jsonb;
  v_tmp  jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  IF v_kind IN ('posts', 'all') THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT id, slug, title, summary, content_md, tags, status, author_id,
                   created_at, updated_at, published_at, publish_at, pinned, weight,
                   reviewed_by, reviewed_at, review_note, edit_title, edit_summary,
                   edit_content_md, edit_tags, edit_submitted_at, edit_review_note, series
              FROM public.cloud_posts ORDER BY id LIMIT v_cap) t;
    v := v || jsonb_build_object('posts', v_tmp);
    v_n := v_n || jsonb_build_object('posts', jsonb_array_length(v_tmp));
  END IF;

  IF v_kind IN ('comments', 'all') THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT id, post_slug, owner_id, author_name, content, status, created_at,
                   parent_id, flag_reason, edited_at, spam_score, spam_flags
              FROM public.comments ORDER BY id LIMIT v_cap) t;
    v := v || jsonb_build_object('comments', v_tmp);
    v_n := v_n || jsonb_build_object('comments', jsonb_array_length(v_tmp));
  END IF;

  IF v_kind IN ('users', 'all') THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT p.owner_id, p.nickname, p.avatar_url, p.bio, p.status,
                   p.can_publish, p.is_editor, p.created_at, p.email_verified_at,
                   (SELECT lower(a.email) FROM public.admin_emails a WHERE lower(a.email) = lower(au.email::text)) AS admin_email
              FROM public.profiles p
              LEFT JOIN auth.users au ON au.id::text = p.owner_id
             ORDER BY p.created_at LIMIT v_cap) t;
    v := v || jsonb_build_object('profiles', v_tmp);
    v_n := v_n || jsonb_build_object('profiles', jsonb_array_length(v_tmp));

    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT email, note, created_at FROM public.admin_emails ORDER BY created_at LIMIT v_cap) t;
    v := v || jsonb_build_object('admin_emails', v_tmp);
    v_n := v_n || jsonb_build_object('admin_emails', jsonb_array_length(v_tmp));
  END IF;

  IF v_kind IN ('interactions', 'all') THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT post_slug, owner_id, created_at, folder, is_private FROM public.post_bookmarks ORDER BY created_at LIMIT v_cap) t;
    v := v || jsonb_build_object('bookmarks', v_tmp);

    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT post_slug, owner_id, created_at FROM public.post_likes ORDER BY created_at LIMIT v_cap) t;
    v := v || jsonb_build_object('likes', v_tmp);

    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT post_slug, views, updated_at FROM public.post_views ORDER BY post_slug LIMIT v_cap) t;
    v := v || jsonb_build_object('views', v_tmp);

    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT post_slug, owner_id, title, percent, created_at, updated_at FROM public.reading_history ORDER BY updated_at DESC LIMIT v_cap) t;
    v := v || jsonb_build_object('reading_history', v_tmp);

    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT email, lang, status, source, created_at, confirmed_at, unsubscribed_at FROM public.subscribers ORDER BY created_at LIMIT v_cap) t;
    v := v || jsonb_build_object('subscribers', v_tmp);

    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT email, note, created_at FROM public.comment_banned_words ORDER BY created_at LIMIT v_cap) t;
    v := v || jsonb_build_object('banned_words', v_tmp);
  END IF;

  IF v_kind IN ('admin', 'all') THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT id, actor_id, actor_email, action, target_type, target_id, note, payload, created_at
              FROM public.admin_audit_log ORDER BY id DESC LIMIT v_cap) t;
    v := v || jsonb_build_object('audit_log', v_tmp);

    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tmp
      FROM (SELECT key, value, is_public, updated_at FROM public.site_settings ORDER BY key) t;
    v := v || jsonb_build_object('settings', v_tmp);
  END IF;

  IF v = '{}'::jsonb THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_kind');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'kind', v_kind,
    'generated_at', now(),
    'counts', v_n,
    'data', v
  );
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_export(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_backup_record(
  p_kind text, p_path text, p_url text, p_size bigint, p_row_counts jsonb, p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_id bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_path IS NULL OR btrim(p_path) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
  END IF;

  INSERT INTO public.backup_snapshots (kind, format, path, url, size, row_counts, note, created_by)
  VALUES (left(COALESCE(p_kind, 'all'), 40), 'json', btrim(p_path), p_url,
          COALESCE(p_size, 0), COALESCE(p_row_counts, '{}'::jsonb),
          NULLIF(left(btrim(COALESCE(p_note, '')), 200), ''), auth.uid()::text)
  RETURNING id INTO v_id;

  PERFORM public.audit_log('backup_create', 'backup', v_id::text, NULL,
                           jsonb_build_object('kind', p_kind, 'path', p_path, 'size', p_size));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_backup_record(text, text, text, bigint, jsonb, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_backups_page(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_total int;
  v_rows jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT count(*) INTO v_total FROM public.backup_snapshots;
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM public.backup_snapshots ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_backups_page(integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_backup_delete(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_path text;
  v_n int;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  PERFORM public.require_totp_gate();

  DELETE FROM public.backup_snapshots WHERE id = p_id RETURNING path INTO v_path;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  PERFORM public.audit_log('backup_delete', 'backup', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'path', v_path);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_backup_delete(bigint) TO authenticated;

-- =====================================================================
-- 5. B7 媒体库
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.media_assets (
  id         bigserial PRIMARY KEY,
  path       text NOT NULL UNIQUE,
  url        text NOT NULL,
  name       text,
  mime       text,
  size       bigint,
  folder     text,
  owner_id   text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS media_assets_folder_idx ON public.media_assets (folder, created_at DESC);

CREATE OR REPLACE FUNCTION public.media_register(
  p_path text, p_url text, p_name text DEFAULT NULL, p_mime text DEFAULT NULL,
  p_size bigint DEFAULT NULL, p_folder text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_id  bigint;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  IF NOT public.is_active() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inactive');
  END IF;
  IF p_path IS NULL OR btrim(p_path) = '' OR p_url IS NULL OR btrim(p_url) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
  END IF;

  INSERT INTO public.media_assets (path, url, name, mime, size, folder, owner_id)
  VALUES (btrim(p_path), btrim(p_url), left(COALESCE(p_name, ''), 200), left(COALESCE(p_mime, ''), 80),
          p_size, NULLIF(left(btrim(COALESCE(p_folder, '')), 60), ''), v_uid)
  ON CONFLICT (path) DO UPDATE
    SET url = EXCLUDED.url, name = EXCLUDED.name, mime = EXCLUDED.mime,
        size = EXCLUDED.size, folder = EXCLUDED.folder
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END
$function$;

GRANT EXECUTE ON FUNCTION public.media_register(text, text, text, text, bigint, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.media_page(p_search text DEFAULT NULL, p_folder text DEFAULT NULL,
                                             p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 24), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_folder text := NULLIF(btrim(COALESCE(p_folder, '')), '');
  v_uid text := auth.uid()::text;
  v_total int;
  v_rows jsonb;
  v_size bigint;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  DROP TABLE IF EXISTS _md;
  CREATE TEMP TABLE _md ON COMMIT DROP AS
  SELECT m.id, m.path, m.url, m.name, m.mime, m.size, m.folder, m.owner_id, m.created_at,
         COALESCE(NULLIF(btrim(p.nickname), ''), '读者') AS owner_name
    FROM public.media_assets m
    LEFT JOIN public.profiles p ON p.owner_id = m.owner_id
   WHERE (v_search IS NULL OR m.name ILIKE '%' || v_search || '%' OR m.path ILIKE '%' || v_search || '%'
                            OR m.url ILIKE '%' || v_search || '%')
     AND (v_folder IS NULL OR m.folder = v_folder);

  SELECT count(*), COALESCE(sum(size), 0) INTO v_total, v_size FROM _md;
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM _md ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'total_size', v_size, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

GRANT EXECUTE ON FUNCTION public.media_page(text, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.media_folders()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('folder', f.folder, 'count', f.n) ORDER BY f.n DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT COALESCE(folder, '(未分组)') AS folder, count(*) AS n
        FROM public.media_assets GROUP BY COALESCE(folder, '(未分组)')
    ) f;
  RETURN jsonb_build_object('ok', true, 'rows', v_rows);
END
$function$;

GRANT EXECUTE ON FUNCTION public.media_folders() TO authenticated;

CREATE OR REPLACE FUNCTION public.media_delete(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_row public.media_assets;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  SELECT * INTO v_row FROM public.media_assets WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.owner_id <> v_uid AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  DELETE FROM public.media_assets WHERE id = p_id;
  PERFORM public.audit_log('media_delete', 'media', p_id::text, NULL,
                           jsonb_build_object('path', v_row.path, 'size', v_row.size));
  -- 返回存储路径，客户端据此删除对象；删不掉也不影响记录一致性
  RETURN jsonb_build_object('ok', true, 'path', v_row.path, 'url', v_row.url);
END
$function$;

GRANT EXECUTE ON FUNCTION public.media_delete(bigint) TO authenticated;

-- =====================================================================
-- 6. B8 置顶 / 排序权重 / 定时发布（管理员改任意云文章）
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_set_post_flags(
  p_slug text, p_pinned boolean DEFAULT NULL, p_weight integer DEFAULT NULL, p_publish_at text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_row public.cloud_posts;
  v_at  timestamptz;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = btrim(COALESCE(p_slug, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF p_publish_at IS NULL THEN
    v_at := v_row.publish_at;
  ELSIF btrim(p_publish_at) = '' THEN
    v_at := NULL;
  ELSE
    BEGIN
      v_at := btrim(p_publish_at)::timestamptz;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_time');
    END;
  END IF;

  UPDATE public.cloud_posts
     SET pinned = COALESCE(p_pinned, pinned),
         weight = COALESCE(LEAST(GREATEST(p_weight, -1000), 1000), weight),
         publish_at = v_at,
         status = CASE
                    WHEN status IN ('published', 'scheduled') AND v_at IS NOT NULL AND v_at > now() THEN 'scheduled'
                    WHEN status = 'scheduled' AND (v_at IS NULL OR v_at <= now()) THEN 'published'
                    ELSE status
                  END,
         published_at = CASE
                          WHEN status = 'scheduled' AND (v_at IS NULL OR v_at <= now()) THEN COALESCE(v_at, published_at, now())
                          ELSE published_at
                        END,
         updated_at = now()
   WHERE id = v_row.id;

  PERFORM public.audit_log('post_flags', 'cloud_post', v_row.slug, NULL,
                           jsonb_build_object('pinned', p_pinned, 'weight', p_weight, 'publish_at', p_publish_at));
  RETURN jsonb_build_object('ok', true, 'slug', v_row.slug, 'publish_at', v_at);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_set_post_flags(text, boolean, integer, text) TO authenticated;

-- =====================================================================
-- 7. B9 统计趋势
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_stats_trend(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_days int := LEAST(GREATEST(COALESCE(p_days, 30), 7), 180);
  v_rows jsonb;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.day), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT d.day::date AS day,
             COALESCE(c.n, 0)  AS comments,
             COALESCE(p.n, 0)  AS posts,
             COALESCE(v.n, 0)  AS views,
             COALESCE(u.n, 0)  AS users
        FROM generate_series(current_date - (v_days - 1), current_date, interval '1 day') AS d(day)
        LEFT JOIN (SELECT created_at::date AS day, count(*) AS n FROM public.comments
                    WHERE created_at >= current_date - (v_days - 1) GROUP BY 1) c ON c.day = d.day::date
        LEFT JOIN (SELECT COALESCE(published_at, created_at)::date AS day, count(*) AS n FROM public.cloud_posts
                    WHERE COALESCE(published_at, created_at) >= current_date - (v_days - 1) GROUP BY 1) p ON p.day = d.day::date
        LEFT JOIN (SELECT day, count(*) AS n FROM public.page_views_log
                    WHERE day >= current_date - (v_days - 1) AND NOT is_bot GROUP BY 1) v ON v.day = d.day::date
        LEFT JOIN (SELECT created_at::date AS day, count(*) AS n FROM public.profiles
                    WHERE created_at >= current_date - (v_days - 1) GROUP BY 1) u ON u.day = d.day::date
    ) t;

  RETURN jsonb_build_object('ok', true, 'days', v_days, 'rows', v_rows);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_stats_trend(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_top_posts(p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_rows jsonb;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT s.post_slug, s.views, s.likes, s.comments, s.bookmarks,
             COALESCE((SELECT COALESCE(NULLIF(btrim(c.title), ''), c.slug) FROM public.cloud_posts c WHERE c.slug = s.post_slug LIMIT 1), s.post_slug) AS title
        FROM public.post_stats_public s
       ORDER BY s.views DESC, s.comments DESC
       LIMIT v_limit
    ) t;

  RETURN jsonb_build_object('ok', true, 'rows', v_rows);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_top_posts(integer) TO authenticated;

-- =====================================================================
-- 8. B10 访问分析
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.page_views_log (
  id            bigserial PRIMARY KEY,
  day           date NOT NULL DEFAULT current_date,
  path          text NOT NULL,
  referrer_host text,
  ua_family     text,
  is_bot        boolean NOT NULL DEFAULT false,
  session_hash  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.page_views_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS page_views_log_day_idx ON public.page_views_log (day);
CREATE INDEX IF NOT EXISTS page_views_log_session_idx ON public.page_views_log (session_hash, path, created_at DESC);

CREATE OR REPLACE FUNCTION public.ua_family(p_ua text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN COALESCE(btrim(p_ua), '') = '' THEN ''
    WHEN p_ua ~* 'bot|spider|crawler|slurp|curl|wget|python-requests|headless|facebookexternalhit|feedfetcher|preview' THEN 'Bot'
    WHEN p_ua ~* 'micromessenger' THEN 'WeChat'
    WHEN p_ua ~* 'edg/' THEN 'Edge'
    WHEN p_ua ~* 'opr/|opera' THEN 'Opera'
    WHEN p_ua ~* 'firefox/' THEN 'Firefox'
    WHEN p_ua ~* 'chrome/|crios' THEN 'Chrome'
    WHEN p_ua ~* 'safari/' THEN 'Safari'
    ELSE 'Other'
  END
$function$;

CREATE OR REPLACE FUNCTION public.page_view_log(p_path text, p_referrer text DEFAULT NULL,
                                                p_ua text DEFAULT NULL, p_session text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_path text := left(btrim(COALESCE(p_path, '')), 200);
  v_ref  text;
  v_ua   text := left(COALESCE(p_ua, ''), 300);
  v_fam  text;
  v_sess text := left(btrim(COALESCE(p_session, '')), 80);
BEGIN
  IF v_path = '' OR v_path !~ '^/' THEN
    RETURN false;
  END IF;

  v_ref := left(
    COALESCE(NULLIF(regexp_replace(COALESCE(p_referrer, ''), '^[a-zA-Z]+://([^/]+).*$', '\1'), ''), ''),
    120);
  v_fam := public.ua_family(v_ua);

  -- 同一会话 + 同一路径 30 分钟内只记一次，避免刷新灌水
  IF v_sess <> '' AND EXISTS (
       SELECT 1 FROM public.page_views_log l
        WHERE l.session_hash = v_sess AND l.path = v_path
          AND l.created_at >= now() - interval '30 minutes') THEN
    RETURN false;
  END IF;

  INSERT INTO public.page_views_log (day, path, referrer_host, ua_family, is_bot, session_hash)
  VALUES (current_date, v_path, NULLIF(v_ref, ''), v_fam, (v_fam = 'Bot'), v_sess);

  -- 低概率清理：保留一年
  IF random() < 0.01 THEN
    DELETE FROM public.page_views_log WHERE created_at < now() - interval '365 days';
  END IF;

  RETURN true;
END
$function$;

GRANT EXECUTE ON FUNCTION public.page_view_log(text, text, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_analytics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_days int := LEAST(GREATEST(COALESCE(p_days, 30), 7), 180);
  v_from date := current_date - (v_days - 1);
  v_series jsonb;
  v_paths jsonb;
  v_refs jsonb;
  v_uas jsonb;
  v_pv bigint;
  v_uv bigint;
  v_bot bigint;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT count(*) INTO v_pv FROM public.page_views_log WHERE day >= v_from;
  SELECT count(DISTINCT session_hash) INTO v_uv
    FROM public.page_views_log WHERE day >= v_from AND COALESCE(session_hash, '') <> '';
  SELECT count(*) INTO v_bot FROM public.page_views_log WHERE day >= v_from AND is_bot;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.day), '[]'::jsonb) INTO v_series
    FROM (
      SELECT d.day::date AS day,
             COALESCE(x.pv, 0) AS pv,
             COALESCE(x.uv, 0) AS uv
        FROM generate_series(v_from, current_date, interval '1 day') AS d(day)
        LEFT JOIN (
          SELECT day, count(*) AS pv, count(DISTINCT session_hash) AS uv
            FROM public.page_views_log
           WHERE day >= v_from AND NOT is_bot
           GROUP BY day
        ) x ON x.day = d.day::date
    ) t;

  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_paths
    FROM (
      SELECT path, count(*) AS pv, count(DISTINCT session_hash) AS uv
        FROM public.page_views_log
       WHERE day >= v_from AND NOT is_bot
       GROUP BY path ORDER BY pv DESC LIMIT 15
    ) t;

  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_refs
    FROM (
      SELECT COALESCE(NULLIF(referrer_host, ''), '(直接访问)') AS host, count(*) AS n
        FROM public.page_views_log
       WHERE day >= v_from AND NOT is_bot
       GROUP BY 1 ORDER BY n DESC LIMIT 10
    ) t;

  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_uas
    FROM (
      SELECT COALESCE(NULLIF(ua_family, ''), '(未知)') AS family, count(*) AS n
        FROM public.page_views_log
       WHERE day >= v_from AND NOT is_bot
       GROUP BY 1 ORDER BY n DESC LIMIT 10
    ) t;

  RETURN jsonb_build_object(
    'ok', true, 'days', v_days,
    'total_pv', v_pv, 'total_uv', v_uv, 'bot_pv', v_bot,
    'series', v_series, 'paths', v_paths, 'referrers', v_refs, 'uas', v_uas
  );
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_analytics(integer) TO authenticated;

-- =====================================================================
-- 9. B12 审计日志：筛选 / 分页 / 导出
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_audit_page(
  p_search text DEFAULT NULL, p_action text DEFAULT NULL, p_actor text DEFAULT NULL,
  p_from text DEFAULT NULL, p_to text DEFAULT NULL,
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit  int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_action text := NULLIF(btrim(COALESCE(p_action, '')), '');
  v_actor  text := NULLIF(btrim(COALESCE(p_actor, '')), '');
  v_from   timestamptz;
  v_to     timestamptz;
  v_total  int;
  v_rows   jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  BEGIN
    v_from := NULLIF(btrim(COALESCE(p_from, '')), '')::timestamptz;
  EXCEPTION WHEN others THEN v_from := NULL; END;
  BEGIN
    v_to := NULLIF(btrim(COALESCE(p_to, '')), '')::timestamptz;
  EXCEPTION WHEN others THEN v_to := NULL; END;

  DROP TABLE IF EXISTS _al;
  CREATE TEMP TABLE _al ON COMMIT DROP AS
  SELECT l.id, l.actor_id, l.actor_email, l.action, l.target_type, l.target_id,
         l.note, l.payload, l.created_at
    FROM public.admin_audit_log l
   WHERE (v_action IS NULL OR l.action = v_action)
     AND (v_actor IS NULL OR l.actor_id = v_actor OR lower(COALESCE(l.actor_email, '')) = lower(v_actor))
     AND (v_from IS NULL OR l.created_at >= v_from)
     AND (v_to IS NULL OR l.created_at < v_to + interval '1 day')
     AND (v_search IS NULL
          OR COALESCE(l.actor_email, '') ILIKE '%' || v_search || '%'
          OR COALESCE(l.action, '') ILIKE '%' || v_search || '%'
          OR COALESCE(l.note, '') ILIKE '%' || v_search || '%'
          OR COALESCE(l.target_id, '') ILIKE '%' || v_search || '%');

  SELECT count(*) INTO v_total FROM _al;
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM _al ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_audit_page(text, text, text, text, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_audit_actions()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT CASE WHEN public.is_admin() THEN
    COALESCE((SELECT jsonb_agg(t.a ORDER BY t.c DESC)
                FROM (SELECT action AS a, count(*) AS c FROM public.admin_audit_log
                       GROUP BY action ORDER BY count(*) DESC LIMIT 60) t), '[]'::jsonb)
  ELSE '[]'::jsonb END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_audit_actions() TO authenticated;

-- =====================================================================
-- 10. B13 二次验证（TOTP）
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.user_totp (
  owner_id         text PRIMARY KEY,
  secret           text NOT NULL,
  enabled_at       timestamptz,
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_totp ENABLE ROW LEVEL SECURITY;
-- 无策略：只能经下面的函数读写，secret 永远不回传（只回传一次用于绑定）

-- base32（RFC4648，无填充）编解码：authenticator 用 base32，这里自己实现
CREATE OR REPLACE FUNCTION public.b32_encode(p_bytes bytea)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_alpha text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_bits  text := '';
  v_i     int;
  v_out   text := '';
BEGIN
  FOR v_i IN 0 .. length(p_bytes) - 1 LOOP
    v_bits := v_bits || lpad(get_byte(p_bytes, v_i)::bit(8)::text, 8, '0');
  END LOOP;
  WHILE char_length(v_bits) >= 5 LOOP
    v_out := v_out || substr(v_alpha, (substr(v_bits, 1, 5))::bit(5)::int + 1, 1);
    v_bits := substr(v_bits, 6);
  END LOOP;
  IF char_length(v_bits) > 0 THEN
    v_out := v_out || substr(v_alpha, (lpad(v_bits, 5, '0'))::bit(5)::int + 1, 1);
  END IF;
  RETURN v_out;
END
$function$;

CREATE OR REPLACE FUNCTION public.b32_decode(p_text text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_alpha text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_s     text := upper(regexp_replace(COALESCE(p_text, ''), '[^A-Za-z2-7]', '', 'g'));
  v_bits  text := '';
  v_i     int;
  v_idx   int;
  v_out   bytea := ''::bytea;
BEGIN
  FOR v_i IN 1 .. char_length(v_s) LOOP
    v_idx := position(substr(v_s, v_i, 1) IN v_alpha) - 1;
    EXIT WHEN v_idx < 0;
    v_bits := v_bits || lpad(v_idx::bit(5)::text, 5, '0');
  END LOOP;
  WHILE char_length(v_bits) >= 8 LOOP
    v_out := v_out || set_byte('00'::bytea, 0, (substr(v_bits, 1, 8))::bit(8)::int);
    v_bits := substr(v_bits, 9);
  END LOOP;
  RETURN v_out;
END
$function$;

CREATE OR REPLACE FUNCTION public.totp_code(p_secret text, p_step bigint)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_key bytea := public.b32_decode(p_secret);
  v_msg bytea := decode(lpad(to_hex(p_step), 16, '0'), 'hex');
  v_hash bytea;
  v_off int;
  v_bin bigint;
BEGIN
  IF v_key IS NULL OR length(v_key) = 0 THEN
    RETURN '';
  END IF;
  v_hash := hmac(v_msg, v_key, 'sha1');
  v_off := get_byte(v_hash, 19) & 15;
  v_bin := ((get_byte(v_hash, v_off) & 127)::bigint << 24)
         | (get_byte(v_hash, v_off + 1)::bigint << 16)
         | (get_byte(v_hash, v_off + 2)::bigint << 8)
         | (get_byte(v_hash, v_off + 3)::bigint);
  RETURN lpad((v_bin % 1000000)::text, 6, '0');
END
$function$;

CREATE OR REPLACE FUNCTION public.totp_check(p_secret text, p_code text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_step bigint := floor(extract(epoch FROM now()) / 30)::bigint;
  v_want text := regexp_replace(COALESCE(p_code, ''), '[^0-9]', '', 'g');
  v_i    int;
BEGIN
  IF char_length(v_want) <> 6 THEN
    RETURN false;
  END IF;
  FOR v_i IN -1 .. 1 LOOP
    IF public.totp_code(p_secret, v_step + v_i) = v_want THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION public.require_totp_gate()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_en  timestamptz;
  v_last timestamptz;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN;
  END IF;
  SELECT enabled_at, last_verified_at INTO v_en, v_last
    FROM public.user_totp WHERE owner_id = v_uid AND enabled_at IS NOT NULL;
  IF v_en IS NULL THEN
    RETURN;
  END IF;
  IF v_last IS NULL OR v_last < now() - interval '15 minutes' THEN
    RAISE EXCEPTION '该操作需要二次验证，请先在「安全」里输入动态验证码。'
      USING ERRCODE = 'P0001', HINT = 'TOTP_REQUIRED';
  END IF;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.require_totp_gate() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.totp_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_row public.user_totp;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  SELECT * INTO v_row FROM public.user_totp WHERE owner_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'enabled', false);
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'enabled', v_row.enabled_at IS NOT NULL,
    'enabled_at', v_row.enabled_at,
    'last_verified_at', v_row.last_verified_at,
    'gate_fresh', (v_row.last_verified_at IS NOT NULL AND v_row.last_verified_at > now() - interval '15 minutes'),
    'pending', (v_row.enabled_at IS NULL)
  );
END
$function$;

GRANT EXECUTE ON FUNCTION public.totp_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.totp_begin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid    text := auth.uid()::text;
  v_secret text;
  v_email  text;
  v_uri    text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_totp WHERE owner_id = v_uid AND enabled_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_enabled');
  END IF;

  v_secret := public.b32_encode(gen_random_bytes(20));

  INSERT INTO public.user_totp (owner_id, secret, enabled_at, last_verified_at)
  VALUES (v_uid, v_secret, NULL, NULL)
  ON CONFLICT (owner_id) DO UPDATE SET secret = EXCLUDED.secret, enabled_at = NULL, last_verified_at = NULL;

  SELECT COALESCE(u.email::text, v_uid) INTO v_email FROM auth.users u WHERE u.id::text = v_uid;
  v_uri := 'otpauth://totp/' || public.url_encode('WS Blog:' || v_email)
        || '?secret=' || v_secret
        || '&issuer=' || public.url_encode('WS Blog')
        || '&algorithm=SHA1&digits=6&period=30';

  RETURN jsonb_build_object('ok', true, 'secret', v_secret, 'uri', v_uri, 'account', v_email);
END
$function$;

GRANT EXECUTE ON FUNCTION public.totp_begin() TO authenticated;

CREATE OR REPLACE FUNCTION public.url_encode(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(string_agg(
           CASE WHEN substr(p_text, i, 1) ~ '[A-Za-z0-9\-_.~]' THEN substr(p_text, i, 1)
                ELSE '%' || upper(lpad(to_hex(ascii(substr(p_text, i, 1))), 2, '0')) END,
           '' ORDER BY i), '')
    FROM generate_series(1, char_length(COALESCE(p_text, ''))) AS i
$function$;

CREATE OR REPLACE FUNCTION public.totp_enable(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_row public.user_totp;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  SELECT * INTO v_row FROM public.user_totp WHERE owner_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_started');
  END IF;

  IF NOT public.totp_check(v_row.secret, p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_code');
  END IF;

  UPDATE public.user_totp
     SET enabled_at = now(), last_verified_at = now()
   WHERE owner_id = v_uid;

  PERFORM public.audit_log('totp_enable', 'profile', v_uid, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'enabled', true);
END
$function$;

GRANT EXECUTE ON FUNCTION public.totp_enable(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.totp_gate(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_uid text := auth.uid()::text;
  v_row public.user_totp;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;
  SELECT * INTO v_row FROM public.user_totp WHERE owner_id = v_uid AND enabled_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'gate_fresh', true, 'note', 'not_enabled');
  END IF;
  IF NOT public.totp_check(v_row.secret, p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_code');
  END IF;
  UPDATE public.user_totp SET last_verified_at = now() WHERE owner_id = v_uid;
  RETURN jsonb_build_object('ok', true, 'gate_fresh', true);
END
$function$;

GRANT EXECUTE ON FUNCTION public.totp_gate(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.totp_disable()
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
  DELETE FROM public.user_totp WHERE owner_id = v_uid;
  PERFORM public.audit_log('totp_disable', 'profile', v_uid, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'enabled', false);
END
$function$;

GRANT EXECUTE ON FUNCTION public.totp_disable() TO authenticated;

-- 站长救援通道：另一名管理员可帮他解绑（避免丢手机被永久锁在门外）
CREATE OR REPLACE FUNCTION public.admin_disable_totp(p_owner text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_n int;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  DELETE FROM public.user_totp WHERE owner_id = btrim(COALESCE(p_owner, ''));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM public.audit_log('totp_reset_by_admin', 'profile', p_owner, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'removed', v_n);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_disable_totp(text) TO authenticated;

-- =====================================================================
-- 11. B14 健康检查
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT jsonb_build_object(
    'ok', true,
    'checked_at', now(),
    'db', jsonb_build_object(
      'size_bytes', pg_database_size(current_database()),
      'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'),
      'views', (SELECT count(*) FROM information_schema.views WHERE table_schema = 'public'),
      'functions', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
    ),
    'rows', jsonb_build_object(
      'posts_total', (SELECT count(*) FROM public.cloud_posts),
      'posts_published', (SELECT count(*) FROM public.cloud_posts WHERE status = 'published'),
      'posts_draft', (SELECT count(*) FROM public.cloud_posts WHERE status = 'draft'),
      'posts_pending', (SELECT count(*) FROM public.cloud_posts WHERE status = 'pending'),
      'comments_total', (SELECT count(*) FROM public.comments),
      'comments_pending', (SELECT count(*) FROM public.comments WHERE status = 'pending'),
      'comments_spam', (SELECT count(*) FROM public.comments WHERE spam_score > 0),
      'users_total', (SELECT count(*) FROM public.profiles),
      'users_disabled', (SELECT count(*) FROM public.profiles WHERE status = 'disabled'),
      'subscribers_confirmed', (SELECT count(*) FROM public.subscribers WHERE confirmed_at IS NOT NULL),
      'banned_words', (SELECT count(*) FROM public.comment_banned_words),
      'media_assets', (SELECT count(*) FROM public.media_assets),
      'media_bytes', (SELECT COALESCE(sum(size), 0) FROM public.media_assets),
      'previews_active', (SELECT count(*) FROM public.post_previews WHERE NOT revoked AND expires_at > now()),
      'audit_rows', (SELECT count(*) FROM public.admin_audit_log)
    ),
    'attention', jsonb_build_object(
      'scheduled_due', (SELECT count(*) FROM public.cloud_posts WHERE status = 'scheduled' AND publish_at <= now()),
      'scheduled_upcoming', (SELECT count(*) FROM public.cloud_posts WHERE status = 'scheduled' AND publish_at > now()),
      'outbox_pending', (SELECT count(*) FROM public.notify_outbox WHERE sent_at IS NULL AND attempts < 8),
      'outbox_failed', (SELECT count(*) FROM public.notify_outbox WHERE sent_at IS NULL AND attempts >= 8),
      'reports_open', (SELECT count(*) FROM public.comment_reports WHERE status = 'open'),
      'email_requests', (SELECT count(*) FROM public.profiles WHERE COALESCE(pending_email, '') <> ''),
      'expired_previews', (SELECT count(*) FROM public.post_previews WHERE expires_at <= now())
    ),
    'latest', jsonb_build_object(
      'audit', (SELECT to_jsonb(t) FROM (SELECT action, actor_email, created_at FROM public.admin_audit_log ORDER BY id DESC LIMIT 1) t),
      'comment', (SELECT to_jsonb(t) FROM (SELECT author_name, created_at FROM public.comments ORDER BY id DESC LIMIT 1) t),
      'post', (SELECT to_jsonb(t) FROM (SELECT title, created_at FROM public.cloud_posts ORDER BY id DESC LIMIT 1) t)
    ),
    'config', jsonb_build_object(
      'notify_enabled', COALESCE((SELECT (value)::text::boolean FROM public.site_settings WHERE key = 'notify.enabled'), false),
      'webhook_set', COALESCE((SELECT NULLIF(btrim(value::text, '"'), '') FROM public.site_settings WHERE key = 'notify.webhook_url') IS NOT NULL, false),
      'worker_secret_set', COALESCE((SELECT NULLIF(btrim(value::text, '"'), '') FROM public.site_settings WHERE key = 'notify.worker_secret') IS NOT NULL, false),
      'maintenance', COALESCE((SELECT (value->>'active')::boolean FROM public.site_settings WHERE key = 'banner.maintenance'), false),
      'announcement', COALESCE((SELECT (value->>'active')::boolean FROM public.site_settings WHERE key = 'banner.announcement'), false)
    )
  ) INTO v;

  RETURN v;
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_health() TO authenticated;

-- =====================================================================
-- 12. B17 反垃圾：评论打点 + 评分 + 专用队列
-- =====================================================================
CREATE OR REPLACE FUNCTION public.spam_setting_int(p_key text, p_default integer)
RETURNS integer
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v text;
BEGIN
  SELECT NULLIF(btrim(value::text, '"'), '') INTO v FROM public.site_settings WHERE key = p_key;
  IF v IS NULL THEN
    SELECT NULLIF((public.settings_defaults()->p_key->'value')::text, '') INTO v;
  END IF;
  BEGIN
    RETURN COALESCE(v::int, p_default);
  EXCEPTION WHEN others THEN
    RETURN p_default;
  END;
END
$function$;

CREATE OR REPLACE FUNCTION public.spam_setting_text(p_key text, p_default text)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v text;
BEGIN
  SELECT NULLIF(btrim(value::text, '"'), '') INTO v FROM public.site_settings WHERE key = p_key;
  IF v IS NULL THEN
    v := NULLIF(btrim((public.settings_defaults()->p_key->'value')::text, '"'), '');
  END IF;
  RETURN COALESCE(v, p_default);
END
$function$;

CREATE OR REPLACE FUNCTION public.request_header(p_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_raw text;
  v_hdr jsonb;
BEGIN
  v_raw := NULLIF(current_setting('request.headers', true), '');
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_hdr := v_raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  RETURN left(COALESCE(v_hdr->>lower(p_name), ''), 300);
END
$function$;

CREATE OR REPLACE FUNCTION public.comment_take_ip_ua()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_ip   text;
  v_ua   text;
  v_salt text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  v_ip := split_part(COALESCE(public.request_header('x-forwarded-for'), ''), ',', 1);
  v_ua := COALESCE(public.request_header('user-agent'), '');

  v_salt := public.spam_setting_text('security.ip_salt', 'wsblog');
  IF btrim(v_ip) <> '' THEN
    NEW.ip_hash := encode(digest(btrim(v_ip) || '|' || v_salt, 'sha256'), 'hex');
  END IF;
  NEW.ua_family := public.ua_family(v_ua);

  RETURN NEW;
END
$function$;

-- ⚠️ 同一时机（BEFORE INSERT）有多个触发器时，PostgreSQL 按**触发器名字母序**执行：
--    comments_ip_ua_trg 先于 comments_stamp_author_trg —— 评分逻辑依赖这个顺序（要先有 ua_family）。
--    以后新增 BEFORE INSERT 触发器时，名字必须排在 comments_stamp_author_trg 之后。
DROP TRIGGER IF EXISTS comments_ip_ua_trg ON public.comments;
CREATE TRIGGER comments_ip_ua_trg
  BEFORE INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.comment_take_ip_ua();

CREATE OR REPLACE FUNCTION public.admin_spam_page(p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_total int;
  v_rows jsonb;
  v_hold int := public.spam_setting_int('comment.hold_score', 4);
  v_hide int := public.spam_setting_int('comment.auto_hide_score', 7);
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT count(*) INTO v_total FROM public.comments WHERE spam_score > 0;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.spam_score DESC, t.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT c.id, c.post_slug, c.author_name, c.owner_id, c.content, c.status,
             c.spam_score, c.spam_flags, c.ua_family, left(COALESCE(c.ip_hash, ''), 12) AS ip_hint,
             c.created_at,
             (SELECT count(*) FROM public.comments x WHERE x.ip_hash = c.ip_hash AND c.ip_hash IS NOT NULL) AS same_ip
        FROM public.comments c
       WHERE c.spam_score > 0
       ORDER BY c.spam_score DESC, c.created_at DESC
       LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'hold_score', v_hold, 'auto_hide_score', v_hide,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_spam_page(integer, integer) TO authenticated;

-- =====================================================================
-- 13. 改写既有函数：放行编辑角色 + 支持定时发布 / 置顶权重 / 反垃圾字段
-- =====================================================================

-- 13.1 文章状态通知：补「定时未到点」与「定时到点上线」
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

  IF NEW.author_id IS NOT NULL AND NEW.author_id <> v_actor THEN
    IF NEW.status = 'published' THEN
      PERFORM public.notify_push(
        NEW.author_id, 'post_approved',
        '投稿《' || NEW.title || '》已通过',
        '站长已审核通过，文章现在可以在前台看到了。',
        'post.html?slug=' || NEW.slug, v_actor, v_actor_name, NEW.slug);
    ELSIF NEW.status = 'scheduled' THEN
      PERFORM public.notify_push(
        NEW.author_id, 'post_approved',
        '投稿《' || NEW.title || '》已通过',
        '站长已审核通过，文章将在 ' || to_char(NEW.publish_at, 'YYYY-MM-DD HH24:MI') || ' 自动上线。',
        'post.html?slug=' || NEW.slug, v_actor, v_actor_name, NEW.slug);
    ELSIF NEW.status = 'rejected' THEN
      PERFORM public.notify_push(
        NEW.author_id, 'post_rejected',
        '投稿《' || NEW.title || '》未通过',
        COALESCE(NULLIF(btrim(NEW.review_note), ''), '站长没有填写理由，修改后可以重新提交。'),
        v_link, v_actor, v_actor_name, NEW.slug);
    ELSIF NEW.status = 'draft' AND OLD.status IN ('published', 'scheduled') THEN
      PERFORM public.notify_push(
        NEW.author_id, 'post_unpublished',
        '文章《' || NEW.title || '》已下架',
        '站长把它转回了草稿，前台暂时不可见。',
        v_link, v_actor, v_actor_name, NEW.slug);
    END IF;
  END IF;

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

-- 13.2 评论守卫：追加 IP/UA 打点与垃圾评分（原逻辑一字不动，只做加法）
CREATE OR REPLACE FUNCTION public.comments_stamp_author()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_nickname text; v_parent public.comments; v_word text; v_recent_1m int; v_recent_10m int;
  v_admin boolean := public.is_admin(); v_edited boolean := false; v_link text; v_mention text;
  v_uid text; v_takes int := 0;
  v_score int := 0; v_flags text[] := '{}'; v_links int; v_hold int; v_hide int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.owner_id := auth.uid()::text;
  END IF;
  IF NEW.owner_id IS NULL OR NEW.owner_id = '' THEN
    RAISE EXCEPTION '评论必须由登录用户提交' USING ERRCODE = '42501';
  END IF;
  NEW.content := btrim(coalesce(NEW.content, ''));
  IF char_length(NEW.content) = 0 THEN
    RAISE EXCEPTION '评论内容不能为空' USING ERRCODE = '23514';
  END IF;
  NEW.content := left(NEW.content, 1000);

  IF TG_OP = 'UPDATE' THEN
    v_edited := NEW.content IS DISTINCT FROM OLD.content;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT v_admin THEN
    NEW.owner_id := OLD.owner_id;
    NEW.post_slug := OLD.post_slug;
    NEW.parent_id := OLD.parent_id;
    NEW.status := OLD.status;
  END IF;

  IF TG_OP = 'UPDATE' AND v_edited AND NOT v_admin THEN
    IF OLD.created_at < now() - interval '15 minutes' THEN
      RAISE EXCEPTION '评论发表超过 15 分钟后不能再修改，可以删除后重新发表。'
        USING ERRCODE = 'P0001', HINT = 'EDIT_WINDOW_CLOSED';
    END IF;
    NEW.edited_at := now();
    IF OLD.status <> 'pending' THEN
      NEW.status := 'pending';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.edited_at := OLD.edited_at;
  END IF;

  IF TG_OP = 'INSERT' AND NOT v_admin THEN
    SELECT count(*) INTO v_recent_1m FROM public.comments
     WHERE owner_id = NEW.owner_id AND created_at >= now() - interval '60 seconds';
    IF v_recent_1m >= 5 THEN
      RAISE EXCEPTION '发言太快了，请等一分钟后再试。' USING ERRCODE = 'P0001', HINT = 'RATE_LIMIT_1M';
    END IF;
    SELECT count(*) INTO v_recent_10m FROM public.comments
     WHERE owner_id = NEW.owner_id AND created_at >= now() - interval '10 minutes';
    IF v_recent_10m >= 20 THEN
      RAISE EXCEPTION '最近十分钟的评论太多了，请稍后再来。' USING ERRCODE = 'P0001', HINT = 'RATE_LIMIT_10M';
    END IF;
  END IF;

  SELECT NULLIF(btrim(coalesce(nickname, '')), '') INTO v_nickname
    FROM public.profiles WHERE owner_id = NEW.owner_id;
  IF v_nickname IS NOT NULL THEN
    NEW.author_name := left(v_nickname, 60);
  ELSIF TG_OP = 'UPDATE' AND NULLIF(btrim(coalesce(OLD.author_name, '')), '') IS NOT NULL THEN
    NEW.author_name := left(OLD.author_name, 60);
  ELSE
    NEW.author_name := '读者';
  END IF;

  SELECT w.word INTO v_word FROM public.comment_banned_words w
   WHERE position(lower(w.word) IN lower(NEW.content)) > 0
   ORDER BY char_length(w.word) DESC LIMIT 1;
  NEW.flag_reason := CASE WHEN v_word IS NULL THEN NULL ELSE '命中敏感词：' || left(v_word, 40) END;

  -- ---- B17：垃圾评分（只打标记与分数，不代替人工判定） ----
  v_hold := public.spam_setting_int('comment.hold_score', 4);
  v_hide := public.spam_setting_int('comment.auto_hide_score', 7);

  IF TG_OP = 'INSERT' AND NOT v_admin THEN
    v_links := (char_length(NEW.content) - char_length(replace(lower(NEW.content), 'http', ''))) / 4;
    IF v_links >= 1 THEN
      v_score := v_score + LEAST(v_links, 3) * 2;
      v_flags := v_flags || 'links';
    END IF;
    IF v_word IS NOT NULL THEN
      v_score := v_score + 4;
      v_flags := v_flags || 'banned_word';
    END IF;
    IF COALESCE(NEW.ua_family, '') = '' THEN
      v_score := v_score + 2;
      v_flags := v_flags || 'no_ua';
    ELSIF NEW.ua_family = 'Bot' THEN
      v_score := v_score + 3;
      v_flags := v_flags || 'bot_ua';
    END IF;
    IF char_length(NEW.content) < 10 AND v_links >= 1 THEN
      v_score := v_score + 2;
      v_flags := v_flags || 'short_link';
    END IF;
    IF EXISTS (SELECT 1 FROM public.comments c
                WHERE c.owner_id = NEW.owner_id AND c.content = NEW.content
                  AND c.created_at >= now() - interval '10 minutes') THEN
      v_score := v_score + 3;
      v_flags := v_flags || 'duplicate';
    END IF;
    IF NEW.ip_hash IS NOT NULL AND (
         SELECT count(*) FROM public.comments c
          WHERE c.ip_hash = NEW.ip_hash AND c.created_at >= now() - interval '30 minutes') >= 5 THEN
      v_score := v_score + 3;
      v_flags := v_flags || 'ip_burst';
    END IF;

    NEW.spam_score := v_score;
    NEW.spam_flags := CASE WHEN cardinality(v_flags) = 0 THEN NULL ELSE v_flags END;
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.spam_score := COALESCE(OLD.spam_score, 0);
    NEW.spam_flags := OLD.spam_flags;
    NEW.ip_hash := OLD.ip_hash;
    NEW.ua_family := OLD.ua_family;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_admin THEN
      NEW.status := CASE WHEN NEW.status IS NULL OR NEW.status NOT IN ('visible','hidden','pending')
                         THEN 'visible' ELSE NEW.status END;
    ELSE
      NEW.status := CASE WHEN v_score >= v_hide THEN 'hidden' ELSE 'pending' END;
    END IF;
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.comments WHERE id = NEW.parent_id;
    IF NOT FOUND OR v_parent.post_slug IS DISTINCT FROM NEW.post_slug
       OR v_parent.parent_id IS NOT NULL OR v_parent.id = NEW.id THEN
      NEW.parent_id := NULL;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_link := CASE WHEN NEW.post_slug LIKE 'cloud:%'
                   THEN 'post.html?slug=' || substr(NEW.post_slug, 7)
                   ELSE 'posts/' || NEW.post_slug || '.html' END;

    FOR v_mention IN
      SELECT DISTINCT m[1] FROM regexp_matches(
        NEW.content,
        '@([^[:space:]@,.;:!?()<>\[\]/|，。、；：！？（）【】《》“”‘’…—"'']{1,40})', 'g') AS m
      LIMIT 5
    LOOP
      SELECT p.owner_id INTO v_uid FROM public.profiles p
       WHERE p.nickname = v_mention AND p.status = 'active' LIMIT 1;
      IF v_uid IS NOT NULL AND v_uid <> NEW.owner_id THEN
        PERFORM public.notify_push(
          v_uid, 'mention',
          COALESCE(NEW.author_name, '有人') || ' 在评论里提到了你',
          left(NEW.content, 200), v_link, NEW.owner_id, NEW.author_name, NEW.post_slug);
        v_takes := v_takes + 1;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END
$function$;

-- 13.3 后台文章分页：放行编辑 + 置顶/权重/定时列 + scheduled 筛选项
CREATE OR REPLACE FUNCTION public.admin_posts_page(p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
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
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  DROP TABLE IF EXISTS _ap;
  CREATE TEMP TABLE _ap ON COMMIT DROP AS
  SELECT p.id, p.slug, p.title, p.summary, p.status, p.author_id, p.tags,
         p.created_at, p.updated_at, p.published_at, p.review_note, p.reviewed_at,
         p.edit_submitted_at, p.edit_review_note, p.publish_at, p.pinned, p.weight,
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
      OR (v_status = 'published' AND p.status = 'published' AND (p.publish_at IS NULL OR p.publish_at <= now()))
      OR (v_status = 'scheduled' AND p.status = 'scheduled' AND p.publish_at > now())
      OR (v_status = 'edit_pending' AND p.edit_submitted_at IS NOT NULL)
      OR (v_status NOT IN ('reviewed', 'published', 'scheduled', 'edit_pending') AND p.status = v_status)
    );

  SELECT count(*) INTO v_total FROM _ap;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT id, slug, title, summary, status, author_id, tags, created_at, updated_at,
             published_at, review_note, reviewed_at, edit_submitted_at, edit_review_note,
             edit_title, nickname, email, publish_at, pinned, weight
      FROM _ap
     ORDER BY pinned DESC, (status = 'pending') DESC, (edit_submitted_at IS NOT NULL) DESC, updated_at DESC
     LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

-- 13.4 审核投稿：放行编辑 + 尊重 publish_at（未来 → scheduled）
CREATE OR REPLACE FUNCTION public.admin_review_post(p_slug text, p_action text, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_row  public.cloud_posts;
  v_at   timestamptz;
  v_next text;
BEGIN
  IF NOT public.is_staff() OR NOT public.is_active() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_slug IS NULL OR btrim(p_slug) = '' OR p_action IS NULL
     OR p_action NOT IN ('approve', 'reject', 'unpublish') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
  END IF;

  SELECT * INTO v_row FROM public.cloud_posts WHERE slug = btrim(p_slug);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF p_action = 'approve' THEN
    v_at := v_row.publish_at;
    v_next := CASE WHEN v_at IS NOT NULL AND v_at > now() THEN 'scheduled' ELSE 'published' END;
    UPDATE public.cloud_posts
       SET status = v_next,
           published_at = CASE WHEN v_next = 'published' THEN COALESCE(v_at, published_at, now()) ELSE published_at END,
           review_note = NULL,
           reviewed_at = now(),
           reviewed_by = auth.uid()::text,
           updated_at = now()
     WHERE id = v_row.id;
  ELSIF p_action = 'reject' THEN
    UPDATE public.cloud_posts
       SET status = 'rejected',
           published_at = NULL,
           publish_at = NULL,
           review_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
           reviewed_at = now(),
           reviewed_by = auth.uid()::text,
           updated_at = now()
     WHERE id = v_row.id;
    v_next := 'rejected';
  ELSE
    UPDATE public.cloud_posts
       SET status = 'draft',
           published_at = NULL,
           publish_at = NULL,
           reviewed_at = now(),
           reviewed_by = auth.uid()::text,
           updated_at = now()
     WHERE id = v_row.id;
    v_next := 'draft';
  END IF;

  PERFORM public.audit_log(
    'post_review', 'cloud_post', v_row.id::text,
    p_action || coalesce(' / ' || NULLIF(btrim(COALESCE(p_note, '')), ''), ''),
    jsonb_build_object('action', p_action, 'note', p_note, 'result_status', v_next, 'publish_at', v_row.publish_at)
  );

  RETURN jsonb_build_object('ok', true, 'slug', v_row.slug, 'action', p_action, 'status', v_next);
END
$function$;

-- 13.5 审核改稿：放行编辑
CREATE OR REPLACE FUNCTION public.admin_review_edit(p_slug text, p_action text, p_note text DEFAULT NULL::text)
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
  IF NOT public.is_staff() THEN
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

  PERFORM public.audit_log('review_edit_' || p_action, 'cloud_post', v_row.id::text, v_note, NULL);

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

-- 13.6 改稿新旧全文对照：放行编辑
CREATE OR REPLACE FUNCTION public.admin_post_edit_detail(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_row public.cloud_posts%ROWTYPE;
BEGIN
  IF NOT public.is_staff() THEN
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
    'tags', COALESCE(v_row.tags, '{}'::text[]),
    'edit_title', COALESCE(NULLIF(btrim(v_row.edit_title), ''), v_row.title),
    'edit_summary', COALESCE(v_row.edit_summary, COALESCE(v_row.summary, '')),
    'edit_content_md', COALESCE(v_row.edit_content_md, v_row.content_md, '')
  );
END
$function$;

-- 13.7 评论分页：放行编辑 + 垃圾分数字段
CREATE OR REPLACE FUNCTION public.admin_comments_page(p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
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
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  DROP TABLE IF EXISTS _ac;
  CREATE TEMP TABLE _ac ON COMMIT DROP AS
  SELECT c.id, c.parent_id, c.post_slug, c.author_name, c.content, c.status,
         c.flag_reason, c.created_at, c.spam_score, c.spam_flags, c.ua_family,
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
      OR (v_status = 'spam' AND c.spam_score > 0)
    );

  SELECT count(*) INTO v_total FROM _ac;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT id, parent_id, post_slug, author_name, content, status, flag_reason,
             created_at, parent_author, spam_score, spam_flags, ua_family
      FROM _ac ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

-- 13.8 举报分页：放行编辑
CREATE OR REPLACE FUNCTION public.admin_reports_page(p_status text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_status text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_total bigint;
  v_open bigint;
  v_rows jsonb;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  DROP TABLE IF EXISTS _rp;
  CREATE TEMP TABLE _rp ON COMMIT DROP AS
  SELECT r.id, r.comment_id, r.post_slug, r.reason, r.note, r.status, r.created_at,
         r.handled_at, r.handle_note, r.reporter_id,
         (SELECT COALESCE(NULLIF(btrim(p.nickname), ''), split_part(COALESCE(u.email::text, ''), '@', 1), '读者')
            FROM auth.users u LEFT JOIN public.profiles p ON p.owner_id = u.id::text
           WHERE u.id::text = r.reporter_id) AS reporter_name,
         c.author_name AS comment_author,
         c.content AS comment_content,
         c.owner_id AS comment_author_id,
         c.status AS comment_status
    FROM public.comment_reports r
    LEFT JOIN public.comments c ON c.id = r.comment_id
   WHERE v_status IS NULL OR r.status = v_status;

  SELECT count(*) INTO v_total FROM _rp;
  SELECT count(*) INTO v_open FROM public.comment_reports WHERE status = 'open';

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (SELECT id, comment_id, post_slug, reason, note, status, created_at, handled_at,
                 handle_note, reporter_name, comment_author, comment_content,
                 comment_author_id, comment_status
            FROM _rp ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'open', v_open, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;

-- 13.9 处理举报：放行编辑
CREATE OR REPLACE FUNCTION public.admin_resolve_report(p_id bigint, p_action text, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 200), '');
  v_owner text;
  v_kind text;
BEGIN
  IF NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_action NOT IN ('resolved', 'dismissed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_action');
  END IF;

  UPDATE public.comment_reports
     SET status = v_action, handled_by = auth.uid()::text, handled_at = now(), handle_note = v_note
   WHERE id = p_id AND status = 'open'
  RETURNING reporter_id INTO v_owner;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  v_kind := CASE WHEN v_action = 'resolved' THEN 'report_resolved' ELSE 'report_dismissed' END;
  PERFORM public.notify_push(
    v_owner, v_kind,
    CASE WHEN v_action = 'resolved' THEN '你的举报已被处理' ELSE '你的举报暂不处理' END,
    CASE WHEN v_action = 'resolved' THEN '站长已处理你举报的评论。' ELSE '站长看过你举报的评论，决定暂不处理。' END
      || COALESCE(' 说明：' || v_note, ''),
    'index.html', NULL, NULL, NULL);

  PERFORM public.audit_log('comment_report_' || v_action, 'comment_report', p_id::text, v_note, NULL);
  RETURN jsonb_build_object('ok', true, 'action', v_action);
END
$function$;

-- 13.10 用户分页：补 is_editor / 二次验证状态
CREATE OR REPLACE FUNCTION public.admin_users_page(p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
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
         COALESCE(p.is_editor, false) AS is_editor,
         p.email_verified_at,
         p.pending_email,
         p.pending_email_at,
         p.pending_email_note,
         EXISTS (SELECT 1 FROM public.admin_emails a WHERE lower(a.email) = lower(u.email::text)) AS is_admin,
         EXISTS (SELECT 1 FROM public.user_totp t WHERE t.owner_id = u.id::text AND t.enabled_at IS NOT NULL) AS totp_enabled,
         (u.id::text = auth.uid()::text) AS is_self,
         COALESCE(p.created_at, u.created_at) AS created_at,
         u.last_login,
         (SELECT count(*) FROM public.comments c WHERE c.owner_id = u.id::text) AS comment_count,
         (SELECT count(*) FROM public.post_likes l WHERE l.owner_id = u.id::text) AS like_count,
         (SELECT count(*) FROM public.cloud_posts cp WHERE cp.author_id = u.id::text) AS post_count
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
      OR (v_status = 'editor'   AND COALESCE(p.is_editor, false))
    );

  SELECT count(*) INTO v_total FROM _au;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT owner_id, email, nickname, avatar_url, bio, status, can_publish, is_editor,
             is_admin, totp_enabled, is_self, created_at, last_login, comment_count,
             like_count, post_count, email_verified_at, pending_email, pending_email_at,
             pending_email_note
      FROM _au ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    ) t;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
END
$function$;
