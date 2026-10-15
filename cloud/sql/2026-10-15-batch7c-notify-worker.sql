-- =====================================================================
-- 第七批补丁 C · 站外投递 worker（缺口 B3 的最后一段管道）
-- 日期：2026-10-15
-- 目标：让 notify_outbox 队列真的能被发出去。
--
-- 背景：第七批主文件已经把「入队 → 队列 → 后台面板」全部建好，
-- 但把队列 drain 出去的进程（云函数 ws-notify）没落地，B3 一直是
-- 「只入队、不送达」。本补丁补齐 worker 需要的四个存储过程。
--
-- 本次一并修掉的既有 bug：
--   notify_outbox_claim / notify_outbox_ack 用 btrim(value::text) 比密钥，
--   而 site_settings 的 jsonb 字符串转 text 会带一对引号（"abc"），
--   btrim 只去空白不去引号 → 密钥永远对不上、永远返回 forbidden。
--   本仓其他函数一律写成 btrim(value::text, '"')，这里统一口径。
--
-- 云函数侧（代码在仓库 cloudfunctions/ws-notify/，非本文件）：
--   · 每 5 分钟定时触发（0 */5 * * * * *）
--   · 走站点通道 /.cloud/database/rest/rpc/<fn> + 发布密钥（服务端调用不受 Origin 限制）
--   · 环境变量：WS_BLOG_ENDPOINT / WS_BLOG_ACCESS_KEY / NOTIFY_WORKER_SECRET
--               以及可选的 SMTP_HOST 等
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 只读投递配置（worker 先看配置再领取，避免白烧队列的尝试次数）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_worker_config(p_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
  v_cfg jsonb;
  v_get text;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want FROM public.site_settings WHERE key = 'notify.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  v_cfg := jsonb_build_object('webhook_url', '', 'webhook_kind', 'auto', 'mail_enabled', false, 'site_title', 'WS Blog');

  SELECT NULLIF(btrim(value::text, '"'), '') INTO v_get FROM public.site_settings WHERE key = 'notify.webhook_url';
  IF v_get IS NOT NULL THEN v_cfg := jsonb_set(v_cfg, '{webhook_url}', to_jsonb(v_get)); END IF;

  SELECT NULLIF(btrim(value::text, '"'), '') INTO v_get FROM public.site_settings WHERE key = 'notify.webhook_kind';
  IF v_get IS NOT NULL AND v_get <> '' THEN v_cfg := jsonb_set(v_cfg, '{webhook_kind}', to_jsonb(v_get)); END IF;

  SELECT NULLIF(btrim(value::text, '"'), '') INTO v_get FROM public.site_settings WHERE key = 'mail.enabled';
  IF v_get IS NOT NULL THEN v_cfg := jsonb_set(v_cfg, '{mail_enabled}', to_jsonb(v_get::boolean)); END IF;

  SELECT NULLIF(btrim(value::text, '"'), '') INTO v_get FROM public.site_settings WHERE key = 'site.title';
  IF v_get IS NOT NULL AND v_get <> '' THEN v_cfg := jsonb_set(v_cfg, '{site_title}', to_jsonb(v_get)); END IF;

  RETURN jsonb_build_object('ok', true, 'config', v_cfg);
END
$function$;
-- ⚠️ 反直觉但必须：REST 通道（/.cloud/database/rest/rpc/）的服务端调用身份就是 anon。
--    云函数没有用户 JWT，网关按匿名角色进来 —— 「REVOKE FROM anon」会让 worker 直接吃
--    401 permission denied。安全边界不靠 GRANT，靠**函数体内的共享密钥校验**。
--    （本文件线上实际授权一直带着 anon，此处补齐源码，避免源码与云端不一致。）
-- 与 claim/ack 同一套口径：GRANT 到 anon，但函数内先验共享密钥

-- ---------------------------------------------------------------------
-- 2. 领取（修订版：修密钥比对 + 顺带回传投递配置）
--    为什么配置要在这里回传：webhook 地址属敏感信息，不该进匿名可读的
--    设置视图；而此刻共享密钥已经证明了身份，由这个函数代读最自然。
-- ---------------------------------------------------------------------
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
  v_cfg jsonb;
  v_get text;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want FROM public.site_settings WHERE key = 'notify.worker_secret';
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

  v_cfg := jsonb_build_object('webhook_url', '', 'webhook_kind', 'auto', 'mail_enabled', false, 'site_title', 'WS Blog');

  SELECT NULLIF(btrim(value::text, '"'), '') INTO v_get FROM public.site_settings WHERE key = 'notify.webhook_url';
  IF v_get IS NOT NULL THEN v_cfg := jsonb_set(v_cfg, '{webhook_url}', to_jsonb(v_get)); END IF;

  SELECT NULLIF(btrim(value::text, '"'), '') INTO v_get FROM public.site_settings WHERE key = 'notify.webhook_kind';
  IF v_get IS NOT NULL AND v_get <> '' THEN v_cfg := jsonb_set(v_cfg, '{webhook_kind}', to_jsonb(v_get)); END IF;

  SELECT NULLIF(btrim(value::text, '"'), '') INTO v_get FROM public.site_settings WHERE key = 'mail.enabled';
  IF v_get IS NOT NULL THEN v_cfg := jsonb_set(v_cfg, '{mail_enabled}', to_jsonb(v_get::boolean)); END IF;

  SELECT NULLIF(btrim(value::text, '"'), '') INTO v_get FROM public.site_settings WHERE key = 'site.title';
  IF v_get IS NOT NULL AND v_get <> '' THEN v_cfg := jsonb_set(v_cfg, '{site_title}', to_jsonb(v_get)); END IF;

  RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'config', v_cfg);
END
$function$;

-- ⚠️ 反直觉但必须：REST 通道（/.cloud/database/rest/rpc/）的服务端调用身份就是 anon。
--    云函数没有用户 JWT，网关按匿名角色进来 —— 「REVOKE FROM anon」会让 worker 直接吃
--    401 permission denied。安全边界不靠 GRANT，靠**函数体内的共享密钥校验**。
--    （本文件线上实际授权一直带着 anon，此处补齐源码，避免源码与云端不一致。）
GRANT EXECUTE ON FUNCTION public.notify_outbox_claim(text, integer) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. 回执（修订版：同样修密钥比对）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_outbox_ack(p_secret text, p_id bigint, p_ok boolean, p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want FROM public.site_settings WHERE key = 'notify.worker_secret';
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

-- ⚠️ 反直觉但必须：REST 通道（/.cloud/database/rest/rpc/）的服务端调用身份就是 anon。
--    云函数没有用户 JWT，网关按匿名角色进来 —— 「REVOKE FROM anon」会让 worker 直接吃
--    401 permission denied。安全边界不靠 GRANT，靠**函数体内的共享密钥校验**。
--    （本文件线上实际授权一直带着 anon，此处补齐源码，避免源码与云端不一致。）
GRANT EXECUTE ON FUNCTION public.notify_outbox_ack(text, bigint, boolean, text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. 心跳：worker 是静默定时任务，没有痕迹就等于「看不见的管道」。
--    后台「通知」面板读 notify.worker_state 显示「正常 / 已停止 / 未运行」。
--    密钥不对时连心跳都写不进去 —— 那正是「没有运行记录」这个正确信号。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_worker_beat(
  p_secret text, p_status text, p_sent integer DEFAULT 0, p_failed integer DEFAULT 0, p_detail text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want FROM public.site_settings WHERE key = 'notify.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  INSERT INTO public.site_settings (key, value, is_public, updated_at, updated_by)
  VALUES (
    'notify.worker_state',
    jsonb_build_object(
      'at', now(),
      'status', left(COALESCE(p_status, 'unknown'), 40),
      'sent', COALESCE(p_sent, 0),
      'failed', COALESCE(p_failed, 0),
      'detail', left(COALESCE(p_detail, ''), 300)
    ),
    false, now(), 'ws-notify'
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, is_public = false, updated_at = now(), updated_by = 'ws-notify';

  RETURN jsonb_build_object('ok', true);
END
$function$;

GRANT EXECUTE ON FUNCTION public.notify_worker_beat(text, text, integer, integer, text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. 初始化共享密钥（如尚未设置）
--    ⚠️ 本仓库是公开仓库：**任何真实密钥都不许写进迁移文件**。
--       这里用服务端随机生成，值只落在数据库里（is_public=false），
--       部署后到后台「通知」面板复制出来，填进云函数 ws-notify 的
--       NOTIFY_WORKER_SECRET；轮换后同样要更新函数环境变量。
--    （长度 48 位 hex，与 notify_outbox_claim / notify_worker_beat 的
--      btrim 比对逻辑无关，只是为了一致的外观。）
-- ---------------------------------------------------------------------
INSERT INTO public.site_settings (key, value, is_public, updated_at, updated_by)
SELECT 'notify.worker_secret',
       to_jsonb(
         md5(random()::text || clock_timestamp()::text || pg_backend_pid()::text)
         || substr(md5(random()::text || clock_timestamp()::text), 1, 16)
       ),
       false, now(), 'deploy:ws-notify'
WHERE NOT EXISTS (SELECT 1 FROM public.site_settings WHERE key = 'notify.worker_secret');
