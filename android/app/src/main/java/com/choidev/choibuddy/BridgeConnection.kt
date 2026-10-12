package com.choidev.choibuddy

import okhttp3.Call
import java.io.IOException
import java.nio.CharBuffer
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** 다시 붙기 전 기다릴 시간. 1초에서 시작해 두 배씩, 30초까지 늘린다. */
class Backoff {
    private var nextMs = FIRST_MS

    fun next(): Long = nextMs.also { nextMs = (nextMs * 2).coerceAtMost(MAX_MS) }

    fun reset() {
        nextMs = FIRST_MS
    }

    private companion object {
        const val FIRST_MS = 1_000L
        const val MAX_MS = 30_000L
    }
}

/** 브리지 /api/events에 붙는 SSE 연결 하나. 자기 스레드에서 읽고, 끊기면 [Backoff]만큼 쉬었다가 다시 붙는다. */
class BridgeConnection(private val pairing: Pairing, private val listener: Listener) {
    interface Listener {
        /** 응답을 받아 이벤트를 읽기 시작했다. */
        fun onOpen()

        /** 끊겼다. [state]는 다시 붙을 때까지 보여 줄 상태. */
        fun onDrop(state: LinkState)

        fun onEvent(event: SseEvent)
    }

    @Volatile
    private var running = true

    @Volatile
    private var active: Call? = null

    private val wake = Semaphore(0)

    fun start() {
        thread(name = "choibuddy-events", isDaemon = true) { loop() }
    }

    /** 기다리던 중이면 바로, 붙어 있으면 끊고 바로 다시 붙는다(네트워크가 바뀌었을 때). */
    fun reconnectNow() {
        active?.cancel()
        wake.release()
    }

    fun close() {
        running = false
        reconnectNow()
    }

    private fun loop() {
        val backoff = Backoff()
        while (running) {
            val state = try {
                read(backoff)
            } catch (e: IOException) {
                LinkState.Connecting
            }
            if (!running) return

            listener.onDrop(state)
            wake.tryAcquire(backoff.next(), TimeUnit.MILLISECONDS)
            wake.drainPermits()
        }
    }

    private fun read(backoff: Backoff): LinkState {
        val call = Bridge.events.newCall(Bridge.eventsRequest(pairing))
        active = call
        if (!running) call.cancel()

        call.execute().use { response ->
            if (response.code == 401 || response.code == 403) return LinkState.Rejected

            val body = response.body
            if (!response.isSuccessful || body == null) return LinkState.Connecting

            backoff.reset()
            listener.onOpen()
            val parser = SseParser()
            val reader = body.charStream()
            val buffer = CharArray(8 * 1024)
            while (running) {
                val count = reader.read(buffer)
                if (count < 0) break

                parser.feed(CharBuffer.wrap(buffer, 0, count)).forEach(listener::onEvent)
            }
        }

        return LinkState.Connecting
    }
}
