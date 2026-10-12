package com.choidev.choibuddy

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/** 휴대폰은 Tailscale로 PC의 브리지에 닿는다. 설치는 Play 스토어에서, 로그인은 Tailscale 앱에서 한다. */
object Tailscale {
    const val PACKAGE = "com.tailscale.ipn"

    fun installed(context: Context): Boolean = context.packageManager.getLaunchIntentForPackage(PACKAGE) != null

    /** 깔려 있으면 Tailscale을 열고, 없으면 Play 스토어의 Tailscale 페이지를 연다(스토어 앱이 없으면 웹). */
    fun open(context: Context) {
        val launch = context.packageManager.getLaunchIntentForPackage(PACKAGE)
        val store = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$PACKAGE"))

        try {
            context.startActivity(launch ?: store)
        } catch (e: ActivityNotFoundException) {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$PACKAGE")))
        }
    }
}
