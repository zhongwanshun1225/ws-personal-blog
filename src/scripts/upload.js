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

  /**
   * 打开文件选择框，选中后上传。
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
        if (file.type && opts.accept === 'image/*' && file.type.indexOf('image/') !== 0) {
          reject(new Error('请选择图片文件'));
          return;
        }
        uploadFile(file, opts).then(resolve, reject);
      };

      input.click();
    });
  }

  function uploadFile(file, options) {
    var opts = options || {};
    var now = new Date();
    var folder = String(opts.folder || 'blog').replace(/^\/+|\/+$/g, '');
    var base =
      opts.filename ||
      String(now.getTime()) + '-' + Math.random().toString(36).slice(2, 8);
    var path = folder + '/' + now.getFullYear() + pad2(now.getMonth() + 1) + '/' + base + extOf(file.name);

    var bucket = C.storage().from(BUCKET);
    return bucket
      .upload(path, file, { upsert: !!opts.upsert, cacheControl: '3600' })
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

  window.WSBlogUpload = { pickAndUpload: pickAndUpload, uploadFile: uploadFile, BUCKET: BUCKET };
})();
