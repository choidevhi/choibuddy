package com.choidev.choibuddy

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WireTest {
    @Test
    fun readsWhetherCodexAsks() {
        val json = """{"type":"pending","sessionId":"s1","sessionName":"web","text":"Which color?","pendingId":"q1","pendingKind":"question","agent":"codex","at":1}"""

        assertEquals(Alert(AlertType.PENDING, "s1", "web", "Which color?", "q1", PendingKind.QUESTION, codex = true), Wire.alert(json))
    }

    @Test
    fun parsesPendingAlert() {
        val json = """{"type":"pending","sessionId":"s1","sessionName":"choibuddy","text":"npm test",""" +
            """"pendingId":"p1","pendingKind":"permission","at":1760000000000}"""

        assertEquals(
            Alert(AlertType.PENDING, "s1", "choibuddy", "npm test", "p1", PendingKind.PERMISSION),
            Wire.alert(json),
        )
    }

    @Test
    fun parsesNullPendingFields() {
        val json = """{"type":"done","sessionId":"s1","sessionName":"app","text":"","pendingId":null,""" +
            """"pendingKind":null,"at":1}"""

        assertEquals(Alert(AlertType.DONE, "s1", "app", "", null, null), Wire.alert(json))
    }

    @Test
    fun alertToleratesMissingAndUnknownFields() {
        val json = """{"type":"error","sessionId":"s1","sessionName":"app","future":{"x":1}}"""

        assertEquals(Alert(AlertType.ERROR, "s1", "app", "", null, null), Wire.alert(json))
    }

    @Test
    fun unknownAlertTypeIsIgnored() {
        assertNull(Wire.alert("""{"type":"party","sessionId":"s","sessionName":"n","text":"t","pendingId":null}"""))
        assertNull(Wire.alert("""{"sessionId":"s"}"""))
    }

    @Test
    fun parsesV2SnapshotAndIgnoresFieldsItDoesNotUse() {
        val json = """
            {"protocol":2,"serverTime":1,"server":{"pcId":"pc-1","hostName":"STUDIO-PC","tailnetUrl":null,"version":"0.3.0"},
             "gallery":{"count":3},
             "limits":{"windows":[{"kind":"five_hour","percentUsed":42,"resetsAt":null}],"at":1},
             "sessions":[
               {"id":"a","status":"working","usage":{"model":"opus","contextPercent":12,"inputTokens":1,
                 "outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":null},
                "agents":[{"id":"g","type":"Explore","steps":[]}],"canPrompt":true,"queued":["next"]},
               {"id":"b","status":"ended","usage":null,"agents":[],"canPrompt":false,"queued":[]},
               {"id":"c","status":"waiting"}
             ],
             "pending":[
               {"id":"p1","sessionId":"a","sessionName":"web","kind":"permission","tool":"Bash","detail":"npm test",
                "preview":{"type":"terminal","command":"npm test","output":"","failed":false},
                "canAlwaysAllow":true,"questions":[],"plan":null,"createdAt":1},
               {"id":"p2","sessionId":"c","sessionName":"api","kind":"plan","tool":"ExitPlanMode","detail":"",
                "plan":"# Plan","questions":[],"createdAt":2}
             ]}
        """.trimIndent()

        assertEquals(
            SnapshotSummary(
                pcId = "pc-1",
                hostName = "STUDIO-PC",
                activeSessions = 2,
                pending = listOf(
                    PendingItem("p1", "web", PendingKind.PERMISSION, "Bash", "npm test"),
                    PendingItem("p2", "api", PendingKind.PLAN, "ExitPlanMode", ""),
                ),
                sessions = listOf(
                    SessionSummary("a", "", SessionStatus.WORKING, null, running = false, lastFailed = false, activity = "", turnStartedAt = 0, updatedAt = 0),
                    SessionSummary("b", "", SessionStatus.ENDED, null, running = false, lastFailed = false, activity = "", turnStartedAt = 0, updatedAt = 0),
                    SessionSummary("c", "", SessionStatus.WAITING, null, running = false, lastFailed = false, activity = "", turnStartedAt = 0, updatedAt = 0),
                ),
                limits = listOf(LimitSummary("five_hour", 42)),
            ),
            Wire.snapshot(json),
        )
    }

    @Test
    fun readsWhatTheWidgetShowsForEachSession() {
        val json = """
            {"protocol":2,"limits":{"windows":[{"kind":"five_hour","percentUsed":23.6},{"kind":"seven_day","percentUsed":140}],"at":1},
             "sessions":[
               {"id":"w","name":"korus","status":"working","turnStartedAt":1000,"updatedAt":2000,"prompt":"fix it","message":null,
                "steps":[{"id":"1","tool":"Read","kind":"read","title":"a.ts","status":"done"},
                         {"id":"2","tool":"Bash","kind":"bash","title":"npm  test\n--watch","status":"running"}]},
               {"id":"t","name":"api","status":"thinking","prompt":"line one\nline two","steps":[]},
               {"id":"d","name":"web","status":"done","prompt":"p","message":"All tests pass.\nDetails below","steps":[
                 {"id":"1","tool":"Edit","kind":"edit","title":"x","status":"failed"}]},
               {"id":"n","name":"new","status":"working","steps":[{"id":"1","tool":"Mystery","kind":"brand-new","title":"","status":"running"}]},
               {"id":"f","name":"future","status":"sleeping"}
             ]}
        """.trimIndent()

        val snapshot = Wire.snapshot(json)

        assertEquals(
            listOf(
                SessionSummary("w", "korus", SessionStatus.WORKING, StepKind.BASH, running = true, lastFailed = false, activity = "Bash · npm test --watch", turnStartedAt = 1000, updatedAt = 2000),
                SessionSummary("t", "api", SessionStatus.THINKING, null, running = false, lastFailed = false, activity = "line one line two", turnStartedAt = 0, updatedAt = 0),
                SessionSummary("d", "web", SessionStatus.DONE, StepKind.EDIT, running = false, lastFailed = true, activity = "All tests pass. Details below", turnStartedAt = 0, updatedAt = 0),
                SessionSummary("n", "new", SessionStatus.WORKING, StepKind.OTHER, running = true, lastFailed = false, activity = "Mystery", turnStartedAt = 0, updatedAt = 0),
            ),
            snapshot.sessions,
        )
        assertEquals(listOf(LimitSummary("five_hour", 24), LimitSummary("seven_day", 100)), snapshot.limits)
        // 상단 알림의 세션 수는 모르는 상태도 센다. 위젯만 그 세션을 건너뛴다.
        assertEquals(5, snapshot.activeSessions)
    }

    @Test
    fun snapshotToleratesMissingOptionalFields() {
        val json = """
            {"protocol":2,
             "pending":[
               {"id":"p1","kind":"question"},
               {"id":null,"kind":"permission","tool":"Bash","detail":"ls"},
               {"id":"p3","kind":"brand-new","tool":"X","detail":null}
             ]}
        """.trimIndent()

        assertEquals(
            SnapshotSummary(
                pcId = "",
                hostName = "",
                activeSessions = 0,
                pending = listOf(
                    PendingItem("p1", "", PendingKind.QUESTION, "", ""),
                    PendingItem("p3", "", null, "X", ""),
                ),
            ),
            Wire.snapshot(json),
        )
    }

    @Test
    fun pairingListRoundTripsAndSkipsBrokenEntries() {
        val pairings = listOf(Pairing("http://100.1.1.1:47130", "a".repeat(20)), Pairing("http://pc-b:47130", "b".repeat(20)))

        assertEquals(pairings, Wire.pairings(Wire.pairingsJson(pairings)))
        assertEquals(emptyList<Pairing>(), Wire.pairings("[]"))
        assertEquals(
            listOf(Pairing("http://x:1", "t".repeat(16))),
            Wire.pairings("""[{"baseUrl":"http://x:1"},null,{"baseUrl":"http://x:1","token":"tttttttttttttttt"},{"token":"z"}]"""),
        )
    }

    @Test
    fun decisionBodyMatchesProtocol() {
        val body = JSONObject(Wire.decision("p1", Behavior.DENY))

        assertEquals("p1", body.getString("id"))
        assertEquals("deny", body.getString("behavior"))
        assertTrue(body.has("message") && body.isNull("message"))
        assertTrue(body.has("answers") && body.isNull("answers"))
        assertEquals(4, body.length())
    }
}
