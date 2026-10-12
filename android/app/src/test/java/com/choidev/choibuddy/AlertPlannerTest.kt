package com.choidev.choibuddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** values/strings.xml(영어)과 같은 문구. */
private object EnglishPhrases : Phrases {
    override val permissionRequest = "Permission request"
    override val claudeAsks = "Claude asks"
    override val planApproval = "Plan approval"
    override val finished = "Finished"
    override val stoppedOnError = "Stopped on an error"
    override val pickAnAnswer = "Pick an answer"
    override val approvePlan = "Approve this plan?"
    override val finishedTask = "Finished the task"
    override val runCommand = "Run command"
    override val editFile = "Edit file"
    override val readFile = "Read file"
    override val openWebPage = "Open web page"
    override val mcp = "MCP"

    override fun useTool(tool: String) = "Use $tool"
}

class AlertPlannerTest {
    private val allowDeny = listOf(Behavior.ALLOW, Behavior.DENY)

    private fun alert(type: AlertType, text: String = "npm test", pendingId: String? = null, kind: PendingKind? = null) =
        Alert(type, "s1", "web", text, pendingId, kind)

    private fun plan(
        alert: Alert,
        item: PendingItem? = null,
        pcName: String? = null,
        appVisible: Boolean = false,
        doneAlerts: Boolean = true,
    ) = AlertPlanner.forAlert(alert, item, pcName, appVisible, doneAlerts, EnglishPhrases)

    @Test
    fun actionComesFromTool() {
        val expected = mapOf(
            "Bash" to "Run command",
            "PowerShell" to "Run command",
            "Edit" to "Edit file",
            "Write" to "Edit file",
            "MultiEdit" to "Edit file",
            "NotebookEdit" to "Edit file",
            "Read" to "Read file",
            "WebFetch" to "Open web page",
            "WebSearch" to "Open web page",
            "mcp__github__create_issue" to "MCP",
            "Grep" to "Use Grep",
            "" to null,
        )

        for ((tool, action) in expected) assertEquals(tool, action, AlertPlanner.actionOf(tool, EnglishPhrases))
    }

    @Test
    fun permissionUsesSnapshotItemForActionAndDetail() {
        val item = PendingItem("p1", "web", PendingKind.PERMISSION, "Bash", "npm run build")

        assertEquals(
            Notice.Pending("p1", "web · Permission request", "Run command · npm run build", allowDeny),
            plan(alert(AlertType.PENDING, pendingId = "p1", kind = PendingKind.PERMISSION), item),
        )
    }

    @Test
    fun permissionWithoutItemFallsBackToAlertText() {
        assertEquals(
            Notice.Pending("p1", "web · Permission request", "npm test", allowDeny),
            plan(alert(AlertType.PENDING, pendingId = "p1", kind = PendingKind.PERMISSION)),
        )
    }

    @Test
    fun permissionWithEmptyDetailShowsOnlyAction() {
        val item = PendingItem("p1", "web", PendingKind.PERMISSION, "mcp__db__query", "")

        assertEquals("MCP", AlertPlanner.forItem(item, null, EnglishPhrases).text)
    }

    @Test
    fun questionShowsTheQuestionOrAsksToPick() {
        val withText = plan(alert(AlertType.PENDING, "Which branch?", "q1", PendingKind.QUESTION))
        val empty = plan(alert(AlertType.PENDING, "", "q1", PendingKind.QUESTION))

        assertEquals(Notice.Pending("q1", "web · Claude asks", "Which branch?", emptyList()), withText)
        assertEquals(Notice.Pending("q1", "web · Claude asks", "Pick an answer", emptyList()), empty)
    }

    @Test
    fun planAsksForApproval() {
        assertEquals(
            Notice.Pending("x", "web · Plan approval", "Approve this plan?", emptyList()),
            plan(alert(AlertType.PENDING, "", "x", PendingKind.PLAN)),
        )
    }

    @Test
    fun noPendingNotificationWhileAppIsVisibleOrWithoutId() {
        assertNull(plan(alert(AlertType.PENDING, pendingId = "p1", kind = PendingKind.PERMISSION), appVisible = true))
        assertNull(plan(alert(AlertType.PENDING)))
    }

    @Test
    fun resolvedWithdrawsEvenWhileVisible() {
        assertEquals(Notice.Withdraw("p1"), plan(alert(AlertType.RESOLVED, pendingId = "p1"), appVisible = true))
    }

    @Test
    fun doneShowsReplyOrFallback() {
        assertEquals(
            Notice.Finished("s1", "web · Finished", "All tests pass."),
            plan(alert(AlertType.DONE, "All tests pass.")),
        )
        assertEquals(Notice.Finished("s1", "web · Finished", "Finished the task"), plan(alert(AlertType.DONE, "")))
    }

    @Test
    fun errorShowsErrorText() {
        assertEquals(
            Notice.Finished("s1", "web · Stopped on an error", "rate limited"),
            plan(alert(AlertType.ERROR, "rate limited")),
        )
        assertEquals(Notice.Finished("s1", "web · Stopped on an error", ""), plan(alert(AlertType.ERROR, "")))
    }

    @Test
    fun finishedRespectsTheSetting() {
        assertNull(plan(alert(AlertType.DONE), doneAlerts = false))
        assertNull(plan(alert(AlertType.ERROR), doneAlerts = false))
        assertNull(plan(alert(AlertType.NOTICE)))
    }

    @Test
    fun finishedStillAlertsWhileTheAppIsOpen() {
        assertEquals(Notice.Finished("s1", "web · Finished", "done"), plan(alert(AlertType.DONE, "done"), appVisible = true))
        assertEquals(Notice.Finished("s1", "web · Stopped on an error", "rate limited"), plan(alert(AlertType.ERROR, "rate limited"), appVisible = true))
    }

    @Test
    fun missedRequestsSkipAlreadyNotified() {
        val pending = listOf(
            PendingItem("p1", "web", PendingKind.PERMISSION, "Bash", "npm test"),
            PendingItem("p2", "api", PendingKind.PERMISSION, "Edit", "src/App.tsx"),
        )

        assertEquals(
            listOf(Notice.Pending("p2", "api · Permission request", "Edit file · src/App.tsx", allowDeny)),
            AlertPlanner.missed(pending, notified = setOf("p1"), pcName = null, appVisible = false, phrases = EnglishPhrases),
        )
        assertEquals(
            emptyList<Notice.Pending>(),
            AlertPlanner.missed(pending, emptySet(), pcName = null, appVisible = true, phrases = EnglishPhrases),
        )
    }

    @Test
    fun titleCarriesPcNameWhenGiven() {
        val item = PendingItem("p1", "korus", PendingKind.PERMISSION, "Bash", "npm test")

        assertEquals("korus · STUDIO-PC · Permission request", AlertPlanner.forItem(item, "STUDIO-PC", EnglishPhrases).title)
        assertEquals("korus · Permission request", AlertPlanner.forItem(item, null, EnglishPhrases).title)
        assertEquals(
            Notice.Finished("s1", "web · LAPTOP · Finished", "done"),
            plan(alert(AlertType.DONE, "done"), pcName = "LAPTOP"),
        )
        assertEquals(
            listOf("korus · STUDIO-PC · Permission request"),
            AlertPlanner.missed(listOf(item), emptySet(), "STUDIO-PC", appVisible = false, phrases = EnglishPhrases).map { it.title },
        )
    }

    @Test
    fun staleIsShownMinusLive() {
        assertEquals(setOf("a", "c"), AlertPlanner.stale(listOf("a", "b", "c", "a"), live = setOf("b", "d")))
        assertEquals(emptySet<String>(), AlertPlanner.stale(listOf("b"), live = setOf("b")))
    }
}
