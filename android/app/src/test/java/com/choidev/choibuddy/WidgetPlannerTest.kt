package com.choidev.choibuddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetPlannerTest {
    private fun session(
        id: String,
        status: SessionStatus,
        updatedAt: Long = 0,
        kind: StepKind? = null,
        running: Boolean = false,
        lastFailed: Boolean = false,
    ) = SessionSummary(id, "proj-$id", status, kind, running, lastFailed, "doing $id", turnStartedAt = 10, updatedAt = updatedAt)

    private fun feed(vararg sessions: SessionSummary, connected: Boolean = true, pcName: String? = null, limits: List<LimitSummary> = emptyList()) =
        WidgetFeed(pcName, connected, sessions.toList(), limits)

    @Test
    fun noConnectedPcIsOffline() {
        assertEquals(WidgetPlanner.OFFLINE, WidgetPlanner.plan(emptyList()))
        assertEquals(WidgetPlanner.OFFLINE, WidgetPlanner.plan(listOf(feed(session("a", SessionStatus.WORKING), connected = false))))
        assertEquals(Pose.SHRUG, WidgetPlanner.OFFLINE.pose)
    }

    @Test
    fun connectedWithoutLiveSessionsRestsAndStillShowsUsage() {
        val model = WidgetPlanner.plan(
            listOf(feed(session("a", SessionStatus.ENDED), limits = listOf(LimitSummary("five_hour", 23), LimitSummary("seven_day", 61)))),
        )

        assertEquals(WidgetState.RESTING, model.state)
        assertEquals(Pose.COFFEE, model.pose)
        assertNull(model.main)
        assertEquals(23, model.fiveHour)
        assertEquals(61, model.weekly)
    }

    @Test
    fun approvalComesFirstThenWorkThenTheRestNewestFirst() {
        val model = WidgetPlanner.plan(
            listOf(
                feed(session("done-old", SessionStatus.DONE, updatedAt = 1), session("work", SessionStatus.WORKING, updatedAt = 5)),
                feed(session("ask", SessionStatus.WAITING, updatedAt = 2), session("done-new", SessionStatus.DONE, updatedAt = 9)),
            ),
        )

        assertEquals("ask", model.main?.sessionId)
        assertEquals(Pose.WARNING, model.pose)
        assertEquals(listOf("work", "done-new"), model.others.map(WidgetRow::sessionId))
    }

    @Test
    fun theSameSessionFromTwoAddressesShowsOnce() {
        val shared = session("a", SessionStatus.WORKING, kind = StepKind.BASH, running = true)
        val model = WidgetPlanner.plan(listOf(feed(shared), feed(shared)))

        assertEquals("a", model.main?.sessionId)
        assertEquals(emptyList<WidgetRow>(), model.others)
    }

    @Test
    fun usageComesFromThePcOfTheTopSession() {
        val model = WidgetPlanner.plan(
            listOf(
                feed(session("idle", SessionStatus.IDLE), pcName = "LAPTOP", limits = listOf(LimitSummary("five_hour", 5))),
                feed(session("work", SessionStatus.THINKING), pcName = "DESKTOP", limits = listOf(LimitSummary("five_hour", 80))),
            ),
        )

        assertEquals("DESKTOP", model.main?.pcName)
        assertEquals(80, model.fiveHour)
        assertNull(model.weekly)
    }

    @Test
    fun posesFollowTheAppsLook() {
        assertEquals(Pose.BASH, WidgetPlanner.poseOf(session("a", SessionStatus.WORKING, kind = StepKind.BASH, running = true)))
        assertEquals(Pose.WRITE, WidgetPlanner.poseOf(session("a", SessionStatus.WORKING, kind = StepKind.OTHER, running = true)))
        assertEquals(Pose.WRITE, WidgetPlanner.poseOf(session("a", SessionStatus.WORKING)))
        assertEquals(Pose.FAILED, WidgetPlanner.poseOf(session("a", SessionStatus.WORKING, kind = StepKind.EDIT, lastFailed = true)))
        assertEquals(Pose.EDIT, WidgetPlanner.poseOf(session("a", SessionStatus.WORKING, kind = StepKind.EDIT, running = true, lastFailed = true)))
        assertEquals(Pose.THINK, WidgetPlanner.poseOf(session("a", SessionStatus.THINKING)))
        assertEquals(Pose.DONE, WidgetPlanner.poseOf(session("a", SessionStatus.DONE)))
        assertEquals(Pose.DIZZY, WidgetPlanner.poseOf(session("a", SessionStatus.ERROR)))
        assertEquals(Pose.BASE, WidgetPlanner.poseOf(session("a", SessionStatus.IDLE)))
        assertEquals(Pose.CLOSED, WidgetPlanner.poseOf(session("a", SessionStatus.ENDED)))
    }

    @Test
    fun atMostTwoOtherSessions() {
        val sessions = (1..5).map { session("s$it", SessionStatus.WORKING, updatedAt = it.toLong()) }
        val model = WidgetPlanner.plan(listOf(feed(*sessions.toTypedArray())))

        assertEquals("s5", model.main?.sessionId)
        assertEquals(listOf("s4", "s3"), model.others.map(WidgetRow::sessionId))
        assertEquals(WidgetPlanner.OTHERS, model.others.size)
    }
}
