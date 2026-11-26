/*
 * logic.js 单测。演出数据用 web/data/schedule.js 原样（从海报逐条录入的，不是编的）；
 * 配准用「已知仿射 + 人为残差」合成的控制点，能精确算出该得多少。
 *
 * 跑法：node tools/test_logic.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
const L = require(path.join(WEB, 'logic.js'));

// schedule.js 是给浏览器的 window.X = … 写法，在沙箱里跑一遍取出来。
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(WEB, 'data', 'schedule.js'), 'utf8'), sandbox);
const SCHED = sandbox.window.LZM_SCHEDULE;
const show = (id) => {
  const s = SCHED.shows.find((x) => x.id === id);
  if (!s) throw new Error('没有这个节目：' + id);
  return s;
};

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
}
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error((msg || '') + ' 期望 ≈' + b + '（±' + tol + '），实际 ' + a);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const at = (s) => L.parseLocalDateTime(s);
const count = (id, ymd) => L.daySessions(show(id), ymd).sessions.length;
const closed = (id, ymd) => L.daySessions(show(id), ymd).closed;

console.log('— 规则解析');

// 海报魔术秀一格里写了三件事：平时 4 场 / 24 日公休 / 26–28 日 6 场，钉住拆分后的三条规则。
test('魔术秀 11-24 公休', () => eq(closed('magic', '2026-11-24'), true));
test('魔术秀 11-27 六场', () => eq(count('magic', '2026-11-27'), 6));
test('魔术秀 11-25 四场（落到默认规则）', () => eq(count('magic', '2026-11-25'), 4));

// 折子戏默认是不演的，只有 28/29 两天演：钉「默认规则 closed」这条路。
test('折子戏 11-27 不演', () => eq(closed('opera', '2026-11-27'), true));
test('折子戏 11-28 三场', () => eq(count('opera', '2026-11-28'), 3));

// 猪猪侠 24 日走默认 4 场、25 日起加到 5 场：钉「dates 命中优先于默认」。
test('猪猪侠 11-24 四场', () => eq(count('kids', '2026-11-24'), 4));
test('猪猪侠 11-25 五场', () => eq(count('kids', '2026-11-25'), 5));

// 冰雪世界周五周六延长到 20:30：钉 weekdays 规则，且 11-27 确实是周五。
test('2026-11-27 是周五', () => eq(L.weekday('2026-11-27'), 5));
test('冰雪世界 11-27（周五）至 20:30', () => {
  const d = L.daySessions(show('snow'), '2026-11-27');
  eq(d.sessions.length, 1); eq(d.sessions[0].endHM, '20:30'); eq(d.continuous, true);
});
test('冰雪世界 11-26（周四）至 17:30', () => eq(L.daySessions(show('snow'), '2026-11-26').sessions[0].endHM, '17:30'));

test('铁花秀 11-26 两场，带场次备注', () => {
  const d = L.daySessions(show('ironflower'), '2026-11-26');
  eq(d.sessions.length, 2); eq(d.sessions[0].note, '打铁花+低空烟花');
});
test('铁花秀 11-29 一场', () => eq(count('ironflower', '2026-11-29'), 1));
test('影视揭秘 11-30 公休', () => eq(closed('film', '2026-11-30'), true));

// 默认规则写在加场规则前面时，仍按「dates > weekdays > 默认」取，不被书写顺序带偏。
test('默认规则写在前面也不吞掉加场日', () => {
  const s = { id: 'x', rules: [{ times: [['10:00', '11:00']] }, { dates: ['2026-11-26'], times: [['10:00', '11:00'], ['12:00', '13:00']] }] };
  eq(L.daySessions(s, '2026-11-26').sessions.length, 2);
  eq(L.daySessions(s, '2026-11-25').sessions.length, 1);
});

console.log('— 最近一场');

// 「结束时间 > 现在」取第一场：13:00 时 12:45 那场还在演，不能跳到 16:45。
test('进行中：功夫传奇 11-26 13:00', () => {
  const st = L.showStatus(show('kungfu'), at('2026-11-26T13:00'), SCHED);
  eq(st.state, 'live'); eq(st.cur.startHM, '12:45'); eq(st.minsLeft, 45);
  eq(L.statusText(st), '进行中 · 还剩 45 分钟');
});
test('未开始：功夫传奇 11-26 14:00 → 16:45，2小时45分后', () => {
  const st = L.showStatus(show('kungfu'), at('2026-11-26T14:00'), SCHED);
  eq(st.state, 'upcoming'); eq(st.cur.startHM, '16:45'); eq(st.minsToStart, 165);
  eq(L.statusText(st), '2小时45分后');
});
test('快开演：综艺秀 11-26 14:20 → 10 分钟后（soon）', () => {
  const st = L.showStatus(show('variety'), at('2026-11-26T14:20'), SCHED);
  eq(st.state, 'soon'); eq(L.statusText(st), '10 分钟后');
});
test('1小时20分后 的写法', () => eq(L.fmtUntil(80), '1小时20分后'));
// 「明天第一场」也要带结束时间：只说 12:45 的话，人没法判断能不能和别的节目排开。
test('全结束：功夫传奇 11-26 21:00 → 今日已结束 · 明天 12:45–13:45', () => {
  const st = L.showStatus(show('kungfu'), at('2026-11-26T21:00'), SCHED);
  eq(st.state, 'ended'); eq(st.tomorrow.startHM, '12:45');
  eq(L.statusText(st), '今日已结束 · 明天 12:45–13:45');
});
test('起止区间用 en dash', () => eq(L.fmtRange({ startHM: '13:50', endHM: '14:25' }), '13:50–14:25'));
// 明天出了海报有效期就不说「明天几点」，免得替景区做承诺。
test('全结束且明天超出有效期：11-30 晚不附明天', () => {
  const st = L.showStatus(show('kungfu'), at('2026-11-30T21:00'), SCHED);
  eq(st.state, 'ended'); eq(st.tomorrow, null); eq(L.statusText(st), '今日已结束');
});
test('今日不演但明天演：折子戏 11-27 → 今日不演 · 明天 13:30–14:00', () => {
  const st = L.showStatus(show('opera'), at('2026-11-27T10:00'), SCHED);
  eq(st.state, 'closed'); eq(L.statusText(st), '今日不演 · 明天 13:30–14:00');
});
test('continuous 开放中：街艺 11-26 14:20 → 开放中 · 至 22:00', () => {
  const st = L.showStatus(show('street'), at('2026-11-26T14:20'), SCHED);
  eq(st.state, 'open'); eq(L.statusText(st), '开放中 · 至 22:00');
});
test('continuous 未开放：冰雪世界 9:40 → 10:00 开放 · 20 分钟后', () => {
  const st = L.showStatus(show('snow'), at('2026-11-26T09:40'), SCHED);
  eq(st.state, 'soon'); eq(L.statusText(st), '10:00 开放 · 20 分钟后');
});
// 结束那一刻（end == now）算已结束，不算「还剩 0 分钟」。
test('边界：恰好散场那一分钟算下一场', () => {
  const st = L.showStatus(show('kungfu'), at('2026-11-26T13:45'), SCHED);
  eq(st.cur.startHM, '16:45');
});
test('跨天：23:59 → 00:01 自动换到新一天的规则', () => {
  eq(L.showStatus(show('magic'), at('2026-11-24T23:59'), SCHED).state, 'closed');
  const st = L.showStatus(show('magic'), at('2026-11-25T00:01'), SCHED);
  eq(st.state, 'upcoming'); eq(st.cur.startHM, '09:30');
});
test('排序：进行中 → 未开始按时间 → 已结束 → 不演', () => {
  const t = at('2026-11-27T13:20');
  const sts = SCHED.shows.map((s, i) => L.showStatus(s, t, SCHED, i)).sort(L.compareStatus);
  const order = { live: 0, open: 1, soon: 2, upcoming: 2, ended: 3, closed: 4 };
  for (let i = 1; i < sts.length; i++) ok(order[sts[i - 1].state] <= order[sts[i].state], '状态顺序乱了 @' + i);
  const ups = sts.filter((s) => s.state === 'soon' || s.state === 'upcoming');
  for (let i = 1; i < ups.length; i++) ok(ups[i - 1].cur.start <= ups[i].cur.start, '未开始的没按时间排');
});
test('音乐广场两档节目取最近的：11-26 取狂欢音乐秀、11-27 取唐艺大舞台', () => {
  const pick = (t) => L.bestOf(['tangyi', 'carnival'].map((id, i) => L.showStatus(show(id), at(t), SCHED, i))).show.id;
  eq(pick('2026-11-26T15:00'), 'carnival');
  eq(pick('2026-11-27T15:00'), 'tangyi');
});
// 真机反馈：露出条只给即将开演的，正在演的看不到。改成进行中排最前（最多 2 场），再补最快开演的。
test('摘要：进行中排最前（最多 2 场），再补最快开演的，不收 continuous', () => {
  const t = at('2026-11-26T14:20');
  const items = L.peekItems(SCHED.shows.map((s, i) => L.showStatus(s, t, SCHED, i)), 3, 2);
  eq(items.length, 3);
  eq(items[0].state, 'live'); eq(items[1].state, 'live');
  eq(items[2].show.id, 'variety'); eq(items[2].cur.startHM, '14:30');
  ok(items.every((s) => !s.show.continuous));
});
// 11-26 11:25：上午几场都在 11:20 前散了，11:30 猪猪侠之前没有在演的（街艺是 continuous，不算）。
test('摘要：没有进行中时 3 格全给即将开演的，按开演时间排', () => {
  const t = at('2026-11-26T11:25');
  const items = L.peekItems(SCHED.shows.map((s, i) => L.showStatus(s, t, SCHED, i)), 3, 2);
  eq(items.length, 3);
  ok(items.every((s) => s.state === 'soon' || s.state === 'upcoming'), '不该有进行中');
  eq(items[0].show.id, 'kids'); eq(items[0].cur.startHM, '11:30');
  ok(items[0].cur.start <= items[1].cur.start && items[1].cur.start <= items[2].cur.start);
});
test('有效期判断', () => {
  eq(L.inValidity(SCHED, '2026-11-24'), true); eq(L.inValidity(SCHED, '2026-11-30'), true);
  eq(L.inValidity(SCHED, '2026-12-01'), false); eq(L.inValidity(SCHED, '2026-11-23'), false);
});
test('步行分钟：700 m × 1.3 ÷ 70 = 13', () => eq(L.walkMinutes(700), 13));

console.log('— 坐标配准');

// 合成真值：像素是 (lat, lon) 的一个仿射（含旋转、各向不等缩放、y 轴向下），
// 局部米制平面对 lat/lon 也是线性的，所以模型理应一字不差地还原它。
const LAT0 = 31.0, LON0 = 120.0;
// 真值也在同一套局部投影上造，否则「米」的口径和模型差 0.2%，会被误判成模型误差。
const F0 = L.localFrame(LAT0, LON0);
function truth(lat, lon) {
  const { x, y } = F0.toXY(lat, lon);
  // 北朝右、东朝下（导览图顺时针转了 90°），再加 7° 旋转和 1.6 / 1.35 px/m 的不等缩放
  const r = 7 * Math.PI / 180;
  const u = 1.6 * (y * Math.cos(r) - x * Math.sin(r));
  const v = 1.35 * (x * Math.cos(r) + y * Math.sin(r));
  return { px: 640 + u, py: 1137 + v };
}
const SITES = [[31.0030, 119.9950], [30.9975, 119.9960], [31.0040, 120.0060], [30.9968, 120.0055], [31.0002, 120.0002], [31.0015, 119.9990]];
const BASE = SITES.map(([lat, lon], i) => Object.assign({ name: 'P' + i, lat, lon }, truth(lat, lon)));

test('不足两点不配准；空表不抛', () => {
  eq(L.buildGeoModel([]), null); eq(L.buildGeoModel(BASE.slice(0, 1)), null); eq(L.buildGeoModel(undefined), null);
});
test('6 点仿射：控制点之外的任意点也精确还原', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(BASE, []));
  eq(m.kind, 'affine');
  for (const [lat, lon] of [[31.0010, 120.0030], [30.9990, 119.9980], [31.0100, 120.0200]]) {
    const p = m.forward(lat, lon), t = truth(lat, lon);
    near(p.px, t.px, 1e-6, 'px'); near(p.py, t.py, 1e-6, 'py');
  }
});
test('2 点相似变换：纯旋转 + 等比缩放的真值能还原', () => {
  const sim = (lat, lon) => { const { x, y } = F0.toXY(lat, lon); const r = 0.3;
    return { px: 500 + 1.5 * (x * Math.cos(r) - y * Math.sin(r)), py: 900 - 1.5 * (x * Math.sin(r) + y * Math.cos(r)) }; };
  const pts = [[31.000, 120.000], [31.003, 120.004]].map(([lat, lon]) => Object.assign({ lat, lon }, sim(lat, lon)));
  const m = L.buildGeoModel(pts);
  eq(m.kind, 'similarity');
  const p = m.forward(31.0015, 119.998), t = sim(31.0015, 119.998);
  near(p.px, t.px, 0.05, 'px'); near(p.py, t.py, 0.05, 'py');
});
test('两点挨得太近（< 30 m）不配准', () => {
  const pts = [[31.0, 120.0], [31.0001, 120.0001]].map(([lat, lon]) => Object.assign({ lat, lon }, truth(lat, lon)));
  eq(L.buildGeoModel(pts), null);
});
test('逆变换：inverse(forward(q)) ≈ q', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(BASE, []));
  const p = m.forward(31.0012, 120.0021), ll = m.inverse(p.px, p.py);
  near(ll.lat, 31.0012, 1e-8); near(ll.lon, 120.0021, 1e-8);
});
test('朝向：图是顺时针转 90° 的，真北在图上朝右（≈90°，带 7° 旋转）', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(BASE, []));
  const q = m.toXY(31.0, 120.0);
  // 真值里北 = (u 正、v 带 sin7° 分量)：atan2(1.6cos7°, -(1.35sin7°)) 换成「上为 0 顺时针」
  const r = 7 * Math.PI / 180;
  const expect = (Math.atan2(1.6 * Math.cos(r), -1.35 * Math.sin(r)) * 180 / Math.PI + 360) % 360;
  near(m.headingToImage(q.x, q.y, 0), expect, 1e-6);
  near(m.headingToImage(q.x, q.y, 0), 90 + 5.9, 1.5, '大致朝右');
});
test('精度圈：像素半径 = 精度米数 × 每米像素', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(BASE, []));
  near(m.pxPerM, Math.sqrt(1.6 * 1.35), 1e-3);
  const loc = L.locate(m, 31.0, 120.0, 10, 1280, 2275, 0);
  near(loc.accPx, 10 * Math.sqrt(1.6 * 1.35), 1e-3);
});

// 校准点：在 P4 附近（P4 本身会被它替换掉）站着对准，像素与真值偏了 (+40, −25)——手绘图的局部变形。
const CAL_LL = [31.0005, 120.0004];
const CAL = Object.assign({ lat: CAL_LL[0], lon: CAL_LL[1], acc: 6, time: 0 }, (() => {
  const t = truth(CAL_LL[0], CAL_LL[1]); return { px: t.px + 40, py: t.py - 25 };
})());

test('校准点 40 m 内的底稿点被替换，权重 3 倍', () => {
  const pts = L.mergeControlPoints(BASE, [CAL]);
  ok(!pts.some((p) => p.name === 'P4'), 'P4 应被替换');
  eq(pts.length, BASE.length);
  eq(pts.filter((p) => p.kind === 'calib')[0].w, L.CALIB_WEIGHT);
});
test('加校准点后：校准点处误差 ≈ 0', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(BASE, [CAL]));
  const p = m.forward(CAL.lat, CAL.lon);
  near(p.px, CAL.px, 1e-6, 'px'); near(p.py, CAL.py, 1e-6, 'py');
  // 离它 3 m 也几乎贴着它（IDW 在点附近是平的），不会一挪步就跳回去
  const p3 = m.forward(CAL.lat + 3 / 110900, CAL.lon);
  const t3 = truth(CAL.lat + 3 / 110900, CAL.lon);
  near(p3.px - t3.px, 40, 2, '3 m 外 dx'); near(p3.py - t3.py, -25, 2, '3 m 外 dy');
});
test('加校准点后：其余底稿点仍精确命中', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(BASE, [CAL]));
  for (const b of BASE.filter((p) => p.name !== 'P4')) {
    const p = m.forward(b.lat, b.lon); near(p.px, b.px, 1e-6); near(p.py, b.py, 1e-6);
  }
});
test('加校准点后：远处修正衰减到接近 0（只剩仿射，不乱外推）', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(BASE, [CAL]));
  const calRes = Math.hypot(40, 25);
  const far = (dLatM) => {
    const lat = CAL.lat + dLatM / 110900, q = m.toXY(lat, CAL.lon);
    const full = m.forwardXY(q.x, q.y), aff = m.affineXY(q.x, q.y);
    return Math.hypot(full.px - aff.px, full.py - aff.py);
  };
  ok(far(2000) < 0.05 * calRes, '2 km 外修正应 < 5%：' + far(2000).toFixed(2));
  ok(far(5000) < 0.01 * calRes, '5 km 外修正应 < 1%：' + far(5000).toFixed(2));
  ok(far(2000) < far(500), '修正应随距离单调变小');
});
test('景区外判定与距离', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(BASE, []));
  const c = m.inverse(640, 1137.5);
  const out = L.locate(m, c.lat + 2300 / 110900, c.lon, 10, 1280, 2275, 60);
  eq(out.inside, false); near(out.distToCenterM, 2300, 30);
  eq(L.fmtDistance(out.distToCenterM), '2.3 km');
  eq(L.locate(m, c.lat, c.lon, 10, 1280, 2275, 60).inside, true);
});

console.log('— 配准覆盖范围');

test('凸包：正方形内为 0、外为到边的距离、退化时也不抛', () => {
  const sq = L.convexHull([{ px: 0, py: 0 }, { px: 100, py: 0 }, { px: 100, py: 100 }, { px: 0, py: 100 }, { px: 50, py: 50 }]);
  eq(sq.length, 4, '内部点应被剔掉');
  eq(L.distOutsideHull(sq, 50, 50), 0);
  near(L.distOutsideHull(sq, 50, 130), 30, 1e-9);
  near(L.distOutsideHull(sq, 130, 140), 50, 1e-9);
  near(L.distOutsideHull(L.convexHull([{ px: 0, py: 0 }, { px: 100, py: 0 }]), 50, 20), 20, 1e-9);
  eq(L.distOutsideHull([], 1, 1), Infinity);
});

// 真数据（geo.js 21 个控制点、venues.js 剧场坐标，都是定稿原样）：
// 音乐广场一带没有控制点，应落在凸包外；演艺城中心的剧场在凸包内。
const dataBox = { window: {} };
for (const f of ['geo.js', 'venues.js']) vm.runInNewContext(fs.readFileSync(path.join(WEB, 'data', f), 'utf8'), dataBox);
const GEO = dataBox.window.LZM_GEO, VEN = dataBox.window.LZM_VENUES;
const venue = (id) => VEN.find((v) => v.id === id);
test('真数据：音乐广场在控制点凸包外 > 25 m，全息儿童剧场在凸包内', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(GEO.controlPoints, []));
  ok(m, '21 个控制点应能配准'); eq(m.kind, 'affine');
  const hull = L.convexHull(GEO.controlPoints);
  const mus = venue('music'), kids = venue('kids');
  ok(L.distOutsideHull(hull, mus.px, mus.py) / m.pxPerM > 25, '音乐广场应在凸包外');
  eq(L.distOutsideHull(hull, kids.px, kids.py), 0);
});
test('真数据：每米约 2.3 像素（geo.js 注「约 0.44 m/px」），北在图上朝右偏下', () => {
  const m = L.buildGeoModel(L.mergeControlPoints(GEO.controlPoints, []));
  near(1 / m.pxPerM, 0.44, 0.05, 'm/px');
  const k = venue('kids'), ll = m.inverse(k.px, k.py), q = m.toXY(ll.lat, ll.lon);
  const north = m.headingToImage(q.x, q.y, 0);
  ok(north > 90 && north < 130, '北应在图上朝右略偏下（90°–130°），实际 ' + north.toFixed(1));
});

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
