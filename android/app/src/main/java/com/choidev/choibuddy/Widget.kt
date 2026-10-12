package com.choidev.choibuddy

/** 위젯이 보여 줄 PC 하나의 최근 상태. [pcName]은 PC가 여러 대일 때만 붙는다. */
data class WidgetFeed(
    val pcName: String?,
    val connected: Boolean,
    val sessions: List<SessionSummary>,
    val limits: List<LimitSummary>,
)

/** 버디 자세. 이름이 res/drawable-nodpi/buddy_<소문자 이름>.png와 같다(앱 UI의 SVG에서 뽑았다). */
enum class Pose { THINK, READ, EDIT, WRITE, BASH, SEARCH, WEB, AGENT, TODO, QUESTION, PLAN, MCP, WARNING, FAILED, DONE, DIZZY, CLOSED, BASE, COFFEE, SHRUG }

enum class WidgetState { OFFLINE, RESTING, ACTIVE }

/** 세션 한 줄. [pose]는 버디 그림이자 상태 문구(앱 UI의 look.* 문구와 같다)를 고른다. */
data class WidgetRow(
    val sessionId: String,
    val name: String,
    val pcName: String?,
    val status: SessionStatus,
    val pose: Pose,
    val activity: String,
    val turnStartedAt: Long,
    val updatedAt: Long,
)

/** 위젯 한 장에 그릴 내용. 사용량은 맨 위 세션이 있는 PC의 것이다. */
data class WidgetModel(
    val state: WidgetState,
    val main: WidgetRow?,
    val others: List<WidgetRow>,
    val fiveHour: Int?,
    val weekly: Int?,
) {
    val pose: Pose
        get() = when (state) {
            WidgetState.OFFLINE -> Pose.SHRUG
            WidgetState.RESTING -> Pose.COFFEE
            WidgetState.ACTIVE -> main?.pose ?: Pose.BASE
        }
}

/** 안드로이드 API와 떨어뜨려 JVM 테스트로 확인한다. */
object WidgetPlanner {
    /** 맨 위 세션 아래에 더 보여 줄 세션 수. */
    const val OTHERS = 2

    val OFFLINE = WidgetModel(WidgetState.OFFLINE, null, emptyList(), null, null)

    // 손이 필요한 것(승인), 일하는 것, 멈춘 것, 끝난 것, 쉬는 것 순. 같으면 최근 것이 위.
    private val ORDER = compareBy<Pair<WidgetFeed, SessionSummary>> { rank(it.second.status) }
        .thenByDescending { it.second.updatedAt }

    fun plan(feeds: List<WidgetFeed>): WidgetModel {
        val connected = feeds.filter(WidgetFeed::connected)

        if (connected.isEmpty()) return OFFLINE

        // 같은 PC를 두 주소로 짝지었으면 같은 세션이 두 번 온다.
        val live = connected
            .flatMap { feed -> feed.sessions.map { feed to it } }
            .distinctBy { it.second.id }
            .filter { it.second.status != SessionStatus.ENDED }
            .sortedWith(ORDER)
        val top = live.firstOrNull()
        val usageFeed = top?.first ?: connected.first()
        val fiveHour = usageFeed.limits.firstOrNull { it.kind == FIVE_HOUR }?.percent
        val weekly = usageFeed.limits.firstOrNull { it.kind == SEVEN_DAY }?.percent

        if (top == null) return WidgetModel(WidgetState.RESTING, null, emptyList(), fiveHour, weekly)

        return WidgetModel(
            state = WidgetState.ACTIVE,
            main = row(top),
            others = live.drop(1).take(OTHERS).map(::row),
            fiveHour = fiveHour,
            weekly = weekly,
        )
    }

    /** 앱 UI의 lookFor와 같은 규칙. 시간이 지나면 바뀌는 자세(축하, 졸림)는 위젯이 스스로 다시 그리지 않으므로 뺐다. */
    fun poseOf(session: SessionSummary): Pose = when (session.status) {
        SessionStatus.WAITING -> Pose.WARNING
        SessionStatus.THINKING -> Pose.THINK
        SessionStatus.WORKING -> if (!session.running && session.lastFailed) Pose.FAILED else working(session.kind ?: StepKind.OTHER)
        SessionStatus.DONE -> Pose.DONE
        SessionStatus.ERROR -> Pose.DIZZY
        SessionStatus.ENDED -> Pose.CLOSED
        SessionStatus.IDLE -> Pose.BASE
    }

    private fun working(kind: StepKind): Pose = when (kind) {
        StepKind.READ -> Pose.READ
        StepKind.EDIT -> Pose.EDIT
        StepKind.WRITE, StepKind.OTHER -> Pose.WRITE
        StepKind.BASH -> Pose.BASH
        StepKind.SEARCH -> Pose.SEARCH
        StepKind.WEB -> Pose.WEB
        StepKind.AGENT -> Pose.AGENT
        StepKind.TODO -> Pose.TODO
        StepKind.QUESTION -> Pose.QUESTION
        StepKind.PLAN -> Pose.PLAN
        StepKind.MCP -> Pose.MCP
    }

    private fun row(entry: Pair<WidgetFeed, SessionSummary>): WidgetRow {
        val (feed, session) = entry

        return WidgetRow(
            sessionId = session.id,
            name = session.name,
            pcName = feed.pcName,
            status = session.status,
            pose = poseOf(session),
            activity = session.activity,
            turnStartedAt = session.turnStartedAt,
            updatedAt = session.updatedAt,
        )
    }

    private fun rank(status: SessionStatus): Int = when (status) {
        SessionStatus.WAITING -> 0
        SessionStatus.WORKING, SessionStatus.THINKING -> 1
        SessionStatus.ERROR -> 2
        SessionStatus.DONE -> 3
        SessionStatus.IDLE -> 4
        SessionStatus.ENDED -> 5
    }

    private const val FIVE_HOUR = "five_hour"
    private const val SEVEN_DAY = "seven_day"
}
