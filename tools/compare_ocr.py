"""按框 IoU 把两份 OCR 结果逐行配对，报行数、文本一致率与不一致的行。

用法：python tools/compare_ocr.py [基准.json] [待比.json]
默认基准 tools/fixtures/poster-1124.ocr.json（Python RapidOCR），待比 tools/fixtures/poster-1124.android.json（真机）。

验收口径：
- 所有含「数字:数字-数字:数字」的时间行逐字一致（冒号认半角和全角：端上把 : 认成 ：也要算进来、算作不一致）；
- 整体文本一致率 ≥ 95%：基准里每一行，配上了且文字完全相同才算一致，分母是基准行数（漏检也算不一致）。
两条都达标退出码 0，否则 1。
"""
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TIME_RE = re.compile(r'\d+[:：]\d+\s*-\s*\d+[:：]\d+')
# 配对门槛：两边框都是同一套检测出来的，同一行文字的框基本重合；0.5 能挡住相邻行的误配
IOU_MIN = 0.5
TARGET_RATE = 0.95


def bbox(line):
    xs = [p[0] for p in line['box']]
    ys = [p[1] for p in line['box']]
    return min(xs), min(ys), max(xs), max(ys)


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def pair(ref, got):
    """全体候选按 IoU 从大到小贪心配对，一行只配一次。返回 {ref 下标: got 下标}。"""
    cands = []
    for i, r in enumerate(ref):
        rb = bbox(r)
        for j, g in enumerate(got):
            v = iou(rb, bbox(g))
            if v >= IOU_MIN:
                cands.append((v, i, j))
    cands.sort(reverse=True)
    used_r, used_g, m = set(), set(), {}
    for v, i, j in cands:
        if i in used_r or j in used_g:
            continue
        used_r.add(i)
        used_g.add(j)
        m[i] = j
    return m


def main():
    ref_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'tools/fixtures/poster-1124.ocr.json'
    got_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'tools/fixtures/poster-1124.android.json'
    ref = json.loads(ref_path.read_text(encoding='utf-8'))
    got = json.loads(got_path.read_text(encoding='utf-8'))
    rl, gl = ref['lines'], got['lines']
    m = pair(rl, gl)

    same = sum(1 for i, j in m.items() if rl[i]['text'] == gl[j]['text'])
    rate = same / len(rl) if rl else 0.0
    char_sim = sum(SequenceMatcher(None, rl[i]['text'], gl[j]['text']).ratio() for i, j in m.items()) / len(rl) if rl else 0.0

    time_ref = [i for i, r in enumerate(rl) if TIME_RE.search(r['text'])]
    time_bad = [i for i in time_ref if i not in m or gl[m[i]]['text'] != rl[i]['text']]
    # 端上多认出来的时间行（基准里没有配对的）也算不一致
    matched_g = set(m.values())
    time_extra = [j for j, g in enumerate(gl) if TIME_RE.search(g['text']) and j not in matched_g]

    print(f'基准 {ref_path.name}: {len(rl)} 行（{ref.get("engine", "?")}）')
    print(f'待比 {got_path.name}: {len(gl)} 行（{got.get("engine", "?")}，{got.get("ms", "?")} ms）')
    print(f'配上 {len(m)} 行；文本完全一致 {same}/{len(rl)} = {rate:.1%}；字符级相似度 {char_sim:.1%}')
    print(f'时间行 {len(time_ref)} 行，不一致 {len(time_bad)} 行，端上多出 {len(time_extra)} 行')

    diffs = [(i, j) for i, j in sorted(m.items()) if rl[i]['text'] != gl[j]['text']]
    if diffs:
        print('\n文字不一致（基准 → 待比，后面是两边的分数）：')
        for i, j in diffs:
            mark = '  [时间行]' if i in time_ref else ''
            print(f'  {rl[i]["text"]} → {gl[j]["text"]}   ({rl[i]["score"]} / {gl[j]["score"]}){mark}')
    miss = [i for i in range(len(rl)) if i not in m]
    if miss:
        print('\n基准有、待比没配上：')
        for i in miss:
            print(f'  {rl[i]["text"]}  box={rl[i]["box"][0]}..{rl[i]["box"][2]}')
    extra = [j for j in range(len(gl)) if j not in matched_g]
    if extra:
        print('\n待比多出来、基准没配上：')
        for j in extra:
            print(f'  {gl[j]["text"]}  box={gl[j]["box"][0]}..{gl[j]["box"][2]}')

    ok = not time_bad and not time_extra and rate >= TARGET_RATE
    print('\n结论：' + ('达标' if ok else '未达标') + f'（时间行全一致 {"是" if not time_bad and not time_extra else "否"}，'
          f'一致率 {rate:.1%} {"≥" if rate >= TARGET_RATE else "<"} {TARGET_RATE:.0%}）')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
