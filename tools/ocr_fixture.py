"""用 RapidOCR（PP-OCRv4 mobile 中文 det + rec，不用方向分类）识别海报，输出与 App 原生 OCR 同格式的 JSON。

用法：python tools/ocr_fixture.py <海报图片> <输出.json>
模型下载到 models/（App 打包的就是这同一批文件，两边结果才可比）。
"""
import hashlib
import json
import sys
import time
from pathlib import Path

from rapidocr import ModelType, OCRVersion, RapidOCR

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / 'models'


def main(src: str, dst: str) -> None:
    MODEL_DIR.mkdir(exist_ok=True)
    engine = RapidOCR(params={
        'Global.model_root_dir': str(MODEL_DIR),
        'Global.use_cls': False,
        'Det.ocr_version': OCRVersion.PPOCRV4,
        'Det.model_type': ModelType.MOBILE,
        'Rec.ocr_version': OCRVersion.PPOCRV4,
        'Rec.model_type': ModelType.MOBILE,
    })
    t0 = time.time()
    res = engine(src, use_cls=False)
    ms = int((time.time() - t0) * 1000)

    from PIL import Image
    w, h = Image.open(src).size
    lines = [
        {'text': t, 'score': round(float(s), 4), 'box': [[round(float(x), 1), round(float(y), 1)] for x, y in b]}
        for b, t, s in zip(res.boxes, res.txts, res.scores)
    ]
    models = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()[:16] for p in sorted(MODEL_DIR.rglob('*.onnx'))}
    out = {
        'ok': True, 'width': w, 'height': h, 'lines': lines,
        'engine': 'RapidOCR PP-OCRv4 mobile ch det+rec, no cls (python reference)', 'models': models, 'ms': ms,
    }
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'{len(lines)} lines, {ms} ms -> {dst}')
    print('models:', models)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
