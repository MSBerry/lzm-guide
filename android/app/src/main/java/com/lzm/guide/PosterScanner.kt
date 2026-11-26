package com.lzm.guide

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.random.Random

/**
 * 「一张海报图 → 转正 → 留档 → OCR → 交给页面的 JSON」整条流水线，跑在自己的单线程 executor 上。
 *
 * ## 交给页面的 JSON（字段与 `tools/fixtures/poster-1124.ocr.json` 一致）
 * - 成功：`{ok:true, width, height, lines:[{text, score, box:[[x,y]×4]}], posterId, posterUrl, engine, ms}`。
 *   `width/height` 与 `box` 都是 **EXIF 转正后原图**的像素坐标；`posterUrl` 那张留档图长边缩到 ≤ 2400，
 *   比原图小时页面叠框要按 `naturalWidth / width` 缩放。box 顺时针、从左上起。
 * - 失败：`{ok:false, error:'cancelled'|'decode_failed'|'ocr_failed', message}`。
 *
 * ## 回落
 * | 情形 | 表现 |
 * |---|---|
 * | 图打不开 / 不是图 / 留档写不进去 | `decode_failed`，不留档 |
 * | 模型建不起来 / 推理报错 | `ocr_failed`，删掉刚留的档；建不起来之后 [isAvailable] 恒 false |
 * | 一行字都没认出来 | 仍是 `ok:true`，`lines` 为空，留档照留——认没认出来由页面告诉用户 |
 *
 * ## 线程约定
 * [onProgress] / [onResult] 在后台线程回调，调用方自己切主线程。[serve] 跑在 WebView 的 IO 线程上，只读文件。
 */
internal class PosterScanner(
    context: Context,
    /** stage 只会是 `decoding` / `detecting` / `recognizing`。 */
    private val onProgress: (String) -> Unit,
    /** 参数是 JSON 字符串，原样交给 `LZM_onPosterResult`。 */
    private val onResult: (String) -> Unit,
) : AutoCloseable {

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "PosterOcr") }
    private val engine = PosterOcr(context.applicationContext)
    private val dir = File(context.filesDir, POSTER_DIR)
    private var closed = false

    val isAvailable: Boolean
        get() = engine.isAvailable

    /** 识别一张图并留档；[cleanup] 在识别结束后（无论成败）于后台线程调用，用来删相机的临时文件。 */
    fun scan(open: () -> InputStream, cleanup: () -> Unit = {}) {
        if (closed) return
        executor.execute {
            val json = try {
                process(open, keepPoster = true)
            } finally {
                cleanup()
            }
            onResult(json.toString())
        }
    }

    /**
     * 调试钩子：对设备上一个文件跑同一套解码 + OCR（不留档），结果写到 [out]。
     * 只给 `am start --es lzm_ocr_test` 用，调用方负责只在 debuggable 包里放行。
     */
    fun runTest(path: String, out: File) {
        if (closed) return
        executor.execute {
            val t0 = SystemClock.elapsedRealtime()
            val json = process({ FileInputStream(path) }, keepPoster = false)
            try {
                out.parentFile?.mkdirs()
                out.writeText(json.toString(1))
            } catch (e: IOException) {
                Log.w(TAG, "自测结果写不进 ${out.absolutePath}", e)
                return@execute
            }
            Log.i(
                TAG,
                "OCR 自测完成 out=${out.absolutePath} ok=${json.optBoolean("ok")} " +
                    "lines=${json.optJSONArray("lines")?.length() ?: 0} ms=${SystemClock.elapsedRealtime() - t0}",
            )
        }
    }

    /** posterId 不合法（含路径分隔符等）时什么都不删。 */
    fun deletePoster(id: String) {
        if (!validId(id)) {
            Log.w(TAG, "deletePoster 收到非法 id，忽略 len=${id.length}")
            return
        }
        val f = File(dir, "$id.jpg")
        if (f.exists() && !f.delete()) Log.w(TAG, "留档删不掉 id=$id")
    }

    /**
     * WebView 的 shouldInterceptRequest：把 `https://appassets.androidplatform.net/posters/<id>.jpg` 映射到 filesDir。
     *
     * ## 为什么是这个虚拟 https 地址
     * - shouldInterceptRequest **不经手** `file:///android_asset/` 下的请求，挂在 asset 路径下拦不到；
     * - 直接给 `file:///data/...`：targetSdk 30 起 WebView 默认 allowFileAccess=false，页面加载不出来，
     *   为它打开文件访问又等于让页面能读整个私有目录；
     * - `appassets.androidplatform.net` 是 Android 专门留给 WebViewAssetLoader 这类拦截用的域名，不会撞真站点。
     *   请求在这里就被应答，不出网，所以没有 INTERNET 权限也能加载。
     *
     * 本域名下其它路径一律 404，不放行到网络栈。返回 null 表示不是本域名，交给 WebView 默认处理。
     */
    fun serve(url: Uri): WebResourceResponse? {
        if (url.host != POSTER_HOST) return null
        val segs = url.pathSegments
        val id = if (segs.size == 2 && segs[0] == "posters" && segs[1].endsWith(".jpg")) segs[1].removeSuffix(".jpg") else null
        if (id != null && validId(id)) {
            try {
                return WebResourceResponse("image/jpeg", null, 200, "OK", HEADERS, FileInputStream(File(dir, "$id.jpg")))
            } catch (e: FileNotFoundException) {
                Log.w(TAG, "页面要的留档不在了 id=$id，回 404", e)
            }
        }
        return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", HEADERS, ByteArrayInputStream(ByteArray(0)))
    }

    /** 排在正在跑的识别后面释放模型：识别跑到一半时释放 session 会在 native 层崩。 */
    override fun close() {
        if (closed) return
        closed = true
        executor.execute { engine.close() }
        executor.shutdown()
    }

    // ── 流水线 ─────────────────────────

    private fun process(open: () -> InputStream, keepPoster: Boolean): JSONObject {
        val t0 = SystemClock.elapsedRealtime()
        onProgress("decoding")
        val decoded = try {
            decode(open)
        } catch (e: IOException) {
            Log.w(TAG, "海报读不出来，回 decode_failed", e)
            null
        } catch (e: SecurityException) {
            Log.w(TAG, "海报没有读权限，回 decode_failed", e)
            null
        } ?: return error("decode_failed", "图片读不出来")

        val posterId = if (keepPoster) {
            try {
                savePoster(decoded.bitmap)
            } catch (e: IOException) {
                Log.w(TAG, "海报留档写不进去，回 decode_failed", e)
                decoded.bitmap.recycle()
                return error("decode_failed", "海报存不下来，可能是存储空间不足")
            }
        } else {
            null
        }
        val img = toBgr(decoded.bitmap)
        decoded.bitmap.recycle()
        val t1 = SystemClock.elapsedRealtime()

        val result = try {
            engine.recognize(img, onProgress)
        } catch (e: PosterOcr.EngineException) {
            Log.w(TAG, "OCR 失败，回 ocr_failed、删留档 id=$posterId", e)
            posterId?.let(::deletePoster)
            return error("ocr_failed", "识别引擎出错：${e.message}")
        }
        val ms = SystemClock.elapsedRealtime() - t0
        Log.i(
            TAG,
            "OCR 完成 src=${img.width}x${img.height} full=${decoded.fullWidth}x${decoded.fullHeight} " +
                "lines=${result.lines.size} decode=${t1 - t0} load=${result.loadMs} det=${result.detMs} " +
                "rec=${result.recMs} total=$ms",
        )

        // 解码时可能按 2 的幂降采样过：框乘回原图尺寸
        val sx = decoded.fullWidth.toDouble() / img.width
        val sy = decoded.fullHeight.toDouble() / img.height
        val lines = JSONArray()
        for (line in result.lines) {
            val box = JSONArray()
            for (i in 0 until 4) box.put(JSONArray().put(round1(line.quad.xs[i] * sx)).put(round1(line.quad.ys[i] * sy)))
            lines.put(JSONObject().put("text", line.text).put("score", round4(line.score)).put("box", box))
        }
        return JSONObject().apply {
            put("ok", true)
            put("width", decoded.fullWidth)
            put("height", decoded.fullHeight)
            put("lines", lines)
            if (posterId != null) {
                put("posterId", posterId)
                put("posterUrl", "https://$POSTER_HOST/posters/$posterId.jpg")
            }
            put("engine", engine.engineName)
            put("ms", ms)
        }
    }

    private class Decoded(val bitmap: Bitmap, val fullWidth: Int, val fullHeight: Int)

    /**
     * 解码并按 EXIF 转正。大图按 2 的幂降采样，但长边不低于 [DECODE_MIN_LONG_SIDE]：
     * 下游 OCR 本来就会把长边缩到 2000，再大只是白占内存（5000 万像素的相机原图整张解开要 200 MB）。
     * 返回 null 表示「不是能解的图」，IO / 权限异常直接抛给调用方。
     */
    @Throws(IOException::class)
    private fun decode(open: () -> InputStream): Decoded? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeStream(it, null, bounds) }
        val w = bounds.outWidth
        val h = bounds.outHeight
        if (w <= 0 || h <= 0) {
            Log.w(TAG, "解不出图片尺寸 mime=${bounds.outMimeType}，按不是图片处理")
            return null
        }
        val orientation = try {
            open().use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        } catch (e: IOException) {
            Log.w(TAG, "读不出 EXIF mime=${bounds.outMimeType}，按未旋转处理", e)
            ExifInterface.ORIENTATION_NORMAL
        }
        var sample = 1
        while (max(w, h) / (sample * 2) >= DECODE_MIN_LONG_SIDE) sample *= 2
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val raw = open().use { BitmapFactory.decodeStream(it, null, opts) }
        if (raw == null) {
            Log.w(TAG, "BitmapFactory 解码失败 mime=${bounds.outMimeType} ${w}x$h sample=$sample")
            return null
        }
        val transposed = orientation in TRANSPOSING
        return Decoded(applyOrientation(raw, orientation), if (transposed) h else w, if (transposed) w else h)
    }

    /** 与 PIL ImageOps.exif_transpose 同义；矩阵取法同 Glide 的 TransformationUtils。 */
    private fun applyOrientation(src: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                m.setRotate(180f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                m.setRotate(90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                m.setRotate(-90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
            else -> return src
        }
        val out = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
        if (out !== src) src.recycle()
        return out
    }

    /**
     * ARGB → BGR（RapidOCR 吃的是 OpenCV 的 BGR 顺序，模型也是按它训的）。
     * 带透明度的图照 RapidOCR 的 cvt_four_to_three 垫底色：不透明部分偏暗垫白、偏亮垫黑；
     * ⚠️ 直接丢掉 alpha 不行：透明处的 RGB 通常是 0，黑字透明底的图会变成黑底黑字。
     */
    private fun toBgr(bitmap: Bitmap): BgrImage {
        val w = bitmap.width
        val h = bitmap.height
        val data = ByteArray(w * h * 3)
        val row = IntArray(w)
        val alpha = bitmap.hasAlpha()
        var bg = 0f
        if (alpha) {
            var lum = 0.0
            var n = 0L
            for (y in 0 until h) {
                bitmap.getPixels(row, 0, w, 0, y, w, 1)
                for (c in row) {
                    if (c ushr 24 == 0) continue
                    lum += 0.299 * ((c shr 16) and 0xFF) + 0.587 * ((c shr 8) and 0xFF) + 0.114 * (c and 0xFF)
                    n++
                }
            }
            bg = if (n == 0L || lum / n < 128) 255f else 0f
        }
        for (y in 0 until h) {
            bitmap.getPixels(row, 0, w, 0, y, w, 1)
            for (x in 0 until w) {
                val c = row[x]
                val o = (y * w + x) * 3
                if (alpha) {
                    val a = (c ushr 24) / 255f
                    data[o] = ((c and 0xFF) * a + bg * (1 - a)).toInt().toByte()
                    data[o + 1] = (((c shr 8) and 0xFF) * a + bg * (1 - a)).toInt().toByte()
                    data[o + 2] = (((c shr 16) and 0xFF) * a + bg * (1 - a)).toInt().toByte()
                } else {
                    data[o] = c.toByte()
                    data[o + 1] = (c shr 8).toByte()
                    data[o + 2] = (c shr 16).toByte()
                }
            }
        }
        return BgrImage(w, h, data)
    }

    /** 先写临时文件再改名：写到一半被杀，页面也不会拿到一张半截的图。 */
    @Throws(IOException::class)
    private fun savePoster(bitmap: Bitmap): String {
        val id = String.format(Locale.US, "p%1\$tY%1\$tm%1\$td-%1\$tH%1\$tM%1\$tS-%2\$04x", Date(), Random.nextInt(0x10000))
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("建不了目录 ${dir.absolutePath}")
        val long = max(bitmap.width, bitmap.height)
        val scaled = if (long > POSTER_MAX_SIDE) {
            val r = POSTER_MAX_SIDE.toDouble() / long
            Bitmap.createScaledBitmap(
                bitmap,
                max(1, (bitmap.width * r).roundToInt()),
                max(1, (bitmap.height * r).roundToInt()),
                true,
            )
        } else {
            bitmap
        }
        val tmp = File(dir, "$id.jpg.tmp")
        try {
            FileOutputStream(tmp).use {
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, POSTER_QUALITY, it)) throw IOException("JPEG 压缩失败")
            }
        } finally {
            if (scaled !== bitmap) scaled.recycle()
        }
        if (!tmp.renameTo(File(dir, "$id.jpg"))) {
            tmp.delete()
            throw IOException("改名失败 id=$id")
        }
        return id
    }

    companion object {
        private const val TAG = "LzmPoster"

        const val POSTER_HOST = "appassets.androidplatform.net"
        private const val POSTER_DIR = "posters"

        /** 页面给的 id 会拼进文件路径，只认我们自己生成的那种字符。 */
        private val ID_RE = Regex("^[A-Za-z0-9_-]{1,64}$")

        /** CORS 头：页面是 file:// 源，想把留档图画进 canvas 再取像素时不被当成跨域污染。 */
        private val HEADERS = mapOf("Access-Control-Allow-Origin" to "*")

        /** 降采样后长边下限：RapidOCR 的 max_side_len 是 2000，解码图不小于它，送进去的像素才和直接读原图同量级。 */
        private const val DECODE_MIN_LONG_SIDE = 2000

        /** 留档长边上限：用户的 vivo 屏幕 1080×2376，长边 2400 铺满屏不糊，再大只是占空间。 */
        private const val POSTER_MAX_SIDE = 2400
        private const val POSTER_QUALITY = 90

        private val TRANSPOSING = setOf(
            ExifInterface.ORIENTATION_TRANSPOSE,
            ExifInterface.ORIENTATION_ROTATE_90,
            ExifInterface.ORIENTATION_TRANSVERSE,
            ExifInterface.ORIENTATION_ROTATE_270,
        )

        private fun validId(id: String) = ID_RE.matches(id)

        fun errorJson(code: String, message: String): String = error(code, message).toString()

        private fun error(code: String, message: String) =
            JSONObject().put("ok", false).put("error", code).put("message", message)

        private fun round1(v: Double) = Math.round(v * 10) / 10.0

        /** 与基准脚本的 round(score, 4) 同口径（Python round 对 double 是精确的银行家舍入）。 */
        private fun round4(v: Double) = BigDecimal(v).setScale(4, RoundingMode.HALF_EVEN).toDouble()
    }
}
