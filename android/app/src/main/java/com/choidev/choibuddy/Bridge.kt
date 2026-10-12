package com.choidev.choibuddy

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** PC 브리지의 HTTP API. OkHttp 클라이언트는 앱 전체에서 하나를 나눠 쓴다. */
object Bridge {
    private val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()

    // 서버가 15초마다 주석 줄을 보낸다. 45초 동안 아무것도 오지 않으면 죽은 연결로 보고 다시 붙는다.
    val events: OkHttpClient = client.newBuilder().readTimeout(45, TimeUnit.SECONDS).build()

    // 알림 버튼 수신기(goAsync)는 10초 안에 끝나야 한다.
    private val decisions = client.newBuilder().callTimeout(8, TimeUnit.SECONDS).build()

    private val json = "application/json; charset=utf-8".toMediaType()

    fun eventsRequest(pairing: Pairing): Request = Request.Builder()
        .url(
            pairing.baseUrl.toHttpUrl().newBuilder()
                .addPathSegments("api/events")
                .addQueryParameter("token", pairing.token)
                .build(),
        )
        .header("Accept", "text/event-stream")
        .build()

    /** 승인 결정을 보낸다. 404는 PC나 다른 화면에서 이미 처리된 요청이라 보낸 것으로 친다. */
    fun decide(pairing: Pairing, pendingId: String, behavior: Behavior): Boolean {
        val request = Request.Builder()
            .url(pairing.baseUrl.toHttpUrl().newBuilder().addPathSegments("api/decide").build())
            .header("Authorization", "Bearer ${pairing.token}")
            .post(Wire.decision(pendingId, behavior).toRequestBody(json))
            .build()

        return try {
            decisions.newCall(request).execute().use { it.isSuccessful || it.code == 404 }
        } catch (e: IOException) {
            false
        }
    }
}
