package com.choidev.choibuddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Locale

class LanguageTest {
    @Test
    fun acceptsTheFourUiTags() {
        assertEquals(Locale.KOREAN, Language.of("ko")?.locale)
        assertEquals(Locale.ENGLISH, Language.of("en")?.locale)
        assertEquals(Locale.JAPANESE, Language.of("ja")?.locale)
        assertEquals(Locale.FRENCH, Language.of("fr")?.locale)
    }

    @Test
    fun rejectsOtherTags() {
        for (tag in listOf("zh", "ko-KR", "KO", "", null)) assertNull(tag, Language.of(tag))
    }
}
