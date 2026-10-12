package com.choidev.choibuddy

import org.junit.Assert.assertEquals
import org.junit.Test

class SseParserTest {
    private fun parse(vararg chunks: String): List<SseEvent> {
        val parser = SseParser()

        return chunks.flatMap(parser::feed)
    }

    @Test
    fun namedEventWithJsonData() {
        assertEquals(
            listOf(SseEvent("snapshot", """{"protocol":1}""")),
            parse("event: snapshot\ndata: {\"protocol\":1}\n\n"),
        )
    }

    @Test
    fun defaultsToMessageAndJoinsDataLines() {
        assertEquals(listOf(SseEvent("message", "a\nb\n")), parse("data: a\ndata: b\ndata:\n\n"))
    }

    @Test
    fun ignoresCommentsAndHeartbeats() {
        assertEquals(
            listOf(SseEvent("alert", "x")),
            parse(": ping\n\n: hello\nevent: alert\n: mid-event comment\ndata: x\n\n"),
        )
    }

    @Test
    fun acceptsCrlfAndBareCr() {
        assertEquals(
            listOf(SseEvent("alert", "1"), SseEvent("alert", "2")),
            parse("event: alert\r\ndata: 1\r\n\r\nevent: alert\rdata: 2\r\r"),
        )
    }

    @Test
    fun crlfSplitAcrossChunksIsOneLineEnd() {
        // LF를 빈 줄로 잘못 보면 "a"와 "b"가 따로 나간다.
        assertEquals(listOf(SseEvent("message", "a\nb")), parse("data: a\r", "\ndata: b\r\n", "\r\n"))
    }

    @Test
    fun lineSplitAcrossChunks() {
        assertEquals(listOf(SseEvent("alert", "hello 세션")), parse("ev", "ent: al", "ert\nda", "ta: hello 세", "션\n", "\n"))
    }

    @Test
    fun onlyOneLeadingSpaceIsStripped() {
        assertEquals(listOf(SseEvent("message", " x"), SseEvent("message", "y")), parse("data:  x\n\ndata:y\n\n"))
    }

    @Test
    fun eventTypeResetsAfterDispatch() {
        assertEquals(
            listOf(SseEvent("alert", "1"), SseEvent("message", "2")),
            parse("event: alert\ndata: 1\n\ndata: 2\n\n"),
        )
    }

    @Test
    fun eventWithoutDataIsDropped() {
        assertEquals(listOf(SseEvent("message", "2")), parse("event: alert\n\ndata: 2\n\n"))
    }

    @Test
    fun fieldWithoutColonAndUnknownFields() {
        assertEquals(listOf(SseEvent("message", "")), parse("id: 7\nretry: 1000\nfoo: bar\ndata\n\n"))
    }

    @Test
    fun incompleteEventWaitsForBlankLine() {
        val parser = SseParser()

        assertEquals(emptyList<SseEvent>(), parser.feed("event: alert\ndata: x\n"))
        assertEquals(listOf(SseEvent("alert", "x")), parser.feed("\n"))
    }
}
