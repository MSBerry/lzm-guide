package com.lzm.guide

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * 只暴露一个文件的 ContentProvider：系统相机（ACTION_IMAGE_CAPTURE）把照片写进 [file]。
 *
 * ## 为什么不用 FileProvider
 * 那在 androidx.core 里，为它引一整个 AndroidX 不值；这里只要一个固定路径，openFile 十几行就够。
 *
 * ## 为什么路径写死
 * 相机拍照期间本进程可能被系统回收，回来时是新 Activity 实例，只能靠固定路径找到照片；
 * 一次只会有一个拍照在进行，覆盖写没有问题。
 *
 * 清单里 `exported=false` + `grantUriPermissions=true`：外部 App 只能凭 Intent 上临时授予的权限访问。
 */
internal class CaptureProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = "image/jpeg"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val ctx = context ?: throw FileNotFoundException("provider 未挂上 context")
        if (uri.path != PATH) throw FileNotFoundException("只提供 $PATH，收到 ${uri.path}")
        val f = file(ctx)
        f.parentFile?.mkdirs()
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode))
    }

    /** 少数相机 App 写之前会先 query 一下名字和大小，返回空 cursor 它们会直接报错。 */
    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?,
    ): Cursor? {
        val ctx = context ?: return null
        if (uri.path != PATH) return null
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val f = file(ctx)
        val row = cols.map {
            when (it) {
                OpenableColumns.DISPLAY_NAME -> f.name
                OpenableColumns.SIZE -> f.length()
                else -> null
            }
        }
        return MatrixCursor(cols, 1).apply { addRow(row) }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        private const val PATH = "/capture.jpg"

        fun file(context: Context) = File(File(context.cacheDir, "camera"), "capture.jpg")

        /** authority 与清单里的 `${applicationId}.capture` 同值。 */
        fun uri(context: Context): Uri = Uri.parse("content://${context.packageName}.capture$PATH")
    }
}
