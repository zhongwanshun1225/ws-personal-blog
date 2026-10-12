"""WS Blog 的 Python 构建内核。

模块划分：

- ``util``         通用工具（转义、slug、日期、阅读时长…）
- ``frontmatter``  front-matter 解析
- ``highlight``    Pygments → highlight.js class 的代码高亮
- ``markdown``     Markdown → HTML 渲染（含 TOC 收集、提示块）
- ``content``      content/ 目录的内容加载
- ``templates``    页面外壳与各页面模板
- ``server``       本地预览服务器（自动重建）
"""

__version__ = "2.0.0"
__all__ = ["__version__"]
