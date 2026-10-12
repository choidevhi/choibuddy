package com.choidev.choibuddy

/** 알림 문구. 앱에서는 고른 언어의 strings.xml로, 테스트에서는 고정 문구로 채운다. */
interface Phrases {
    val permissionRequest: String
    val claudeAsks: String
    val planApproval: String
    val finished: String
    val stoppedOnError: String
    val pickAnAnswer: String
    val approvePlan: String
    val finishedTask: String
    val runCommand: String
    val editFile: String
    val readFile: String
    val openWebPage: String
    val mcp: String

    fun useTool(tool: String): String
}

/** 알림 한 건으로 무엇을 할지. 안드로이드 API와 떨어뜨려 JVM 테스트로 확인한다. */
sealed interface Notice {
    /** 승인 요청. [buttons]가 비어 있으면 앱을 여는 것만 된다. */
    data class Pending(
        val pendingId: String,
        val title: String,
        val text: String,
        val buttons: List<Behavior>,
        val sendFailed: Boolean = false,
    ) : Notice

    data class Finished(val sessionId: String, val title: String, val text: String) : Notice

    /** 이미 처리된 요청의 알림을 내린다. */
    data class Withdraw(val pendingId: String) : Notice
}

object AlertPlanner {
    private const val SEPARATOR = " · "
    private val COMMAND_TOOLS = setOf("Bash", "PowerShell")
    private val EDIT_TOOLS = setOf("Edit", "Write", "MultiEdit", "NotebookEdit")
    private val WEB_TOOLS = setOf("WebFetch", "WebSearch")

    /**
     * 승인 요청은 앱 화면이 보이는 동안 화면 안 UI가 알리므로 띄우지 않는다.
     * 작업이 끝났다는 알림은 앱을 보고 있어도 띄운다. 다른 세션을 보고 있거나 폰을 내려놓았을 때 놓치지 않게.
     * [item]은 최근 스냅샷의 같은 요청이다. 브리지는 alert를 스냅샷보다 먼저 보내므로 보통 없다.
     * [pcName]은 PC가 여러 대일 때만 넘긴다. 제목이 "세션 · PC · 문구"가 된다.
     */
    fun forAlert(
        alert: Alert,
        item: PendingItem?,
        pcName: String?,
        appVisible: Boolean,
        doneAlerts: Boolean,
        phrases: Phrases,
    ): Notice? = when (alert.type) {
        AlertType.PENDING -> alert.pendingId
            ?.takeUnless { appVisible }
            ?.let { id ->
                pending(id, alert.sessionName, pcName, alert.pendingKind, item?.tool, item?.detail ?: alert.text, phrases)
            }

        AlertType.RESOLVED -> alert.pendingId?.let(Notice::Withdraw)
        AlertType.DONE -> finished(alert, pcName, phrases.finished, alert.text.ifBlank { phrases.finishedTask }, doneAlerts)
        AlertType.ERROR -> finished(alert, pcName, phrases.stoppedOnError, alert.text, doneAlerts)
        AlertType.NOTICE -> null
    }

    /** 스냅샷에 실린 요청 그대로의 알림(도구 이름까지 알 때). */
    fun forItem(item: PendingItem, pcName: String?, phrases: Phrases): Notice.Pending =
        pending(item.id, item.sessionName, pcName, item.kind, item.tool, item.detail, phrases)

    /**
     * 다시 연결된 뒤 첫 스냅샷에서 부른다. 끊겨 있던 사이 알림을 놓친 승인 요청을 띄우고,
     * 이미 띄웠던 것([notified], 사용자가 지운 것과 같은 PC의 다른 주소로 온 것 포함)은 다시 울리지 않는다.
     */
    fun missed(
        pending: List<PendingItem>,
        notified: Set<String>,
        pcName: String?,
        appVisible: Boolean,
        phrases: Phrases,
    ): List<Notice.Pending> =
        if (appVisible) emptyList() else pending.mapNotNull { if (it.id in notified) null else forItem(it, pcName, phrases) }

    /** 떠 있는 승인 알림 가운데 스냅샷에 더는 없는 것. PC나 다른 화면에서 이미 처리됐다. */
    fun stale(shown: Collection<String>, live: Set<String>): Set<String> = shown.toSet() - live

    fun buttonsFor(kind: PendingKind?): List<Behavior> =
        if (kind == PendingKind.PERMISSION) listOf(Behavior.ALLOW, Behavior.DENY) else emptyList()

    /** 권한 요청에서 무엇을 하려는지. 도구를 모르면 null이고, 본문은 내용만 남는다. */
    fun actionOf(tool: String, phrases: Phrases): String? = when {
        tool.isBlank() -> null
        tool in COMMAND_TOOLS -> phrases.runCommand
        tool in EDIT_TOOLS -> phrases.editFile
        tool == "Read" -> phrases.readFile
        tool in WEB_TOOLS -> phrases.openWebPage
        tool.startsWith("mcp__") -> phrases.mcp
        else -> phrases.useTool(tool)
    }

    private fun pending(
        id: String,
        sessionName: String,
        pcName: String?,
        kind: PendingKind?,
        tool: String?,
        detail: String,
        phrases: Phrases,
    ): Notice.Pending {
        val (label, body) = when (kind) {
            PendingKind.PERMISSION -> phrases.permissionRequest to join(tool?.let { actionOf(it, phrases) }, detail)
            PendingKind.PLAN -> phrases.planApproval to phrases.approvePlan
            PendingKind.QUESTION, null -> phrases.claudeAsks to detail.ifBlank { phrases.pickAnAnswer }
        }

        return Notice.Pending(id, join(sessionName, pcName, label), body, buttonsFor(kind))
    }

    private fun finished(
        alert: Alert,
        pcName: String?,
        label: String,
        body: String,
        doneAlerts: Boolean,
    ): Notice? = if (!doneAlerts) {
        null
    } else {
        Notice.Finished(alert.sessionId, join(alert.sessionName, pcName, label), body)
    }

    private fun join(vararg parts: String?): String =
        parts.filterNot { it.isNullOrBlank() }.joinToString(SEPARATOR)
}

/** 연결 하나의 상태. 문구는 Notifications가 고른 언어로 붙인다. */
sealed interface LinkState {
    data object Connecting : LinkState

    data object Rejected : LinkState

    data class Connected(val sessions: Int) : LinkState
}
