package com.choidev.choibuddy

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

// shared/protocol.ts(v2) 가운데 폰 알림과 홈 화면 위젯에 쓰는 부분만 옮겼다.

enum class AlertType { PENDING, RESOLVED, DONE, ERROR, NOTICE }

enum class PendingKind { PERMISSION, QUESTION, PLAN }

/** 알림 버튼으로 보낼 수 있는 결정. "always"는 화면 안 UI에서만 고른다. */
enum class Behavior(val wire: String) {
    ALLOW("allow"),
    DENY("deny"),
}

/** [text]는 내용(명령, Claude의 답, 오류)뿐이다. 문구는 폰이 자기 언어로 붙인다. */
data class Alert(
    val type: AlertType,
    val sessionId: String,
    val sessionName: String,
    val text: String,
    val pendingId: String?,
    val pendingKind: PendingKind?,
)

/** [detail]은 묻는 대상(명령, 파일 이름, 첫 질문)뿐이고 계획이면 비어 있다. */
data class PendingItem(
    val id: String,
    val sessionName: String,
    val kind: PendingKind?,
    val tool: String,
    val detail: String,
)

enum class SessionStatus { THINKING, WORKING, WAITING, DONE, IDLE, ERROR, ENDED }

enum class StepKind { READ, EDIT, WRITE, BASH, SEARCH, WEB, AGENT, TODO, QUESTION, PLAN, MCP, OTHER }

/**
 * 위젯에 그릴 세션 하나. [kind]는 실행 중인 도구(없으면 마지막 도구)의 종류이고 [running]은 실행 중인 도구가 있는지,
 * [activity]는 지금 하는 일("Bash · npm test")이나 Claude의 마지막 답 첫 줄이다.
 */
data class SessionSummary(
    val id: String,
    val name: String,
    val status: SessionStatus,
    val kind: StepKind?,
    val running: Boolean,
    val lastFailed: Boolean,
    val activity: String,
    val turnStartedAt: Long,
    val updatedAt: Long,
)

/** 계정 사용량 창 하나(five_hour, seven_day …)의 사용 비율. */
data class LimitSummary(val kind: String, val percent: Int)

/** [pcId]는 PC 설치마다 고정이라 같은 PC의 두 주소를 한 대로 본다. [hostName]은 알림에 붙이는 PC 이름. */
data class SnapshotSummary(
    val pcId: String,
    val hostName: String,
    val activeSessions: Int,
    val pending: List<PendingItem>,
    val sessions: List<SessionSummary> = emptyList(),
    val limits: List<LimitSummary> = emptyList(),
)

/**
 * JSON 경계. 쓰지 않는 필드와 새로 생긴 필드는 무시하고, 빠진 글자 필드는 빈 문자열로 읽는다.
 * JSON 자체가 깨졌으면 org.json의 JSONException을 그대로 던진다.
 */
object Wire {
    /** 종류를 모르는(새 버전 프로토콜의) 알림이면 null. */
    fun alert(json: String): Alert? {
        val o = JSONObject(json)
        val type = enumOf<AlertType>(o.text("type")) ?: return null

        return Alert(
            type = type,
            sessionId = o.text("sessionId"),
            sessionName = o.text("sessionName"),
            text = o.text("text"),
            pendingId = o.textOrNull("pendingId"),
            pendingKind = enumOf<PendingKind>(o.text("pendingKind")),
        )
    }

    fun snapshot(json: String): SnapshotSummary {
        val o = JSONObject(json)
        val active = o.optJSONArray("sessions").objects().count { it.text("status") != "ended" }
        val sessions = o.optJSONArray("sessions").objects().mapNotNull(::session)
        val limits = o.optJSONObject("limits")?.optJSONArray("windows").objects().mapNotNull { w ->
            val kind = w.textOrNull("kind") ?: return@mapNotNull null

            LimitSummary(kind, w.optDouble("percentUsed", 0.0).roundToInt().coerceIn(0, 100))
        }
        val pending = o.optJSONArray("pending").objects().mapNotNull { p ->
            val id = p.textOrNull("id") ?: return@mapNotNull null

            PendingItem(
                id = id,
                sessionName = p.text("sessionName"),
                kind = enumOf<PendingKind>(p.text("kind")),
                tool = p.text("tool"),
                detail = p.text("detail"),
            )
        }

        val server = o.optJSONObject("server")

        return SnapshotSummary(server?.text("pcId").orEmpty(), server?.text("hostName").orEmpty(), active, pending, sessions, limits)
    }

    /** 상태를 모르는(새 버전 프로토콜의) 세션이면 null. */
    private fun session(o: JSONObject): SessionSummary? {
        val id = o.textOrNull("id") ?: return null
        val status = enumOf<SessionStatus>(o.text("status")) ?: return null
        val steps = o.optJSONArray("steps").objects()
        val running = steps.lastOrNull { it.text("status") == "running" }
        val last = steps.lastOrNull()
        val step = running ?: last
        val doing = step?.let { listOf(it.text("tool"), it.text("title")).filter(String::isNotBlank).joinToString(" · ") }.orEmpty()
        val activity = when (status) {
            SessionStatus.WORKING, SessionStatus.WAITING -> doing
            SessionStatus.THINKING -> o.text("prompt")
            else -> o.text("message").ifBlank { o.text("prompt") }
        }

        return SessionSummary(
            id = id,
            name = o.text("name"),
            status = status,
            kind = step?.let { enumOf<StepKind>(it.text("kind")) ?: StepKind.OTHER },
            running = running != null,
            lastFailed = last?.text("status") == "failed",
            activity = oneLine(activity),
            turnStartedAt = o.optLong("turnStartedAt", 0),
            updatedAt = o.optLong("updatedAt", 0),
        )
    }

    // 위젯 한 줄에 들어갈 만큼만. 줄바꿈과 겹친 공백은 한 칸으로 줄인다.
    private fun oneLine(text: String): String = text.replace(WHITESPACE, " ").trim().take(ACTIVITY_MAX)

    private val WHITESPACE = Regex("\\s+")
    private const val ACTIVITY_MAX = 160

    /** 앱에 저장한 연결 목록이자 getConfigs()가 UI에 주는 모양: `[{"baseUrl":…,"token":…}]`. */
    fun pairings(json: String): List<Pairing> = JSONArray(json).objects().mapNotNull { o ->
        val baseUrl = o.textOrNull("baseUrl") ?: return@mapNotNull null
        val token = o.textOrNull("token") ?: return@mapNotNull null

        Pairing(baseUrl, token)
    }

    fun pairingsJson(pairings: List<Pairing>): String =
        JSONArray(pairings.map { JSONObject().put("baseUrl", it.baseUrl).put("token", it.token) }).toString()

    fun decision(pendingId: String, behavior: Behavior): String = JSONObject()
        .put("id", pendingId)
        .put("behavior", behavior.wire)
        .put("message", JSONObject.NULL)
        .put("answers", JSONObject.NULL)
        .toString()

    // isNull은 키가 없을 때와 null일 때 모두 참이다. Android의 optString은 null을 "null"로 돌려주므로 먼저 거른다.
    private fun JSONObject.textOrNull(name: String): String? = if (isNull(name)) null else optString(name)

    private fun JSONObject.text(name: String): String = textOrNull(name).orEmpty()

    private fun JSONArray?.objects(): List<JSONObject> =
        if (this == null) emptyList() else (0 until length()).mapNotNull(::optJSONObject)

    private inline fun <reified E : Enum<E>> enumOf(wire: String): E? =
        enumValues<E>().firstOrNull { it.name.lowercase() == wire }
}
