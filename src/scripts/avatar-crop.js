/**
 * 头像裁剪与压缩（缺口 M12）。
 *
 * 之前的行为是「选中一张手机原图 → 直接上传 → 原图地址写进 profiles.avatar_url」，
 * 结果是：列表页要下载几 MB 的图只为画一个 40px 的圆圈，而且构图完全不可控
 * （人像偏在角落、长图被压扁）。这里补上标准的两步：
 *
 *   1. 在 256×256 的画布上做**正方形裁剪**（拖动平移 + 缩放），所见即所得；
 *   2. 导出为 JPEG（quality 0.88）再上传，通常 10–30 KB。
 *
 * 依赖：assets/cloud.js（会话）、assets/upload.js（上传与魔数校验）。
 * DOM 契约见 wsblog/templates/pages.py::account_page 里的 [data-avatar-modal]。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var OUTPUT = 256; /* 输出边长（像素） */
  var QUALITY = 0.88; /* JPEG 质量：肉眼无损，体积约为 PNG 的 1/4 */
  var MAX_INPUT_MB = 8; /* 原图上限，超过就明确拒绝而不是让浏览器卡死 */

  var modal = q('[data-avatar-modal]');
  var canvas = q('[data-crop-canvas]');
  var stage = q('[data-crop-stage]');
  var zoomEl = q('[data-crop-zoom]');
  var applyBtn = q('[data-crop-apply]');
  var cancelBtn = q('[data-crop-cancel]');

  /* 当前裁剪会话。同一时刻只允许一个 —— 弹窗是模态的。 */
  var session = null;

  function q(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function t(key, fallback) {
    if (typeof window.__wsT === 'function') {
      var str = window.__wsT(key, fallback);
      if (str) return str;
    }
    return fallback || key;
  }

  function toast(message) {
    C.toast(message);
  }

  /* ---------------- 画布绘制 ---------------- */

  /** 按当前 zoom / 偏移把图片画进正方形画布，并把偏移夹在合法范围内。 */
  function draw() {
    if (!canvas || !session || !session.img) return;
    var size = canvas.width; /* 与 CSS 尺寸解耦，固定 256 */
    var ctx = canvas.getContext('2d');
    var img = session.img;

    /* 基准缩放：让短边刚好铺满画布（cover），再乘用户缩放 */
    var base = size / Math.min(img.width, img.height);
    var scale = base * session.zoom;
    var w = img.width * scale;
    var h = img.height * scale;

    /* 图片必须始终覆盖整个画布：x ∈ [size-w, 0]，y ∈ [size-h, 0] */
    var x = Math.min(0, Math.max(size - w, (size - w) / 2 + session.ox));
    var y = Math.min(0, Math.max(size - h, (size - h) / 2 + session.oy));
    session.ox = x - (size - w) / 2;
    session.oy = y - (size - h) / 2;

    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x, y, w, h);

    /* 三分线辅助构图（只画在预览上，不会进导出结果） */
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.lineWidth = 1;
    for (var i = 1; i <= 2; i++) {
      var p = Math.round((size / 3) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 导出 ---------------- */

  /** canvas → JPEG Blob。老浏览器没有 toBlob 时退回 dataURL 再手工转二进制。 */
  function toBlob() {
    return new Promise(function (resolve, reject) {
      if (!canvas) {
        reject(new Error(t('account.cropFail', '裁剪失败，请重试')));
        return;
      }
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob(
          function (blob) {
            if (blob) resolve(blob);
            else reject(new Error(t('account.cropFail', '裁剪失败，请重试')));
          },
          'image/jpeg',
          QUALITY
        );
        return;
      }
      try {
        var dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
        var base64 = dataUrl.split(',')[1] || '';
        var bin = atob(base64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/jpeg' }));
      } catch (err) {
        reject(new Error(t('account.cropFail', '裁剪失败，请重试')));
      }
    });
  }

  /**
   * 上传裁剪结果。上传模块缺失时（例如脚本被拦截）退化为「只给 dataURL」，
   * 调用方仍能把头像显示出来，只是没有持久化地址。
   */
  function upload(blob, options) {
    var opts = options || {};
    var name = (opts.filename || 'avatar') + '.jpg';
    if (!window.WSBlogUpload || typeof window.WSBlogUpload.uploadFile !== 'function') {
      return Promise.resolve({ url: '', blob: blob, path: '' });
    }
    var file;
    try {
      file = new File([blob], name, { type: 'image/jpeg' });
    } catch (err) {
      file = blob;
    }
    return window.WSBlogUpload
      .uploadFile(
        file,
        {
          folder: opts.folder || 'avatars',
          filename: opts.filename || 'avatar',
          upsert: true,
        },
        { mime: 'image/jpeg', ext: '.jpg' }
      )
      .then(function (res) {
        return { url: res.url, path: res.path, blob: blob };
      });
  }

  /* ---------------- 弹窗开关 ---------------- */

  function open() {
    if (!modal) return;
    modal.removeAttribute('hidden');
    document.body.classList.add('is-modal-open');
  }

  function close() {
    if (!modal) return;
    modal.setAttribute('hidden', '');
    document.body.classList.remove('is-modal-open');
  }

  function finish(result) {
    var current = session;
    session = null;
    close();
    if (zoomEl) zoomEl.value = '100';
    if (current) {
      if (current.img && current.img.src && current.img.src.indexOf('blob:') === 0) {
        URL.revokeObjectURL(current.img.src);
      }
      current.settle(result);
    }
  }

  /* ---------------- 交互 ---------------- */

  function bindOnce() {
    if (!modal || modal.getAttribute('data-crop-bound')) return;
    modal.setAttribute('data-crop-bound', '1');

    if (zoomEl) {
      zoomEl.addEventListener('input', function () {
        if (!session) return;
        var value = parseInt(zoomEl.value, 10);
        session.zoom = (isNaN(value) ? 100 : Math.min(320, Math.max(100, value))) / 100;
        draw();
      });
    }

    /* 拖动平移。用 Pointer Events 一套代码覆盖鼠标 / 触摸 / 触控笔。 */
    if (stage) {
      stage.addEventListener('pointerdown', function (e) {
        if (!session) return;
        session.drag = { x: e.clientX, y: e.clientY, ox: session.ox, oy: session.oy };
        stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
        stage.classList.add('is-dragging');
        e.preventDefault();
      });
      stage.addEventListener('pointermove', function (e) {
        if (!session || !session.drag) return;
        /* 画布 CSS 尺寸与逻辑尺寸可能不同，按比例换算拖动距离 */
        var rect = canvas ? canvas.getBoundingClientRect() : null;
        var ratio = rect && rect.width ? canvas.width / rect.width : 1;
        session.ox = session.drag.ox + (e.clientX - session.drag.x) * ratio;
        session.oy = session.drag.oy + (e.clientY - session.drag.y) * ratio;
        draw();
      });
      var endDrag = function (e) {
        if (!session) return;
        session.drag = null;
        stage.classList.remove('is-dragging');
        if (e && stage.releasePointerCapture && e.pointerId != null) {
          try {
            stage.releasePointerCapture(e.pointerId);
          } catch (err) {
            /* 指针已经释放，忽略 */
          }
        }
      };
      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);
      stage.addEventListener('pointerleave', endDrag);
    }

    if (cancelBtn) cancelBtn.addEventListener('click', function () { finish(null); });

    if (applyBtn) {
      applyBtn.addEventListener('click', function () {
        if (!session) return;
        var current = session;
        applyBtn.disabled = true;
        var label = applyBtn.textContent;
        applyBtn.textContent = t('account.cropReading', '处理中…');

        toBlob()
          .then(function (blob) {
            return upload(blob, {
              uid: current.uid,
              folder: 'avatars',
              filename: current.filename,
            }).then(function (res) {
              res.blob = blob;
              return res;
            });
          })
          .then(function (res) {
            finish(res);
          })
          .catch(function (err) {
            session = current;
            toast((err && err.message) || t('account.cropFail', '裁剪失败，请重试'));
          })
          .then(function () {
            applyBtn.disabled = false;
            applyBtn.textContent = label;
          });
      });
    }

    /* 点击遮罩关闭；Esc 关闭 */
    modal.addEventListener('click', function (e) {
      if (e.target === modal) finish(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && session) finish(null);
    });
  }

  /* ---------------- 对外入口 ---------------- */

  /**
   * 选图 → 裁剪 → 压缩 → 上传。
   * options: { uid, filename, folder, accept, maxMB }
   * resolve: { url, path, blob }；用户取消时 resolve(null)。
   */
  function pick(options) {
    var opts = options || {};
    if (!modal || !canvas) {
      return Promise.reject(new Error(t('account.cropFail', '当前页面不支持头像裁剪')));
    }
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = opts.accept || 'image/*';

      input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) {
          resolve(null);
          return;
        }
        var maxMB = opts.maxMB || MAX_INPUT_MB;
        if (file.size > maxMB * 1024 * 1024) {
          reject(new Error('原图不能超过 ' + maxMB + ' MB，请先压缩或换一张'));
          return;
        }

        /* 用上传模块的魔数校验挡掉伪装成图片的文件（upload.js 是唯一裁判） */
        var check =
          window.WSBlogUpload && window.WSBlogUpload.verifyFile
            ? window.WSBlogUpload.verifyFile(file, 'image/*')
            : Promise.resolve(null);

        check
          .then(function () {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
              session = {
                img: img,
                zoom: 1,
                ox: 0,
                oy: 0,
                drag: null,
                uid: opts.uid || '',
                filename: opts.filename || 'avatar',
                settle: resolve,
              };
              if (zoomEl) zoomEl.value = '100';
              open();
              draw();
            };
            img.onerror = function () {
              URL.revokeObjectURL(url);
              reject(new Error('这张图片没能读取出来，请换一张'));
            };
            img.src = url;
          })
          .catch(reject);
      };

      input.click();
    });
  }

  /* 页面加载时就把弹窗事件挂好：account.js 只负责调用 pick()。 */
  if (modal) bindOnce();

  window.WSBlogAvatar = {
    pick: pick,
    outputSize: OUTPUT,
    quality: QUALITY,
    isOpen: function () {
      return !!session;
    },
  };
})();
