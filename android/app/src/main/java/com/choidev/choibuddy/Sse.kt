package com.choidev.choibuddy

/** 서버가 보낸 이벤트 하나. `event:` 줄이 없었으면 [type]은 "message"다. */
data class SseEvent(val type: String, val data: String)

/**
 * text/event-stream을 받은 조각 그대로 넣으면 끝난 이벤트를 돌려준다(WHATWG 규칙 중 id·retry는 쓰지 않아 뺐다).
 * 줄 끝은 CRLF·LF·CR을 모두 받고, CR과 LF가 조각 경계에서 갈라져도 한 줄 끝으로 본다.
 */
class SseParser {
    private val line = StringBuilder()
    private val data = StringBuilder()
    private var type = ""
    private var afterCr = false

    fun feed(chunk: CharSequence): List<SseEvent> {
        val events = mutableListOf<SseEvent>()
        for (char in chunk) {
            if (afterCr) {
                afterCr = false
                if (char == '\n') continue
            }

            when (char) {
                '\r' -> {
                    afterCr = true
                    endLine(events)
                }

                '\n' -> endLine(events)
                else -> line.append(char)
            }
        }

        return events
    }

    private fun endLine(events: MutableList<SseEvent>) {
        val text = line.toString()
        line.setLength(0)
        if (text.isEmpty()) {
            dispatch(events)
            return
        }

        if (text.startsWith(':')) return

        val colon = text.indexOf(':')
        val field = if (colon < 0) text else text.substring(0, colon)
        val value = if (colon < 0) "" else text.substring(colon + 1).removePrefix(" ")
        when (field) {
            "event" -> type = value
            "data" -> data.append(value).append('\n')
        }
    }

    private fun dispatch(events: MutableList<SseEvent>) {
        if (data.isNotEmpty()) {
            events += SseEvent(type.ifEmpty { "message" }, data.substring(0, data.length - 1))
        }

        data.setLength(0)
        type = ""
    }
}
