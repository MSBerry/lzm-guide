# 龙之梦演艺导览

太湖龙之梦 · 太湖演艺城的离线导览 App：以手绘导览图为底，显示各剧场离现在最近的演出场次，进景区后在图上标出当前位置与朝向；支持拍照导入新一期演出海报（端侧 OCR，不联网）。

## 结构

| 目录 | 内容 |
|---|---|
| `web/` | 单页前端（Android 壳把整个目录当 assets 打包）。`data/schedule.js` 内置时刻表，`data/venues.js` 剧场坐标，`data/geo.js` 地图配准控制点（WGS-84） |
| `android/` | 零三方 UI 库的 WebView 壳：原生 GPS / 指南针 / 海报 OCR，经 `AndroidBridge` 与 `window.LZM_on*` 和页面通信 |
| `models/` | PP-OCRv4 mobile 中文 det + rec（ONNX，Apache-2.0，字典在 rec 模型元数据 `character` 里） |
| `tools/` | 测试与参考脚本：`test_logic.js`、`test_poster.js`（node）、`shoot.js`（Chrome 无头截图）、`ocr_fixture.py`（电脑端参考 OCR） |

## 构建与测试

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1   # -> dist/lzm-guide.apk
node tools/test_logic.js
node tools/test_poster.js
```

浏览器里直接打开 `web/index.html` 也能用（定位走浏览器接口，需 HTTPS；海报识别只在 App 里有）。
调试参数：`?now=2026-11-26T14:20&lat=30.9545&lon=120.0728&heading=90&debug=1`。

## 已知限制

- 导览图是手绘的，定位换算误差约 10–20 m；音乐广场一带没有控制点，偏差更大，靠现场「位置校准」修正。
- 内置时刻表只覆盖 2026-11-24 至 11-30（海报「11月24日版本」），之后靠导入新海报。
