package com.choidev.choibuddy

/**
 * 서비스가 보는 연결 하나의 요약.
 * [pcKey]는 스냅샷의 pcId(같은 PC의 다른 주소면 같다)이고, 아직 모르면 연결 주소다.
 */
data class LinkView(val host: String, val pcKey: String, val state: LinkState)

/** 상시 알림 한 장에 담을 전체 상태. [pcs]와 [sessions]는 같은 PC를 한 번만 센다. */
data class FleetStatus(val pcs: Int, val sessions: Int, val connecting: Boolean, val rejectedHosts: List<String>)

/** 여러 PC 연결을 묶어 보는 규칙. 안드로이드 없이 JVM 테스트로 확인한다. */
object Fleet {
    fun status(links: List<LinkView>): FleetStatus {
        val sessionsByPc = LinkedHashMap<String, Int>()
        for (link in links) {
            val state = link.state
            if (state is LinkState.Connected) sessionsByPc.putIfAbsent(link.pcKey, state.sessions)
        }

        return FleetStatus(
            pcs = sessionsByPc.size,
            sessions = sessionsByPc.values.sum(),
            connecting = links.any { it.state == LinkState.Connecting },
            rejectedHosts = links.mapNotNull { if (it.state == LinkState.Rejected) it.host else null }.distinct(),
        )
    }

    /** 서로 다른 PC가 둘 이상일 때만 알림 제목에 PC 이름을 붙인다. */
    fun namesPcs(links: List<LinkView>): Boolean = links.map(LinkView::pcKey).distinct().size > 1

    /** 같은 PC에 여러 주소로 붙어 있으면 그 PC의 연결된 첫 주소만 작업 끝·오류를 알린다(두 번 울리지 않게). */
    fun isPrimary(index: Int, links: List<LinkView>): Boolean {
        val pcKey = links[index].pcKey

        return links.indexOfFirst { it.pcKey == pcKey && it.state is LinkState.Connected } == index
    }
}

/**
 * 알린 승인 요청 id → 그 요청을 받은 연결. [허용]/[거부]는 이 연결(PC)로 보낸다.
 * 요청 id는 브리지가 만든 UUID라 PC가 달라도 겹치지 않으므로, 같은 PC의 다른 주소로 다시 와도 한 번만 알린다.
 */
class PendingRoutes {
    data class Route(val baseUrl: String, val pcKey: String)

    private val routes = HashMap<String, Route>()

    val ids: Set<String> get() = routes.keys

    /** 처음 보는 요청이면 [route]로 기록하고 true. 이미 알린 요청이면 false이고 처음 경로를 그대로 둔다. */
    fun claim(pendingId: String, route: Route): Boolean = routes.putIfAbsent(pendingId, route) == null

    operator fun get(pendingId: String): Route? = routes[pendingId]

    fun remove(pendingId: String) {
        routes.remove(pendingId)
    }

    /** 스냅샷: [pcKey] PC의 요청 가운데 [live]에 없는 것은 끝났으니 잊는다. 다른 PC의 요청은 그대로 둔다. */
    fun settle(pcKey: String, live: Set<String>) {
        routes.entries.removeAll { it.value.pcKey == pcKey && it.key !in live }
    }

    /** 연결을 지웠을 때 그 주소로 받은 요청을 잊는다. */
    fun forget(baseUrl: String) {
        routes.values.removeAll { it.baseUrl == baseUrl }
    }
}
