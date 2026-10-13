-- =====================================================================
-- WS Blog · 第二批收尾：撤销三个旧的「公开读全列」策略
--
-- ⚠️ 执行前提：前端已切换到 posts_public / profiles_public 视图
--    （cloud-posts.js 三处 from('posts_public')）并已重新发布云域名。
--    本文件与 batch2-hardening.sql 分开执行是为了零中断上线：
--    视图与旧策略先并存，前端全量切换后再撤旧路。
--
-- 撤销后：
--   * 匿名对 cloud_posts 只能经 posts_public 视图读白名单列
--     （review_note / reviewed_by / author_id 不再可读）；
--     作者与管理员仍按各自 RLS 策略读基表。
--   * 匿名对 profiles 只能经 profiles_public 读昵称/头像/简介，
--     status / 时间戳不再可枚举。
--   * 匿名不能再枚举「谁给哪篇文章点了赞」。
-- 验证（应全部成功且无敏感列）：
--   SELECT slug, title FROM public.posts_public LIMIT 1;
--   SELECT owner_id, nickname FROM public.profiles_public LIMIT 1;
--   SELECT count(*) FROM public.post_likes;           -- 匿名应报权限错误
--   SELECT review_note FROM public.cloud_posts LIMIT 1; -- 匿名应报权限错误
-- =====================================================================

DROP POLICY IF EXISTS posts_public_read ON public.cloud_posts;
DROP POLICY IF EXISTS profiles_read_all ON public.profiles;
DROP POLICY IF EXISTS likes_read_all ON public.post_likes;
