package com.choidev.choibuddy

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.format.DateFormat
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import java.util.Date

/** 홈 화면 위젯. 내용은 [BridgeService]가 [Widgets.publish]로 밀어 넣고, 시스템이 다시 그려 달라면 마지막 내용을 그린다. */
class BuddyWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = Widgets.draw(context, manager, ids)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
        Widgets.draw(context, manager, intArrayOf(id))
}

/** 위젯 크기에 따라 보이는 줄. 작으면 버디와 상태만, 중간이면 사용량까지, 크면 다른 세션까지. */
enum class WidgetSize { SMALL, MEDIUM, LARGE }

object Widgets {
    // 서비스가 돌지 않으면(앱 프로세스가 새로 떴으면) 연결 없음으로 그린다. 눌러서 앱을 열면 서비스가 다시 붙는다.
    @Volatile
    private var model: WidgetModel = WidgetPlanner.OFFLINE

    private const val MEDIUM_FROM_DP = 110
    private const val LARGE_FROM_DP = 170
    private const val WARN_FROM = 60
    private const val BAD_FROM = 85

    /** 내용이 바뀌었을 때만 다시 그린다. */
    fun publish(context: Context, next: WidgetModel) {
        if (next == model) return

        model = next
        draw(context)
    }

    /** 언어를 바꿨을 때처럼 내용은 그대로여도 다시 그려야 할 때. */
    fun draw(
        context: Context,
        manager: AppWidgetManager = AppWidgetManager.getInstance(context),
        ids: IntArray = manager.getAppWidgetIds(ComponentName(context, BuddyWidget::class.java)),
    ) {
        val current = model

        for (id in ids) manager.updateAppWidget(id, views(context, current, manager.getAppWidgetOptions(id)))
    }

    /** Android 12부터는 크기별 화면을 한 번에 넘기고 런처가 맞는 것을 고른다. 그 전에는 지금 높이로 고른다. */
    fun views(context: Context, model: WidgetModel, options: Bundle?): RemoteViews =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            RemoteViews(
                mapOf(
                    SizeF(110f, 50f) to render(context, model, WidgetSize.SMALL),
                    SizeF(150f, MEDIUM_FROM_DP.toFloat()) to render(context, model, WidgetSize.MEDIUM),
                    SizeF(150f, LARGE_FROM_DP.toFloat()) to render(context, model, WidgetSize.LARGE),
                ),
            )
        } else {
            render(context, model, sizeFor(options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT) ?: 0))
        }

    fun sizeFor(heightDp: Int): WidgetSize = when {
        heightDp <= 0 -> WidgetSize.MEDIUM
        heightDp < MEDIUM_FROM_DP -> WidgetSize.SMALL
        heightDp < LARGE_FROM_DP -> WidgetSize.MEDIUM
        else -> WidgetSize.LARGE
    }

    fun render(context: Context, model: WidgetModel, size: WidgetSize): RemoteViews {
        val text = context.localized()
        val views = RemoteViews(context.packageName, R.layout.widget_buddy)
        val main = model.main

        views.setOnClickPendingIntent(R.id.widget_root, openApp(context))
        views.setImageViewResource(R.id.widget_buddy, drawableOf(model.pose))
        views.setImageViewResource(R.id.widget_dot, dotOf(model.pose))
        views.setTextViewText(R.id.widget_status, text.getString(labelOf(model.pose)))
        views.setTextViewText(R.id.widget_name, main?.let { title(it) } ?: text.getString(R.string.widget_label))

        val activity = when (model.state) {
            WidgetState.OFFLINE -> text.getString(R.string.widget_offline_hint)
            WidgetState.RESTING -> text.getString(R.string.widget_resting_hint)
            WidgetState.ACTIVE -> main?.activity.orEmpty()
        }
        views.setTextViewText(R.id.widget_activity, activity)
        // 한 줄 높이(작은 크기)에는 버디 옆에 이름과 상태만 들어간다.
        views.setViewVisibility(R.id.widget_activity, if (activity.isBlank() || size == WidgetSize.SMALL) View.GONE else View.VISIBLE)

        clock(views, text, main)
        others(views, text, if (size == WidgetSize.LARGE) model.others else emptyList())
        usage(views, text, model, size != WidgetSize.SMALL)

        return views
    }

    // 일하는 동안은 이번 턴이 몇 분째인지 위젯이 스스로 센다. 끝났으면 마지막으로 바뀐 시각을 적는다.
    private fun clock(views: RemoteViews, text: Context, main: WidgetRow?) {
        val busy = main != null && main.status in BUSY
        views.setViewVisibility(R.id.widget_elapsed, if (busy) View.VISIBLE else View.GONE)
        if (busy && main != null) {
            val elapsed = (System.currentTimeMillis() - main.turnStartedAt).coerceAtLeast(0)
            views.setChronometer(R.id.widget_elapsed, SystemClock.elapsedRealtime() - elapsed, null, true)
        } else {
            views.setChronometer(R.id.widget_elapsed, SystemClock.elapsedRealtime(), null, false)
        }

        val at = main?.updatedAt ?: 0
        val showTime = !busy && main != null && at > 0
        views.setViewVisibility(R.id.widget_time, if (showTime) View.VISIBLE else View.GONE)
        if (showTime) views.setTextViewText(R.id.widget_time, DateFormat.getTimeFormat(text).format(Date(at)))
    }

    private fun others(views: RemoteViews, text: Context, rows: List<WidgetRow>) {
        views.setViewVisibility(R.id.widget_others, if (rows.isEmpty()) View.GONE else View.VISIBLE)
        for ((index, slot) in OTHER_SLOTS.withIndex()) {
            val row = rows.getOrNull(index)
            views.setViewVisibility(slot.row, if (row == null) View.GONE else View.VISIBLE)
            if (row == null) continue

            views.setImageViewResource(slot.dot, dotOf(row.pose))
            views.setTextViewText(slot.name, title(row))
            views.setTextViewText(slot.status, text.getString(labelOf(row.pose)))
        }
    }

    private fun usage(views: RemoteViews, text: Context, model: WidgetModel, shown: Boolean) {
        val visible = shown && (model.fiveHour != null || model.weekly != null)
        views.setViewVisibility(R.id.widget_usage, if (visible) View.VISIBLE else View.GONE)
        gauge(views, text, GAUGES[0], model.fiveHour, R.string.widget_five_hour)
        gauge(views, text, GAUGES[1], model.weekly, R.string.widget_weekly)
    }

    private fun gauge(views: RemoteViews, text: Context, gauge: Gauge, percent: Int?, label: Int) {
        val visibility = if (percent == null) View.GONE else View.VISIBLE
        for (id in listOf(gauge.label, gauge.bar, gauge.percent)) views.setViewVisibility(id, visibility)
        if (percent == null) return

        views.setTextViewText(gauge.label, text.getString(label))
        views.setProgressBar(gauge.bar, 100, percent, false)
        views.setTextViewText(gauge.percent, "$percent%")
        // 색 리소스로 넘겨야 런처가 밝은·어두운 테마에 맞는 색을 고른다.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val color = when {
                percent >= BAD_FROM -> R.color.widget_bad
                percent >= WARN_FROM -> R.color.widget_warn
                else -> R.color.widget_accent
            }
            views.setColorStateList(gauge.bar, "setProgressTintList", color)
        }
    }

    private fun title(row: WidgetRow): String = listOfNotNull(row.name.ifBlank { null }, row.pcName).joinToString(" · ")

    private fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE,
    )

    fun dotOf(pose: Pose): Int = when (pose) {
        Pose.WARNING, Pose.QUESTION -> R.drawable.widget_dot_warn
        Pose.DONE -> R.drawable.widget_dot_good
        Pose.FAILED, Pose.DIZZY -> R.drawable.widget_dot_bad
        Pose.CLOSED, Pose.BASE, Pose.COFFEE, Pose.SHRUG -> R.drawable.widget_dot_dim
        else -> R.drawable.widget_dot_accent
    }

    fun drawableOf(pose: Pose): Int = when (pose) {
        Pose.THINK -> R.drawable.buddy_think
        Pose.READ -> R.drawable.buddy_read
        Pose.EDIT -> R.drawable.buddy_edit
        Pose.WRITE -> R.drawable.buddy_write
        Pose.BASH -> R.drawable.buddy_bash
        Pose.SEARCH -> R.drawable.buddy_search
        Pose.WEB -> R.drawable.buddy_web
        Pose.AGENT -> R.drawable.buddy_agent
        Pose.TODO -> R.drawable.buddy_todo
        Pose.QUESTION -> R.drawable.buddy_question
        Pose.PLAN -> R.drawable.buddy_plan
        Pose.MCP -> R.drawable.buddy_mcp
        Pose.WARNING -> R.drawable.buddy_warning
        Pose.FAILED -> R.drawable.buddy_failed
        Pose.DONE -> R.drawable.buddy_done
        Pose.DIZZY -> R.drawable.buddy_dizzy
        Pose.CLOSED -> R.drawable.buddy_closed
        Pose.BASE -> R.drawable.buddy_base
        Pose.COFFEE -> R.drawable.buddy_coffee
        Pose.SHRUG -> R.drawable.buddy_shrug
    }

    fun labelOf(pose: Pose): Int = when (pose) {
        Pose.THINK -> R.string.widget_look_think
        Pose.READ -> R.string.widget_look_read
        Pose.EDIT -> R.string.widget_look_edit
        Pose.WRITE -> R.string.widget_look_write
        Pose.BASH -> R.string.widget_look_bash
        Pose.SEARCH -> R.string.widget_look_search
        Pose.WEB -> R.string.widget_look_web
        Pose.AGENT -> R.string.widget_look_agent
        Pose.TODO -> R.string.widget_look_todo
        Pose.QUESTION -> R.string.widget_look_question
        Pose.PLAN -> R.string.widget_look_plan
        Pose.MCP -> R.string.widget_look_mcp
        Pose.WARNING -> R.string.widget_look_warning
        Pose.FAILED -> R.string.widget_look_failed
        Pose.DONE -> R.string.widget_look_done
        Pose.DIZZY -> R.string.widget_look_dizzy
        Pose.CLOSED -> R.string.widget_look_closed
        Pose.BASE -> R.string.widget_look_base
        Pose.COFFEE -> R.string.widget_look_coffee
        Pose.SHRUG -> R.string.widget_look_shrug
    }

    private val BUSY = setOf(SessionStatus.THINKING, SessionStatus.WORKING, SessionStatus.WAITING)

    private class OtherSlot(val row: Int, val dot: Int, val name: Int, val status: Int)

    private val OTHER_SLOTS = listOf(
        OtherSlot(R.id.widget_other1, R.id.widget_other1_dot, R.id.widget_other1_name, R.id.widget_other1_status),
        OtherSlot(R.id.widget_other2, R.id.widget_other2_dot, R.id.widget_other2_name, R.id.widget_other2_status),
    )

    private class Gauge(val label: Int, val bar: Int, val percent: Int)

    private val GAUGES = listOf(
        Gauge(R.id.widget_five_label, R.id.widget_five_bar, R.id.widget_five_pct),
        Gauge(R.id.widget_week_label, R.id.widget_week_bar, R.id.widget_week_pct),
    )
}
