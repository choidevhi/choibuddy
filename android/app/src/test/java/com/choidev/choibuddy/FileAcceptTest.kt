package com.choidev.choibuddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileAcceptTest {
    private val known = mapOf("pdf" to "application/pdf", "jpg" to "image/jpeg", "png" to "image/png")

    private fun mimes(vararg accept: String) = FileAccept.mimeTypes(accept.toList(), known::get)

    @Test
    fun noAcceptMeansAnyFile() {
        assertEquals(listOf("*/*"), mimes())
        assertEquals(listOf("*/*"), mimes(""))
        assertEquals(listOf("*/*"), mimes(" ", ""))
    }

    @Test
    fun keepsMimeTypesAndMapsExtensions() {
        assertEquals(listOf("image/*"), mimes("image/*"))
        assertEquals(listOf("image/png", "image/jpeg", "application/pdf"), mimes("image/png", ".JPG", " .pdf "))
    }

    @Test
    fun splitsCommaJoinedAcceptAndDropsDuplicates() {
        assertEquals(listOf("image/*", "application/pdf"), mimes("image/*, .pdf,image/*"))
    }

    @Test
    fun unknownExtensionOpensEverything() {
        assertEquals(listOf("*/*"), mimes("image/*", ".xyz"))
    }

    @Test
    fun cameraOnlyWhenJpegFits() {
        assertTrue(FileAccept.allowsPhoto(listOf("*/*")))
        assertTrue(FileAccept.allowsPhoto(listOf("application/pdf", "image/*")))
        assertTrue(FileAccept.allowsPhoto(listOf("image/jpeg")))
        assertFalse(FileAccept.allowsPhoto(listOf("application/pdf")))
        assertFalse(FileAccept.allowsPhoto(listOf("image/png")))
    }
}
