package com.choidev.choibuddy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 폰을 켰을 때와 앱을 업데이트했을 때, 짝지은 PC가 있으면 연결 서비스를 다시 띄운다. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val restart = intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        if (restart && Prefs(context).pairings.isNotEmpty()) BridgeService.start(context)
    }
}
