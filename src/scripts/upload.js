/**
 * 文件上传（CloudBase 存储）。
 *
 * 所有上传都进 runtime bucket：后台编辑器插图放 blog/，头像放 avatars/。
 * 使用方式与 supabase-js 一致：storage.from('runtime').upload(path, file)，
 * 之后再 getPublicUrl(path) 拿公开访问地址。
 *
 * 登录用户才能上传（存储策略按会话校验）；失败时把服务端错误透传给调用方 toast。
 */

(function () {
  'use strict';

  var C = window.WSBlogCloud;
  if (!C) return;

  var BUCKET = 'runtime';

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function extOf(name) {
    var match = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
    return match ? '.' + match[1].toLowerCase() : '';
  }

  /* ---------- 文件类型校验（按文件头魔数，不信 file.type） ----------
     背景见 docs/2026-10-13-安全与功能评估.md 第 1.3 节：
     浏览器给的 file.type 完全可伪造，服务端也没有类型白名单，而上传落盘后
     的公开地址与站点同源（`{endpoint}/.cloud/storage/object/public/runtime/…`）。
     于是"上传一个 .html / .svg 再直接打开它的公开地址"就是一条存储型 XSS ——
     能读到 localStorage 里的会话令牌。因此：只按魔数认定真实类型，
     并且**落盘扩展名一律由魔数决定**，让伪装扩展名失效。 */
  var IMAGE_SIGNATURES = [
    {
      mime: 'image/jpeg', ext: '.jpg', need: 3,
      match: function (b) { return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; },
    },
    {
      mime: 'image/png', ext: '.png', need: 8,
      match: function (b) {
        return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
          b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
      },
    },
    {
      mime: 'image/gif', ext: '.gif', need: 4,
      match: function (b) { return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38; },
    },
    {
      mime: 'image/webp', ext: '.webp', need: 12,
      match: function (b) {
        return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
          b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
      },
    },
    {
      mime: 'image/avif', ext: '.avif', need: 12,
      match: function (b) {
        return b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
          b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66;
      },
    },
    {
      mime: 'image/bmp', ext: '.bmp', need: 2,
      match: function (b) { return b[0] === 0x42 && b[1] === 0x4d; },
    },
  ];

  /* 非图片场景（目前站点全部是 image/*，留作扩展口）：只放行无执行能力的文档类扩展名 */
  var SAFE_DOC_EXTS = ['.pdf', '.txt', '.md', '.csv', '.zip'];

  function readHead(file, bytes) {
    return new Promise(function (resolve) {
      try {
        var slice = file.slice(0, bytes);
        if (slice && typeof slice.arrayBuffer === 'function') {
          slice.arrayBuffer().then(function (buf) {
            resolve(new Uint8Array(buf));
          }, function () { resolve(null); });
          return;
        }
        var reader = new FileReader();
        reader.onload = function () { resolve(new Uint8Array(reader.result)); };
        reader.onerror = function () { resolve(null); };
        reader.readAsArrayBuffer(slice);
      } catch (err) {
        resolve(null);
      }
    });
  }

  function sniffImage(head) {
    if (!head) return null;
    for (var i = 0; i < IMAGE_SIGNATURES.length; i++) {
      var sig = IMAGE_SIGNATURES[i];
      if (head.length >= sig.need && sig.match(head)) return sig;
    }
    return null;
  }

  /**
   * 校验并返回"判定出的图片签名"（非图片场景返回 null）。
   * 判定失败时 reject，调用方直接把 message 透传给 toast。
   */
  function verifyFile(file, accept) {
    var wantImage = !accept || accept.indexOf('image/') === 0;
    return readHead(file, 16).then(function (head) {
      var sig = sniffImage(head);
      if (sig) return sig;
      var ext = extOf(file.name);
      if (wantImage) {
        if (String(file.type) === 'image/svg+xml' || ext === '.svg') {
          throw new Error('SVG 可以内嵌脚本，本站不接受，请改用 PNG / JPG');
        }
        throw new Error('这不是有效的图片文件（按文件内容判定，改扩展名无效）');
      }
      if (SAFE_DOC_EXTS.indexOf(ext) < 0) {
        throw new Error('不支持的文件类型：' + (ext || extOf(file.name) || '未知'));
      }
      return null;
    });
  }

  /**
   * 打开文件选择框，选中后校验并上传。
   * options: { accept, maxMB, folder, filename, upsert }
   * resolve: { url, path }
   */
  function pickAndUpload(options) {
    var opts = options || {};
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      if (opts.accept) input.accept = opts.accept;

      input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) {
          reject(new Error('未选择文件'));
          return;
        }
        var maxMB = opts.maxMB || 5;
        if (file.size > maxMB * 1024 * 1024) {
          reject(new Error('文件不能超过 ' + maxMB + ' MB'));
          return;
        }
        verifyFile(file, opts.accept).then(function (signature) {
          return uploadFile(file, opts, signature).then(resolve, reject);
        }, reject);
      };

      input.click();
    });
  }

  function uploadFile(file, options, signature) {
    var opts = options || {};
    var sig = signature || null;
    var now = new Date();
    var folder = String(opts.folder || 'blog').replace(/^\/+|\/+$/g, '');
    var base =
      opts.filename ||
      String(now.getTime()) + '-' + Math.random().toString(36).slice(2, 8);
    /* 扩展名以魔数判定结果为准：把 a.html 改名成 a.png 传上来，也只落成 .png */
    var ext = sig ? sig.ext : extOf(file.name);
    var path = folder + '/' + now.getFullYear() + pad2(now.getMonth() + 1) + '/' + base + ext;

    /* 让 multipart 里的 Content-Type 与真实类型一致（浏览器原样发送 file.type） */
    var payload = file;
    if (sig) {
      try {
        payload = new File([file], base + ext, { type: sig.mime });
      } catch (err) {
        payload = file;
      }
    }

    var bucket = C.storage().from(BUCKET);
    return bucket
      .upload(path, payload, { upsert: !!opts.upsert, cacheControl: '3600' })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var pub = bucket.getPublicUrl(path);
        var url = (pub && pub.data && pub.data.publicUrl) || '';
        if (!url) throw new Error('上传成功，但没能拿到访问地址');
        /* 覆盖上传时同名 URL 会被缓存，追加版本参数强制刷新 */
        if (opts.upsert) url += '?v=' + now.getTime();
        return { url: url, path: path };
      });
  }

  window.WSBlogUpload = {
    pickAndUpload: pickAndUpload,
    uploadFile: uploadFile,
    verifyFile: verifyFile,
    BUCKET: BUCKET,
  };
})();
