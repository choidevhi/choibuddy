package com.choidev.choibuddy

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * 위젯을 런처처럼 RemoteViews.apply로 펼쳐 실제 Android 그리기 코드로 PNG에 그린다.
 * RemoteViews가 받지 않는 뷰나 속성을 쓰면 여기서 바로 실패한다. 그림은 build/widget-shots/에 남는다.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WidgetRenderTest {
    private val out = File("build/widget-shots").apply { mkdirs() }

    private val working = WidgetModel(
        state = WidgetState.ACTIVE,
        main = WidgetRow("a", "korus", null, SessionStatus.WORKING, Pose.BASH, "Bash · pnpm vitest run src/invoice.test.ts", System.currentTimeMillis() - 195_000, 0),
        others = listOf(
            WidgetRow("b", "shop-web", null, SessionStatus.WAITING, Pose.WARNING, "", 0, 0),
            WidgetRow("c", "api", null, SessionStatus.DONE, Pose.DONE, "", 0, 0),
        ),
        fiveHour = 23,
        weekly = 71,
    )

    private val finished = WidgetModel(
        state = WidgetState.ACTIVE,
        main = WidgetRow("a", "korus", "STUDIO-PC", SessionStatus.DONE, Pose.DONE, "All 46 tests pass. The VAT table now has 2026 rates.", 0, 1_760_000_000_000),
        others = emptyList(),
        fiveHour = 88,
        weekly = 40,
    )

    private val resting = WidgetModel(WidgetState.RESTING, null, emptyList(), 5, 12)

    @Test
    fun drawsEveryStateAndSizeInBothThemes() {
        for (theme in listOf("notnight", "night")) {
            RuntimeEnvironment.setQualifiers("w411dp-h891dp-$theme-xxhdpi")
            shot("working-large-$theme", working, WidgetSize.LARGE, 330, 190)
            shot("working-medium-$theme", working, WidgetSize.MEDIUM, 330, 120)
            shot("working-small-$theme", working, WidgetSize.SMALL, 250, 76)
            shot("done-medium-$theme", finished, WidgetSize.MEDIUM, 330, 120)
            shot("resting-medium-$theme", resting, WidgetSize.MEDIUM, 330, 120)
            shot("offline-small-$theme", WidgetPlanner.OFFLINE, WidgetSize.SMALL, 250, 76)
        }

        // 앱 언어를 따로 고르지 않았으면 기기 언어로 그린다.
        for (theme in listOf("notnight", "night")) {
            RuntimeEnvironment.setQualifiers("ko-rKR-w411dp-h891dp-$theme-xxhdpi")
            shot("ko-working-large-$theme", working, WidgetSize.LARGE, 330, 190)
            shot("ko-done-medium-$theme", finished, WidgetSize.MEDIUM, 330, 120)
            shot("ko-offline-small-$theme", WidgetPlanner.OFFLINE, WidgetSize.SMALL, 250, 76)
        }
    }

    @Test
    fun hidesWhatTheSizeHasNoRoomFor() {
        val context = RuntimeEnvironment.getApplication()
        val small = Widgets.render(context, working, WidgetSize.SMALL).apply(context, FrameLayout(context))
        val large = Widgets.render(context, working, WidgetSize.LARGE).apply(context, FrameLayout(context))

        assertEquals(View.GONE, small.findViewById<View>(R.id.widget_usage).visibility)
        assertEquals(View.GONE, small.findViewById<View>(R.id.widget_activity).visibility)
        assertEquals(View.GONE, small.findViewById<View>(R.id.widget_others).visibility)
        assertEquals(View.VISIBLE, large.findViewById<View>(R.id.widget_usage).visibility)
        assertEquals(View.VISIBLE, large.findViewById<View>(R.id.widget_other2).visibility)
        assertEquals(View.VISIBLE, large.findViewById<View>(R.id.widget_elapsed).visibility)
        assertEquals(View.GONE, large.findViewById<View>(R.id.widget_time).visibility)
    }

    private fun shot(name: String, model: WidgetModel, size: WidgetSize, widthDp: Int, heightDp: Int) {
        val context = RuntimeEnvironment.getApplication()
        val density = context.resources.displayMetrics.density
        val width = (widthDp * density).toInt()
        val height = (heightDp * density).toInt()
        val parent = FrameLayout(context)
        val view = Widgets.render(context, model, size).apply(context, parent)

        parent.addView(view, FrameLayout.LayoutParams(width, height))
        parent.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        parent.layout(0, 0, width, height)

        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        parent.draw(Canvas(bitmap))
        File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }

        assertTrue(File(out, "$name.png").length() > 0)
    }
}
