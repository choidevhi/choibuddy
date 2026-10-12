package com.choidev.choibuddy

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.net.Uri
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File

/**
 * WebView의 `<input type="file">`. 시스템 문서 선택기로 파일을 고르거나 카메라로 바로 찍는다.
 * WebView는 콜백이 한 번 불려야 다음 선택을 받으므로, 어떤 길로 끝나든(취소 포함) [finish]를 꼭 한 번 부른다.
 * 결과 런처를 등록해야 해서 액티비티가 만들어질 때(onCreate 전) 함께 만든다.
 */
class FileChooser(private val activity: ComponentActivity) {
    private var callback: ValueCallback<Array<Uri>>? = null
    private var photo: Uri? = null

    private val pickOne = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        finish(uri?.let { arrayOf(it) })
    }

    private val pickMany = activity.registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        finish(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    private val takePhoto = activity.registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        finish(photo?.takeIf { saved }?.let { arrayOf(it) })
    }

    private val photoDir get() = File(activity.cacheDir, PHOTO_DIR)

    fun show(callback: ValueCallback<Array<Uri>>, params: FileChooserParams) {
        finish(null)
        this.callback = callback

        val mimeTypes = FileAccept.mimeTypes(params.acceptTypes.toList()) { extension ->
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
        }
        val types = mimeTypes.toTypedArray()
        val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
        val pickFiles = { launch { if (multiple) pickMany.launch(types) else pickOne.launch(types) } }
        when {
            !FileAccept.allowsPhoto(mimeTypes) -> pickFiles()
            params.isCaptureEnabled -> launchCamera()
            else -> {
                val text = activity.localized()
                AlertDialog.Builder(activity)
                    .setItems(arrayOf(text.getString(R.string.attach_files), text.getString(R.string.attach_photo))) { _, which ->
                        if (which == 0) pickFiles() else launchCamera()
                    }
                    .setOnCancelListener { finish(null) }
                    .show()
            }
        }
    }

    /** 앱을 새로 열 때 지난번에 찍은 사진을 지운다. 그때는 이미 올렸거나 버린 사진이다. */
    fun clearPhotos() {
        photoDir.listFiles()?.forEach(File::delete)
    }

    private fun launchCamera() {
        val dir = photoDir.apply { mkdirs() }
        val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".files", file)
        photo = uri
        launch { takePhoto.launch(uri) }
    }

    private fun launch(start: () -> Unit) {
        try {
            start()
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "no app to pick files", e)
            finish(null)
        }
    }

    private fun finish(uris: Array<Uri>?) {
        callback?.onReceiveValue(uris)
        callback = null
    }

    private companion object {
        const val TAG = "FileChooser"
        const val PHOTO_DIR = "camera"
    }
}
