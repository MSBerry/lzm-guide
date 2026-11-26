package com.lzm.guide

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.os.SystemClock
import android.util.Log
import java.io.IOException
import java.math.BigDecimal
import java.math.RoundingMode
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * 海报离线 OCR：PP-OCRv4 mobile 中文检测 + 识别（不用方向分类），跑在 onnxruntime 的 Java API 上。
 *
 * ## 对齐的是谁
 * 前后处理逐项照抄 RapidOCR 3.10（`tools/ocr_fixture.py` 用它跑出 `tools/fixtures/poster-1124.ocr.json`），
 * 两边吃同一对模型文件，结果才能用 `tools/compare_ocr.py` 逐行比。具体对齐到哪一步见各常量和
 * [OcrGeometry.kt][resizeLinear] 的类头。照抄之前先用同一套算法的 Python 镜像在桌面上对拍过：123/123 行文字全同。
 *
 * ```
 * 解码后的整图 ──限长 2000──> [垂直补边] ──det: 短边补到 736、32 对齐──> 概率图
 *    ──> >0.3 二值化 + 2×2 膨胀 ──> 8 连通域 ──> 最小外接矩形 ──> 打分 ≥0.5 ──> 圆角外扩 1.6 ──> 再求外接矩形
 *    ──> 按行排序 ──> 逐框透视裁剪（高宽比 ≥1.5 转 90°）──> rec: 按宽高比排序、6 个一批、高 48 ──> CTC 贪心解码
 *    ──> 去空串、去 <0.5 分 ──> 框映射回解码图坐标
 * ```
 *
 * ## 生命周期
 * 两个 session 第一次 [recognize] 时才建（15 MB 模型读进内存要几百毫秒，进页面就建是白占内存），
 * 之后缓存复用，[close] 释放。建失败记一次，之后 [isAvailable] 恒为 false，不反复重试。
 *
 * ## 线程约定
 * **[recognize] 与 [close] 必须在同一条后台线程上串行调用**（[PosterScanner] 的单线程 executor）：
 * 识别跑到一半时 close 掉 session 是 native 层的 use-after-free。rec 段内部再分给 [recPool] 并行，
 * 但 [recognize] 返回（含抛异常）前一定等齐所有批次，所以上面这条对调用方仍然成立。[isAvailable] 任意线程可读。
 */
internal class PosterOcr(private val context: Context) : AutoCloseable {

    class Line(val text: String, val score: Double, val quad: Quad)

    class Result(val lines: List<Line>, val loadMs: Long, val detMs: Long, val recMs: Long)

    /** 建 session、跑推理时可预期的失败（模型读不出、ORT 报错、字典对不上模型）。调用方回落成 `ocr_failed`。 */
    class EngineException(message: String, cause: Throwable? = null) : Exception(message, cause)

    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }

    /** rec 分批并行的工作线程，见 [recognizeCrops]。 */
    private val recPool: ExecutorService by lazy {
        Executors.newFixedThreadPool(REC_WORKERS) { Thread(it, "PosterOcrRec") }
    }
    private var det: Loaded? = null
    private var rec: Loaded? = null
    private var chars: List<String> = emptyList()
    private var closed = false

    @Volatile
    private var loadFailed = false

    /** 模型在包里、且没有建失败过。不代表一定能跑成功，只用来决定页面露不露入口。 */
    val isAvailable: Boolean
        get() = !loadFailed && modelsPresent

    private val modelsPresent: Boolean by lazy {
        val names = try {
            context.assets.list("")?.toSet().orEmpty()
        } catch (e: IOException) {
            Log.w(TAG, "列不出 assets，按 OCR 不可用处理", e)
            emptySet()
        }
        (DET_MODEL in names && REC_MODEL in names).also {
            if (!it) Log.w(TAG, "assets 里缺模型 det=${DET_MODEL in names} rec=${REC_MODEL in names}，OCR 不可用")
        }
    }

    val engineName: String
        get() = "onnxruntime-android ${env.version} PP-OCRv4 mobile ch det+rec, no cls"

    @Throws(EngineException::class)
    fun recognize(src: BgrImage, onStage: (String) -> Unit): Result {
        check(!closed) { "recognize after close" }
        val t0 = SystemClock.elapsedRealtime()
        ensureLoaded()
        val t1 = SystemClock.elapsedRealtime()

        // ① Global：长边限 2000（短边不足 30 放大），两次缩放的比例要连乘
        // ⚠️ RapidOCR 的 resize_image_within_bounds 在两步都触发时只留第二步的比例（框会映射错），这里改成连乘；
        //    只有 30×2000 这种极端长条图才会两步都触发，海报碰不到，所以与基准仍然可比。
        var img = src
        var ratioW = 1.0
        var ratioH = 1.0
        if (max(img.width, img.height) > MAX_SIDE_LEN) {
            val r = MAX_SIDE_LEN.toDouble() / max(img.width, img.height)
            val (nw, nh) = round32((img.width * r).toInt()) to round32((img.height * r).toInt())
            if (nw <= 0 || nh <= 0) return Result(emptyList(), t1 - t0, 0, 0)
            ratioW = img.width.toDouble() / nw
            ratioH = img.height.toDouble() / nh
            img = resizeLinear(img, nw, nh)
        }
        if (min(img.width, img.height) < MIN_SIDE_LEN) {
            val r = MIN_SIDE_LEN.toDouble() / min(img.width, img.height)
            val (nw, nh) = round32((img.width * r).toInt()) to round32((img.height * r).toInt())
            if (nw <= 0 || nh <= 0) return Result(emptyList(), t1 - t0, 0, 0)
            ratioW *= img.width.toDouble() / nw
            ratioH *= img.height.toDouble() / nh
            img = resizeLinear(img, nw, nh)
        }

        // ② 垂直补边：太扁（宽高比 > 8）或太矮（≤ 30）的图上下补黑边，检测模型才认得出单行字
        var padTop = 0
        if (img.height <= MIN_HEIGHT || img.width.toDouble() / img.height > WIDTH_HEIGHT_RATIO) {
            val newH = max((img.width / WIDTH_HEIGHT_RATIO).toInt(), MIN_HEIGHT) * 2
            padTop = (kotlin.math.abs(newH - img.height) / 2.0).toInt()
            img = padVertical(img, padTop)
        }

        onStage("detecting")
        val quads = detect(img)
        val t2 = SystemClock.elapsedRealtime()
        if (quads.isEmpty()) return Result(emptyList(), t1 - t0, t2 - t1, 0)

        onStage("recognizing")
        val texts = recognizeCrops(img, quads)
        val t3 = SystemClock.elapsedRealtime()

        val lines = ArrayList<Line>(quads.size)
        for (i in quads.indices) {
            val (text, score) = texts[i]
            if (text.isBlank() || score < TEXT_SCORE) continue
            val q = quads[i]
            // map_boxes_to_original：先减补边、再乘缩放比，最后夹进原图范围
            val xs = DoubleArray(4) { (q.xs[it] * ratioW).coerceIn(0.0, src.width.toDouble()) }
            val ys = DoubleArray(4) { ((q.ys[it] - padTop) * ratioH).coerceIn(0.0, src.height.toDouble()) }
            lines += Line(text, score, Quad(xs, ys))
        }
        return Result(lines, t1 - t0, t2 - t1, t3 - t2)
    }

    override fun close() {
        if (closed) return
        closed = true
        // recognize 返回前已等齐所有批次，这里池子是空闲的，直接关
        recPool.shutdown()
        releaseSessions()
    }

    private fun releaseSessions() {
        det?.close()
        rec?.close()
        det = null
        rec = null
    }

    // ── 模型加载 ─────────────────────────

    private class Loaded(val session: OrtSession, val options: OrtSession.SessionOptions) : AutoCloseable {
        val input: String = session.inputNames.first()

        override fun close() {
            try {
                session.close()
            } catch (e: OrtException) {
                Log.w(TAG, "释放 session 出错，忽略", e)
            }
            options.close()
        }
    }

    @Throws(EngineException::class)
    private fun ensureLoaded() {
        if (det != null && rec != null) return
        if (loadFailed) throw EngineException("模型加载失败过，不再重试")
        try {
            val d = det ?: load(DET_MODEL, intraThreads = 0).also { det = it }
            // rec 的并行在批与批之间（见 recognizeCrops），单次 Run 只用调用线程，免得几个 Run 抢同一个线程池
            val r = rec ?: load(REC_MODEL, intraThreads = 1).also { rec = it }
            chars = readCharacters(r.session)
            Log.i(TAG, "模型就绪 det=${d.input} rec=${r.input} chars=${chars.size} ort=${env.version}")
        } catch (e: OrtException) {
            failLoad("建 session 失败", e)
        } catch (e: IOException) {
            failLoad("读模型 assets 失败", e)
        } catch (e: EngineException) {
            failLoad(e.message ?: "模型校验失败", e)
        }
    }

    /** 回落之后的样子：本次返回 `ocr_failed`，[isAvailable] 变 false，页面下次问时就不再露拍照识别入口。 */
    private fun failLoad(what: String, e: Exception): Nothing {
        loadFailed = true
        releaseSessions()
        Log.w(TAG, "$what，OCR 回落为不可用", e)
        throw EngineException(what, e)
    }

    /** [intraThreads] 为 0 时用 ORT 默认线程数。 */
    private fun load(asset: String, intraThreads: Int): Loaded {
        val bytes = context.assets.open(asset).use { it.readBytes() }
        val options = OrtSession.SessionOptions()
        try {
            // 与 RapidOCR 的 OrtInferSession 同配置：全量图优化、关 CPU arena（rec 每批输入宽度都不一样，arena 只会越攒越大）
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            options.setCPUArenaAllocator(false)
            if (intraThreads > 0) options.setIntraOpNumThreads(intraThreads)
            return Loaded(env.createSession(bytes, options), options)
        } catch (e: OrtException) {
            options.close()
            throw e
        }
    }

    /**
     * 字典在 rec 模型的元数据里（key `character`，6623 行），RapidOCR 的 CTCLabelDecode 再在头上插 blank、尾上补空格：
     * 下标 0 = blank，1..6623 = 字典，6624 = 空格，共 6625 类，正好是模型输出的最后一维。
     */
    private fun readCharacters(session: OrtSession): List<String> {
        val raw = session.metadata.customMetadata[DICT_KEY]
            ?: throw EngineException("rec 模型元数据里没有 $DICT_KEY")
        // Python 用的是 str.splitlines()；这份字典里没有 \v \f \x1c 之类的另类换行（已核），按 \r\n / \n / \r 切等价
        val lines = raw.lines().let { if (it.isNotEmpty() && it.last().isEmpty()) it.dropLast(1) else it }
        val list = ArrayList<String>(lines.size + 2)
        list += "blank"
        list += lines
        list += " "
        val classes = (session.outputInfo.values.first().info as TensorInfo).shape.last()
        if (classes != list.size.toLong()) {
            throw EngineException("字典 ${list.size} 类与模型输出 $classes 类对不上")
        }
        return list
    }

    // ── 检测 ─────────────────────────

    private fun detect(img: BgrImage): List<Quad> {
        val session = det!!
        val h = img.height
        val w = img.width
        // limit_type=min：短边不足 736 才放大，否则原尺寸；两边再各自取整到 32 的倍数
        val ratio = if (min(h, w) < DET_LIMIT_SIDE_LEN) {
            if (h < w) DET_LIMIT_SIDE_LEN.toDouble() / h else DET_LIMIT_SIDE_LEN.toDouble() / w
        } else {
            1.0
        }
        val rh = round32((h * ratio).toInt())
        val rw = round32((w * ratio).toInt())
        if (rh <= 0 || rw <= 0) return emptyList()
        val resized = resizeLinear(img, rw, rh)

        val plane = rh * rw
        val input = directFloats(3 * plane)
        val px = resized.data
        for (i in 0 until plane) {
            for (c in 0 until 3) input.put(c * plane + i, DET_NORM[px[i * 3 + c].toInt() and 0xFF])
        }
        val pred = run(session, input, longArrayOf(1, 3, rh.toLong(), rw.toLong())).first
        return dbPostProcess(pred, rw, rh, w, h)
    }

    /** DBPostProcess：概率图 → 原图（det 输入前的那张）上的四边形，已按阅读顺序排好。 */
    private fun dbPostProcess(pred: FloatArray, pw: Int, ph: Int, destW: Int, destH: Int): List<Quad> {
        // ① 二值化 + 2×2 膨胀（cv2.dilate 锚点在 (1,1)：每个前景像素向右、向下各扩一格）
        val mask = ByteArray(pw * ph)
        for (y in 0 until ph) {
            for (x in 0 until pw) {
                val i = y * pw + x
                if (pred[i] > DB_THRESH ||
                    (x > 0 && pred[i - 1] > DB_THRESH) ||
                    (y > 0 && pred[i - pw] > DB_THRESH) ||
                    (x > 0 && y > 0 && pred[i - pw - 1] > DB_THRESH)
                ) {
                    mask[i] = 1
                }
            }
        }
        // findContours 把图像最外一圈当 0
        for (x in 0 until pw) {
            mask[x] = 0
            mask[(ph - 1) * pw + x] = 0
        }
        for (y in 0 until ph) {
            mask[y * pw] = 0
            mask[y * pw + pw - 1] = 0
        }

        // ② 8 连通域，代替 findContours(RETR_LIST)。不要洞的轮廓：洞里框住的多是阈值以下的像素，打分过不了 0.5，
        //    桌面实测 RETR_LIST 换成 RETR_EXTERNAL 结果一行不差。每行只记最左、最右像素——凸包只需要这些点。
        val rowMin = IntArray(ph) { Int.MAX_VALUE }
        val rowMax = IntArray(ph) { -1 }
        val touched = IntArray(ph)
        var stack = IntArray(4096)
        val boxes = ArrayList<Quad>()
        var candidates = 0
        for (start in 0 until pw * ph) {
            if (mask[start].toInt() == 0) continue
            if (candidates >= DB_MAX_CANDIDATES) break
            candidates++
            var nTouched = 0
            var sp = 0
            stack[sp++] = start
            mask[start] = 0
            while (sp > 0) {
                val p = stack[--sp]
                val x = p % pw
                val y = p / pw
                if (rowMax[y] < 0) touched[nTouched++] = y
                if (x < rowMin[y]) rowMin[y] = x
                if (x > rowMax[y]) rowMax[y] = x
                for (dy in -1..1) {
                    val ny = y + dy
                    if (ny < 0 || ny >= ph) continue
                    for (dx in -1..1) {
                        val nx = x + dx
                        if (nx < 0 || nx >= pw) continue
                        val q = ny * pw + nx
                        if (mask[q].toInt() == 0) continue
                        mask[q] = 0
                        if (sp == stack.size) stack = stack.copyOf(stack.size * 2)
                        stack[sp++] = q
                    }
                }
            }
            val n = nTouched * 2
            val xs = IntArray(n)
            val ys = IntArray(n)
            for (k in 0 until nTouched) {
                val y = touched[k]
                xs[2 * k] = rowMin[y]
                ys[2 * k] = y
                xs[2 * k + 1] = rowMax[y]
                ys[2 * k + 1] = y
                rowMin[y] = Int.MAX_VALUE
                rowMax[y] = -1
            }
            boxFromComponent(pred, pw, ph, xs, ys, n, destW, destH)?.let { boxes += it }
        }
        return sortBoxes(boxes)
    }

    private fun boxFromComponent(
        pred: FloatArray, pw: Int, ph: Int, xs: IntArray, ys: IntArray, n: Int, destW: Int, destH: Int,
    ): Quad? {
        val first = miniBox(xs, ys, n)
        if (first.shortSide < DB_MIN_SIZE) return null
        val q = asFloat32(first.quad)
        if (boxScoreFast(pred, pw, ph, q) < DB_BOX_THRESH) return null

        // unclip：外扩距离 = 面积 × 1.6 / 周长（shapely 的 area / length），再圆角外扩
        var area = 0.0
        var length = 0.0
        for (i in 0 until 4) {
            val j = (i + 1) % 4
            area += q.xs[i] * q.ys[j] - q.xs[j] * q.ys[i]
            length += hypot(q.xs[j] - q.xs[i], q.ys[j] - q.ys[i])
        }
        val (ex, ey) = clipperRoundOffset(q, kotlin.math.abs(area) / 2 * DB_UNCLIP_RATIO / length)
        if (ex.isEmpty()) return null
        val second = miniBox(ex, ey, ex.size)
        if (second.shortSide < DB_MIN_SIZE + 2) return null
        val b = asFloat32(second.quad)

        // 概率图坐标 → det 输入前的原图坐标。⚠️ 这一步 numpy 全程是 float32，且 np.round 是银行家舍入；
        // 换成 double + Math.round 会在 .5 上差一格
        val bx = IntArray(4) {
            Math.rint(((b.xs[it].toFloat() / pw.toFloat()) * destW.toFloat()).toDouble()).toInt().coerceIn(0, destW)
        }
        val by = IntArray(4) {
            Math.rint(((b.ys[it].toFloat() / ph.toFloat()) * destH.toFloat()).toDouble()).toInt().coerceIn(0, destH)
        }

        // filter_det_res：order_points_clockwise（按 x 排，左右两对各按 y 排）+ 夹进 [0, w-1]，太小的丢
        val byX = (0 until 4).sortedBy { bx[it] }
        val left = byX.take(2).sortedBy { by[it] }
        val right = byX.drop(2).sortedBy { by[it] }
        val order = intArrayOf(left[0], right[0], right[1], left[1])
        val rx = DoubleArray(4) { bx[order[it]].coerceIn(0, destW - 1).toDouble() }
        val ry = DoubleArray(4) { by[order[it]].coerceIn(0, destH - 1).toDouble() }
        if (hypot(rx[0] - rx[1], ry[0] - ry[1]).toInt() <= 3 || hypot(rx[0] - rx[3], ry[0] - ry[3]).toInt() <= 3) {
            return null
        }
        return Quad(rx, ry)
    }

    /**
     * box_score_fast：框内概率均值。cv2.fillPoly 的光栅化规则这里只近似（逐行求与四条边的交点，含端点），
     * 只影响贴着 0.5 门槛的框；桌面对拍同一套近似，没有一个框因此进出。
     */
    private fun boxScoreFast(pred: FloatArray, pw: Int, ph: Int, q: Quad): Double {
        val xmin = floor(q.xs.min()).toInt().coerceIn(0, pw - 1)
        val xmax = ceil(q.xs.max()).toInt().coerceIn(0, pw - 1)
        val ymin = floor(q.ys.min()).toInt().coerceIn(0, ph - 1)
        val ymax = ceil(q.ys.max()).toInt().coerceIn(0, ph - 1)
        // numpy 的 astype(int32)：向零截断
        val px = DoubleArray(4) { (q.xs[it] - xmin).toInt().toDouble() }
        val py = DoubleArray(4) { (q.ys[it] - ymin).toInt().toDouble() }
        var sum = 0.0
        var count = 0
        for (yy in 0..(ymax - ymin)) {
            var lo = Double.MAX_VALUE
            var hi = -Double.MAX_VALUE
            for (i in 0 until 4) {
                val x1 = px[i]
                val y1 = py[i]
                val x2 = px[(i + 1) % 4]
                val y2 = py[(i + 1) % 4]
                if (y1 == y2) {
                    if (y1 == yy.toDouble()) {
                        lo = min(lo, min(x1, x2))
                        hi = max(hi, max(x1, x2))
                    }
                    continue
                }
                if (yy >= min(y1, y2) && yy <= max(y1, y2)) {
                    val x = x1 + (yy - y1) * (x2 - x1) / (y2 - y1)
                    lo = min(lo, x)
                    hi = max(hi, x)
                }
            }
            if (lo > hi) continue
            val a = max(ceil(lo - 1e-9).toInt(), 0)
            val b = min(floor(hi + 1e-9).toInt(), xmax - xmin)
            if (b < a) continue
            val row = (ymin + yy) * pw + xmin
            for (x in a..b) sum += pred[row + x]
            count += b - a + 1
        }
        return if (count > 0) sum / count else 0.0
    }

    /**
     * sorted_boxes：按左上角 y 稳定排序，相邻两框 y 差 < 10 归同一行，行内按 x 排。
     * ⚠️ 别改成「y 差 < 10 就比 x」的两两比较排序：那不满足传递性，结果依赖输入顺序，RapidOCR 也早换成了分行号的写法。
     */
    private fun sortBoxes(boxes: List<Quad>): List<Quad> {
        if (boxes.isEmpty()) return boxes
        val byY = boxes.sortedBy { it.ys[0] }
        val line = IntArray(byY.size)
        for (i in 1 until byY.size) {
            line[i] = line[i - 1] + if (byY[i].ys[0] - byY[i - 1].ys[0] >= SORT_Y_THRESHOLD) 1 else 0
        }
        return byY.indices.sortedWith(compareBy({ line[it] }, { byY[it].xs[0] })).map { byY[it] }
    }

    // ── 识别 ─────────────────────────

    /** get_rotate_crop_image：透视拉正；竖长条（高宽比 ≥ 1.5）当竖排字，逆时针转 90° 再识别。 */
    private fun crop(img: BgrImage, q: Quad): BgrImage {
        val (cw, ch) = quadCropSize(q)
        val c = warpCubic(img, q, max(cw, 1), max(ch, 1))
        return if (c.height.toDouble() / c.width >= 1.5) rot90(c) else c
    }

    /** 裁剪后（含转 90°）的宽高。分批要先知道宽高比，用它就不必先把所有框都裁出来。 */
    private fun cropSize(q: Quad): Pair<Int, Int> {
        val (cw, ch) = quadCropSize(q)
        val w = max(cw, 1)
        val h = max(ch, 1)
        return if (h.toDouble() / w >= 1.5) h to w else w to h
    }

    /**
     * 按宽高比排序、6 个一批识别。批与批之间互不相干，分给 [recPool] 并行跑，每次 Run 只用调用线程。
     *
     * ⚠️ 别改回「一批一批串行、让 ORT 自己多线程」：rec 模型是 48 像素高的小张量，61% 时间在逐通道卷积、
     * 36% 在没融合的 hardswish 逐元素算子上（ORT profiler 拆的），单次 Run 内多线程几乎不涨：
     * 串行时 rec 段默认线程数 5.2–6.4 s，改成 6 批并行、每批单线程 3.5 s（2026-11-26 vivo V2408A 同图实测）。
     * 批的划分和 RapidOCR 完全一样，并行只改执行顺序，不改结果。
     */
    private fun recognizeCrops(img: BgrImage, quads: List<Quad>): List<Pair<String, Double>> {
        val sizes = quads.map(::cropSize)
        val ratios = DoubleArray(quads.size) { sizes[it].first / sizes[it].second.toDouble() }
        // 按宽高比排序再分批，同批补边少。numpy 的 argsort 默认不稳定，这里用稳定排序；桌面实测换 stable 结果一行不差
        val batches = quads.indices.sortedBy { ratios[it] }.chunked(REC_BATCH)
        // 最宽的批最慢，先发出去，免得最后剩它一个在跑
        val futures = batches.indices.reversed().associateWith { b ->
            recPool.submit(Callable { recognizeBatch(img, quads, batches[b], ratios) })
        }
        val out = arrayOfNulls<Pair<String, Double>>(quads.size)
        // 有一批失败也要等其余批次跑完再抛：调用方随后可能 close()，批次还在跑时释放 session 会在 native 层崩
        var failure: Throwable? = null
        for ((b, f) in futures) {
            try {
                val res = f.get()
                for ((k, i) in batches[b].withIndex()) out[i] = res[k]
            } catch (e: ExecutionException) {
                if (failure == null) failure = e.cause ?: e
            }
        }
        failure?.let { throw it }
        return out.map { it!! }
    }

    private fun recognizeBatch(img: BgrImage, quads: List<Quad>, batch: List<Int>, ratios: DoubleArray): List<Pair<String, Double>> {
        var maxRatio = REC_W.toDouble() / REC_H
        for (i in batch) maxRatio = max(maxRatio, ratios[i])
        val imgW = (REC_H * maxRatio).toInt()
        val plane = REC_H * imgW
        val input = directFloats(batch.size * 3 * plane) // 新分配的 direct buffer 全 0，0 就是补边值
        for ((k, i) in batch.withIndex()) {
            val c = crop(img, quads[i])
            val resizedW = if (ceil(REC_H * ratios[i]) > imgW) imgW else ceil(REC_H * ratios[i]).toInt()
            val r = resizeLinear(c, resizedW, REC_H)
            val base = k * 3 * plane
            for (y in 0 until REC_H) {
                for (x in 0 until resizedW) {
                    val p = (y * resizedW + x) * 3
                    for (ch in 0 until 3) {
                        input.put(base + ch * plane + y * imgW + x, REC_NORM[r.data[p + ch].toInt() and 0xFF])
                    }
                }
            }
        }
        val (probs, shape) = run(rec!!, input, longArrayOf(batch.size.toLong(), 3, REC_H.toLong(), imgW.toLong()))
        val steps = shape[1].toInt()
        val classes = shape[2].toInt()
        return batch.indices.map { k -> ctcDecode(probs, k * steps * classes, steps, classes) }
    }

    /**
     * CTCLabelDecode：逐帧取最大类，去掉与前一帧相同的、去掉 blank。
     * 分数是保留字符概率的均值；每个概率先 round(·, 5) 再平均、均值再 round 5 位，照抄是为了和基准的分数逐位可比。
     */
    private fun ctcDecode(p: FloatArray, offset: Int, steps: Int, classes: Int): Pair<String, Double> {
        val sb = StringBuilder()
        var confSum = 0.0
        var confN = 0
        var prev = -1
        for (t in 0 until steps) {
            val row = offset + t * classes
            var best = 0
            var bestP = p[row]
            for (c in 1 until classes) {
                if (p[row + c] > bestP) {
                    bestP = p[row + c]
                    best = c
                }
            }
            if (best != prev && best != 0) {
                sb.append(chars[best])
                confSum += BigDecimal(bestP.toDouble()).setScale(5, RoundingMode.HALF_EVEN).toDouble()
                confN++
            }
            prev = best
        }
        val mean = if (confN > 0) confSum / confN else 0.0
        return sb.toString() to Math.rint(mean * 1e5) / 1e5
    }

    // ── 工具 ─────────────────────────

    /** 跑一次推理，返回第一个输出的数据与形状。 */
    private fun run(model: Loaded, input: FloatBuffer, shape: LongArray): Pair<FloatArray, LongArray> {
        try {
            OnnxTensor.createTensor(env, input, shape).use { tensor ->
                model.session.run(mapOf(model.input to tensor)).use { result ->
                    val out = result.get(0) as OnnxTensor
                    // getFloatBuffer 已经从 native 拷了一份到堆上，直接拿它的数组，别再拷第二份：
                    // 最宽那批 rec 输出近 30 MB，几批并行时两份拷贝能把 256 MB 的堆顶满
                    val fb = out.floatBuffer
                    val arr = if (fb.hasArray() && fb.arrayOffset() == 0) fb.array() else FloatArray(fb.remaining()).also { fb.get(it) }
                    return arr to out.info.shape
                }
            }
        } catch (e: OrtException) {
            throw EngineException("推理失败 shape=${shape.joinToString("x")}", e)
        }
    }

    /** direct + 本机字节序：createTensor 收到它不再拷一份（堆上的 FloatBuffer 会被整份复制进 native）。 */
    private fun directFloats(n: Int): FloatBuffer =
        ByteBuffer.allocateDirect(n * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()

    private fun padVertical(img: BgrImage, pad: Int): BgrImage {
        val out = ByteArray(img.width * (img.height + 2 * pad) * 3)
        System.arraycopy(img.data, 0, out, pad * img.width * 3, img.data.size)
        return BgrImage(img.width, img.height + 2 * pad, out)
    }

    /** numpy 那边四角是 float32：先落成 float 再用，截断 / 取整的结果才一致（551.99999999 落成 552.0）。 */
    private fun asFloat32(q: Quad) = Quad(
        DoubleArray(4) { q.xs[it].toFloat().toDouble() },
        DoubleArray(4) { q.ys[it].toFloat().toDouble() },
    )

    /** int(round(v / 32) * 32)，Python 的 round 是银行家舍入。 */
    private fun round32(v: Int): Int = (roundHalfEven(v / 32.0) * 32).toInt()

    private companion object {
        const val TAG = "LzmOcr"

        const val DET_MODEL = "ch_PP-OCRv4_det_mobile.onnx"
        const val REC_MODEL = "ch_PP-OCRv4_rec_mobile.onnx"
        const val DICT_KEY = "character"

        // 以下全部取自 rapidocr/config.yaml 与 ch_ppocr_det / ch_ppocr_rec 源码（3.10），**别改**：改了就和基准不可比。

        /** Global.max_side_len / min_side_len。 */
        const val MAX_SIDE_LEN = 2000
        const val MIN_SIDE_LEN = 30

        /** Global.use_vertical_padding 的两个门槛：min_height、width_height_ratio。 */
        const val MIN_HEIGHT = 30
        const val WIDTH_HEIGHT_RATIO = 8.0

        /** Global.text_score：识别均分低于它的行丢掉。 */
        const val TEXT_SCORE = 0.5

        /** Det.limit_side_len，配 limit_type: min。 */
        const val DET_LIMIT_SIDE_LEN = 736

        /** Det.thresh / box_thresh / unclip_ratio / max_candidates；min_size 写死在 DBPostProcess 里。 */
        const val DB_THRESH = 0.3f
        const val DB_BOX_THRESH = 0.5
        const val DB_UNCLIP_RATIO = 1.6
        const val DB_MAX_CANDIDATES = 1000
        const val DB_MIN_SIZE = 3.0

        /** TextDetector._BOX_SORT_Y_THRESHOLD。 */
        const val SORT_Y_THRESHOLD = 10.0

        /** Rec.rec_img_shape = [3, 48, 320]，rec_batch_num = 6。 */
        const val REC_H = 48
        const val REC_W = 320
        const val REC_BATCH = 6

        /**
         * rec 并行批数：2026-11-26 vivo V2408A（骁龙 8 Elite，8 核）同图实测 rec 段 3 路 4.8 s、4 路 4.1 s、
         * 6 路 3.5 s、8 路 3.7 s，取 6；核少的机器不超过核数。
         */
        val REC_WORKERS = min(6, Runtime.getRuntime().availableProcessors())

        /**
         * det 归一化 (v/255 − 0.5)/0.5 的查表。⚠️ 照 numpy 的类型提升算：v×(1/255) 是 float32，减 mean 时升成 float64，
         * 最后再落回 float32。全程 float 算会在最后一位上差，256 个值查表反正不费事。
         */
        val DET_NORM = FloatArray(256) { (((it * (1.0 / 255.0).toFloat()).toDouble() - 0.5) / 0.5).toFloat() }

        /** rec 归一化：那边是 float32 的 v/255，-= 0.5，/= 0.5。 */
        val REC_NORM = FloatArray(256) { ((it.toFloat() / 255f) - 0.5f) / 0.5f }
    }
}
