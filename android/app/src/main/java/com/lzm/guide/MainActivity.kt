package com.lzm.guide

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.util.Locale

/**
 * 全屏 WebView 壳：页面是打进 assets 的 `web/`，原生只补页面拿不好的三样——定位、指南针、海报离线 OCR。
 *
 * ## JS 桥契约（页面按这个写，名字与参数都不许改）
 * 页面 → 原生，`window.AndroidBridge`（见 [JsBridge]）：
 * `isNative()` / `requestLocationPermission()` / `openLocationSettings()` / `setKeepScreenOn(on)`；
 * 海报：`ocrAvailable(): Boolean` / `pickPoster('camera' | 'gallery')` / `deletePoster(posterId)`。
 *
 * 原生 → 页面，全部走 evaluateJavascript、主线程、数字一律 [Locale.US]：
 * - `LZM_onLocation(lat, lon, accuracyM, speedMps, bearingDeg, timeMs, provider)`：WGS-84 原始坐标，
 *   没有的量传 -1，provider 为 `'gps' | 'network' | 'fused'`
 * - `LZM_onHeading(deg, accuracy)`：真北顺时针 0–360，accuracy 为传感器精度 0–3
 * - `LZM_onLocationStatus(status)`：`'denied' | 'disabled' | 'searching' | 'ok'`
 * - `LZM_onPosterProgress(stage)`：`'decoding' | 'detecting' | 'recognizing'`
 * - `LZM_onPosterResult(jsonString)`：**参数是 JSON 字符串**，格式见 [PosterScanner]
 * - 返回键先问 `LZM_onBack()`，返回 true 算页面消费了，否则退出
 *
 * ## 推送时机
 * **只在 onPageFinished 之后推**，之前的直接丢弃（页面函数还没定义）；onPageFinished 时补推
 * 最新状态、最后一个定位与当前朝向，所以丢掉的那些不会丢信息。
 * 海报结果例外：丢了就丢了用户拍的那张，所以页面没好时先存着，onPageFinished 再补推（只留最后一个）。
 *
 * ## 海报
 * ```
 * pickPoster ──> 系统相机 / 相册 ──onActivityResult──> [PosterScanner 后台线程]
 *     decoding ──> 留档 filesDir/posters ──> detecting ──> recognizing ──> LZM_onPosterResult
 *     └── 取消 / 没有相机 App ──> LZM_onPosterResult({ok:false, error:'cancelled'})
 * ```
 * 不申请相机 / 存储权限：拍照交给系统相机写进 [CaptureProvider]，相册走系统选择器给的临时授权。
 * 留档图经 [PosterScanner.serve] 以虚拟 https 地址给页面当 `<img src>`。
 *
 * 调试钩子（只在 debuggable 包里生效）：
 * `adb shell am start -n com.lzm.guide/.MainActivity --es lzm_ocr_test <设备上的图片路径>`，
 * 结果写到 `getExternalFilesDir(null)/ocr_test.json`。
 *
 * ## 封面与兜底（[PageCover]）
 * ```
 * loadIndex ──> [封面] ──onPageFinished──> 150 ms 后淡出
 *                  └── 主文档出错 ──> 300 ms 后自动重载一次 ── 又出错 ──> [兜底：页面没加载出来 + 重新加载]
 *                                                                          └── 点按钮 ──> loadIndex
 * ```
 * 系统错误页自始至终被盖着，用户看不到。Activity 被回收后恢复、渲染进程崩了走 recreate，
 * 都是一个全新实例从 onCreate 起步：新封面、新 WebView、重新 loadIndex，不继承旧实例的状态。
 *
 * ## 生命周期
 * ```
 * onResume ──> 定位 + 传感器 + 系统定位开关广播 开
 * onPause  ──> 全关（进后台不耗电，也不在后台读位置）
 * ```
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var cover: PageCover
    private lateinit var location: LocationTracker
    private lateinit var heading: HeadingSensor
    private lateinit var posters: PosterScanner
    private val ui = Handler(Looper.getMainLooper())

    /** 页面还没好时出来的海报结果，onPageFinished 补推。 */
    private var pendingPosterResult: String? = null

    private var pageReady = false
    private var resumed = false
    private var pushedStatus: String? = null

    /** 本次 [loadIndex] 的主文档出过错。系统错误页也会走 onPageFinished，靠它把那次拦下。 */
    private var loadFailed = false

    /** 自动重载只给一次；页面成功加载后清零。 */
    private var autoRetried = false

    /** 渲染进程没了之后 WebView 除 destroy 外一律不许再碰，onPause / onDestroy 都要看它。 */
    private var webViewReleased = false

    private val retryLoad = Runnable { loadIndex() }

    /** 用户在下拉栏 / 设置里开关系统定位。开了之后重新订阅一遍，不指望关着时订上的那几路自己恢复。 */
    private val providersReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (resumed) location.start()
            refreshStatus()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        location = LocationTracker(this, ::onLocationFix, ::refreshStatus)
        heading = HeadingSensor(this, ::pushHeading)
        posters = PosterScanner(
            this,
            onProgress = { stage -> runOnUiThread { js("window.LZM_onPosterProgress && LZM_onPosterProgress('$stage')") } },
            onResult = { json -> runOnUiThread { pushPosterResult(json) } },
        )

        webView = buildWebView()
        cover = PageCover(this, ::loadIndex)
        val root = FrameLayout(this).apply {
            setBackgroundColor(BAR_COLOR)
            addView(webView, FrameLayout.LayoutParams(MATCH, MATCH))
            addView(cover, FrameLayout.LayoutParams(MATCH, MATCH))
        }
        padForSystemBars(root)
        setContentView(root)
        if (Build.VERSION.SDK_INT >= 29) {
            // 三键导航时系统默认给导航栏叠一层半透明遮罩，底色就不是 #F7EFE3 了
            window.isNavigationBarContrastEnforced = false
        }
        registerBackHandler()

        loadIndex()

        // 定位是这个 App 的核心功能，首次启动直接申请；recreate（渲染进程崩了重建）时不重复弹
        if (savedInstanceState == null && !location.hasAnyPermission()) requestLocationPermissions()

        handleOcrTest(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleOcrTest(intent)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        if (!webViewReleased) webView.onResume()
        location.start()
        heading.start()
        val filter = IntentFilter(LocationManager.PROVIDERS_CHANGED_ACTION)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(providersReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(providersReceiver, filter)
        }
        refreshStatus()
    }

    override fun onPause() {
        resumed = false
        unregisterReceiver(providersReceiver)
        location.stop()
        heading.stop()
        if (!webViewReleased) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        cover.animate().cancel()
        releaseWebView()
        posters.close()
        super.onDestroy()
    }

    // ── WebView ─────────────────────────────────────────

    /** 首次加载、自动重载、兜底页上点「重新加载」都走这里：先盖封面再加载。 */
    private fun loadIndex() {
        if (webViewReleased) return
        ui.removeCallbacks(retryLoad)
        loadFailed = false
        pageReady = false
        cover.showLoading()
        webView.loadUrl(INDEX_URL)
    }

    private fun releaseWebView() {
        if (webViewReleased) return
        webViewReleased = true
        pageReady = false
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        WebView.setWebContentsDebuggingEnabled(true)
        return WebView(this).apply {
            setBackgroundColor(BAR_COLOR)
            // 页面自己处理拖动与双指缩放，系统的过度滚动光晕和滚动条只会捣乱
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true // 页面用 localStorage 存校准点
                textZoom = 100 // 别让系统「字体大小」把布局撑坏
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
            }
            addJavascriptInterface(JsBridge(), "AndroidBridge")
            webViewClient = PageClient()
            webChromeClient = ConsoleClient()
        }
    }

    private inner class PageClient : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            pageReady = false
        }

        override fun onPageFinished(view: WebView, url: String?) {
            // 系统错误页加载完也会走到这里：不算页面好了，也不揭封面
            if (loadFailed) return
            autoRetried = false
            pageReady = true
            pushedStatus = null // 新页面没收到过状态，强制补推
            refreshStatus()
            val loc = location.last
            val provider = location.lastProvider
            if (loc != null && provider != null) pushLocation(loc, provider)
            heading.repush()
            pendingPosterResult?.let {
                pendingPosterResult = null
                pushPosterResult(it)
            }
            cover.fadeOut()
        }

        /** 只认留档图的虚拟地址，其余返回 null 走默认（assets 页面本身不经过这里）。 */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            posters.serve(request.url)

        /**
         * 只管主文档：先盖封面（别让系统错误页露出来），自动重载一次，还失败就换成兜底页。
         * 子资源（图片 / js）出错只记日志，页面自己决定怎么降级。
         */
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            val desc = "code=${error.errorCode} desc=${error.description} url=${request.url}"
            if (!request.isForMainFrame) {
                Log.w(TAG, "子资源加载失败 $desc，不拦")
                return
            }
            loadFailed = true
            pageReady = false
            ui.removeCallbacks(retryLoad)
            if (!autoRetried) {
                autoRetried = true
                Log.w(TAG, "主文档加载失败 $desc，${RETRY_DELAY_MS} ms 后自动重载一次")
                cover.showLoading()
                ui.postDelayed(retryLoad, RETRY_DELAY_MS)
            } else {
                Log.w(TAG, "主文档加载失败 $desc，重载后仍失败，盖兜底页")
                cover.showFailed()
            }
        }

        /** 只有 assets 里的页面留在壳里；外链交给系统浏览器（本 App 没有 INTERNET 权限，留着也打不开）。 */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.scheme == "file") return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "没有能打开外链的应用，忽略 scheme=${uri.scheme}", e)
            }
            return true
        }

        /**
         * 渲染进程被系统杀掉时默认会连带整个 App 崩溃；这里改成重建 Activity、重新加载页面。
         * 返回 true 的代价是这个 WebView 立刻作废：当场 destroy，挂着的重载一并撤掉，
         * 否则 recreate 之前它还会被 onPause 或那次延迟重载碰到。
         */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "WebView 渲染进程退出 didCrash=${detail.didCrash()}，重建页面")
            ui.removeCallbacksAndMessages(null)
            cover.showLoading()
            releaseWebView()
            recreate()
            return true
        }
    }

    private class ConsoleClient : WebChromeClient() {
        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
            val text = "${m.message()} (${m.sourceId()?.substringAfterLast('/')}:${m.lineNumber()})"
            when (m.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.e(WEB_TAG, text)
                ConsoleMessage.MessageLevel.WARNING -> Log.w(WEB_TAG, text)
                ConsoleMessage.MessageLevel.DEBUG, ConsoleMessage.MessageLevel.TIP -> Log.d(WEB_TAG, text)
                else -> Log.i(WEB_TAG, text)
            }
            return true
        }
    }

    /**
     * API 35+（targetSdk 36）强制 edge-to-edge：内容画到系统栏底下、栏本身透明。
     * 根布局按系统栏 / 刘海 / 输入法留白，留出来的那圈露出根布局的 #F7EFE3，看起来就是栏的底色。
     * 34 及以下 DecorView 已经把这些 insets 吃掉了，这里拿到的是 0，等于不生效。
     */
    @Suppress("DEPRECATION") // 30 以下只有 systemWindowInset* 这一套
    private fun padForSystemBars(root: View) {
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime(),
                )
                v.setPadding(i.left, i.top, i.right, i.bottom)
                // 留白已由根布局做掉，返回 CONSUMED：别让 WebView 再收到一份没扣过的 insets、自己再让一次
                WindowInsets.CONSUMED
            } else {
                v.setPadding(
                    insets.systemWindowInsetLeft,
                    insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight,
                    insets.systemWindowInsetBottom,
                )
                insets.consumeSystemWindowInsets()
            }
        }
    }

    // ── 原生 → 页面 ─────────────────────────────────────────

    private fun js(code: String) {
        if (pageReady) webView.evaluateJavascript(code, null)
    }

    private fun onLocationFix(loc: Location, provider: String) {
        heading.updateLocation(loc)
        pushLocation(loc, provider)
        refreshStatus()
    }

    private fun pushLocation(loc: Location, provider: String) {
        js(
            String.format(
                Locale.US,
                "window.LZM_onLocation && LZM_onLocation(%.7f,%.7f,%.1f,%.2f,%.1f,%d,'%s')",
                loc.latitude,
                loc.longitude,
                if (loc.hasAccuracy()) loc.accuracy else -1f,
                if (loc.hasSpeed()) loc.speed else -1f,
                if (loc.hasBearing()) loc.bearing else -1f,
                loc.time,
                provider,
            ),
        )
    }

    private fun pushHeading(deg: Float, accuracy: Int) {
        js(String.format(Locale.US, "window.LZM_onHeading && LZM_onHeading(%.1f,%d)", deg, accuracy))
    }

    private fun currentStatus(): String = when {
        !location.hasAnyPermission() -> "denied"
        !location.isSystemLocationOn() -> "disabled"
        location.hasFix -> "ok"
        else -> "searching"
    }

    /** 状态没变不推；页面还没好时也不记成「已推」，等 onPageFinished 补。 */
    private fun refreshStatus() {
        if (!pageReady) return
        val status = currentStatus()
        if (status == pushedStatus) return
        pushedStatus = status
        js("window.LZM_onLocationStatus && LZM_onLocationStatus('$status')")
    }

    // ── 权限 ─────────────────────────────────────────

    private fun requestLocationPermissions() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ASKED, true).apply()
        requestPermissions(
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
            REQ_LOCATION,
        )
    }

    /**
     * 页面上点「开启定位」。只给了大致位置也再弹一次（系统会弹「改为精确位置」）。
     *
     * 被永久拒绝时系统不再弹框、requestPermissions 静默回一个拒绝，只能送去应用详情页。
     * 判据是「问过 + shouldShowRequestPermissionRationale 为 false」：没问过时它也是 false，
     * 所以要靠 [KEY_ASKED] 区分。
     */
    private fun requestPermissionFromPage() {
        if (location.hasFinePermission()) {
            refreshStatus()
            return
        }
        val asked = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_ASKED, false)
        if (asked && !shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)) {
            Log.i(TAG, "定位权限已被永久拒绝，跳应用详情页")
            startSettings(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        } else {
            requestLocationPermissions()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode != REQ_LOCATION) return
        // 弹框期间 Activity 处于 paused，定位是关着的；已经回到前台的话按新权限重新订阅
        if (resumed) location.start()
        refreshStatus()
    }

    private fun startSettings(intent: Intent) {
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "设置页打不开 action=${intent.action}，退回系统设置首页", e)
            try {
                startActivity(Intent(Settings.ACTION_SETTINGS))
            } catch (e2: ActivityNotFoundException) {
                Log.w(TAG, "系统设置首页也打不开，放弃", e2)
            }
        }
    }

    // ── 海报 ─────────────────────────────────────────

    private fun pushPosterResult(json: String) {
        if (!pageReady) {
            pendingPosterResult = json
            return
        }
        // JSONObject.quote 出来的是合法的 JS 字符串字面量（引号、反斜杠、换行、</ 都已转义）
        js("window.LZM_onPosterResult && LZM_onPosterResult(${JSONObject.quote(json)})")
    }

    private fun startPosterPick(source: String) {
        when (source) {
            "camera" -> {
                val file = CaptureProvider.file(this)
                file.delete() // 上一次的残留不能当成这次拍的
                val uri = CaptureProvider.uri(this)
                val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                    .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                // EXTRA_OUTPUT 里的 Uri 不随 flags 授权，要挂进 ClipData 才会把写权限给到相机
                intent.clipData = ClipData.newRawUri("", uri)
                startForPoster(intent, REQ_CAMERA, "没有可用的相机应用")
            }
            "gallery" -> {
                // 33+ 的系统照片选择器不要任何存储权限；老系统退回 GET_CONTENT，由用户挑选的那张临时授权
                if (Build.VERSION.SDK_INT >= 33) {
                    try {
                        startActivityForResult(Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*"), REQ_GALLERY)
                        return
                    } catch (e: ActivityNotFoundException) {
                        Log.w(TAG, "系统照片选择器不存在，退回 GET_CONTENT", e)
                    }
                }
                val intent = Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE)
                startForPoster(intent, REQ_GALLERY, "没有可用的相册应用")
            }
            else -> {
                Log.w(TAG, "pickPoster 收到未知 source=$source，按取消处理")
                pushPosterResult(PosterScanner.errorJson("cancelled", "未知来源：$source"))
            }
        }
    }

    private fun startForPoster(intent: Intent, requestCode: Int, missing: String) {
        try {
            startActivityForResult(intent, requestCode)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "$missing action=${intent.action}，回 cancelled", e)
            pushPosterResult(PosterScanner.errorJson("cancelled", missing))
        }
    }

    @Deprecated("框架 Activity 只有这一条路；不引 AndroidX 就用不上 Activity Result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        when (requestCode) {
            REQ_CAMERA -> {
                val file = CaptureProvider.file(this)
                // 有的相机写了 EXTRA_OUTPUT 仍回 RESULT_OK 但 data 为空，以文件有没有内容为准
                if (resultCode != RESULT_OK || file.length() == 0L) {
                    file.delete()
                    pushPosterResult(PosterScanner.errorJson("cancelled", "没有拍照"))
                    return
                }
                posters.scan(open = { file.inputStream() }, cleanup = { file.delete() })
            }
            REQ_GALLERY -> {
                val uri = data?.data
                if (resultCode != RESULT_OK || uri == null) {
                    pushPosterResult(PosterScanner.errorJson("cancelled", "没有选图"))
                    return
                }
                posters.scan(open = { contentResolver.openInputStream(uri) ?: throw FileNotFoundException("打不开 $uri") })
            }
            else -> super.onActivityResult(requestCode, resultCode, data)
        }
    }

    /** `am start --es lzm_ocr_test <路径>`：验收对拍用。release 包不响应，免得任何 App 都能借它读本 App 能读的文件。 */
    private fun handleOcrTest(intent: Intent?) {
        val path = intent?.getStringExtra(EXTRA_OCR_TEST) ?: return
        PosterOcr.PROF_THREADS = intent.getIntExtra("lzm_ocr_threads", 0)
        PosterOcr.PROF_XNN = intent.getBooleanExtra("lzm_ocr_xnn", false)
        PosterOcr.PROF_ORT = intent.getBooleanExtra("lzm_ocr_prof", false)
        intent.removeExtra(EXTRA_OCR_TEST) // recreate 时 getIntent() 还是这一个，别再跑一遍
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
        val out = File(getExternalFilesDir(null), "ocr_test.json")
        Log.i(TAG, "OCR 自测开始 src=$path out=${out.absolutePath}")
        posters.runTest(path, out)
    }

    // ── 返回键 ─────────────────────────────────────────

    private fun registerBackHandler() {
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
                handleBack()
            }
        }
    }

    /** API 33+ 不会走到这里（清单里开了 enableOnBackInvokedCallback），由上面的回调接。 */
    @Deprecated("API 33+ 走 OnBackInvokedCallback")
    override fun onBackPressed() {
        handleBack()
    }

    private fun handleBack() {
        if (!pageReady) {
            finish()
            return
        }
        webView.evaluateJavascript("!!(window.LZM_onBack && LZM_onBack())") { result ->
            if (result != "true") finish()
        }
    }

    // ── 页面 → 原生 ─────────────────────────────────────────

    /** 方法跑在 WebView 的 JavaBridge 线程上，凡是碰 UI / Activity 的都切回主线程。 */
    inner class JsBridge {
        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun requestLocationPermission() = runOnUiThread { requestPermissionFromPage() }

        @JavascriptInterface
        fun openLocationSettings() = runOnUiThread { startSettings(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) }

        @JavascriptInterface
        fun setKeepScreenOn(on: Boolean) = runOnUiThread {
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        /** 同步返回，页面据此决定露不露「拍海报」入口。 */
        @JavascriptInterface
        fun ocrAvailable(): Boolean = posters.isAvailable

        /** 结果一律经 LZM_onPosterResult 回来，包括取消。 */
        @JavascriptInterface
        fun pickPoster(source: String) = runOnUiThread { startPosterPick(source) }

        @JavascriptInterface
        fun deletePoster(posterId: String) = posters.deletePoster(posterId)
    }

    private companion object {
        const val TAG = "LzmGuide"
        const val WEB_TAG = "LzmWeb"
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val INDEX_URL = "file:///android_asset/index.html"

        /**
         * 主文档出错后等 300 ms 再重载：用户报过一次加载失败但复现不了、原因未知，
         * 只求错开同一时刻的偶发问题。值是主窗口定的，没有实测依据。
         */
        const val RETRY_DELAY_MS = 300L
        const val REQ_LOCATION = 1
        const val REQ_CAMERA = 2
        const val REQ_GALLERY = 3
        const val EXTRA_OCR_TEST = "lzm_ocr_test"
        const val PREFS = "lzm_guide"
        const val KEY_ASKED = "location_permission_asked"

        /** 与页面底色、res/values/colors.xml 的 bar_bg 同值。 */
        const val BAR_COLOR = 0xFFF7EFE3.toInt()
    }
}
