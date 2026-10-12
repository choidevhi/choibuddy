package com.choidev.choibuddy

import android.content.Context
import androidx.core.content.edit

/** 앱 설정. 기기 코드는 이 폰에만 두는 로컬 값이라 private 저장소에 두고, 백업은 매니페스트에서 껐다. */
class Prefs(context: Context) {
    private val store = context.getSharedPreferences("choibuddy", Context.MODE_PRIVATE)

    /** 짝지은 PC들. 처음 읽을 때 0.2의 연결 하나를 목록으로 옮긴다. */
    val pairings: List<Pairing>
        get() = synchronized(LOCK) {
            val legacyUrl = store.getString(LEGACY_BASE_URL, null)
            val legacyToken = store.getString(LEGACY_TOKEN, null)
            val legacy = if (legacyUrl != null && legacyToken != null) Pairing(legacyUrl, legacyToken) else null
            val list = Pairings.migrate(store.getString(PAIRINGS, null), legacy)
            if (legacyUrl != null || legacyToken != null) {
                store.edit {
                    putString(PAIRINGS, Wire.pairingsJson(list))
                    remove(LEGACY_BASE_URL)
                    remove(LEGACY_TOKEN)
                }
            }

            list
        }

    // JS 스레드·QR 결과·딥 링크가 동시에 고칠 수 있어 읽고 고쳐 쓰는 동안 잠근다.
    fun addPairing(pairing: Pairing) = updatePairings { Pairings.add(it, pairing) }

    fun removePairing(baseUrl: String) = updatePairings { Pairings.remove(it, baseUrl) }

    fun clearPairings() = updatePairings { emptyList() }

    var keepScreenOn: Boolean
        get() = store.getBoolean(KEEP_SCREEN_ON, false)
        set(value) = store.edit { putBoolean(KEEP_SCREEN_ON, value) }

    var doneAlerts: Boolean
        get() = store.getBoolean(DONE_ALERTS, true)
        set(value) = store.edit { putBoolean(DONE_ALERTS, value) }

    /** null이면 시스템 언어를 따른다. */
    var language: Language?
        get() = Language.of(store.getString(LANGUAGE, null))
        set(value) = store.edit { putString(LANGUAGE, value?.tag) }

    private fun updatePairings(change: (List<Pairing>) -> List<Pairing>) {
        synchronized(LOCK) {
            val next = change(pairings)
            store.edit { putString(PAIRINGS, Wire.pairingsJson(next)) }
        }
    }

    private companion object {
        val LOCK = Any()
        const val PAIRINGS = "pairings"
        const val LEGACY_BASE_URL = "baseUrl"
        const val LEGACY_TOKEN = "token"
        const val KEEP_SCREEN_ON = "keepScreenOn"
        const val DONE_ALERTS = "doneAlerts"
        const val LANGUAGE = "language"
    }
}
