-- ============================================================================
-- 2026-10-13 第一批安全止血 · 评论写入校验
--
-- 背景（见 docs/2026-10-13-安全与功能评估.md 第 1.2 节）：
--   comments 的 INSERT/UPDATE 完全由客户端决定 author_name、content 长度、
--   status 取值、parent_id 归属与 created_at。comments_own_all 只校验
--   owner_id 与 is_active()，于是任何登录用户都能：
--     · 把 author_name 写成站长的昵称（评论区无法分辨真伪）；
--     · 提交任意长度正文（前端 1000 字上限可绕过）；
--     · 指定 status，跳过审核；
--     · 把 parent_id 指向别的文章 / 任意 id（串楼）；
--     · 改 created_at 干扰排序。
--
-- 本迁移把「作者身份 + 内容边界」收归服务端：
--   1) BEFORE INSERT/UPDATE 触发器 comments_stamp_author()
--      —— owner_id / author_name 一律由服务端派生，其余字段做规范化与白名单；
--   2) 表级 CHECK 约束兜底（即使走 service role 直写也拦得住）；
--   3) parent_id 外键由 ON DELETE CASCADE 改为 ON DELETE SET NULL。
--      原行为下，作者删掉自己的一条评论会「静默连坐」删掉挂在它下面的
--      他人回复；改成 SET NULL 后回复降级为顶层评论保留（renderComments
--      本来就把 parent_id 为空的行当作顶层渲染）。
--
-- 应用方式：下面的语句一条一条执行（云服务 REST 通道一次只接受一条语句）。
-- ============================================================================

-- ① 触发器函数：作者身份与字段边界全部由服务端决定
CREATE OR REPLACE FUNCTION public.comments_stamp_author()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_nickname text;
  v_parent   public.comments;
BEGIN
  -- 1) 作者身份以服务端为准：客户端传来的 owner_id / author_name 一律不采信
  IF TG_OP = 'INSERT' THEN
    NEW.owner_id := auth.uid()::text;
  END IF;
  IF NEW.owner_id IS NULL OR NEW.owner_id = '' THEN
    RAISE EXCEPTION '评论必须由登录用户提交' USING ERRCODE = '42501';
  END IF;

  SELECT NULLIF(btrim(coalesce(nickname, '')), '') INTO v_nickname
    FROM public.profiles
   WHERE owner_id = NEW.owner_id;

  IF v_nickname IS NOT NULL THEN
    NEW.author_name := left(v_nickname, 60);
  ELSIF TG_OP = 'UPDATE' AND NULLIF(btrim(coalesce(OLD.author_name, '')), '') IS NOT NULL THEN
    -- 资料行缺失（历史数据）时保留已存在的显示名，避免把老评论改名成"读者"
    NEW.author_name := left(OLD.author_name, 60);
  ELSE
    NEW.author_name := '读者';
  END IF;

  -- 2) 正文：去空白、非空、封顶 1000 字（与前端一致，但由服务端强制）
  NEW.content := btrim(coalesce(NEW.content, ''));
  IF char_length(NEW.content) = 0 THEN
    RAISE EXCEPTION '评论内容不能为空' USING ERRCODE = '23514';
  END IF;
  NEW.content := left(NEW.content, 1000);

  -- 3) 状态只接受白名单取值，其余一律回落 visible
  IF NEW.status IS NULL OR NEW.status NOT IN ('visible', 'hidden', 'pending') THEN
    NEW.status := 'visible';
  END IF;

  -- 4) 时间戳由服务端定稿，避免作者改 created_at 干扰排序
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;

  -- 5) 楼层归属：只能回复「同一篇文章的顶层评论」（禁跨楼串楼与自引用）
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

-- ② 绑定触发器
DROP TRIGGER IF EXISTS comments_stamp_author_trg ON public.comments;

CREATE TRIGGER comments_stamp_author_trg
  BEFORE INSERT OR UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.comments_stamp_author();

-- ③ 表级约束兜底
ALTER TABLE public.comments
  ADD CONSTRAINT comments_content_len_chk CHECK (char_length(content) BETWEEN 1 AND 1000);

ALTER TABLE public.comments
  ADD CONSTRAINT comments_status_chk CHECK (status IN ('visible', 'hidden', 'pending'));

ALTER TABLE public.comments
  ADD CONSTRAINT comments_slug_len_chk CHECK (char_length(post_slug) BETWEEN 1 AND 200);

ALTER TABLE public.comments
  ADD CONSTRAINT comments_author_len_chk CHECK (char_length(coalesce(author_name, '')) <= 60);

-- ④ parent_id 外键：删父评论不再连坐删掉别人的回复
ALTER TABLE public.comments DROP CONSTRAINT comments_parent_id_fkey;

ALTER TABLE public.comments
  ADD CONSTRAINT comments_parent_id_fkey FOREIGN KEY (parent_id)
  REFERENCES public.comments(id) ON DELETE SET NULL;
