package com.choidev.choibuddy

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingsTest {
    private val a = Pairing("http://100.1.1.1:47130", "a".repeat(20))
    private val b = Pairing("http://desktop-b:47130", "b".repeat(20))

    @Test
    fun addAppendsNewPc() {
        assertEquals(listOf(a, b), Pairings.add(listOf(a), b))
        assertEquals(listOf(a), Pairings.add(emptyList(), a))
    }

    @Test
    fun addWithSameAddressReplacesTokenInPlace() {
        val renewed = Pairing(a.baseUrl, "n".repeat(20))

        assertEquals(listOf(renewed, b), Pairings.add(listOf(a, b), renewed))
    }

    @Test
    fun removeDropsOnlyThatAddress() {
        assertEquals(listOf(b), Pairings.remove(listOf(a, b), a.baseUrl))
        assertEquals(listOf(a, b), Pairings.remove(listOf(a, b), "http://unknown:1"))
    }

    @Test
    fun migratesSinglePairingFromOlderVersion() {
        assertEquals(listOf(a), Pairings.migrate(storedJson = null, legacy = a))
        assertEquals(emptyList<Pairing>(), Pairings.migrate(storedJson = null, legacy = null))
    }

    @Test
    fun storedListWinsOverLegacy() {
        assertEquals(listOf(b), Pairings.migrate(Wire.pairingsJson(listOf(b)), legacy = a))
        assertEquals(emptyList<Pairing>(), Pairings.migrate("[]", legacy = a))
    }

    @Test
    fun brokenStoredListFallsBackInsteadOfCrashing() {
        assertEquals(listOf(a), Pairings.migrate("{not json", legacy = a))
        assertEquals(emptyList<Pairing>(), Pairings.migrate("{not json", legacy = null))
    }

    @Test
    fun addressAndHost() {
        assertEquals("100.1.1.1:47130", a.address)
        assertEquals("100.1.1.1", a.host)
        assertEquals("[fd7a::1]", Pairing("http://[fd7a::1]:47130", "x".repeat(16)).host)
    }
}
