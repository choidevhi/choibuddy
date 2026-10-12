package com.choidev.choibuddy

import android.appwidget.AppWidgetManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * WebView 안 UI가 `window.ChoiBuddyNative`로 부르는 메서드.
 * WebView의 JS 스레드에서 불리므로 화면을 건드리는 일은 [MainActivity]가 메인 스레드로 넘긴다.
 */
class NativeBridge(private val activity: MainActivity) {
    private val prefs = Prefs(activity)

    @JavascriptInterface
    fun platform(): String = "android"

    /** 짝지은 PC 전부: `[{"baseUrl":…,"token":…}]`, 없으면 `[]`. */
    @JavascriptInterface
    fun getConfigs(): String = Wire.pairingsJson(prefs.pairings)

    /** 예전 UI용: 첫 PC 하나, 없으면 `null`. */
    @JavascriptInterface
    fun getConfig(): String = prefs.pairings.firstOrNull()
        ?.let { JSONObject().put("baseUrl", it.baseUrl).put("token", it.token).toString() }
        ?: "null"

    /** QR로 PC를 하나 더한다(같은 주소면 기기 코드만 바꾼다). 사람이 앱 안에서 한 일이라 묻지 않는다. */
    @JavascriptInterface
    fun scanPairing() = activity.runOnUiThread(activity::scanPairing)

    /** 붙여 넣은 링크로 PC를 하나 더한다. scanPairing과 같다. */
    @JavascriptInterface
    fun setPairing(link: String): Boolean = activity.applyPairing(link)

    @JavascriptInterface
    fun removePairing(baseUrl: String) = activity.removePairing(baseUrl)

    /** 모든 PC 연결을 지운다. */
    @JavascriptInterface
    fun unpair() = activity.unpair()

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) = activity.runOnUiThread { activity.setKeepScreenOn(on) }

    @JavascriptInterface
    fun notificationsAllowed(): Boolean = NotificationManagerCompat.from(activity).areNotificationsEnabled()

    @JavascriptInterface
    fun requestNotifications() = activity.runOnUiThread(activity::requestNotifications)

    @JavascriptInterface
    fun setDoneAlerts(on: Boolean) {
        prefs.doneAlerts = on
    }

    @JavascriptInterface
    fun doneAlerts(): Boolean = prefs.doneAlerts

    /** ko, en, ja, fr 중 하나. 그 밖의 값은 무시한다. 바뀌면 상시 알림과 채널 이름을 그 언어로 다시 올린다. */
    @JavascriptInterface
    fun setLanguage(tag: String) {
        val language = Language.of(tag) ?: return
        if (language == prefs.language) return

        prefs.language = language
        if (prefs.pairings.isNotEmpty()) BridgeService.start(activity)
    }

    /** 클립보드의 사진: `{"name":…,"mime":…,"data":<base64>}`. 사진이 없거나 20MB를 넘거나 읽지 못하면 `null`. */
    @JavascriptInterface
    fun clipboardImage(): String = Photos.fromClipboard(activity) ?: "null"

    /** https 링크를 휴대폰 브라우저로 연다(업데이트 APK 내려받기). https가 아니면 false. */
    @JavascriptInterface
    fun openUrl(url: String): Boolean {
        val uri = Uri.parse(url)

        if (uri.scheme != "https") return false
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (e: ActivityNotFoundException) {
                Log.w("NativeBridge", "no browser for $url", e)
            }
        }

        return true
    }

    /** Tailscale 앱이 깔려 있으면 true. 휴대폰은 Tailscale로 PC에 닿는다. */
    @JavascriptInterface
    fun tailscaleInstalled(): Boolean = Tailscale.installed(activity)

    /** Tailscale을 연다. 없으면 Play 스토어의 Tailscale 페이지를 연다. */
    @JavascriptInterface
    fun openTailscale() = activity.runOnUiThread { Tailscale.open(activity) }

    /** 런처에 홈 화면 위젯을 놓아 달라고 한다. 런처가 못 하면 false이고, UI가 위젯 목록에서 고르라고 안내한다. */
    @JavascriptInterface
    fun pinWidget(): Boolean {
        val manager = AppWidgetManager.getInstance(activity)

        return manager.isRequestPinAppWidgetSupported &&
            manager.requestPinAppWidget(ComponentName(activity, BuddyWidget::class.java), null, null)
    }

    /** 사진을 Pictures/ChoiBuddy에 저장하고 토스트로 알린다. 저장했으면 true, 사진 MIME이 아니면 false. */
    @JavascriptInterface
    fun saveImage(base64: String, name: String, mime: String): Boolean = activity.saveImage(base64, name, mime)
}
