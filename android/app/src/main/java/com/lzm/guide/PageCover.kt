package com.lzm.guide

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 盖在 WebView 上的原生层，两种样子共用一个 View。
 *
 * - **封面**（[showLoading]）：冷启动、重载期间盖住 WebView，页面好了再 [fadeOut]，
 *   免得先闪白或闪出半截页面。
 * - **兜底**（[showFailed]）：主文档自动重载后仍失败时，代替系统的「网页无法打开」错误页。
 *
 * 盖着时吞掉所有触摸，不让点击漏到下面的 WebView（那时下面可能正是系统错误页）。
 */
@SuppressLint("ViewConstructor") // 只在代码里 new，不进 XML
internal class PageCover(context: Context, onReload: () -> Unit) : FrameLayout(context) {

    private val message = TextView(context)
    private val reloadButton = Button(context)

    init {
        setBackgroundColor(context.getColor(R.color.bar_bg))
        isClickable = true

        message.apply {
            setTextColor(context.getColor(R.color.cover_text))
            gravity = Gravity.CENTER
        }
        reloadButton.apply {
            setText(R.string.reload)
            isAllCaps = false
            textSize = 16f
            setTextColor(context.getColor(R.color.icon_fg))
            stateListAnimator = null
            val shape = GradientDrawable().apply {
                cornerRadius = dp(24).toFloat()
                setColor(context.getColor(R.color.icon_bg))
            }
            background = RippleDrawable(ColorStateList.valueOf(RIPPLE), shape, null)
            minWidth = 0
            minimumWidth = 0
            minHeight = 0
            minimumHeight = 0
            setPadding(dp(32), dp(10), dp(32), dp(10))
            setOnClickListener { onReload() }
        }
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            addView(message)
            addView(
                reloadButton,
                LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = dp(24) },
            )
        }
        addView(column, LayoutParams(WRAP, WRAP, Gravity.CENTER))
        showLoading()
    }

    fun showLoading() {
        show()
        message.setText(R.string.app_name)
        message.textSize = 22f
        reloadButton.visibility = GONE
    }

    fun showFailed() {
        show()
        message.setText(R.string.load_failed)
        message.textSize = 16f
        reloadButton.visibility = VISIBLE
    }

    /** 等 [FADE_DELAY_MS] 再用 [FADE_MS] 淡出。中途再调 [showLoading] / [showFailed] 会取消淡出。 */
    fun fadeOut() {
        if (visibility != VISIBLE) return
        animate().cancel()
        animate().alpha(0f)
            .setStartDelay(FADE_DELAY_MS)
            .setDuration(FADE_MS)
            .withEndAction { visibility = GONE } // 被 cancel 时不回调，不会把刚盖上的层又藏掉
            .start()
    }

    private fun show() {
        animate().cancel()
        alpha = 1f
        visibility = VISIBLE
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private companion object {
        const val WRAP = LayoutParams.WRAP_CONTENT
        const val RIPPLE = 0x33FFFFFF

        /**
         * onPageFinished 时 DOM 已就绪，但首帧未必画完；晚 150 ms 再淡出，免得露出半截页面。
         * 值是主窗口定的，没有实测依据。
         */
        const val FADE_DELAY_MS = 150L
        const val FADE_MS = 200L
    }
}
