package com.choidev.choibuddy

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Base64

/**
 * 클립보드에서 읽거나 사진 폴더에 저장하는 사진의 MIME·파일 이름·내용을 다룬다.
 * 실제 클립보드와 MediaStore는 [Photos]가 맡고, 여기는 안드로이드 없이 JVM 테스트로 확인한다.
 */
object ImageFiles {
    /** 클립보드에서 읽는 최대 크기. 넘으면 사진이 없는 것으로 본다. */
    const val MAX_BYTES = 20 * 1024 * 1024

    private const val MAX_NAME = 100

    // 공유 저장소의 파일 이름 한도(바이트). 한글 100자는 300바이트라 글자 수만 지켜서는 넘는다.
    private const val MAX_NAME_BYTES = 255
    private const val OTHER = "img"
    private val EXTENSIONS = mapOf(
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/gif" to "gif",
        "image/webp" to "webp",
        "image/bmp" to "bmp",
        "image/heic" to "heic",
    )
    private val IMAGE_MIME = Regex("image/[a-z0-9][a-z0-9.+-]*")
    private val EXTENSION = Regex("\\.([A-Za-z0-9]{1,10})$")
    private val STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")

    /** 소문자로 맞춘 사진 MIME. 사진이 아니거나 종류를 모르는 와일드카드(모든 사진)면 null. */
    fun imageMime(mime: String?): String? = mime?.trim()?.lowercase()?.takeIf(IMAGE_MIME::matches)

    /** [imageMime]을 거친 MIME의 확장자. 모르는 사진(image/avif 등)은 `img`. */
    fun extensionOf(mime: String): String = EXTENSIONS[mime] ?: OTHER

    /**
     * 파일 이름. 경로 구분자·제어 문자와 앞뒤 공백·점을 빼고, [mime]에 맞는 확장자를 보장하고, 100자 안으로 줄인다.
     * 이름이 비면 [fallback]. 확장자가 MIME과 다르면 바꾸지 않고 뒤에 붙인다(gif는 gif로 남아 움직임이 살아 있다).
     * 모르는 사진 MIME이면 이미 있는 확장자를 믿는다.
     */
    fun fileName(name: String?, mime: String, fallback: String): String {
        val clean = name.orEmpty().filterNot { it == '/' || it == '\\' || it.isISOControl() }.trim(::isEdge)
        val base = clean.ifEmpty { fallback }
        val extension = extensionOf(mime)
        val current = EXTENSION.find(base)?.groupValues?.get(1)?.takeIf { extension == OTHER || matches(it, extension) }
        val stem = if (current != null) base.dropLast(current.length + 1) else base

        return fit(stem, current ?: extension)
    }

    /** `clipboard-20261011-090503`처럼 시각을 붙인 이름. */
    fun stamped(prefix: String, now: LocalDateTime): String = "$prefix-${STAMP.format(now)}"

    /** JS가 보낸 base64(`data:…;base64,` 앞머리가 붙어 와도 된다). 깨졌거나 비었으면 null. */
    fun decode(base64: String): ByteArray? = try {
        Base64.getDecoder().decode(base64.substringAfter("base64,")).takeIf { it.isNotEmpty() }
    } catch (e: IllegalArgumentException) {
        null
    }

    /** [input]을 끝까지 읽는다. [max]바이트를 넘으면 그 자리에서 멈추고 null. */
    fun readUpTo(input: InputStream, max: Int): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return out.toByteArray()
            if (out.size() + read > max) return null

            out.write(buffer, 0, read)
        }
    }

    /** [taken]에 없는 이름. `a.png`가 있으면 `a (1).png`, `a (2).png`…(Android 10 이상에서 MediaStore가 붙이는 방식). */
    fun unique(fileName: String, taken: (String) -> Boolean): String {
        if (!taken(fileName)) return fileName

        val stem = fileName.substringBeforeLast('.')
        val extension = fileName.substringAfterLast('.')

        return generateSequence(1, Int::inc).map { "$stem ($it).$extension" }.first { !taken(it) }
    }

    /** UI에 넘기는 `{"name":…,"mime":…,"data":<base64>}`. */
    fun clipboardJson(name: String, mime: String, bytes: ByteArray): String {
        // base64 글자(A–Z a–z 0–9 + / =)는 JSON에서 이스케이프할 것이 없다. 20MB 사진을 JSONObject로 한 글자씩 다시 훑지 않는다.
        val data = Base64.getEncoder().encodeToString(bytes)

        return "{\"name\":${JSONObject.quote(name)},\"mime\":${JSONObject.quote(mime)},\"data\":\"$data\"}"
    }

    private fun matches(current: String, extension: String) =
        current.equals(extension, ignoreCase = true) || (extension == "jpg" && current.equals("jpeg", ignoreCase = true))

    // 앞의 점은 숨김 파일이 되고, 끝의 점·공백은 확장자 앞에 남으면 이상하다.
    private fun isEdge(char: Char) = char.isWhitespace() || char == '.'

    // 이름 끝을 잘라 글자 수와 바이트 한도 안에 넣는다. 이모지 같은 서로게이트 쌍은 반쪽만 남기지 않는다.
    private fun fit(stem: String, extension: String): String {
        val name = { length: Int -> "${stem.take(length).trimEnd(::isEdge)}.$extension" }
        var end = minOf(stem.length, MAX_NAME - extension.length - 1)
        while (end > 0 && (stem[end - 1].isHighSurrogate() || name(end).toByteArray().size > MAX_NAME_BYTES)) end--

        return name(end)
    }
}
