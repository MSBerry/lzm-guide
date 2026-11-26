/*
 * 无头 Chrome 截图 + 交互冒烟：通过 DevTools 协议点标记、拖面板、双指缩放、模拟原生壳，并收集控制台报错。
 *
 * 位置相关的场景直接用真数据（web/data/geo.js 已定稿）。另拷一份「降级沙箱」到
 * f:/tmp/lzm-guide/ui/sandbox/：控制点和参照点清空、删掉一个剧场，验数据缺失时不崩。真 web/data 不动。
 *
 * 跑法：node tools/shoot.js            → 截图写到 f:/tmp/lzm-guide/ui/
 *       node tools/shoot.js s5 s6      → 只跑名字以这些开头的场景
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WEB = path.join(__dirname, '..', 'web');
const OUT = 'f:/tmp/lzm-guide/ui';
const SANDBOX = path.join(OUT, 'sandbox');
// 用户的 vivo：1080×2376、DPR 约 2.6 → 视口约 412×905。截图用 DPR 2，图小一点、字一样清楚。
const W = 412, H = 905, DPR = 2;

const L = require(path.join(WEB, 'logic.js'));
const PST = require(path.join(WEB, 'poster.js'));
const box = { window: {} };
for (const f of ['geo.js', 'venues.js', 'schedule.js']) vm.runInNewContext(fs.readFileSync(path.join(WEB, 'data', f), 'utf8'), box);
const MODEL = L.buildGeoModel(L.mergeControlPoints(box.window.LZM_GEO.controlPoints, []));
if (!MODEL) throw new Error('真数据配不上准，截不了位置相关的图');

// ── 导入海报用的 OCR 素材 ─────────────────────────────────
// 11/24 那份是真识别结果原样；「12/01 那一期」没有真海报，拿 11/24 的识别结果改出来：
// 日期整体挪一周，再造出预览页要演示的几种情况（换节目、改时间、折行第二截没认出来、低置信度）。
const OCR_1124 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'poster-1124.ocr.json'), 'utf8'));
const OCR_1201 = (() => {
  const o = JSON.parse(JSON.stringify(OCR_1124));
  o.lines.forEach((l) => {
    l.text = l.text.replace(/11月/g, '12月').replace(/(\d{1,2})日/g, (m, d) => (+d >= 24 && +d <= 30 ? +d - 23 : +d) + '日');
  });
  const line = (t) => { const l = o.lines.find((x) => x.text === t); if (!l) throw new Error('12/01 素材里没有「' + t + '」'); return l; };
  line('综艺秀《梦幻钻石》').text = '综艺秀《星光大道》';
  line('12:45-13:45/16:45-17:45/19:15-20:15').text = '12:45-13:45/16:45-17:45/19:30-20:30';
  o.lines.splice(o.lines.indexOf(line('16:30-17:10/17:40-18:20')), 1);
  line('10:35-11:10/11:40-12:15/13:50-14:25/17:05-17:40').score = 0.78;
  return o;
})();
const ENTRY_1201 = {
  id: 'imp-shoot', importedAt: L.parseLocalDateTime('2026-11-30T20:05'), posterId: 'p1201', posterUrl: 'img/schedule.jpg',
  schedule: PST.parsePoster(OCR_1201, { today: '2026-11-30', knownShows: box.window.LZM_SCHEDULE.shows, venues: box.window.LZM_VENUES }).schedule,
};
const FIX_JS = `window.__FIX = ${JSON.stringify({ p1124: OCR_1124, p1201: OCR_1201 })};`;
const PRELOAD_1201 = `try { localStorage.setItem('lzm.schedules.v1', ${JSON.stringify(JSON.stringify([ENTRY_1201]))}); } catch (e) {}`;
// 原生回调：参数是 JSON 字符串，posterUrl 指向打包的那张图（12/01 没有真图，对照时看到的是 11/24 的）
const result = (name, id) => `LZM_onPosterResult(JSON.stringify(Object.assign({}, window.__FIX.${name}, { posterId: '${id}', posterUrl: 'img/schedule.jpg', engine: 'mock', ms: 1234 })))`;
// 找卡片：按节目名，返回它在预览里的 DOM id
const cardId = (title) => `[...document.querySelectorAll('.pv-card')].find((c) => c.querySelector('.pv-title').textContent.includes(${JSON.stringify(title)})).id`;
const scrollToCard = (title) => `(() => { const c = document.getElementById(${cardId(title)}); const b = document.getElementById('impBody'); b.scrollTop += c.getBoundingClientRect().top - b.getBoundingClientRect().top - 8; })()`;
const impText = `document.getElementById('impBody').textContent`;

function writeSandbox() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.cpSync(WEB, SANDBOX, { recursive: true });
  fs.appendFileSync(path.join(SANDBOX, 'data', 'geo.js'), '\n// 降级沙箱：清空控制点\nwindow.LZM_GEO.controlPoints = [];\n');
  fs.appendFileSync(path.join(SANDBOX, 'data', 'venues.js'),
    '\n// 降级沙箱：清空参照点、删掉梨园剧场（折子戏的 venueId 就找不到了）\nwindow.LZM_POIS = [];\n' +
    "window.LZM_VENUES = window.LZM_VENUES.filter(function (v) { return v.id !== 'liyuan'; });\n");
}

const url = (root, q) => 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/') + (q ? '?' + q : '');
const NOW = 'now=2026-11-26T14:20';
const INSIDE = { lat: 30.9545, lon: 120.0728 };          // 盛世广场附近（主窗口给的样例点）
const MUSIC = MODEL.inverse(891, 2094);                  // 音乐广场红牌处：控制点凸包外
const C = MODEL.inverse(640, 1137.5);
const OUTSIDE = { lat: C.lat + 2300 / 111000, lon: C.lon };
const llq = (ll, extra) => `lat=${ll.lat.toFixed(6)}&lon=${ll.lon.toFixed(6)}&acc=8${extra || ''}`;

// 在页面里查「有没有字压着字」：可见标签两两不重叠、标签不压别家徽标、徽标之间重叠不超过半径。
const COLLISION_JS = `(() => {
  const vis = (e) => e.style.visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const mk = [...document.querySelectorAll('.mk')].map((m) => ({ id: m.dataset.venue,
    b: m.querySelector('.mk-badge').getBoundingClientRect(), l: vis(m.querySelector('.mk-lab')) ? m.querySelector('.mk-lab').getBoundingClientRect() : null }));
  const ov = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const bad = [];
  for (let i = 0; i < mk.length; i++) for (let j = 0; j < mk.length; j++) {
    if (i === j) continue;
    if (mk[i].l && mk[j].l && i < j && ov(mk[i].l, mk[j].l)) bad.push(mk[i].id + ' 标签压 ' + mk[j].id + ' 标签');
    if (mk[i].l && ov(mk[i].l, mk[j].b)) bad.push(mk[i].id + ' 标签压 ' + mk[j].id + ' 徽标');
    const bi = mk[i].b, bj = mk[j].b, d = Math.hypot((bi.left + bi.right - bj.left - bj.right) / 2, (bi.top + bi.bottom - bj.top - bj.bottom) / 2);
    if (i < j && d < Math.max(bi.width, bj.width) / 2) bad.push(mk[i].id + ' 徽标盖住 ' + mk[j].id + ' 过半');
  }
  return { bad, shown: mk.filter((m) => m.l).length, total: mk.length };
})()`;

// 起止时间不许折行（真机上用户点名「14:00 下面另起一行 –15:05」很怪）：
// 时间块里结束时间的顶边必须在开始时间的底边之上（同一行）；句子里夹的时间段、状态胶囊只能有一个行框。
const WRAP_JS = `(() => {
  const bad = [], shown = (e) => e.getClientRects().length && e.getBoundingClientRect().width > 0;
  for (const box of document.querySelectorAll('.tm, .ses-tm, .mk-pill')) {
    const a = box.querySelector('b'), z = box.querySelector('small, i');
    if (!a || !z || !shown(box) || box.closest('[style*="visibility: hidden"]')) continue;
    if (z.getBoundingClientRect().top >= a.getBoundingClientRect().bottom - 3) bad.push(box.className + '「' + box.textContent + '」');
  }
  for (const e of document.querySelectorAll('.nw, .pill')) {
    if (!shown(e)) continue;
    const lh = parseFloat(getComputedStyle(e).lineHeight) || 20;
    if (e.getClientRects().length > 1 || e.getBoundingClientRect().height > lh * 1.6 + 8) bad.push(e.className + '「' + e.textContent + '」');
  }
  return bad;
})()`;

async function expectNoCollision(p, tag) {
  const r = await p.eval(COLLISION_JS);
  p.expect(!r.bad.length, (tag || '') + ' 整图视图有压字：' + r.bad.join('；'));
  return r;
}

// ── 场景 ─────────────────────────────────
const SCENES = [
  { name: 's0_notice', root: WEB, q: NOW, freshNotice: true },
  { name: 's0b_degraded', root: SANDBOX, q: NOW,
    act: async (p) => {
      p.expect(await p.chip() === '仅显示演出时间', '没有控制点时胶囊应为「仅显示演出时间」：' + await p.chip());
      p.expect(await p.eval(`!document.querySelector('.mk[data-venue="liyuan"]')`), '找不到的剧场不该上图');
      p.expect(/折子戏/.test(await p.eval(`document.getElementById('sheetBody').textContent`)), '剧场缺失的节目仍应出现在列表里');
    } },
  { name: 's1_full_view', root: WEB, q: NOW, act: async (p) => { await expectNoCollision(p, '14:20'); } },
  { name: 's1b_full_view_morning', root: WEB, q: 'now=2026-11-26T10:00', act: async (p) => { await expectNoCollision(p, '10:00'); } },
  { name: 's1c_full_view_evening', root: WEB, q: 'now=2026-11-28T19:05', act: async (p) => { await expectNoCollision(p, '11-28 19:05'); } },
  { name: 's2_inside', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}`, act: async (p) => { await expectNoCollision(p, '有定位'); } },
  { name: 's2b_inside_follow', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}`,
    act: async (p) => { await p.clickSel('#fabLocate'); await p.wait(700); await expectNoCollision(p, '跟随放大后'); } },
  { name: 's3_outside', root: WEB, q: `${NOW}&${llq(OUTSIDE, '&heading=60')}`,
    act: async (p) => { p.expect(/^不在景区 · 距 2\.3 km$/.test(await p.chip()), '景区外胶囊文案不对：' + await p.chip()); } },
  { name: 's4_half', root: WEB, q: NOW,
    act: async (p) => {
      await p.dragSel('#sheetHead', 0, -330); await p.wait(500);
      const h = parseFloat(await p.eval(`document.getElementById('sheet').style.height`));
      p.expect(Math.abs(h - Math.round(H * 0.5)) < 3, '拖到一半停住再松手应吸到半屏，实际 ' + h);
    } },
  { name: 's4b_half_walk', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}`,
    act: async (p) => {
      await p.dragSel('#sheetHead', 0, -330); await p.wait(500);
      p.expect(/步行约 \d+ 分钟/.test(await p.eval(`document.getElementById('sheetBody').textContent`)), '有定位时列表应出步行时间');
    } },
  { name: 's5_venue_detail', root: WEB, q: NOW,
    act: async (p) => { await p.tapSel('.mk[data-venue="magic"] .mk-badge'); await p.wait(600); } },
  { name: 's6_venue_walk', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}`,
    act: async (p) => { await p.tapSel('.mk[data-venue="variety"] .mk-badge'); await p.wait(600); } },
  { name: 's6b_ironflower', root: WEB, q: 'now=2026-11-26T18:50',
    act: async (p) => {
      p.expect(await p.eval(`document.querySelector('.mk[data-venue="ironflower"] .mk-badge').textContent`) === '火', '铁花秀徽标应为「火」');
      p.expect(await p.eval(`document.querySelector('.mk[data-venue="music"] .mk-badge').textContent`) === '♪', '音乐广场徽标应为 ♪');
      await p.tapSel('.mk[data-venue="ironflower"] .mk-badge'); await p.wait(600);
    } },
  { name: 's7_full_list', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}`,
    act: async (p) => {
      await p.dragSel('#sheetHead', 0, -700); await p.wait(500);
      const t = await p.eval(`document.getElementById('sheetBody').textContent`);
      p.expect(!t.includes('…'), '列表里不该出现省略号截断');
      p.expect(/13:50–14:25|13:50\s*–14:25/.test(t.replace(/\s+/g, '')) || t.includes('–14:25'), '列表行应写出结束时间');
    } },
  { name: 's8_poster', root: WEB, q: NOW, act: async (p) => { await p.clickSel('#fabPoster'); await p.wait(500); } },
  { name: 's9_settings', root: WEB, q: `${NOW}&${llq(INSIDE)}`, act: async (p) => { await p.clickSel('#fabSettings'); await p.wait(300); } },
  { name: 's10_calib', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}`,
    act: async (p) => { await p.clickSel('#fabSettings'); await p.wait(200); await p.clickSel('#calibStart'); await p.wait(700); } },
  { name: 's11_debug', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}&debug=1` },
  { name: 's12_out_of_range', root: WEB, q: 'now=2026-12-02T19:10', act: async (p) => { await expectNoCollision(p, '有效期外'); } },
  { name: 's13_evening', root: WEB, q: 'now=2026-11-26T21:30' },
  { name: 's14_pinch', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}`,
    act: async (p) => {
      const s0 = await p.scale();
      await p.pinch(206, 430, 60, 240); await p.wait(300);
      const s = await p.scale();
      p.expect(Math.abs(s / s0 - 4) < 0.1, '双指张开 60→240 px 后应放大 4 倍：' + s0 + ' → ' + s);
    } },
  { name: 's15_bridge', root: WEB, q: `${NOW}&debug=1`, bridge: true,
    act: async (p) => {
      const calls = () => p.eval(`window.AndroidBridge.calls.join(',')`);
      await p.eval(`LZM_onLocationStatus('denied')`); await p.wait(50);
      p.expect(await p.chip() === '没给定位权限', '拒绝权限时胶囊文案不对：' + await p.chip());
      await p.clickSel('#locChip'); await p.wait(50);
      p.expect((await calls()).includes('perm'), '点「没给定位权限」应调 requestLocationPermission');
      await p.eval(`LZM_onLocationStatus('disabled')`); await p.wait(50);
      p.expect(await p.chip() === '定位没开', '系统定位关时胶囊文案不对：' + await p.chip());
      await p.clickSel('#locChip'); await p.wait(50);
      p.expect((await calls()).includes('settings'), '点「定位没开」应调 openLocationSettings');
      await p.eval(`LZM_onLocationStatus('searching')`);
      p.expect(await p.chip() === '定位中…', '搜星时胶囊应为「定位中…」：' + await p.chip());
      await p.eval(`LZM_onLocation(${INSIDE.lat}, ${INSIDE.lon}, 6, 1.4, 120, Date.now(), 'gps')`);
      await p.eval(`LZM_onHeading(200, 3)`); await p.wait(100);
      p.expect(await p.chip() === '已定位 ±6 m', '收到定位后胶囊应为「已定位 ±6 m」：' + await p.chip());
      p.expect(await p.eval(`!document.getElementById('me').hidden`), '收到原生定位后应画出蓝点');
      p.expect(/朝向 120°/.test(await p.eval(`document.getElementById('dbg').textContent`)), '走动中（1.4 m/s）应优先用 GPS bearing 120° 而不是指南针 200°');
      p.expect(await p.eval(`!window.__geoCalled`), '有原生壳时不该调 navigator.geolocation');
      await p.clickSel('#fabLocate'); await p.wait(400);
      p.expect((await calls()).includes('keep:true'), '进入跟随应 setKeepScreenOn(true)');
      await p.clickSel('#fabPoster'); await p.wait(200);
      p.expect(await p.eval(`LZM_onBack()`) === true && await p.eval(`document.getElementById('poster').hidden`), '返回键应先关海报');
      p.expect(await p.eval(`LZM_onBack()`) === false, '面板收起、列表视图时返回键应交给原生（false）');
      await p.drag(150, 400, 60, 40); await p.wait(100);
      p.expect((await calls()).includes('keep:false'), '手动拖图应退出跟随并 setKeepScreenOn(false)');
    } },
  { name: 's16_calib_flow', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}&debug=1`,
    act: async (p) => {
      const before = /图上 px (\d+) py (\d+)/.exec(await p.eval(`document.getElementById('dbg').textContent`));
      await p.clickSel('#fabSettings'); await p.wait(150);
      await p.clickSel('#calibStart'); await p.wait(500);
      await p.drag(120, 300, 45, -35); await p.wait(200);
      await p.clickSel('#calibOk'); await p.wait(300);
      const saved = JSON.parse(await p.eval(`localStorage.getItem('lzm.calib.v1')`) || '[]');
      p.expect(saved.length === 1, '确定后应存下 1 个校准点，实际 ' + saved.length);
      const m = /图上 px (\d+) py (\d+)/.exec(await p.eval(`document.getElementById('dbg').textContent`));
      p.expect(m && saved[0] && Math.abs(+m[1] - saved[0].px) <= 1 && Math.abs(+m[2] - saved[0].py) <= 1,
        '校准后同一位置应正好落在校准像素上：蓝点 ' + (m && m[1] + ',' + m[2]) + ' vs 校准 ' + (saved[0] && saved[0].px + ',' + saved[0].py));
      p.expect(saved[0] && before && Math.hypot(saved[0].px - before[1], saved[0].py - before[2]) > 20, '拖过图之后校准点应和原位置不同');
    } },
  { name: 's17_narrow360', root: WEB, q: `${NOW}&${llq(OUTSIDE)}`, vp: { w: 360, h: 760, dpr: 2, mobile: true },
    act: async (p) => { await expectNoCollision(p, '360 宽'); } },
  { name: 's17b_narrow360_detail', root: WEB, q: 'now=2026-11-26T18:50', vp: { w: 360, h: 760, dpr: 2, mobile: true },
    act: async (p) => { await p.tapSel('.mk[data-venue="ironflower"] .mk-badge'); await p.wait(600); } },
  { name: 's17c_narrow360_list', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60')}`, vp: { w: 360, h: 760, dpr: 2, mobile: true },
    act: async (p) => { await p.dragSel('#sheetHead', 0, -600); await p.wait(500); } },
  { name: 's17d_narrow360_list_late', root: WEB, q: 'now=2026-11-28T20:40', vp: { w: 360, h: 760, dpr: 2, mobile: true },
    act: async (p) => {
      await p.dragSel('#sheetHead', 0, -600); await p.wait(500);
      await p.eval(`document.getElementById('sheetBody').scrollTop = 99999`); await p.wait(200);
    } },
  { name: 's18_desktop_wheel', root: WEB, q: NOW, vp: { w: 1280, h: 800, dpr: 1, mobile: false },
    act: async (p) => {
      const s0 = await p.scale();
      for (let i = 0; i < 4; i++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 380, deltaX: 0, deltaY: -120 }); await p.wait(30); }
      await p.wait(200);
      const s1 = await p.scale();
      p.expect(s1 > s0 * 2, '滚轮向上 4 格应放大到 2 倍以上：' + s0 + ' → ' + s1);
    } },
  { name: 's19_music_alert', root: WEB, q: `${NOW}&${llq(MUSIC, '&heading=200')}`,
    act: async (p) => {
      const t = await p.eval(`document.getElementById('alert').hidden ? '' : document.getElementById('alertText').textContent`);
      p.expect(/^音乐广场一带定位偏差较大/.test(t), '音乐广场一带应提醒校准：' + t);
      await p.clickSel('#fabLocate'); await p.wait(700);
    } },
  { name: 's19b_music_alert_go', root: WEB, q: `${NOW}&${llq(MUSIC, '&heading=200')}`,
    act: async (p) => {
      await p.clickSel('#alertAct'); await p.wait(600);
      p.expect(await p.eval(`!document.getElementById('calibBar').hidden`), '点「去校准」应直接进校准');
    } },
  { name: 's20_compass_weak', root: WEB, q: `${NOW}&${llq(INSIDE, '&heading=60&hacc=0')}`,
    act: async (p) => {
      await p.clickSel('#fabLocate'); await p.wait(700);
      p.expect(/指南针不准/.test(await p.eval(`document.getElementById('alertText').textContent`)), '指南针精度 ≤1 应提醒画 8 字');
      p.expect(await p.eval(`document.getElementById('meCone').classList.contains('weak')`), '指南针不可信时扇形应变虚');
    } },
  { name: 's21_low_acc', root: WEB, q: `${NOW}&lat=${INSIDE.lat}&lon=${INSIDE.lon}&acc=45&heading=60`,
    act: async (p) => {
      p.expect(/定位精度 ±45 米/.test(await p.eval(`document.getElementById('alertText').textContent`)), '精度 45 m 应提醒');
      await p.clickSel('#alertClose'); await p.wait(100);
      p.expect(await p.eval(`document.getElementById('alert').hidden`), '点 ✕ 后提醒应收起');
    } },
  { name: 's22_browser_geo', root: WEB, q: NOW, geo: INSIDE,
    act: async (p) => {
      await p.wait(800);
      p.expect(/^已定位 ±\d+ m$/.test(await p.chip()), '浏览器定位回落路径应拿到位置：' + await p.chip());
      p.expect(await p.eval(`!document.getElementById('me').hidden`), '浏览器定位后应画出蓝点');
    } },

  // ── 导入新海报 ─────────────────────────────────
  { name: 'p1_import_entry', root: WEB, q: NOW, bridge: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(300);
      p.expect(await p.eval(`!document.getElementById('impCam').disabled`), '有原生壳且 ocrAvailable 时拍照按钮应可点');
      p.expect(/当前生效/.test(await p.eval(`document.getElementById('schedList').textContent`)), '内置那期应标「当前生效」');
    } },
  { name: 'p1b_import_browser', root: WEB, q: NOW,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(300);
      await p.eval(`document.getElementById('schedSec').scrollIntoView()`); await p.wait(100);
      var note = await p.eval(`document.getElementById('impNote').textContent`);
      p.expect(note.startsWith('浏览器版不支持识别海报，请用 App'), '浏览器里应提示用 App');
      p.expect(note.includes('太湖龙之梦度假区」→ 演出安排 → 演艺城节目单'), '应给出最新节目单的获取渠道');
      p.expect(await p.eval(`document.getElementById('impCam').disabled && document.getElementById('impGal').disabled`), '浏览器里两个按钮应置灰');
    } },
  { name: 'p2_busy', root: WEB, q: NOW, bridge: true, fix: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(100);
      p.expect((await p.calls()).includes('pick:camera'), '点「拍照」应调 pickPoster(\'camera\')');
      await p.eval(`LZM_onPosterProgress('decoding')`); await p.wait(50);
      await p.eval(`LZM_onPosterProgress('detecting')`); await p.wait(300);
      p.expect(/正在识别海报/.test(await p.eval(impText)), '收到进度应显示识别中');
    } },
  { name: 'p3_preview_summary', root: WEB, q: NOW, bridge: true, fix: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impGal'); await p.wait(50);
      p.expect((await p.calls()).includes('pick:gallery'), '点「从相册选」应调 pickPoster(\'gallery\')');
      await p.eval(`LZM_onPosterProgress('recognizing')`); await p.wait(50);
      await p.eval(result('p1124', 'p1124')); await p.wait(400);
      const t = await p.eval(impText);
      p.expect(/识别出 17 个节目，没有需要确认的地方/.test(t), '原海报应 17 个节目、0 处需确认：' + t.slice(0, 120));
      p.expect(/节目和场次时间都一样/.test(t), '同一张海报和当前那期比应「都一样」');
    } },
  { name: 'p4_preview_warn_edit', root: WEB, q: 'now=2026-12-01T10:00', bridge: true, fix: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1201', 'p1201')); await p.wait(400);
      const t = await p.eval(impText);
      p.expect(/识别出 17 个节目，\d+ 处需要确认/.test(t), '12/01 素材应有需确认的地方');
      // 时间有变化 2：功夫传奇是素材里故意改的；魔术秀是折行第二截没认出来，真的少了 17:40–18:20
      p.expect(/新增 1/.test(t) && /本期没有 1/.test(t) && /时间有变化 2/.test(t) && /−17:40–18:20/.test(t), '对比应列出新增 1 / 本期没有 1 / 时间有变化 2');
      p.expect(await p.eval(`document.getElementById(${cardId('惊天幻象')}).querySelector('.pv-day.warn') !== null`), '魔术秀那几天应标黄');
      await p.eval(`document.getElementById(${cardId('惊天幻象')}).querySelector('[data-pv=edit]').click()`); await p.wait(200);
      await p.eval(scrollToCard('惊天幻象')); await p.wait(200);
      p.expect(await p.eval(`document.querySelectorAll('#' + ${cardId('惊天幻象')} + ' .pv-sub.warn').length`) === 1, '编辑态里出问题的那一子行应标黄');
    } },
  { name: 'p4b_edit_fixed', root: WEB, q: 'now=2026-12-01T10:00', bridge: true, fix: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1201', 'p1201')); await p.wait(300);
      await p.eval(`document.getElementById(${cardId('惊天幻象')}).querySelector('[data-pv=edit]').click()`); await p.wait(150);
      await p.eval(`(() => { const ta = document.querySelector('#' + ${cardId('惊天幻象')} + ' .pv-sub[data-k="1"] textarea');
        ta.value = '09:30-10:10 / 10:40-11:20 / 13:00-13:40 / 15:20-16:00 / 16:30-17:10 / 17:40-18:20';
        ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await p.wait(500);
      await p.eval(scrollToCard('惊天幻象')); await p.wait(150);
      const card = await p.eval(`document.getElementById(${cardId('惊天幻象')}).textContent`);
      p.expect(!/海报写每天/.test(card) && /6 场/.test(card), '补全后魔术秀不该再报场数不符：' + card.slice(0, 200));
      p.expect(await p.eval(`document.getElementById(${cardId('惊天幻象')}).querySelector('.pv-day.warn') === null`), '改好后黄条应消失');
    } },
  { name: 'p5_new_show_venue', root: WEB, q: 'now=2026-12-01T10:00', bridge: true, fix: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1201', 'p1201')); await p.wait(300);
      p.expect(/还没选剧场/.test(await p.eval(`document.getElementById(${cardId('星光大道')}).textContent`)), '新节目应提示还没选剧场');
      await p.eval(`(() => { const s = document.querySelector('#' + ${cardId('星光大道')} + ' select'); s.value = 'variety'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await p.wait(200);
      await p.eval(scrollToCard('星光大道')); await p.wait(150);
      const card = await p.eval(`document.getElementById(${cardId('星光大道')}).textContent`);
      p.expect(/综艺秀剧场/.test(card) && !/请选它在哪个剧场/.test(card), '选了剧场后应显示剧场名、不再报缺剧场：' + card.slice(0, 160));
    } },
  { name: 'p6_confirmed', root: WEB, q: 'now=2026-12-01T10:00', bridge: true, fix: true,
    act: async (p) => {
      p.expect(!(await p.eval(`document.getElementById('banner').hidden`)), '12/01 只有内置那期时应挂超期横幅');
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1201', 'p1201')); await p.wait(300);
      await p.clickSel('#impOk'); await p.wait(200);
      p.expect(await p.eval(`!document.getElementById('impBar').hidden && /仍然导入/.test(document.getElementById('impBar').textContent)`), '有标黄时确认要先在页面内问一句');
      await p.clickSel('#impBar [data-imp="ok-force"]'); await p.wait(400);
      const saved = JSON.parse(await p.eval(`localStorage.getItem('lzm.schedules.v1')`) || '[]');
      p.expect(saved.length === 1 && saved[0].schedule.validFrom === '2026-12-01' && saved[0].posterId === 'p1201', '确认后应存下这一期：' + JSON.stringify(saved.map((x) => x.schedule.validFrom)));
      p.expect(/已导入 12\/01–12\/07/.test(await p.eval(`document.getElementById('toast').textContent`)), 'toast 应为「已导入 12/01–12/07」');
      p.expect(await p.eval(`document.getElementById('imp').hidden && document.getElementById('banner').hidden`), '导入后应立即生效、横幅收起');
      p.expect(!(await p.calls()).some((c) => c.startsWith('del:')), '确认导入不该删原图');
    } },
  { name: 'p7_sched_list', root: WEB, q: 'now=2026-12-03T14:20', bridge: true, init: PRELOAD_1201,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(300);
      const t = await p.eval(`document.getElementById('schedList').textContent`);
      p.expect(/12\/01–12\/07当前生效/.test(t.replace(/\s/g, '')), '导入的那期应当前生效：' + t);
      p.expect(/已过期/.test(t) && /内置/.test(t), '内置那期应标已过期');
    } },
  { name: 'p7b_sched_delete', root: WEB, q: 'now=2026-12-03T14:20', bridge: true, init: PRELOAD_1201,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('.sl-del'); await p.wait(150);
      p.expect(/删掉这一期/.test(await p.eval(`document.getElementById('schedList').textContent`)), '删除前应页面内确认');
      await p.wait(100);
      const shot = await p.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, 'p7b_sched_delete_confirm.png'), Buffer.from(shot.data, 'base64'));
      await p.clickSel('[data-sl="del-yes"]'); await p.wait(300);
      p.expect((await p.calls()).includes('del:p1201'), '删除应调 deletePoster(posterId)');
      p.expect(JSON.parse(await p.eval(`localStorage.getItem('lzm.schedules.v1')`)).length === 0, '存档里应删掉');
      p.expect(!(await p.eval(`document.getElementById('banner').hidden`)), '删掉后回到内置那期，应挂超期横幅');
    } },
  { name: 'p8_preview_360', root: WEB, q: 'now=2026-12-01T10:00', bridge: true, fix: true, vp: { w: 360, h: 760, dpr: 2, mobile: true },
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1201', 'p1201')); await p.wait(300);
      await p.eval(`document.getElementById(${cardId('惊天幻象')}).querySelector('[data-pv=edit]').click()`); await p.wait(150);
      await p.eval(scrollToCard('惊天幻象')); await p.wait(150);
      const over = await p.eval(`[...document.querySelectorAll('#imp *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5 && e.getClientRects().length).map((e) => e.className || e.tagName).slice(0, 5)`);
      p.expect(!over.length, '360 宽下有元素超出屏幕：' + over.join(','));
    } },
  { name: 'p8b_preview_360_top', root: WEB, q: 'now=2026-12-01T10:00', bridge: true, fix: true, vp: { w: 360, h: 760, dpr: 2, mobile: true },
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1201', 'p1201')); await p.wait(300);
    } },
  { name: 'p9_error', root: WEB, q: NOW, bridge: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(`LZM_onPosterProgress('decoding')`);
      await p.eval(`LZM_onPosterResult(JSON.stringify({ ok: false, error: 'decode_failed', message: 'BitmapFactory returned null' }))`); await p.wait(300);
      const t = await p.eval(impText);
      p.expect(/这张图片打不开/.test(t) && /别斜着拍/.test(t), '解码失败应给人话提示 + 拍摄建议');
      p.expect(!/BitmapFactory/.test(t), '技术细节只在 debug 下显示');
    } },
  { name: 'p9b_cancel_and_back', root: WEB, q: NOW, bridge: true, fix: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(`LZM_onPosterResult(JSON.stringify({ ok: false, error: 'cancelled', message: '' }))`); await p.wait(200);
      p.expect(await p.eval(`document.getElementById('imp').hidden && document.getElementById('toast').hidden`), '用户取消应静默返回');
      // 识别中按返回：关掉这一层，之后结果再来就删原图、不弹预览
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(`LZM_onPosterProgress('detecting')`); await p.wait(50);
      p.expect(await p.eval(`LZM_onBack()`) === true && await p.eval(`document.getElementById('imp').hidden`), '识别中返回键应先关导入层');
      await p.eval(result('p1124', 'late1')); await p.wait(200);
      p.expect(await p.eval(`document.getElementById('imp').hidden`) && (await p.calls()).includes('del:late1'), '取消后迟到的结果应丢弃并删原图');
      // 预览没改过：返回 = 放弃，删原图；改过：先问一句，再按一次返回收起问句
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1124', 'pv1')); await p.wait(300);
      await p.eval(`document.querySelector('.pv-card [data-pv=edit]').click()`); await p.wait(100);
      await p.eval(`(() => { const i = document.querySelector('.pv-card .pv-sub input'); i.value = '每天两场'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await p.wait(400);
      p.expect(await p.eval(`LZM_onBack()`) === true && await p.eval(`!document.getElementById('impBar').hidden`), '改过的预览按返回应先问要不要放弃');
      await p.wait(100);
      const shot = await p.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, 'p9b_discard_ask.png'), Buffer.from(shot.data, 'base64'));
      p.expect(await p.eval(`LZM_onBack()`) === true && await p.eval(`document.getElementById('impBar').hidden && !document.getElementById('imp').hidden`), '再按返回应只收起问句');
      await p.clickSel('#impDiscard'); await p.wait(100);
      await p.clickSel('#impBar [data-imp="discard-yes"]'); await p.wait(200);
      p.expect(await p.eval(`document.getElementById('imp').hidden`) && (await p.calls()).includes('del:pv1'), '放弃应关掉并删原图');
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1124', 'pv2')); await p.wait(300);
      await p.clickSel('#impLook'); await p.wait(400);
      p.expect(await p.eval(`!document.getElementById('poster').hidden`), '「对照原图」应打开原图');
      p.expect(await p.eval(`LZM_onBack()`) === true && await p.eval(`document.getElementById('poster').hidden && !document.getElementById('imp').hidden`), '返回键应先关原图、留在预览');
      p.expect(await p.eval(`LZM_onBack()`) === true && await p.eval(`document.getElementById('imp').hidden`) && (await p.calls()).includes('del:pv2'), '没改过的预览返回 = 放弃');
    } },
  { name: 'p10_look_focus', root: WEB, q: NOW, bridge: true, fix: true,
    act: async (p) => {
      await p.clickSel('#fabSettings'); await p.wait(200);
      await p.clickSel('#impCam'); await p.wait(50);
      await p.eval(result('p1124', 'p1124')); await p.wait(300);
      await p.eval(`document.getElementById(${cardId('惊天幻象')}).querySelector('[data-pv=look]').click()`); await p.wait(700);
      // 魔术秀那两行在原图 y 1035–1134：放大到比整图适配大，而且这两行整个落在屏幕里
      const v = await p.eval(`(() => { const w = document.getElementById('posterWorld'), s = parseFloat(w.style.width) / 1080,
        ty = +/translate3d\\([^,]+,\\s*([-\\d.]+)px/.exec(w.style.transform)[1]; return { s, top: ty + 1035 * s, bottom: ty + 1134 * s, fit: Math.min(innerWidth / 1080, innerHeight / 1920) }; })()`);
      p.expect(v.s > v.fit * 1.05 && v.top >= 0 && v.bottom <= H, '对照原图应框住魔术秀那两行：' + JSON.stringify(v));
    } },
  { name: 'p11_switch_active', root: WEB, q: 'now=2026-12-03T14:20', bridge: true, init: PRELOAD_1201,
    act: async (p) => {
      p.expect(await p.eval(`document.getElementById('banner').hidden`), '12/03 有覆盖它的导入期，不该挂横幅');
      // 12/01 那期里综艺秀剧场换成了没选剧场的新节目：换期后标记要跟着重建，这个剧场不再上图
      p.expect(await p.eval(`!document.querySelector('.mk[data-venue="variety"]') && !!document.querySelector('.mk[data-venue="magic"]')`), '换期后剧场标记应按新一期重建');
      await p.dragSel('#sheetHead', 0, -700); await p.wait(500);
      await p.eval(`document.getElementById('sheetBody').scrollTop = 99999`); await p.wait(200);
      p.expect(/12月1日版本/.test(await p.eval(`document.getElementById('sheetBody').textContent`)), '页脚数据来源应换成 12 月 1 日版本');
    } },
  { name: 'p11b_out_of_range', root: WEB, q: 'now=2026-12-10T14:20', bridge: true, init: PRELOAD_1201,
    act: async (p) => {
      const b = await p.eval(`document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent`);
      p.expect(/^已超出有效期：时间表只覆盖 12\/1/.test(b), '12/10 应用 12/01 那期并挂超期横幅：' + b);
      await p.clickSel('#fabPoster'); await p.wait(300);
      p.expect(/img\/schedule\.jpg$/.test(await p.eval(`document.getElementById('posterImg').src`)), '海报按钮应显示生效那期的 posterUrl');
      p.expect(await p.eval(`document.getElementById('posterMark').hidden`), '从海报按钮打开时不该有对照框');
      await p.eval(`LZM_onBack()`); await p.wait(200);
    } },
  { name: 'p11c_midnight', root: WEB, q: 'now=2026-11-30T23:59:58', bridge: true, init: PRELOAD_1201,
    act: async (p) => {
      p.expect(await p.eval(`document.getElementById('banner').hidden`), '11-30 内置那期仍覆盖，不挂横幅');
      await p.wait(2600);
      await p.eval(`document.dispatchEvent(new Event('visibilitychange'))`); await p.wait(200);
      await p.clickSel('#fabSettings'); await p.wait(200);
      p.expect(/12\/01–12\/07当前生效/.test((await p.eval(`document.getElementById('schedList').textContent`)).replace(/\s/g, '')), '过了零点应自动换到 12/01 那期');
    } },
];

// ── 极简 CDP 客户端 ─────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 端口让 Chrome 自己挑（--remote-debugging-port=0），再从配置目录的 DevToolsActivePort 读出来：
// 写死的端口会撞上别人的 adb forward（2026-11-26 就撞过 9333），撞了 Chrome 只听 [::1]，连不上也不报错。
async function connect(prof) {
  const portFile = path.join(prof, 'DevToolsActivePort');
  for (let i = 0; i < 60; i++) {
    try {
      const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* Chrome 还没起来 */ }
    await sleep(200);
  }
  throw new Error('连不上无头 Chrome');
}

class Page {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; this.logs = []; this.fails = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        this.onEvent(m);
        this.listeners.forEach((f) => f(m));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  onEvent(m) {
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) {
      this.logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      this.logs.push('exception: ' + (d.exception && d.exception.description || d.text) + ' @' + d.url + ':' + d.lineNumber);
    } else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
      this.logs.push('log.' + m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  }
  once(method) { return new Promise((res) => { const f = (m) => { if (m.method === method) { this.listeners.splice(this.listeners.indexOf(f), 1); res(m); } }; this.listeners.push(f); }); }
  wait(ms) { return sleep(ms); }
  expect(cond, msg) { if (!cond) this.fails.push(msg); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval 失败：' + expr.slice(0, 80) + ' → ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  chip() { return this.eval(`document.getElementById('locText').textContent`); }
  calls() { return this.eval(`window.AndroidBridge ? window.AndroidBridge.calls.slice() : []`); }
  async scale() { return +(await this.eval(`(parseFloat(document.getElementById('world').style.width) / 1280).toFixed(3)`)); }
  async rect(sel) {
    const r = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!r) throw new Error('找不到元素 ' + sel);
    return r;
  }
  async clickSel(sel) {
    const r = await this.rect(sel);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    }
  }
  async touch(type, points) {
    await this.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) });
  }
  async tapSel(sel) {
    const r = await this.rect(sel);
    await this.touch('touchStart', [[r.x, r.y]]);
    await this.wait(40);
    await this.touch('touchEnd', []);
  }
  async drag(x, y, dx, dy) {
    await this.touch('touchStart', [[x, y]]);
    for (let i = 1; i <= 12; i++) { await this.touch('touchMove', [[x + dx * i / 12, y + dy * i / 12]]); await this.wait(16); }
    await this.wait(150); // 停一下再松手，模拟「拖到位放下」而不是甩
    await this.touch('touchEnd', []);
  }
  async dragSel(sel, dx, dy) { const r = await this.rect(sel); await this.drag(r.x, r.y, dx, dy); }
  async pinch(cx, cy, d0, d1) {
    await this.touch('touchStart', [[cx - d0 / 2, cy], [cx + d0 / 2, cy]]);
    for (let i = 1; i <= 14; i++) {
      const d = d0 + (d1 - d0) * i / 14;
      await this.touch('touchMove', [[cx - d / 2, cy], [cx + d / 2, cy]]);
      await this.wait(16);
    }
    await this.touch('touchEnd', []);
  }
}

async function main() {
  const only = process.argv.slice(2);
  fs.mkdirSync(OUT, { recursive: true });
  writeSandbox();
  const prof = path.join(OUT, '..', 'chrome-prof');
  // 整个 profile 每次重建：⚠️ 只删 DevToolsActivePort 不够——上一轮最后的 localStorage.clear()
  // 来不及落盘 Chrome 就被 kill 了，「已看过须知」会漏进下一轮，首张须知卡截出来是空的。
  fs.rmSync(prof, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0',
    `--user-data-dir=${prof}`, '--no-first-run', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  let failed = 0, ran = 0;
  try {
    const ws = new WebSocket(await connect(prof));
    await new Promise((r) => ws.addEventListener('open', r));
    const p = new Page(ws);
    await p.send('Page.enable'); await p.send('Runtime.enable'); await p.send('Log.enable');

    // 假原生壳：记下页面调了哪些原生方法；顺手把 geolocation 换成告密的，证明有壳时页面没去碰它。
    // 海报导入三件：ocrAvailable 恒真；pickPoster / deletePoster 只记账，结果由场景自己调 LZM_onPosterResult 喂。
    const BRIDGE_JS = `window.AndroidBridge = { calls: [],
      requestLocationPermission() { this.calls.push('perm'); }, openLocationSettings() { this.calls.push('settings'); },
      setKeepScreenOn(b) { this.calls.push('keep:' + b); },
      ocrAvailable() { return true; }, pickPoster(s) { this.calls.push('pick:' + s); }, deletePoster(id) { this.calls.push('del:' + id); } };
      navigator.geolocation.watchPosition = function () { window.__geoCalled = true; return 0; };`;
    // 除了专门截须知卡的场景，其余都当「看过须知」，免得每张图都被卡片挡住。
    const NOTICE_SEEN_JS = `try { localStorage.setItem('lzm.notice.v1', '1'); } catch (e) {}`;

    for (const sc of SCENES) {
      if (only.length && !only.some((o) => sc.name.startsWith(o))) continue;
      ran++;
      p.logs = []; p.fails = [];
      const vp = sc.vp || { w: W, h: H, dpr: DPR, mobile: true };
      await p.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.dpr, mobile: vp.mobile });
      await p.send('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile, maxTouchPoints: 5 });
      const injected = [];
      if (sc.bridge) injected.push(await p.send('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE_JS }));
      if (sc.fix) injected.push(await p.send('Page.addScriptToEvaluateOnNewDocument', { source: FIX_JS }));
      if (sc.init) injected.push(await p.send('Page.addScriptToEvaluateOnNewDocument', { source: sc.init }));
      if (!sc.freshNotice) injected.push(await p.send('Page.addScriptToEvaluateOnNewDocument', { source: NOTICE_SEEN_JS }));
      if (sc.geo) {
        await p.send('Browser.grantPermissions', { permissions: ['geolocation'] });
        await p.send('Emulation.setGeolocationOverride', { latitude: sc.geo.lat, longitude: sc.geo.lon, accuracy: 12 });
      } else {
        await p.send('Browser.resetPermissions');
        await p.send('Emulation.clearGeolocationOverride');
      }
      const loaded = p.once('Page.loadEventFired');
      await p.send('Page.navigate', { url: url(sc.root, sc.q) });
      await loaded;
      await p.wait(500);
      try { if (sc.act) await sc.act(p); } catch (e) { p.fails.push('脚本出错：' + e.message); }
      await p.wait(250);
      const wrapped = await p.eval(WRAP_JS);
      p.expect(!wrapped.length, '时间折行了：' + wrapped.join('；'));
      const shot = await p.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, sc.name + '.png'), Buffer.from(shot.data, 'base64'));
      const info = await p.eval(`JSON.stringify({ s: +(parseFloat(document.getElementById('world').style.width) / 1280).toFixed(3), sheet: document.getElementById('sheet').style.height, chip: document.getElementById('locText').textContent, me: !document.getElementById('me').hidden, alert: document.getElementById('alert').hidden ? '' : document.getElementById('alertText').textContent })`);
      for (const inj of injected) await p.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
      await p.eval('localStorage.clear()');
      const errs = p.logs.filter((l) => !l.startsWith('warning') && !l.startsWith('log.warning'));
      if (errs.length || p.fails.length) failed++;
      console.log(`${sc.name.padEnd(24)} ${info}${p.logs.length ? '\n   ' + p.logs.join('\n   ') : ''}` +
        (p.fails.length ? '\n   FAIL ' + p.fails.join('\n   FAIL ') : ''));
    }
    ws.close();
  } finally {
    chrome.kill();
  }
  console.log(failed ? `\n${failed}/${ran} 个场景有控制台报错或断言失败` : `\n${ran} 个场景：控制台零报错，交互断言全过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
