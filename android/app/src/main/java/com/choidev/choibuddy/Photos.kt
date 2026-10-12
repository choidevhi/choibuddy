package com.choidev.choibuddy

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import androidx.annotation.RequiresApi
import java.io.File
import java.io.IOException
import java.time.LocalDateTime
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * 클립보드의 사진을 읽고, 사진을 공유 사진 폴더(Pictures/ChoiBuddy)에 저장한다.
 * 둘 다 JS 스레드에서 불린다. 클립보드는 화면 스레드에서 읽고, 파일 읽기·쓰기는 부른 스레드에서 한다.
 */
object Photos {
    private const val TAG = "Photos"
    private const val ALBUM = "ChoiBuddy"
    private const val UI_TIMEOUT_SECONDS = 2L

    /** 클립보드의 첫 사진을 [ImageFiles.clipboardJson]으로. 사진이 없거나 20MB를 넘거나 읽지 못하면 null. */
    fun fromClipboard(activity: Activity): String? = try {
        // 포커스를 가진 화면만 클립보드를 읽을 수 있고, 예전 Android는 ClipboardManager를 Looper 있는 스레드에서 만들어야 한다.
        val read = FutureTask { activity.getSystemService(ClipboardManager::class.java)?.primaryClip }
        activity.runOnUiThread(read)
        read.get(UI_TIMEOUT_SECONDS, TimeUnit.SECONDS)?.let { image(activity.contentResolver, it) }
    } catch (e: Exception) {
        Log.w(TAG, "could not read clipboard image", e)
        null
    }

    /** [bytes]를 Pictures/ChoiBuddy/[fileName]으로 저장한다. 같은 이름이 있으면 뒤에 번호가 붙는다. */
    fun save(context: Context, bytes: ByteArray, fileName: String, mime: String): Boolean = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveToMediaStore(context.contentResolver, bytes, fileName, mime)
        } else {
            saveToFolder(context, bytes, fileName, mime)
        }
        true
    } catch (e: Exception) {
        Log.w(TAG, "could not save image", e)
        false
    }

    private fun image(resolver: ContentResolver, clip: ClipData): String? {
        val description = clip.description
        val described = (0 until description.mimeTypeCount).firstNotNullOfOrNull {
            ImageFiles.imageMime(description.getMimeType(it))
        }
        for (i in 0 until clip.itemCount) {
            val uri = clip.getItemAt(i).uri?.takeIf { it.scheme == ContentResolver.SCHEME_CONTENT } ?: continue
            val mime = ImageFiles.imageMime(resolver.getType(uri)) ?: described ?: continue
            val bytes = resolver.openInputStream(uri)?.use { ImageFiles.readUpTo(it, ImageFiles.MAX_BYTES) } ?: return null
            val fallback = ImageFiles.stamped("clipboard", LocalDateTime.now())

            return ImageFiles.clipboardJson(ImageFiles.fileName(displayName(resolver, uri), mime, fallback), mime, bytes)
        }

        return null
    }

    // 이름은 덤이다. 못 읽으면 clipboard-<시각>으로 짓는다.
    private fun displayName(resolver: ContentResolver, uri: Uri): String? = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)) else null
        }
    } catch (e: Exception) {
        Log.w(TAG, "no display name for $uri", e)
        null
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun saveToMediaStore(resolver: ContentResolver, bytes: ByteArray, fileName: String, mime: String) {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$ALBUM")
            // 다 쓰기 전에는 갤러리에 반쯤 쓴 파일이 보이지 않게 한다.
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values) ?: throw IOException("MediaStore insert failed")
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IOException("no output stream for $uri")
            resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
    }

    // Android 9 이하는 MediaStore가 폴더를 정해 주지 않는다. 저장소 권한으로 직접 쓰고 미디어 스캐너에 알려 갤러리에 보이게 한다.
    @Suppress("DEPRECATION")
    private fun saveToFolder(context: Context, bytes: ByteArray, fileName: String, mime: String) {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), ALBUM)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create $dir")

        val file = File(dir, ImageFiles.unique(fileName) { File(dir, it).exists() })
        file.writeBytes(bytes)
        MediaScannerConnection.scanFile(context, arrayOf(file.path), arrayOf(mime), null)
    }
}
