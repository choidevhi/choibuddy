package com.choidev.choibuddy

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.time.LocalDateTime
import kotlin.concurrent.thread

/** ui/dist를 띄우는 WebView 한 장짜리 화면. 네이티브 기능은 [NativeBridge]로 연다. */
class MainActivity : ComponentActivity() {
    private lateinit var prefs: Prefs
    private lateinit var webView: WebView
    private val files = FileChooser(this)

    // 페이지가 뜨기 전에 보낸 이벤트(딥 링크로 시작했을 때 등)는 모아 두었다가 로드가 끝나면 보낸다.
    private var pageLoaded = false
    private val queuedScripts = mutableListOf<String>()

    // 뒤로 가기는 먼저 화면에 묻는다. 열린 시트·사진 뷰어·메뉴를 닫거나 이전 탭으로 가면 화면이 true를 돌려준다.
    // 더 돌아갈 곳이 없으면(홈) 시스템 기본 동작대로 앱을 내린다.
    private val goBack = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            webView.evaluateJavascript("window.choibuddyBack?.() === true") { handled ->
                if (handled != "true") leave()
            }
        }
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // 두 번 거절하면 시스템은 더 묻지 않는다. 그때는 앱 알림 설정으로 보낸다.
        if (!granted && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
            openNotificationSettings()
        }
        dispatch("choibuddy-notifications")
    }

    // Android 9 이하는 공유 사진 폴더에 쓰려면 저장소 권한이 있어야 한다. 묻는 동안 저장할 사진을 들고 있다가 허락하면 이어서 저장한다.
    private var imageWaitingForStorage: (() -> Boolean)? = null
    private val askStorage = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val save = imageWaitingForStorage ?: return@registerForActivityResult
        imageWaitingForStorage = null
        if (granted) thread(name = "choibuddy-save-image") { save() } else toast(R.string.image_save_failed)
    }

    // 입력창의 마이크. 듣는 동안의 결과는 `choibuddy-voice` 이벤트로 UI에 간다.
    private val voice by lazy { Voice(this) { detail -> runScript("window.dispatchEvent(new CustomEvent('choibuddy-voice',{detail:$detail}))") } }
    private var voiceLanguage = "ko-KR"
    private val askMicrophone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) voice.start(voiceLanguage) else runScript("window.dispatchEvent(new CustomEvent('choibuddy-voice',{detail:{kind:'denied',text:''}}))")
    }

    /** 듣기 시작한다. 마이크 권한이 없으면 먼저 묻는다. 메인 스레드에서 부른다. */
    fun startVoice(language: String) {
        voiceLanguage = language
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) voice.start(language) else askMicrophone.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun stopVoice() = voice.stop()

    fun voiceAvailable(): Boolean = voice.available()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        applyKeepScreenOn(prefs.keepScreenOn)
        if (savedInstanceState == null) files.clearPhotos()

        webView = createWebView()
        val root = FrameLayout(this)
        root.addView(webView, MATCH_PARENT, MATCH_PARENT)
        // 바는 투명하게 두고 내용만 바·카메라 구멍·키보드를 피한다. 바 뒤로는 창 배경(#0b0b0d)이 보인다.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, goBack)

        if (savedInstanceState == null) handleIntent(intent)
        webView.loadUrl(START_URL)
        if (prefs.pairings.isNotEmpty()) BridgeService.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        visible = true
    }

    override fun onStop() {
        visible = false
        super.onStop()
    }

    override fun onDestroy() {
        voice.destroy()
        webView.destroy()
        super.onDestroy()
    }

    /** PC를 하나 더한다(같은 주소면 기기 코드만 바꾼다). 아무 스레드에서나 불린다(JS, QR 결과, 딥 링크 확인). */
    fun applyPairing(link: String): Boolean {
        val pairing = Pairing.parse(link)
        if (pairing == null) {
            toast(R.string.toast_invalid_pairing)
            return false
        }

        add(pairing)

        return true
    }

    fun removePairing(baseUrl: String) {
        prefs.removePairing(baseUrl)
        Notifications.cancelFor(this, baseUrl)
        if (prefs.pairings.isEmpty()) BridgeService.stop(this) else BridgeService.start(this)
        dispatch("choibuddy-config")
    }

    fun unpair() {
        prefs.clearPairings()
        BridgeService.stop(this)
        NotificationManagerCompat.from(this).cancelAll()
        dispatch("choibuddy-config")
    }

    fun scanPairing() {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { applyPairing(it.rawValue.orEmpty()) }
            .addOnFailureListener { error ->
                Log.w(TAG, "QR scanner failed", error)
                toast(R.string.toast_scanner_unavailable)
            }
    }

    fun setKeepScreenOn(on: Boolean) {
        prefs.keepScreenOn = on
        applyKeepScreenOn(on)
    }

    fun requestNotifications() {
        val needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        when {
            needsPermission -> askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            NotificationManagerCompat.from(this).areNotificationsEnabled() -> dispatch("choibuddy-notifications")
            else -> openNotificationSettings()
        }
    }

    /**
     * JS가 넘긴 사진을 Pictures/ChoiBuddy에 저장하고 토스트로 알린다. JS 스레드에서 불리므로 파일도 이 스레드에서 쓴다.
     * 저장했으면 true. Android 9 이하에서 저장소 권한을 묻는 중이면 false이고, 허락받으면 이어서 저장한다.
     */
    fun saveImage(base64: String, name: String, mime: String): Boolean {
        val type = ImageFiles.imageMime(mime)
        val bytes = type?.let { ImageFiles.decode(base64) }
        if (type == null || bytes == null) {
            toast(R.string.image_save_failed)
            return false
        }

        val fileName = ImageFiles.fileName(name, type, ImageFiles.stamped("choibuddy", LocalDateTime.now()))
        val save = {
            Photos.save(this, bytes, fileName, type).also { saved ->
                toast(if (saved) R.string.image_saved else R.string.image_save_failed)
            }
        }
        val needsPermission = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        if (needsPermission) {
            runOnUiThread {
                imageWaitingForStorage = save
                askStorage.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
            return false
        }

        return save()
    }

    // Any web page or app can fire a choibuddy:// link, and links add PCs, so
    // always ask before pairing. QR scans and pasted links come from inside the app.
    private fun handleIntent(intent: Intent) {
        if (intent.action != Intent.ACTION_VIEW) return

        val pairing = intent.dataString?.let(Pairing::parse)
        if (pairing == null) {
            toast(R.string.toast_invalid_pairing)
            return
        }

        val text = localized()
        AlertDialog.Builder(this)
            .setTitle(text.getString(R.string.pair_dialog_title))
            .setMessage(pairing.address)
            .setPositiveButton(text.getString(R.string.pair_dialog_confirm)) { _, _ -> add(pairing) }
            .setNegativeButton(text.getString(R.string.pair_dialog_cancel), null)
            .show()
    }

    private fun leave() {
        goBack.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        goBack.isEnabled = true
    }

    private fun add(pairing: Pairing) {
        prefs.addPairing(pairing)
        BridgeService.start(this)
        dispatch("choibuddy-config")
    }

    private fun applyKeepScreenOn(on: Boolean) {
        if (on) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun openNotificationSettings() {
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    private fun dispatch(event: String) = runScript("window.dispatchEvent(new Event('$event'))")

    private fun toast(@StringRes text: Int) {
        val message = JSONObject.quote(localized().getString(text))
        runScript("window.dispatchEvent(new CustomEvent('choibuddy-toast',{detail:$message}))")
    }

    private fun runScript(script: String) = runOnUiThread {
        if (pageLoaded) webView.evaluateJavascript(script, null) else queuedScripts += script
    }

    // UI 자체가 JS 앱이다. 앱에 묶인 asset 밖으로는 이동하지 않으므로 JS 인터페이스가 다른 페이지에 열리지 않는다.
    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        return WebView(this).apply {
            setBackgroundColor(getColor(R.color.background))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // UI는 https(앱 asset)이고 브리지는 Tailscale 안의 http다.
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(NativeBridge(this@MainActivity), "ChoiBuddyNative")
            webViewClient = ShellClient(assets)
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams,
                ): Boolean {
                    files.show(callback, params)
                    return true
                }
            }
        }
    }

    private inner class ShellClient(private val assets: WebViewAssetLoader) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            assets.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false

            // 바깥 링크(그리고 choibuddy:// 링크)는 시스템에 넘긴다.
            try {
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "no app for ${request.url.scheme}", e)
            }

            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            pageLoaded = true
            for (script in queuedScripts) view.evaluateJavascript(script, null)
            queuedScripts.clear()
        }
    }

    companion object {
        private const val TAG = "MainActivity"
        private const val START_URL = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/ui/index.html"

        /** 화면이 보이는 동안 true. 그동안은 화면 안 UI가 알리므로 서비스는 알림을 띄우지 않는다. */
        @Volatile
        var visible = false
            private set
    }
}
