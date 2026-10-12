package com.choidev.choibuddy

import java.util.Locale

/** UI가 setLanguage로 고를 수 있는 언어. 고르기 전에는 시스템 언어를 따른다. */
enum class Language(val tag: String, val locale: Locale) {
    KO("ko", Locale.KOREAN),
    EN("en", Locale.ENGLISH),
    JA("ja", Locale.JAPANESE),
    FR("fr", Locale.FRENCH),
    ;

    companion object {
        fun of(tag: String?): Language? = entries.firstOrNull { it.tag == tag }
    }
}
