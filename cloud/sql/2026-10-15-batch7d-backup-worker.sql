-- =====================================================================
-- 第七批补丁 D · 定时自动备份 + 异地留存（缺口 B5 收尾）
-- 日期：2026-10-15
-- 目标：把「一键导出 / 上传 / 清单 / 删除」这套**手动**备份补成**自动 + 异地**。
--
-- 背景：第七批主文件已建好 backup_snapshots 表与四个管理 RPC
--   （admin_export / admin_backup_record / admin_backups_page / admin_backup_delete），
-- 但这些都要**管理员在浏览器里点**才发生，且落到的是本站自己的 runtime 存储桶 ——
-- 数据仍只在一个云环境里，谈不上「异地留存」。
--
-- 本补丁补三件事：
--   1. 备份策略存进 site_settings（是否开启、时刻、保留份数、异地目标），后台可改；
--   2. 给定时 worker 用的**共享密钥通道**（worker 不是管理员，不能走 admin_* 那套）：
--      backup_worker_config / backup_snapshot_record / backup_worker_beat / backup_prune；
--   3. 备份心跳，让后台能看出「这管道是不是停了」。
--
-- 云函数侧（cloudfunctions/ws-backup/，非本文件）：
--   · 每天定点触发（7 段 cron，如 0 0 3 * * * * = 每天 03:00）
--   · 走站点通道 /.cloud/database/rest/rpc/<fn> + 发布密钥（服务端调用不受 Origin 限制）
--   · 先取策略 → 导出 → 写异地目标（Webhook / S3 兼容）→ 登记 → 按保留份数裁剪
--   · 环境变量：WS_BLOG_ENDPOINT / WS_BLOG_ACCESS_KEY / BACKUP_WORKER_SECRET
--               以及可选的 BACKUP_WEBHOOK_URL 等（见云函数 README 注释）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. 备份策略默认值（全部 is_public=false：策略属运维配置，不该匿名可见）
--    · backup.enabled    是否开启定时快照
--    · backup.hour       每天几点（0-23，服务器时区）
--    · backup.kind       导出范围（all / posts / comments / users / interactions / admin）
--    · backup.keep       云端保留最近几份（超出由 worker 调用 backup_prune 删）
--    · backup.offsite    'off' | 'webhook' | 's3' —— 异地留存方式
--    · backup.offsite_state 最近一次异地投递结果（worker 回写，供后台显示）
-- ---------------------------------------------------------------------
INSERT INTO public.site_settings (key, value, is_public, updated_at, updated_by)
SELECT v.key, v.value, false, now(), 'deploy:ws-backup'
  FROM (VALUES
    ('backup.enabled',  'true'::jsonb),
    ('backup.hour',     '3'::jsonb),
    ('backup.kind',     '"all"'::jsonb),
    ('backup.keep',     '14'::jsonb),
    ('backup.offsite',  '"off"'::jsonb)
  ) AS v(key, value)
 WHERE NOT EXISTS (SELECT 1 FROM public.site_settings s WHERE s.key = v.key);

-- ---------------------------------------------------------------------
-- 1. 共享密钥（与 notify.worker_secret 同一套做法）
--    ⚠️ 本仓库是公开仓库：**任何真实密钥都不许写进迁移文件**。
--       这里用服务端随机生成，值只落在数据库里（is_public=false）；
--       部署后到后台「数据与备份」面板复制出来，填进云函数 ws-backup 的
--       BACKUP_WORKER_SECRET 环境变量；轮换后同样要更新函数环境变量。
-- ---------------------------------------------------------------------
INSERT INTO public.site_settings (key, value, is_public, updated_at, updated_by)
SELECT 'backup.worker_secret',
       to_jsonb(
         md5(random()::text || clock_timestamp()::text || pg_backend_pid()::text)
         || substr(md5(random()::text || clock_timestamp()::text), 1, 16)
       ),
       false, now(), 'deploy:ws-backup'
WHERE NOT EXISTS (SELECT 1 FROM public.site_settings WHERE key = 'backup.worker_secret');

-- ---------------------------------------------------------------------
-- 2. 工具函数：读一个非公开设置项的文本值
--    ⚠️ site_settings 的 value 是 jsonb，字符串转 text 会带一对引号（"abc"），
--       必须 btrim(value::text, '"') 去掉 —— 本仓踩过一次（见 7c 文件的说明）。
--    内部使用，不 GRANT。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_setting_text(p_key text, p_default text DEFAULT '')
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v text;
BEGIN
  SELECT NULLIF(btrim(value::text, '"'), '') INTO v FROM public.site_settings WHERE key = p_key;
  RETURN COALESCE(v, p_default);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.backup_setting_text(text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. worker 取策略（密钥校验；worker 不是管理员，不能读 admin_* 那套）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_worker_config(p_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
  v_cfg  jsonb;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want
    FROM public.site_settings WHERE key = 'backup.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  v_cfg := jsonb_build_object(
    'enabled',      COALESCE(public.backup_setting_text('backup.enabled', 'true')::boolean, true),
    'hour',         COALESCE(NULLIF(public.backup_setting_text('backup.hour', '3'), '')::int, 3),
    'kind',         COALESCE(NULLIF(public.backup_setting_text('backup.kind', 'all'), ''), 'all'),
    'keep',         COALESCE(NULLIF(public.backup_setting_text('backup.keep', '14'), '')::int, 14),
    'offsite',      COALESCE(NULLIF(public.backup_setting_text('backup.offsite', 'off'), ''), 'off'),
    'site_title',   COALESCE(NULLIF(public.backup_setting_text('site.title', 'WS Blog'), ''), 'WS Blog')
  );

  RETURN jsonb_build_object('ok', true, 'config', v_cfg);
END
$function$;

-- ⚠️ 反直觉但必须：REST 通道（/.cloud/database/rest/rpc/）的服务端调用身份就是 anon。
--    云函数没有用户 JWT，网关按匿名角色进来 —— 所以「REVOKE FROM anon」会让 worker
--    拿到 401 permission denied（实测 backup_worker_config 首次调用即撞上）。
--    安全边界不靠 GRANT，靠**函数体第一段的共享密钥校验**：密钥不对一律返回 forbidden。
--    这也与 notify_worker_config / notify_outbox_claim 的线上实际授权保持一致。
GRANT EXECUTE ON FUNCTION public.backup_worker_config(text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. worker 登记一条快照（落 backup_snapshots + 审计）
--    与 admin_backup_record 的区别：身份来自共享密钥而非 is_admin()，
--    并额外记录**异地投递结果**（offsite / offsite_state）。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_snapshot_record(
  p_secret      text,
  p_kind        text,
  p_path        text,
  p_url         text,
  p_size        bigint,
  p_row_counts  jsonb,
  p_note        text DEFAULT NULL,
  p_offsite     text DEFAULT NULL,
  p_offsite_state text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
  v_id   bigint;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want
    FROM public.site_settings WHERE key = 'backup.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_path IS NULL OR btrim(p_path) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
  END IF;

  INSERT INTO public.backup_snapshots
    (kind, format, path, url, size, row_counts, note, created_by, offsite, offsite_state)
  VALUES
    (left(COALESCE(p_kind, 'all'), 40), 'json', btrim(p_path), p_url,
     COALESCE(p_size, 0), COALESCE(p_row_counts, '{}'::jsonb),
     NULLIF(left(btrim(COALESCE(p_note, '')), 200), ''),
     'ws-backup',
     NULLIF(left(btrim(COALESCE(p_offsite, '')), 20), ''),
     NULLIF(left(btrim(COALESCE(p_offsite_state, '')), 300), ''))
  RETURNING id INTO v_id;

  PERFORM public.audit_log('backup_auto', 'backup', v_id::text, NULL,
    jsonb_build_object('kind', p_kind, 'path', p_path, 'size', p_size,
                       'offsite', p_offsite, 'offsite_state', p_offsite_state));

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END
$function$;

-- ⚠️ 反直觉但必须：REST 通道（/.cloud/database/rest/rpc/）的服务端调用身份就是 anon。
--    云函数没有用户 JWT，网关按匿名角色进来 —— 所以「REVOKE FROM anon」会让 worker
--    拿到 401 permission denied（实测 backup_worker_config 首次调用即撞上）。
--    安全边界不靠 GRANT，靠**函数体第一段的共享密钥校验**：密钥不对一律返回 forbidden。
--    这也与 notify_worker_config / notify_outbox_claim 的线上实际授权保持一致。
GRANT EXECUTE ON FUNCTION public.backup_snapshot_record(text, text, text, text, bigint, jsonb, text, text, text)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. worker 心跳：静默定时任务必须留痕，否则「管道停了」没人知道。
--    后台读 backup.worker_state 显示「正常 / 已停止 / 未运行」。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_worker_beat(
  p_secret text,
  p_status text,
  p_note   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want
    FROM public.site_settings WHERE key = 'backup.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  INSERT INTO public.site_settings (key, value, is_public, updated_at, updated_by)
  VALUES (
    'backup.worker_state',
    jsonb_build_object(
      'at', now(),
      'status', left(COALESCE(p_status, 'unknown'), 40),
      'note', left(COALESCE(p_note, ''), 300)
    ),
    false, now(), 'ws-backup'
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, is_public = false, updated_at = now(), updated_by = 'ws-backup';

  RETURN jsonb_build_object('ok', true);
END
$function$;

-- ⚠️ 反直觉但必须：REST 通道（/.cloud/database/rest/rpc/）的服务端调用身份就是 anon。
--    云函数没有用户 JWT，网关按匿名角色进来 —— 所以「REVOKE FROM anon」会让 worker
--    拿到 401 permission denied（实测 backup_worker_config 首次调用即撞上）。
--    安全边界不靠 GRANT，靠**函数体第一段的共享密钥校验**：密钥不对一律返回 forbidden。
--    这也与 notify_worker_config / notify_outbox_claim 的线上实际授权保持一致。
GRANT EXECUTE ON FUNCTION public.backup_worker_beat(text, text, text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. 按保留份数裁剪：只删**超出保留数的最旧记录**，返回被裁掉的 path 列表
--    让 worker 有机会把存储里的文件也删掉（DB 记录删了、文件还占着没意义）。
--    ⚠️ 只裁 worker 自己产生的（created_by='ws-backup'）？—— 不。
--       手动备份也该受保留策略约束，否则手动点几下就能把桶塞满。
--       但要**保护手动备份不被一刀切**：手动的那份 created_by 是管理员 uid，
--       这里统一按时间裁剪，语义是「保留最近 N 份」，与来源无关。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_prune(p_secret text, p_keep integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
  v_keep int := GREATEST(COALESCE(p_keep, 14), 1);
  v_paths jsonb;
  v_n int;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want
    FROM public.site_settings WHERE key = 'backup.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(t.path), '[]'::jsonb) INTO v_paths
    FROM (
      SELECT path FROM public.backup_snapshots
       ORDER BY created_at DESC
       OFFSET v_keep
    ) t;

  DELETE FROM public.backup_snapshots
   WHERE id IN (
     SELECT id FROM public.backup_snapshots ORDER BY created_at DESC OFFSET v_keep
   );
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n > 0 THEN
    PERFORM public.audit_log('backup_prune', 'backup', NULL,
      format('按保留 %s 份裁剪', v_keep), jsonb_build_object('removed', v_n, 'paths', v_paths));
  END IF;

  RETURN jsonb_build_object('ok', true, 'removed', v_n, 'paths', v_paths, 'keep', v_keep);
END
$function$;

-- ⚠️ 反直觉但必须：REST 通道（/.cloud/database/rest/rpc/）的服务端调用身份就是 anon。
--    云函数没有用户 JWT，网关按匿名角色进来 —— 所以「REVOKE FROM anon」会让 worker
--    拿到 401 permission denied（实测 backup_worker_config 首次调用即撞上）。
--    安全边界不靠 GRANT，靠**函数体第一段的共享密钥校验**：密钥不对一律返回 forbidden。
--    这也与 notify_worker_config / notify_outbox_claim 的线上实际授权保持一致。
GRANT EXECUTE ON FUNCTION public.backup_prune(text, integer) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. 给备份补两列：异地留存方式与最近一次异地投递结果
--    （主文件建表时没有这两列 —— 那时还没有「异地」这个概念）
-- ---------------------------------------------------------------------
ALTER TABLE public.backup_snapshots
  ADD COLUMN IF NOT EXISTS offsite        text,
  ADD COLUMN IF NOT EXISTS offsite_state  text;

COMMENT ON COLUMN public.backup_snapshots.offsite IS
  '异地留存方式：off / webhook / s3（worker 写入）';
COMMENT ON COLUMN public.backup_snapshots.offsite_state IS
  '最近一次异地投递结果：ok:webhook / failed:... 等（worker 写入）';

-- ---------------------------------------------------------------------
-- 8. backup_snapshots 的读策略：后台要能分页看，走 admin_backups_page（SECURITY DEFINER），
--    表本身继续无策略（RLS 开着 + 无 policy = 匿名/普通用户一律读不到）。
--    这里只补一条：让**本人创建的手动备份**不需要额外策略也没关系 —— 保持原状即可。
--    （显式记一笔，免得后人以为漏了策略。）
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 9. 共享密钥版的导出：worker 不是管理员，用不了 admin_export
--    ⚠️ 为什么不直接把 admin_export 的 is_admin() 放宽：那等于把「全量数据导出」
--       这个口子开给所有人（匿名也能调 REST RPC）。必须另开一条**只认共享密钥**的通道。
--    范围与 admin_export 完全一致（同一批表、同一 cap），保证「手动导出」与
--    「定时快照」产出的结构相同。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_export(p_secret text, p_kind text DEFAULT 'all')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_want text;
  v_kind text;
  v_cap  int := 5000;
  v      jsonb := '{}'::jsonb;
  v_n    jsonb := '{}'::jsonb;
  v_tmp  jsonb;
BEGIN
  SELECT btrim(COALESCE(value::text, ''), '"') INTO v_want
    FROM public.site_settings WHERE key = 'backup.worker_secret';
  v_want := btrim(COALESCE(v_want, ''));
  IF v_want = '' OR p_secret IS NULL OR btrim(p_secret) <> v_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  v_kind := lower(btrim(COALESCE(p_kind, 'all')));

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
      /* 敏感词表只有 word / created_at —— 原来这里抄了上面 admin_emails 段的
       * `email, note`，导致 kind='interactions'（以及含它的 'all'）整条报
       * 42703 column "email" does not exist。单跑 'users'/'posts'/'comments' 都过，
       * 所以一直没暴露。 */
      FROM (SELECT word, created_at FROM public.comment_banned_words ORDER BY created_at LIMIT v_cap) t;
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
    'source', 'ws-backup',
    'generated_at', now(),
    'counts', v_n,
    'data', v
  );
END
$function$;

-- ⚠️ 反直觉但必须：REST 通道（/.cloud/database/rest/rpc/）的服务端调用身份就是 anon。
--    云函数没有用户 JWT，网关按匿名角色进来 —— 所以「REVOKE FROM anon」会让 worker
--    拿到 401 permission denied（实测 backup_worker_config 首次调用即撞上）。
--    安全边界不靠 GRANT，靠**函数体第一段的共享密钥校验**：密钥不对一律返回 forbidden。
--    这也与 notify_worker_config / notify_outbox_claim 的线上实际授权保持一致。
GRANT EXECUTE ON FUNCTION public.backup_export(text, text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 10. 后台读取「备份策略 / 心跳」的接口（管理员视角，走 is_admin()）
--     面板要显示「定时备份是否开着 / 上次跑到什么时候」，这两项都 is_public=false，
--     匿名可读的设置视图里看不到，所以给后台单独开一个读口。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_backup_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_state jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT value INTO v_state FROM public.site_settings WHERE key = 'backup.worker_state';

  RETURN jsonb_build_object(
    'ok', true,
    'enabled',      COALESCE(public.backup_setting_text('backup.enabled', 'true')::boolean, true),
    'hour',         COALESCE(NULLIF(public.backup_setting_text('backup.hour', '3'), '')::int, 3),
    'kind',         COALESCE(NULLIF(public.backup_setting_text('backup.kind', 'all'), ''), 'all'),
    'keep',         COALESCE(NULLIF(public.backup_setting_text('backup.keep', '14'), '')::int, 14),
    'offsite',      COALESCE(NULLIF(public.backup_setting_text('backup.offsite', 'off'), ''), 'off'),
    'secret_set',   COALESCE(btrim(public.backup_setting_text('backup.worker_secret', '')) <> '', false),
    'worker_state', COALESCE(v_state, 'null'::jsonb),
    'total',        (SELECT count(*) FROM public.backup_snapshots),
    'last',         (SELECT to_jsonb(t) FROM (
                       SELECT id, kind, path, size, offsite, offsite_state, created_by, created_at
                         FROM public.backup_snapshots ORDER BY created_at DESC LIMIT 1) t)
  );
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_backup_status() TO authenticated;

-- ---------------------------------------------------------------------
-- 11. 后台保存备份策略（管理员视角）。只允许改白名单几个键，走 site_settings 写入。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_backup_setting(p_key text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_key text := btrim(COALESCE(p_key, ''));
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_key NOT IN ('backup.enabled', 'backup.hour', 'backup.kind', 'backup.keep', 'backup.offsite') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_key');
  END IF;

  INSERT INTO public.site_settings (key, value, is_public, updated_at, updated_by)
  VALUES (v_key, COALESCE(p_value, 'null'::jsonb), false, now(), auth.uid()::text)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, is_public = false, updated_at = now(), updated_by = auth.uid()::text;

  PERFORM public.audit_log('backup_setting', 'setting', v_key, NULL,
                           jsonb_build_object('value', p_value));
  RETURN jsonb_build_object('ok', true, 'key', v_key, 'value', p_value);
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_backup_setting(text, jsonb) TO authenticated;

