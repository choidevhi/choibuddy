package com.choidev.choibuddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FleetTest {
    private fun connected(host: String, pcKey: String, sessions: Int) = LinkView(host, pcKey, LinkState.Connected(sessions))

    @Test
    fun countsEachPcOnceAndSumsSessions() {
        val links = listOf(
            connected("100.1.1.1", "pc-a", 2),
            // 같은 PC의 다른 주소: 세션을 두 번 세지 않는다.
            connected("desktop-a", "pc-a", 2),
            connected("100.2.2.2", "pc-b", 3),
        )

        assertEquals(FleetStatus(pcs = 2, sessions = 5, connecting = false, rejectedHosts = emptyList()), Fleet.status(links))
    }

    @Test
    fun reportsRejectedHostsAndConnecting() {
        val links = listOf(
            LinkView("100.1.1.1", "http://100.1.1.1:47130", LinkState.Rejected),
            LinkView("100.2.2.2", "http://100.2.2.2:47130", LinkState.Connecting),
            connected("100.3.3.3", "pc-c", 0),
        )

        assertEquals(FleetStatus(pcs = 1, sessions = 0, connecting = true, rejectedHosts = listOf("100.1.1.1")), Fleet.status(links))
    }

    @Test
    fun nothingConnectedYet() {
        assertEquals(FleetStatus(0, 0, connecting = false, rejectedHosts = emptyList()), Fleet.status(emptyList()))
    }

    @Test
    fun namesPcsOnlyWhenThereAreTwoDifferentPcs() {
        assertFalse(Fleet.namesPcs(listOf(connected("a", "pc-a", 1))))
        assertFalse(Fleet.namesPcs(listOf(connected("a", "pc-a", 1), connected("a2", "pc-a", 1))))
        assertTrue(Fleet.namesPcs(listOf(connected("a", "pc-a", 1), connected("b", "pc-b", 1))))
    }

    @Test
    fun firstConnectedAddressOfAPcIsPrimary() {
        val links = listOf(
            LinkView("a1", "pc-a", LinkState.Connecting),
            connected("a2", "pc-a", 1),
            connected("a3", "pc-a", 1),
            connected("b", "pc-b", 1),
        )

        assertFalse(Fleet.isPrimary(0, links))
        assertTrue(Fleet.isPrimary(1, links))
        assertFalse(Fleet.isPrimary(2, links))
        assertTrue(Fleet.isPrimary(3, links))
    }
}

class PendingRoutesTest {
    private val a = PendingRoutes.Route("http://100.1.1.1:47130", "pc-a")
    private val a2 = PendingRoutes.Route("http://desktop-a:47130", "pc-a")
    private val b = PendingRoutes.Route("http://100.2.2.2:47130", "pc-b")

    @Test
    fun decisionGoesToThePcThatSentTheRequest() {
        val routes = PendingRoutes()

        assertTrue(routes.claim("p1", a))
        assertTrue(routes.claim("p2", b))
        assertEquals(a, routes["p1"])
        assertEquals(b, routes["p2"])
        assertNull(routes["p3"])
    }

    @Test
    fun sameRequestFromAnotherAddressOfTheSamePcNotifiesOnce() {
        val routes = PendingRoutes()

        assertTrue(routes.claim("p1", a))
        assertFalse(routes.claim("p1", a2))
        assertEquals(a, routes["p1"])
    }

    @Test
    fun snapshotSettlesOnlyThatPcsRequests() {
        val routes = PendingRoutes()
        routes.claim("a-live", a)
        routes.claim("a-done", a)
        routes.claim("b-open", b)

        routes.settle("pc-a", live = setOf("a-live"))

        assertEquals(setOf("a-live", "b-open"), routes.ids)
    }

    @Test
    fun forgetAndRemove() {
        val routes = PendingRoutes()
        routes.claim("p1", a)
        routes.claim("p2", a2)
        routes.claim("p3", b)

        routes.forget(a.baseUrl)
        routes.remove("p3")

        assertEquals(setOf("p2"), routes.ids)
    }
}
