package com.choidev.choibuddy

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TailscaleTest {
    private val activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    @Test
    fun withoutTailscaleItOpensItsStorePage() {
        assertFalse(Tailscale.installed(activity))

        Tailscale.open(activity)

        val started = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertEquals("market://details?id=com.tailscale.ipn", started.dataString)
    }

    @Test
    fun withTailscaleItOpensTheApp() {
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(Tailscale.PACKAGE)
        val info = ResolveInfo().apply {
            activityInfo = ActivityInfo().apply {
                packageName = Tailscale.PACKAGE
                name = "com.tailscale.ipn.MainActivity"
            }
        }
        shadowOf(activity.packageManager).addResolveInfoForIntent(launcher, info)

        assertTrue(Tailscale.installed(activity))

        Tailscale.open(activity)

        assertEquals(Tailscale.PACKAGE, shadowOf(activity).nextStartedActivity.component?.packageName)
    }
}
