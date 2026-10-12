package com.choidev.choibuddy

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf

/** 알림 채널과 알림. 문구는 모두 [localized]로 고른 언어의 strings.xml에서 읽는다. */
object Notifications {
    const val STATUS_ID = 1

    // 승인 알림은 태그=pendingId, 끝 알림은 태그=sessionId로 구분한다. 해시 충돌 없이 요청마다 알림 하나가 된다.
    private const val PENDING_ID = 2
    private const val FINISHED_ID = 3

    private const val STATUS_CHANNEL = "status"
    private const val PENDING_CHANNEL = "pending"
    // 0.5.4까지는 "finished"(중요도 보통)라 화면 위에 뜨지 않았다. 채널 중요도는 만든 뒤 앱이 올릴 수 없어 새 채널로 옮긴다.
    private const val FINISHED_CHANNEL = "finished_popup"
    private const val OLD_FINISHED_CHANNEL = "finished"

    // 알림과 버튼 인텐트에 함께 싣는다. 앱 프로세스가 새로 떠도 어느 PC의 알림인지, 결정을 어디로 보낼지 안다.
    private const val EXTRA_ID = "pendingId"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_BEHAVIOR = "behavior"
    private const val EXTRA_BASE_URL = "choibuddy.baseUrl"
    private const val EXTRA_PC = "choibuddy.pcKey"

    /** 버튼을 누른 승인 알림을 되읽은 것. */
    data class Decision(val notice: Notice.Pending, val behavior: Behavior, val route: PendingRoutes.Route)

    /** 이미 있는 채널에 다시 부르면 이름·설명만 바뀐다(언어를 바꿨을 때). */
    fun createChannels(context: Context) {
        val text = context.localized()
        val channels = listOf(
            channel(text, STATUS_CHANNEL, R.string.channel_status, R.string.channel_status_description, NotificationManager.IMPORTANCE_LOW),
            channel(text, PENDING_CHANNEL, R.string.channel_pending, R.string.channel_pending_description, NotificationManager.IMPORTANCE_HIGH),
            channel(text, FINISHED_CHANNEL, R.string.channel_finished, R.string.channel_finished_description, NotificationManager.IMPORTANCE_HIGH),
        )
        val manager = context.getSystemService(NotificationManager::class.java)

        manager.deleteNotificationChannel(OLD_FINISHED_CHANNEL)
        manager.createNotificationChannels(channels)
    }

    /** 첫 줄이 제목, 거절된 PC가 더 있으면 다음 줄들이 본문이 된다. */
    fun status(context: Context, status: FleetStatus): Notification {
        val lines = statusLines(context.localized(), status)
        val builder = NotificationCompat.Builder(context, STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_buddy)
            .setContentTitle(lines.first())
            .setContentIntent(openApp(context))
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (lines.size > 1) {
            val rest = lines.drop(1).joinToString("\n")
            builder.setContentText(rest).setStyle(NotificationCompat.BigTextStyle().bigText(rest))
        }

        return builder.build()
    }

    fun updateStatus(context: Context, status: FleetStatus) = post(context, null, STATUS_ID, status(context, status))

    fun showPending(context: Context, notice: Notice.Pending, route: PendingRoutes.Route) {
        val text = context.localized()
        val body = if (notice.sendFailed) text.getString(R.string.send_failed, notice.text) else notice.text
        val builder = NotificationCompat.Builder(context, PENDING_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_buddy)
            .setContentTitle(notice.title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            // 같은 요청을 다시 올릴 때(문구 보강, 전송 실패, 재연결 직후)는 소리 없이 내용만 바꾼다.
            .setOnlyAlertOnce(true)
            .addExtras(bundleOf(EXTRA_BASE_URL to route.baseUrl, EXTRA_PC to route.pcKey))
        for (behavior in notice.buttons) {
            val label = text.getString(if (behavior == Behavior.ALLOW) R.string.action_allow else R.string.action_deny)
            val action = NotificationCompat.Action.Builder(null, label, decide(context, notice, behavior, route))
                // 잠금 화면에서 허용은 잠금을 푼 뒤에만 보낸다. 거부는 바로 보내도 안전하다.
                .setAuthenticationRequired(behavior == Behavior.ALLOW)
                .build()
            builder.addAction(action)
        }
        if (notice.buttons.isEmpty()) builder.addAction(0, text.getString(R.string.action_open), openApp(context))

        post(context, notice.pendingId, PENDING_ID, builder.build())
    }

    /** 아직 떠 있을 때만 내용을 바꾼다. 사용자가 지운 알림은 되살리지 않는다. */
    fun refreshPending(context: Context, notice: Notice.Pending, route: PendingRoutes.Route) {
        val shown = active(context).any { it.id == PENDING_ID && it.tag == notice.pendingId }

        if (shown) showPending(context, notice, route)
    }

    fun cancelPending(context: Context, pendingId: String) {
        NotificationManagerCompat.from(context).cancel(pendingId, PENDING_ID)
    }

    /** [pcKey] PC의 승인 알림 가운데 그 PC의 스냅샷([live])에 더는 없는 것을 내린다. 다른 PC의 알림은 건드리지 않는다. */
    fun withdrawStale(context: Context, pcKey: String, live: Set<String>) {
        val shown = active(context).mapNotNull {
            if (it.id == PENDING_ID && it.notification.extras.getString(EXTRA_PC) == pcKey) it.tag else null
        }
        for (pendingId in AlertPlanner.stale(shown, live)) cancelPending(context, pendingId)
    }

    fun showFinished(context: Context, notice: Notice.Finished, baseUrl: String) {
        val notification = NotificationCompat.Builder(context, FINISHED_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_buddy)
            .setContentTitle(notice.title)
            .setContentText(notice.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .addExtras(bundleOf(EXTRA_BASE_URL to baseUrl))
            .build()

        post(context, notice.sessionId, FINISHED_ID, notification)
    }

    /** 연결 하나를 지울 때 그 연결로 받은 승인·작업 알림을 내린다. */
    fun cancelFor(context: Context, baseUrl: String) {
        val manager = NotificationManagerCompat.from(context)
        for (shown in active(context)) {
            if (shown.id != STATUS_ID && shown.notification.extras.getString(EXTRA_BASE_URL) == baseUrl) {
                manager.cancel(shown.tag, shown.id)
            }
        }
    }

    /** [DecisionReceiver]가 받은 버튼 인텐트를 되읽는다. 버튼은 permission 요청에만 있다. */
    fun decisionOf(intent: Intent): Decision? {
        val pendingId = intent.getStringExtra(EXTRA_ID) ?: return null
        val behavior = intent.getStringExtra(EXTRA_BEHAVIOR)?.let(Behavior::valueOf) ?: return null
        val baseUrl = intent.getStringExtra(EXTRA_BASE_URL) ?: return null
        val notice = Notice.Pending(
            pendingId = pendingId,
            title = intent.getStringExtra(EXTRA_TITLE).orEmpty(),
            text = intent.getStringExtra(EXTRA_TEXT).orEmpty(),
            buttons = AlertPlanner.buttonsFor(PendingKind.PERMISSION),
        )

        return Decision(notice, behavior, PendingRoutes.Route(baseUrl, intent.getStringExtra(EXTRA_PC) ?: baseUrl))
    }

    private fun statusLines(text: Context, status: FleetStatus): List<String> {
        val resources = text.resources
        val sessions = resources.getQuantityString(R.plurals.status_sessions, status.sessions, status.sessions)
        val main = when {
            status.pcs == 1 -> text.getString(R.string.status_one_pc) + " · " + sessions
            status.pcs > 1 -> resources.getQuantityString(R.plurals.status_pcs, status.pcs, status.pcs) + " · " + sessions
            status.connecting || status.rejectedHosts.isEmpty() -> text.getString(R.string.status_connecting)
            else -> null
        }

        return listOfNotNull(main) + status.rejectedHosts.map { text.getString(R.string.status_rejected_host, it) }
    }

    private fun active(context: Context) = context.getSystemService(NotificationManager::class.java).activeNotifications

    private fun channel(text: Context, id: String, name: Int, description: Int, importance: Int) =
        NotificationChannel(id, text.getString(name), importance).apply { this.description = text.getString(description) }

    private fun decide(context: Context, notice: Notice.Pending, behavior: Behavior, route: PendingRoutes.Route): PendingIntent {
        val intent = Intent(context, DecisionReceiver::class.java)
            // PendingIntent는 extras를 비교하지 않는다. 요청·버튼마다 data를 달리해 서로 덮어쓰지 않게 한다.
            .setData(Uri.fromParts("decision", notice.pendingId, behavior.wire))
            .putExtra(EXTRA_ID, notice.pendingId)
            .putExtra(EXTRA_TITLE, notice.title)
            .putExtra(EXTRA_TEXT, notice.text)
            .putExtra(EXTRA_BEHAVIOR, behavior.name)
            .putExtra(EXTRA_BASE_URL, route.baseUrl)
            .putExtra(EXTRA_PC, route.pcKey)

        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun post(context: Context, tag: String?, id: Int, notification: Notification) {
        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) return

        NotificationManagerCompat.from(context).notify(tag, id, notification)
    }
}
