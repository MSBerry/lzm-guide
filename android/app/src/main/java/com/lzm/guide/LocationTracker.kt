package com.lzm.guide

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Log

/**
 * 用框架 [LocationManager] 同时听几路定位，挑过一遍再交出去。
 *
 * ## 为什么不用 FusedLocationProviderClient
 * 那是 GMS 的，国内机大多没有。[LocationManager] 哪台机器都在，代价是要自己在几路之间挑点。
 *
 * ## 听哪几路
 * GPS（要 FINE；只给了「大致位置」时不听，否则 requestLocationUpdates 直接抛 SecurityException）、
 * NETWORK、API 31+ 再加 FUSED。机器上没有的那一路跳过。
 *
 * ## 挑点规则
 * - [start] 时先交一次 2 分钟内最新的 lastKnown，页面不用干等首个定位。
 * - 10 秒内已有更准的 GPS 点时，丢掉精度更差的网络 / 融合点：两路交替上来时，
 *   「我在哪」会在图上来回跳。
 *
 * ## 线程约定
 * 回调全在主线程（requestLocationUpdates 传的是主 Looper）。
 */
internal class LocationTracker(
    private val context: Context,
    /** 收下一个点。provider 只会是 `gps` / `network` / `fused`（就是 [LocationManager] 常量的字面值）。 */
    private val onFix: (Location, String) -> Unit,
    /** 某一路被开 / 关了，调用方据此重算状态。 */
    private val onProviderToggled: () -> Unit,
) {
    private val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val listeners = mutableListOf<ProviderListener>()
    private var lastGps: Location? = null

    /** 最近一个被收下的点及其来源，页面重新加载后补推用。跨 [stop] / [start] 保留。 */
    var last: Location? = null
        private set
    var lastProvider: String? = null
        private set

    /** 本轮 [start] 之后收下过点（含 2 分钟内的 lastKnown）。决定状态是 `searching` 还是 `ok`。 */
    var hasFix = false
        private set

    fun hasFinePermission() = granted(Manifest.permission.ACCESS_FINE_LOCATION)

    fun hasAnyPermission() = hasFinePermission() || granted(Manifest.permission.ACCESS_COARSE_LOCATION)

    /** 系统定位总开关。28 以下没有 isLocationEnabled，看有没有任何一路开着。 */
    fun isSystemLocationOn(): Boolean =
        if (Build.VERSION.SDK_INT >= 28) {
            lm.isLocationEnabled
        } else {
            lm.getProviders(true).any { it != LocationManager.PASSIVE_PROVIDER }
        }

    /** 幂等：先停掉上一轮再按当前权限重新订阅。权限变了、系统开关变了都直接再调一次。 */
    @SuppressLint("MissingPermission") // hasAnyPermission / hasFinePermission 已查过
    fun start() {
        stop()
        hasFix = false
        if (!hasAnyPermission()) return

        val wanted = buildList {
            if (hasFinePermission()) add(LocationManager.GPS_PROVIDER)
            add(LocationManager.NETWORK_PROVIDER)
            if (Build.VERSION.SDK_INT >= 31) add(LocationManager.FUSED_PROVIDER)
        }
        val present = lm.allProviders.toSet()
        val providers = wanted.filter { it in present }

        deliverFreshLastKnown(providers)

        for (p in providers) {
            val listener = ProviderListener(p)
            try {
                lm.requestLocationUpdates(p, UPDATE_INTERVAL_MS, 0f, listener, Looper.getMainLooper())
                listeners += listener
            } catch (e: SecurityException) {
                // 查完权限到这里之间被收回（设置页里改的），这一路不听，其余照常
                Log.w(TAG, "订阅定位被拒 provider=$p，跳过这一路", e)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "provider=$p 不可用，跳过这一路", e)
            }
        }
        Log.i(TAG, "开始定位 providers=${listeners.map { it.provider }} fine=${hasFinePermission()}")
    }

    fun stop() {
        for (l in listeners) lm.removeUpdates(l)
        listeners.clear()
    }

    @SuppressLint("MissingPermission") // 只从 start() 里、查过权限之后调
    private fun deliverFreshLastKnown(providers: List<String>) {
        val now = SystemClock.elapsedRealtimeNanos()
        var best: Location? = null
        var bestProvider: String? = null
        for (p in providers) {
            val loc = try {
                lm.getLastKnownLocation(p)
            } catch (e: SecurityException) {
                Log.w(TAG, "读 lastKnown 被拒 provider=$p", e)
                null
            } ?: continue
            if (now - loc.elapsedRealtimeNanos > LAST_KNOWN_MAX_AGE_NS) continue
            if (best == null || loc.elapsedRealtimeNanos > best.elapsedRealtimeNanos) {
                best = loc
                bestProvider = p
            }
        }
        if (best != null && bestProvider != null) accept(best, bestProvider)
    }

    private fun accept(loc: Location, provider: String) {
        if (provider == LocationManager.GPS_PROVIDER) {
            lastGps = loc
        } else {
            val gps = lastGps
            val gpsAgeNs = gps?.let { SystemClock.elapsedRealtimeNanos() - it.elapsedRealtimeNanos }
            if (gps != null && gpsAgeNs != null && gpsAgeNs < GPS_PRIORITY_NS && gps.hasAccuracy() &&
                (!loc.hasAccuracy() || loc.accuracy > gps.accuracy)
            ) {
                return
            }
        }
        last = loc
        lastProvider = provider
        hasFix = true
        onFix(loc, provider)
    }

    private fun granted(permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** 每一路一个监听器，来源按「订阅的是哪一路」记，不去信 [Location.getProvider] 里填的字符串。 */
    private inner class ProviderListener(val provider: String) : LocationListener {
        override fun onLocationChanged(location: Location) = accept(location, provider)
        override fun onProviderEnabled(provider: String) = onProviderToggled()
        override fun onProviderDisabled(provider: String) = onProviderToggled()

        // ⚠️ 别删：API 30 以前这几个方法在接口里是抽象的，不覆写在老机器上回调时会 AbstractMethodError。
        @Deprecated("API 29 起系统不再回调")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
    }

    private companion object {
        const val TAG = "LzmLocation"

        /** 1 秒一个点：步行导览要的是「人在图上跟着走」，再密就只是费电。 */
        const val UPDATE_INTERVAL_MS = 1000L

        /** lastKnown 超过 2 分钟就不先推：步行 2 分钟能走一两百米，旧点会把人画到别的剧场门口。 */
        const val LAST_KNOWN_MAX_AGE_NS = 120_000_000_000L

        /** GPS 点 10 秒内仍算「新鲜」，期间更差的网络 / 融合点一律丢。超过 10 秒说明 GPS 断了，让网络点接上。 */
        const val GPS_PRIORITY_NS = 10_000_000_000L
    }
}
