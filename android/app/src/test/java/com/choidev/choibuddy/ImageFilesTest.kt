package com.choidev.choibuddy

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.time.LocalDateTime
import java.util.Base64

class ImageFilesTest {
    private fun name(name: String?, mime: String = "image/png") = ImageFiles.fileName(name, mime, "fallback")

    @Test
    fun acceptsOnlyConcreteImageMimes() {
        assertEquals("image/png", ImageFiles.imageMime("image/png"))
        assertEquals("image/jpeg", ImageFiles.imageMime(" Image/JPEG "))
        assertEquals("image/svg+xml", ImageFiles.imageMime("image/svg+xml"))
        assertNull(ImageFiles.imageMime("image/*"))
        assertNull(ImageFiles.imageMime("image/"))
        assertNull(ImageFiles.imageMime("text/plain"))
        assertNull(ImageFiles.imageMime("application/octet-stream"))
        assertNull(ImageFiles.imageMime(""))
        assertNull(ImageFiles.imageMime(null))
    }

    @Test
    fun mapsMimeToExtension() {
        assertEquals("png", ImageFiles.extensionOf("image/png"))
        assertEquals("jpg", ImageFiles.extensionOf("image/jpeg"))
        assertEquals("gif", ImageFiles.extensionOf("image/gif"))
        assertEquals("webp", ImageFiles.extensionOf("image/webp"))
        assertEquals("bmp", ImageFiles.extensionOf("image/bmp"))
        assertEquals("heic", ImageFiles.extensionOf("image/heic"))
        assertEquals("img", ImageFiles.extensionOf("image/avif"))
    }

    @Test
    fun keepsMatchingExtensionAndAppendsOtherwise() {
        assertEquals("cat.png", name("cat.png"))
        assertEquals("cat.PNG", name("cat.PNG"))
        assertEquals("cat.jpeg", name("cat.jpeg", "image/jpeg"))
        assertEquals("cat.gif", name("cat", "image/gif"))
        assertEquals("cat.png.gif", name("cat.png", "image/gif"))
        assertEquals("v1.2 notes.png", name("v1.2 notes"))
    }

    @Test
    fun unknownImageTrustsExistingExtension() {
        assertEquals("pic.avif", name("pic.avif", "image/avif"))
        assertEquals("pic.img", name("pic", "image/avif"))
    }

    @Test
    fun stripsSeparatorsControlCharsAndEdgeDots() {
        assertEquals("etcpasswd.png", name("../etc/passwd"))
        assertEquals("ab c.png", name("a\\b\u0000 c\n.png"))
        assertEquals("hidden.png", name(" .hidden. "))
    }

    @Test
    fun emptyNameUsesFallback() {
        assertEquals("fallback.png", name(null))
        assertEquals("fallback.png", name(""))
        assertEquals("fallback.png", name(" /./ "))
    }

    @Test
    fun longNamesFitInHundredCharsAndKeepExtension() {
        val ascii = name("a".repeat(300) + ".png")
        assertEquals(100, ascii.length)
        assertTrue(ascii.endsWith("a.png"))

        val korean = name("가".repeat(120), "image/gif")
        assertTrue(korean.endsWith("가.gif"))
        assertTrue(korean.length <= 100)
        assertTrue(korean.toByteArray().size <= 255)
    }

    @Test
    fun cuttingNeverSplitsAnEmoji() {
        val emoji = "😀"
        val cut = name("x" + emoji.repeat(80))
        val stem = cut.removeSuffix(".png")

        assertTrue(cut.length <= 100)
        assertTrue(stem.endsWith(emoji))
        assertEquals(cut, String(cut.toByteArray(), Charsets.UTF_8))
    }

    @Test
    fun stampsWithDateAndTime() {
        val now = LocalDateTime.of(2026, 10, 11, 9, 5, 3)

        assertEquals("clipboard-20261011-090503", ImageFiles.stamped("clipboard", now))
    }

    @Test
    fun decodesBase64AndRejectsBrokenOrEmpty() {
        val bytes = byteArrayOf(1, 2, 3, -1)
        val base64 = Base64.getEncoder().encodeToString(bytes)

        assertArrayEquals(bytes, ImageFiles.decode(base64))
        assertArrayEquals(bytes, ImageFiles.decode("data:image/png;base64,$base64"))
        assertNull(ImageFiles.decode("not base64!"))
        assertNull(ImageFiles.decode(""))
    }

    @Test
    fun readsUpToTheLimit() {
        assertArrayEquals(ByteArray(10) { it.toByte() }, ImageFiles.readUpTo(trickle(10), 10))
        assertNull(ImageFiles.readUpTo(trickle(11), 10))
        assertArrayEquals(ByteArray(0), ImageFiles.readUpTo(trickle(0), 10))
    }

    @Test
    fun uniqueNumbersTakenNames() {
        val taken = setOf("a.png", "a (1).png")

        assertEquals("b.png", ImageFiles.unique("b.png", taken::contains))
        assertEquals("a (2).png", ImageFiles.unique("a.png", taken::contains))
    }

    @Test
    fun clipboardJsonRoundTrips() {
        val bytes = ByteArray(1000) { (it * 7).toByte() }
        val json = JSONObject(ImageFiles.clipboardJson("\"quoted\" 사진.png", "image/png", bytes))

        assertEquals("\"quoted\" 사진.png", json.getString("name"))
        assertEquals("image/png", json.getString("mime"))
        assertArrayEquals(bytes, Base64.getDecoder().decode(json.getString("data")))
        assertEquals(3, json.length())
    }

    // 실제 ContentResolver 스트림처럼 몇 바이트씩 나눠 준다.
    private fun trickle(size: Int): InputStream = object : ByteArrayInputStream(ByteArray(size) { it.toByte() }) {
        override fun read(b: ByteArray, off: Int, len: Int) = super.read(b, off, minOf(len, 3))
    }
}
