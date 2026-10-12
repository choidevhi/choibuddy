package com.choidev.choibuddy

/**
 * `<input type="file" accept="…">`의 값을 파일 선택기에 넘길 MIME 목록으로 바꾼다.
 * 확장자(.pdf)는 [mimeOf]로 MIME을 찾는다(앱에서는 MimeTypeMap). 안드로이드 없이 JVM 테스트로 확인한다.
 */
object FileAccept {
    private const val ANY = "*/*"
    private val PHOTO_TYPES = setOf(ANY, "image/*", "image/jpeg")

    /**
     * 비었으면 아무 파일. 확장자 하나라도 MIME을 모르면 거르다 필요한 파일을 막을 수 있어 아무 파일로 연다.
     * WebView 버전에 따라 쉼표로 이어진 한 덩어리로 올 때도 있어 다시 나눈다.
     */
    fun mimeTypes(acceptTypes: List<String>, mimeOf: (extension: String) -> String?): List<String> {
        val entries = acceptTypes.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        val mimes = entries.map { entry ->
            if (entry.startsWith('.')) mimeOf(entry.removePrefix(".")) ?: return listOf(ANY) else entry
        }

        return mimes.distinct().ifEmpty { listOf(ANY) }
    }

    /** 카메라로 찍은 사진(JPEG)을 받는 입력인가. */
    fun allowsPhoto(mimeTypes: List<String>): Boolean = mimeTypes.any { it in PHOTO_TYPES }
}
