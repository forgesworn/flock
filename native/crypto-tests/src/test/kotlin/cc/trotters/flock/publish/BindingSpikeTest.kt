package cc.trotters.flock.publish

// Binding spike (Task 2): confirms the org.rust-nostr:nostr-sdk-jvm:0.44.2 Kotlin
// API surface that Tasks 4 and 7 (nsec-tree/beacon crypto, gift wrap + signal
// event) are written against.
//
// RESULT: NO DEVIATIONS. Every name assumed by the plan — package `rust.nostr.sdk`,
// Keys/SecretKey/PublicKey, nip44Encrypt/nip44Decrypt + Nip44Version, EventBuilder
// (tags/customCreatedAt/signWithKeys/build), Kind, Tag.parse, Timestamp.fromSecs,
// Event.fromJson/verify/asJson/createdAt/kind — is exactly right and compiled +
// passed unmodified on the first run against the real binding jar (confirmed via
// `javap` against the downloaded nostr-sdk-jvm-0.44.2.jar, not just the compiler).
//
// Notes for later tasks:
// - The jar bundles a real native FFI lib for linux-x86-64 (glibc) among many
//   other targets (JNA-loaded `libnostr_sdk_ffi.so`), so these are genuine
//   Rust-backed crypto ops on this host, not stubs.
// - `EventBuilder`/`Keys`/etc. implement `AutoCloseable` (uniffi-generated
//   cleaner-backed wrappers) — fine to leave unclosed in short-lived JVM test
//   processes, but worth `.use { }`-wrapping in long-running Android code paths.
// - `Nip44Version` is an enum with a single member `V2` (no `V1`) in this build.
// - `EventBuilder.customCreatedAt`/`.tags` return `EventBuilder` (fluent/chainable).
// - `UnsignedEvent.id()` is nullable in Kotlin (hence `!!` below); `Event.id()` is not.
//
// See .superpowers/sdd/task-2-report.md (repo root) for the full confirmed-API table.

import org.junit.jupiter.api.Test
import rust.nostr.sdk.*
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BindingSpikeTest {
    private val skHex = "0101010101010101010101010101010101010101010101010101010101010101"

    @Test
    fun `keys parse and derive x-only pubkeys`() {
        val keys = Keys(SecretKey.parse(skHex))
        assertEquals(64, keys.publicKey().toHex().length)
    }

    @Test
    fun `nip44 v2 round-trips`() {
        val a = Keys.generate(); val b = Keys.generate()
        val ct = nip44Encrypt(a.secretKey(), b.publicKey(), "flock", Nip44Version.V2)
        assertEquals("flock", nip44Decrypt(b.secretKey(), a.publicKey(), ct))
    }

    @Test
    fun `event builder signs kind 1059 with custom created_at and tags`() {
        val keys = Keys.generate()
        val ev = EventBuilder(Kind(1059u), "x")
            .tags(listOf(Tag.parse(listOf("p", keys.publicKey().toHex())), Tag.parse(listOf("expiration", "123"))))
            .customCreatedAt(Timestamp.fromSecs(1_000_000u))
            .signWithKeys(keys)
        assertTrue(ev.verify())
        assertEquals(1_000_000uL, ev.createdAt().asSecs())
        assertTrue(ev.asJson().contains("\"kind\":1059"))
    }

    @Test
    fun `unsigned event exposes the computed id (rumor)`() {
        val keys = Keys.generate()
        val unsigned = EventBuilder(Kind(20078u), "payload")
            .tags(listOf(Tag.parse(listOf("d", "ssg/abc")), Tag.parse(listOf("t", "beacon"))))
            .customCreatedAt(Timestamp.fromSecs(1_000_000u))
            .build(keys.publicKey())
        assertEquals(64, unsigned.id()!!.toHex().length)
        assertTrue(unsigned.asJson().contains("\"id\""))
    }
}
