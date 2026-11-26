package com.lzm.guide

import android.content.Context
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.os.SystemClock
import android.util.Log
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * 指南针：输出「手机朝向」的真北顺时针角度 0–360。
 *
 * ## 为什么不用 getOrientation() 的 azimuth
 * ⚠️ 别改回 `SensorManager.getOrientation(R, o); o[0]`：它是设备顶边（+Y）投到水平面的方向。
 * 手机竖着拿（边走边看图最常见）时顶边几乎朝天，水平投影只剩噪声，箭头会乱转。
 * 这里把「顶边 +Y」和「背面 −Z」都用旋转矩阵转到世界坐标，取两者水平分量之**和**：
 * 平放时背面朝地、只剩顶边；竖拿时顶边朝天、只剩背面；中间按倾角平滑过渡。
 * 两轴互相垂直、不会同时竖直；和向量只在「屏幕朝上且顶边后仰过头」这种少见姿势下接近 0，那时不更新。
 *
 * ## 传感器选择
 * TYPE_ROTATION_VECTOR（带陀螺的融合）→ TYPE_GEOMAGNETIC_ROTATION_VECTOR（没陀螺的机器）
 * → 加速度 + 磁力计手算旋转矩阵。三者的世界系 Y 轴都指**磁北**，出口统一加磁偏角转真北。
 *
 * ## 线程约定
 * registerListener 不传 Handler，回调在主线程；[onHeading] 也在主线程调。
 */
internal class HeadingSensor(
    context: Context,
    /** (真北角度 0–360, 传感器精度 0–3)。已按 ≥100 ms 且变化 ≥1° 节流。 */
    private val onHeading: (Float, Int) -> Unit,
) : SensorEventListener {

    private val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val rotationSensor: Sensor? =
        sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
            ?: sm.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR)
    private val accelSensor: Sensor? =
        if (rotationSensor == null) sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) else null
    private val magnetSensor: Sensor? =
        if (rotationSensor == null) sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) else null

    private val rotation = FloatArray(9)
    private val gravity = FloatArray(3)
    private val geomagnetic = FloatArray(3)
    private var hasGravity = false

    // 平滑的是单位方向向量 (东, 北) 而不是角度：直接对角度做低通，359° 和 1° 会被平均成 180°。
    private var smoothEast = 0f
    private var smoothNorth = 0f
    private var hasSmooth = false
    private var lastEventNs = 0L

    private var declination = declinationAt(DEFAULT_LAT, DEFAULT_LON, 0.0)
    private var accuracy = SensorManager.SENSOR_STATUS_UNRELIABLE

    /** 最近一次算出的真北角度；还没算出过是 NaN。 */
    private var heading = Float.NaN
    private var pushedHeading = Float.NaN
    private var pushedAccuracy = -1
    private var pushedAtMs = 0L

    fun start() {
        val ok = if (rotationSensor != null) {
            sm.registerListener(this, rotationSensor, SensorManager.SENSOR_DELAY_GAME)
        } else if (accelSensor != null && magnetSensor != null) {
            sm.registerListener(this, accelSensor, SensorManager.SENSOR_DELAY_GAME) &&
                sm.registerListener(this, magnetSensor, SensorManager.SENSOR_DELAY_GAME)
        } else {
            false
        }
        if (!ok) Log.w(TAG, "没有可用的方向传感器，页面收不到朝向，只能看定位点")
    }

    fun stop() {
        sm.unregisterListener(this)
        // 下次 start 从第一帧重新起步，不拿暂停前的旧向量去和新读数做低通
        hasSmooth = false
        hasGravity = false
    }

    /** 用最近一次定位更新磁偏角。还没定位过时用的是 [DEFAULT_LAT] / [DEFAULT_LON]。 */
    fun updateLocation(loc: Location) {
        declination = declinationAt(loc.latitude, loc.longitude, if (loc.hasAltitude()) loc.altitude else 0.0)
    }

    /** 页面重新加载后补推一次当前朝向，不受节流限制。 */
    fun repush() {
        if (heading.isNaN()) return
        push()
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_ROTATION_VECTOR, Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR -> {
                SensorManager.getRotationMatrixFromVector(rotation, event.values)
                accuracy = event.accuracy
            }
            Sensor.TYPE_ACCELEROMETER -> {
                event.values.copyInto(gravity, endIndex = 3)
                hasGravity = true
                return
            }
            Sensor.TYPE_MAGNETIC_FIELD -> {
                event.values.copyInto(geomagnetic, endIndex = 3)
                accuracy = event.accuracy
                if (!hasGravity || !SensorManager.getRotationMatrix(rotation, null, gravity, geomagnetic)) return
            }
            else -> return
        }
        onRotation(event.timestamp)
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
        if (sensor == rotationSensor || sensor == magnetSensor) this.accuracy = accuracy
    }

    private fun onRotation(timestampNs: Long) {
        // R 行优先，world = R · device。设备 +Y 映到世界是第 1 列 (R1, R4, R7)，
        // 设备 −Z 是第 2 列取反 (−R2, −R5, −R8)；只要水平的东 / 北两个分量。
        val east = rotation[1] - rotation[2]
        val north = rotation[4] - rotation[5]
        val norm = hypot(east, north)
        if (norm < MIN_HORIZONTAL) return
        val unitEast = east / norm
        val unitNorth = north / norm

        if (!hasSmooth) {
            smoothEast = unitEast
            smoothNorth = unitNorth
            hasSmooth = true
        } else {
            val dt = ((timestampNs - lastEventNs) / 1e9f).coerceIn(0f, MAX_DT_S)
            val alpha = dt / (SMOOTH_TAU_S + dt)
            smoothEast += alpha * (unitEast - smoothEast)
            smoothNorth += alpha * (unitNorth - smoothNorth)
        }
        lastEventNs = timestampNs
        // 短时间内转了近 180° 时两向量会互相抵消，方向不可信，等下一帧
        if (hypot(smoothEast, smoothNorth) < MIN_HORIZONTAL) return

        val magneticDeg = Math.toDegrees(atan2(smoothEast, smoothNorth).toDouble())
        heading = (((magneticDeg + declination) % 360.0 + 360.0) % 360.0).toFloat()

        val now = SystemClock.elapsedRealtime()
        if (now - pushedAtMs < PUSH_MIN_INTERVAL_MS) return
        if (!pushedHeading.isNaN() && accuracy == pushedAccuracy &&
            angleDiff(heading, pushedHeading) < PUSH_MIN_DELTA_DEG
        ) {
            return
        }
        push()
    }

    private fun push() {
        pushedHeading = heading
        pushedAccuracy = accuracy
        pushedAtMs = SystemClock.elapsedRealtime()
        onHeading(heading, accuracy.coerceIn(0, 3))
    }

    private companion object {
        const val TAG = "LzmHeading"

        /** 还没定位时算磁偏角用的点：太湖龙之梦一带。磁偏角随地点变，但在景区范围内用这个点足够。 */
        const val DEFAULT_LAT = 31.0
        const val DEFAULT_LON = 120.0

        /** 低通时间常数。经验值，未在真机上调过：大了箭头拖沓，小了走路时晃。 */
        const val SMOOTH_TAU_S = 0.25f

        /** 两帧间隔上限：暂停 / 掉帧后别让一帧把平滑值整个拽过去（alpha 封顶约 0.67）。 */
        const val MAX_DT_S = 0.5f

        /** 水平和向量短于这个长度时方向不可信，不更新（单位向量的 1/10）。 */
        const val MIN_HORIZONTAL = 0.1f

        /** 推给页面的节流：≥100 ms 且变化 ≥1°（精度档位变了也推）。传感器 50 Hz 原样推，页面就得每 20 ms 重绘一次箭头。 */
        const val PUSH_MIN_INTERVAL_MS = 100L
        const val PUSH_MIN_DELTA_DEG = 1f

        fun declinationAt(lat: Double, lon: Double, alt: Double): Float =
            GeomagneticField(lat.toFloat(), lon.toFloat(), alt.toFloat(), System.currentTimeMillis()).declination

        /** 两角度之差的绝对值，按圆周取短的那边（359° 与 1° 差 2°）。 */
        fun angleDiff(a: Float, b: Float): Float {
            val d = abs(a - b) % 360f
            return if (d > 180f) 360f - d else d
        }
    }
}
