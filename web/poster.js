/*
 * 海报 OCR 结果 → 时刻表（与 data/schedule.js 同构）。纯函数、不碰 DOM：浏览器里挂 window.LZM_POSTER，
 * node 里 require 得到（tools/test_poster.js 就这么测）。日期运算借 logic.js，所以 index.html 里要排在它后面。
 *
 *   OCR 行 ──摆正──> 表头定列 ──> 时间行按行距成格 ──日期框挂到最近的格──> 子行 ──DP 对到──> 节目名块
 *          ──> 草稿（每个子行 = 一段「日期文本」+ 一段「场次文本」）──rebuild──> 规则 + issues
 *
 * 草稿是故意留的中间层：预览页改的就是子行文本，改完照样走 rebuild。首次解析和人工改过的结果
 * 走同一条路，单测钉住解析也就钉住了编辑后的规则生成与校验。
 *
 * 只认这一家海报的版式（三列「演出名称 / 日期 / 备注」，一个节目拆几行子行），不追求通用表格识别。
 * 认不准的地方不猜：一律落成 warn 级 issue，预览页标黄让人对照原图确认。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var P = factory(isNode ? require('./logic.js') : root.LZM_LOGIC);
  if (isNode) module.exports = P;
  else root.LZM_POSTER = P;
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  var P = {};

  // 低于这个置信度的时间 / 日期 / 备注框一律报 warn。0.85：原海报样张（poster-1124.ocr.json，2026-11-26 识别）
  // 时间框最低 0.94，「日常」这种两字小框掉到 0.72，低分只出现在真正难认的地方。
  P.LOW_CONF = 0.85;
  // 以下长度都以 u（表体文字的中位行高）为单位，缩放后的图照样适用。
  // 只用于「那一行没认出时间」时把落单的日期框按间隙成组；有时间行的子行不靠它（见 pitchThreshold）。
  var DATE_CELL_GAP = 0.2;
  // 时间行「折行」与「换子行」的行距分界（单位：时间框高度）。只是兜底，实际按 pitchThreshold 现算。
  var LINE_PITCH = 1.15;
  var SPAN_LIMIT_DAYS = 62;

  // ── 文字归一 ─────────────────────────────────
  //
  // 逐字一对一替换、不增删字符：解析在归一后的串上做，取备注原文时按同一下标回原串去切。

  var DASH = '—–―‐‑‒−~〜';
  function norm(s) {
    s = String(s == null ? '' : s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i), ch = s[i];
      if (c >= 0xFF01 && c <= 0xFF5E) ch = String.fromCharCode(c - 0xFEE0);
      else if (c === 0x3000 || c === 0xA0) ch = ' ';
      else if (ch === '︰' || ch === '∶') ch = ':';
      if (ch === '~' || DASH.indexOf(ch) >= 0) ch = '-';
      out += ch;
    }
    // 「一」夹在数字之间是连字符被认成了汉字一（16:30一17:10、26日一28日）；O 贴着数字是 0。
    return out.replace(/([\d日])(\s*)一(?=\s*\d)/g, '$1$2-')
      .replace(/([\d:])[Oo〇]/g, '$10').replace(/[Oo〇](?=[\d:])/g, '0');
  }
  P.norm = norm;

  var CN = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  function cnNum(s) {
    s = String(s);
    if (/^\d+$/.test(s)) return +s;
    var m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
    if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
    return s.length === 1 && CN[s] != null ? CN[s] : NaN;
  }
  P.cnNum = cnNum;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ── 时间 ─────────────────────────────────

  // 冒号也认「.」：OCR 偶尔把冒号认成点。连字符在 norm 里已经统一成 -。
  var TIME_RE = /(\d{1,2})\s*[:.]\s*(\d{2})\s*(?:-+|至|到)\s*(\d{1,2})\s*[:.]\s*(\d{2})/g;

  /** 一段文字里的全部时间段（按出现顺序），以及挖掉它们之后剩下的文字的位置。 */
  function scanTimes(t) {
    var out = [], m;
    TIME_RE.lastIndex = 0;
    while ((m = TIME_RE.exec(t))) {
      out.push({ sh: +m[1], sm: +m[2], eh: +m[3], em: +m[4], at: m.index, end: m.index + m[0].length, src: m[0] });
    }
    return out;
  }
  function hasTime(t) { TIME_RE.lastIndex = 0; var r = TIME_RE.test(t); TIME_RE.lastIndex = 0; return r; }
  // 认坏了的时间（「21:08-21523」）也得当时间行走，后面才会被报成「没看懂」；当成备注就悄悄丢了一场。
  function looksTime(t) { return hasTime(t) || /\d{1,2}\s*[:.]\s*\d{2}\s*-|\d{1,2}\s*:\s*\d{2}/.test(t); }
  function hmOk(h, m) { return h >= 0 && h <= 24 && m >= 0 && m < 60 && !(h === 24 && m > 0); }
  function hmStr(h, m) { return pad2(h) + ':' + pad2(m); }

  // ── 星期 / 日常 ─────────────────────────────────

  var WD = { '日': 0, '天': 0, '七': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
  var WD_RE = /(?:周|星期|礼拜)([一二三四五六日天七])(?:\s*(?:至|到|-)\s*(?:周|星期|礼拜)?([一二三四五六日天七]))?/g;
  var WD_WORD_RE = /周末|双休日|工作日|平日/g;

  /** 「周五/周六」「周一至周五」「周末」→ [5,6] 等；没有就 null。 */
  function scanWeekdays(t) {
    var set = {}, any = false, m;
    WD_RE.lastIndex = 0;
    while ((m = WD_RE.exec(t))) {
      any = true;
      var a = WD[m[1]], b = m[2] != null ? WD[m[2]] : a;
      // 周一至周日：日按 7 算，范围才走得通
      var aa = a === 0 ? 7 : a, bb = b === 0 ? 7 : b;
      if (m[2] != null && bb >= aa) for (var k = aa; k <= bb; k++) set[k % 7] = 1;
      else { set[a] = 1; set[b] = 1; }
    }
    WD_WORD_RE.lastIndex = 0;
    while ((m = WD_WORD_RE.exec(t))) {
      any = true;
      if (m[0] === '周末' || m[0] === '双休日') { set[6] = 1; set[0] = 1; }
      else [1, 2, 3, 4, 5].forEach(function (d) { set[d] = 1; });
    }
    return any ? Object.keys(set).map(Number).sort() : null;
  }

  var DEFAULT_LABEL_RE = /^(日常|平时|平常|每天|每日|其余|其他日期|其它日期)$/;

  /** 时间行前面那个小标签：「日常」→ 'default'，「周五/周六」→ [5,6]，别的 → null。 */
  function parseLabel(t) {
    var s = t.replace(/[\s:()（）]/g, '');
    if (!s) return null;
    if (DEFAULT_LABEL_RE.test(s)) return 'default';
    var w = scanWeekdays(s);
    if (w && !s.replace(WD_RE, '').replace(WD_WORD_RE, '').replace(/[\/、,，和及与]/g, '')) return w;
    return null;
  }

  // ── 日期 ─────────────────────────────────

  function ymdOf(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  function validMD(m, d) { return m >= 1 && m <= 12 && d >= 1 && d <= 31; }
  function dayDiff(a, b) {
    var pa = a.split('-'), pb = b.split('-');
    return Math.round((new Date(+pa[0], pa[1] - 1, +pa[2]) - new Date(+pb[0], pb[1] - 1, +pb[2])) / 86400000);
  }
  function realDate(y, m, d) {
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  /** 海报不写年份：在 today 前后一年里挑离 today 最近的那个（12 月导下一年 1 月的海报就落到明年）。 */
  P.inferYear = function (m, d, today) {
    var ty = +String(today).slice(0, 4), best = ty, bd = Infinity;
    [ty - 1, ty, ty + 1].forEach(function (y) {
      if (!realDate(y, m, d)) return;
      var dd = Math.abs(dayDiff(ymdOf(y, m, d), today));
      if (dd < bd) { bd = dd; best = y; }
    });
    return best;
  };

  /**
   * 标题里的有效期：「11月24日至30日」「11月30日至12月6日」「12月29日-1月4日」。
   * 结束月日早于开始就当跨年。认不出返回 null。
   */
  P.parseValidity = function (text, today) {
    var t = norm(text).replace(/\s+/g, '');
    var m = /(\d{1,2})月(\d{1,2})[日号]?(?:至|到|-+)(?:(\d{1,2})月)?(\d{1,2})[日号]?/.exec(t) ||
      /(\d{1,2})[.\/](\d{1,2})(?:至|到|-+)(?:(\d{1,2})[.\/])?(\d{1,2})(?!\d)/.exec(t);
    if (!m) return null;
    var m1 = +m[1], d1 = +m[2], m2 = m[3] ? +m[3] : m1, d2 = +m[4];
    if (!validMD(m1, d1) || !validMD(m2, d2)) return null;
    var y1 = P.inferYear(m1, d1, today);
    var y2 = m2 * 100 + d2 < m1 * 100 + d1 ? y1 + 1 : y1;
    if (!realDate(y1, m1, d1) || !realDate(y2, m2, d2)) return null;
    return { from: ymdOf(y1, m1, d1), to: ymdOf(y2, m2, d2) };
  };

  /** 子行里只有月日：挑让它离有效期最近的那一年。 */
  function resolveYmd(m, d, ctx) {
    var fy = ctx && ctx.from ? +ctx.from.slice(0, 4) : new Date().getFullYear();
    var best = null, bd = Infinity;
    [fy - 1, fy, fy + 1].forEach(function (y) {
      if (!realDate(y, m, d)) return;
      var s = ymdOf(y, m, d);
      var dd = !ctx || !ctx.from ? 0 : s < ctx.from ? dayDiff(ctx.from, s) : ctx.to && s > ctx.to ? dayDiff(s, ctx.to) : 0;
      if (dd < bd) { bd = dd; best = s; }
    });
    return best;
  }

  var COUNT_RE = /每[天日]\s*([0-9一二两三四五六七八九十]{1,3})\s*场/;
  var EVERY_RE = /每[天日](?:演出|开放|都演|均演|营业|开演)?|全天/;
  var CLOSED_RE = /公休|休演|停演|不演|暂停演出|暂停|闭馆|闭园/;
  var DATE_TOKEN_RE = /(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号]?/g;

  /**
   * 日期列文字 → { count, every, dates, closed, weekdays, bad }。
   *
   * 一段里的日期 token 之间夹「至 / 到 / -」是区间，别的（/、空格）是并列；
   * 没写月份的跟前一个 token 的月，第一个也没写就按有效期推。
   * 「公休」管它所在那一段的日期，那一段没日期就管前一段（「11月24日 公休」中间断开时）。
   */
  P.parseDateText = function (text, ctx) {
    var raw = norm(text);
    var out = { count: null, every: false, dates: [], closed: [], weekdays: null, label: null, bad: [], empty: !raw.trim() };
    var t = raw;
    var cm = COUNT_RE.exec(t);
    if (cm) { out.count = cnNum(cm[1]); t = t.replace(cm[0], ' '); }
    if (EVERY_RE.test(t)) { out.every = true; t = t.replace(new RegExp(EVERY_RE.source, 'g'), ' '); }
    var wd = scanWeekdays(t);
    if (wd) { out.weekdays = wd; t = t.replace(WD_RE, ' ').replace(WD_WORD_RE, ' '); }
    if (/日常|平时|其余/.test(t)) { out.label = 'default'; t = t.replace(/日常|平时|其余/g, ' '); }
    t = t.replace(/[仅只]|演出|开放/g, ' ');

    var segs = t.split(/[\s,，;；]+/).filter(Boolean);
    var lastMonth = null, prevSeg = null;
    segs.forEach(function (seg) {
      var isClosed = CLOSED_RE.test(seg);
      var body = seg.replace(new RegExp(CLOSED_RE.source, 'g'), '');
      var toks = [], m;
      DATE_TOKEN_RE.lastIndex = 0;
      while ((m = DATE_TOKEN_RE.exec(body))) {
        toks.push({ mo: m[1] ? +m[1] : null, d: +m[2], at: m.index, end: m.index + m[0].length });
      }
      var rest = body, dates = [];
      toks.slice().reverse().forEach(function (k) { rest = rest.slice(0, k.at) + ' ' + rest.slice(k.end); });
      rest = rest.replace(/至|到|-+|[\/、和及与.]/g, '').trim();
      if (rest) out.bad.push(seg);
      for (var i = 0; i < toks.length; i++) {
        var k = toks[i];
        var mo = k.mo || lastMonth || guessMonth(k.d, ctx);
        if (!mo || !validMD(mo, k.d)) { out.bad.push(seg); continue; }
        lastMonth = mo;
        var a = resolveYmd(mo, k.d, ctx);
        if (!a) { out.bad.push(seg); continue; }
        var next = toks[i + 1];
        var between = next ? body.slice(k.end, next.at).trim() : '';
        if (next && /^(至|到|-+)$/.test(between)) {
          var mo2 = next.mo || mo;
          if (!validMD(mo2, next.d)) { out.bad.push(seg); i++; continue; }
          var b = resolveYmd(mo2, next.d, ctx);
          if (b && b < a && !next.mo) b = null;
          if (!b || dayDiff(b, a) < 0 || dayDiff(b, a) > SPAN_LIMIT_DAYS) { out.bad.push(seg); i++; continue; }
          for (var x = a; x <= b; x = L.addDays(x, 1)) dates.push(x);
          lastMonth = mo2;
          i++;
        } else {
          dates.push(a);
        }
      }
      if (isClosed) {
        if (dates.length) out.closed = out.closed.concat(dates);
        else if (prevSeg && prevSeg.dates.length && !prevSeg.closed) {
          // 「11月24日 公休」被空格拆成两段：把前一段的日期挪到公休里
          out.dates = out.dates.filter(function (d) { return prevSeg.dates.indexOf(d) < 0; });
          out.closed = out.closed.concat(prevSeg.dates);
        }
      } else {
        out.dates = out.dates.concat(dates);
      }
      prevSeg = { dates: dates, closed: isClosed };
    });
    out.dates = uniqSorted(out.dates);
    out.closed = uniqSorted(out.closed);
    return out;
  };

  function guessMonth(d, ctx) {
    if (!ctx || !ctx.from) return null;
    var fm = +ctx.from.slice(5, 7), fd = +ctx.from.slice(8, 10);
    var tm = ctx.to ? +ctx.to.slice(5, 7) : fm;
    return d >= fd || tm === fm ? fm : tm;
  }

  function uniqSorted(a) {
    var seen = {}, out = [];
    a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
    return out.sort();
  }

  /** 这段文字里有没有日期列该有的东西（场数、日期、公休、星期）。 */
  function hasDatePhrase(t) {
    return COUNT_RE.test(t) || EVERY_RE.test(t) || /\d{1,2}\s*月\s*\d{1,2}|\d{1,2}\s*[日号]/.test(t) ||
      (CLOSED_RE.test(t) && /\d/.test(t)) || !!scanWeekdays(t);
  }

  // ── 场次文本 ─────────────────────────────────
  //
  // 预览页可编辑的那一行字，也是草稿里存的形态：
  //   「09:30-10:10 / 10:40-11:20」「19:18-19:33（打铁花+低空烟花） / 21:08-21:23」
  //   「日常 10:00-17:30；周五/周六 10:00-20:30」（分号隔开的段各带一个标签）

  /** 场次文本 → { lines:[{ label, times:[[s,e,note?]], bad }], bad:[] }。label：null 无标签 / 'default' / [星期]。 */
  P.parseTimeText = function (text) {
    var raw = String(text == null ? '' : text), nt = norm(raw);
    var out = { lines: [], bad: [] };
    var segs = [], start = 0;
    for (var i = 0; i <= nt.length; i++) {
      if (i === nt.length || nt[i] === ';' || nt[i] === '\n') { segs.push([start, i]); start = i + 1; }
    }
    segs.forEach(function (sg) {
      var t = nt.slice(sg[0], sg[1]), r = raw.slice(sg[0], sg[1]);
      if (!t.trim()) return;
      var found = scanTimes(t), line = { label: null, times: [], bad: [] };
      if (!found.length) { out.bad.push(r.trim()); return; }
      var head = t.slice(0, found[0].at);
      if (head.trim()) {
        var lab = parseLabel(head);
        if (lab) line.label = lab;
        else if (head.replace(/[\s\/|]/g, '')) line.bad.push(r.slice(0, found[0].at).trim());
      }
      found.forEach(function (f, k) {
        var tailEnd = k + 1 < found.length ? found[k + 1].at : t.length;
        var tail = t.slice(f.end, tailEnd), note = '';
        // 备注只认紧跟在时间后面、带括号的那段；不带括号的字一律当「没看懂」报出来。
        // ⚠️ 别把不带括号的剩字也收成备注：OCR 拼错的碎字会悄悄变成场次备注，没人发现。
        var pm = /^\s*\(([^)]*)\)?/.exec(tail);
        var restAt = 0;
        if (pm) {
          var open = f.end + pm[0].indexOf('(') + 1, close = f.end + pm[0].length - (/\)$/.test(pm[0]) ? 1 : 0);
          note = cleanNote(r.slice(open, close));
          restAt = pm[0].length;
        }
        var rest = tail.slice(restAt);
        if (rest.replace(/[\s\/|、,，]/g, '')) line.bad.push(r.slice(f.end + restAt, tailEnd).trim());
        if (!hmOk(f.sh, f.sm) || !hmOk(f.eh, f.em)) { line.bad.push(f.src); return; }
        var item = [hmStr(f.sh, f.sm), hmStr(f.eh, f.em)];
        if (note) item.push(note);
        line.times.push(item);
      });
      out.lines.push(line);
    });
    return out;
  };

  /** 「（含打铁花+低空烟花）」→「打铁花+低空烟花」：括号、首尾标点去掉，「含」字省掉（schedule.js 手录口径）。 */
  function cleanNote(s) {
    return String(s || '').replace(/^[\s(（\/|、,，]+|[\s)）\/|、,，]+$/g, '').replace(/^含/, '').trim();
  }

  // 「天部分停演」（雨字没认出来）也算：漏了这一下它就变成场次备注挂到每一场上了
  function isRainTag(s) { return /(雨|天).{0,4}(停|取消|不演)/.test(s); }

  /** 场次文本的规范写法（草稿里存的、编辑框里显示的）。 */
  P.formatLines = function (lines) {
    return lines.map(function (ln) {
      var lab = ln.label === 'default' ? '日常 ' : Array.isArray(ln.label) ? fmtWeekdays(ln.label) + ' ' : '';
      return lab + ln.times.map(function (x) { return x[0] + '-' + x[1] + (x[2] ? '（' + x[2] + '）' : ''); }).join(' / ');
    }).join('；');
  };

  var WD_CN = '日一二三四五六';
  function fmtWeekdays(w) { return w.map(function (d) { return '周' + WD_CN[d]; }).join('/'); }

  // ── 几何 ─────────────────────────────────

  function hyp(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function median(a) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function wMedian(vals, ws) {
    var idx = vals.map(function (_, i) { return i; }).sort(function (a, b) { return vals[a] - vals[b]; });
    var tot = ws.reduce(function (s, w) { return s + w; }, 0), acc = 0;
    for (var k = 0; k < idx.length; k++) { acc += ws[idx[k]]; if (acc >= tot / 2) return vals[idx[k]]; }
    return 0;
  }

  /**
   * 把 OCR 框摆正到「文字行水平」的坐标系里，后面所有按行 / 按列的判断都在这个坐标系里做。
   *
   * 两层：① 全图转掉宽框顶边角度的加权中位数（拍歪了）；② 剩下的角度随位置线性变化
   * （斜着拍的透视：上边和下边的行歪的方向相反），拟合 φ(x,y) = a + b·x + c·y，
   * 只做「y 按 x 错切」不动 x。⚠️ 别把第②层也做成整体旋转：透视下竖线并没有歪，
   * 按行角去转会把顶部和底部的列各往一边推 40 px，日期列、备注列的分界就糊了。
   */
  function straighten(lines, W, H) {
    var items = [];
    lines.forEach(function (l, i) {
      if (!l || !Array.isArray(l.box) || l.box.length !== 4 || l.text == null) return;
      var b = l.box.map(function (p) { return [+p[0], +p[1]]; });
      if (b.some(function (p) { return !isFinite(p[0]) || !isFinite(p[1]); })) return;
      var w = hyp(b[0], b[1]), h = hyp(b[0], b[3]);
      items.push({ i: i, raw: String(l.text), t: norm(l.text), score: isFinite(+l.score) ? +l.score : 1, box: b, w: w, h: h,
        ang: Math.atan2(b[1][1] - b[0][1], b[1][0] - b[0][0]) });
    });
    var Xc = (W || 1000) / 2, Yc = (H || 1000) / 2;
    var wide = items.filter(function (it) { return it.w > 3 * it.h && Math.abs(it.ang) < 0.3; });
    var th0 = wide.length ? wMedian(wide.map(function (it) { return it.ang; }), wide.map(function (it) { return it.w; })) : 0;
    var cs = Math.cos(-th0), sn = Math.sin(-th0);
    function rot(p) { var x = p[0] - Xc, y = p[1] - Yc; return [Xc + x * cs - y * sn, Yc + x * sn + y * cs]; }
    items.forEach(function (it) {
      it.q = it.box.map(rot);
      it.qcx = (it.q[0][0] + it.q[1][0] + it.q[2][0] + it.q[3][0]) / 4;
      it.qcy = (it.q[0][1] + it.q[1][1] + it.q[2][1] + it.q[3][1]) / 4;
    });

    // ② 残余角度场：宽框按宽度平方加权（窄框的角度一像素误差就是好几度），两轮、第二轮剔掉偏 1° 以上的
    var fit = { a: 0, b: 0, c: 0 };
    var pts = wide.map(function (it) {
      return { x: (it.qcx - Xc) / (W || 1000), y: (it.qcy - Yc) / (H || 1000), r: it.ang - th0, w: it.w * it.w };
    });
    for (var pass = 0; pass < 2 && pts.length >= 6; pass++) {
      var f = lsq3(pts);
      if (!f) break;
      fit = f;
      pts = pts.filter(function (p) { return Math.abs(p.r - (fit.a + fit.b * p.x + fit.c * p.y)) < 0.0175; });
    }
    var LIM = 0.1;
    function phi(x, y) {
      var v = fit.a + fit.b * (x - Xc) / (W || 1000) + fit.c * (y - Yc) / (H || 1000);
      return Math.max(-LIM, Math.min(LIM, v));
    }
    items.forEach(function (it) {
      // 沿着行从图中线积到框中心：取中点处的角度
      var ph = phi((it.qcx + Xc) / 2, it.qcy), tn = Math.tan(ph);
      var xs = it.q.map(function (p) { return p[0]; });
      var ys = it.q.map(function (p) { return p[1] - (p[0] - Xc) * tn; });
      it.x0 = Math.min.apply(null, xs); it.x1 = Math.max.apply(null, xs);
      it.y0 = Math.min.apply(null, ys); it.y1 = Math.max.apply(null, ys);
      it.cx = (it.x0 + it.x1) / 2; it.cy = (it.y0 + it.y1) / 2;
      var ox = it.box.map(function (p) { return p[0]; }), oy = it.box.map(function (p) { return p[1]; });
      it.ob = [Math.min.apply(null, ox), Math.min.apply(null, oy), Math.max.apply(null, ox), Math.max.apply(null, oy)];
      it.vertical = it.h > 1.8 * it.w && it.raw.length >= 2;
    });
    return { items: items, angle: th0 * 180 / Math.PI };
  }

  function lsq3(pts) {
    var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    pts.forEach(function (p) {
      var row = [1, p.x, p.y];
      for (var i = 0; i < 3; i++) {
        v[i] += p.w * row[i] * p.r;
        for (var j = 0; j < 3; j++) S[i][j] += p.w * row[i] * row[j];
      }
    });
    var s = solve3(S, v);
    return s ? { a: s[0], b: s[1], c: s[2] } : null;
  }
  function solve3(A, b) {
    var M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < 3; c++) {
      var p = c;
      for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      var tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      for (var r2 = 0; r2 < 3; r2++) {
        if (r2 === c) continue;
        var k = M[r2][c] / M[c][c];
        for (var j = c; j < 4; j++) M[r2][j] -= k * M[c][j];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }

  function bboxUnion(list) {
    var b = null;
    list.forEach(function (it) {
      var o = it.ob;
      if (!o) return;
      if (!b) b = o.slice();
      else { b[0] = Math.min(b[0], o[0]); b[1] = Math.min(b[1], o[1]); b[2] = Math.max(b[2], o[2]); b[3] = Math.max(b[3], o[3]); }
    });
    return b && b.map(function (v) { return Math.round(v); });
  }

  // ── 版面 ─────────────────────────────────

  function compact(t) { return t.replace(/\s+/g, ''); }

  /** 表头「演出名称 / 日期 / 备注」三个框：用它们的位置划列。找不到返回 null，交给按内容猜。 */
  function findHeader(items, u) {
    var pick = function (re) { return items.filter(function (it) { return re.test(compact(it.t)); }); };
    var names = pick(/^(演出名称|节目名称|演出节目|节目|名称)$/), dates = pick(/^(日期|演出日期)$/),
      notes = pick(/^(备注|时间|演出时间|场次|场次时间)$/);
    var best = null;
    names.forEach(function (n) {
      dates.forEach(function (d) {
        if (d.cx <= n.cx || Math.abs(d.cy - n.cy) > 1.5 * u) return;
        var nt = notes.filter(function (x) { return x.cx > d.cx && Math.abs(x.cy - d.cy) < 1.5 * u; })[0] || null;
        var score = (nt ? 2 : 1) - Math.abs(d.cy - n.cy) / (10 * u);
        if (!best || score > best.score) best = { name: n, date: d, note: nt, score: score };
      });
    });
    return best;
  }

  /** 名称列里的编号框：「3」「②」「?」（⑨ 认成的）。 */
  function parseNo(t) {
    var s = compact(t);
    var m = /^([①-⑳])/.exec(s);
    if (m) return m[1].charCodeAt(0) - 0x245F;
    m = /^(\d{1,2})$/.exec(s);
    return m ? +m[1] : null;
  }
  function isNoBox(it, u) {
    var s = compact(it.t);
    return s.length <= 2 && it.w < 1.6 * u && /^[①-⑳\d?？口〇Oo.。·]{1,2}$/.test(s);
  }
  function stripLeadNo(raw) {
    var m = /^\s*([①-⑳]|\d{1,2}(?=\s*[^\d\s:：月日号.]))\s*[.、．]?\s*/.exec(raw);
    return m ? { no: m[1].length === 1 && m[1].charCodeAt(0) >= 0x2460 ? m[1].charCodeAt(0) - 0x245F : +m[1], text: raw.slice(m[0].length) }
      : { no: null, text: raw };
  }

  function splitName(raw) {
    var s = raw.replace(/\s+/g, '').replace(/[<〈＜]/g, '《').replace(/[>〉＞]/g, '》');
    var m = /^(.*?)《([^》]*)》?(.*)$/.exec(s);
    if (!m) return { kind: s, title: '' };
    return { kind: (m[1] + m[3]).trim(), title: m[2].trim() };
  }

  function nameKey(s) {
    return norm(s).replace(/[\s《》<>()（）「」"'“”·•・.。,，、:：]/g, '').replace(/[xX✕]/g, '×').replace(/^[①-⑳\d]+/, '');
  }
  function bigrams(s) { var a = []; for (var i = 0; i < s.length - 1; i++) a.push(s.substr(i, 2)); return a.length ? a : [s]; }
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    var A = bigrams(a), B = bigrams(b), cnt = {}, hit = 0;
    A.forEach(function (g) { cnt[g] = (cnt[g] || 0) + 1; });
    B.forEach(function (g) { if (cnt[g] > 0) { cnt[g]--; hit++; } });
    return 2 * hit / (A.length + B.length);
  }
  P.nameSimilarity = function (a, b) { return dice(nameKey(a), nameKey(b)); };
  var MATCH_MIN = 0.6;

  // ── 抽取草稿 ─────────────────────────────────

  /**
   * OCR 结果 → 草稿。草稿只含「海报上写了什么」（按子行切好的原文），规则留给 rebuild 生成。
   * 返回 { meta, shows:[…], issues:[…]（只跟 OCR 有关、编辑后不会变的那些）, debug }。
   */
  P.extractDraft = function (ocr, opts) {
    opts = opts || {};
    var today = opts.today || L.ymd(Date.now());
    var issues = [];
    var W = +ocr.width || 0, H = +ocr.height || 0;
    var st = straighten(Array.isArray(ocr.lines) ? ocr.lines : [], W, H);
    var items = st.items;

    var bodyH = items.filter(function (it) { return hasTime(it.t) || hasDatePhrase(it.t); }).map(function (it) { return it.h; });
    var u = median(bodyH.length >= 5 ? bodyH : items.map(function (it) { return it.h; })) || 20;

    // ① 表头与列
    var hdr = findHeader(items, u), b1, b2, headTop, headBottom;
    if (hdr) {
      b1 = (hdr.name.x1 + hdr.date.x0) / 2;
      // 日期表头居中在日期列里，右界按它对称过去。⚠️ 别取「日期 / 备注」两表头的中点：
      // 备注列宽一倍多，中点会落进备注列里，把左半边的时间框当成日期。
      b2 = 2 * hdr.date.cx - b1;
      headTop = Math.min(hdr.name.y0, hdr.date.y0);
      headBottom = Math.max(hdr.name.y1, hdr.date.y1, hdr.note ? hdr.note.y1 : -Infinity);
    } else {
      // 表头没认出来：日期列 = 右边同一行上有时间框的那些日期框。⚠️ 别把所有带「月日」的框都算上：
      // 标题「11月24日至30日」和右下角「11月24日版本」也带，会把日期列的右界拽到图边上。
      var tBoxes = items.filter(function (it) { return hasTime(it.t); });
      var dBoxes = items.filter(function (it) {
        return !hasTime(it.t) && (COUNT_RE.test(it.t) || /\d月\d/.test(it.t)) &&
          tBoxes.some(function (t) { return t.x0 > it.x1 && Math.abs(t.cy - it.cy) < 1.5 * u; });
      });
      if (dBoxes.length < 3) {
        return { meta: emptyMeta(today), shows: [], issues: [{ level: 'warn', code: 'no_table', msg: '这张图里没找到演出时刻表' }], debug: { u: u } };
      }
      var dcx = median(dBoxes.map(function (it) { return it.cx; }));
      var tx0 = median(tBoxes.filter(function (t) { return t.cx > dcx; }).map(function (t) { return t.x0; }));
      b2 = (median(dBoxes.map(function (it) { return it.x1; })) + tx0) / 2;
      b1 = 2 * dcx - b2;
      headTop = headBottom = Math.min.apply(null, dBoxes.map(function (it) { return it.y0; })) - u;
      issues.push({ level: 'info', code: 'no_header', msg: '没找到表头，列是按内容猜的' });
    }

    var foot = items.filter(function (it) { return it.cy > headBottom && /温馨提示|咨询电话|客服电话|服务热线|咨询热线|版本$|版$/.test(compact(it.t)); });
    var footTop = foot.length ? Math.min.apply(null, foot.map(function (it) { return it.y0; })) : Infinity;

    // ② 标题区：有效期；页脚：提示、电话、版本
    var meta = emptyMeta(today);
    var titleItems = items.filter(function (it) { return it.y1 <= headTop + 0.5 * u; }).sort(function (a, b) { return a.y0 - b.y0; });
    var vr = null;
    titleItems.some(function (it) { vr = P.parseValidity(it.t, today); return !!vr; });
    items.forEach(function (it) {
      var c = compact(it.raw), nt = compact(it.t), m;
      if ((m = /(\d{1,2})月(\d{1,2})[日号]?版/.exec(nt))) meta.version = m[1] + '月' + m[2] + '日版本';
      if ((m = /温馨提示[:：]?(.+)$/.exec(c))) meta.notice = m[1].replace(/[!！。.]+$/, '');
      if ((m = /(?:电话|热线)[:：]?([\d\-—\s]{7,})/.exec(nt))) meta.phone = m[1].replace(/\D/g, '');
    });
    if (vr) { meta.validFrom = vr.from; meta.validTo = vr.to; meta.validityFound = true; }
    else {
      var vm = /(\d{1,2})月(\d{1,2})日/.exec(meta.version || '');
      if (vm) meta.validFrom = ymdOf(P.inferYear(+vm[1], +vm[2], today), +vm[1], +vm[2]);
      meta.validTo = L.addDays(meta.validFrom, 6);
      meta.validityFound = false;
    }
    if (!meta.version) meta.version = (+meta.validFrom.slice(5, 7)) + '月' + (+meta.validFrom.slice(8, 10)) + '日版本';

    // ③ 表体分类
    var body = items.filter(function (it) { return it.cy > headBottom && it.cy < footTop && !it.vertical; });
    // 跨列且够长的才是横贯的标题 / 红条。⚠️ 只看「跨列」不够：「单独收费」角标就骑在名称列和日期列的分界上。
    var spans = function (it) { return it.w > 6 * u && ((it.x0 < b2 - u && it.x1 > b2 + u) || (it.x0 < b1 - u && it.x1 > b1 + u)); };
    body.forEach(function (it) {
      var t = it.t, timeIn = looksTime(t);
      if (/单独收费|另行收费|另收费/.test(t) && it.w < 6 * u) it.cls = 'badge';
      else if (!timeIn && it.h > 1.6 * u && (spans(it) || (it.cx > b1 && it.w > 4 * u)) && !hasDatePhrase(t)) it.cls = 'section';
      else if (!timeIn && spans(it) && !hasDatePhrase(t)) it.cls = 'banner';
      else if (timeIn) it.cls = it.cx < b1 ? 'nameTime' : 'time';
      else if (it.cx < b1) {
        if (/推荐必看|推荐|必看/.test(compact(t)) && compact(t).length <= 5) it.cls = 'streetTag';
        else if (isNoBox(it, u)) it.cls = 'no';
        else if (/^(地点|场地|地址|位置)/.test(compact(t))) it.cls = 'loc';
        else it.cls = 'name';
      } else if (/《/.test(t) && !hasDatePhrase(t)) it.cls = 'item';
      else if (it.cx < b2) it.cls = hasDatePhrase(t) ? 'date' : 'misc';
      else if (parseLabel(t)) it.cls = 'label';
      else if (hasDatePhrase(t) && !/[()（）]/.test(it.raw)) it.cls = 'date';
      else if (compact(t).length <= 1) it.cls = 'misc';
      else it.cls = 'annot';
    });
    // 红条被拆成几截时，和长条同一行的碎块、或字面像公告的，都并进红条。
    // ⚠️ 带括号的备注框不收：倾斜 + 缩小后「（含打铁花+低高空烟花）」离红条只差半行，收进去场次备注就没了。
    var banners = body.filter(function (it) { return it.cls === 'banner'; });
    body.forEach(function (it) {
      if (it.cls !== 'misc' && !(it.cls === 'annot' && !/[()（）]/.test(it.raw))) return;
      var sameRow = banners.some(function (b) { return Math.abs(b.cy - it.cy) < 0.7 * u; });
      if (sameRow || /预警|管控|取消|为准|公告|广播/.test(it.t)) { it.cls = 'banner'; banners.push(it); }
    });

    // ④ 推荐必看段：从第一个「推荐必看」/ 节目清单框往下都归它
    var streetTag = body.filter(function (it) { return it.cls === 'streetTag'; });
    var itemBoxes = body.filter(function (it) { return it.cls === 'item'; });
    var yS = Infinity;
    var itemLike = function (it) {
      return it.cx >= b1 && !looksTime(it.t) && !hasDatePhrase(it.t) && /^[^《(（〈<]{2,}[《(（〈<]/.test(compact(it.raw));
    };
    if (streetTag.length || itemBoxes.length >= 3) {
      yS = Math.min.apply(null, streetTag.concat(itemBoxes).map(function (it) { return it.y0; })) - 0.3 * u;
      // 书名号全被认成圆括号时清单第一行会落在「推荐必看」上面：往上收到最后一条普通时间行为止
      var lastLine = -Infinity;
      body.forEach(function (it) { if (it.cls === 'time' && it.cy < yS) lastLine = Math.max(lastLine, it.y1); });
      body.forEach(function (it) { if (it.cy > lastLine && it.cy < yS + u && itemLike(it)) yS = Math.min(yS, it.y0 - 0.3 * u); });
    } else {
      itemBoxes.forEach(function (it) { it.cls = 'misc'; });
    }
    var reg = body.filter(function (it) { return it.cy < yS; });
    var street = body.filter(function (it) { return it.cy >= yS; });
    // 段内日期 / 备注两列里的字都是节目清单，书名号认成圆括号（「互动浴戏（步步为面）」）的也算
    street.forEach(function (it) {
      if (it.cx >= b1 && it.cls !== 'item' && !looksTime(it.t) && /[《〈<(（]/.test(it.raw) && compact(it.t).length >= 4) it.cls = 'item';
    });

    // ⑤ 时间行：标签挂到右边最近的行，括号备注挂到左边最近的行
    var lines = reg.filter(function (it) { return it.cls === 'time'; }).map(function (it) {
      return { it: it, cy: it.cy, y0: it.y0, y1: it.y1, x0: it.x0, x1: it.x1, label: null, annots: [], parts: [it] };
    }).sort(function (a, b) { return a.cy - b.cy; });
    var looseAnnots = [];
    reg.forEach(function (it) {
      if (it.cls !== 'label' && it.cls !== 'annot') return;
      var best = null, bd = 0.9 * u;
      lines.forEach(function (ln) {
        var ok = it.cls === 'label' ? ln.x0 > it.cx : ln.x1 < it.cx + u;
        var d = Math.abs(ln.cy - it.cy);
        if (ok && d < bd) { bd = d; best = ln; }
      });
      if (!best) { looseAnnots.push(it); return; }
      best.parts.push(it);
      if (it.cls === 'label') best.label = it;
      else best.annots.push(it);
    });

    // ⑥ 时间行按行距成格（一格 = 一个子行）。行距比间隙可靠：OCR 框的上下留白不随缩放等比变，
    //    缩到 70% 后日期列里「隔格」的间隙只剩 2 px、和「同格」叠着的 −5 px 分不开，行距却还是 1.8 倍对 0.75 倍。
    var hT = median(lines.map(function (ln) { return ln.it.h; })) || u;
    var pitchMax = pitchThreshold(lines, hT) * hT;
    var cells = [];
    lines.forEach(function (ln) {
      var c = cells[cells.length - 1];
      if (c && ln.cy - c.lastCy <= pitchMax) { c.lines.push(ln); c.lastCy = ln.cy; c.y1 = Math.max(c.y1, ln.y1); }
      else cells.push({ items: [], lines: [ln], y0: ln.y0, y1: ln.y1, lastCy: ln.cy });
    });
    cells.forEach(function (c) { c.cy = (c.y0 + c.y1) / 2; });

    // ⑦ 日期框挂到中心最近的时间格（格子里的字都是竖直居中的）；够不着的（那一行没认出时间）按间隙自成一格
    var dates = reg.filter(function (it) { return it.cls === 'date'; }).sort(function (a, b) { return a.y0 - b.y0; });
    var orphanDates = [];
    dates.forEach(function (it) {
      var best = null, bd = Infinity;
      cells.forEach(function (c) { var d = Math.abs(c.cy - it.cy); if (d < bd) { bd = d; best = c; } });
      if (best && bd <= (best.y1 - best.y0) / 2 + u) best.items.push(it);
      else orphanDates.push(it);
    });
    var dcells = [];
    orphanDates.forEach(function (it) {
      var c = dcells[dcells.length - 1];
      if (c && it.y0 - c.y1 <= DATE_CELL_GAP * u) { c.items.push(it); c.y1 = Math.max(c.y1, it.y1); }
      else dcells.push({ items: [it], lines: [], y0: it.y0, y1: it.y1 });
    });
    dcells.forEach(function (c) { c.cy = (c.y0 + c.y1) / 2; });

    // ⑧ 一格里有两个「每天N场」，说明两个子行被并成了一格：在两者之间最大的空隙处拆开，时间行就近分
    var subrows = [];
    cells.concat(dcells).forEach(function (c) { splitCell(c).forEach(function (x) { subrows.push(x); }); });
    subrows.sort(function (a, b) { return a.cy - b.cy; });

    // ⑧ 名称块：「《片名》」「地点：…」行接在上一块下面，其余新起一块
    var nameBoxes = reg.filter(function (it) { return it.cls === 'name' || it.cls === 'loc'; }).sort(function (a, b) { return a.y0 - b.y0; });
    var blocks = [];
    nameBoxes.forEach(function (it) {
      var cur = blocks[blocks.length - 1];
      var cont = it.cls === 'loc' || /^\s*[《<〈]/.test(it.raw);
      if (cur && cont && it.y0 - cur.y1 < 0.6 * u) { cur.items.push(it); cur.y1 = Math.max(cur.y1, it.y1); }
      else blocks.push({ items: [it], y0: it.y0, y1: it.y1 });
    });
    blocks.forEach(function (b) { b.cy = (b.y0 + b.y1) / 2; b.nos = []; b.badges = []; });
    reg.forEach(function (it) {
      if (it.cls !== 'no' && it.cls !== 'badge') return;
      var best = null, bd = 1.2 * u;
      blocks.forEach(function (b) {
        var d = it.cy < b.y0 ? b.y0 - it.cy : it.cy > b.y1 ? it.cy - b.y1 : 0;
        if (d < bd) { bd = d; best = b; }
      });
      if (best) (it.cls === 'no' ? best.nos : best.badges).push(it);
    });

    // ⑨ 子行 → 名称块：DP 找保序的连续切分，让每块名字的中心对准它那几格子行的中心
    var assign = assignRows(blocks, subrows, u);
    var empties = [];
    blocks.forEach(function (b, k) { b.rows = assign[k]; if (!b.rows.length) empties.push(b); });
    // 没分到子行、又紧贴着邻块的名字，多半是一个名字被拆成了两块，并给贴得更紧的那一边
    empties.forEach(function (b) {
      var k = blocks.indexOf(b), prev = blocks[k - 1], next = blocks[k + 1];
      var gp = prev ? b.y0 - prev.y1 : Infinity, gn = next ? next.y0 - b.y1 : Infinity;
      var tgt = Math.min(gp, gn) >= 0.8 * u ? null : gp <= gn ? prev : next;
      if (!tgt) return;
      tgt.items = tgt.y0 < b.y0 ? tgt.items.concat(b.items) : b.items.concat(tgt.items);
      tgt.nos = tgt.nos.concat(b.nos); tgt.badges = tgt.badges.concat(b.badges);
      tgt.y0 = Math.min(tgt.y0, b.y0); tgt.y1 = Math.max(tgt.y1, b.y1); tgt.cy = (tgt.y0 + tgt.y1) / 2;
      blocks.splice(k, 1);
    });

    // ⑩ 分区：「龙之梦太湖演艺城」这种横贯标题之前的节目在园区其他区域
    var sections = reg.filter(function (it) { return it.cls === 'section'; }).sort(function (a, b) { return a.cy - b.cy; });
    var cityAt = sections.filter(function (s) { return /演艺城/.test(s.t); })[0];

    var shows = blocks.map(function (b) {
      var nameRaw = '', loc = null, no = null;
      b.items.forEach(function (it) {
        if (it.cls === 'loc') { loc = it.raw.replace(/^\s*(地点|场地|地址|位置)\s*[:：]?\s*/, '').trim(); return; }
        var s = stripLeadNo(it.raw);
        if (s.no != null && no == null) no = s.no;
        nameRaw += s.text.trim();
      });
      b.nos.forEach(function (it) { var n = parseNo(it.t); if (n != null && no == null) no = n; });
      var nm = splitName(nameRaw);
      var tags = [];
      b.badges.forEach(function (it) { var s = compact(it.raw).replace(/[()（）]/g, ''); if (tags.indexOf(s) < 0) tags.push(s); });
      var all = b.items.concat(b.nos, b.badges);
      var subs = b.rows.map(function (c) { return subFromCell(c, tags); });
      b.rows.forEach(function (c) { all = all.concat(c.items); c.lines.forEach(function (ln) { all = all.concat(ln.parts); }); });
      var area = null;
      if (cityAt && b.cy < cityAt.cy) area = 'other';
      sections.forEach(function (s) { if (s !== cityAt && b.cy > s.cy && (!cityAt || s.cy > cityAt.cy)) area = 'other'; });
      return {
        ocrName: nameRaw, kind: nm.kind, title: nm.title, no: no, venueText: loc, tags: tags, area: area,
        note: '', subs: subs.length ? subs : [{ dateText: '', timeText: '', ocrIssues: [], box: null }],
        noRows: !subs.length, cy: b.cy, box: bboxUnion(all),
      };
    });

    // 红条挂给它正上方那个节目
    if (banners.length) {
      var rows = [];
      banners.slice().sort(function (a, b) { return a.cy - b.cy; }).forEach(function (it) {
        var g = rows[rows.length - 1];
        if (g && Math.abs(it.cy - g[0].cy) < 0.7 * u) g.push(it);
        else rows.push([it]);
      });
      rows.forEach(function (row) {
        var parts = row.sort(function (a, b) { return a.x0 - b.x0; });
        var cy = parts[0].cy, text = parts.map(function (it) { return it.raw.trim(); }).join('');
        var owner = shows.filter(function (s) { return s.cy < cy; }).pop();
        if (owner) { owner.banner = (owner.banner ? owner.banner + '；' : '') + text; owner.bannerScore = Math.min.apply(null, parts.map(function (it) { return it.score; })); }
      });
    }

    // ⑪ 推荐必看段 → 一个 continuous 节目 + 节目清单
    if (street.length && (streetTag.length || itemBoxes.length >= 3)) {
      var sName = street.filter(function (it) { return it.cx < b1 && it.cls === 'name'; }).sort(function (a, b) { return a.y0 - b.y0; });
      var sTimes = street.filter(function (it) { return it.cls === 'nameTime' || (it.cls === 'time' && it.cx < b2); });
      var its = street.filter(function (it) { return it.cls === 'item'; });
      var nmS = splitName(sName.map(function (it) { return it.raw.trim(); }).join(''));
      var timeLines = sTimes.map(function (it) { return linesFromBox(it, null, []); });
      shows.push({
        ocrName: nmS.kind + (nmS.title ? '《' + nmS.title + '》' : ''), kind: nmS.kind || '推荐必看', title: nmS.title, no: null,
        venueText: null, tags: streetTag.length ? ['推荐必看'] : [], area: null, note: '', street: true,
        items: orderItems(its, u),
        subs: [{ dateText: '', timeText: P.formatLines(timeLines), ocrIssues: lowConf(sTimes, '时间'), box: bboxUnion(sTimes) }],
        noRows: !sTimes.length, cy: Infinity, box: bboxUnion(street.filter(function (it) { return it.cls !== 'misc'; })),
      });
    }

    // ⑫ 没对上任何节目的时间行（OCR 漏了名字之类）
    lines.forEach(function (ln) {
      if (blocks.some(function (b) { return b.rows.some(function (c) { return c.lines.indexOf(ln) >= 0; }); })) return;
      issues.push({ level: 'warn', code: 'unassigned', msg: '有一行场次没对上节目：「' + ln.it.raw + '」', box: bboxUnion([ln.it]) });
    });
    // 没挂上时间行的括号备注报 warn 并挂到最近的节目：丢了它就是丢了一条场次备注，不能静悄悄地丢
    looseAnnots.forEach(function (it) {
      if (compact(it.t).length < 2) return;
      var owner = null, bd = Infinity;
      shows.forEach(function (s, k) { var d = Math.abs(s.cy - it.cy); if (d < bd) { bd = d; owner = k; } });
      var serious = /[()（）\d]/.test(it.raw) || it.score < P.LOW_CONF;
      var x = { level: serious ? 'warn' : 'info', code: 'loose_text', msg: '这段字没认出属于哪一行：「' + it.raw + '」' };
      if (owner != null) (shows[owner].ocrIssues = shows[owner].ocrIssues || []).push(x);
      else issues.push(x);
    });
    if (!meta.validityFound) issues.push({ level: 'warn', code: 'validity_missing', msg: '没认出海报标题里的日期范围，请手动填写有效期' });

    var draft = { meta: meta, shows: shows, issues: issues, debug: { u: u, hT: hT, pitch: pitchMax / hT, b1: b1, b2: b2, angle: st.angle, headBottom: headBottom, footTop: footTop, yS: yS } };
    matchKnown(draft, opts.knownShows || [], opts.venues || []);
    return draft;
  };

  /**
   * 折行与换子行的行距分界。⚠️ 别写死成固定倍数：OCR 框的上下留白不随图缩放，按框高算的比值会漂——
   * 原图折行 0.90、铁花秀两格 1.43；缩到 70% 再压 JPEG 后折行 0.68、铁花秀 1.00，固定 1.15 就把两格并了。
   * 两簇本身一直分得开，所以取行距排序后最大的那道缝。
   */
  function pitchThreshold(lines, hT) {
    var ps = [];
    for (var i = 1; i < lines.length; i++) {
      var p = (lines[i].cy - lines[i - 1].cy) / hT;
      if (p > 0.45 && p < 1.7) ps.push(p);
    }
    ps.sort(function (a, b) { return a - b; });
    var gap = 0, at = LINE_PITCH;
    for (i = 1; i < ps.length; i++) {
      if (ps[i] - ps[i - 1] > gap) { gap = ps[i] - ps[i - 1]; at = (ps[i] + ps[i - 1]) / 2; }
    }
    return gap >= 0.2 ? Math.max(0.8, Math.min(1.25, at)) : LINE_PITCH;
  }

  function splitCell(c) {
    var its = c.items.slice().sort(function (a, b) { return a.cy - b.cy; });
    var counts = its.filter(function (it) { return COUNT_RE.test(it.t); });
    if (counts.length < 2) return [c];
    var a = its.indexOf(counts[0]), b = its.indexOf(counts[1]), cut = a + 1, gap = -Infinity;
    for (var k = a; k < b; k++) {
      var g = its[k + 1].y0 - its[k].y1;
      if (g > gap) { gap = g; cut = k + 1; }
    }
    var parts = [its.slice(0, cut), its.slice(cut)].map(function (list) {
      var y0 = Math.min.apply(null, list.map(function (it) { return it.y0; })), y1 = Math.max.apply(null, list.map(function (it) { return it.y1; }));
      return { items: list, lines: [], y0: y0, y1: y1, cy: (y0 + y1) / 2 };
    });
    c.lines.forEach(function (ln) {
      (Math.abs(ln.cy - parts[0].cy) <= Math.abs(ln.cy - parts[1].cy) ? parts[0] : parts[1]).lines.push(ln);
    });
    parts.forEach(function (p) {
      p.lines.forEach(function (ln) { p.y0 = Math.min(p.y0, ln.y0); p.y1 = Math.max(p.y1, ln.y1); });
      p.cy = (p.y0 + p.y1) / 2;
    });
    return splitCell(parts[0]).concat(splitCell(parts[1]));
  }

  function emptyMeta(today) {
    return { version: '', validFrom: today, validTo: L.addDays(today, 6), notice: '', phone: '', validityFound: false };
  }

  function lowConf(list, what) {
    return list.filter(function (it) { return it.score < P.LOW_CONF; }).map(function (it) {
      return { level: 'warn', code: 'low_conf', msg: what + '「' + it.raw + '」识别把握不大（' + it.score.toFixed(2) + '），请对照原图' };
    });
  }

  /** 一个时间框（连同挂在它上面的标签、括号备注）→ 一条场次行。备注里的「雨天停演」类归节目标签。 */
  function linesFromBox(it, labelIt, annots, tags) {
    var t = it.t, raw = it.raw, found = scanTimes(t);
    var line = { label: null, times: [] };
    var head = t.slice(0, found.length ? found[0].at : 0);
    if (labelIt) line.label = parseLabel(labelIt.t);
    else if (head.trim()) line.label = parseLabel(head);
    var notes = [];
    function takeNote(s) {
      s = cleanNote(s);
      if (!s) return;
      if (isRainTag(s)) { if (tags && tags.indexOf(s) < 0) tags.push(s); return; }
      notes.push(s);
    }
    var leftovers = [];
    found.forEach(function (f, k) {
      var tailEnd = k + 1 < found.length ? found[k + 1].at : t.length;
      var tail = raw.slice(f.end, tailEnd);
      var paren = /[(（]([^)）]*)[)）]?/.exec(tail);
      if (paren) { takeNote(paren[1]); tail = tail.replace(paren[0], ''); }
      if (tail.replace(/[\s\/|、,，]/g, '')) leftovers.push(tail.trim());
      line.times.push([hmStr(f.sh, f.sm), hmStr(f.eh, f.em), f]);
    });
    annots.forEach(function (a) { takeNote(a.raw); });
    if (!found.length) leftovers.push(raw.trim());
    else if (head.trim() && !line.label && !labelIt) leftovers.unshift(raw.slice(0, found[0].at).trim());
    line.times = line.times.map(function (x) {
      var f = x[2];
      // 时分不合法的原样留在文本里，rebuild 会把它报成「没看懂」
      if (!hmOk(f.sh, f.sm) || !hmOk(f.eh, f.em)) return [f.src.replace(/\s+/g, '')];
      return notes.length ? [x[0], x[1], notes.join('，')] : [x[0], x[1]];
    });
    line.leftovers = leftovers;
    return line;
  }

  function subFromCell(c, tags) {
    var dateText = c.items.slice().sort(function (a, b) { return a.y0 - b.y0 || a.x0 - b.x0; })
      .map(function (it) { return it.raw.trim(); }).join(' ');
    var lines = c.lines.slice().sort(function (a, b) { return a.cy - b.cy; }).map(function (ln) {
      return linesFromBox(ln.it, ln.label, ln.annots, tags);
    });
    // 折行的两截（同一标签、都没标签）在文本里接成一段；不同标签的各成一段
    var merged = [];
    lines.forEach(function (ln) {
      var prev = merged[merged.length - 1];
      if (prev && !ln.label) prev.times = prev.times.concat(ln.times), prev.leftovers = prev.leftovers.concat(ln.leftovers);
      else merged.push(ln);
    });
    var timeText = merged.map(function (ln) {
      var lab = ln.label === 'default' ? '日常 ' : Array.isArray(ln.label) ? fmtWeekdays(ln.label) + ' ' : '';
      return lab + ln.times.map(function (x) { return x.length === 1 ? x[0] : x[0] + '-' + x[1] + (x[2] ? '（' + x[2] + '）' : ''); }).join(' / ') +
        (ln.leftovers.length ? ' ' + ln.leftovers.join(' ') : '');
    }).join('；');
    var parts = c.items.slice();
    c.lines.forEach(function (ln) { parts = parts.concat(ln.parts); });
    // 标签认成「日常」时低分也无妨（没标签本来就按日常算）；认成星期的低分要报：周六错成周日不会有别的症状
    var side = [];
    c.lines.forEach(function (ln) {
      side = side.concat(ln.annots, ln.label && Array.isArray(parseLabel(ln.label.t)) ? [ln.label] : []);
    });
    var ocrIssues = lowConf(c.items, '日期').concat(lowConf(c.lines.map(function (ln) { return ln.it; }), '时间'), lowConf(side, '备注'));
    return { dateText: dateText, timeText: timeText, ocrIssues: ocrIssues, box: bboxUnion(parts) };
  }

  /** 节目清单按列读：先左列从上到下，再右列。 */
  function orderItems(its, u) {
    var byX = its.slice().sort(function (a, b) { return a.x0 - b.x0; }), cols = [];
    byX.forEach(function (it) {
      var c = cols[cols.length - 1];
      if (c && it.x0 - c.x0 < 3 * u) c.items.push(it);
      else cols.push({ x0: it.x0, items: [it] });
    });
    var out = [];
    cols.forEach(function (c) {
      c.items.sort(function (a, b) { return a.y0 - b.y0; }).forEach(function (it) {
        out.push(compact(it.raw).replace(/^([^《(（]*)[(（]([^)）》]*)[)）》]?$/, '$1《$2》'));
      });
    });
    return out;
  }

  /**
   * 子行（按 y 排好）切成连续的几段分给名称块（也按 y 排好）。代价 = 每块名字中心与它那段子行首尾中心
   * 的中点之差。用首尾子行的中心而不是文字上下沿：格子里的字是竖直居中的，一行字和两行字的格子
   * 高度一样、文字上下沿却差半行，拿上下沿算会系统性偏半行。
   */
  function assignRows(blocks, rows, u) {
    var n = blocks.length, m = rows.length, INF = 1e18;
    var out = blocks.map(function () { return []; });
    if (!n) return out;
    var EMPTY = 1.5 * u, REACH = 4 * u;
    function cost(k, i, j) {
      var c = Math.abs((rows[i].cy + rows[j].cy) / 2 - blocks[k].cy);
      for (var s = i; s <= j; s++) c += Math.max(0, Math.abs(rows[s].cy - blocks[k].cy) - REACH);
      return c;
    }
    var f = [], from = [];
    for (var k = 0; k <= n; k++) { f.push(new Array(m + 1).fill(INF)); from.push(new Array(m + 1).fill(-1)); }
    f[0][0] = 0;
    for (k = 1; k <= n; k++) {
      for (var j = 0; j <= m; j++) {
        if (f[k - 1][j] + EMPTY < f[k][j]) { f[k][j] = f[k - 1][j] + EMPTY; from[k][j] = j; }
        for (var i = 0; i < j; i++) {
          if (f[k - 1][i] >= INF) continue;
          var v = f[k - 1][i] + cost(k - 1, i, j - 1);
          if (v < f[k][j]) { f[k][j] = v; from[k][j] = i; }
        }
      }
    }
    var jj = m;
    for (k = n; k >= 1; k--) {
      var ii = from[k][jj];
      for (var s = ii; s < jj; s++) out[k - 1].push(rows[s]);
      jj = ii;
    }
    return out;
  }

  /**
   * 按名称去对上一期的节目：对上的继承 id / 剧场 / 编号 / 区域 / 说明，标签取并集；
   * 对不上的是新节目，剧场先空着等人选。一对一，分数高的先配。
   */
  function matchKnown(draft, known, venues) {
    var pairs = [];
    draft.shows.forEach(function (ds, i) {
      known.forEach(function (ks, j) {
        var sc = dice(nameKey(ds.kind + ds.title), nameKey(ks.kind + (ks.title || '')));
        if (ds.title && ks.title && nameKey(ds.title) === nameKey(ks.title)) sc = Math.max(sc, 0.9);
        // 「推荐必看」段按位置认，不按名字：名字只有五个字，错一个（国湖街艺秀）分数就掉到 0.5
        if (ds.street && Array.isArray(ks.items) && ks.items.length) sc = Math.max(sc, 0.95);
        if (sc >= MATCH_MIN) pairs.push({ i: i, j: j, sc: sc });
      });
    });
    pairs.sort(function (a, b) { return b.sc - a.sc; });
    var usedI = {}, usedJ = {};
    pairs.forEach(function (p) {
      if (usedI[p.i] || usedJ[p.j]) return;
      usedI[p.i] = usedJ[p.j] = 1;
      var ds = draft.shows[p.i], ks = known[p.j];
      ds.known = ks.id;
      ds.ocrKind = ds.kind; ds.ocrTitle = ds.title;
      ds.kind = ks.kind; ds.title = ks.title || '';
      ds.renamed = nameKey(ds.ocrKind + ds.ocrTitle) !== nameKey(ks.kind + (ks.title || ''));
      ds.no = ks.no != null ? ks.no : null;
      ds.area = ks.area || null;
      ds.continuous = !!ks.continuous;
      ds.venueId = ks.venueId || null;
      ds.knownTags = (ks.tags || []).slice();
      // 认得和上一期标签只差一两个字的，按上一期的写法（「天部分停演」→「雨天部分停演」）
      ds.tags = (ds.tags || []).map(function (t) {
        var hit = ds.knownTags.filter(function (k) { return k !== t && dice(nameKey(k), nameKey(t)) >= 0.6; })[0];
        if (hit) { (ds.tagFixes = ds.tagFixes || []).push([t, hit]); return hit; }
        return t;
      }).filter(function (t, i, a) { return a.indexOf(t) === i; });
      var kn = {};
      (ks.rules || []).forEach(function (r) { (r.times || []).forEach(function (x) { if (x[2]) kn[x[2]] = 1; }); });
      ds.knownNotes = Object.keys(kn);
      // 说明里写了日期的（「仅 11/28、11/29 演出」）是上一期专属的，不继承；地点之类的照留
      ds.note = ks.note && !/\d+\s*\/\s*\d+|\d+月\d+日/.test(ks.note) ? ks.note : '';
    });
    draft.shows.forEach(function (ds) {
      var v = ds.venueText ? findVenue(ds.venueText, venues) : null;
      if (v) ds.venueId = v.id;
      if (!ds.known) { ds.venueId = v ? v.id : null; ds.knownTags = []; ds.continuous = null; }
      if (ds.banner) {
        // 上一期说明里已经有这条提醒（字面相近）就别再拼一遍
        if (!ds.note || dice(nameKey(ds.note), nameKey(ds.banner)) < 0.3) ds.note = ds.note ? ds.note + '；' + ds.banner : ds.banner;
      }
    });
    draft.knownIds = known.map(function (k) { return k.id; });
    draft.knownNames = {};
    known.forEach(function (k) { draft.knownNames[k.id] = L.showTitle(k); });
  }

  function findVenue(text, venues) {
    var k = nameKey(text);
    return venues.filter(function (v) { return nameKey(v.name) === k; })[0] ||
      venues.filter(function (v) { var vk = nameKey(v.name); return vk && (k.indexOf(vk) >= 0 || vk.indexOf(k) >= 0); })[0] || null;
  }

  // ── 草稿 → 时刻表 ─────────────────────────────────

  /**
   * 子行 → 规则，口径照 schedule.js 文件头：公休放最前，加场日期规则在默认之前，
   * 全部子行都带日期（或都限定了星期）的节目补一条 {closed:true} 默认。
   * ruleSub[i] = 第 i 条规则出自第几个子行（-1 = 补的默认），预览页据此把 warn 标到具体日子上。
   */
  function buildRules(parsed) {
    var closed = [], dated = [], weekly = [], deflt = [];
    parsed.forEach(function (p, k) {
      if (p.date.closed.length) closed.push({ r: { dates: p.date.closed.slice(), closed: true }, k: k });
      var D = p.date.dates, W = p.date.weekdays;
      var lines = p.time.lines.filter(function (ln) { return ln.times.length; });
      var wLines = lines.filter(function (ln) { return Array.isArray(ln.label); });
      var dLines = lines.filter(function (ln) { return !Array.isArray(ln.label); });
      var covered = {};
      wLines.forEach(function (ln) { ln.label.forEach(function (d) { covered[d] = 1; }); });
      wLines.forEach(function (ln) {
        var w = W ? ln.label.filter(function (d) { return W.indexOf(d) >= 0; }) : ln.label;
        if (D.length) {
          var dd = D.filter(function (x) { return w.indexOf(L.weekday(x)) >= 0; });
          if (dd.length) dated.push({ r: { dates: dd, times: cloneTimes(ln.times) }, k: k });
        } else if (w.length) weekly.push({ r: { weekdays: w, times: cloneTimes(ln.times) }, k: k });
      });
      var times = [];
      dLines.forEach(function (ln) { times = times.concat(cloneTimes(ln.times)); });
      if (!times.length) return;
      if (D.length) {
        var rest = D.filter(function (x) { return !covered[L.weekday(x)] && (!W || W.indexOf(L.weekday(x)) >= 0); });
        if (rest.length) dated.push({ r: { dates: rest, times: times }, k: k });
      } else if (W) {
        var ww = W.filter(function (d) { return !covered[d]; });
        if (ww.length) weekly.push({ r: { weekdays: ww, times: times }, k: k });
      } else {
        deflt.push({ r: { times: times }, k: k });
      }
    });
    var all = closed.concat(dated, weekly, deflt);
    if (!deflt.length) all.push({ r: { closed: true }, k: -1 });
    return { rules: all.map(function (x) { return x.r; }), ruleSub: all.map(function (x) { return x.k; }), defaults: deflt.length };
  }

  function cloneTimes(ts) { return ts.map(function (x) { return x.slice(); }); }

  function md(ymd) { return (+ymd.slice(5, 7)) + '/' + (+ymd.slice(8, 10)); }
  P.fmtMD = md;
  function mins(hm) { return L.parseHM(hm); }

  /**
   * 草稿 → { schedule, issues, views }。schedule 与 LZM_SCHEDULE 同构，可直接存、直接用。
   * views[i] 是第 i 个节目给预览页的附加信息：{ ruleSub, subs:[{ date, time }] }。
   */
  P.rebuild = function (draft, opts) {
    opts = opts || {};
    var meta = draft.meta, issues = [];
    var push = function (level, code, msg, si, k) { issues.push({ level: level, code: code, msg: msg, show: si == null ? null : si, sub: k == null ? null : k }); };
    (draft.issues || []).forEach(function (x) { issues.push({ level: x.level, code: x.code, msg: x.msg, show: null, sub: null }); });

    var from = meta.validFrom, to = meta.validTo, ctxOk = /^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || '');
    if (!ctxOk) push('warn', 'validity_bad', '有效期没填完整');
    else if (to < from) push('warn', 'validity_bad', '有效期结束日早于开始日');
    else if (dayDiff(to, from) > SPAN_LIMIT_DAYS) push('warn', 'validity_bad', '有效期跨了 ' + (dayDiff(to, from) + 1) + ' 天，不像一期海报');
    var ctx = { from: from, to: to };
    var inRange = function (d) { return !ctxOk || (d >= from && d <= to); };

    var usedIds = {};
    draft.shows.forEach(function (ds) { if (ds.known) usedIds[ds.known] = 1; });
    var newSeq = 0;
    var views = [];
    var shows = draft.shows.map(function (ds, si) {
      // 人改过这个节目的任一子行，就算对照原图确认过了，OCR 层面的提醒不再挂着
      var touched = ds.subs.some(function (sub) { return sub.edited; });
      if (!touched) (ds.ocrIssues || []).forEach(function (x) { push(x.level, x.code, x.msg, si, null); });
      var parsed = ds.subs.map(function (sub, k) {
        var date = P.parseDateText(sub.dateText, ctx), time = P.parseTimeText(sub.timeText);
        if (!sub.edited) (sub.ocrIssues || []).forEach(function (x) { push(x.level, x.code, x.msg, si, k); });
        date.bad.forEach(function (b) { push('warn', 'date_bad', '日期里有一段没看懂：「' + b + '」', si, k); });
        time.bad.forEach(function (b) { push('warn', 'time_bad', '场次里有一段没看懂：「' + b + '」', si, k); });
        time.lines.forEach(function (ln) { ln.bad.forEach(function (b) { push('warn', 'time_bad', '场次里有一段没看懂：「' + b + '」', si, k); }); });
        date.dates.concat(date.closed).forEach(function (d) {
          if (!inRange(d)) push('warn', 'date_outside', md(d) + ' 不在有效期 ' + md(from) + '–' + md(to) + ' 内', si, k);
        });
        var n = 0;
        time.lines.forEach(function (ln) { n += ln.times.length; });
        if (!n && !date.closed.length && !(sub.dateText || '').trim() && !(sub.timeText || '').trim()) {
          push('warn', 'no_times', '这一行没认出日期和场次', si, k);
        } else if (!n && !date.closed.length) {
          push('warn', 'no_times', '这一行没认出场次', si, k);
        }
        if (date.count != null && n) {
          var labeled = time.lines.filter(function (ln) { return ln.label; });
          var counts = labeled.length > 1 ? labeled.map(function (ln) { return ln.times.length; }) : [n];
          if (counts.some(function (c) { return c !== date.count; })) {
            push('warn', 'count_mismatch', '海报写每天 ' + date.count + ' 场，认出 ' + counts.join(' / ') + ' 场', si, k);
          }
        }
        time.lines.forEach(function (ln) { checkOrder(ln.times, function (msg) { push('warn', 'time_order', msg, si, k); }); });
        return { date: date, time: time };
      });

      // 不同子行占了同一天
      var seen = {};
      parsed.forEach(function (p, k) {
        p.date.dates.forEach(function (d) {
          if (seen[d] != null && seen[d] !== k) push('warn', 'date_overlap', md(d) + ' 同时出现在两行里，只按前一行算', si, k);
          seen[d] = k;
        });
      });
      parsed.forEach(function (p, k) {
        p.date.closed.forEach(function (d) {
          if (seen[d] != null) push('warn', 'date_overlap', md(d) + ' 又写了加场又写了公休，按公休算', si, k);
        });
      });

      var br = buildRules(parsed);
      if (br.defaults > 1) push('warn', 'dup_default', '有两行都没写日期，后一行不会生效', si, null);

      var continuous = ds.continuous;
      if (continuous == null) {
        // 新节目：每天只有一个时段、且都在 3 小时以上（冰雪世界、动物世界那种）就当随到随看
        var wins = [];
        br.rules.forEach(function (r) { if (r.times) wins.push(r.times); });
        continuous = !!wins.length && wins.every(function (ts) {
          return ts.length === 1 && mins(ts[0][1]) - mins(ts[0][0]) >= 180;
        }) && !parsed.some(function (p) { return p.date.count != null && p.date.count > 1; });
      }
      if (!continuous) checkDurations(parsed, function (msg, k) { push('warn', 'duration_odd', msg, si, k); });

      var id = ds.known || null;
      if (!id) { do { id = 'new' + (++newSeq); } while (usedIds[id]); usedIds[id] = 1; }
      var tags = (ds.tags || []).slice();
      (ds.knownTags || []).forEach(function (t) {
        if (tags.indexOf(t) >= 0) return;
        tags.push(t);
        push('info', 'tag_kept', '沿用上一期的「' + t + '」标签（这次海报上没认出来）', si, null);
      });
      (ds.tagFixes || []).forEach(function (f) { push('info', 'tag_fixed', '标签「' + f[0] + '」按上一期写成「' + f[1] + '」', si, null); });
      // 场次备注是自由文字，认错一个字（「低空」→「做空」）置信度照样 0.87。对得上上一期的节目，
      // 备注只要不和上一期一字不差就报出来让人看一眼；新节目没有参照，只能靠置信度。
      if (ds.known && !touched) {
        var kn = ds.knownNotes || [], seenNote = {};
        parsed.forEach(function (p, k) {
          p.time.lines.forEach(function (ln) {
            ln.times.forEach(function (x) {
              var nt = x[2];
              if (!nt || seenNote[nt] || kn.indexOf(nt) >= 0) return;
              seenNote[nt] = 1;
              var near = kn.filter(function (q) { return dice(nameKey(q), nameKey(nt)) >= 0.5; })[0];
              push('warn', near ? 'note_diff' : 'note_new', near
                ? '场次备注「' + nt + '」和上一期「' + near + '」只差几个字，请对照原图'
                : '多了场次备注「' + nt + '」，上一期没有，请对照原图', si, k);
            });
          });
        });
      }
      if (ds.known && ds.renamed) push('info', 'name_fixed', '名称按上一期「' + L.showTitle(ds) + '」（海报上认成「' + ds.ocrKind + (ds.ocrTitle ? '《' + ds.ocrTitle + '》' : '') + '」）', si, null);
      if (!ds.known) {
        if (ds.venueId == null && !ds.venueChosen && ds.area !== 'other' && !ds.street) push('warn', 'no_venue', '新节目，请选它在哪个剧场', si, null);
        else if (!ds.venueChosen && !ds.venueId) push('info', 'new_show', '新节目', si, null);
      }
      if (ds.noRows) push('warn', 'show_no_rows', '认出了节目名，但没对上任何场次', si, null);

      var show = { id: id };
      if (ds.no != null) show.no = ds.no;
      show.kind = ds.kind || '';
      show.title = ds.title || '';
      show.venueId = ds.venueId || null;
      if (ds.area) show.area = ds.area;
      if (continuous) show.continuous = true;
      if (tags.length) show.tags = tags;
      var note = ds.note || onlyDatesNote(br.rules, ctx);
      if (note) show.note = note;
      if (ds.items && ds.items.length) show.items = ds.items.slice();
      show.rules = br.rules;
      views.push({ ruleSub: br.ruleSub, subs: parsed });
      return show;
    });

    (draft.knownIds || []).forEach(function (id) {
      if (draft.shows.some(function (ds) { return ds.known === id; })) return;
      push('warn', 'show_missing', '上一期有「' + ((draft.knownNames || {})[id] || id) + '」，这次海报上没找到', null, null);
    });

    var schedule = {
      version: meta.version || '', validFrom: from, validTo: to,
      notice: meta.notice || '', phone: meta.phone || '', shows: shows,
    };
    return { schedule: schedule, issues: issues, views: views };
  };

  function checkOrder(times, report) {
    var prev = null;
    times.forEach(function (x) {
      var s = mins(x[0]), e = mins(x[1]);
      // 晚上开演、过零点散场的允许（e 加一天）；白天出现「结束早于开始」多半是认错了一位数
      if (e <= s && !(s >= 20 * 60 && e <= 4 * 60)) report(x[0] + '-' + x[1] + ' 结束早于开始');
      if (prev) {
        if (s < prev.s) report('场次没按先后排：' + x[0] + ' 排在 ' + prev.hm + ' 后面');
        else if (s < prev.e) report(prev.hm + '-' + prev.end + ' 和 ' + x[0] + '-' + x[1] + ' 时间重叠');
      }
      prev = { s: s, e: e <= s ? e + 1440 : e, hm: x[0], end: x[1] };
    });
  }

  /**
   * 同一节目每场时长都一样（样张 13 个节目无一例外），某一场不一样多半是 OCR 认错了一位数
   * （13:50 → 13:58）。只在多数场次时长一致时才拿它当标准。
   */
  function checkDurations(parsed, report) {
    var all = [];
    parsed.forEach(function (p, k) {
      p.time.lines.forEach(function (ln) {
        ln.times.forEach(function (x) {
          var s = mins(x[0]), e = mins(x[1]);
          if (e > s) all.push({ d: e - s, k: k, hm: x[0] + '-' + x[1] });
        });
      });
    });
    if (all.length < 3) return;
    var cnt = {};
    all.forEach(function (a) { cnt[a.d] = (cnt[a.d] || 0) + 1; });
    var mode = null;
    Object.keys(cnt).forEach(function (d) { if (mode == null || cnt[d] > cnt[mode]) mode = d; });
    if (cnt[mode] < 2 || cnt[mode] * 2 < all.length) return;
    var done = {};
    all.forEach(function (a) {
      if (String(a.d) === mode || done[a.hm]) return;
      done[a.hm] = 1;
      report(a.hm + ' 时长 ' + a.d + ' 分钟，其他场都是 ' + mode + ' 分钟', a.k);
    });
  }

  /** 只在有效期里两三天演的节目，自动写一句「仅 11/28、11/29 演出」（schedule.js 手录时的写法）。 */
  function onlyDatesNote(rules, ctx) {
    var last = rules[rules.length - 1];
    if (!last || !last.closed || last.dates || last.weekdays) return '';
    var ds = [];
    rules.forEach(function (r) { if (r.dates && !r.closed) ds = ds.concat(r.dates); });
    ds = uniqSorted(ds);
    if (!ds.length || ds.length > 3) return '';
    if (ctx.from && ctx.to && dayDiff(ctx.to, ctx.from) + 1 <= ds.length) return '';
    return '仅 ' + ds.map(md).join('、') + ' 演出';
  }

  /** 一步到位：OCR → { schedule, issues, draft, views }。 */
  P.parsePoster = function (ocr, opts) {
    var draft = P.extractDraft(ocr || {}, opts);
    var r = P.rebuild(draft, opts);
    return { schedule: r.schedule, issues: r.issues, draft: draft, views: r.views };
  };

  // ── 给预览页 ─────────────────────────────────

  P.daysOf = function (from, to) {
    var out = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || to < from) return out;
    for (var d = from; d <= to && out.length <= SPAN_LIMIT_DAYS; d = L.addDays(d, 1)) out.push(d);
    return out;
  };

  /**
   * 一个节目在有效期内按天的场次，把场次完全相同的日子并成一组：
   * [{ days:[ymd], closed, sessions:[{startHM,endHM,note}], subs:[子行下标] }]，按组里第一天排。
   */
  P.dayGroups = function (show, from, to, ruleSub) {
    var groups = [], byKey = {};
    P.daysOf(from, to).forEach(function (d) {
      var day = L.daySessions(show, d), rule = L.pickRule(show, d);
      var key = day.closed ? 'closed' : day.sessions.map(function (s) { return s.startHM + s.endHM + s.note; }).join('|');
      var g = byKey[key];
      if (!g) {
        g = byKey[key] = { days: [], closed: day.closed, subs: [], sessions: day.sessions.map(function (s) { return { startHM: s.startHM, endHM: s.endHM, note: s.note }; }) };
        groups.push(g);
      }
      g.days.push(d);
      var k = ruleSub && rule ? ruleSub[show.rules.indexOf(rule)] : -1;
      if (k != null && k >= 0 && g.subs.indexOf(k) < 0) g.subs.push(k);
    });
    return groups;
  };

  /** 场次「指纹」：有效期内出现过的全部时间段，去重排序。比两期时只看时间变没变，不看哪天演。 */
  function rangesOf(show, from, to) {
    var set = {};
    P.daysOf(from, to).forEach(function (d) {
      L.daySessions(show, d).sessions.forEach(function (s) { set[s.startHM + '–' + s.endHM] = 1; });
    });
    return Object.keys(set).sort();
  }

  /**
   * 与当前生效那一期比：新增 / 本期没有 / 时间有变化（多了哪些时段、少了哪些时段）。
   * 日期本来就每期不同，只比时段，否则每个节目都会被报成「有变化」。
   */
  P.diffSchedules = function (oldS, newS) {
    var out = { added: [], removed: [], changed: [] };
    var oldById = {};
    ((oldS && oldS.shows) || []).forEach(function (s) { oldById[s.id] = s; });
    var seen = {};
    (newS.shows || []).forEach(function (s, i) {
      var o = oldById[s.id];
      if (!o) { out.added.push({ index: i, show: s }); return; }
      seen[s.id] = 1;
      var a = rangesOf(o, oldS.validFrom, oldS.validTo), b = rangesOf(s, newS.validFrom, newS.validTo);
      var plus = b.filter(function (x) { return a.indexOf(x) < 0; }), minus = a.filter(function (x) { return b.indexOf(x) < 0; });
      if (plus.length || minus.length) out.changed.push({ index: i, show: s, plus: plus, minus: minus });
    });
    ((oldS && oldS.shows) || []).forEach(function (s) { if (!seen[s.id]) out.removed.push({ show: s }); });
    return out;
  };

  return P;
});
