/* chart.js —— 极简 SVG 图表（B9 统计趋势 / B10 访问分析）
 *
 * 为什么不用第三方图表库：后台只画两条折线加几个横条，为它引一个
 * 200KB 的图表库不划算，而且 CSP 里我们已经把外部脚本收口了。
 * 这里手写 SVG，产出是纯 DOM，无依赖、可被读屏软件读到标题。
 *
 * 暴露 window.WSBlogChart：
 *   line(el, {series:[{name,color,points:[y..]}], labels:[..], height})
 *   bars(el, {rows:[{label,value,hint}], unit, color, limit})
 *   sparkline(el, {points, color})
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs) {
    var node = document.createElementNS(NS, tag);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          node.setAttribute(key, attrs[key]);
        }
      }
    }
    return node;
  }

  function escapeText(value) {
    return String(value === null || value === undefined ? '' : value);
  }

  function niceMax(value) {
    var v = Math.max(1, Number(value) || 0);
    var pow = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
    for (var i = 0; i < steps.length; i++) {
      if (v <= steps[i] * pow) return steps[i] * pow;
    }
    return 10 * pow;
  }

  /* ---------------- 折线图 ---------------- */

  function line(container, opts) {
    if (!container) return;
    var o = opts || {};
    var series = (o.series || []).filter(function (s) {
      return s && s.points && s.points.length;
    });
    var labels = o.labels || [];
    var width = 680;
    var height = Number(o.height) || 180;
    var padL = 38;
    var padR = 12;
    var padT = 14;
    var padB = 26;
    var cols = Math.max.apply(
      null,
      [1].concat(
        series.map(function (s) {
          return s.points.length;
        })
      )
    );

    container.textContent = '';
    if (!series.length) {
      var empty = document.createElement('p');
      empty.className = 'chart-empty';
      empty.textContent = o.empty || '暂无数据';
      container.appendChild(empty);
      return;
    }

    var max = 0;
    series.forEach(function (s) {
      s.points.forEach(function (p) {
        if (p > max) max = p;
      });
    });
    max = niceMax(max);

    var plotW = width - padL - padR;
    var plotH = height - padT - padB;
    var svg = el('svg', {
      class: 'chart chart--line',
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      preserveAspectRatio: 'none',
    });

    // Y 轴网格 + 刻度（4 档就够，多了在窄屏上是噪点）
    for (var g = 0; g <= 4; g++) {
      var y = padT + (plotH * g) / 4;
      svg.appendChild(el('line', { x1: padL, y1: y, x2: width - padR, y2: y, class: 'chart__grid' }));
      var label = el('text', { x: padL - 6, y: y + 4, class: 'chart__ytick', 'text-anchor': 'end' });
      label.textContent = escapeText(Math.round((max * (4 - g)) / 4));
      svg.appendChild(label);
    }

    function xAt(i) {
      if (cols === 1) return padL + plotW / 2;
      return padL + (plotW * i) / (cols - 1);
    }

    function yAt(v) {
      return padT + plotH - (plotH * (Number(v) || 0)) / max;
    }

    series.forEach(function (s) {
      var color = s.color || 'var(--accent)';
      var points = s.points;
      var d = '';
      points.forEach(function (p, i) {
        d += (i ? ' L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(p).toFixed(1);
      });
      svg.appendChild(el('path', { d: d, class: 'chart__line', stroke: color }));
      // 端点只画最后一个，用作「当前值」的视觉锚点
      var last = points.length - 1;
      svg.appendChild(
        el('circle', { cx: xAt(last).toFixed(1), cy: yAt(points[last]).toFixed(1), r: 2.6, fill: color })
      );
    });

    // X 轴只标首 / 中 / 末三个日期，避免标签互相压叠
    [0, Math.floor((cols - 1) / 2), cols - 1].forEach(function (idx, n) {
      if (idx < 0 || !labels.length) return;
      var text = el('text', {
        x: xAt(idx).toFixed(1),
        y: height - 8,
        class: 'chart__xtick',
        'text-anchor': n === 0 ? 'start' : n === 2 ? 'end' : 'middle',
      });
      text.textContent = escapeText(labels[idx] || '');
      svg.appendChild(text);
    });

    container.appendChild(svg);

    if (series.length > 1) {
      var legend = document.createElement('div');
      legend.className = 'chart-legend';
      series.forEach(function (s) {
        var item = document.createElement('span');
        item.className = 'chart-legend__item';
        var dot = document.createElement('i');
        dot.className = 'chart-legend__dot';
        dot.style.background = s.color || 'var(--accent)';
        item.appendChild(dot);
        item.appendChild(document.createTextNode(s.name || ''));
        legend.appendChild(item);
      });
      container.appendChild(legend);
    }
  }

  /* ---------------- 横条榜 ---------------- */

  function bars(container, opts) {
    if (!container) return;
    var o = opts || {};
    var rows = (o.rows || []).filter(function (r) {
      return r && r.label !== undefined && r.label !== null && String(r.label) !== '';
    });
    container.textContent = '';
    if (!rows.length) {
      var empty = document.createElement('p');
      empty.className = 'chart-empty';
      empty.textContent = o.empty || '暂无数据';
      container.appendChild(empty);
      return;
    }
    var limit = Number(o.limit) || rows.length;
    rows = rows.slice(0, limit);
    var max = 0;
    rows.forEach(function (r) {
      if (r.value > max) max = r.value;
    });
    max = Math.max(1, max);

    var list = document.createElement('ul');
    list.className = 'chart-bars';
    rows.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'chart-bars__row';

      var name = document.createElement('span');
      name.className = 'chart-bars__label';
      name.textContent = String(row.label);
      if (row.hint) name.title = String(row.hint);
      li.appendChild(name);

      var track = document.createElement('span');
      track.className = 'chart-bars__track';
      var fill = document.createElement('i');
      fill.className = 'chart-bars__fill';
      fill.style.width = Math.max(2, Math.round((row.value / max) * 100)) + '%';
      if (row.color) fill.style.background = row.color;
      track.appendChild(fill);
      li.appendChild(track);

      var value = document.createElement('span');
      value.className = 'chart-bars__value';
      value.textContent =
        (o.unit === 'bytes' ? humanBytes(row.value) : String(row.value)) + (o.suffix || '');
      li.appendChild(value);

      list.appendChild(li);
    });
    container.appendChild(list);
  }

  /* ---------------- 迷你走势（表格行内用）---------------- */

  function sparkline(container, opts) {
    if (!container) return;
    var o = opts || {};
    var points = o.points || [];
    container.textContent = '';
    if (points.length < 2) return;
    var w = 96;
    var h = 22;
    var max = Math.max.apply(null, points.concat([1]));
    var svg = el('svg', {
      class: 'chart chart--spark',
      viewBox: '0 0 ' + w + ' ' + h,
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    });
    var d = '';
    points.forEach(function (p, i) {
      var x = (w * i) / (points.length - 1);
      var y = h - (h - 3) * ((Number(p) || 0) / max) - 1.5;
      d += (i ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
    svg.appendChild(el('path', { d: d, class: 'chart__line', stroke: o.color || 'var(--accent)' }));
    container.appendChild(svg);
  }

  function humanBytes(n) {
    var v = Number(n) || 0;
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + units[i];
  }

  window.WSBlogChart = {
    line: line,
    bars: bars,
    sparkline: sparkline,
    humanBytes: humanBytes,
  };
})();
