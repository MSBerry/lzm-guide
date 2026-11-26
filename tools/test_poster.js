/*
 * poster.js 验收 + 单测。素材不是编的：
 *   fixtures/poster-1124.ocr.json      同一套 PP-OCRv4 mobile 模型对原海报 web/img/schedule.jpg 的识别结果；
 *   fixtures/perturbed/*.ocr.json      对海报副本做旋转 / 透视 / 缩小 / JPEG 压缩后再识别（扰动方式写在各文件 perturb 字段），
 *                                      其中 hard-* 三份超出需求给的扰动强度（模糊、缩到一半再压到 q40），专门用来逼出认错。
 * 期望值一律取 web/data/schedule.js（11/24 版逐条手录），按天比实际场次，不比规则结构：同一意思可以有不同写法。
 *
 * 跑法：node tools/test_poster.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
const FIX = path.join(__dirname, 'fixtures');
const L = require(path.join(WEB, 'logic.js'));
const P = require(path.join(WEB, 'poster.js'));

const box = { window: {} };
for (const f of ['schedule.js', 'venues.js']) vm.runInNewContext(fs.readFileSync(path.join(WEB, 'data', f), 'utf8'), box);
const SCHED = box.window.LZM_SCHEDULE, VENUES = box.window.LZM_VENUES;
const OPTS = { today: '2026-11-26', knownShows: SCHED.shows, venues: VENUES };
const DAYS = P.daysOf('2026-11-24', '2026-11-30');
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const REF = load(path.join(FIX, 'poster-1124.ocr.json'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || '') + ' 期望 ' + sb + '，实际 ' + sa);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const sessions = (show, d) => L.daySessions(show, d).sessions.map((s) => [s.startHM, s.endHM, s.note]);
const warns = (r, pred) => r.issues.filter((x) => x.level === 'warn' && (!pred || pred(x)));
const clone = (o) => JSON.parse(JSON.stringify(o));
const findShow = (r, id) => r.schedule.shows.find((s) => s.id === id);

/**
 * 按天逐个节目比对：返回 [{ id, days:[…], flagged }]。flagged = 这个节目身上挂了 warn，
 * 或者整期有「上一期有、本期没有」的 warn 点了它的名。
 */
function compare(r) {
  const out = [];
  for (const ks of SCHED.shows) {
    const idx = r.schedule.shows.findIndex((s) => s.id === ks.id);
    const ps = r.schedule.shows[idx];
    const bad = ps ? DAYS.filter((d) => JSON.stringify(sessions(ks, d)) !== JSON.stringify(sessions(ps, d))) : DAYS.slice();
    if (!bad.length) continue;
    const name = L.showTitle(ks);
    const flagged = ps ? warns(r, (x) => x.show === idx).length > 0
      : warns(r, (x) => x.code === 'show_missing' && x.msg.includes(name)).length > 0;
    out.push({ id: ks.id, days: bad, flagged });
  }
  // 多出来的节目（认坏了名字被当成新节目）：要么自己挂着 warn，要么有对应的「本期没有」warn
  r.schedule.shows.forEach((s, i) => {
    if (SCHED.shows.some((k) => k.id === s.id)) return;
    const flagged = warns(r, (x) => x.show === i).length > 0 || warns(r, (x) => x.code === 'show_missing').length > 0;
    out.push({ id: s.id + '(多出)', days: [], flagged });
  });
  return out;
}

console.log('— 核心：原海报 OCR 逐日逐场与 schedule.js 一致');

const R = P.parsePoster(REF, OPTS);

test('有效期 2026-11-24 至 2026-11-30，版本含「11月24日」', () => {
  eq(R.schedule.validFrom, '2026-11-24'); eq(R.schedule.validTo, '2026-11-30');
  ok(R.schedule.version.includes('11月24日'), R.schedule.version);
});
test('节目一一对上：17 个、id 全是 schedule.js 里的、没有多出来的', () => {
  eq(R.schedule.shows.length, SCHED.shows.length);
  eq(R.schedule.shows.map((s) => s.id).sort(), SCHED.shows.map((s) => s.id).sort());
});
// 这一条就是验收线：每天、每个节目、每一场的起止和场次备注都要一字不差。
test('11-24 至 11-30 每天每个节目的场次（起止 + 备注）完全一致', () => {
  const bad = [];
  for (const ks of SCHED.shows) {
    const ps = findShow(R, ks.id);
    for (const d of DAYS) {
      const a = JSON.stringify(sessions(ks, d)), b = JSON.stringify(sessions(ps, d));
      if (a !== b) bad.push(ks.id + ' ' + d + '\n        期望 ' + a + '\n        实际 ' + b);
    }
  }
  ok(!bad.length, bad.length + ' 处不一致：\n      ' + bad.join('\n      '));
});
// 解析全对时不该有误报：warn 一多，预览页的黄条就没人看了。
test('原海报解析全对时 0 条 warn', () => eq(warns(R).map((x) => x.msg), []));
test('连续开放 / 区域 / 剧场 / 标签 / 编号沿用上一期', () => {
  for (const ks of SCHED.shows) {
    const ps = findShow(R, ks.id);
    eq(!!ps.continuous, !!ks.continuous, ks.id + ' continuous');
    eq(ps.area || null, ks.area || null, ks.id + ' area');
    eq(ps.venueId, ks.venueId, ks.id + ' venueId');
    eq((ps.tags || []).slice().sort(), (ks.tags || []).slice().sort(), ks.id + ' tags');
    eq(ps.no == null ? null : ps.no, ks.no == null ? null : ks.no, ks.id + ' no');
  }
});
test('提示语、电话从页脚认出来', () => {
  ok(/因天气原因或运营调整/.test(R.schedule.notice), R.schedule.notice);
  eq(R.schedule.phone, '4006177878');
});
// 规则口径（schedule.js 文件头）：公休最前、加场日期规则在默认之前。
test('魔术秀规则顺序：公休 → 26–28 加场 → 默认', () => {
  const r = findShow(R, 'magic').rules;
  eq(r.length, 3);
  eq(r[0], { dates: ['2026-11-24'], closed: true });
  eq(r[1].dates, ['2026-11-26', '2026-11-27', '2026-11-28']); eq(r[1].times.length, 6);
  ok(!r[2].dates && !r[2].weekdays && r[2].times.length === 4, JSON.stringify(r[2]));
});
// 「全部子行都带日期」的节目要补 closed 默认：猪猪侠两行都带日期，有效期外的日子就不演。
test('猪猪侠两行都带日期 → 补一条 {closed:true} 默认', () => {
  const r = findShow(R, 'kids').rules;
  eq(r[r.length - 1], { closed: true });
  eq(L.daySessions(findShow(R, 'kids'), '2026-12-01').closed, true);
});
test('冰雪世界「日常 / 周五周六」→ weekdays 规则 + 默认', () => {
  const r = findShow(R, 'snow').rules;
  eq(r, [{ weekdays: [5, 6], times: [['10:00', '20:30']] }, { times: [['10:00', '17:30']] }]);
});
test('地点：音乐广场 → venueId music；单独收费角标、（雨天停演）进 tags', () => {
  eq(findShow(R, 'tangyi').venueId, 'music');
  ok(findShow(R, 'xishi').tags.includes('单独收费'));
  ok(findShow(R, 'xishi').tags.includes('雨天停演'));
  ok(findShow(R, 'zoo').tags.includes('雨天部分停演'));
});
test('推荐必看段 → continuous 节目，清单 14 项按列读', () => {
  const s = findShow(R, 'street');
  eq(s.continuous, true); eq(s.items.length, 14);
  eq(s.items[0], '大巡游《宋韵国风》'); eq(s.items[7], '互动游戏《步步为赢》');
});
test('红条提醒挂给铁花秀', () => ok(/气象预警/.test(findShow(R, 'ironflower').note), findShow(R, 'ironflower').note));

console.log('— 扰动版：要么全对，要么错的地方一定有 warn');

const PERT = path.join(FIX, 'perturbed');
const pertFiles = fs.existsSync(PERT) ? fs.readdirSync(PERT).filter((f) => f.endsWith('.json')).sort() : [];
test('扰动 fixture 至少 8 份', () => ok(pertFiles.length >= 8, '只有 ' + pertFiles.length + ' 份'));
const pertSummary = [];
for (const f of pertFiles) {
  const ocr = load(path.join(PERT, f));
  const r = P.parsePoster(ocr, OPTS);
  const diff = compare(r);
  const silent = diff.filter((d) => !d.flagged);
  const state = !diff.length ? '全对' : silent.length ? '漏报' : '有错但都报了';
  pertSummary.push(f.replace(/^poster-1124-|\.ocr\.json$/g, '') + '：' + state + (diff.length ? '（错 ' + diff.length + ' 个节目，warn ' + warns(r).length + ' 条）' : ''));
  test(f + '（' + (ocr.perturb || '') + '）→ ' + state, () => {
    eq(r.schedule.validFrom, '2026-11-24'); eq(r.schedule.validTo, '2026-11-30');
    ok(!silent.length, '错了却没报：' + silent.map((d) => d.id + ' ' + d.days.join(',')).join('；'));
  });
  // 需求给的那几种扰动（不带 hard- 前缀）要求全对
  if (!/hard-/.test(f)) test(f + ' 在需求给的扰动强度内应全对', () => ok(!diff.length, diff.map((d) => d.id).join(',')));
}

console.log('— 篡改原 fixture：认错一位数也要被报出来');

function tamper(fn) { const o = clone(REF); fn(o.lines); return P.parsePoster(o, OPTS); }
function lineOf(lines, text) { const l = lines.find((x) => x.text === text); if (!l) throw new Error('fixture 里没有「' + text + '」'); return l; }
const idxOf = (r, id) => r.schedule.shows.findIndex((s) => s.id === id);

// 结束时间认错一位、置信度照样高：只能靠「同一节目每场时长一样」抓出来。
test('冰秀 13:50 认成 13:58（置信度 0.97）→ 时长不一致 warn', () => {
  const r = tamper((ls) => { const l = lineOf(ls, '13:15-13:50/15:20-15:55/18:20-18:55'); l.text = '13:15-13:58/15:20-15:55/18:20-18:55'; });
  ok(warns(r, (x) => x.code === 'duration_odd' && x.show === idxOf(r, 'ice')).length, JSON.stringify(warns(r)));
});
test('「每天四场」与认出的场次数不符 → count_mismatch warn', () => {
  const r = tamper((ls) => { ls.splice(ls.indexOf(lineOf(ls, '18:15-19:00')), 1); });
  const w = warns(r, (x) => x.code === 'count_mismatch' && x.show === idxOf(r, 'kids'));
  ok(w.length && /每天 5 场/.test(w[0].msg), JSON.stringify(warns(r)));
});
test('场次不递增 / 结束早于开始 → time_order warn', () => {
  const r = tamper((ls) => { lineOf(ls, '12:45-13:45/16:45-17:45/19:15-20:15').text = '12:45-13:45/19:15-20:15/16:45-17:45'; });
  ok(warns(r, (x) => x.code === 'time_order' && x.show === idxOf(r, 'kungfu')).length);
  const r2 = tamper((ls) => { lineOf(ls, '20:20-21:20（雨天停演）').text = '20:20-12:20（雨天停演）'; });
  ok(warns(r2, (x) => x.code === 'time_order' && /结束早于开始/.test(x.msg)).length, JSON.stringify(warns(r2)));
});
test('时间框置信度 < 0.85 → low_conf warn 挂在那个节目上', () => {
  const r = tamper((ls) => { lineOf(ls, '12:00-12:40/14:30-15:10/16:45-17:25').score = 0.8; });
  ok(warns(r, (x) => x.code === 'low_conf' && x.show === idxOf(r, 'variety')).length);
});
test('认坏的时间「16:30-1710」→ 没看懂 warn，不是悄悄少一场', () => {
  const r = tamper((ls) => { lineOf(ls, '16:30-17:10/17:40-18:20').text = '16:30-1710/17:40-18:20'; });
  ok(warns(r, (x) => x.code === 'time_bad' && x.show === idxOf(r, 'magic')).length, JSON.stringify(warns(r)));
});
test('场次备注认错一个字（低空 → 做空）→ note_diff warn', () => {
  const r = tamper((ls) => { lineOf(ls, '（含打铁花+低高空烟花）').text = '（含打铁花+做高空烟花）'; });
  ok(warns(r, (x) => x.code === 'note_diff' && x.show === idxOf(r, 'ironflower')).length, JSON.stringify(warns(r)));
});
test('节目改名（认不出是谁）→ 新节目 venueId=null + no_venue warn，旧的报「本期没有」', () => {
  const r = tamper((ls) => { lineOf(ls, '综艺秀《梦幻钻石》').text = '综艺秀《星光大道》'; });
  const s = r.schedule.shows.find((x) => x.title === '星光大道');
  ok(s && s.venueId === null && /^new/.test(s.id), JSON.stringify(s));
  ok(warns(r, (x) => x.code === 'no_venue' && x.show === r.schedule.shows.indexOf(s)).length);
  ok(warns(r, (x) => x.code === 'show_missing' && x.msg.includes('梦幻钻石')).length);
});
test('上一期有、本期整行没了 → show_missing warn', () => {
  const r = tamper((ls) => {
    ['大型旅游演艺', '《醉美太湖》', '②', '14:00-15:05/16:15-17:20/18:55-20:00'].forEach((t) => ls.splice(ls.indexOf(lineOf(ls, t)), 1));
    ls.splice(ls.findIndex((l) => l.text === '每天三场' && l.box[0][1] > 890 && l.box[0][1] < 910), 1);
  });
  ok(warns(r, (x) => x.code === 'show_missing' && x.msg.includes('醉美太湖')).length, JSON.stringify(warns(r)));
});
// 表头三个字被反光盖住认不出来时，列分界改按「右边同一行有时间框的日期框」去猜。
test('表头「演出名称 / 日期 / 备注」都没认出来 → 按内容猜列，仍逐日一致', () => {
  const r = tamper((ls) => { ['演出名称', '日期', '备注'].forEach((t) => ls.splice(ls.indexOf(lineOf(ls, t)), 1)); });
  eq(compare(r).map((d) => d.id), []);
  ok(r.issues.some((x) => x.code === 'no_header'));
});
// 没有上一期可对照时（knownShows 为空），「地点：XX」仍要映射到剧场。
test('不给 knownShows：地点映射 venueId，其余新节目报缺剧场；园区其他区域只给 info', () => {
  const r = P.parsePoster(REF, { today: '2026-11-26', knownShows: [], venues: VENUES });
  const tangyi = r.schedule.shows.find((s) => s.kind === '龙之梦唐艺大舞台');
  eq(tangyi.venueId, 'music');
  const circus = r.schedule.shows.find((s) => s.kind === '龙之梦大马戏');
  eq(circus.area, 'other');
  ok(!warns(r, (x) => x.code === 'no_venue' && x.show === r.schedule.shows.indexOf(circus)).length, '园区其他区域不该要剧场');
  ok(warns(r, (x) => x.code === 'no_venue').length >= 10);
  // 新节目也要自己推出 continuous：冰雪世界、动物世界每天一个长时段
  eq(!!r.schedule.shows.find((s) => s.kind === '冰雪世界演艺').continuous, true);
  eq(!!r.schedule.shows.find((s) => s.kind === '综艺秀').continuous, false);
});

console.log('— 单元：标题 / 日期 / 时间写法');

test('标题「11月24日至30日」', () => eq(P.parseValidity('11月24日至30日', '2026-11-26'), { from: '2026-11-24', to: '2026-11-30' }));
test('跨月「11月30日至12月6日」', () => eq(P.parseValidity('11月30日至12月6日', '2026-11-26'), { from: '2026-11-30', to: '2026-12-06' }));
// 12 月底导入下一年 1 月的海报：年份要落到明年，而不是今年 1 月。
test('跨年：12-28 导入「1月1日至7日」→ 2027', () => eq(P.parseValidity('1月1日至7日', '2026-12-28'), { from: '2027-01-01', to: '2027-01-07' }));
test('跨年区间「12月29日-1月4日」', () => eq(P.parseValidity('12月29日-1月4日', '2026-12-20'), { from: '2026-12-29', to: '2027-01-04' }));
test('全角数字和波浪线「１１月２４日～３０日」', () => eq(P.parseValidity('１１月２４日～３０日', '2026-11-26'), { from: '2026-11-24', to: '2026-11-30' }));
test('1 月初看到上一年 12 月底的海报 → 去年', () => eq(P.parseValidity('12月29日至31日', '2027-01-02'), { from: '2026-12-29', to: '2026-12-31' }));
test('认不出的标题返回 null', () => eq(P.parseValidity('11月演艺时间安排', '2026-11-26'), null));

const CTX = { from: '2026-11-24', to: '2026-11-30' };
const pd = (t, ctx) => { const d = P.parseDateText(t, ctx || CTX); return { count: d.count, dates: d.dates, closed: d.closed, weekdays: d.weekdays, bad: d.bad }; };
test('「每天四场 11月24日公休」', () => eq(pd('每天四场 11月24日公休'), { count: 4, dates: [], closed: ['2026-11-24'], weekdays: null, bad: [] }));
test('「11月26日至28日」「11月26日-28日」区间', () => {
  eq(pd('11月26日至28日').dates, ['2026-11-26', '2026-11-27', '2026-11-28']);
  eq(pd('11月26日-28日').dates, ['2026-11-26', '2026-11-27', '2026-11-28']);
});
test('「11月24日/30日」列表、「11月24日至26日 11月30日」两段并起来', () => {
  eq(pd('11月24日/30日').dates, ['2026-11-24', '2026-11-30']);
  eq(pd('11月24日至26日 11月30日').dates, ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-30']);
});
// OCR 把连字符认成汉字「一」、日期前后夹空格，都得照样读。
test('「26日一28日」（连字符认成一）、「11月24日 公休」（中间断开）', () => {
  eq(pd('11月26日一28日').dates, ['2026-11-26', '2026-11-27', '2026-11-28']);
  eq(pd('11月24日 公休').closed, ['2026-11-24']);
});
test('跨月区间「11月30日至12月2日」', () => eq(pd('11月30日至12月2日', { from: '2026-11-30', to: '2026-12-06' }).dates, ['2026-11-30', '2026-12-01', '2026-12-02']));
test('中文数字：每天两场 / 每天十二场', () => { eq(pd('每天两场').count, 2); eq(pd('每天十二场').count, 12); eq(P.cnNum('二十一'), 21); });
test('周五/周六、周一至周五、周末', () => {
  eq(pd('周五/周六').weekdays, [5, 6]); eq(pd('周一至周五').weekdays, [1, 2, 3, 4, 5]); eq(pd('周末').weekdays, [0, 6]);
});
test('看不懂的日期报出来（「11月24日公体」）', () => ok(pd('11月24日公体').bad.length));

const pt = (t) => P.parseTimeText(t);
test('时间：全角冒号、—、～、／都认', () => eq(pt('14：00—15：25／19：00～20：25').lines[0].times, [['14:00', '15:25'], ['19:00', '20:25']]));
test('时间：连字符认成「一」、0 认成 O、多余空格', () => eq(pt('16:30一17:10 / 1O:40 - 11:2O').lines[0].times, [['16:30', '17:10'], ['10:40', '11:20']]));
test('时间：括号备注进第三项，「含」字省掉', () => eq(pt('19:18-19:33（含打铁花+低空烟花）').lines[0].times, [['19:18', '19:33', '打铁花+低空烟花']]));
test('时间：标签分段「日常 …；周五/周六 …」', () => {
  const r = pt('日常 10:00-17:30；周五/周六 10:00-20:30');
  eq(r.lines.map((l) => l.label), ['default', [5, 6]]);
});
test('时间：缺位的「15:20-1555」报没看懂，不吞', () => ok(pt('13:15-13:50/15:20-1555').lines[0].bad.length));
test('时间：不带括号的剩字也报，不收成备注', () => ok(pt('10:00-11:00 加演').lines[0].bad.length));

console.log('— 草稿编辑：改子行文本后重建');

test('改一行场次文本 → 规则跟着变，这一行的 OCR 提醒清掉', () => {
  const r = tamper((ls) => { lineOf(ls, '12:00-12:40/14:30-15:10/16:45-17:25').score = 0.8; });
  const d = r.draft, si = d.shows.findIndex((s) => s.known === 'variety');
  d.shows[si].subs[0].timeText = '12:00-12:40 / 14:30-15:10';
  d.shows[si].subs[0].edited = true;
  const r2 = P.rebuild(d, OPTS);
  eq(sessions(r2.schedule.shows[si], '2026-11-25').length, 2);
  ok(warns(r2, (x) => x.show === si && x.code === 'count_mismatch').length, '改成两场应报「海报写每天 3 场」');
  ok(!warns(r2, (x) => x.show === si && x.code === 'low_conf').length, '人改过的行不再报低置信度');
});
test('改适用日期 → 加场日期跟着变', () => {
  const d = clone(R.draft), si = d.shows.findIndex((s) => s.known === 'magic');
  d.shows[si].subs[1].dateText = '11月29日至30日 每天六场';
  const r2 = P.rebuild(d, OPTS);
  eq(sessions(r2.schedule.shows[si], '2026-11-30').length, 6);
  eq(sessions(r2.schedule.shows[si], '2026-11-27').length, 4);
});
test('新节目选了「不在地图上」→ 不再报缺剧场', () => {
  const r = tamper((ls) => { lineOf(ls, '综艺秀《梦幻钻石》').text = '综艺秀《星光大道》'; });
  const si = r.draft.shows.findIndex((s) => s.title === '星光大道');
  r.draft.shows[si].venueChosen = true;
  ok(!warns(P.rebuild(r.draft, OPTS), (x) => x.code === 'no_venue').length);
});
test('有效期改反 → warn', () => {
  const d = clone(R.draft); d.meta.validFrom = '2026-12-01'; d.meta.validTo = '2026-11-28';
  ok(warns(P.rebuild(d, OPTS), (x) => x.code === 'validity_bad').length);
});

console.log('— 与上一期对比、按天分组');

test('同一张海报对内置那期：没有新增、没有缺、没有变化', () => {
  const df = P.diffSchedules(SCHED, R.schedule);
  eq([df.added.length, df.removed.length, df.changed.length], [0, 0, 0]);
});
test('改一场时间 → changed 里给出多了 / 少了哪个时段', () => {
  const d = clone(R.draft), si = d.shows.findIndex((s) => s.known === 'kungfu');
  d.shows[si].subs[0].timeText = '12:45-13:45 / 16:45-17:45 / 19:30-20:30';
  const df = P.diffSchedules(SCHED, P.rebuild(d, OPTS).schedule);
  eq(df.changed.map((c) => [c.show.id, c.plus, c.minus]), [['kungfu', ['19:30–20:30'], ['19:15–20:15']]]);
});
test('魔术秀按天分组：24 公休 / 25、29、30 四场 / 26–28 六场', () => {
  const s = findShow(R, 'magic'), si = R.schedule.shows.indexOf(s);
  const g = P.dayGroups(s, '2026-11-24', '2026-11-30', R.views[si].ruleSub);
  eq(g.map((x) => [x.days.map((d) => +d.slice(8)), x.closed ? 0 : x.sessions.length]), [[[24], 0], [[25, 29, 30], 4], [[26, 27, 28], 6]]);
  eq(g[2].subs, [1]);
});

console.log('— 多期自动切换（logic.pickSchedule）');

const mk = (from, to, id) => ({ validFrom: from, validTo: to, shows: [], id });
const E = (id, from, to, at) => ({ id, importedAt: at, schedule: mk(from, to, id) });
test('只有内置：有效期内用它、不超期', () => {
  const p = L.pickSchedule(SCHED, [], '2026-11-26'); eq(p.entry, null); eq(p.outOfRange, false);
});
test('导入的覆盖今天 → 用导入的；内置也覆盖时导入的优先', () => {
  const e = E('a', '2026-11-24', '2026-11-30', 100);
  eq(L.pickSchedule(SCHED, [e], '2026-11-26').entry.id, 'a');
});
test('多期都覆盖 → 取最后导入的', () => {
  const a = E('a', '2026-12-01', '2026-12-07', 100), b = E('b', '2026-11-30', '2026-12-06', 200);
  eq(L.pickSchedule(SCHED, [b, a], '2026-12-02').entry.id, 'b');
  eq(L.pickSchedule(SCHED, [a, b], '2026-12-07').entry.id, 'a');
});
// 跨零点：11-30 23:59 还是内置那期，12-01 00:00 就换成 12/01 那期。
test('跨零点自动换期', () => {
  const a = E('a', '2026-12-01', '2026-12-07', 100);
  eq(L.pickSchedule(SCHED, [a], L.ymd(L.parseLocalDateTime('2026-11-30T23:59'))).entry, null);
  eq(L.pickSchedule(SCHED, [a], L.ymd(L.parseLocalDateTime('2026-12-01T00:00'))).entry.id, 'a');
});
test('都不覆盖 → 取开始日 ≤ 今天里最新的一期，标超期', () => {
  const a = E('a', '2026-12-01', '2026-12-07', 100), b = E('b', '2026-12-15', '2026-12-21', 50);
  const p = L.pickSchedule(SCHED, [a, b], '2026-12-10');
  eq(p.entry.id, 'a'); eq(p.outOfRange, true);
});
test('今天早于所有期 → 取最早开始的那期，标超期', () => {
  const p = L.pickSchedule(SCHED, [E('a', '2026-12-01', '2026-12-07', 100)], '2026-11-20');
  eq(p.entry, null); eq(p.outOfRange, true);
});
test('存档里的坏条目跳过，不抛', () => {
  const p = L.pickSchedule(SCHED, [null, {}, { schedule: { validFrom: '2026-11-26' } }], '2026-11-26');
  eq(p.entry, null);
});

console.log('\n扰动版：\n  ' + pertSummary.join('\n  '));
console.log('\n' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
