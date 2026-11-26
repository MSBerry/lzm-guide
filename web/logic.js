/*
 * 纯逻辑层：演出规则解析、「离现在最近的一场」、经纬度 → 导览图像素配准。
 *
 * 不碰 DOM、不读全局数据：浏览器里挂到 window.LZM_LOGIC，node 里 require 得到
 * （tools/test_logic.js 就是这么测的）。所以这里只能用经典脚本写法，不能写 export。
 *
 * 时间一律是「本地时区的毫秒时间戳」。景区在 UTC+8、没有夏令时，按本地日历算
 * 「今天」「明天」不会出岔子；⚠️ 别改成 Date.UTC 那一套：那会让晚上 8 点以后的
 * 「今天」变成 UTC 的明天，整张表错一天。
 */
(function (root, factory) {
  var L = factory();
  if (typeof module === 'object' && module.exports) module.exports = L;
  else root.LZM_LOGIC = L;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var L = {};
  var MIN_MS = 60000;

  // ── 日期与时刻 ─────────────────────────────────

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    if (!m) throw new Error('日期格式应为 YYYY-MM-DD：' + s);
    return { y: +m[1], m: +m[2], d: +m[3] };
  }

  L.ymd = function (ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };

  // 用 Date 构造器做进位（31 日 +1 → 下月 1 日），不手算月份天数。
  L.addDays = function (ymd, n) {
    var p = parseYmd(ymd);
    return L.ymd(new Date(p.y, p.m - 1, p.d + n).getTime());
  };

  L.weekday = function (ymd) {
    var p = parseYmd(ymd);
    return new Date(p.y, p.m - 1, p.d).getDay();
  };

  L.parseHM = function (s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    return m ? +m[1] * 60 + +m[2] : NaN;
  };

  L.atMinutes = function (ymd, mins) {
    var p = parseYmd(ymd);
    return new Date(p.y, p.m - 1, p.d, 0, mins).getTime();
  };

  L.fmtHM = function (ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  // ?now=2026-11-26T14:20 按本地时间解析。
  // ⚠️ 别直接 new Date(str)：不带时区的日期时间串，老内核会当 UTC 解析，差 8 小时。
  L.parseLocalDateTime = function (s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s || '').trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  };

  L.inValidity = function (sched, ymd) {
    if (!sched) return true;
    if (sched.validFrom && ymd < sched.validFrom) return false;
    if (sched.validTo && ymd > sched.validTo) return false;
    return true;
  };

  // ── 多期时刻表 ─────────────────────────────────

  /**
   * 内置那一期 + 导入的各期里，今天该用哪一期。返回 { entry（null = 内置）, schedule, outOfRange }。
   *
   *   有几期都覆盖今天 → 取最后导入的（内置的算最早导入）：同一周重拍了一张更清楚的，以新的为准；
   *   都不覆盖       → 取 validFrom ≤ 今天里开始得最晚的，outOfRange（界面挂「超出有效期」横幅）；
   *   全是以后的     → 取最早开始的那期，同样 outOfRange。
   * ⚠️ 别改成「都不覆盖就回落内置」：内置那张是 11/24 的老海报，导入过 12 月的之后再回落它，
   *    默认规则会按两三期前的场次去报时间。
   */
  L.pickSchedule = function (builtin, entries, ymd) {
    var all = [{ entry: null, schedule: builtin, at: -Infinity }];
    (entries || []).forEach(function (e) {
      if (e && e.schedule && e.schedule.validFrom && Array.isArray(e.schedule.shows)) {
        all.push({ entry: e, schedule: e.schedule, at: +e.importedAt || 0 });
      }
    });
    function later(a, b) { return !a || b.at >= a.at ? b : a; }
    var best = null;
    all.forEach(function (c) { if (L.inValidity(c.schedule, ymd)) best = later(best, c); });
    if (best) return { entry: best.entry, schedule: best.schedule, outOfRange: false };
    all.forEach(function (c) {
      var f = c.schedule.validFrom;
      if (!f || f > ymd) return;
      if (!best || f > best.schedule.validFrom || (f === best.schedule.validFrom && c.at >= best.at)) best = c;
    });
    if (!best) {
      all.forEach(function (c) {
        if (!best || (c.schedule.validFrom || '') < (best.schedule.validFrom || '')) best = c;
      });
    }
    return { entry: best.entry, schedule: best.schedule, outOfRange: true };
  };

  // ── 规则解析 ─────────────────────────────────

  /**
   * 取某天生效的那条规则。
   *
   * 优先级按层级而不是只按书写顺序：dates 命中 > weekdays 命中 > 默认规则，同层取靠前的。
   * 数据文件里本来就是这么排的，两种读法结果一样；按层级读是为了以后有人把默认规则
   * 写到前面时不至于把加场日整个吞掉。
   */
  L.pickRule = function (show, ymd) {
    var wd = L.weekday(ymd);
    var best = null, bestTier = 9;
    (show.rules || []).forEach(function (r) {
      var hasD = Array.isArray(r.dates), hasW = Array.isArray(r.weekdays);
      if (hasD && r.dates.indexOf(ymd) < 0) return;
      if (hasW && r.weekdays.indexOf(wd) < 0) return;
      var tier = hasD ? 0 : hasW ? 1 : 2;
      if (tier < bestTier) { best = r; bestTier = tier; }
    });
    return best;
  };

  /**
   * 某个节目某一天的全部场次。没有任何规则命中（只写了加场日、没写默认）也当作不演。
   */
  L.daySessions = function (show, ymd) {
    var rule = L.pickRule(show, ymd);
    var out = { ymd: ymd, closed: true, continuous: !!show.continuous, sessions: [] };
    if (!rule || rule.closed || !Array.isArray(rule.times) || !rule.times.length) return out;
    rule.times.forEach(function (t, i) {
      var s = L.parseHM(t[0]), e = L.parseHM(t[1]);
      if (!(s >= 0) || !(e >= 0)) {
        // 手录的表，格式错一处不该让整张表白屏；但要留痕，否则少一场没人发现。
        if (typeof console !== 'undefined') console.warn('[LZM] 场次时间格式不对 show=' + show.id + ' ' + JSON.stringify(t));
        return;
      }
      if (e <= s) e += 1440;
      out.sessions.push({
        idx: i, startHM: t[0], endHM: t[1], note: t[2] || '',
        start: L.atMinutes(ymd, s), end: L.atMinutes(ymd, e),
      });
    });
    out.sessions.sort(function (a, b) { return a.start - b.start; });
    out.closed = out.sessions.length === 0;
    return out;
  };

  // ── 「离现在最近的一场」 ─────────────────────────────────

  L.SOON_MIN = 30;

  /**
   * 一个节目此刻的状态。
   *
   * 取「结束时间 > 现在」的第一场，而不是「开始时间 > 现在」：后者会把正在演的那场跳过去，
   * 人站在剧场门口看到的却是两小时后的下一场。
   *
   * state：live 进行中 / open 开放中（continuous）/ soon ≤30 分钟开演 / upcoming /
   *        ended 今日已结束 / closed 今日不演
   */
  L.showStatus = function (show, nowMs, sched, index) {
    var today = L.ymd(nowMs);
    var day = L.daySessions(show, today);
    var st = {
      show: show, index: index == null ? 0 : index, today: today, day: day,
      state: null, cur: null, minsToStart: null, minsLeft: null, tomorrow: null,
    };
    for (var i = 0; i < day.sessions.length; i++) {
      if (day.sessions[i].end > nowMs) { st.cur = day.sessions[i]; break; }
    }
    if (st.cur) {
      if (st.cur.start <= nowMs) {
        st.state = show.continuous ? 'open' : 'live';
        st.minsLeft = Math.ceil((st.cur.end - nowMs) / MIN_MS);
      } else {
        st.minsToStart = Math.ceil((st.cur.start - nowMs) / MIN_MS);
        st.state = st.minsToStart <= L.SOON_MIN ? 'soon' : 'upcoming';
      }
      return st;
    }
    st.state = day.closed ? 'closed' : 'ended';
    var tmr = L.addDays(today, 1);
    // 只在明天仍在海报有效期内时才说「明天几点」：过了有效期，默认规则只是兜底猜测，
    // 拿它说「明天 12:45」等于替景区做了承诺。
    if (L.inValidity(sched, tmr)) {
      var td = L.daySessions(show, tmr);
      if (td.sessions.length) st.tomorrow = td.sessions[0];
    }
    return st;
  };

  var RANK = { live: 0, open: 1, soon: 2, upcoming: 2, ended: 3, closed: 4 };

  /**
   * 列表排序：进行中 → 开放中 → 未开始（按开始时间）→ 今日已结束 → 今日不演。
   * 进行中的按开演时间倒序：刚开演的那场最可能还进得去。
   */
  L.compareStatus = function (a, b) {
    var ra = RANK[a.state], rb = RANK[b.state];
    if (ra !== rb) return ra - rb;
    if (a.state === 'live') return (b.cur.start - a.cur.start) || (a.index - b.index);
    if (ra === 2) return (a.cur.start - b.cur.start) || (a.index - b.index);
    return a.index - b.index;
  };

  /** 一个剧场挂多个节目（音乐广场）时，取最该看的那个。 */
  L.bestOf = function (sts) {
    if (!sts || !sts.length) return null;
    return sts.slice().sort(L.compareStatus)[0];
  };

  /**
   * 收起时的摘要：正在演的排最前（最多 maxLive 场，刚开演的优先），剩下的位置给最快开演的。
   * 给进行中设上限：下午常有三四场同时在演，全放进来就看不到「下一场去哪」了。
   * 不收 continuous（街艺全天都「开放中」，摘要里永远占一格就没信息量了）。
   */
  L.peekItems = function (sts, n, maxLive) {
    n = n || 3;
    maxLive = maxLive == null ? 2 : maxLive;
    var real = sts.filter(function (st) { return !st.show.continuous; });
    var up = real.filter(function (st) { return st.state === 'soon' || st.state === 'upcoming'; })
      .sort(function (a, b) { return a.cur.start - b.cur.start; });
    var live = real.filter(function (st) { return st.state === 'live'; })
      .sort(function (a, b) { return b.cur.start - a.cur.start || a.index - b.index; });
    var head = live.slice(0, Math.min(maxLive, n));
    return head.concat(up.slice(0, n - head.length));
  };

  /** venue：演艺城剧场 / city：演艺城其他（铁花秀、街艺）/ other：园区其他区域。 */
  L.groupOf = function (show) {
    if (show.area === 'other') return 'other';
    return show.venueId ? 'venue' : 'city';
  };

  L.showTitle = function (show) {
    return show.title ? show.kind + '《' + show.title + '》' : show.kind;
  };

  // ── 文案 ─────────────────────────────────

  function hm(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + '小时' + (m ? m + '分' : '');
  }

  /** 「8 分钟后」「1小时20分后」 */
  L.fmtUntil = function (mins) {
    return mins < 60 ? mins + ' 分钟后' : hm(mins) + '后';
  };

  /** 「还剩 12 分钟」「还剩 1小时5分」 */
  L.fmtLeft = function (mins) {
    return '还剩 ' + (mins < 60 ? mins + ' 分钟' : hm(mins));
  };

  /** 「13:50–14:25」。用 en dash 不用连字符：后者在窄字体里和减号、破折号分不清。 */
  L.fmtRange = function (ses) { return ses.startHM + '–' + ses.endHM; };

  /** 一行状态文案；app 和单测共用，保证列表、详情、摘要说的是同一句话。 */
  L.statusText = function (st) {
    var cont = st.show.continuous;
    var tmr = st.tomorrow ? ' · 明天 ' + L.fmtRange(st.tomorrow) + (cont ? ' 开放' : '') : '';
    switch (st.state) {
      case 'live': return '进行中 · ' + L.fmtLeft(st.minsLeft);
      case 'open': return '开放中 · 至 ' + st.cur.endHM;
      case 'soon':
      case 'upcoming':
        return cont ? st.cur.startHM + ' 开放 · ' + L.fmtUntil(st.minsToStart) : L.fmtUntil(st.minsToStart);
      case 'ended': return '今日已结束' + tmr;
      case 'closed': return '今日不演' + tmr;
    }
    return '';
  };

  L.fmtDistance = function (m) {
    if (m < 1000) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  };

  // ── 步行 ─────────────────────────────────

  // 1.3 是园区路网绕行系数（直线换算成实际走的路），70 m/min 是带娃逛街的步速，
  // 比通常的 80 慢一档：宁可让人早出发也别让人掐着点赶不上。
  L.WALK_DETOUR = 1.3;
  L.WALK_M_PER_MIN = 70;

  L.walkMinutes = function (distM) {
    return Math.max(1, Math.ceil(distM * L.WALK_DETOUR / L.WALK_M_PER_MIN));
  };

  // ── 坐标配准 ─────────────────────────────────
  //
  // 导览图是手绘的：不按比例、还顺时针转了 90°。思路分两层：
  //   ① 经纬度投到控制点质心处的局部米制平面（x 向东、y 向北，单位米），
  //      再用加权最小二乘拟合一个仿射到像素——吸收旋转、各向不等的缩放、镜像；
  //   ② 仿射吸收不了的局部变形，用控制点残差的反距离加权（IDW）补上，
  //      并掺一个「零修正」伪权重，让离控制点远的地方修正衰减到 0，只剩仿射。
  //
  //   lat/lon ──投影──> (x,y) 米 ──仿射──> 像素 ──+ IDW 残差修正──> 像素
  //
  // 两点只够定一个相似变换（平移 + 旋转 + 等比缩放）；不足两点不配准。

  /** 等距圆柱投影到以 (lat0, lon0) 为原点的局部平面。演艺城 1–2 km 尺度内误差远小于 GPS 本身。 */
  L.localFrame = function (lat0, lon0) {
    var phi = lat0 * Math.PI / 180;
    // 每度米数用椭球的级数展开而不是 111320·cos：纬度 31° 处两者差约 0.2%，
    // 不大，但这里没有理由用更粗的那个。
    var mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
    var mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
    return {
      lat0: lat0, lon0: lon0,
      toXY: function (lat, lon) { return { x: (lon - lon0) * mLon, y: (lat - lat0) * mLat }; },
      toLatLon: function (x, y) { return { lat: lat0 + y / mLat, lon: lon0 + x / mLon }; },
    };
  };

  L.distanceM = function (lat1, lon1, lat2, lon2) {
    var R = 6371008.8, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  function validCP(p) {
    return p && isFinite(p.px) && isFinite(p.py) && isFinite(p.lat) && isFinite(p.lon) &&
      Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  }

  // 现场校准点是人站在那儿对准的，比在底稿上估的可信，权重给 3 倍。
  L.CALIB_WEIGHT = 3;
  // 校准点 40 m 内的底稿点直接替换：两个点离得这么近却各说各的像素，
  // IDW 会在两点之间拉出一道陡坎，蓝点走过去会跳。
  L.CALIB_REPLACE_M = 40;

  /** 底稿控制点 + 现场校准点 → 带权重的统一控制点表。 */
  L.mergeControlPoints = function (base, calib) {
    var pts = (base || []).filter(validCP).map(function (p) {
      return { name: p.name || '', kind: 'base', px: +p.px, py: +p.py, lat: +p.lat, lon: +p.lon, w: p.w > 0 ? +p.w : 1 };
    });
    (calib || []).filter(validCP).forEach(function (c, i) {
      pts = pts.filter(function (p) {
        return p.kind !== 'base' || L.distanceM(p.lat, p.lon, c.lat, c.lon) >= L.CALIB_REPLACE_M;
      });
      pts.push({ name: c.name || '校准点 ' + (i + 1), kind: 'calib', px: +c.px, py: +c.py, lat: +c.lat, lon: +c.lon,
        w: L.CALIB_WEIGHT, acc: c.acc, time: c.time });
    });
    return pts;
  };

  // 「零修正」伪点的等效距离：离任何控制点 150 m 开外，修正就衰减过半，再远趋近 0。
  // 取 150 m 是因为演艺城里相邻剧场大多相距 100–200 m，一个点的修正最多带到邻居门口。
  L.ZERO_CORR_RADIUS_M = 150;
  // 控制点主方向的标准差低于 15 m（两个点相距不到约 30 m）就不配准：
  // GPS 本身就有 ±5–10 m 误差，这么短的基线量出来的比例和旋转是噪声。
  L.MIN_SPREAD_M = 15;
  // 次方向 / 主方向的标准差比低于 0.15 视为「几乎共线」，退回相似变换：
  // 共线的点量不出垂直方向的比例，硬拟仿射会把那个方向拉成任意长。
  L.MIN_AFFINE_ASPECT = 0.15;

  /**
   * 由控制点建配准模型；不足两点、点挤在一起、退化时返回 null（界面显示「无配准数据」）。
   */
  L.buildGeoModel = function (points) {
    var pts = (points || []).filter(validCP).map(function (p) {
      return { name: p.name || '', kind: p.kind || 'base', px: +p.px, py: +p.py, lat: +p.lat, lon: +p.lon,
        w: p.w > 0 ? +p.w : 1 };
    });
    if (pts.length < 2) return null;

    var W = 0, la = 0, lo = 0;
    pts.forEach(function (p) { W += p.w; la += p.w * p.lat; lo += p.w * p.lon; });
    var frame = L.localFrame(la / W, lo / W);

    var mx = 0, my = 0, mu = 0, mv = 0;
    pts.forEach(function (p) {
      var q = frame.toXY(p.lat, p.lon);
      p.x = q.x; p.y = q.y;
      mx += p.w * p.x; my += p.w * p.y; mu += p.w * p.px; mv += p.w * p.py;
    });
    mx /= W; my /= W; mu /= W; mv /= W;

    var sxx = 0, syy = 0, sxy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
    pts.forEach(function (p) {
      var dx = p.x - mx, dy = p.y - my, du = p.px - mu, dv = p.py - mv, w = p.w;
      sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy;
      sxu += w * dx * du; syu += w * dy * du; sxv += w * dx * dv; syv += w * dy * dv;
    });
    var tr = sxx + syy, det = sxx * syy - sxy * sxy;
    var disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    var lmax = tr / 2 + disc, lmin = Math.max(0, tr / 2 - disc);
    if (lmax / W < L.MIN_SPREAD_M * L.MIN_SPREAD_M) return null;

    var kind, a, b, d, e;
    if (pts.length >= 3 && Math.sqrt(lmin / lmax) >= L.MIN_AFFINE_ASPECT) {
      kind = 'affine';
      a = (syy * sxu - sxy * syu) / det; b = (sxx * syu - sxy * sxu) / det;
      d = (syy * sxv - sxy * syv) / det; e = (sxx * syv - sxy * sxv) / det;
    } else {
      // 相似变换按复数最小二乘解。⚠️ 像素 y 轴朝下、米制 y 轴朝北，手性相反：
      // 直接拿 (px, py) 当复数去拟，解出来的是「镜像 + 旋转」拟不上的东西。
      // 先把像素翻成 (px, -py) 再拟，解完再翻回来。
      kind = 'similarity';
      var ar = (sxu - syv) / tr, ai = -(sxv + syu) / tr;
      a = ar; b = -ai; d = -ai; e = -ar;
    }
    var c = mu - a * mx - b * my, f = mv - d * mx - e * my;
    var linDet = a * e - b * d;
    if (!isFinite(linDet) || Math.abs(linDet) < 1e-12) return null;

    var sr = 0;
    pts.forEach(function (p) {
      p.rx = p.px - (a * p.x + b * p.y + c);
      p.ry = p.py - (d * p.x + e * p.y + f);
      sr += p.w * (p.rx * p.rx + p.ry * p.ry);
    });
    var pxPerM = Math.sqrt(Math.abs(linDet));
    var W0 = 1 / (L.ZERO_CORR_RADIUS_M * L.ZERO_CORR_RADIUS_M);

    function affineXY(x, y) { return { px: a * x + b * y + c, py: d * x + e * y + f }; }

    function forwardXY(x, y) {
      var base = affineXY(x, y);
      var sw = W0, sx = 0, sy = 0, hitW = 0, hx = 0, hy = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], dx = x - p.x, dy = y - p.y, d2 = dx * dx + dy * dy;
        // 1 mm 内算正中控制点：直接取它的残差，免得 1/d² 除出无穷。
        if (d2 < 1e-6) { hitW += p.w; hx += p.w * p.rx; hy += p.w * p.ry; continue; }
        var wi = p.w / d2;
        sw += wi; sx += wi * p.rx; sy += wi * p.ry;
      }
      if (hitW > 0) return { px: base.px + hx / hitW, py: base.py + hy / hitW };
      return { px: base.px + sx / sw, py: base.py + sy / sw };
    }

    function linInv(u, v) { return { x: (e * u - b * v) / linDet, y: (-d * u + a * v) / linDet }; }

    /**
     * 像素 → 米制平面。先用仿射逆当初值，再做几步不动点迭代把 IDW 修正也反解掉，
     * 这样「剧场离我多远」和图上蓝点到剧场的视觉距离是一致的。迭代变差就退回仿射逆。
     */
    function inverseXY(px, py) {
      var q0 = linInv(px - c, py - f);
      var q = { x: q0.x, y: q0.y };
      var err0 = null;
      for (var k = 0; k < 10; k++) {
        var F = forwardXY(q.x, q.y), ex = px - F.px, ey = py - F.py, err = ex * ex + ey * ey;
        if (err0 === null) err0 = err;
        if (err < 1e-6) return q;
        var dq = linInv(ex, ey);
        q.x += dq.x; q.y += dq.y;
      }
      var Fq = forwardXY(q.x, q.y), e2 = (px - Fq.px) * (px - Fq.px) + (py - Fq.py) * (py - Fq.py);
      return e2 <= err0 ? q : q0;
    }

    return {
      kind: kind,
      count: pts.length,
      points: pts,
      frame: frame,
      lin: { a: a, b: b, c: c, d: d, e: e, f: f },
      pxPerM: pxPerM,
      rmsResidualM: Math.sqrt(sr / W) / pxPerM,
      toXY: frame.toXY,
      affineXY: affineXY,
      forwardXY: forwardXY,
      forward: function (lat, lon) { var q = frame.toXY(lat, lon); return forwardXY(q.x, q.y); },
      inverseXY: inverseXY,
      inverse: function (px, py) { var q = inverseXY(px, py); return frame.toLatLon(q.x, q.y); },
      /**
       * 真北顺时针的朝向 → 图上的角度（图片「上」为 0，顺时针）。
       * 沿朝向走 5 m、两端都过完整映射再量角度：地图转了 90°、又不是严格正北朝上、
       * 局部还被 IDW 掰过，这些都自动算进去了。⚠️ 别写成 heading − 地图旋转角：
       * 那只对纯旋转成立，各向不等缩放下斜方向会偏十几度。
       */
      headingToImage: function (x, y, deg) {
        var h = deg * Math.PI / 180, step = 5;
        var p1 = forwardXY(x, y), p2 = forwardXY(x + step * Math.sin(h), y + step * Math.cos(h));
        var ang = Math.atan2(p2.px - p1.px, -(p2.py - p1.py)) * 180 / Math.PI;
        return (ang + 360) % 360;
      },
    };
  };

  // ── 配准覆盖范围 ─────────────────────────────────
  //
  // 控制点围成的凸包之内是「内插」，之外全靠仿射「外推」，误差会随距离放大。
  // 用凸包判「这一带没有配准参照」，而不是写死某个像素范围（比如音乐广场 py ≥ 1950）：
  // 控制点一换，写死的范围就悄悄过期了，凸包跟着数据走。

  /** 像素平面上的凸包（Andrew 单调链），逆时针；不足 3 点返回原样。 */
  L.convexHull = function (pts) {
    var p = pts.map(function (q) { return { x: +q.px, y: +q.py }; })
      .sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    if (p.length < 3) return p;
    function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
    var lower = [], upper = [], i;
    for (i = 0; i < p.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
      lower.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  };

  /** 点在凸包外多远（像素）；在里面返回 0。凸包退化（<3 点）时按到各点 / 线段的距离算。 */
  L.distOutsideHull = function (hull, x, y) {
    var n = hull.length;
    if (!n) return Infinity;
    if (n >= 3) {
      var inside = true;
      for (var i = 0; i < n; i++) {
        var a = hull[i], b = hull[(i + 1) % n];
        if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) { inside = false; break; }
      }
      if (inside) return 0;
    }
    var best = Infinity;
    for (var j = 0; j < n; j++) {
      var p = hull[j], q = hull[(j + 1) % n];
      var dx = q.x - p.x, dy = q.y - p.y, len2 = dx * dx + dy * dy;
      var t = len2 ? Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / len2)) : 0;
      var ex = p.x + t * dx - x, ey = p.y + t * dy - y;
      best = Math.min(best, Math.sqrt(ex * ex + ey * ey));
    }
    return best;
  };

  /**
   * 一次定位落到图上的结果。inside 带一圈余量：站在图边上的出入口时，
   * 配准误差可能把点推出图外几米，不该因此就说人在「景区外」。
   */
  L.locate = function (model, lat, lon, accM, imgW, imgH, marginM) {
    var q = model.toXY(lat, lon);
    var p = model.forwardXY(q.x, q.y);
    var mPx = (marginM || 0) * model.pxPerM;
    var inside = p.px >= -mPx && p.py >= -mPx && p.px <= imgW + mPx && p.py <= imgH + mPx;
    var c = model.inverseXY(imgW / 2, imgH / 2);
    return {
      x: q.x, y: q.y, px: p.px, py: p.py, inside: inside,
      distToCenterM: Math.sqrt((q.x - c.x) * (q.x - c.x) + (q.y - c.y) * (q.y - c.y)),
      accPx: (accM > 0 ? accM : 0) * model.pxPerM,
    };
  };

  return L;
});
