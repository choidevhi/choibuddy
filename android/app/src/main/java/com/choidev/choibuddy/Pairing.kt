package com.choidev.choibuddy

import org.json.JSONException
import java.net.URI
import java.net.URLDecoder

/** PC 앱 QR(`choibuddy://pair?u=<브리지 주소>&t=<기기 코드>`)이 담은 연결 정보. PC 한 대의 한 주소다. */
data class Pairing(val baseUrl: String, val token: String) {
    /** `호스트:포트`. 연결을 물을 때 보여 준다. */
    val address: String get() = baseUrl.substringAfter("://")

    /** 포트 없는 호스트. 연결 코드가 거절된 PC를 가리킬 때 쓴다. */
    val host: String get() = address.substringBeforeLast(':')

    companion object {
        private const val MIN_TOKEN_LENGTH = 16

        /** 올바른 연결 링크가 아니면 null. */
        fun parse(link: String): Pairing? = try {
            parseOrThrow(link.trim())
        } catch (e: IllegalArgumentException) {
            null
        }

        private fun parseOrThrow(link: String): Pairing? {
            val uri = URI.create(link)
            val isPairLink = uri.scheme.equals("choibuddy", ignoreCase = true) &&
                uri.host.equals("pair", ignoreCase = true) &&
                uri.rawPath in ROOT_PATHS
            if (!isPairLink) return null

            val params = (uri.rawQuery ?: return null).split('&').associate { part ->
                val pair = part.split('=', limit = 2)
                pair[0] to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
            }
            val baseUrl = params["u"]?.let(::baseUrlOf) ?: return null
            val token = params["t"]?.takeIf(::isToken) ?: return null

            return Pairing(baseUrl, token)
        }

        /** 경로·쿼리 없는 `http(s)://호스트:포트`만 받는다. 같은 PC인지 주소로 비교하므로 호스트는 소문자로 맞춘다. */
        private fun baseUrlOf(raw: String): String? {
            val uri = URI.create(raw)
            val scheme = uri.scheme?.lowercase()
            val valid = (scheme == "http" || scheme == "https") &&
                uri.host != null &&
                uri.port in 1..65535 &&
                uri.rawUserInfo == null &&
                uri.rawQuery == null &&
                uri.rawFragment == null &&
                uri.rawPath in ROOT_PATHS

            return if (valid) "$scheme://${uri.host.lowercase()}:${uri.port}" else null
        }

        // 토큰은 Authorization 헤더와 쿼리에 그대로 실린다. 공백·제어 문자가 없는 ASCII만 받는다.
        private fun isToken(token: String) = token.length >= MIN_TOKEN_LENGTH && token.all { it in '!'..'~' }

        private val ROOT_PATHS = setOf("", "/")
    }
}

/** 짝지은 PC 목록. 주소(baseUrl)가 같으면 같은 연결로 본다. */
object Pairings {
    /** 같은 주소가 있으면 자리는 두고 기기 코드만 바꾼다. 없으면 끝에 붙인다. */
    fun add(list: List<Pairing>, pairing: Pairing): List<Pairing> =
        if (list.any { it.baseUrl == pairing.baseUrl }) {
            list.map { if (it.baseUrl == pairing.baseUrl) pairing else it }
        } else {
            list + pairing
        }

    fun remove(list: List<Pairing>, baseUrl: String): List<Pairing> = list.filterNot { it.baseUrl == baseUrl }

    /**
     * 0.2까지는 연결을 하나만 저장했다([legacy]). 목록([storedJson])이 아직 없으면 그 하나로 목록을 만든다.
     * 저장된 목록이 깨졌으면 앱이 죽지 않게 옛 연결(없으면 빈 목록)로 돌아간다.
     */
    fun migrate(storedJson: String?, legacy: Pairing?): List<Pairing> {
        if (storedJson == null) return listOfNotNull(legacy)

        return try {
            Wire.pairings(storedJson)
        } catch (e: JSONException) {
            listOfNotNull(legacy)
        }
    }
}
