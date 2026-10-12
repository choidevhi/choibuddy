package com.choidev.choibuddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.net.URLEncoder

class PairingTest {
    private val token = "abcdef0123456789XYZ_-"

    // shared/protocol.ts의 pairingLink와 같은 모양(encodeURIComponent는 공백을 %20으로 쓴다).
    private fun link(baseUrl: String, token: String = this.token) =
        "choibuddy://pair?u=${encode(baseUrl)}&t=${encode(token)}"

    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    @Test
    fun parsesLinkFromPcApp() {
        assertEquals(
            Pairing("http://100.88.12.34:47130", token),
            Pairing.parse(link("http://100.88.12.34:47130")),
        )
    }

    @Test
    fun acceptsHttpsHostNamesAndTrailingSlash() {
        assertEquals(
            Pairing("https://desktop.tail1234.ts.net:47130", token),
            Pairing.parse(link("https://desktop.tail1234.ts.net:47130/")),
        )
    }

    @Test
    fun lowercasesHostSoTheSamePcAddressMatches() {
        assertEquals(
            Pairing("http://studio-pc:47130", token),
            Pairing.parse(link("HTTP://STUDIO-PC:47130")),
        )
    }

    @Test
    fun acceptsIpv6AndSurroundingWhitespace() {
        assertEquals(
            Pairing("http://[fd7a:115c:a1e0::1]:47130", token),
            Pairing.parse("  " + link("http://[fd7a:115c:a1e0::1]:47130") + "\n"),
        )
    }

    @Test
    fun parameterOrderDoesNotMatter() {
        val reversed = "choibuddy://pair?t=${encode(token)}&u=${encode("http://10.0.0.2:47130")}"

        assertEquals(Pairing("http://10.0.0.2:47130", token), Pairing.parse(reversed))
    }

    @Test
    fun keepsEncodedTokenCharacters() {
        val plusToken = "a+b/c=d0123456789abcdef"

        assertEquals(plusToken, Pairing.parse(link("http://10.0.0.2:47130", plusToken))?.token)
    }

    @Test
    fun rejectsWrongSchemeOrHost() {
        val query = "?u=${encode("http://10.0.0.2:47130")}&t=$token"

        assertNull(Pairing.parse("https://pair$query"))
        assertNull(Pairing.parse("choibuddy://connect$query"))
        assertNull(Pairing.parse("choibuddy:pair$query"))
        assertNull(Pairing.parse("choibuddy://pair/extra$query"))
    }

    @Test
    fun rejectsBadBaseUrl() {
        assertNull(Pairing.parse(link("http://100.88.12.34")))
        assertNull(Pairing.parse(link("ftp://100.88.12.34:47130")))
        assertNull(Pairing.parse(link("100.88.12.34:47130")))
        assertNull(Pairing.parse(link("http://100.88.12.34:47130/api")))
        assertNull(Pairing.parse(link("http://100.88.12.34:47130?x=1")))
        assertNull(Pairing.parse(link("http://user@100.88.12.34:47130")))
        assertNull(Pairing.parse(link("http://:47130")))
    }

    @Test
    fun rejectsMissingOrWeakToken() {
        val u = encode("http://10.0.0.2:47130")

        assertNull(Pairing.parse("choibuddy://pair?u=$u"))
        assertNull(Pairing.parse("choibuddy://pair?u=$u&t="))
        assertNull(Pairing.parse(link("http://10.0.0.2:47130", "0123456789abcde")))
        assertNull(Pairing.parse(link("http://10.0.0.2:47130", "0123456789 abcdef")))
        assertNull(Pairing.parse(link("http://10.0.0.2:47130", "0123456789abcdef\n")))
    }

    @Test
    fun acceptsMinimumTokenLength() {
        assertEquals("0123456789abcdef", Pairing.parse(link("http://10.0.0.2:47130", "0123456789abcdef"))?.token)
    }

    @Test
    fun rejectsGarbage() {
        assertNull(Pairing.parse(""))
        assertNull(Pairing.parse("올바르지 않은 코드"))
        assertNull(Pairing.parse("choibuddy://pair"))
        assertNull(Pairing.parse("choibuddy://pair?u=%zz&t=$token"))
    }
}
