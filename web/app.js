/*
 * 界面层：地图平移缩放、剧场标记、底部场次面板、我的位置、现场校准、海报查看。
 * 纯计算都在 logic.js（window.LZM_LOGIC），这里只管状态和 DOM。
 *
 * 定位来源三选一，互斥：
 *   ?lat=&lon=               模拟一次定位并屏蔽真实传感器（浏览器里调试、截图用）
 *   window.AndroidBridge 在   原生壳推送：LZM_onLocation / LZM_onHeading / LZM_onLocationStatus
 *   否则                     navigator.geolocation + deviceorientation(absolute)
 * ⚠️ 有原生壳时别再碰 navigator.geolocation：WebView 会再弹一次自己的权限框，
 *    两路定位各报各的，蓝点会在两个位置之间来回跳。
 *
 * 时刻表有多期：内置的 data/schedule.js 永远在，导入的存 localStorage；SCHED / SHOWS 指向
 * 「今天生效的那一期」，每次 refresh 用 L.pickSchedule 重挑（跨零点自动换期）。导入流程：
 *   设置 ──pickPoster──> 原生拍照 / 选图 + OCR ──LZM_onPosterProgress×N──> [识别中]
 *        ──LZM_onPosterResult(json)──> poster.js 解析 ──> [预览 / 就地改] ──确认──> 存档、立即重挑
 *                                                              └─放弃 / 返回──> deletePoster
 */
(function () {
  'use strict';

  var L = window.LZM_LOGIC;
  var PP = window.LZM_POSTER || null;
  var BUILTIN = window.LZM_SCHEDULE || {};
  var SCHED = BUILTIN;
  var SHOWS = [];
  var VENUES = (Array.isArray(window.LZM_VENUES) ? window.LZM_VENUES : []).filter(hasPx);
  var POIS = (Array.isArray(window.LZM_POIS) ? window.LZM_POIS : []).filter(hasPx);
  var GEO = window.LZM_GEO || {};
  var GEO_IMG = GEO.image || {};
  var MAP_W = +GEO_IMG.width || 1280;
  var MAP_H = +GEO_IMG.height || 2275;
  var MAP_SRC = GEO_IMG.src || 'img/map.jpg';
  var BRIDGE = window.AndroidBridge || null;

  var Q = parseQuery(location.search);
  var DEBUG = Q.debug === '1';
  var SIM = isFinite(parseFloat(Q.lat)) && isFinite(parseFloat(Q.lon));

  var CALIB_KEY = 'lzm.calib.v1';
  var REFRESH_MS = 15000;
  var MAX_SCALE = 3;
  // 放大到这个倍数才在标记下挂剧场名：再小，相邻剧场（魔术 / 功夫传奇）的名字会叠在一起。
  var LABEL_SCALE = 0.62;
  // 点「定位」时至少放大到这里：整图适配时一个剧场只有指甲盖大，蓝点看不出在哪条街。
  var LOCATE_MIN_SCALE = 0.9;
  var CALIB_WARN_ACC_M = 30;
  var FIX_STALE_MS = 60000;
  var HEADING_STALE_MS = 10000;
  // 步速以上才信 GPS bearing：站着不动时它是随机数，走起来它比指南针稳（不受手机姿态影响）。
  var BEARING_MIN_SPEED = 1;
  var INSIDE_MARGIN_M = 60;
  // 落在底稿控制点凸包外超过 25 m 才算「这一带没有配准参照」：凸包边上那一圈还在 RMS（约 10 m）量级内，
  // 一出门就弹提醒只会让人觉得哪儿都不准。
  var WEAK_ZONE_M = 25;
  // 身边 100 m 内已经有校准点，就别再劝人校准了（IDW 修正在这个范围内仍有一半以上的分量）。
  var WEAK_CALIB_NEAR_M = 100;
  var NOTICE_KEY = 'lzm.notice.v1';
  var WEEK = '日一二三四五六';
  var NOREG_MSG = '这张导览图暂时没法和手机定位对上，只能看演出时间。\n可在「设置 → 位置校准」里现场对准两处地点来开启。';

  // ── 原生回调先挂上：壳可能在页面一加载完就开始推，别让第一条定位落空 ─────────────────

  window.LZM_onLocation = function (lat, lon, acc, speed, bearing, timeMs, provider) {
    if (SIM) return;
    acceptFix(lat, lon, acc, speed, bearing, timeMs, provider || 'gps');
  };
  window.LZM_onHeading = function (deg, accuracy) {
    if (SIM) return;
    acceptHeading(deg, accuracy);
  };
  window.LZM_onLocationStatus = function (status) {
    if (SIM) return;
    setLocStatus(String(status || ''));
  };
  window.LZM_onBack = function () { return handleBack(); };
  window.LZM_onPosterProgress = function (stage) { onPosterProgress(String(stage || '')); };
  // 契约：参数是 JSON 字符串（不是对象），原生那边省得自己拼 JS 字面量、也不怕引号转义。
  window.LZM_onPosterResult = function (json) { onPosterResult(json); };

  // ── 状态 ─────────────────────────────────

  var timeOffset = 0;
  if (Q.now) {
    var simNow = L.parseLocalDateTime(Q.now);
    if (simNow != null) timeOffset = simNow - Date.now();
    else console.warn('[LZM] ?now 格式不对，应为 2026-11-26T14:20，按真实时间走：' + Q.now);
  }
  function now() { return Date.now() + timeOffset; }

  var state = {
    sts: [],
    view: { kind: 'list' },
    sheet: 'peek',
    peekH: 150,
    follow: false,
    pendingLocate: false,
    locStatus: 'searching',
    fix: null,
    heading: null, headingAt: 0, hx: 0, hy: 0, headingAcc: null,
    me: null,
    calib: loadCalib(),
    points: [],
    model: null,
    hull: [],
    venueXY: {},
    calibMode: false,
    calibWarned: false,
    cross: { x: 0, y: 0 },
  };

  var venueById = {}, showById = {}, showsByVenue = {}, markerVenues = [];
  VENUES.forEach(function (v) { venueById[v.id] = v; });

  /** 换期时重建「节目 / 剧场」索引。标记要跟着重建（buildMarkers），这里不碰 DOM。 */
  function indexShows() {
    showById = {}; showsByVenue = {};
    var orphanVenueIds = [];
    SHOWS.forEach(function (s, i) {
      showById[s.id] = s;
      if (!s.venueId) return;
      if (!venueById[s.venueId]) { orphanVenueIds.push(s.venueId); return; }
      (showsByVenue[s.venueId] = showsByVenue[s.venueId] || []).push(i);
    });
    if (orphanVenueIds.length) {
      console.warn('[LZM] 这些 venueId 在 venues.js 里找不到，对应节目不上图、不算步行：' + orphanVenueIds.join(','));
    }
    markerVenues = VENUES.filter(function (v) { return showsByVenue[v.id]; });
  }

  // ── 多期时刻表 ─────────────────────────────────

  var SCHEDS_KEY = 'lzm.schedules.v1';
  var imported = loadImported();
  // key：'builtin' 或导入那期的 id。null = 还没挑过，下一次 applyEffective 必定重建。
  var active = { key: null, entry: null, outOfRange: false };

  /** 按今天重挑生效的那一期；换了期返回 true（调用方负责重绘）。 */
  function applyEffective(t) {
    var p = L.pickSchedule(BUILTIN, imported, L.ymd(t));
    var key = p.entry ? p.entry.id : 'builtin';
    active.outOfRange = p.outOfRange;
    if (key === active.key) return false;
    active.key = key;
    active.entry = p.entry;
    SCHED = p.schedule || {};
    SHOWS = Array.isArray(SCHED.shows) ? SCHED.shows : [];
    indexShows();
    // 正看着的节目 / 剧场在新一期里没有了，退回列表，别对着一个不存在的 id 渲染
    if (state.view.kind === 'show' && !showById[state.view.id]) state.view = { kind: 'list' };
    if (state.view.kind === 'venue' && !showsByVenue[state.view.id]) state.view = { kind: 'list' };
    buildMarkers();
    return true;
  }

  function loadImported() {
    var raw;
    try { raw = window.localStorage.getItem(SCHEDS_KEY); }
    catch (e) { console.warn('[LZM] 读不了 localStorage，只用内置时刻表', e); return []; }
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(function (x) {
        return x && x.id && x.schedule && Array.isArray(x.schedule.shows) && /^\d{4}-\d{2}-\d{2}$/.test(x.schedule.validFrom || '');
      }) : [];
    } catch (e) {
      console.warn('[LZM] 导入的时刻表存档损坏，只用内置时刻表 len=' + raw.length, e);
      return [];
    }
  }

  function saveImported() {
    try { window.localStorage.setItem(SCHEDS_KEY, JSON.stringify(imported)); return true; }
    catch (e) { console.warn('[LZM] 导入的时刻表没存下来，本次打开内有效、关掉就丢 n=' + imported.length, e); return false; }
  }

  function deletePoster(id) {
    if (!id || !BRIDGE || typeof BRIDGE.deletePoster !== 'function') return;
    try { BRIDGE.deletePoster(String(id)); }
    catch (e) { console.warn('[LZM] deletePoster 调用失败，原图留在手机里 posterId=' + id, e); }
  }

  // ── DOM ─────────────────────────────────

  function $(id) { return document.getElementById(id); }
  var stageEl = $('stage'), worldEl = $('world'), mapImg = $('mapImg');
  var markerLayer = $('markerLayer'), debugLayer = $('debugLayer'), poiLayer = $('poiLayer');
  var meEl = $('me'), meAcc = $('meAcc'), meCone = $('meCone');
  var topbarEl = $('topbar'), bannerEl = $('banner'), clockTime = $('clockTime'), clockDate = $('clockDate');
  var locChip = $('locChip'), locText = $('locText');
  var fabsEl = $('fabs'), fabLocate = $('fabLocate');
  var sheetEl = $('sheet'), headEl = $('sheetHead'), bodyEl = $('sheetBody'), peekEl = $('peek');
  var sheetTitle = $('sheetTitle'), sheetMeta = $('sheetMeta'), backBtn = $('backBtn');
  var calibBar = $('calibBar'), calibGps = $('calibGps'), calibPois = $('calibPois'), calibWarn = $('calibWarn');
  var calibOk = $('calibOk'), crosshairEl = $('crosshair');
  var settingsEl = $('settings'), posterEl = $('poster'), toastEl = $('toast'), dbgEl = $('dbg');
  var alertEl = $('alert'), alertText = $('alertText'), alertAct = $('alertAct'), noticeEl = $('notice');

  // ── 平移缩放 ─────────────────────────────────

  var TAP_SLOP = 8;

  /**
   * 一块可拖动 / 双指缩放 / 双击放大 / 滚轮缩放的画布。地图和海报共用。
   *
   * 视图 = (s, tx, ty)：内容像素 (x, y) 在屏幕上的位置是 (x·s + tx, y·s + ty)。
   * insets 是被浮层盖住的边（顶栏、底部面板）：平移夹在「图边缘能露到浮层边上」为止，
   * 而不是屏幕边缘——否则图的最下面一截永远藏在面板底下拖不出来。
   */
  function PanZoom(stage, world, o) {
    this.stage = stage;
    this.world = world;
    this.cw = o.width; this.ch = o.height;
    this.maxScale0 = o.maxScale || 3;
    this.maxScale = this.maxScale0;
    this.minScale = 0.05;
    this.insets = o.insets || zeroInsets;
    this.fitInsets = o.fitInsets || this.insets;
    this.onChange = o.onChange || noop;
    this.onTap = o.onTap || null;
    this.onUserGesture = o.onUserGesture || noop;
    this.s = 1; this.tx = 0; this.ty = 0;
    this.pts = {};
    this.g = null;
    this.anim = 0;
    this.lastTap = null;
    var self = this;
    stage.addEventListener('pointerdown', function (e) { self._down(e); });
    stage.addEventListener('pointermove', function (e) { self._move(e); });
    stage.addEventListener('pointerup', function (e) { self._up(e, false); });
    stage.addEventListener('pointercancel', function (e) { self._up(e, true); });
    stage.addEventListener('wheel', function (e) { self._wheel(e); }, { passive: false });
  }

  PanZoom.prototype.setContentSize = function (w, h) { this.cw = w; this.ch = h; };

  PanZoom.prototype._ids = function () { return Object.keys(this.pts); };

  PanZoom.prototype._down = function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.stopAnim();
    this.stage.setPointerCapture(e.pointerId);
    this.pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    var n = this._ids().length;
    if (n === 1) {
      this.g = { x0: e.clientX, y0: e.clientY, t0: e.timeStamp, moved: false, multi: false,
        lastX: e.clientX, lastY: e.clientY, lastT: e.timeStamp, vx: 0, vy: 0 };
    } else if (this.g) {
      this.g.multi = true;
      this._startPinch();
    }
  };

  PanZoom.prototype._startPinch = function () {
    var ids = this._ids(), a = this.pts[ids[0]], b = this.pts[ids[1]];
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    this.g.d0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    this.g.s0 = this.s;
    // 记住双指中点下的那个内容点，之后每帧让它仍在新的中点下：缩放 + 平移一次算完。
    this.g.cx = (mx - this.tx) / this.s;
    this.g.cy = (my - this.ty) / this.s;
  };

  PanZoom.prototype._move = function (e) {
    var p = this.pts[e.pointerId], g = this.g;
    if (!p || !g) return;
    p.x = e.clientX; p.y = e.clientY;
    var ids = this._ids();
    if (ids.length >= 2) {
      var a = this.pts[ids[0]], b = this.pts[ids[1]];
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var s = this.clampScale(g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0);
      if (!g.moved) { g.moved = true; this.onUserGesture(); }
      this._set(s, mx - g.cx * s, my - g.cy * s);
      return;
    }
    if (!g.moved) {
      // 没出抖动范围前不动图：手指按下时的细微滑动不该让地图跟着蹭。
      if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < TAP_SLOP) return;
      g.moved = true;
      this.onUserGesture();
    }
    var dx = e.clientX - g.lastX, dy = e.clientY - g.lastY, dt = e.timeStamp - g.lastT;
    this._set(this.s, this.tx + dx, this.ty + dy);
    if (dt > 0) { g.vx = 0.6 * g.vx + 0.4 * dx / dt; g.vy = 0.6 * g.vy + 0.4 * dy / dt; }
    g.lastX = e.clientX; g.lastY = e.clientY; g.lastT = e.timeStamp;
  };

  PanZoom.prototype._up = function (e, cancelled) {
    if (!this.pts[e.pointerId]) return;
    delete this.pts[e.pointerId];
    var g = this.g, ids = this._ids();
    if (!g) return;
    if (ids.length >= 2) { this._startPinch(); return; }
    if (ids.length === 1) {
      // 双指松开一指：剩下那根接着拖。⚠️ 不重置参考点的话，图会一下跳到那根手指的位置。
      var rest = this.pts[ids[0]];
      g.lastX = rest.x; g.lastY = rest.y; g.lastT = e.timeStamp; g.vx = g.vy = 0;
      return;
    }
    this.g = null;
    if (cancelled) return;
    if (!g.moved && !g.multi && e.timeStamp - g.t0 < 600) { this._tap(e.clientX, e.clientY, e.timeStamp); return; }
    if (g.moved && !g.multi && e.timeStamp - g.lastT < 80) this._fling(g.vx, g.vy);
  };

  PanZoom.prototype._tap = function (x, y, t) {
    if (this.onTap && this.onTap(x, y)) { this.lastTap = null; return; }
    var lt = this.lastTap;
    if (lt && t - lt.t < 320 && Math.hypot(x - lt.x, y - lt.y) < 40) {
      this.lastTap = null;
      if (this.s >= this.maxScale * 0.98) this.fit(true);
      else this.zoomAt(2, x, y, true);
      this.onUserGesture();
      return;
    }
    this.lastTap = { x: x, y: y, t: t };
  };

  PanZoom.prototype._wheel = function (e) {
    e.preventDefault();
    this.stopAnim();
    var dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
    this.zoomAt(Math.exp(-dy * 0.0018), e.clientX, e.clientY, false);
    this.onUserGesture();
  };

  PanZoom.prototype._fling = function (vx, vy) {
    if (Math.hypot(vx, vy) < 0.25) return;
    var self = this, last = performance.now();
    function step(t) {
      var dt = Math.min(40, t - last);
      last = t;
      var k = Math.pow(0.995, dt);
      vx *= k; vy *= k;
      var ox = self.tx, oy = self.ty;
      self._set(self.s, self.tx + vx * dt, self.ty + vy * dt);
      if (Math.hypot(vx, vy) < 0.02 || (Math.abs(self.tx - ox) < 0.01 && Math.abs(self.ty - oy) < 0.01)) { self.anim = 0; return; }
      self.anim = requestAnimationFrame(step);
    }
    this.anim = requestAnimationFrame(step);
  };

  PanZoom.prototype.stopAnim = function () {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
  };

  PanZoom.prototype.clampScale = function (s) { return Math.min(this.maxScale, Math.max(this.minScale, s)); };

  PanZoom.prototype.clampView = function (s, tx, ty) {
    var vw = this.stage.clientWidth, vh = this.stage.clientHeight, ins = this.insets();
    s = this.clampScale(s);
    var cw = this.cw * s, ch = this.ch * s;
    var l = ins.left || 0, r = vw - (ins.right || 0), t = ins.top || 0, b = vh - (ins.bottom || 0);
    tx = cw <= r - l ? l + (r - l - cw) / 2 : Math.min(l, Math.max(r - cw, tx));
    ty = ch <= b - t ? t + (b - t - ch) / 2 : Math.min(t, Math.max(b - ch, ty));
    return { s: s, tx: tx, ty: ty };
  };

  PanZoom.prototype._apply = function (s, tx, ty) {
    this.s = s; this.tx = tx; this.ty = ty;
    var st = this.world.style;
    st.width = (this.cw * s).toFixed(2) + 'px';
    st.height = (this.ch * s).toFixed(2) + 'px';
    st.transform = 'translate3d(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px,0)';
    this.onChange(this);
  };

  PanZoom.prototype._set = function (s, tx, ty) {
    var v = this.clampView(s, tx, ty);
    this._apply(v.s, v.tx, v.ty);
  };

  PanZoom.prototype.animateTo = function (s, tx, ty, ms) {
    this.stopAnim();
    var to = this.clampView(s, tx, ty), from = { s: this.s, tx: this.tx, ty: this.ty };
    var self = this, t0 = performance.now(), dur = ms || 280;
    if (Math.abs(to.s - from.s) < 1e-4 && Math.abs(to.tx - from.tx) < 0.5 && Math.abs(to.ty - from.ty) < 0.5) {
      this._apply(to.s, to.tx, to.ty);
      return;
    }
    function step(t) {
      var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      self._apply(from.s + (to.s - from.s) * e, from.tx + (to.tx - from.tx) * e, from.ty + (to.ty - from.ty) * e);
      self.anim = k < 1 ? requestAnimationFrame(step) : 0;
    }
    this.anim = requestAnimationFrame(step);
  };

  PanZoom.prototype.setView = function (s, tx, ty, animate) {
    if (animate) this.animateTo(s, tx, ty);
    else { this.stopAnim(); this._set(s, tx, ty); }
  };

  PanZoom.prototype.computeMin = function () {
    var vw = this.stage.clientWidth, vh = this.stage.clientHeight, ins = this.fitInsets();
    var aw = vw - (ins.left || 0) - (ins.right || 0), ah = vh - (ins.top || 0) - (ins.bottom || 0);
    this.minScale = Math.max(0.01, Math.min(aw / this.cw, ah / this.ch));
    this.maxScale = Math.max(this.maxScale0, this.minScale);
  };

  PanZoom.prototype.fit = function (animate) {
    this.computeMin();
    var vw = this.stage.clientWidth, vh = this.stage.clientHeight, ins = this.fitInsets();
    var s = this.minScale;
    var tx = ((ins.left || 0) + vw - (ins.right || 0) - this.cw * s) / 2;
    var ty = ((ins.top || 0) + vh - (ins.bottom || 0) - this.ch * s) / 2;
    this.setView(s, tx, ty, animate);
  };

  PanZoom.prototype.isAtMin = function () { return this.s <= this.minScale * 1.001; };

  PanZoom.prototype.resize = function () {
    var atMin = this.isAtMin();
    this.computeMin();
    if (atMin) this.fit(false);
    else this._set(this.s, this.tx, this.ty);
  };

  PanZoom.prototype.reclamp = function (animate) {
    var v = this.clampView(this.s, this.tx, this.ty);
    if (Math.abs(v.tx - this.tx) < 0.5 && Math.abs(v.ty - this.ty) < 0.5 && Math.abs(v.s - this.s) < 1e-4) return;
    this.setView(v.s, v.tx, v.ty, animate);
  };

  PanZoom.prototype.regionCenter = function () {
    var vw = this.stage.clientWidth, vh = this.stage.clientHeight, ins = this.insets();
    return { x: ((ins.left || 0) + vw - (ins.right || 0)) / 2, y: ((ins.top || 0) + vh - (ins.bottom || 0)) / 2 };
  };

  /** 把内容点 (cx, cy) 放到可见区域中心；s 不给就保持当前倍数。 */
  PanZoom.prototype.centerOn = function (cx, cy, s, animate) {
    var c = this.regionCenter();
    s = this.clampScale(s || this.s);
    this.setView(s, c.x - cx * s, c.y - cy * s, animate);
  };

  PanZoom.prototype.zoomAt = function (f, x, y, animate) {
    var s1 = this.clampScale(this.s * f);
    var cx = (x - this.tx) / this.s, cy = (y - this.ty) / this.s;
    this.setView(s1, x - cx * s1, y - cy * s1, animate);
  };

  PanZoom.prototype.toScreen = function (x, y) { return { x: x * this.s + this.tx, y: y * this.s + this.ty }; };
  PanZoom.prototype.toContent = function (x, y) { return { x: (x - this.tx) / this.s, y: (y - this.ty) / this.s }; };

  // ── 地图与浮层 ─────────────────────────────────

  var insetsCache = { top: 70, bottom: 150, left: 0, right: 0 };
  var fitInsetsCache = { top: 70, bottom: 150, left: 0, right: 0 };

  var mapPZ = new PanZoom(stageEl, worldEl, {
    width: MAP_W, height: MAP_H, maxScale: MAX_SCALE,
    insets: function () { return insetsCache; },
    fitInsets: function () { return fitInsetsCache; },
    onChange: positionOverlay,
    onTap: onMapTap,
    onUserGesture: function () { if (state.follow) setFollow(false); },
  });

  /**
   * 浮层占掉的边。底边跟着面板当前档位走（最多半屏），让半屏时也能把图最下面的
   * 音乐广场拖到面板上沿；面板收起后 reclamp 会把图自己滑回去。
   * 校准模式下四边都收到准星上：图上任何一点都得能拖到准星底下，包括贴边的出入口。
   */
  function updateInsets() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var topEl = bannerEl.hidden ? topbarEl : bannerEl;
    var top = Math.round(topEl.getBoundingClientRect().bottom + 6);
    // 提醒条压在地图上、不算进 insets：它随 GPS 时有时无，算进去的话地图会跟着一跳一跳。
    alertEl.style.top = top + 'px';
    if (state.calibMode) {
      insetsCache = { top: state.cross.y, bottom: vh - state.cross.y, left: state.cross.x, right: vw - state.cross.x };
    } else {
      insetsCache = { top: top, bottom: Math.min(sheetHeightFor(state.sheet), Math.round(vh * 0.55)), left: 0, right: 0 };
    }
    fitInsetsCache = { top: top, bottom: state.peekH, left: 0, right: 0 };
  }

  // ── 剧场标记 ─────────────────────────────────
  //
  // 标记 = 徽标（圆心钉在剧场上，永远显示）+ 标签（起止时间胶囊，放大后再挂剧场名）。
  // 整图视图下剧场挨得很近（魔术与功夫传奇只隔约 48 px），标签一律挂在正下方必然互相压字，
  // 所以每次缩放都按优先级给标签找位置：下 → 右 → 左 → 上，四面都挤就不显示，只留徽标。
  // 优先级：选中的 > 进行中 > 快开演 > 未开始（越早越前）> 已结束 > 今日不演。

  // ♪ 只给音乐广场；铁花秀是打铁花 + 烟花，用「火」字，免得和音乐广场看成一类。
  var BADGE_GLYPH = { music: '♪', ironflower: '火' };
  var markerEls = [], badgeEls = [], labEls = [], labW = [], labH = [], badgeR = [], labPri = [];
  var labDirty = true;

  function buildMarkers() {
    markerLayer.innerHTML = '';
    markerEls = markerVenues.map(function (v) {
      var el = document.createElement('div');
      el.className = 'mk';
      el.setAttribute('data-venue', v.id);
      el.innerHTML = '<div class="mk-badge"></div><div class="mk-lab"><div class="mk-pill"></div><div class="mk-name"></div></div>';
      el.querySelector('.mk-name').textContent = v.name;
      markerLayer.appendChild(el);
      return el;
    });
    badgeEls = markerEls.map(function (el) { return el.childNodes[0]; });
    labEls = markerEls.map(function (el) { return el.childNodes[1]; });
    labDirty = true;
  }

  var STATE_PRI = { live: 0, soon: 1, upcoming: 2, open: 3, ended: 5, closed: 6 };

  function renderMarkers() {
    var selId = state.view.kind === 'venue' ? state.view.id : null;
    markerVenues.forEach(function (v, i) {
      var el = markerEls[i];
      var best = L.bestOf(showsByVenue[v.id].map(function (idx) { return state.sts[idx]; }));
      // 起止都写：只写开始时间的话，看不出这场 40 分钟还是 2 小时，排不了下一场。
      // ⚠️ 别为了省地方把结束时间去掉，也别拆成两行叠放（真机上用户嫌怪）：单行、结束时间小一号（CSS 控制）。
      var pill;
      switch (best.state) {
        case 'open': pill = '至 ' + best.cur.endHM; break;
        case 'live': case 'soon': case 'upcoming':
          pill = '<b>' + best.cur.startHM + '</b><i>–' + best.cur.endHM + '</i>'; break;
        case 'ended': pill = '已结束'; break;
        default: pill = '今日不演';
      }
      var grey = best.state === 'ended' || best.state === 'closed';
      var cls = 'mk st-' + best.state + (grey ? ' grey' : '') + (v.id === selId ? ' sel' : '');
      if (el.className !== cls) { el.className = cls; labDirty = true; }
      var glyph = best.show.no != null ? String(best.show.no) : BADGE_GLYPH[v.id] || '★';
      setText(badgeEls[i], glyph);
      badgeEls[i].classList.toggle('fire', glyph === '火');
      var p = labEls[i].firstChild;
      if (p.getAttribute('data-v') !== pill) { p.setAttribute('data-v', pill); p.innerHTML = pill; labDirty = true; }
      labPri[i] = v.id === selId ? -1 : STATE_PRI[best.state] + (best.minsToStart ? Math.min(best.minsToStart, 999) / 1000 : 0);
    });
    positionOverlay();
  }

  /** 标签尺寸只在内容或缩放档位变了才量：量一次要强制排版，拖图的每一帧都量会掉帧。 */
  function measureLabels() {
    for (var i = 0; i < markerEls.length; i++) {
      badgeR[i] = badgeEls[i].offsetWidth / 2;
      labW[i] = labEls[i].offsetWidth;
      labH[i] = labEls[i].offsetHeight;
    }
    labDirty = false;
  }

  function overlaps(a, b) {
    return a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
  }

  var fabRect = null;
  function layoutLabels(s, tx, ty) {
    var n = markerEls.length, obst = [], out = new Array(n), order = [], vw = window.innerWidth, i;
    for (i = 0; i < n; i++) {
      var v0 = markerVenues[i], x0 = v0.px * s + tx, y0 = v0.py * s + ty, r0 = badgeR[i];
      obst.push({ l: x0 - r0, t: y0 - r0, r: x0 + r0, b: y0 + r0 });
      order.push(i);
    }
    if (fabRect) obst.push(fabRect);
    order.sort(function (a, b) { return labPri[a] - labPri[b] || a - b; });
    order.forEach(function (k) {
      var v = markerVenues[k], x = v.px * s + tx, y = v.py * s + ty, r = badgeR[k], w = labW[k], h = labH[k];
      // 先试正下 / 右 / 左 / 正上，再试贴着徽标的斜向和错位：单行胶囊比两行叠放宽一倍，
      // 只有四个正方向的话，密集处（3/4/5、7/10）会有标签无处可放被藏掉。
      var cands = [[-w / 2, r + 2], [r + 3, -h / 2], [-r - 3 - w, -h / 2], [-w / 2, -r - 2 - h],
        [-r, r + 2], [r - w, r + 2], [-r, -r - 2 - h], [r - w, -r - 2 - h],
        [r + 3, -r], [r + 3, r - h], [-r - 3 - w, -r], [-r - 3 - w, r - h]];
      // 第一轮还要求不出屏幕左右边，实在放不下第二轮才放宽（宁可半截出屏也比不显示强）。
      for (var pass = 0; pass < 2 && !out[k]; pass++) {
        for (var c = 0; c < cands.length; c++) {
          var rc = { l: x + cands[c][0], t: y + cands[c][1], r: x + cands[c][0] + w, b: y + cands[c][1] + h };
          if (pass === 0 && (rc.l < 2 || rc.r > vw - 2)) continue;
          if (obst.some(function (o) { return overlaps(o, rc); })) continue;
          out[k] = cands[c];
          obst.push(rc);
          break;
        }
      }
    });
    return out;
  }

  var lastZoomed = null;
  function positionOverlay() {
    var s = mapPZ.s, tx = mapPZ.tx, ty = mapPZ.ty;
    var zoomed = s >= LABEL_SCALE;
    if (zoomed !== lastZoomed) { markerLayer.classList.toggle('zoomed', zoomed); lastZoomed = zoomed; labDirty = true; }
    if (labDirty) measureLabels();
    var pos = layoutLabels(s, tx, ty);
    for (var i = 0; i < markerEls.length; i++) {
      var v = markerVenues[i];
      markerEls[i].style.transform = 'translate3d(' + (v.px * s + tx).toFixed(1) + 'px,' + (v.py * s + ty).toFixed(1) + 'px,0)';
      var p = pos[i], lab = labEls[i];
      if (p) {
        lab.style.visibility = '';
        lab.style.transform = 'translate(' + p[0].toFixed(1) + 'px,' + p[1].toFixed(1) + 'px)';
      } else {
        lab.style.visibility = 'hidden';
      }
    }
    positionMe();
    positionDots(debugEls, debugPts);
    if (state.calibMode) { positionDots(poiEls, POIS); schedulePoiChips(); }
  }

  function positionDots(els, pts) {
    if (!els.length) return;
    var s = mapPZ.s, tx = mapPZ.tx, ty = mapPZ.ty;
    for (var i = 0; i < els.length; i++) {
      els[i].style.transform = 'translate3d(' + (pts[i].px * s + tx).toFixed(1) + 'px,' + (pts[i].py * s + ty).toFixed(1) + 'px,0)';
    }
  }

  function hitMarker(x, y) {
    var best = null, bestD = Infinity;
    // 徽标和（显示着的）标签都算点中；同时命中几个取徽标圆心最近的。
    markerEls.forEach(function (el, i) {
      var rects = [badgeEls[i].getBoundingClientRect()];
      if (labEls[i].style.visibility !== 'hidden') rects.push(labEls[i].getBoundingClientRect());
      var pad = 6, hit = rects.some(function (r) {
        return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
      });
      if (!hit) return;
      var b = rects[0], d = Math.hypot(x - (b.left + b.right) / 2, y - (b.top + b.bottom) / 2);
      if (d < bestD) { bestD = d; best = markerVenues[i].id; }
    });
    return best;
  }

  function onMapTap(x, y) {
    if (state.calibMode) return false;
    var hit = hitMarker(x, y);
    if (hit) { openVenue(hit); return true; }
    if (DEBUG) {
      var c = mapPZ.toContent(x, y), msg = 'px ' + Math.round(c.x) + ', py ' + Math.round(c.y);
      if (state.model) { var ll = state.model.inverse(c.x, c.y); msg += '\n' + ll.lat.toFixed(6) + ', ' + ll.lon.toFixed(6); }
      toast(msg);
    } else if (state.sheet !== 'peek') {
      setSheet('peek');
    }
    return false;
  }

  /** 剧场被面板 / 顶栏挡住时才挪图；本来就看得见就别动，免得每点一下地图都晃。 */
  function ensureVisible(px, py) {
    var p = mapPZ.toScreen(px, py), ins = insetsCache, vw = window.innerWidth, vh = window.innerHeight;
    var m = 48;
    if (p.x < m || p.x > vw - m || p.y < ins.top + m || p.y > vh - ins.bottom - m) mapPZ.centerOn(px, py, null, true);
  }

  // ── 我的位置 ─────────────────────────────────

  function setLocStatus(st) {
    if (['denied', 'disabled', 'searching', 'ok', 'unavailable', 'unsupported'].indexOf(st) < 0) {
      console.warn('[LZM] 未知定位状态 status=' + st + '，按定位中处理');
      st = 'searching';
    }
    state.locStatus = st;
    renderChip();
    renderMe();
    if (state.calibMode) renderCalibGps();
  }

  function acceptFix(lat, lon, acc, speed, bearing, timeMs, provider) {
    lat = +lat; lon = +lon;
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      console.warn('[LZM] 丢弃无效定位 lat=' + lat + ' lon=' + lon);
      return;
    }
    state.fix = {
      lat: lat, lon: lon,
      acc: +acc > 0 ? +acc : 0,
      speed: isFinite(+speed) ? +speed : -1,
      bearing: isFinite(+bearing) ? +bearing : -1,
      time: +timeMs || Date.now(),
      provider: String(provider || ''),
      receivedAt: Date.now(),
    };
    state.locStatus = 'ok';
    var wasInside = !!(state.me && state.me.inside);
    relocate();
    var me = state.me;
    if (me && (state.follow || state.pendingLocate)) {
      if (me.inside) {
        if (state.pendingLocate) setFollow(true);
        mapPZ.centerOn(me.px, me.py, state.pendingLocate ? Math.max(mapPZ.s, LOCATE_MIN_SCALE) : null, true);
      } else if (state.pendingLocate) {
        toast('你在景区外，距演艺城 ' + L.fmtDistance(me.distToCenterM));
      }
      state.pendingLocate = false;
    }
    if (state.calibMode) renderCalibGps();
    // 进出景区那一下（含第一次定位）立刻重绘，步行时间要马上出来；之后只是分钟数微调，节流即可。
    if (wasInside !== !!(me && me.inside)) renderSheet();
    else throttledSheetRender();
  }

  function acceptHeading(deg, accuracy) {
    deg = +deg;
    if (!isFinite(deg)) return;
    var r = deg * Math.PI / 180, sx = Math.sin(r), cy = Math.cos(r);
    // 在单位向量上做低通，而不是对角度做：359° 和 1° 的平均是 0° 不是 180°。
    if (state.heading == null) { state.hx = sx; state.hy = cy; }
    else { state.hx += (sx - state.hx) * 0.3; state.hy += (cy - state.hy) * 0.3; }
    state.heading = (Math.atan2(state.hx, state.hy) * 180 / Math.PI + 360) % 360;
    state.headingAt = Date.now();
    state.headingAcc = accuracy == null || accuracy === '' || !isFinite(+accuracy) ? null : +accuracy;
    scheduleMe();
  }

  function bearingUsable() {
    var f = state.fix;
    return !!(f && f.speed > BEARING_MIN_SPEED && f.bearing >= 0 && Date.now() - f.receivedAt < 5000);
  }

  function effectiveHeading() {
    if (bearingUsable()) return state.fix.bearing;
    if (state.heading != null && (SIM || Date.now() - state.headingAt < HEADING_STALE_MS)) return state.heading;
    return null;
  }

  /**
   * 指南针是否不可信。口径统一成 Android SensorManager 的精度档：0 不可靠、1 低、2 中、3 高，
   * ≤1 算不可信；浏览器那边（iOS 给的是误差度数）在入口处换算成这套档位。
   * 走动中用的是 GPS bearing，指南针准不准无所谓，不报。
   */
  function compassWeak() {
    return !bearingUsable() && state.heading != null && state.headingAcc != null && state.headingAcc <= 1;
  }

  // ── 就地提醒：同一时间只亮一条，按「能马上处理的」优先 ─────────────────

  var alertDismissed = {};

  function weakZoneName() {
    var me = state.me, m = state.model;
    if (!me || !me.inside || !m) return null;
    if (L.distOutsideHull(state.hull, me.px, me.py) / m.pxPerM <= WEAK_ZONE_M) return null;
    var f = state.fix;
    var calibNear = state.calib.some(function (c) { return L.distanceM(c.lat, c.lon, f.lat, f.lon) < WEAK_CALIB_NEAR_M; });
    if (calibNear) return null;
    // 用最近的剧场 / 参照点给这一带起名，比「这里」好认；都太远就叫「这一带」。
    var best = null, bestD = 150 * m.pxPerM;
    VENUES.concat(POIS).forEach(function (p) {
      var d = Math.hypot(p.px - me.px, p.py - me.py);
      if (d < bestD) { bestD = d; best = p; }
    });
    return best ? String(best.name).replace(/[(（].*$/, '') + '一带' : '这一带';
  }

  function currentAlert() {
    if (state.calibMode) return null;
    var me = state.me, f = state.fix, list = [];
    if (me && me.inside) {
      var zone = weakZoneName();
      if (zone) list.push({ kind: 'weak', text: zone + '定位偏差较大，建议在这里校准一次', act: '去校准' });
      if (f.acc > CALIB_WARN_ACC_M) list.push({ kind: 'acc', text: '定位精度 ±' + Math.round(f.acc) + ' 米，到空旷处会更准' });
      if (compassWeak()) list.push({ kind: 'compass', text: '指南针不准：拿着手机在空中画几次 8 字' });
    }
    for (var i = 0; i < list.length; i++) if (!alertDismissed[list[i].kind]) return list[i];
    return null;
  }

  function renderAlert() {
    var a = currentAlert();
    if (!a) { alertEl.hidden = true; return; }
    setText(alertText, a.text);
    alertEl.setAttribute('data-kind', a.kind);
    alertAct.hidden = !a.act;
    if (a.act) setText(alertAct, a.act);
    alertEl.hidden = false;
  }

  function rebuildModel() {
    var base = Array.isArray(GEO.controlPoints) ? GEO.controlPoints : [];
    state.points = L.mergeControlPoints(base, state.calib);
    state.model = L.buildGeoModel(state.points);
    // 凸包只用底稿点：校准点是「这里已经补过了」，交给 WEAK_CALIB_NEAR_M 判，别让它把凸包撑大。
    state.hull = L.convexHull(state.points.filter(function (p) { return p.kind === 'base'; }));
    state.venueXY = {};
    renderDebugPoints();
    relocate();
  }

  function relocate() {
    var f = state.fix;
    state.me = state.model && f ? L.locate(state.model, f.lat, f.lon, f.acc, MAP_W, MAP_H, INSIDE_MARGIN_M) : null;
    renderMe();
    renderChip();
    renderAlert();
    renderDbg();
  }

  var meRaf = 0;
  function scheduleMe() {
    if (!meRaf) meRaf = requestAnimationFrame(function () { meRaf = 0; renderMe(); renderAlert(); renderDbg(); });
  }

  function renderMe() {
    var m = state.me;
    var show = !!(m && m.inside);
    if (meEl.hidden === show) meEl.hidden = !show;
    if (!show) return;
    meEl.classList.toggle('stale', Date.now() - state.fix.receivedAt > FIX_STALE_MS);
    var hd = effectiveHeading();
    if (hd == null) {
      meCone.classList.add('off');
    } else {
      meCone.classList.remove('off');
      meCone.classList.toggle('weak', compassWeak());
      meCone.style.transform = 'rotate(' + state.model.headingToImage(m.x, m.y, hd).toFixed(1) + 'deg)';
    }
    positionMe();
  }

  function positionMe() {
    if (meEl.hidden || !state.me) return;
    var s = mapPZ.s, m = state.me;
    meEl.style.transform = 'translate3d(' + (m.px * s + mapPZ.tx).toFixed(1) + 'px,' + (m.py * s + mapPZ.ty).toFixed(1) + 'px,0)';
    var r = m.accPx * s;
    // 圈比蓝点本身还小时不画：画出来只是蓝点外面一圈毛边，反倒像没对齐。
    meAcc.hidden = r < 13;
    if (r >= 13) {
      var d = (2 * r).toFixed(1) + 'px', o = (-r).toFixed(1) + 'px';
      meAcc.style.width = d; meAcc.style.height = d; meAcc.style.left = o; meAcc.style.top = o;
    }
  }

  /**
   * 顶部定位胶囊。文案只用游客听得懂的话：⚠️ 别写「无配准数据」「GPS」这类开发者用语，
   * 用户在真机上看到「无配准数据」完全不知道该干什么。
   */
  function chipState() {
    if (!state.model) return { text: '仅显示演出时间', cls: 'muted', act: 'noreg' };
    if (state.locStatus === 'denied') return { text: '没给定位权限', cls: 'warn', act: 'perm' };
    if (state.locStatus === 'disabled') return { text: '定位没开', cls: 'warn', act: 'settings' };
    if (state.locStatus === 'unsupported') return { text: '这台设备不能定位', cls: 'muted', act: '' };
    var f = state.fix;
    var stale = f && Date.now() - f.receivedAt > FIX_STALE_MS;
    if (!f || (stale && state.locStatus === 'searching')) {
      return state.locStatus === 'unavailable'
        ? { text: '暂时定位不到', cls: 'warn', act: 'wait' }
        : { text: '定位中…', cls: 'muted searching', act: 'wait' };
    }
    if (state.me && !state.me.inside) {
      return { text: '不在景区 · 距 ' + L.fmtDistance(state.me.distToCenterM), cls: 'warn', act: 'outside' };
    }
    return { text: '已定位 ±' + Math.round(f.acc) + ' m', cls: 'ok' + (stale ? ' stale' : ''), act: 'locate' };
  }

  function renderChip() {
    var c = chipState();
    var cls = 'loc-chip ' + c.cls;
    if (locChip.className !== cls) locChip.className = cls;
    if (locText.textContent !== c.text) locText.textContent = c.text;
    locChip.setAttribute('data-act', c.act);
  }

  function onChipClick() {
    var act = locChip.getAttribute('data-act');
    if (act === 'noreg') toast(NOREG_MSG);
    else if (act === 'perm') requestPermission();
    else if (act === 'settings') openLocationSettings();
    else if (act === 'outside') toast('你在景区外，距演艺城 ' + L.fmtDistance(state.me.distToCenterM) + '\n进了景区蓝点会出现在图上');
    else if (act === 'wait') toast('正在定位，到室外开阔处会快一些');
    else if (act === 'locate') onLocateClick();
  }

  function requestPermission() {
    if (BRIDGE && BRIDGE.requestLocationPermission) BRIDGE.requestLocationPermission();
    else toast('定位权限被拒绝了。\n请在浏览器的网站设置里允许本页使用位置。');
  }

  function openLocationSettings() {
    if (BRIDGE && BRIDGE.openLocationSettings) BRIDGE.openLocationSettings();
    else toast('请在手机设置里打开「位置信息」。');
  }

  function setFollow(on) {
    if (state.follow === on) return;
    state.follow = on;
    fabLocate.classList.toggle('on', on);
    // 跟随 = 正边走边看图，这时熄屏最烦人；退出跟随就交还给系统。
    if (BRIDGE && BRIDGE.setKeepScreenOn) BRIDGE.setKeepScreenOn(!!on);
  }

  function onLocateClick() {
    askIosCompass();
    if (!state.model) { toast(NOREG_MSG); return; }
    if (state.locStatus === 'denied') { requestPermission(); return; }
    if (state.locStatus === 'disabled') { openLocationSettings(); return; }
    if (!state.me) { state.pendingLocate = true; toast('正在定位，拿到位置后自动跳过去'); return; }
    if (!state.me.inside) { toast('你在景区外，距演艺城 ' + L.fmtDistance(state.me.distToCenterM)); return; }
    setFollow(true);
    mapPZ.centerOn(state.me.px, state.me.py, Math.max(mapPZ.s, LOCATE_MIN_SCALE), true);
  }

  function venueXY(v) {
    var q = state.venueXY[v.id];
    if (!q) q = state.venueXY[v.id] = state.model.inverseXY(v.px, v.py);
    return q;
  }

  function walkFor(st) {
    var s = st.show, me = state.me;
    if (!me || !me.inside || !s.venueId) return null;
    var v = venueById[s.venueId];
    if (!v) return null;
    var q = venueXY(v);
    var mins = L.walkMinutes(Math.hypot(q.x - me.x, q.y - me.y));
    var late = !s.continuous && (st.state === 'soon' || st.state === 'upcoming') && mins > st.minsToStart;
    return { mins: mins, late: late };
  }

  // ── 浏览器里的定位 / 指南针（没有原生壳时） ─────────────────────────────────

  var browserGeoStarted = false;
  function startBrowserGeo() {
    if (BRIDGE || SIM || browserGeoStarted) return;
    browserGeoStarted = true;
    if (!navigator.geolocation) { setLocStatus('unsupported'); return; }
    setLocStatus('searching');
    navigator.geolocation.watchPosition(function (p) {
      var c = p.coords;
      acceptFix(c.latitude, c.longitude, c.accuracy,
        c.speed == null ? -1 : c.speed,
        c.heading == null || isNaN(c.heading) ? -1 : c.heading,
        p.timestamp, 'browser');
    }, function (err) {
      if (err.code === 1) setLocStatus('denied');
      else if (err.code === 2) setLocStatus('unavailable');
      // code 3 是单次超时，watch 还会继续报，保持「定位中」
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });

    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', function (e) {
        if (e.alpha != null) acceptHeading(360 - e.alpha + screenAngle(), null);
      });
    } else {
      window.addEventListener('deviceorientation', function (e) {
        if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
          // iOS 给的是误差度数（−1 = 需要校准），换成 Android 的 0–3 档，好和原生壳共用一个判据。
          var a = e.webkitCompassAccuracy;
          acceptHeading(e.webkitCompassHeading + screenAngle(), a == null ? null : a < 0 ? 0 : a <= 15 ? 3 : a <= 30 ? 2 : 1);
        } else if (e.absolute && e.alpha != null) {
          acceptHeading(360 - e.alpha + screenAngle(), null);
        }
        // 非 absolute 的 alpha 以「打开页面时手机朝向」为 0，不是北，画出来是错的，宁可不画。
      });
    }
  }

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }

  var iosAsked = false;
  /** iOS 13+ 的指南针必须在用户点按的同一个调用栈里申请，所以挂在「定位」「校准」按钮上。 */
  function askIosCompass() {
    startBrowserGeo();
    var DOE = window.DeviceOrientationEvent;
    if (BRIDGE || SIM || iosAsked || !DOE || typeof DOE.requestPermission !== 'function') return;
    iosAsked = true;
    DOE.requestPermission().then(function (r) {
      if (r !== 'granted') console.warn('[LZM] 指南针权限没给 r=' + r + '，不画朝向');
    }, function (e) { console.warn('[LZM] 指南针权限申请失败，不画朝向', e); });
  }

  // ── 底部面板 ─────────────────────────────────

  function sheetHeightFor(name) {
    var vh = window.innerHeight;
    if (name === 'peek') return state.peekH;
    if (name === 'half') return Math.round(vh * 0.5);
    return Math.round(vh - topbarEl.getBoundingClientRect().bottom - 8);
  }

  function measurePeek() {
    return Math.round(headEl.offsetHeight + (parseFloat(getComputedStyle(sheetEl).paddingBottom) || 0));
  }

  function setSheet(name, animate) {
    state.sheet = name;
    sheetEl.classList.toggle('is-peek', name === 'peek');
    if (name === 'peek') state.peekH = measurePeek();
    var h = sheetHeightFor(name);
    if (animate === false) sheetEl.classList.add('dragging');
    sheetEl.style.height = h + 'px';
    if (animate === false) { void sheetEl.offsetHeight; sheetEl.classList.remove('dragging'); }
    positionFabs(h, animate !== false);
    updateInsets();
    mapPZ.reclamp(animate !== false);
  }

  function positionFabs(h, animate) {
    var vw = window.innerWidth, vh = window.innerHeight, away = h > vh * 0.6;
    fabsEl.classList.toggle('dragging', !animate);
    fabsEl.style.bottom = (h + 12) + 'px';
    fabsEl.classList.toggle('away', away);
    toastEl.style.bottom = (Math.min(h, vh * 0.6) + 18) + 'px';
    // 按钮列也算标签的障碍物：标签被按钮盖住等于没显示。尺寸与 .fabs/.fab 的 CSS 一致（3×54 + 2×10）。
    var fb = vh - h - 12;
    var next = away ? null : { l: vw - 66, t: fb - 182, r: vw - 8, b: fb };
    if (JSON.stringify(next) !== JSON.stringify(fabRect)) { fabRect = next; positionOverlay(); }
  }

  function toggleSheet() {
    setSheet(state.sheet === 'peek' ? 'half' : state.sheet === 'half' ? 'peek' : 'half');
  }

  // 拖把手 / 标题区改面板高度。点按不在这里处理，交给 click：
  // ⚠️ 别一按下就 setPointerCapture，那样 click 会落到 sheetHead 上，摘要行、返回钮都点不动。
  var drag = null, suppressClickUntil = 0;
  headEl.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { id: e.pointerId, y0: e.clientY, h0: sheetEl.offsetHeight, active: false, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
  });
  headEl.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dy) < TAP_SLOP) return;
      drag.active = true;
      headEl.setPointerCapture(e.pointerId);
      sheetEl.classList.add('dragging');
    }
    var minH = Math.min(state.peekH, headEl.offsetHeight);
    var h = Math.max(minH, Math.min(sheetHeightFor('full'), drag.h0 - dy));
    sheetEl.style.height = h + 'px';
    positionFabs(h, false);
    var dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.v = 0.6 * drag.v + 0.4 * (e.clientY - drag.lastY) / dt;
    drag.lastY = e.clientY; drag.lastT = e.timeStamp;
  });
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    if (!d.active) return;
    // 手指停住再松开是「放在这儿」，不是甩：最后一次移动已经过去 100 ms 就不认速度。
    if (e.timeStamp - d.lastT > 100) d.v = 0;
    suppressClickUntil = Date.now() + 350;
    sheetEl.classList.remove('dragging');
    var h = sheetEl.offsetHeight, H = { peek: state.peekH, half: sheetHeightFor('half'), full: sheetHeightFor('full') };
    var target;
    if (d.v < -0.45) target = h < H.half ? 'half' : 'full';
    else if (d.v > 0.45) target = h > H.half ? 'half' : 'peek';
    else {
      target = 'peek';
      ['half', 'full'].forEach(function (k) { if (Math.abs(h - H[k]) < Math.abs(h - H[target])) target = k; });
    }
    setSheet(target);
  }
  headEl.addEventListener('pointerup', endDrag);
  headEl.addEventListener('pointercancel', endDrag);

  sheetEl.addEventListener('click', function (e) {
    if (Date.now() < suppressClickUntil) return;
    var t = e.target;
    var act = t.closest('[data-act]');
    if (act) { doAct(act.getAttribute('data-act')); return; }
    var row = t.closest('[data-show]');
    if (row) { openShow(row.getAttribute('data-show')); return; }
    if (t.closest('#backBtn')) { showList(); return; }
    if (headEl.contains(t)) toggleSheet();
  });

  // 手指正按在列表上时别整块重绘：innerHTML 一换，按下的那一行就没了，这次点击会落空。
  var touchingBody = false;
  bodyEl.addEventListener('pointerdown', function () { touchingBody = true; });
  ['pointerup', 'pointercancel'].forEach(function (ev) {
    bodyEl.addEventListener(ev, function () { setTimeout(function () { touchingBody = false; }, 50); });
  });

  var lastSheetRender = 0, sheetTimer = 0;
  function throttledSheetRender() {
    var dt = Date.now() - lastSheetRender;
    if (dt >= 3000) { renderSheet(); return; }
    if (!sheetTimer) sheetTimer = setTimeout(function () { sheetTimer = 0; renderSheet(); }, 3000 - dt);
  }

  function viewStatuses() {
    var v = state.view;
    if (v.kind === 'venue') {
      return (showsByVenue[v.id] || []).map(function (i) { return state.sts[i]; }).sort(L.compareStatus);
    }
    if (v.kind === 'show') return state.sts.filter(function (st) { return st.show.id === v.id; });
    return state.sts;
  }

  function renderSheet() {
    if (touchingBody) { setTimeout(renderSheet, 300); return; }
    lastSheetRender = Date.now();
    var v = state.view, sts = viewStatuses();
    if (v.kind === 'list') {
      setText(sheetTitle, '离现在最近的场次');
      backBtn.hidden = true;
      // 露出条 3 行要占约 190 px：905 高的屏上还剩七成给地图；矮屏（如 360×760）只放 2 行，
      // 否则整图缩到 0.2 倍，剧场徽标挤得点不中。
      peekEl.innerHTML = peekHtml(L.peekItems(state.sts, window.innerHeight >= 840 ? 3 : 2, 2), true);
      bodyEl.innerHTML = listHtml();
    } else if (v.kind === 'venue') {
      setText(sheetTitle, venueById[v.id] ? venueById[v.id].name : '剧场');
      backBtn.hidden = false;
      peekEl.innerHTML = peekHtml(sts.slice(0, 2), false);
      bodyEl.innerHTML = sts.map(detailHtml).join('') + footHtml(false);
    } else {
      var s = showById[v.id];
      setText(sheetTitle, s ? groupLabel(L.groupOf(s)) : '演出');
      backBtn.hidden = false;
      peekEl.innerHTML = peekHtml(sts, false);
      bodyEl.innerHTML = sts.map(detailHtml).join('') + footHtml(false);
    }
    setText(sheetMeta, '');
    // 校准时面板是 display:none，量出来是 0；别拿它当收起高度。
    if (state.sheet === 'peek' && !drag && !state.calibMode) {
      var h = measurePeek();
      if (h !== state.peekH) {
        state.peekH = h;
        sheetEl.style.height = h + 'px';
        positionFabs(h, true);
        updateInsets();
        mapPZ.reclamp(true);
      }
    }
  }

  function groupLabel(g) {
    return g === 'venue' ? '演艺城剧场' : g === 'city' ? '演艺城其他' : '园区其他区域';
  }

  function peekHtml(items, isList) {
    if (!items.length) {
      var first = null;
      state.sts.forEach(function (st) {
        if (st.tomorrow && !st.show.continuous && (!first || st.tomorrow.start < first.tomorrow.start)) first = st;
      });
      return '<div class="peek-row empty">今天的演出都结束了' +
        (isList && first ? '，明天最早 ' + rangeHtml(first.tomorrow) + ' ' + titleHtml(first.show) : '') + '</div>';
    }
    return items.map(function (st) {
      return '<div class="peek-row st-' + st.state + '" data-show="' + esc(st.show.id) + '">' +
        timeHtml(st) +
        '<span class="n">' + noHtml(st.show) + titleHtml(st.show) + '</span>' +
        statusHtml(st) + '</div>';
    }).join('');
  }

  /**
   * 左侧起止时间，单行「14:00–15:05」：开始时间是主角，结束时间小一号、同一基线。
   * ⚠️ 别改回两行叠放（真机上用户嫌怪），也别去掉 CSS 的 nowrap——窄屏宁可缩字号也不折行。
   * 今天没场了就显示明天第一场，上面标「明天」。
   */
  function timeHtml(st) {
    var ses = st.cur || st.tomorrow;
    if (!ses) return '<div class="tm"><b>—</b></div>';
    return '<div class="tm">' + (st.cur ? '' : '<em>明天</em>') + '<b>' + ses.startHM + '</b><small>–' + ses.endHM + '</small></div>';
  }

  /** 右侧状态：胶囊写「是什么状态」，下面一行小字写「还剩多久 / 至几点」。整句版见 L.statusText，详情页用。 */
  function statusParts(st) {
    var cont = st.show.continuous;
    switch (st.state) {
      case 'live': return ['进行中', L.fmtLeft(st.minsLeft)];
      // 左列已经是「10:00–17:30」，右边再拆一行「至 17:30」是重复，还让人以为时间折行了。
      case 'open': return ['开放中', ''];
      case 'soon': case 'upcoming': return [L.fmtUntil(st.minsToStart), cont ? st.cur.startHM + ' 开放' : ''];
      case 'ended': return ['今日已结束', ''];
      default: return ['今日不演', ''];
    }
  }

  function statusHtml(st) {
    var p = statusParts(st);
    return '<div class="st"><span class="pill ' + st.state + '">' + esc(p[0]) + '</span>' + (p[1] ? '<small>' + esc(p[1]) + '</small>' : '') + '</div>';
  }

  function listHtml() {
    var groups = [['venue', '演艺城剧场', ''], ['city', '演艺城其他', ''], ['other', '园区其他区域', '不在本图上']];
    var html = '';
    groups.forEach(function (g) {
      var items = state.sts.filter(function (st) { return L.groupOf(st.show) === g[0]; }).sort(L.compareStatus);
      if (!items.length) return;
      html += '<h3 class="grp">' + g[1] + (g[2] ? '<small>' + g[2] + '</small>' : '') + '</h3>' + items.map(rowHtml).join('');
    });
    return html + footHtml(true);
  }

  /**
   * 一行 = 左：起止时间 ｜ 中：节目全名（可折行，⚠️ 别加省略号截断——真机上「今日你有…」被用户点名）
   *              + 剧场 · 步行 · 标签 ｜ 右：状态胶囊 + 还剩多久。
   */
  function rowHtml(st) {
    var s = st.show, v = s.venueId ? venueById[s.venueId] : null;
    var sub = [];
    if (v) sub.push('<span>' + esc(v.name) + '</span>');
    else if (st.cur && st.cur.note) sub.push('<span>' + esc(st.cur.note) + '</span>');
    else if (s.note && s.note.length <= 16) sub.push('<span>' + esc(s.note) + '</span>');
    var w = walkFor(st);
    if (w) sub.push('<span class="walk">步行约 ' + w.mins + ' 分钟</span>');
    if (w && w.late) sub.push('<span class="late">赶不上开场</span>');
    var tags = tagsHtml(s.tags);
    if (tags) sub.push(tags);
    return '<div class="row st-' + st.state + '" data-show="' + esc(s.id) + '">' + timeHtml(st) +
      '<div class="row-main">' +
        '<div class="row-title">' + noHtml(s) + titleHtml(s) + '</div>' +
        (sub.length ? '<div class="row-sub">' + sub.join('') + '</div>' : '') +
      '</div>' + statusHtml(st) + '</div>';
  }

  function detailHtml(st) {
    var s = st.show, t = now();
    var w = walkFor(st);
    var h = '<div class="det"><div class="det-title">' + noHtml(s) + titleHtml(s) + '</div>';
    if (s.tags && s.tags.length) h += '<div class="det-tags">' + tagsHtml(s.tags) + '</div>';
    h += '<div class="det-status"><span class="pill ' + st.state + '">' + esc(L.statusText(st)) + '</span>' +
      (w ? '<span class="walk">步行约 ' + w.mins + ' 分钟</span>' : '') +
      (w && w.late ? '<span class="late">赶不上开场</span>' : '') + '</div>';
    var ses = st.day.sessions;
    if (ses.length) {
      // 一场一行：左「14:00–15:05」，中间场次备注（可折行），右侧状态。
      h += '<div class="det-label">今天' + (s.continuous ? '开放' : ' ' + ses.length + ' 场') + '</div><div class="det-sessions">';
      ses.forEach(function (x) {
        var cls = x.end <= t ? 'past' : x.start <= t ? 'live' : x === st.cur ? 'next' : '';
        var lab = cls === 'past' ? '已结束' : cls === 'live' ? (s.continuous ? '开放中' : '进行中') :
          cls === 'next' ? (st.state === 'soon' ? L.fmtUntil(st.minsToStart) : '下一场') : '';
        h += '<div class="ses ' + cls + '"><span class="ses-tm"><b>' + x.startHM + '</b><small>–' + x.endHM + '</small></span>' +
          '<em>' + esc(x.note || '') + '</em>' + (lab ? '<i>' + lab + '</i>' : '') + '</div>';
      });
      h += '</div>';
    } else {
      h += '<p class="det-empty">今日不演' + (st.tomorrow ? '，明天首场 ' + rangeHtml(st.tomorrow) : '') + '</p>';
    }
    if (st.state === 'ended' && st.tomorrow) h += '<p class="det-empty">明天首场 ' + rangeHtml(st.tomorrow) + '</p>';
    if (s.note) h += '<p class="det-note">' + esc(s.note) + '</p>';
    if (Array.isArray(s.items) && s.items.length) {
      h += '<div class="det-items">' + s.items.map(function (it) { return '<span>' + esc(it) + '</span>'; }).join('') + '</div>';
    }
    return h + '</div>';
  }

  function footHtml(withPoster) {
    return '<div class="foot">' +
      (withPoster ? '<button class="btn" type="button" data-act="poster">查看原海报</button>' : '') +
      '<p>' + sourceHtml() + '</p>' +
      '<button class="link-btn" type="button" data-act="notice">使用须知</button></div>';
  }

  /**
   * 节目名：书名号那一段整体换行（CSS inline-block）。
   * ⚠️ 别直接输出 L.showTitle 整串：时间列改单行后标题列变窄，会断成「《醉美 / 太湖》」。
   */
  function titleHtml(s) {
    return s.title ? esc(s.kind) + '<span class="bk">《' + esc(s.title) + '》</span>' : esc(s.kind);
  }

  /** 句子里夹的时间段：整句可以折行，但「09:30–10:10」本身不许从连接号处断开。 */
  function rangeHtml(ses) {
    return '<span class="nw">' + L.fmtRange(ses) + '</span>';
  }

  function noHtml(s) {
    if (s.no == null) return '';
    var n = +s.no;
    return '<span class="no">' + (n >= 1 && n <= 20 ? String.fromCharCode(0x245F + n) : esc(String(s.no))) + '</span>';
  }

  /** 「单独收费」「雨天停演」是进门前就得知道的事，做成带底色 + 图标的小标签，别和普通说明混在一起。 */
  function tagsHtml(tags) {
    return (tags || []).map(function (t) {
      var cls = /收费/.test(t) ? 'paid' : /雨/.test(t) ? 'rain' : /推荐|必看/.test(t) ? 'hot' : '';
      var ic = cls === 'paid' ? '¥ ' : cls === 'rain' ? '☂ ' : '';
      return '<span class="tag ' + cls + '">' + ic + esc(t) + '</span>';
    }).join('');
  }

  function openShow(id) {
    var s = showById[id];
    if (!s) return;
    if (s.venueId && venueById[s.venueId]) { openVenue(s.venueId); return; }
    state.view = { kind: 'show', id: id };
    afterViewChange();
    if (state.sheet === 'peek') setSheet('half');
  }

  function openVenue(id) {
    state.view = { kind: 'venue', id: id };
    afterViewChange();
    if (state.sheet !== 'half') setSheet('half');
    var v = venueById[id];
    if (v) ensureVisible(v.px, v.py);
  }

  function showList() {
    state.view = { kind: 'list' };
    afterViewChange();
  }

  function afterViewChange() {
    renderSheet();
    bodyEl.scrollTop = 0;
    renderMarkers();
  }

  // ── 时钟与刷新 ─────────────────────────────────

  function refresh() {
    var t = now();
    applyEffective(t);
    state.sts = SHOWS.map(function (s, i) { return L.showStatus(s, t, SCHED, i); });
    var d = new Date(t);
    setText(clockTime, L.fmtHM(t));
    var dateTxt = (d.getMonth() + 1) + '月' + d.getDate() + '日', weekTxt = '周' + WEEK[d.getDay()];
    if (clockDate.getAttribute('data-v') !== dateTxt + weekTxt) {
      clockDate.setAttribute('data-v', dateTxt + weekTxt);
      clockDate.innerHTML = dateTxt + '<br>' + weekTxt;
    }
    renderBanner(t);
    renderMarkers();
    renderSheet();
    renderChip();
    renderMe();
    renderDbg();
  }

  function renderBanner(t) {
    var out = active.outOfRange;
    if (out) {
      var early = SCHED.validFrom && L.ymd(t) < SCHED.validFrom;
      setText(bannerEl, (early ? '时间表从 ' + md(SCHED.validFrom) + ' 起才生效' : '已超出有效期：时间表只覆盖 ' + validSpan()) +
        '，今天按默认规则显示，以现场为准。点这里导入新海报');
    }
    if (bannerEl.hidden === out) {
      bannerEl.hidden = !out;
      updateInsets();
      mapPZ.reclamp(false);
    }
  }

  function md(ymd) {
    var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? (+m[1]) + '/' + (+m[2]) : '';
  }

  /** 「11/24–11/30」：连接号两侧夹 U+2060（不断行），这串也走 setText，用不了 nowrap 的 span。 */
  function validSpan() {
    return md(SCHED.validFrom) + '\u2060–\u2060' + md(SCHED.validTo);
  }

  // ── 海报 ─────────────────────────────────

  var posterPZ = null, posterImg = $('posterImg'), posterMsg = $('posterMsg'), posterSrc = '', posterFocus = null;

  /**
   * 生效那一期的原图：导入的用原生给的 posterUrl，内置的用打包的那张。
   * ⚠️ 导入的那期没有 posterUrl 时别回落到打包的那张：那是 11/24 的老海报，拿它「对照」只会误导。
   */
  function activePosterSrc() {
    return active.entry ? active.entry.posterUrl || '' : 'img/schedule.jpg';
  }

  /**
   * 看海报原图。focus = { box:[x0,y0,x1,y1], ocrW }：预览页「对照原图」时直接放大到那个节目那几行。
   * box 是 OCR 坐标，原生若是在缩小图上跑的 OCR，要按 naturalWidth / ocrW 放回原图尺度。
   */
  function openPoster(src, focus) {
    src = src === undefined ? activePosterSrc() : src;
    posterEl.hidden = false;
    if (!posterPZ) {
      posterPZ = new PanZoom($('posterStage'), $('posterWorld'), { width: 1080, height: 1920, maxScale: 3 });
      posterImg.addEventListener('load', function () {
        posterMsg.hidden = true;
        posterPZ.setContentSize(posterImg.naturalWidth, posterImg.naturalHeight);
        applyPosterView();
      });
      posterImg.addEventListener('error', function () {
        console.warn('[LZM] 海报原图加载失败，只显示提示 src=' + posterSrc);
        setText(posterMsg, '原图打不开了（可能已被手机清理），时刻表不受影响');
        posterMsg.hidden = false;
      });
    }
    posterFocus = focus || null;
    if (!src) {
      posterSrc = '';
      posterImg.removeAttribute('src');
      $('posterMark').hidden = true;
      setText(posterMsg, '这一期导入时没有存下原图，时刻表不受影响');
      posterMsg.hidden = false;
      return;
    }
    if (posterSrc !== src) { posterSrc = src; posterMsg.hidden = true; posterImg.src = src; }
    else applyPosterView();
  }

  function applyPosterView() {
    var f = posterFocus, b = f && f.box, mark = $('posterMark');
    mark.hidden = true;
    if (!b || !posterImg.naturalWidth) { posterPZ.fit(false); return; }
    posterPZ.computeMin();
    var k = f.ocrW > 0 ? posterImg.naturalWidth / f.ocrW : 1, pad = 30 * k;
    // 一个节目那几行横跨整张表，竖屏上框住整行只比整图适配大一点点：所以再描个框，一眼看出该对哪几行。
    // 按百分比定位，跟着画布宽高一起缩放，不用每帧重算。
    var nw = posterImg.naturalWidth, nh = posterImg.naturalHeight, m = 6 * k;
    mark.style.left = ((b[0] * k - m) / nw * 100) + '%';
    mark.style.top = ((b[1] * k - m) / nh * 100) + '%';
    mark.style.width = ((b[2] - b[0]) * k + 2 * m) / nw * 100 + '%';
    mark.style.height = ((b[3] - b[1]) * k + 2 * m) / nh * 100 + '%';
    mark.hidden = false;
    var x0 = b[0] * k - pad, y0 = b[1] * k - pad, x1 = b[2] * k + pad, y1 = b[3] * k + pad;
    var st = $('posterStage'), s = Math.min(st.clientWidth / (x1 - x0), st.clientHeight / (y1 - y0));
    posterPZ.centerOn((x0 + x1) / 2, (y0 + y1) / 2, Math.max(posterPZ.minScale, Math.min(posterPZ.maxScale, s)), false);
  }

  function closePoster() { posterEl.hidden = true; }

  // ── 设置与校准 ─────────────────────────────────

  function openSettings() { renderSettings(); settingsEl.hidden = false; }
  function closeSettings() { settingsEl.hidden = true; resetClear(); schedDelArmed = null; }

  function renderSettings() {
    renderSchedList();
    var ocr = ocrState();
    $('impCam').disabled = $('impGal').disabled = ocr !== 'ok';
    setText($('impNote'), ocr === 'browser' ? '浏览器版不支持识别海报，请用 App'
      : ocr === 'off' ? '这台手机暂时用不了海报识别'
      : '拍下景区新一期的「演艺时间安排」海报，或从相册选一张截图；识别后先预览、确认了才会换上。');
    $('impNote').classList.toggle('muted-note', ocr !== 'ok');
    var n = state.calib.length, last = state.calib[n - 1];
    setText($('calibCount'), n
      ? '已有 ' + n + ' 个校准点（最近一次 ' + fmtMDHM(last.time) + (last.acc ? '，当时精度 ±' + Math.round(last.acc) + ' m' : '') + '）'
      : '还没有校准点');
    $('calibUndo').disabled = !n;
    $('calibClear').disabled = !n;
    var baseN = state.points.filter(function (p) { return p.kind === 'base'; }).length;
    var geo = state.model
      ? '导览图定位：对准了 ' + baseN + ' 处参照点' + (n ? '，加上你校准的 ' + n + ' 处' : '')
      : '导览图定位：暂时没法和手机定位对上（至少要两处相距 30 m 以上的参照点），只显示演出时间';
    // GEO.source 里是影像型号、拟合残差这类技术细节，只在 ?debug=1 时给开发者看。
    $('dataInfo').innerHTML = sourceHtml() + '<br>' + esc(geo) +
      (DEBUG && GEO.source ? '<br><small>' + esc(GEO.source) + '</small>' : '');
  }

  /** 页脚和设置页共用：数据来源 + 温馨提示 + 电话。 */
  function sourceHtml() {
    var phone = String(SCHED.phone || '');
    var phoneTxt = /^400\d{7}$/.test(phone) ? phone.slice(0, 3) + '-' + phone.slice(3, 6) + '-' + phone.slice(6) : phone;
    var out = [];
    if (SCHED.version) out.push('数据来源：景区演艺海报（' + esc(SCHED.version) + '，覆盖 ' + validSpan() + '）');
    if (SCHED.notice) out.push('温馨提示：' + esc(SCHED.notice));
    if (phone) out.push('咨询电话：<span class="phone">' + esc(phoneTxt) + '</span>');
    return out.join('<br>');
  }

  var clearArmedAt = 0, clearTimer = 0;
  function onClearClick() {
    if (!state.calib.length) return;
    if (Date.now() - clearArmedAt > 3000) {
      clearArmedAt = Date.now();
      $('calibClear').textContent = '再点一次确认清除';
      clearTimeout(clearTimer);
      clearTimer = setTimeout(resetClear, 3000);
      return;
    }
    resetClear();
    state.calib = [];
    saveCalib();
    rebuildModel();
    renderSettings();
    throttledSheetRender();
    toast('已清除全部校准点');
  }
  function resetClear() {
    clearArmedAt = 0;
    clearTimeout(clearTimer);
    $('calibClear').textContent = '全部清除';
  }

  function onUndoClick() {
    if (!state.calib.length) return;
    state.calib.pop();
    saveCalib();
    rebuildModel();
    renderSettings();
    throttledSheetRender();
    toast('已撤销上一个校准点，还剩 ' + state.calib.length + ' 个');
  }

  var poiEls = [];
  function enterCalib() {
    closeSettings();
    askIosCompass();
    setFollow(false);
    state.calibMode = true;
    state.calibWarned = false;
    document.body.classList.add('calib');
    calibBar.hidden = false;
    calibWarn.hidden = true;
    calibOk.textContent = '确定';
    renderCalibGps();
    placeCrosshair();
    crosshairEl.hidden = false;
    if (POIS.length) {
      poiLayer.innerHTML = POIS.map(function (p) { return '<div class="poi"><i></i><span>' + esc(p.name || '') + '</span></div>'; }).join('');
      poiEls = Array.prototype.slice.call(poiLayer.children);
      poiLayer.hidden = false;
    }
    updateInsets();
    // 先把图挪到「系统认为你在的地方」附近，用户只需微调；没定位就停在原处放大一点。
    var me = state.me;
    if (me && me.inside) mapPZ.centerOn(me.px, me.py, Math.max(mapPZ.s, 1), true);
    else {
      var c = mapPZ.toContent(state.cross.x, state.cross.y);
      mapPZ.centerOn(c.x, c.y, Math.max(mapPZ.s, 0.8), true);
    }
    positionOverlay();
    renderAlert();
  }

  function exitCalib() {
    state.calibMode = false;
    document.body.classList.remove('calib');
    calibBar.hidden = true;
    crosshairEl.hidden = true;
    poiLayer.hidden = true;
    poiLayer.innerHTML = '';
    poiEls = [];
    calibPois.innerHTML = '';
    updateInsets();
    setSheet(state.sheet);
    renderAlert();
  }

  /** 准星钉在「顶栏下沿到校准条上沿」的正中，进校准时算一次；之后条高变了也不挪，免得已对准的又错开。 */
  function placeCrosshair() {
    var top = (bannerEl.hidden ? topbarEl : bannerEl).getBoundingClientRect().bottom;
    var bottom = window.innerHeight - calibBar.offsetHeight;
    state.cross = { x: Math.round(window.innerWidth / 2), y: Math.round((top + bottom) / 2) };
    crosshairEl.style.transform = 'translate(' + state.cross.x + 'px,' + state.cross.y + 'px)';
  }

  function renderCalibGps() {
    var f = state.fix, act = '', ok = false, txt;
    if (state.locStatus === 'denied') { txt = '没给定位权限 · 点这里去开'; act = 'perm'; }
    else if (state.locStatus === 'disabled') { txt = '手机定位没开 · 点这里去打开'; act = 'settings'; }
    else if (!f || Date.now() - f.receivedAt > FIX_STALE_MS) { txt = '定位中…（到室外开阔处会快一些）'; }
    else {
      ok = true;
      txt = '已定位 ±' + Math.round(f.acc) + ' m' + (f.acc > CALIB_WARN_ACC_M ? '，偏差较大' : '');
    }
    setText(calibGps, txt);
    calibGps.setAttribute('data-act', act);
    calibOk.disabled = !ok;
  }

  var poiTimer = 0;
  function schedulePoiChips() {
    if (!POIS.length || poiTimer) return;
    poiTimer = setTimeout(function () { poiTimer = 0; renderPoiChips(); }, 250);
  }

  function renderPoiChips() {
    if (!state.calibMode || !POIS.length) return;
    var c = mapPZ.toContent(state.cross.x, state.cross.y);
    var near = POIS.map(function (p, i) { return { i: i, d: Math.hypot(p.px - c.x, p.py - c.y) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, 6);
    calibPois.innerHTML = near.map(function (n) {
      var p = POIS[n.i];
      var dist = state.model ? '约 ' + L.fmtDistance(n.d / state.model.pxPerM) : '';
      return '<button type="button" data-poi="' + n.i + '">' + esc(p.name || '参照点') + (dist ? '<small>' + dist + '</small>' : '') + '</button>';
    }).join('');
  }

  function onCalibOk() {
    var f = state.fix;
    if (!f) return;
    if (f.acc > CALIB_WARN_ACC_M && !state.calibWarned) {
      state.calibWarned = true;
      calibWarn.textContent = '当前定位偏差 ±' + Math.round(f.acc) + ' m，超过 30 m，记下来可能反而更偏。' +
        '可以稍等精度变好再点；确定要记，就点「仍然记录」。';
      calibWarn.hidden = false;
      calibOk.textContent = '仍然记录';
      return;
    }
    var c = mapPZ.toContent(state.cross.x, state.cross.y);
    if (c.x < 0 || c.y < 0 || c.x > MAP_W || c.y > MAP_H) { toast('准星要对在导览图上'); return; }
    state.calib.push({
      px: Math.round(c.x * 10) / 10, py: Math.round(c.y * 10) / 10,
      lat: f.lat, lon: f.lon, acc: Math.round(f.acc * 10) / 10, time: Date.now(),
    });
    var saved = saveCalib();
    rebuildModel();
    exitCalib();
    throttledSheetRender();
    var n = state.calib.length;
    toast(!saved ? '校准点已生效，但没能存下来，关掉后会丢'
      : state.model ? '已记下校准点，共 ' + n + ' 个'
      : '已记下校准点（' + n + ' 个）。再到另一处相距 30 m 以上的地方校准一次，就能显示位置了');
  }

  // ── 设置里的「时刻表」列表 ─────────────────────────────────

  var schedDelArmed = null;

  function renderSchedList() {
    var today = L.ymd(now());
    var rows = [{ id: 'builtin', entry: null, s: BUILTIN }].concat(imported.map(function (e) { return { id: e.id, entry: e, s: e.schedule }; }));
    // 新的在上：按开始日倒排，同一期按导入时间倒排（内置算最早）
    rows.sort(function (a, b) {
      return (b.s.validFrom || '').localeCompare(a.s.validFrom || '') ||
        (b.entry ? b.entry.importedAt : -1) - (a.entry ? a.entry.importedAt : -1);
    });
    $('schedList').innerHTML = rows.map(function (r) {
      var cur = r.id === active.key, past = r.s.validTo && r.s.validTo < today;
      var src = r.entry ? '导入于 ' + fmtMDHM(r.entry.importedAt) : '内置';
      var h = '<div class="sl-row' + (cur ? ' cur' : '') + '" data-sid="' + esc(r.id) + '">' +
        '<div class="sl-main"><div class="sl-top"><b class="nw">' + spanPad(r.s) + '</b>' +
        (cur ? '<span class="pill open">' + (active.outOfRange ? '在用（已超期）' : '当前生效') + '</span>' : past ? '<span class="pill ended">已过期</span>' : '') +
        '</div><small>' + esc(src) + (r.s.version ? ' · ' + esc(r.s.version) : '') + ' · ' + (r.s.shows || []).length + ' 个节目</small></div>';
      if (r.entry) {
        h += schedDelArmed === r.id
          ? '<div class="sl-confirm"><span>删掉这一期？原图也一起删</span><button class="btn danger sm" type="button" data-sl="del-yes">删除</button><button class="btn sm" type="button" data-sl="del-no">取消</button></div>'
          : '<button class="btn sm sl-del" type="button" data-sl="del" aria-label="删除这一期">删除</button>';
      }
      return h + '</div>';
    }).join('');
  }

  function onSchedListClick(e) {
    var b = e.target.closest('[data-sl]');
    if (!b) return;
    var id = b.closest('[data-sid]').getAttribute('data-sid'), act = b.getAttribute('data-sl');
    if (act === 'del') schedDelArmed = id;
    else if (act === 'del-no') schedDelArmed = null;
    else if (act === 'del-yes') {
      schedDelArmed = null;
      var entry = imported.filter(function (x) { return x.id === id; })[0];
      if (!entry) return;
      imported = imported.filter(function (x) { return x !== entry; });
      var saved = saveImported();
      deletePoster(entry.posterId);
      active.key = null;
      refresh();
      toast('已删除 ' + spanPad(entry.schedule) + (saved ? '' : '\n但没能存下来，重新打开后它还会在'));
    }
    renderSettings();
  }

  /** 「12/01–12/07」：月日都补零，列表里几期上下对齐。 */
  function spanPad(s) {
    var f = function (ymd) { var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? m[1] + '/' + m[2] : '?'; };
    return f(s.validFrom) + '–' + f(s.validTo);
  }

  // ── 导入新海报 ─────────────────────────────────
  //
  // idle ──pickPoster──> (原生界面) ──progress──> busy ──result ok──> preview ──确认──> idle（已存、已生效）
  //                                       │              └──result 失败──> error
  //                                       └──cancelled──> idle（静默）
  // 中途按返回 / 取消：pending 清掉；之后结果再来就当没要，原生存下的原图顺手删掉。

  var impEl = $('imp'), impBody = $('impBody'), impFoot = $('impFoot'), impBar = $('impBar'), impOk = $('impOk');
  var imp = { state: 'idle', pending: false, stage: '', res: null, draft: null, out: null, edit: {}, dirty: false, ask: null, err: null };

  /** 'ok' / 'browser'（没有原生壳）/ 'off'（原生说这台机器跑不了 OCR）。 */
  function ocrState() {
    if (!BRIDGE || typeof BRIDGE.pickPoster !== 'function') return 'browser';
    if (!PP) return 'off';
    try { if (typeof BRIDGE.ocrAvailable === 'function' && !BRIDGE.ocrAvailable()) return 'off'; }
    catch (e) { console.warn('[LZM] ocrAvailable() 调用失败，按不可用处理', e); return 'off'; }
    return 'ok';
  }

  function startImport(source) {
    var st = ocrState();
    if (st !== 'ok') { toast(st === 'browser' ? '浏览器版不支持识别海报，请用 App' : '这台手机暂时用不了海报识别'); return; }
    imp.pending = true;
    try { BRIDGE.pickPoster(source); }
    catch (e) {
      imp.pending = false;
      console.warn('[LZM] pickPoster 调用失败 source=' + source, e);
      showImpError('ocr_failed', String(e && e.message || e));
    }
  }

  function onPosterProgress(stage) {
    if (!imp.pending) { console.warn('[LZM] 没在导入却收到识别进度，忽略 stage=' + stage); return; }
    imp.state = 'busy';
    imp.stage = stage;
    openImp();
  }

  function onPosterResult(json) {
    var res = null;
    try { res = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (e) { console.warn('[LZM] 识别结果不是合法 JSON，按识别失败处理 len=' + String(json).length, e); }
    var wanted = imp.pending;
    imp.pending = false;
    if (!wanted) {
      if (res && res.ok && res.posterId) deletePoster(res.posterId);
      return;
    }
    if (!res) { showImpError('ocr_failed', 'bad json'); return; }
    if (!res.ok) {
      if (res.error === 'cancelled') { closeImp(); return; }
      console.warn('[LZM] 海报识别失败 error=' + res.error + ' message=' + res.message);
      showImpError(res.error, res.message);
      return;
    }
    var r = null;
    try { r = PP.parsePoster(res, { today: L.ymd(now()), knownShows: SHOWS, venues: VENUES }); }
    catch (e) { console.warn('[LZM] 海报解析出错，按「没找到时刻表」处理 lines=' + (res.lines || []).length, e); }
    if (!r || !r.schedule.shows.length) {
      deletePoster(res.posterId);
      showImpError('parse_failed', '');
      return;
    }
    imp.res = res;
    imp.draft = r.draft;
    imp.out = { schedule: r.schedule, issues: r.issues, views: r.views };
    imp.edit = {}; imp.dirty = false; imp.ask = null;
    imp.state = 'preview';
    openImp();
    impBody.scrollTop = 0;
  }

  var IMP_ERR = {
    decode_failed: ['这张图片打不开', '可能是格式不支持，或者文件没下载完整。'],
    ocr_failed: ['没能识别出文字', '图片可能太暗、太糊，或者拍得太小。'],
    parse_failed: ['没在图里找到演出时刻表', '要拍的是「演艺时间安排」那张海报，表头「演出名称 / 日期 / 备注」要拍进去。'],
  };

  function showImpError(code, message) {
    imp.state = 'error';
    imp.err = { code: IMP_ERR[code] ? code : 'ocr_failed', message: message || '' };
    openImp();
  }

  function openImp() { impEl.hidden = false; renderImp(); }

  function closeImp() {
    impEl.hidden = true;
    imp.state = 'idle'; imp.res = imp.draft = imp.out = imp.err = imp.ask = null; imp.edit = {}; imp.dirty = false;
  }

  /** 返回键 / 左上角「‹」：确认条 → 识别中（取消）→ 出错页 → 预览（改过就先问一句）。 */
  function impBack() {
    if (imp.ask) { imp.ask = null; renderFoot(); return; }
    if (imp.state === 'busy') { imp.pending = false; closeImp(); toast('已取消识别'); return; }
    if (imp.state === 'preview' && imp.dirty) { imp.ask = 'discard'; renderFoot(); return; }
    if (imp.state === 'preview') { discardImport(); return; }
    closeImp();
  }

  function discardImport() {
    if (imp.res) deletePoster(imp.res.posterId);
    closeImp();
  }

  function confirmImport(force) {
    var o = imp.out, s = o.schedule;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.validFrom || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.validTo || '') || s.validTo < s.validFrom) {
      toast('有效期不对，先在最上面改好再导入');
      impBody.scrollTop = 0;
      return;
    }
    var warnN = o.issues.filter(isWarn).length;
    if (warnN && !force) { imp.ask = 'warn'; renderFoot(); return; }
    var entry = {
      id: 'imp-' + Date.now().toString(36), importedAt: Date.now(),
      posterId: imp.res.posterId || null, posterUrl: imp.res.posterUrl || '', schedule: s,
    };
    imported.push(entry);
    var saved = saveImported();
    closeImp();
    closeSettings();
    active.key = null;
    refresh();
    var msg = '已导入 ' + spanPad(s);
    if (active.key !== entry.id) msg += '\n' + md(s.validFrom) + ' 起自动换上';
    toast(saved ? msg : msg + '\n但没能存下来，关掉后会丢');
  }

  function isWarn(x) { return x.level === 'warn'; }

  function rebuildImp() {
    var r = PP.rebuild(imp.draft, { today: L.ymd(now()), knownShows: SHOWS, venues: VENUES });
    imp.out = { schedule: r.schedule, issues: r.issues, views: r.views };
  }

  // ── 导入：渲染 ─────────────────────────────────

  var STAGES = [['decoding', '读取图片'], ['detecting', '找出文字在哪儿'], ['recognizing', '逐行认字']];

  function renderImp() {
    var st = imp.state;
    setText($('impTitle'), st === 'preview' ? '核对时刻表' : '导入新海报');
    $('impLook').hidden = !(st === 'preview' && imp.res && imp.res.posterUrl);
    impFoot.hidden = st !== 'preview';
    if (st === 'busy') {
      var at = -1;
      STAGES.forEach(function (s, i) { if (s[0] === imp.stage) at = i; });
      if (at < 0) console.warn('[LZM] 未知识别阶段，按第一步显示 stage=' + imp.stage);
      impBody.innerHTML = '<div class="imp-busy"><div class="spinner" aria-hidden="true"></div><h3>正在识别海报</h3>' +
        '<ol class="imp-steps">' + STAGES.map(function (s, i) {
          var cls = i < at ? 'done' : i === Math.max(0, at) ? 'cur' : '';
          return '<li class="' + cls + '">' + s[1] + '</li>';
        }).join('') + '</ol><p class="imp-tip">全在手机上算，不联网，一般几秒钟</p>' +
        '<button class="btn" type="button" data-imp="cancel">取消</button></div>';
    } else if (st === 'error') {
      var e = IMP_ERR[imp.err.code];
      impBody.innerHTML = '<div class="imp-err"><i class="imp-err-ic" aria-hidden="true">!</i><h3>' + esc(e[0]) + '</h3>' +
        '<p>' + esc(e[1]) + '</p><p class="imp-advice">尽量用原图或截图，别斜着拍；拍照时让整张海报占满画面、正对着拍。</p>' +
        (DEBUG && imp.err.message ? '<p class="imp-tech">' + esc(imp.err.message) + '</p>' : '') +
        '<div class="set-actions center"><button class="btn primary" type="button" data-imp="camera">重拍</button>' +
        '<button class="btn" type="button" data-imp="gallery">从相册选</button></div>' +
        '<button class="link-btn" type="button" data-imp="close">返回</button></div>';
    } else if (st === 'preview') {
      renderPreview();
    }
    renderFoot();
  }

  function renderFoot() {
    if (imp.state !== 'preview') return;
    var a = imp.ask;
    impBar.hidden = !a;
    if (a === 'discard') {
      impBar.innerHTML = '<span>改过的内容还没导入，放弃吗？</span><button class="btn danger sm" type="button" data-imp="discard-yes">放弃</button>' +
        '<button class="btn sm" type="button" data-imp="ask-no">继续改</button>';
    } else if (a === 'warn') {
      var n = imp.out.issues.filter(isWarn).length;
      impBar.innerHTML = '<span>还有 ' + n + ' 处标黄没确认，仍然导入？</span><button class="btn primary sm" type="button" data-imp="ok-force">仍然导入</button>' +
        '<button class="btn sm" type="button" data-imp="ask-no">再看看</button>';
    }
  }

  function renderPreview() {
    var keep = impBody.scrollTop;
    var shows = imp.out.schedule.shows, d = imp.draft.meta;
    impBody.innerHTML =
      '<section class="pv-sec"><h3>有效期与版本</h3>' +
        '<div class="pv-row2"><label>从<input type="date" data-meta="validFrom" value="' + esc(d.validFrom || '') + '"></label>' +
        '<label>到<input type="date" data-meta="validTo" value="' + esc(d.validTo || '') + '"></label></div>' +
        '<label>版本<input type="text" data-meta="version" value="' + esc(d.version || '') + '" placeholder="例：12月1日版本"></label></section>' +
      '<section id="pvSum" class="pv-sum"></section>' +
      '<section id="pvDiff" class="pv-sec"></section>' +
      shows.map(function (s, si) { return '<article class="pv-card" id="pv' + si + '" data-si="' + si + '">' + cardHtml(si) + '</article>'; }).join('');
    renderSummary();
    fitTextareas(impBody);
    impBody.scrollTop = keep;
  }

  function renderSummary() {
    var o = imp.out, warnN = o.issues.filter(isWarn).length;
    var sum = $('pvSum');
    sum.className = 'pv-sum ' + (warnN ? 'has-warn' : 'ok');
    var glob = o.issues.filter(function (x) { return x.show == null; });
    sum.innerHTML = '<b>识别出 ' + o.schedule.shows.length + ' 个节目，' + (warnN ? warnN + ' 处需要确认' : '没有需要确认的地方') + '</b>' +
      '<span>' + (warnN ? '标黄的地方请对照原图看一眼，点「改」可以直接改。' : '还是建议对照原图扫一眼再导入。') + '</span>' +
      (glob.length ? '<ul class="pv-issues">' + glob.map(function (x) { return issueLi(x, 0); }).join('') + '</ul>' : '');
    $('pvDiff').innerHTML = diffHtml();
    markWarnCards();
  }

  /** 节目卡片的标黄状态跟着 issues 走：别的节目一改，「本期没有」之类的整期提醒也会变。 */
  function markWarnCards() {
    imp.out.schedule.shows.forEach(function (s, si) {
      var el = $('pv' + si);
      if (el) el.classList.toggle('warn', imp.out.issues.some(function (x) { return x.show === si && isWarn(x); }));
    });
  }

  function diffHtml() {
    var df = PP.diffSchedules(SCHED, imp.out.schedule);
    var h = '<h3>和当前时刻表（' + spanPad(SCHED) + '）比</h3>';
    if (!df.added.length && !df.removed.length && !df.changed.length) return h + '<p class="pv-same">节目和场次时间都一样</p>';
    var name = function (s) { return noHtml(s) + titleHtml(s); };
    if (df.added.length) {
      h += '<div class="pv-diff add"><h4>新增 ' + df.added.length + '</h4>' + df.added.map(function (x) {
        return '<button class="pv-jump" type="button" data-jump="' + x.index + '">' + name(x.show) + '</button>';
      }).join('') + '</div>';
    }
    if (df.removed.length) {
      h += '<div class="pv-diff del"><h4>本期没有 ' + df.removed.length + '</h4>' + df.removed.map(function (x) {
        return '<span class="pv-jump">' + name(x.show) + '</span>';
      }).join('') + '</div>';
    }
    if (df.changed.length) {
      h += '<div class="pv-diff chg"><h4>时间有变化 ' + df.changed.length + '</h4>' + df.changed.map(function (x) {
        // 时段之间留普通空格：全是 nowrap 的 span 首尾相接就没有断行点，360 宽下整串冲出屏幕
        return '<button class="pv-jump" type="button" data-jump="' + x.index + '">' + name(x.show) + '<small>' +
          x.plus.map(function (r) { return '<span class="nw plus">+' + r + '</span>'; }).concat(
            x.minus.map(function (r) { return '<span class="nw minus">−' + r + '</span>'; })).join(' ') + '</small></button>';
      }).join('') + '</div>';
    }
    return h;
  }

  function issueLi(x, nSubs) {
    var pre = x.sub != null && nSubs > 1 ? '第 ' + (x.sub + 1) + ' 行：' : '';
    return '<li class="' + (isWarn(x) ? 'warn' : 'info') + '">' + esc(pre + x.msg) + '</li>';
  }

  function warnSubsOf(si) {
    var w = {};
    imp.out.issues.forEach(function (x) { if (x.show === si && isWarn(x) && x.sub != null) w[x.sub] = true; });
    return w;
  }

  function cardHtml(si) {
    return '<div class="pv-view">' + cardViewHtml(si) + '</div>' + (imp.edit[si] ? editHtml(si) : '') +
      '<div class="pv-acts"><button class="btn sm" type="button" data-pv="edit">' + (imp.edit[si] ? '改好了' : '改') + '</button>' +
      (imp.res.posterUrl && imp.draft.shows[si].box ? '<button class="btn sm" type="button" data-pv="look">对照原图</button>' : '') + '</div>';
  }

  function cardViewHtml(si) {
    var o = imp.out, show = o.schedule.shows[si], ds = imp.draft.shows[si];
    var iss = o.issues.filter(function (x) { return x.show === si; }).sort(function (a, b) { return isWarn(b) - isWarn(a); });
    var v = show.venueId ? venueById[show.venueId] : null;
    var where = v ? esc(v.name) : show.area === 'other' ? '园区其他区域' : ds.street ? '演艺城街区' :
      !ds.known && !ds.venueChosen ? '<b class="pv-need">还没选剧场</b>' : '不在地图上';
    var h = '<div class="pv-head"><div class="pv-title">' + noHtml(show) + titleHtml(show) + '</div>' +
      (!ds.known ? '<span class="pv-new">新节目</span>' : '') + '</div>' +
      '<div class="pv-meta"><span>' + where + '</span>' + tagsHtml(show.tags) + '</div>';
    if (!ds.known && show.area !== 'other' && !ds.street) h += venueSelectHtml(ds);
    h += '<div class="pv-days">' + daysHtml(si) + '</div>';
    if (iss.length) h += '<ul class="pv-issues">' + iss.map(function (x) { return issueLi(x, ds.subs.length); }).join('') + '</ul>';
    return h;
  }

  function venueSelectHtml(ds) {
    var cur = ds.venueChosen ? '__none' : ds.venueId || '';
    return '<label class="pv-venue">在哪个剧场<select data-venue>' +
      '<option value=""' + (cur ? '' : ' selected') + ' disabled>请选择…</option>' +
      VENUES.map(function (x) { return '<option value="' + esc(x.id) + '"' + (cur === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') +
      '<option value="__none"' + (cur === '__none' ? ' selected' : '') + '>不在地图上</option></select></label>';
  }

  /** 场次完全相同的日子并成一行：「11/26–28（四–六） 6 场 …」。这一行出自标黄的子行就整行标黄。 */
  function daysHtml(si) {
    var o = imp.out, s = o.schedule, show = s.shows[si];
    var groups = PP.dayGroups(show, s.validFrom, s.validTo, o.views[si].ruleSub);
    if (!groups.length) return '<p class="pv-empty">有效期不对，没法按天列出场次</p>';
    var w = warnSubsOf(si);
    return groups.map(function (g) {
      var warn = g.subs.some(function (k) { return w[k]; });
      var body = g.closed ? '不演' : (show.continuous ? '开放 ' : g.sessions.length + ' 场 ') + g.sessions.map(function (x) {
        return '<span class="nw">' + x.startHM + '–' + x.endHM + '</span>' + (x.note ? ' <em>' + esc(x.note) + '</em>' : '');
      }).join(' ');
      return '<div class="pv-day' + (warn ? ' warn' : '') + (g.closed ? ' closed' : '') + '"><span class="pv-d">' + daysLabel(g.days) + '</span>' +
        '<span class="pv-s">' + body + '</span></div>';
    }).join('');
  }

  /** 连着的日子写成区间：「11/24（二）、11/26–28（四–六）」。 */
  function daysLabel(days) {
    var runs = [];
    days.forEach(function (d) {
      var r = runs[runs.length - 1];
      if (r && L.addDays(r[r.length - 1], 1) === d) r.push(d); else runs.push([d]);
    });
    return runs.map(function (r) {
      var a = r[0], b = r[r.length - 1];
      if (r.length === 1) return '<span class="nw">' + md(a) + '（' + WEEK[L.weekday(a)] + '）</span>';
      var bTxt = b.slice(0, 7) === a.slice(0, 7) ? String(+b.slice(8)) : md(b);
      return '<span class="nw">' + md(a) + '–' + bTxt + '（' + WEEK[L.weekday(a)] + '–' + WEEK[L.weekday(b)] + '）</span>';
    }).join('、');
  }

  function editHtml(si) {
    var ds = imp.draft.shows[si], w = warnSubsOf(si), n = ds.subs.length;
    return '<div class="pv-edit">' + ds.subs.map(function (sub, k) {
      return '<div class="pv-sub' + (w[k] ? ' warn' : '') + '" data-k="' + k + '">' +
        '<div class="pv-sub-h"><b>' + (n > 1 ? '第 ' + (k + 1) + ' 行' : '这一行') + '</b>' +
        (n > 1 ? '<button class="link-btn sm" type="button" data-pv="delrow">删掉这行</button>' : '') + '</div>' +
        '<label>适用日期<input type="text" data-f="dateText" value="' + esc(sub.dateText || '') + '" placeholder="不填就是每天"></label>' +
        '<label>场次<textarea data-f="timeText" rows="2" placeholder="14:00-15:25 / 19:00-20:25">' + esc(sub.timeText || '') + '</textarea></label></div>';
    }).join('') +
      '<p class="pv-help">时间之间用「/」隔开，场次备注写在括号里；日期写「11月26日至28日」「11月24日公休」「周五/周六」，不填就是每天。</p>' +
      '<button class="btn sm" type="button" data-pv="addrow">＋ 加一行</button></div>';
  }

  /** 改完重算后只换卡片的展示部分，输入框原地不动（整块重绘会把正在打字的框换掉、键盘收起）。 */
  function refreshCard(si) {
    var el = $('pv' + si);
    if (!el) return;
    el.querySelector('.pv-view').innerHTML = cardViewHtml(si);
    var w = warnSubsOf(si);
    Array.prototype.forEach.call(el.querySelectorAll('.pv-sub'), function (sub) {
      sub.classList.toggle('warn', !!w[+sub.getAttribute('data-k')]);
    });
    renderSummary();
  }

  function redrawCard(si) {
    var el = $('pv' + si);
    if (el) { el.innerHTML = cardHtml(si); fitTextareas(el); }
    renderSummary();
  }

  /** 场次框按内容长高：六场的时间串要三行，固定两行会把最后一场藏在框里，看着像少了一场。 */
  function fitTa(ta) { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; }
  function fitTextareas(root) { Array.prototype.forEach.call(root.querySelectorAll('textarea'), fitTa); }

  var editTimer = 0, editSi = -1;
  function onImpInput(e) {
    var el = e.target, card = el.closest('[data-si]');
    if (!card || !el.hasAttribute('data-f')) return;
    var si = +card.getAttribute('data-si'), k = +el.closest('[data-k]').getAttribute('data-k');
    var sub = imp.draft.shows[si].subs[k];
    sub[el.getAttribute('data-f')] = el.value;
    sub.edited = true;
    imp.dirty = true;
    if (el.tagName === 'TEXTAREA') fitTa(el);
    // 打字时 300 ms 没动再重算：每个字都重算，铁花秀那种多行节目在低端机上会卡键盘
    clearTimeout(editTimer);
    editSi = si;
    editTimer = setTimeout(function () { editTimer = 0; rebuildImp(); refreshCard(editSi); }, 300);
  }

  function onImpChange(e) {
    var el = e.target;
    if (el.hasAttribute('data-meta')) {
      imp.draft.meta[el.getAttribute('data-meta')] = el.value.trim();
      imp.dirty = true;
      rebuildImp();
      renderPreview();
    } else if (el.hasAttribute('data-venue')) {
      var si = +el.closest('[data-si]').getAttribute('data-si'), ds = imp.draft.shows[si];
      ds.venueId = el.value && el.value !== '__none' ? el.value : null;
      ds.venueChosen = el.value === '__none';
      imp.dirty = true;
      rebuildImp();
      refreshCard(si);
    }
  }

  function onImpClick(e) {
    var t = e.target, a = t.closest('[data-imp]');
    if (a) {
      var act = a.getAttribute('data-imp');
      if (act === 'cancel' || act === 'close') impBack();
      else if (act === 'camera' || act === 'gallery') { closeImp(); startImport(act); }
      else if (act === 'discard-yes') discardImport();
      else if (act === 'ask-no') { imp.ask = null; renderFoot(); }
      else if (act === 'ok-force') { imp.ask = null; confirmImport(true); }
      return;
    }
    var j = t.closest('[data-jump]');
    if (j) {
      var target = $('pv' + j.getAttribute('data-jump'));
      if (target) impBody.scrollTop += target.getBoundingClientRect().top - impBody.getBoundingClientRect().top - 8;
      return;
    }
    var b = t.closest('[data-pv]');
    if (!b) return;
    var si = +b.closest('[data-si]').getAttribute('data-si'), ds = imp.draft.shows[si], pv = b.getAttribute('data-pv');
    if (pv === 'look') { openPoster(imp.res.posterUrl, { box: ds.box, ocrW: +imp.res.width || 0 }); return; }
    if (pv === 'edit') { imp.edit[si] = !imp.edit[si]; }
    else if (pv === 'addrow') { ds.subs.push({ dateText: '', timeText: '', ocrIssues: [], edited: true }); imp.dirty = true; }
    else if (pv === 'delrow') { ds.subs.splice(+b.closest('[data-k]').getAttribute('data-k'), 1); ds.subs.forEach(function (x) { x.edited = true; }); imp.dirty = true; }
    if (editTimer) { clearTimeout(editTimer); editTimer = 0; }
    rebuildImp();
    redrawCard(si);
  }

  // ── 返回键 ─────────────────────────────────

  /** 一层一层退：须知 → 海报 → 导入（确认条 → 本层）→ 设置 → 校准 → 剧场详情 → 面板展开 → 交给原生退出。 */
  function handleBack() {
    if (!noticeEl.hidden) { closeNotice(); return true; }
    if (!posterEl.hidden) { closePoster(); return true; }
    if (!impEl.hidden) { impBack(); return true; }
    if (!settingsEl.hidden) { closeSettings(); return true; }
    if (state.calibMode) { exitCalib(); return true; }
    if (state.view.kind !== 'list') { showList(); return true; }
    if (state.sheet !== 'peek') { setSheet('peek'); return true; }
    return false;
  }

  function doAct(act) {
    if (act === 'poster') openPoster();
    else if (act === 'close-settings') closeSettings();
    else if (act === 'perm') requestPermission();
    else if (act === 'settings') openLocationSettings();
    else if (act === 'notice') openNotice();
  }

  // ── 使用须知 ─────────────────────────────────
  //
  // 首次打开弹一次，看过记 localStorage；存不了（隐私模式）就每次都弹，宁可多看一遍也别漏看。
  // 各条也在出事的地方就地提醒（见 currentAlert），这里只是汇总。

  function noticeItems() {
    var phone = String(SCHED.phone || '');
    var phoneTxt = /^400\d{7}$/.test(phone) ? phone.slice(0, 3) + '-' + phone.slice(3, 6) + '-' + phone.slice(6) : phone;
    // 第二项是 HTML（电话要包一层不折行）；其余动态片段都过 esc。
    return [
      ['地图是手绘的，不按比例', '手机定位换算到图上会有约 10\u2060–\u206020 米偏差，蓝点用来认个大方向。'],
      ['音乐广场一带偏差更大', '那一带没有对准用的参照点，位置是推算出来的。'],
      ['位置不对就校准一下', '「设置 → 位置校准」：站在认得出的地方（出入口、桥头），把准星对上，附近就准了。'],
      ['演出时间以现场为准', '按景区演艺海报（' + (SCHED.version || '') + '）录入，只覆盖 ' + validSpan() +
        '；遇天气或运营调整，以现场广播为准。'],
      ['步行时间仅供参考', '按直线距离估算，实际要绕路、排队，宁可早点出发。'],
    ].map(function (it, i) {
      var body = esc(it[1]);
      if (i === 3 && phone) body += '咨询电话 <span class="phone">' + esc(phoneTxt) + '</span>';
      return [it[0], body];
    });
  }

  function openNotice() {
    closeSettings();
    $('noticeList').innerHTML = noticeItems().map(function (it) {
      return '<li><b>' + esc(it[0]) + '</b><span>' + it[1] + '</span></li>';
    }).join('');
    noticeEl.hidden = false;
  }

  function closeNotice() {
    noticeEl.hidden = true;
    try { window.localStorage.setItem(NOTICE_KEY, '1'); }
    catch (e) { console.warn('[LZM] 须知已读标记没存下来，下次还会弹', e); }
  }

  function noticeSeen() {
    try { return window.localStorage.getItem(NOTICE_KEY) === '1'; }
    catch (e) { return false; }
  }

  // ── 调试 ─────────────────────────────────

  var debugEls = [], debugPts = [];
  function renderDebugPoints() {
    if (!DEBUG) return;
    debugPts = state.model ? state.model.points : state.points;
    debugLayer.innerHTML = debugPts.map(function (p) {
      return '<div class="cp ' + (p.kind === 'calib' ? 'calib' : 'base') + '"><i></i><span>' + esc(p.name) + '</span></div>';
    }).join('');
    debugEls = Array.prototype.slice.call(debugLayer.children);
    debugLayer.hidden = false;
    positionDots(debugEls, debugPts);
  }

  function renderDbg() {
    if (!DEBUG) return;
    dbgEl.hidden = false;
    var m = state.model, f = state.fix, me = state.me, lines = [];
    lines.push('配准 ' + (m ? m.kind + ' · ' + m.count + ' 点 · ' + m.pxPerM.toFixed(3) + ' px/m · 残差 RMS ' + m.rmsResidualM.toFixed(1) + ' m' : '无'));
    lines.push('定位 ' + state.locStatus + (f ? ' ' + f.lat.toFixed(6) + ',' + f.lon.toFixed(6) + ' ±' + Math.round(f.acc) + 'm ' + f.provider : ''));
    if (me) lines.push('图上 px ' + Math.round(me.px) + ' py ' + Math.round(me.py) + (me.inside ? '' : ' (图外 ' + Math.round(me.distToCenterM) + ' m)'));
    var hd = effectiveHeading();
    if (hd != null) lines.push('朝向 ' + hd.toFixed(0) + '°' + (me && m ? ' → 图上 ' + m.headingToImage(me.x, me.y, hd).toFixed(0) + '°' : ''));
    lines.push('缩放 ' + mapPZ.s.toFixed(3) + '（最小 ' + mapPZ.minScale.toFixed(3) + '）');
    dbgEl.textContent = lines.join('\n');
  }

  // ── 小工具 ─────────────────────────────────

  var toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600 + Math.min(3000, msg.length * 40));
  }

  function setText(el, t) { if (el.textContent !== t) el.textContent = t; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtMDHM(ms) {
    var d = new Date(ms);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + L.fmtHM(ms);
  }

  function hasPx(p) { return p && isFinite(p.px) && isFinite(p.py); }
  function noop() {}
  function zeroInsets() { return { top: 0, bottom: 0, left: 0, right: 0 }; }

  function parseQuery(search) {
    var out = {};
    String(search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      out[dec(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : dec(kv.slice(i + 1));
    });
    return out;
  }
  function dec(s) {
    s = s.replace(/\+/g, ' ');
    try { return decodeURIComponent(s); } catch (e) { return s; } // 手敲的 URL 里一个孤零零的 % 不该让整页起不来
  }

  function loadCalib() {
    var raw;
    try { raw = window.localStorage.getItem(CALIB_KEY); }
    catch (e) { console.warn('[LZM] 读不了 localStorage，按没有校准点处理', e); return []; }
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(function (c) { return c && isFinite(c.px) && isFinite(c.lat) && isFinite(c.lon); }) : [];
    } catch (e) {
      console.warn('[LZM] 校准点存档损坏，忽略 len=' + raw.length, e);
      return [];
    }
  }

  function saveCalib() {
    try { window.localStorage.setItem(CALIB_KEY, JSON.stringify(state.calib)); return true; }
    catch (e) { console.warn('[LZM] 校准点没存下来，本次打开内有效、关掉就丢', e); return false; }
  }

  // ── 启动 ─────────────────────────────────

  // 图没解码出来之前标记层先藏着：冷启动时一排徽标飘在空白上，像是坏了。
  // 先挂监听再设 src，免得缓存命中时 load 在监听之前就触发了。
  var mapShown = false;
  function showMap() {
    if (mapShown) return;
    mapShown = true;
    stageEl.classList.remove('loading');
  }
  mapImg.addEventListener('load', function () {
    if (mapImg.decode) mapImg.decode().then(showMap, showMap);
    else showMap();
  });
  mapImg.addEventListener('error', function () {
    console.warn('[LZM] 导览图加载失败 src=' + MAP_SRC + '，只显示标记和场次');
    showMap();
  });
  mapImg.src = MAP_SRC;
  applyEffective(now());

  locChip.addEventListener('click', onChipClick);
  $('alertClose').addEventListener('click', function () {
    var k = alertEl.getAttribute('data-kind');
    if (k) alertDismissed[k] = true;
    renderAlert();
  });
  alertAct.addEventListener('click', function () {
    if (alertEl.getAttribute('data-kind') === 'weak') enterCalib();
  });
  $('noticeOk').addEventListener('click', closeNotice);
  $('noticeReopen').addEventListener('click', openNotice);
  fabLocate.addEventListener('click', onLocateClick);
  $('fabPoster').addEventListener('click', function () { openPoster(); });
  $('fabSettings').addEventListener('click', openSettings);
  $('posterClose').addEventListener('click', closePoster);
  $('calibStart').addEventListener('click', enterCalib);
  $('calibUndo').addEventListener('click', onUndoClick);
  $('calibClear').addEventListener('click', onClearClick);
  $('calibCancel').addEventListener('click', exitCalib);
  calibOk.addEventListener('click', onCalibOk);
  calibGps.addEventListener('click', function () { doAct(calibGps.getAttribute('data-act')); });
  calibPois.addEventListener('click', function (e) {
    var b = e.target.closest('[data-poi]');
    if (!b) return;
    var p = POIS[+b.getAttribute('data-poi')];
    if (p) mapPZ.centerOn(p.px, p.py, Math.max(mapPZ.s, 1), true);
  });
  settingsEl.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]');
    if (a) doAct(a.getAttribute('data-act'));
  });
  $('schedList').addEventListener('click', onSchedListClick);
  $('impCam').addEventListener('click', function () { startImport('camera'); });
  $('impGal').addEventListener('click', function () { startImport('gallery'); });
  $('impBack').addEventListener('click', impBack);
  $('impLook').addEventListener('click', function () { if (imp.res) openPoster(imp.res.posterUrl, null); });
  impBody.addEventListener('click', onImpClick);
  impBody.addEventListener('input', onImpInput);
  impBody.addEventListener('change', onImpChange);
  impBar.addEventListener('click', onImpClick);
  $('impDiscard').addEventListener('click', function () {
    if (imp.dirty) { imp.ask = 'discard'; renderFoot(); } else discardImport();
  });
  impOk.addEventListener('click', function () {
    // 正在打字时直接点确认：先把还没来得及重算的那一笔算进去，别导入半截
    if (editTimer) { clearTimeout(editTimer); editTimer = 0; rebuildImp(); }
    confirmImport(false);
  });
  bannerEl.addEventListener('click', function () {
    openSettings();
    $('schedSec').scrollIntoView({ block: 'start' });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') handleBack(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  window.addEventListener('resize', function () {
    updateInsets();
    setSheet(state.sheet, false);
    mapPZ.resize();
    if (state.calibMode) { placeCrosshair(); updateInsets(); mapPZ.reclamp(false); }
    if (posterPZ && !posterEl.hidden) posterPZ.resize();
  });

  rebuildModel();
  refresh();
  setSheet('peek', false);
  updateInsets();
  mapPZ.fit(false);

  if (SIM) {
    acceptFix(parseFloat(Q.lat), parseFloat(Q.lon), isFinite(parseFloat(Q.acc)) ? parseFloat(Q.acc) : 8, -1, -1, Date.now(), 'sim');
    // ?hacc= 模拟指南针精度档（0–3，≤1 不可信），用来截「指南针不准」的提醒。
    if (isFinite(parseFloat(Q.heading))) acceptHeading(parseFloat(Q.heading), isFinite(parseFloat(Q.hacc)) ? parseFloat(Q.hacc) : 3);
  } else if (!BRIDGE && state.model) {
    // 没配准时不主动要定位权限：要了也画不出来。等用户进校准再要。
    startBrowserGeo();
  }

  if (!noticeSeen()) openNotice();
  setInterval(refresh, REFRESH_MS);
})();
