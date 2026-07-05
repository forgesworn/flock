package cc.trotters.flock.publish

import rust.nostr.sdk.EventBuilder
import rust.nostr.sdk.Keys
import rust.nostr.sdk.Kind
import rust.nostr.sdk.Nip44Version
import rust.nostr.sdk.SecretKey
import rust.nostr.sdk.PublicKey
import rust.nostr.sdk.Tag
import rust.nostr.sdk.Timestamp
import rust.nostr.sdk.nip44Encrypt

// NIP-59 gift wrap of a kind-20078 beacon signal — the Kotlin twin of
// app/src/giftwrap.ts giftWrap + src/signals.ts buildLocationSignal.
// Backdating, expiry window and tag order must match the JS byte-for-byte
// in behaviour (values are randomised; structure is fixed).

const val WRAP_EXPIRY_SECONDS = 16L * 86_400
private const val BACKDATE_WINDOW = 172_800L
const val SIGNAL_KIND = 20078
const val SEAL_KIND = 13
const val WRAP_KIND = 1059

/** now - random(0..2 days) — NIP-59 timing blur (giftwrap.ts wrapTime). */
private fun wrapTime(nowSec: Long, rand: () -> Double): Long =
    nowSec - (rand() * BACKDATE_WINDOW).toLong()

fun buildBeaconWrapJson(
    identitySkHex: String,
    seedHex: String,
    circleId: String,
    geohash: String,
    precision: Int,
    nowSec: Long,
    rand: () -> Double,
): String {
    val identityKeys = Keys(SecretKey.parse(identitySkHex))
    val inbox = deriveInbox(seedHex)
    val inboxPk = PublicKey.parse(inbox.pkHex)

    // 1. The rumor: an unsigned kind-20078 signal (buildSignalEvent + encryptBeacon).
    val content = encryptBeaconPayload(beaconKey(seedHex), geohash, precision, nowSec)
    val rumor = EventBuilder(Kind(SIGNAL_KIND.toUShort()), content)
        .tags(listOf(
            Tag.parse(listOf("d", "ssg/${groupIdHash(circleId)}")),
            Tag.parse(listOf("t", "beacon")),
        ))
        .customCreatedAt(Timestamp.fromSecs(nowSec.toULong()))
        .build(identityKeys.publicKey())

    // 2. The seal: kind 13, signed by the identity key, NIP-44 to the inbox.
    val sealContent = nip44Encrypt(identityKeys.secretKey(), inboxPk, rumor.asJson(), Nip44Version.V2)
    val seal = EventBuilder(Kind(SEAL_KIND.toUShort()), sealContent)
        .customCreatedAt(Timestamp.fromSecs(wrapTime(nowSec, rand).toULong()))
        .signWithKeys(identityKeys)

    // 3. The wrap: kind 1059 from a throwaway key, expiring 16 days after its
    //    (backdated) created_at — giftwrap.ts WRAP_EXPIRY_SECONDS.
    val ephemeral = Keys.generate()
    val wrapContent = nip44Encrypt(ephemeral.secretKey(), inboxPk, seal.asJson(), Nip44Version.V2)
    val wrapCreatedAt = wrapTime(nowSec, rand)
    return EventBuilder(Kind(WRAP_KIND.toUShort()), wrapContent)
        .tags(listOf(
            Tag.parse(listOf("p", inbox.pkHex)),
            Tag.parse(listOf("expiration", (wrapCreatedAt + WRAP_EXPIRY_SECONDS).toString())),
        ))
        .customCreatedAt(Timestamp.fromSecs(wrapCreatedAt.toULong()))
        .signWithKeys(ephemeral)
        .asJson()
}
