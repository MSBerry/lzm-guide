package com.lzm.guide

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.cos

/**
 * [PosterOcr] 用到的几何与图像原语：RapidOCR 那几处 OpenCV / pyclipper / numpy 调用的无依赖替身。
 *
 * ## 为什么自己写而不引 OpenCV
 * OpenCV Android 包单 arm64 就 10 MB 以上，APK 有 30 MB 预算；这里要的只有六个函数。
 *
 * ## 对齐到什么程度（2026-11-26 在桌面上逐个对拍 opencv-python 5.1.0 / pyclipper 1.4.0）
 * - [resizeLinear]：按 OpenCV 8U 定点 SIMD 公式写，1080×1920→1088×1920 逐字节一致，小图偶有 ±1。
 * - [warpCubic]：OpenCV 5.1 的透视变换用的是**浮点坐标**，不是 4.x 那套 1/32 定点表，照前者写；±1 的像素约 0.2%。
 * - [clipperRoundOffset]：逐行抄 Clipper 6.4 的 ClipperOffset（JT_ROUND），300 组随机框与 pyclipper 输出点集全同。
 * - [miniBox]：凸包 + 逐边求外接矩形，双精度。OpenCV 的 minAreaRect / boxPoints 走 float32，
 *   轴对齐的框常算成 551.9999 这种值，下游一截断就比这里少 1 像素——所以框会有 ±1 像素的出入，
 *   要逐位复现得连 findContours 的点序一起仿，不值。文字不受影响（桌面同一套 Python 镜像 123/123 行全同）。
 *
 * 全部纯算术、不碰 Android API，线程安全。
 */
internal class BgrImage(val width: Int, val height: Int, val data: ByteArray) {
    init {
        require(data.size == width * height * 3) { "size=${data.size} w=$width h=$height" }
    }

    /** 0–255。 */
    fun at(x: Int, y: Int, c: Int): Int = data[(y * width + x) * 3 + c].toInt() and 0xFF
}

/** 四边形，顺序 tl, tr, br, bl，xs/ys 各 4 个。 */
internal class Quad(val xs: DoubleArray, val ys: DoubleArray)

// ── cv2.resize(INTER_LINEAR) ─────────────────────────

private class LinearTable(val ofs: IntArray, val a0: IntArray, val a1: IntArray)

private fun linearTable(srcSize: Int, dstSize: Int): LinearTable {
    val scale = srcSize.toDouble() / dstSize
    val ofs = IntArray(dstSize)
    val a0 = IntArray(dstSize)
    val a1 = IntArray(dstSize)
    for (d in 0 until dstSize) {
        // ⚠️ 坐标先落成 float 再取整：OpenCV 是 (float)((d+0.5)*scale-0.5)，全程 double 会在整数边界上差一格
        var f = ((d + 0.5) * scale - 0.5).toFloat()
        var s = floor(f).toInt()
        f -= s
        if (s < 0) {
            s = 0
            f = 0f
        }
        if (s >= srcSize - 1) {
            s = srcSize - 1
            f = 0f
        }
        ofs[d] = s
        a0[d] = Math.rint(((1f - f) * RESIZE_ONE).toDouble()).toInt()
        a1[d] = Math.rint((f * RESIZE_ONE).toDouble()).toInt()
    }
    return LinearTable(ofs, a0, a1)
}

internal fun resizeLinear(src: BgrImage, dw: Int, dh: Int): BgrImage {
    if (dw == src.width && dh == src.height) return src
    val tx = linearTable(src.width, dw)
    val ty = linearTable(src.height, dh)
    val out = ByteArray(dw * dh * 3)
    val row0 = IntArray(dw * 3)
    val row1 = IntArray(dw * 3)
    val s = src.data
    val sw = src.width
    var cached0 = -1
    var cached1 = -1
    fun hpass(y: Int, dst: IntArray) {
        val base = y * sw * 3
        for (dx in 0 until dw) {
            val x0 = tx.ofs[dx]
            val x1 = min(x0 + 1, sw - 1)
            val p0 = base + x0 * 3
            val p1 = base + x1 * 3
            val a0 = tx.a0[dx]
            val a1 = tx.a1[dx]
            for (c in 0 until 3) {
                dst[dx * 3 + c] = (s[p0 + c].toInt() and 0xFF) * a0 + (s[p1 + c].toInt() and 0xFF) * a1
            }
        }
    }
    for (dy in 0 until dh) {
        val y0 = ty.ofs[dy]
        val y1 = min(y0 + 1, src.height - 1)
        if (cached0 != y0) {
            hpass(y0, row0)
            cached0 = y0
        }
        if (cached1 != y1) {
            hpass(y1, row1)
            cached1 = y1
        }
        val b0 = ty.a0[dy]
        val b1 = ty.a1[dy]
        val o = dy * dw * 3
        for (i in 0 until dw * 3) {
            // OpenCV 的 SIMD 路径：先右移 4 位压进 int16 再取乘积高 16 位，比标量路径的 (v+2^21)>>22 少半位精度。
            // 整幅图绝大部分像素走的是 SIMD，照它算才对得上；照标量公式写，每行都有几十个 ±1。
            val t0 = ((row0[i] shr 4) * b0) shr 16
            val t1 = ((row1[i] shr 4) * b1) shr 16
            out[o + i] = ((t0 + t1 + 2) shr 2).coerceIn(0, 255).toByte()
        }
    }
    return BgrImage(dw, dh, out)
}

// ── 凸包 + 最小外接矩形（cv2.minAreaRect + get_mini_boxes） ─────────────────────────

/** 单调链凸包，去掉共线点（与 OpenCV Sklansky 同口径），逆时针（数学坐标）。xs/ys 是整数像素坐标。 */
private fun convexHull(xs: IntArray, ys: IntArray, n: Int): Pair<IntArray, IntArray> {
    val idx = (0 until n).sortedWith(compareBy({ xs[it] }, { ys[it] }))
    val hx = IntArray(2 * n + 1)
    val hy = IntArray(2 * n + 1)
    var k = 0
    fun cross(ax: Int, ay: Int, bx: Int, by: Int, cx: Int, cy: Int): Long =
        (bx - ax).toLong() * (cy - ay) - (by - ay).toLong() * (cx - ax)
    var last = -1
    for (i in idx) {
        if (last >= 0 && xs[i] == xs[last] && ys[i] == ys[last]) continue
        last = i
        while (k >= 2 && cross(hx[k - 2], hy[k - 2], hx[k - 1], hy[k - 1], xs[i], ys[i]) <= 0) k--
        hx[k] = xs[i]
        hy[k] = ys[i]
        k++
    }
    val lower = k + 1
    last = -1
    for (j in idx.indices.reversed()) {
        val i = idx[j]
        if (last >= 0 && xs[i] == xs[last] && ys[i] == ys[last]) continue
        last = i
        while (k >= lower && cross(hx[k - 2], hy[k - 2], hx[k - 1], hy[k - 1], xs[i], ys[i]) <= 0) k--
        hx[k] = xs[i]
        hy[k] = ys[i]
        k++
    }
    val m = max(k - 1, 1)
    return hx.copyOf(m) to hy.copyOf(m)
}

/** [miniBox] 的结果：按 tl, tr, br, bl 排好的四角 + 短边长。 */
internal class MiniBox(val quad: Quad, val shortSide: Double)

/**
 * RapidOCR 的 get_mini_boxes：最小外接矩形，再把四角排成 tl, tr, br, bl。
 * 排法照抄：按 x 排序后左两点取 y 小的为 tl、右两点取 y 小的为 tr。
 */
internal fun miniBox(xs: IntArray, ys: IntArray, n: Int): MiniBox {
    val (hx, hy) = convexHull(xs, ys, n)
    val m = hx.size
    val cx = DoubleArray(4)
    val cy = DoubleArray(4)
    var shortSide = 0.0
    if (m < 3) {
        // 退化成点或线段：外接矩形面积为 0，短边 0，调用方按 min_size 直接丢弃
        for (i in 0 until 4) {
            cx[i] = hx[if (i == 1 || i == 2) m - 1 else 0].toDouble()
            cy[i] = hy[if (i == 1 || i == 2) m - 1 else 0].toDouble()
        }
    } else {
        var best = Double.MAX_VALUE
        for (i in 0 until m) {
            val ax = hx[i].toDouble()
            val ay = hy[i].toDouble()
            val ex = hx[(i + 1) % m] - ax
            val ey = hy[(i + 1) % m] - ay
            val len = hypot(ex, ey)
            if (len == 0.0) continue
            val ux = ex / len
            val uy = ey / len
            var umin = Double.MAX_VALUE
            var umax = -Double.MAX_VALUE
            var vmin = Double.MAX_VALUE
            var vmax = -Double.MAX_VALUE
            for (j in 0 until m) {
                val px = hx[j] - ax
                val py = hy[j] - ay
                val u = px * ux + py * uy
                val v = -px * uy + py * ux
                if (u < umin) umin = u
                if (u > umax) umax = u
                if (v < vmin) vmin = v
                if (v > vmax) vmax = v
            }
            val area = (umax - umin) * (vmax - vmin)
            if (area < best) {
                best = area
                shortSide = min(umax - umin, vmax - vmin)
                val us = doubleArrayOf(umin, umax, umax, umin)
                val vs = doubleArrayOf(vmin, vmin, vmax, vmax)
                for (c in 0 until 4) {
                    cx[c] = ax + us[c] * ux - vs[c] * uy
                    cy[c] = ay + us[c] * uy + vs[c] * ux
                }
            }
        }
    }
    val order = (0 until 4).sortedBy { cx[it] } // 稳定排序，同 Python sorted
    val (i1, i4) = if (cy[order[1]] > cy[order[0]]) 0 to 1 else 1 to 0
    val (i2, i3) = if (cy[order[3]] > cy[order[2]]) 2 to 3 else 3 to 2
    val pick = intArrayOf(order[i1], order[i2], order[i3], order[i4])
    return MiniBox(Quad(DoubleArray(4) { cx[pick[it]] }, DoubleArray(4) { cy[pick[it]] }), shortSide)
}

// ── pyclipper.PyclipperOffset(JT_ROUND, ET_CLOSEDPOLYGON) ─────────────────────────

/** Clipper 的 Round：四舍五入、远离零。 */
private fun cRound(v: Double): Int = if (v < 0) (v - 0.5).toInt() else (v + 0.5).toInt()

/**
 * 闭合多边形按圆角外扩 [delta]，返回外扩后的整数点（xs, ys）。
 *
 * ⚠️ 输入先**截断**成整数再扩：pyclipper 收 float 时就是这么做的（实测 10.7 → 10），四舍五入会让框整体偏 1 像素。
 * Clipper 最后那步 union 只会删共线点、换起点，不改变凸包，这里省掉——下游只拿它求外接矩形。
 */
internal fun clipperRoundOffset(quad: Quad, delta: Double): Pair<IntArray, IntArray> {
    val sx = ArrayList<Int>(4)
    val sy = ArrayList<Int>(4)
    for (i in 0 until 4) {
        val x = quad.xs[i].toInt()
        val y = quad.ys[i].toInt()
        if (sx.isNotEmpty() && sx.last() == x && sy.last() == y) continue
        sx += x
        sy += y
    }
    while (sx.size > 1 && sx.first() == sx.last() && sy.first() == sy.last()) {
        sx.removeAt(sx.size - 1)
        sy.removeAt(sy.size - 1)
    }
    if (sx.size < 3) return IntArray(0) to IntArray(0)
    // Clipper 的 Orientation：Area >= 0 为正向；反向的整条倒过来，保证法线朝外
    var a = 0.0
    for (i in sx.indices) {
        val j = if (i == 0) sx.size - 1 else i - 1
        a += (sx[j].toDouble() + sx[i]) * (sy[j].toDouble() - sy[i])
    }
    if (-a * 0.5 < 0) {
        sx.reverse()
        sy.reverse()
    }
    val n = sx.size
    val absDelta = abs(delta)
    val arcTol = if (ARC_TOLERANCE > absDelta * DEF_ARC_TOLERANCE) absDelta * DEF_ARC_TOLERANCE else ARC_TOLERANCE
    var steps = Math.PI / acos(1 - arcTol / absDelta)
    if (steps > absDelta * Math.PI) steps = absDelta * Math.PI
    val stepSin = sin(2 * Math.PI / steps)
    val stepCos = cos(2 * Math.PI / steps)
    val stepsPerRad = steps / (2 * Math.PI)

    val nx = DoubleArray(n)
    val ny = DoubleArray(n)
    for (j in 0 until n) {
        val dx = (sx[(j + 1) % n] - sx[j]).toDouble()
        val dy = (sy[(j + 1) % n] - sy[j]).toDouble()
        val f = 1.0 / hypot(dx, dy)
        nx[j] = dy * f
        ny[j] = -dx * f
    }
    val ox = ArrayList<Int>()
    val oy = ArrayList<Int>()
    fun push(x: Double, y: Double) {
        ox += cRound(x)
        oy += cRound(y)
    }
    var k = n - 1
    for (j in 0 until n) {
        val px = sx[j].toDouble()
        val py = sy[j].toDouble()
        var sinA = nx[k] * ny[j] - nx[j] * ny[k]
        if (abs(sinA * delta) < 1.0) {
            val cosA = nx[k] * nx[j] + ny[j] * ny[k]
            if (cosA > 0) {
                // ⚠️ 这里 Clipper 直接 return，k 不前移——照抄，「顺手」补上 k = j 会让下一个角的圆弧起点错位
                push(px + nx[k] * delta, py + ny[k] * delta)
                continue
            }
        } else if (sinA > 1.0) {
            sinA = 1.0
        } else if (sinA < -1.0) {
            sinA = -1.0
        }
        if (sinA * delta < 0) {
            push(px + nx[k] * delta, py + ny[k] * delta)
            ox += sx[j]
            oy += sy[j]
            push(px + nx[j] * delta, py + ny[j] * delta)
        } else {
            val ang = atan2(sinA, nx[k] * nx[j] + ny[k] * ny[j])
            val st = max(cRound(stepsPerRad * abs(ang)), 1)
            var x = nx[k]
            var y = ny[k]
            repeat(st) {
                push(px + x * delta, py + y * delta)
                val x2 = x
                x = x * stepCos - stepSin * y
                y = x2 * stepSin + y * stepCos
            }
            push(px + nx[j] * delta, py + ny[j] * delta)
        }
        k = j
    }
    return ox.toIntArray() to oy.toIntArray()
}

// ── cv2.getPerspectiveTransform + warpPerspective(INTER_CUBIC, BORDER_REPLICATE) ─────────────────────────

/** 解 8×8 线性方程组（部分主元高斯消元），求把 (dx,dy) 映到 (sx,sy) 的单应矩阵，m[8] = 1。 */
private fun homography(dx: DoubleArray, dy: DoubleArray, sx: DoubleArray, sy: DoubleArray): DoubleArray {
    val a = Array(8) { DoubleArray(9) }
    for (i in 0 until 4) {
        val x = dx[i]
        val y = dy[i]
        val u = sx[i]
        val v = sy[i]
        a[i] = doubleArrayOf(x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u, u)
        a[i + 4] = doubleArrayOf(0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v, v)
    }
    for (col in 0 until 8) {
        var piv = col
        for (r in col + 1 until 8) if (abs(a[r][col]) > abs(a[piv][col])) piv = r
        val t = a[col]
        a[col] = a[piv]
        a[piv] = t
        val p = a[col][col]
        for (r in 0 until 8) {
            if (r == col) continue
            val f = a[r][col] / p
            if (f == 0.0) continue
            for (c in col until 9) a[r][c] -= f * a[col][c]
        }
    }
    return DoubleArray(9) { if (it == 8) 1.0 else a[it][8] / a[it][it] }
}

/** OpenCV interpolateCubic，A = -0.75，float 精度。 */
private fun cubicCoeffs(x: Float, out: FloatArray) {
    val a = -0.75f
    out[0] = ((a * (x + 1) - 5 * a) * (x + 1) + 8 * a) * (x + 1) - 4 * a
    out[1] = ((a + 2) * x - (a + 3)) * x * x + 1
    out[2] = ((a + 2) * (1 - x) - (a + 3)) * (1 - x) * (1 - x) + 1
    out[3] = 1f - out[0] - out[1] - out[2]
}

/** 把原图上的四边形 [q] 拉成 cw×ch 的正矩形（RapidOCR get_rotate_crop_image 的那次 warpPerspective）。 */
internal fun warpCubic(img: BgrImage, q: Quad, cw: Int, ch: Int): BgrImage {
    val m = homography(
        doubleArrayOf(0.0, cw.toDouble(), cw.toDouble(), 0.0),
        doubleArrayOf(0.0, 0.0, ch.toDouble(), ch.toDouble()),
        q.xs,
        q.ys,
    )
    val out = ByteArray(cw * ch * 3)
    val wx = FloatArray(4)
    val wy = FloatArray(4)
    val w = img.width
    val h = img.height
    val s = img.data
    val acc = DoubleArray(3)
    for (y in 0 until ch) {
        for (x in 0 until cw) {
            val ww = m[6] * x + m[7] * y + m[8]
            val fx = (m[0] * x + m[1] * y + m[2]) / ww
            val fy = (m[3] * x + m[4] * y + m[5]) / ww
            val x0 = floor(fx).toInt()
            val y0 = floor(fy).toInt()
            cubicCoeffs((fx - x0).toFloat(), wx)
            cubicCoeffs((fy - y0).toFloat(), wy)
            acc[0] = 0.0
            acc[1] = 0.0
            acc[2] = 0.0
            for (k1 in 0 until 4) {
                val yy = (y0 - 1 + k1).coerceIn(0, h - 1)
                for (k2 in 0 until 4) {
                    val xx = (x0 - 1 + k2).coerceIn(0, w - 1)
                    val wgt = (wy[k1] * wx[k2]).toDouble()
                    val p = (yy * w + xx) * 3
                    acc[0] += (s[p].toInt() and 0xFF) * wgt
                    acc[1] += (s[p + 1].toInt() and 0xFF) * wgt
                    acc[2] += (s[p + 2].toInt() and 0xFF) * wgt
                }
            }
            val o = (y * cw + x) * 3
            for (c in 0 until 3) out[o + c] = Math.rint(acc[c]).toInt().coerceIn(0, 255).toByte()
        }
    }
    return BgrImage(cw, ch, out)
}

/** np.rot90(img)：逆时针转 90°，竖排文字转成横排再送识别。 */
internal fun rot90(img: BgrImage): BgrImage {
    val w = img.width
    val h = img.height
    val out = ByteArray(w * h * 3)
    // 输出 h' = w、w' = h；out[i][j] = img[j][w-1-i]
    for (i in 0 until w) {
        for (j in 0 until h) {
            val si = (j * w + (w - 1 - i)) * 3
            val oi = (i * h + j) * 3
            out[oi] = img.data[si]
            out[oi + 1] = img.data[si + 1]
            out[oi + 2] = img.data[si + 2]
        }
    }
    return BgrImage(h, w, out)
}

/** 四边形各边长度的最大值组合：get_rotate_crop_image 定裁剪宽高的那两行。 */
internal fun quadCropSize(q: Quad): Pair<Int, Int> {
    fun d(i: Int, j: Int) = hypot(q.xs[i] - q.xs[j], q.ys[i] - q.ys[j])
    return max(d(0, 1), d(2, 3)).toInt() to max(d(0, 3), d(1, 2)).toInt()
}

/** numpy 的 np.round / Python 3 的 round(x)：银行家舍入。 */
internal fun roundHalfEven(v: Double): Double = Math.rint(v)

internal fun ceilInt(v: Double): Int = ceil(v).toInt()

/** cv2.resize 定点系数的 1.0：INTER_RESIZE_COEF_SCALE = 2^11。 */
private const val RESIZE_ONE = 2048f

/** pyclipper.PyclipperOffset 的默认 arc_tolerance。 */
private const val ARC_TOLERANCE = 0.25

/** Clipper 源码里的 def_arc_tolerance：容差上限是 |delta| 的四分之一。 */
private const val DEF_ARC_TOLERANCE = 0.25
