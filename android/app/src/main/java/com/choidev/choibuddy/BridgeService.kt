package com.choidev.choibuddy

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONException

/**
 * 짝지은 PC마다 이벤트 스트림 하나씩을 붙잡고 있는 포그라운드 서비스.
 * 앱 화면이 꺼져 있어도 승인 요청과 작업 끝을 알림으로 띄우고, 홈 화면 위젯을 최신으로 둔다.
 */
class BridgeService : Service() {
    private lateinit var prefs: Prefs
    private lateinit var connectivity: ConnectivityManager

    // 아래는 연결 스레드들과 메인 스레드가 함께 만지므로 this로 잠근다. 순서는 짝지은 순서다.
    private val links = mutableListOf<Link>()
    private val routes = PendingRoutes()

    // alert는 스냅샷보다 먼저 와서 도구 이름 없이 띄운 요청. 그 PC의 다음 스냅샷에서 문구를 채운다.
    private val bare = HashSet<String>()

    @Volatile
    private var status = FleetStatus(pcs = 0, sessions = 0, connecting = true, rejectedHosts = emptyList())

    // 도구 하나마다 스냅샷이 오므로 위젯은 잠깐 모아서 한 번에 그린다.
    private val mainThread = Handler(Looper.getMainLooper())

    @Volatile
    private var widgetQueued = false

    private val network = object : ConnectivityManager.NetworkCallback() {
        // 등록하자마자 지금 네트워크로 한 번 불린다. 그건 건너뛰고, 기본 네트워크가 바뀔 때만 다시 붙는다.
        var skipNext = false

        override fun onAvailable(network: Network) {
            if (skipNext) {
                skipNext = false
            } else {
                synchronized(this@BridgeService) { links.forEach { it.connection.reconnectNow() } }
            }
        }
    }

    /** PC 한 주소와의 연결. 재연결·백오프·상태를 따로 가진다. */
    private inner class Link(val pairing: Pairing) : BridgeConnection.Listener {
        val connection = BridgeConnection(pairing, this)
        var state: LinkState = LinkState.Connecting
        var hostName = ""
        var pcId = ""
        var pendingItems: Map<String, PendingItem> = emptyMap()
        var sessions: List<SessionSummary> = emptyList()
        var limits: List<LimitSummary> = emptyList()
        var catchUp = false

        val pcKey: String get() = pcId.ifBlank { pairing.baseUrl }
        val route: PendingRoutes.Route get() = PendingRoutes.Route(pairing.baseUrl, pcKey)
        val view: LinkView get() = LinkView(pairing.host, pcKey, state)

        override fun onOpen() = synchronized(this@BridgeService) { catchUp = true }

        override fun onDrop(state: LinkState) {
            synchronized(this@BridgeService) {
                if (this !in links) return

                this.state = state
                refreshStatus()
                queueWidget()
            }
        }

        override fun onEvent(event: SseEvent) {
            try {
                when (event.type) {
                    "snapshot" -> onSnapshot(this, Wire.snapshot(event.data))
                    "alert" -> Wire.alert(event.data)?.let { onAlert(this, it) }
                }
            } catch (e: JSONException) {
                Log.w(TAG, "skipped malformed ${event.type} from ${pairing.address}", e)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        connectivity = getSystemService(ConnectivityManager::class.java)
        network.skipNext = connectivity.activeNetwork != null
        connectivity.registerDefaultNetworkCallback(network)
    }

    // 연결 목록이나 언어가 바뀔 때마다 다시 불린다. 채널 이름과 상시 알림을 다시 올리고 연결을 목록에 맞춘다.
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifications.createChannels(this)
        val pairings = prefs.pairings
        if (!enterForeground() || pairings.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }

        sync(pairings)
        // 언어가 바뀌었을 수 있다. 내용은 그대로여도 문구를 다시 그린다.
        Widgets.draw(this)

        return START_STICKY
    }

    override fun onDestroy() {
        synchronized(this) { links.forEach { it.connection.close() } }
        connectivity.unregisterNetworkCallback(network)
        mainThread.removeCallbacksAndMessages(null)
        Widgets.publish(this, WidgetPlanner.OFFLINE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun enterForeground(): Boolean {
        val notification = Notifications.status(this, status)

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(Notifications.STATUS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(Notifications.STATUS_ID, notification)
            }
            true
        } catch (e: IllegalStateException) {
            // Android 12+는 백그라운드에서 포그라운드로 올리는 것을 막을 수 있다(시스템이 서비스를 되살릴 때 등).
            // 그때는 접고, 다음 앱 실행이나 부팅 때 다시 시작한다.
            Log.w(TAG, "foreground start refused", e)
            false
        }
    }

    /** 지워졌거나 코드가 바뀐 연결은 닫고, 새 연결은 연다. 그대로인 연결은 끊지 않는다. */
    @Synchronized
    private fun sync(pairings: List<Pairing>) {
        val gone = links.filter { it.pairing !in pairings }
        for (link in gone) {
            link.connection.close()
            routes.forget(link.pairing.baseUrl)
        }
        links.removeAll(gone)

        val kept = links.associateBy(Link::pairing)
        val next = pairings.map { kept[it] ?: Link(it).also { link -> link.connection.start() } }
        links.clear()
        links.addAll(next)
        refreshStatus()
        queueWidget()
    }

    private fun phrases() = ResourcePhrases(localized())

    /** PC가 여러 대일 때만 제목에 붙일 PC 이름. */
    private fun pcNameOf(link: Link): String? =
        link.hostName.takeIf { it.isNotBlank() && Fleet.namesPcs(links.map(Link::view)) }

    private fun refreshStatus() {
        val next = Fleet.status(links.map(Link::view))
        if (next == status) return

        status = next
        Notifications.updateStatus(this, next)
    }

    // 지운 연결의 스레드가 닫히기 직전에 넘긴 이벤트는 버린다.
    @Synchronized
    private fun onSnapshot(link: Link, snapshot: SnapshotSummary) {
        if (link !in links) return

        link.pcId = snapshot.pcId
        link.hostName = snapshot.hostName
        link.state = LinkState.Connected(snapshot.activeSessions)
        link.pendingItems = snapshot.pending.associateBy(PendingItem::id)
        link.sessions = snapshot.sessions
        link.limits = snapshot.limits
        refreshStatus()
        queueWidget()

        val phrases by lazy { phrases() }
        val pcName = pcNameOf(link)
        if (link.catchUp) {
            link.catchUp = false
            AlertPlanner.missed(snapshot.pending, routes.ids, pcName, MainActivity.visible, phrases)
                .forEach { showPending(it, link.route) }
        }

        val filled = bare.filter(link.pendingItems::containsKey)
        for (id in filled) {
            val route = routes[id] ?: continue
            Notifications.refreshPending(this, AlertPlanner.forItem(link.pendingItems.getValue(id), pcName, phrases), route)
        }
        bare.removeAll(filled.toSet())

        routes.settle(link.pcKey, link.pendingItems.keys)
        Notifications.withdrawStale(this, link.pcKey, link.pendingItems.keys)
    }

    @Synchronized
    private fun onAlert(link: Link, alert: Alert) {
        if (link !in links) return

        val item = alert.pendingId?.let(link.pendingItems::get)
        val notice = AlertPlanner.forAlert(alert, item, pcNameOf(link), MainActivity.visible, prefs.doneAlerts, phrases())
        when (notice) {
            is Notice.Pending -> if (showPending(notice, link.route) && item == null) bare += notice.pendingId
            is Notice.Finished -> {
                val views = links.map(Link::view)
                if (Fleet.isPrimary(links.indexOf(link), views)) Notifications.showFinished(this, notice, link.pairing.baseUrl)
            }

            is Notice.Withdraw -> {
                routes.remove(notice.pendingId)
                bare.remove(notice.pendingId)
                Notifications.cancelPending(this, notice.pendingId)
            }

            null -> Unit
        }
    }

    private fun queueWidget() {
        if (widgetQueued) return

        widgetQueued = true
        mainThread.postDelayed({
            widgetQueued = false
            Widgets.publish(this, widgetModel())
        }, WIDGET_DELAY_MS)
    }

    @Synchronized
    private fun widgetModel(): WidgetModel = WidgetPlanner.plan(
        links.map { WidgetFeed(pcNameOf(it), it.state is LinkState.Connected, it.sessions, it.limits) },
    )

    /** 이미 알린 요청이면(같은 PC의 다른 주소로 다시 온 것 포함) 띄우지 않고 false. */
    private fun showPending(notice: Notice.Pending, route: PendingRoutes.Route): Boolean {
        if (!routes.claim(notice.pendingId, route)) return false

        Notifications.showPending(this, notice, route)

        return true
    }

    companion object {
        private const val TAG = "BridgeService"
        private const val WIDGET_DELAY_MS = 400L

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, BridgeService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, BridgeService::class.java))
        }
    }
}
