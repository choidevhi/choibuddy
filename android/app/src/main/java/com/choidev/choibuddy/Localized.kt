package com.choidev.choibuddy

import android.content.Context
import android.content.res.Configuration

/** UI가 고른 언어(아직 안 골랐으면 시스템 언어)로 문구를 읽는 Context. */
fun Context.localized(): Context {
    val language = Prefs(this).language ?: return this
    val config = Configuration(resources.configuration).apply { setLocale(language.locale) }

    return createConfigurationContext(config)
}

/** [Phrases]를 strings.xml로 채운다. [context]는 [localized]로 만든 것. */
class ResourcePhrases(private val context: Context) : Phrases {
    override val permissionRequest get() = context.getString(R.string.notice_permission)
    override val claudeAsks get() = context.getString(R.string.notice_question)
    override val codexAsks get() = context.getString(R.string.notice_question_codex)
    override val planApproval get() = context.getString(R.string.notice_plan)
    override val finished get() = context.getString(R.string.notice_finished)
    override val stoppedOnError get() = context.getString(R.string.notice_error)
    override val pickAnAnswer get() = context.getString(R.string.notice_pick_answer)
    override val approvePlan get() = context.getString(R.string.notice_approve_plan)
    override val finishedTask get() = context.getString(R.string.notice_finished_task)
    override val runCommand get() = context.getString(R.string.tool_run_command)
    override val editFile get() = context.getString(R.string.tool_edit_file)
    override val readFile get() = context.getString(R.string.tool_read_file)
    override val openWebPage get() = context.getString(R.string.tool_open_web)
    override val mcp get() = context.getString(R.string.tool_mcp)
    override val moreAccess get() = context.getString(R.string.tool_more_access)

    override fun useTool(tool: String) = context.getString(R.string.tool_use, tool)
}
