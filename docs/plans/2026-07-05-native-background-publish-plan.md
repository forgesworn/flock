# Native Background Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the flock Android app is backgrounded/locked, automatic location beacons for the active circle keep publishing natively — same policy, same wire format as the JS pipeline.

**Architecture:** A Kotlin pipeline (pure crypto/policy core + thin Android glue) receives fixes via a patched broadcast out of `@capacitor-community/background-geolocation`, gates them (foreground check, off-grid, no-report zones, cadence), builds the identical NIP-59 gift-wrapped kind-20078 beacon, and publishes over a short-lived WebSocket. JS mirrors a minimal config into Keystore-backed EncryptedSharedPreferences and reconciles a publish journal on resume. Spec: `docs/plans/2026-07-05-native-background-publish-design.md`.

**Tech Stack:** Kotlin (pure-JVM core + Android glue), `org.rust-nostr:nostr-sdk` 0.44.2 (secp256k1 Schnorr + NIP-44 only), `javax.crypto` (HMAC-SHA256/SHA-256/AES-GCM), OkHttp 4, `androidx.security:security-crypto`, `androidx.lifecycle:lifecycle-process`, vitest (golden vectors), JUnit via a standalone Gradle JVM project (no Android SDK needed for the crypto tests).

## Global Constraints

- British English everywhere (comments, docs, UI copy) — colour, initialise, behaviour.
- Commits: `type: description`. **No `Co-Authored-By` lines.**
- TDD: failing test first, then implement. Library modules stay pure.
- `src/` gates (`npm test`, `npm run typecheck`, `npm run lint`) must stay green after every task.
- Kotlin core files under `native/android-src/kotlin/` must import **no `android.*` classes** (they compile on host JVM for tests and on device).
- Pinned deps: `org.rust-nostr:nostr-sdk:0.44.2` (AAR) / `org.rust-nostr:nostr-sdk-jvm:0.44.2` (tests), `androidx.security:security-crypto:1.1.0-alpha06`, `androidx.lifecycle:lifecycle-process:2.8.7`, `com.squareup.okhttp3:okhttp:4.12.0`, Kotlin Gradle plugin `2.1.0`.
- This machine has no JDK/Android SDK. Task 2 bootstraps a user-space JDK (needed from Task 2 onward). APK assembly (Task 13's final verification) is deferred to Morgan's machine; everything else verifies locally.
- The generated `android/` project is gitignored — all native config lives in committed scripts/templates (`native/patch-android.mjs`, `native/android-src/`).
- Wire-format constants (must match JS byte-for-byte): beacon key = `HMAC-SHA256(seed, "canary:beacon:key")`; signal kind `20078`, tags `[["d","ssg/"+sha256hex(groupId)],["t","beacon"]]`; nsec-tree root = `HMAC-SHA256(key=seed, msg="nsec-tree-root")`; child = `HMAC-SHA256(key=root, msg="nsec-tree\0"+purpose+"\0"+uint32BE(index))`; inbox purpose `flock:inbox` index 0; NIP-59 backdating `now - random(0..172_800)`; wrap expiration `created_at + 16*86_400`; cadence `COARSE_MIN_INTERVAL=45`, `COARSE_HEARTBEAT=300`, `CADENCE_JITTER_FRACTION=0.2`; precision clamp 3..9, default 6, festival boost to 9.

---

### Task 1: Golden vectors — JS generator + regression test

**Files:**
- Create: `native/vectors/generate.test.ts`
- Create: `native/vectors/vectors.json` (generated, committed)
- Modify: `vitest.config.ts` (include `native/**/*.test.ts`)
- Modify: `package.json` (add `gen:vectors` script)

**Interfaces:**
- Produces: `native/vectors/vectors.json` with this exact shape (all later Kotlin tests consume it):

```json
{
  "identitySkHex": "…64 hex…", "identityPkHex": "…64 hex…",
  "seedHex": "…64 hex…", "circleId": "a1b2c3d4",
  "inbox": { "skHex": "…", "pkHex": "…" },
  "beaconKeyHex": "…",
  "groupIdHash": "…64 hex…",
  "geohash": [ { "lat": 51.5007, "lon": -0.1246, "precision": 6, "expected": "gcpuvp" }, … ],
  "derive": [ { "purpose": "flock:inbox", "index": 0, "skHex": "…", "pkHex": "…" }, … ],
  "beaconCiphertexts": [ { "geohash": "gcpuvp", "precision": 6, "timestamp": 1751700000, "ciphertextB64": "…" } ],
  "nip44": [ { "senderSkHex": "…", "recipientPkHex": "…", "plaintext": "flock vector", "ciphertext": "…" } ],
  "wraps": [ { "wrapJson": { …full signed kind-1059 event… }, "expect": { "rumorKind": 20078, "rumorPubkey": "…", "geohash": "gcpuvp", "precision": 6 } } ]
}
```

- [ ] **Step 1: Add the vitest include + npm script**

In `vitest.config.ts` change the include line to:

```ts
    include: ['src/**/*.test.ts', 'app/**/*.test.ts', 'server/**/*.test.mjs', 'native/**/*.test.ts'],
```

In `package.json` scripts add:

```json
    "gen:vectors": "FLOCK_GEN_VECTORS=1 vitest run native/vectors/generate.test.ts",
```

- [ ] **Step 2: Write the generator/regression test**

Create `native/vectors/generate.test.ts`. It has two jobs: with `FLOCK_GEN_VECTORS=1` it (re)writes `vectors.json` from the real JS implementations; otherwise it asserts the committed file still matches the deterministic outputs and that the randomised samples still decrypt — the JS-side regression test.

```ts
// Golden vectors for the native (Kotlin) publish pipeline. Deterministic
// pieces are byte-compared by the Kotlin tests; randomised pieces (AES-GCM,
// NIP-44, full wraps) are verified in the decrypt direction. Regenerate with
// `npm run gen:vectors` ONLY when the wire format deliberately changes.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveBeaconKey, encryptBeacon, decryptBeacon } from 'canary-kit'
import { hashGroupId } from 'canary-kit/nostr'
import { encode } from 'geohash-kit'
import { fromNsec, derive } from 'nsec-tree'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44encrypt, decrypt as nip44decrypt } from 'nostr-tools/nip44'
import { giftWrap, giftUnwrap, rawNip44Decrypt } from '../../app/src/giftwrap'
import { deriveInbox } from '../../app/src/keys'
import { buildLocationSignal } from '../../src/signals'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'vectors.json')
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16))

// Fixed inputs — NEVER real keys. Deliberately memorable filler.
const identitySkHex = '0101010101010101010101010101010101010101010101010101010101010101'
const seedHex = '0202020202020202020202020202020202020202020202020202020202020202'
const circleId = 'a1b2c3d4'

const GEOHASH_CASES = [
  { lat: 51.5007, lon: -0.1246, precision: 6 },
  { lat: 51.5007, lon: -0.1246, precision: 9 },
  { lat: -33.8568, lon: 151.2153, precision: 7 },
  { lat: 0, lon: 0, precision: 3 },
  { lat: 89.999, lon: 179.999, precision: 8 },
]
const DERIVE_CASES = [
  { purpose: 'flock:inbox', index: 0 },
  { purpose: 'flock:circle:a1b2c3d4', index: 0 },
  { purpose: 'flock:circle:a1b2c3d4', index: 3 },
]

async function build(): Promise<Record<string, unknown>> {
  const identityPkHex = getPublicKey(fromHex(identitySkHex))
  const inbox = deriveInbox(seedHex)
  const root = fromNsec(fromHex(seedHex))
  const signer = {
    pubkey: identityPkHex,
    nip44Encrypt: (peerPk: string, plaintext: string) =>
      nip44encrypt(plaintext, getConversationKey(fromHex(identitySkHex), peerPk)),
    signEvent: (tmpl: { kind: number; content: string; tags: string[][]; created_at: number }) =>
      finalizeEvent(tmpl, fromHex(identitySkHex)),
  }
  const unsigned = await buildLocationSignal({ groupId: circleId, seedHex, signalType: 'beacon', geohash: 'gcpuvp', precision: 6 })
  const wrap = await giftWrap(signer as never, inbox.pk, unsigned)
  return {
    identitySkHex, identityPkHex, seedHex, circleId,
    inbox: { skHex: toHex(inbox.sk), pkHex: inbox.pk },
    beaconKeyHex: toHex(deriveBeaconKey(seedHex)),
    groupIdHash: hashGroupId(circleId),
    geohash: GEOHASH_CASES.map((c) => ({ ...c, expected: encode(c.lat, c.lon, c.precision) })),
    derive: DERIVE_CASES.map((c) => {
      const id = derive(root, c.purpose, c.index)
      return { ...c, skHex: toHex(id.privateKey), pkHex: toHex(id.publicKey) }
    }),
    beaconCiphertexts: await (async () => {
      // encryptBeacon stamps its own Date.now() timestamp — decrypt to learn it
      // so the committed vector self-describes the expected payload exactly.
      const key = deriveBeaconKey(seedHex)
      const ciphertextB64 = await encryptBeacon(key, 'gcpuvp', 6)
      const payload = await decryptBeacon(key, ciphertextB64)
      return [{ geohash: 'gcpuvp', precision: 6, timestamp: payload.timestamp, ciphertextB64 }]
    })(),
    nip44: [{
      senderSkHex: identitySkHex, recipientPkHex: inbox.pk, plaintext: 'flock vector',
      ciphertext: nip44encrypt('flock vector', getConversationKey(fromHex(identitySkHex), inbox.pk)),
    }],
    wraps: [{ wrapJson: wrap, expect: { rumorKind: 20078, rumorPubkey: identityPkHex, geohash: 'gcpuvp', precision: 6 } }],
  }
}

describe('native golden vectors', () => {
  it('generates or verifies vectors.json', async () => {
    const fresh = await build()
    if (process.env.FLOCK_GEN_VECTORS === '1' || !existsSync(OUT)) {
      writeFileSync(OUT, JSON.stringify(fresh, null, 2) + '\n')
    }
    const v = JSON.parse(readFileSync(OUT, 'utf8')) as typeof fresh & Record<string, never>
    // Deterministic pieces must still match the JS implementations exactly.
    expect(v.inbox).toEqual(fresh.inbox)
    expect(v.beaconKeyHex).toEqual(fresh.beaconKeyHex)
    expect(v.groupIdHash).toEqual(fresh.groupIdHash)
    expect(v.geohash).toEqual(fresh.geohash)
    expect(v.derive).toEqual(fresh.derive)
    // Randomised pieces: the committed samples must still decrypt via JS.
    const beaconKey = deriveBeaconKey(seedHex)
    for (const b of v.beaconCiphertexts as { ciphertextB64: string; geohash: string; precision: number; timestamp: number }[]) {
      const p = await decryptBeacon(beaconKey, b.ciphertextB64)
      expect(p).toEqual({ geohash: b.geohash, precision: b.precision, timestamp: b.timestamp })
    }
    for (const n of v.nip44 as { senderSkHex: string; recipientPkHex: string; plaintext: string; ciphertext: string }[]) {
      expect(nip44decrypt(n.ciphertext, getConversationKey(fromHex(n.senderSkHex), n.recipientPkHex))).toBe(n.plaintext)
    }
    for (const w of v.wraps as { wrapJson: { pubkey: string; content: string }; expect: { rumorKind: number; rumorPubkey: string } }[]) {
      const inboxSk = fromHex((v.inbox as { skHex: string }).skHex)
      const rumor = await giftUnwrap(rawNip44Decrypt(inboxSk), w.wrapJson)
      expect(rumor?.kind).toBe(w.expect.rumorKind)
      expect(rumor?.pubkey).toBe(w.expect.rumorPubkey)
    }
  })
})
```

- [ ] **Step 3: Run the generator, verify it fails then passes**

Run: `npm run gen:vectors` — expected: PASS, and `native/vectors/vectors.json` now exists.
Run: `npx vitest run native/vectors/generate.test.ts` — expected: PASS (regression mode, file untouched).
Run: `git diff --stat` after a second plain run — expected: no change to `vectors.json` (deterministic).

- [ ] **Step 4: Full gates**

Run: `npm test && npm run typecheck` — expected: all green (26+ suites, the new one included).

- [ ] **Step 5: Commit**

```bash
git add native/vectors/ vitest.config.ts package.json
git commit -m "test: add golden vectors for the native publish pipeline"
```

---

### Task 2: JDK bootstrap + Kotlin JVM test harness + rust-nostr binding spike

**Files:**
- Create: `native/crypto-tests/settings.gradle.kts`
- Create: `native/crypto-tests/build.gradle.kts`
- Create: `native/crypto-tests/gradle/wrapper/` (via `gradle wrapper`)
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/BindingSpikeTest.kt`
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/Hex.kt`
- Modify: `package.json` (add `test:native` script), `.gitignore` (gradle build dirs)

**Interfaces:**
- Produces: `native/crypto-tests` Gradle project whose `main` source set is `../android-src/kotlin` — every later Kotlin core file lands there and is compiled+tested here.
- Produces: `Hex.kt` — `fun hexToBytes(hex: String): ByteArray`, `fun bytesToHex(bytes: ByteArray): String` (lowercase).

- [ ] **Step 1: Bootstrap a user-space JDK 21 (no sudo)**

```bash
mkdir -p ~/.local/jdk && cd ~/.local/jdk
curl -fsSL -o temurin21.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
tar xzf temurin21.tar.gz && rm temurin21.tar.gz
export JAVA_HOME=$(echo ~/.local/jdk/jdk-21*) && export PATH="$JAVA_HOME/bin:$PATH"
java -version
```

Expected: `openjdk version "21.…"`. (Executor: export these in every later shell that runs gradle.)

- [ ] **Step 2: Create the Gradle project**

`native/crypto-tests/settings.gradle.kts`:

```kotlin
rootProject.name = "flock-crypto-tests"
```

`native/crypto-tests/build.gradle.kts`:

```kotlin
// Host-JVM tests for the pure Kotlin publish core (native/android-src/kotlin).
// Runs with only a JDK — no Android SDK. The same sources are compiled into the
// APK by native/patch-android.mjs; rust-nostr's -jvm artifact stands in for the
// Android AAR here (identical Kotlin API, desktop native libs).
plugins { kotlin("jvm") version "2.1.0" }
repositories { mavenCentral() }
kotlin { jvmToolchain(21) }
sourceSets { main { kotlin.srcDir("../android-src/kotlin") } }
dependencies {
    implementation("org.rust-nostr:nostr-sdk-jvm:0.44.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
tasks.test { useJUnitPlatform() }
```

Generate the wrapper — one-off user-space Gradle install, then mint the committed wrapper with it:

```bash
mkdir -p ~/.local/gradle && cd ~/.local/gradle
curl -fsSL -o gradle.zip https://services.gradle.org/distributions/gradle-8.11.1-bin.zip
unzip -q gradle.zip && rm gradle.zip
cd /home/thinkpadx13/MintAI/forgesworn/flock/native/crypto-tests
~/.local/gradle/gradle-8.11.1/bin/gradle wrapper --gradle-version 8.11.1
```

Commit the wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.properties`) — later machines need only a JDK.

Add to root `.gitignore`:

```
native/crypto-tests/.gradle/
native/crypto-tests/build/
native/vectors/kotlin-wraps.json
```

Add to `package.json` scripts:

```json
    "test:native": "cd native/crypto-tests && ./gradlew --console=plain test",
```

- [ ] **Step 3: Write Hex.kt (first core file, proves the source-set wiring)**

`native/android-src/kotlin/cc/trotters/flock/publish/Hex.kt`:

```kotlin
package cc.trotters.flock.publish

fun hexToBytes(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "odd-length hex" }
    return ByteArray(hex.length / 2) { i ->
        ((Character.digit(hex[i * 2], 16) shl 4) + Character.digit(hex[i * 2 + 1], 16)).toByte()
    }
}

fun bytesToHex(bytes: ByteArray): String =
    bytes.joinToString("") { "%02x".format(it) }
```

- [ ] **Step 4: Write the failing binding spike test**

`native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/BindingSpikeTest.kt` — verifies the rust-nostr 0.44 Kotlin API surface this plan assumes. **If any name differs, fix the test to the real API and record the real names in a comment — Tasks 4 and 7 must use whatever this task confirms.**

```kotlin
package cc.trotters.flock.publish

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
```

- [ ] **Step 5: Run, adjust to the real API, get green**

Run: `npm run test:native`
Expected first run: compiles (Hex.kt included) and the spike either passes or fails on a renamed symbol — adjust imports/calls to the actual 0.44.2 binding API until PASS. Document any deviations in the test's comment.

- [ ] **Step 6: Commit**

```bash
git add native/crypto-tests native/android-src/kotlin .gitignore package.json
git commit -m "test: Kotlin JVM harness + rust-nostr binding spike for native publish"
```

---

### Task 3: Kotlin geohash encoder

**Files:**
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/Geohash.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/GeohashTest.kt`

**Interfaces:**
- Produces: `fun encodeGeohash(lat: Double, lon: Double, precision: Int): String` — identical output to geohash-kit `encode` for precision 1..12.

- [ ] **Step 1: Failing test against the vectors**

`GeohashTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.json.JSONObject
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.assertEquals

fun loadVectors(): JSONObject = JSONObject(File("../vectors/vectors.json").readText())

class GeohashTest {
    @Test
    fun `matches geohash-kit vectors`() {
        val cases = loadVectors().getJSONArray("geohash")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(
                c.getString("expected"),
                encodeGeohash(c.getDouble("lat"), c.getDouble("lon"), c.getInt("precision")),
            )
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:native` — expected: compile error, `encodeGeohash` not defined.

- [ ] **Step 3: Implement — a direct port of `geohash-kit/src/core.ts` `encode`**

`Geohash.kt`:

```kotlin
package cc.trotters.flock.publish

// Port of geohash-kit's encode (src/core.ts) — interleaved lon/lat bisection,
// base32 alphabet 0-9 b-z minus a,i,l,o. Must stay byte-identical to JS.
private const val BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

fun encodeGeohash(lat: Double, lon: Double, precision: Int): String {
    require(lat in -90.0..90.0) { "invalid latitude: $lat" }
    require(lon in -180.0..180.0) { "invalid longitude: $lon" }
    val p = precision.coerceIn(1, 12)
    var latMin = -90.0; var latMax = 90.0
    var lonMin = -180.0; var lonMax = 180.0
    val hash = StringBuilder()
    var bit = 0; var ch = 0; var isLon = true
    while (hash.length < p) {
        if (isLon) {
            val mid = (lonMin + lonMax) / 2
            if (lon >= mid) { ch = ch or (1 shl (4 - bit)); lonMin = mid } else lonMax = mid
        } else {
            val mid = (latMin + latMax) / 2
            if (lat >= mid) { ch = ch or (1 shl (4 - bit)); latMin = mid } else latMax = mid
        }
        isLon = !isLon
        bit++
        if (bit == 5) { hash.append(BASE32[ch]); bit = 0; ch = 0 }
    }
    return hash.toString()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:native` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/android-src/kotlin native/crypto-tests/src
git commit -m "feat: Kotlin geohash encoder for the native publish pipeline"
```

---

### Task 4: Kotlin nsec-tree derivation + beacon crypto

**Files:**
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/Crypto.kt`
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/NsecDerive.kt`
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/Beacon.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/DeriveTest.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/BeaconTest.kt`

**Interfaces:**
- Produces: `fun hmacSha256(key: ByteArray, msg: ByteArray): ByteArray`, `fun sha256(msg: ByteArray): ByteArray`, `fun aesGcmEncrypt(key: ByteArray, plaintext: ByteArray): String` (base64 of 12-byte-IV‖ct+tag), `fun aesGcmDecrypt(key: ByteArray, contentB64: String): ByteArray`.
- Produces: `fun treeRootFromSeed(seed: ByteArray): ByteArray`; `fun deriveChildSk(root: ByteArray, purpose: String, index: Int): ByteArray`; `data class Inbox(val skHex: String, val pkHex: String)`; `fun deriveInbox(seedHex: String): Inbox`.
- Produces: `fun beaconKey(seedHex: String): ByteArray`; `fun encryptBeaconPayload(key: ByteArray, geohash: String, precision: Int, timestamp: Long): String`; `fun groupIdHash(groupId: String): String`.
- Consumes: `hexToBytes`/`bytesToHex` (Task 2), rust-nostr `Keys`/`SecretKey` (as confirmed by Task 2's spike).

- [ ] **Step 1: Failing derivation test**

`DeriveTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class DeriveTest {
    private val v = loadVectors()

    @Test
    fun `deriveInbox matches nsec-tree`() {
        val inbox = deriveInbox(v.getString("seedHex"))
        val expected = v.getJSONObject("inbox")
        assertEquals(expected.getString("skHex"), inbox.skHex)
        assertEquals(expected.getString("pkHex"), inbox.pkHex)
    }

    @Test
    fun `child derivation matches every vector`() {
        val root = treeRootFromSeed(hexToBytes(v.getString("seedHex")))
        val cases = v.getJSONArray("derive")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val sk = deriveChildSk(root, c.getString("purpose"), c.getInt("index"))
            assertEquals(c.getString("skHex"), bytesToHex(sk))
            assertEquals(c.getString("pkHex"), rust.nostr.sdk.Keys(rust.nostr.sdk.SecretKey.parse(bytesToHex(sk))).publicKey().toHex())
        }
    }
}
```

- [ ] **Step 2: Failing beacon test**

`BeaconTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.json.JSONObject
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class BeaconTest {
    private val v = loadVectors()

    @Test
    fun `beacon key matches canary-kit`() {
        assertEquals(v.getString("beaconKeyHex"), bytesToHex(beaconKey(v.getString("seedHex"))))
    }

    @Test
    fun `group id hash matches`() {
        assertEquals(v.getString("groupIdHash"), groupIdHash(v.getString("circleId")))
    }

    @Test
    fun `decrypts the JS beacon ciphertext`() {
        val c = v.getJSONArray("beaconCiphertexts").getJSONObject(0)
        val plain = JSONObject(String(aesGcmDecrypt(beaconKey(v.getString("seedHex")), c.getString("ciphertextB64"))))
        assertEquals(c.getString("geohash"), plain.getString("geohash"))
        assertEquals(c.getInt("precision"), plain.getInt("precision"))
        assertEquals(c.getLong("timestamp"), plain.getLong("timestamp"))
    }

    @Test
    fun `own encryption round-trips with the payload shape JS expects`() {
        val key = beaconKey(v.getString("seedHex"))
        val ct = encryptBeaconPayload(key, "gcpuvp", 6, 1751700000L)
        val plain = JSONObject(String(aesGcmDecrypt(key, ct)))
        assertEquals("gcpuvp", plain.getString("geohash"))
        assertEquals(6, plain.getInt("precision"))
        assertEquals(1751700000L, plain.getLong("timestamp"))
    }
}
```

- [ ] **Step 3: Run to verify both fail**

Run: `npm run test:native` — expected: compile errors (symbols not defined).

- [ ] **Step 4: Implement Crypto.kt**

```kotlin
package cc.trotters.flock.publish

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

fun hmacSha256(key: ByteArray, msg: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(msg)

fun sha256(msg: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(msg)

private val rng = SecureRandom()

/** AES-256-GCM, 12-byte IV prepended, base64 — canary-kit's aesGcmEncrypt. */
fun aesGcmEncrypt(key: ByteArray, plaintext: ByteArray): String {
    require(key.size == 32) { "AES-256-GCM requires a 32-byte key" }
    val iv = ByteArray(12).also(rng::nextBytes)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    return Base64.getEncoder().encodeToString(iv + cipher.doFinal(plaintext))
}

fun aesGcmDecrypt(key: ByteArray, contentB64: String): ByteArray {
    require(key.size == 32) { "AES-256-GCM requires a 32-byte key" }
    val combined = Base64.getDecoder().decode(contentB64)
    require(combined.size >= 28) { "ciphertext too short" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, combined, 0, 12))
    return cipher.doFinal(combined, 12, combined.size - 12)
}
```

- [ ] **Step 5: Implement NsecDerive.kt**

```kotlin
package cc.trotters.flock.publish

import rust.nostr.sdk.Keys
import rust.nostr.sdk.SecretKey

// Port of nsec-tree's fromNsec + derive (nsec-tree/src/root-nsec.ts, derive.ts).
// tree_root = HMAC-SHA256(key = seed, msg = "nsec-tree-root");
// child     = HMAC-SHA256(key = root, msg = "nsec-tree\0" + purpose + "\0" + uint32BE(index)),
// retrying at index+1 on an invalid scalar (probability ≈ 2^-128).

private val NSEC_ROOT_LABEL = "nsec-tree-root".toByteArray(Charsets.UTF_8)
// "nsec-tree" + a NUL byte - nsec-tree/src/derive.ts DOMAIN_PREFIX.
private val DOMAIN_PREFIX = "nsec-tree".toByteArray(Charsets.UTF_8) + byteArrayOf(0)
private const val MAX_INDEX = 0x7FFFFFFF

fun treeRootFromSeed(seed: ByteArray): ByteArray = hmacSha256(seed, NSEC_ROOT_LABEL)

fun deriveChildSk(root: ByteArray, purpose: String, index: Int): ByteArray {
    var i = index
    while (i <= MAX_INDEX) {
        val purposeBytes = purpose.toByteArray(Charsets.UTF_8)
        val msg = DOMAIN_PREFIX + purposeBytes + byteArrayOf(0) +
            byteArrayOf((i ushr 24).toByte(), (i ushr 16).toByte(), (i ushr 8).toByte(), i.toByte())
        val candidate = hmacSha256(root, msg)
        try {
            SecretKey.parse(bytesToHex(candidate)) // validity check — throws on invalid scalar
            return candidate
        } catch (_: Exception) {
            candidate.fill(0)
            i++
        }
    }
    throw IllegalStateException("index overflow deriving $purpose")
}

data class Inbox(val skHex: String, val pkHex: String)

/** JS twin: deriveInbox(seedHex) = derive(fromNsec(seed), "flock:inbox", 0). */
fun deriveInbox(seedHex: String): Inbox {
    val sk = deriveChildSk(treeRootFromSeed(hexToBytes(seedHex)), "flock:inbox", 0)
    val skHex = bytesToHex(sk)
    return Inbox(skHex, Keys(SecretKey.parse(skHex)).publicKey().toHex())
}
```

- [ ] **Step 6: Implement Beacon.kt**

```kotlin
package cc.trotters.flock.publish

// canary-kit beacon twin (canary-kit/src/beacon.ts, nostr.ts).
private val BEACON_KEY_INFO = "canary:beacon:key".toByteArray(Charsets.UTF_8)

fun beaconKey(seedHex: String): ByteArray = hmacSha256(hexToBytes(seedHex), BEACON_KEY_INFO)

fun groupIdHash(groupId: String): String = bytesToHex(sha256(groupId.toByteArray(Charsets.UTF_8)))

/** {"geohash":…,"precision":…,"timestamp":…} — key order matches JS JSON.stringify. */
fun encryptBeaconPayload(key: ByteArray, geohash: String, precision: Int, timestamp: Long): String {
    val json = """{"geohash":"$geohash","precision":$precision,"timestamp":$timestamp}"""
    return aesGcmEncrypt(key, json.toByteArray(Charsets.UTF_8))
}
```

- [ ] **Step 7: Run to verify all pass**

Run: `npm run test:native` — expected: PASS (Derive + Beacon + earlier suites).

- [ ] **Step 8: Commit**

```bash
git add native/android-src/kotlin native/crypto-tests/src
git commit -m "feat: Kotlin nsec-tree derivation and beacon crypto, vector-verified"
```

---

### Task 5: Kotlin cadence gate

**Files:**
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/Cadence.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/CadenceTest.kt`

**Interfaces:**
- Produces: `data class BeaconCadence(val lastGeohash: String?, val lastSentAt: Long)`; `fun shouldEmitBeacon(candidateGeohash: String, prev: BeaconCadence, now: Long, minIntervalSeconds: Long, heartbeatSeconds: Long): Boolean`; `fun jitteredSeconds(baseSeconds: Long, jitterFraction: Double, rand: Double): Long`.

- [ ] **Step 1: Failing test — port the JS behaviours from `app/src/cadence.ts`**

`CadenceTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CadenceTest {
    private val none = BeaconCadence(null, 0)

    @Test fun `first beacon always sends`() = assertTrue(shouldEmitBeacon("gcpuvp", none, 1000, 45, 300))

    @Test fun `rate floor suppresses even a new cell`() =
        assertFalse(shouldEmitBeacon("gcpuvq", BeaconCadence("gcpuvp", 1000), 1030, 45, 300))

    @Test fun `new cell after the floor sends`() =
        assertTrue(shouldEmitBeacon("gcpuvq", BeaconCadence("gcpuvp", 1000), 1050, 45, 300))

    @Test fun `same cell inside heartbeat suppresses`() =
        assertFalse(shouldEmitBeacon("gcpuvp", BeaconCadence("gcpuvp", 1000), 1200, 45, 300))

    @Test fun `same cell past heartbeat sends`() =
        assertTrue(shouldEmitBeacon("gcpuvp", BeaconCadence("gcpuvp", 1000), 1300, 45, 300))

    @Test fun `clock skew reads as too soon`() =
        assertFalse(shouldEmitBeacon("gcpuvq", BeaconCadence("gcpuvp", 2000), 1000, 45, 300))

    @Test fun `jitter midpoint reproduces the base`() = assertEquals(45, jitteredSeconds(45, 0.2, 0.5))

    @Test fun `jitter bounds hold and clamp`() {
        assertEquals(36, jitteredSeconds(45, 0.2, 0.0))
        assertEquals(54, jitteredSeconds(45, 0.2, 1.0))
        assertEquals(54, jitteredSeconds(45, 0.2, 7.0)) // out-of-range rand clamps
        assertEquals(1, jitteredSeconds(1, 0.9, 0.0))   // floor at 1s
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:native` — expected: compile error.

- [ ] **Step 3: Implement Cadence.kt (direct port of `app/src/cadence.ts`)**

```kotlin
package cc.trotters.flock.publish

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/** The last automatic beacon broadcast for a circle (app/src/cadence.ts twin). */
data class BeaconCadence(val lastGeohash: String?, val lastSentAt: Long)

fun shouldEmitBeacon(
    candidateGeohash: String,
    prev: BeaconCadence,
    now: Long,
    minIntervalSeconds: Long,
    heartbeatSeconds: Long,
): Boolean {
    if (prev.lastGeohash == null || prev.lastSentAt == 0L) return true
    if (now - prev.lastSentAt < minIntervalSeconds) return false
    if (candidateGeohash != prev.lastGeohash) return true
    return now - prev.lastSentAt >= heartbeatSeconds
}

fun jitteredSeconds(baseSeconds: Long, jitterFraction: Double, rand: Double): Long {
    val r = min(1.0, max(0.0, rand))
    val fraction = min(1.0, max(0.0, jitterFraction))
    val factor = 1 + (r * 2 - 1) * fraction
    return max(1L, (baseSeconds * factor).roundToLong())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:native` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/android-src/kotlin native/crypto-tests/src
git commit -m "feat: Kotlin cadence gate port for native publish"
```

---

### Task 6: Kotlin no-report zones (geofence containment)

**Files:**
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/Geo.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/GeoTest.kt`

**Interfaces:**
- Produces: `data class LatLng(val lat: Double, val lon: Double)`; `sealed class Geofence` with `data class Circle(val centre: LatLng, val radiusMetres: Double)` and `data class Polygon(val vertices: List<LatLng>)`; `data class NoReportZone(val area: Geofence, val policy: String)` (`"withhold"`/`"coarse"`); `fun noReportPolicyAt(point: LatLng, zones: List<NoReportZone>, accuracyMetres: Double): String?`.
- Ports: `src/geofence.ts` (`classifyContainment`, haversine with `EARTH_RADIUS = 6_371_000`) + geohash-kit's `pointInPolygon`/`boundsFullyInsidePolygon`/`boundsOverlapsPolygon`/`segmentsIntersect` + `src/noreport.ts` `noReportPolicyAt`.

- [ ] **Step 1: Failing test — behaviours copied from `src/noreport.test.ts` and `src/geofence.accuracy.test.ts` semantics**

`GeoTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GeoTest {
    private val home = NoReportZone(Geofence.Circle(LatLng(51.5, -0.12), 200.0), "withhold")
    private val nans = NoReportZone(Geofence.Circle(LatLng(51.6, -0.10), 200.0), "coarse")
    private val square = NoReportZone(
        Geofence.Polygon(listOf(LatLng(51.49, -0.13), LatLng(51.49, -0.11), LatLng(51.51, -0.11), LatLng(51.51, -0.13))),
        "withhold",
    )

    @Test fun `confidently outside every zone is null`() =
        assertNull(noReportPolicyAt(LatLng(52.0, 0.5), listOf(home, nans, square), 25.0))

    @Test fun `crisply inside a withhold circle withholds`() =
        assertEquals("withhold", noReportPolicyAt(LatLng(51.5, -0.12), listOf(home), 0.0))

    @Test fun `possibly inside counts as inside (fail-safe)`() {
        // ~250 m east of the 200 m circle's centre, accuracy 100 m — the disc may cover it.
        assertEquals("withhold", noReportPolicyAt(LatLng(51.5, -0.1164), listOf(home), 100.0))
    }

    @Test fun `confidently outside with a tight fix is null`() =
        assertNull(noReportPolicyAt(LatLng(51.5, -0.1164), listOf(home), 10.0))

    @Test fun `withhold beats coarse across zones`() {
        val at = LatLng(51.5, -0.12) // inside home (withhold) and the polygon
        assertEquals("withhold", noReportPolicyAt(at, listOf(nans, home), 0.0))
    }

    @Test fun `coarse-only zone reports coarse`() =
        assertEquals("coarse", noReportPolicyAt(LatLng(51.6, -0.10), listOf(nans), 0.0))

    @Test fun `inside the polygon withholds`() =
        assertEquals("withhold", noReportPolicyAt(LatLng(51.50, -0.12), listOf(square), 0.0))
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:native` — expected: compile error.

- [ ] **Step 3: Implement Geo.kt**

```kotlin
package cc.trotters.flock.publish

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

// Ports of src/geofence.ts containment (accuracy-aware, fail-safe toward
// "possibly inside") and geohash-kit's planar polygon predicates, restricted to
// what the no-report cap needs. Must behave identically to the JS.

data class LatLng(val lat: Double, val lon: Double)

sealed class Geofence {
    data class Circle(val centre: LatLng, val radiusMetres: Double) : Geofence()
    data class Polygon(val vertices: List<LatLng>) : Geofence()
}

data class NoReportZone(val area: Geofence, val policy: String) // "withhold" | "coarse"

private const val EARTH_RADIUS_M = 6_371_000.0

fun haversineMetres(a: LatLng, b: LatLng): Double {
    val toRad = PI / 180
    val dLat = (b.lat - a.lat) * toRad
    val dLon = (b.lon - a.lon) * toRad
    val h = sin(dLat / 2) * sin(dLat / 2) +
        cos(a.lat * toRad) * cos(b.lat * toRad) * sin(dLon / 2) * sin(dLon / 2)
    return EARTH_RADIUS_M * 2 * atan2(sqrt(h), sqrt(1 - h))
}

// [lon, lat] pairs, even-odd ray casting — geohash-kit pointInPolygon.
private fun pointInPolygon(px: Double, py: Double, ring: List<DoubleArray>): Boolean {
    var inside = false
    var j = ring.size - 1
    for (i in ring.indices) {
        val (xi, yi) = ring[i][0] to ring[i][1]
        val (xj, yj) = ring[j][0] to ring[j][1]
        if ((yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside
        j = i
    }
    return inside
}

private fun cross(o: DoubleArray, a: DoubleArray, b: DoubleArray): Double =
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

private fun segmentsIntersect(a1: DoubleArray, a2: DoubleArray, b1: DoubleArray, b2: DoubleArray): Boolean {
    val d1 = cross(b1, b2, a1); val d2 = cross(b1, b2, a2)
    val d3 = cross(a1, a2, b1); val d4 = cross(a1, a2, b2)
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
    fun onSeg(p: DoubleArray, q: DoubleArray, r: DoubleArray): Boolean =
        cross(p, q, r) == 0.0 && r[0] in minOf(p[0], q[0])..maxOf(p[0], q[0]) && r[1] in minOf(p[1], q[1])..maxOf(p[1], q[1])
    return onSeg(b1, b2, a1) || onSeg(b1, b2, a2) || onSeg(a1, a2, b1) || onSeg(a1, a2, b2)
}

private class Bounds(val minLat: Double, val maxLat: Double, val minLon: Double, val maxLon: Double) {
    fun corners(): List<DoubleArray> = listOf(
        doubleArrayOf(minLon, minLat), doubleArrayOf(maxLon, minLat),
        doubleArrayOf(maxLon, maxLat), doubleArrayOf(minLon, maxLat),
    )
}

private fun boundsFullyInsidePolygon(b: Bounds, ring: List<DoubleArray>): Boolean {
    val corners = b.corners()
    if (!corners.all { pointInPolygon(it[0], it[1], ring) }) return false
    val edges = corners.indices.map { corners[it] to corners[(it + 1) % 4] }
    var j = ring.size - 1
    for (i in ring.indices) {
        for ((e1, e2) in edges) if (segmentsIntersect(e1, e2, ring[j], ring[i])) return false
        j = i
    }
    return true
}

private fun boundsOverlapsPolygon(b: Bounds, ring: List<DoubleArray>): Boolean {
    val corners = b.corners()
    if (corners.any { pointInPolygon(it[0], it[1], ring) }) return true
    if (ring.any { it[0] in b.minLon..b.maxLon && it[1] in b.minLat..b.maxLat }) return true
    val edges = corners.indices.map { corners[it] to corners[(it + 1) % 4] }
    var j = ring.size - 1
    for (i in ring.indices) {
        for ((e1, e2) in edges) if (segmentsIntersect(e1, e2, ring[j], ring[i])) return true
        j = i
    }
    return false
}

private fun uncertaintyBounds(p: LatLng, accuracyMetres: Double): Bounds {
    val dLat = accuracyMetres / 111_320.0
    val dLon = accuracyMetres / (111_320.0 * cos(p.lat * PI / 180))
    return Bounds(p.lat - dLat, p.lat + dLat, p.lon - dLon, p.lon + dLon)
}

/** Is the uncertainty disc confidently outside this fence? (src/geofence.ts fenceContainment) */
private fun fullyOutside(point: LatLng, accuracyMetres: Double, fence: Geofence): Boolean = when (fence) {
    is Geofence.Circle -> haversineMetres(point, fence.centre) - accuracyMetres >= fence.radiusMetres
    is Geofence.Polygon -> {
        val ring = fence.vertices.map { doubleArrayOf(it.lon, it.lat) }
        if (accuracyMetres <= 0) !pointInPolygon(point.lon, point.lat, ring)
        else !boundsOverlapsPolygon(uncertaintyBounds(point, accuracyMetres), ring)
    }
}

/**
 * Strictest suppression among the zones the fix is POSSIBLY inside, or null
 * when confidently outside them all (src/noreport.ts noReportPolicyAt).
 */
fun noReportPolicyAt(point: LatLng, zones: List<NoReportZone>, accuracyMetres: Double): String? {
    var strictest: String? = null
    for (z in zones) {
        if (fullyOutside(point, accuracyMetres, z.area)) continue
        if (z.policy != "coarse") return "withhold"
        strictest = "coarse"
    }
    return strictest
}
```

*(Note: `boundsFullyInsidePolygon` is retained for parity with the JS shape but only `fullyOutside` feeds the decision — same as the JS `noReportPolicyAt`, which only needs "not outside". If the Kotlin compiler flags it unused, delete it and the matching import lines.)*

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:native` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/android-src/kotlin native/crypto-tests/src
git commit -m "feat: Kotlin no-report zone containment for native publish"
```

---

### Task 7: Kotlin gift wrap + signal event

**Files:**
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/GiftWrap.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/GiftWrapTest.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/EmitWrapsTest.kt`

**Interfaces:**
- Produces: `fun buildBeaconWrapJson(identitySkHex: String, seedHex: String, circleId: String, geohash: String, precision: Int, nowSec: Long, rand: () -> Double): String` — a complete signed kind-1059 event JSON string, ready for `["EVENT", …]`.
- Consumes: `beaconKey`/`encryptBeaconPayload`/`groupIdHash` (Task 4), `deriveInbox` (Task 4), rust-nostr API as confirmed in Task 2.
- Produces (test artefact): `native/vectors/kotlin-wraps.json` — `[{ "wrapJson": {…}, "expect": { "geohash": "gcpuvp", "precision": 6 } }]`, consumed by Task 8.

- [ ] **Step 1: Failing structural test**

`GiftWrapTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.json.JSONObject
import org.junit.jupiter.api.Test
import rust.nostr.sdk.Event
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GiftWrapTest {
    private val v = loadVectors()

    @Test
    fun `wrap is a valid, backdated, expiring kind 1059 to the circle inbox`() {
        val now = 1_751_700_000L
        val json = buildBeaconWrapJson(
            v.getString("identitySkHex"), v.getString("seedHex"), v.getString("circleId"),
            "gcpuvp", 6, now,
        ) { 0.5 }
        val ev = Event.fromJson(json)
        assertTrue(ev.verify())
        assertEquals(1059uL, ev.kind().asU16().toULong())
        val o = JSONObject(json)
        val tags = o.getJSONArray("tags")
        val p = tags.getJSONArray(0); val exp = tags.getJSONArray(1)
        assertEquals("p", p.getString(0))
        assertEquals(v.getJSONObject("inbox").getString("pkHex"), p.getString(1))
        assertEquals("expiration", exp.getString(0))
        val createdAt = o.getLong("created_at")
        assertTrue(createdAt <= now) // backdated, never future
        assertTrue(createdAt >= now - 172_800)
        assertEquals(createdAt + 16 * 86_400L, exp.getString(1).toLong())
        // The wrap signer must be ephemeral — never the identity key.
        assertTrue(o.getString("pubkey") != v.getString("identityPkHex"))
    }
}
```

- [ ] **Step 2: Failing emission test (produces the reverse-direction artefact)**

`EmitWrapsTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Test
import java.io.File
import java.security.SecureRandom

/** Emits Kotlin-built wraps for the JS reverse-verification stage
 *  (native/vectors/verify-kotlin.test.ts). Gitignored output. */
class EmitWrapsTest {
    @Test
    fun `emit wraps for JS verification`() {
        val v = loadVectors()
        val rng = SecureRandom()
        val out = JSONArray()
        for (precision in listOf(4, 6)) {
            val geohash = "gcpuvp".take(precision)
            val json = buildBeaconWrapJson(
                v.getString("identitySkHex"), v.getString("seedHex"), v.getString("circleId"),
                geohash, precision,
                System.currentTimeMillis() / 1000,
            ) { rng.nextDouble() }
            out.put(JSONObject()
                .put("wrapJson", JSONObject(json))
                .put("expect", JSONObject().put("geohash", geohash).put("precision", precision)))
        }
        File("../vectors/kotlin-wraps.json").writeText(out.toString(2) + "\n")
    }
}
```

- [ ] **Step 3: Run to verify both fail**

Run: `npm run test:native` — expected: compile error (`buildBeaconWrapJson` not defined).

- [ ] **Step 4: Implement GiftWrap.kt**

```kotlin
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
```

(Adjust rust-nostr call names to whatever Task 2's spike confirmed.)

- [ ] **Step 5: Run to verify it passes and emits the artefact**

Run: `npm run test:native` — expected: PASS; `native/vectors/kotlin-wraps.json` exists.

- [ ] **Step 6: Commit**

```bash
git add native/android-src/kotlin native/crypto-tests/src
git commit -m "feat: Kotlin NIP-59 beacon gift wrap, structurally verified"
```

---

### Task 8: JS reverse verification of Kotlin wraps

**Files:**
- Create: `native/vectors/verify-kotlin.test.ts`

**Interfaces:**
- Consumes: `native/vectors/kotlin-wraps.json` (Task 7) and `vectors.json` (Task 1).
- Uses the **untouched** production decrypt path: `giftUnwrap` + `rawNip44Decrypt` (`app/src/giftwrap.ts`), `decryptBeacon` (canary-kit).

- [ ] **Step 1: Write the test**

```ts
// Reverse golden-vector stage: wraps built by the KOTLIN pipeline must decrypt
// through the untouched JS path with zero special-casing (the design doc's
// criterion). Skips when the Kotlin artefact hasn't been generated
// (`npm run test:native` produces it).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { giftUnwrap, rawNip44Decrypt } from '../../app/src/giftwrap'
import { deriveBeaconKey, decryptBeacon } from 'canary-kit'

const here = dirname(fileURLToPath(import.meta.url))
const WRAPS = resolve(here, 'kotlin-wraps.json')
const VECTORS = resolve(here, 'vectors.json')
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16))

describe.skipIf(!existsSync(WRAPS))('kotlin-built wraps decrypt via the JS pipeline', () => {
  it('unwraps and decrypts every emitted wrap', async () => {
    const v = JSON.parse(readFileSync(VECTORS, 'utf8'))
    const wraps = JSON.parse(readFileSync(WRAPS, 'utf8')) as {
      wrapJson: { pubkey: string; content: string; kind: number; tags: string[][] }
      expect: { geohash: string; precision: number }
    }[]
    expect(wraps.length).toBeGreaterThan(0)
    const inboxSk = fromHex(v.inbox.skHex)
    const beaconKey = deriveBeaconKey(v.seedHex)
    for (const w of wraps) {
      expect(w.wrapJson.kind).toBe(1059)
      const rumor = await giftUnwrap(rawNip44Decrypt(inboxSk), w.wrapJson)
      expect(rumor, 'giftUnwrap returned null — NIP-44 or seal mismatch').not.toBeNull()
      expect(rumor!.kind).toBe(20078)
      expect(rumor!.pubkey).toBe(v.identityPkHex)
      expect(rumor!.tags).toEqual([['d', `ssg/${v.groupIdHash}`], ['t', 'beacon']])
      const payload = await decryptBeacon(beaconKey, rumor!.content)
      expect(payload.geohash).toBe(w.expect.geohash)
      expect(payload.precision).toBe(w.expect.precision)
    }
  })
})
```

- [ ] **Step 2: Run the full cross-check**

Run: `npm run test:native && npx vitest run native/vectors/verify-kotlin.test.ts`
Expected: PASS — Kotlin wraps decrypt through the production JS path. (If `giftUnwrap` returns null, debug NIP-44/derivation in the Kotlin side — this is exactly the silent-failure class the vectors exist to catch.)

- [ ] **Step 3: Commit**

```bash
git add native/vectors/verify-kotlin.test.ts
git commit -m "test: JS reverse verification of Kotlin-built gift wraps"
```

---

### Task 9: Kotlin config + journal model

**Files:**
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/PublishConfig.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/PublishConfigTest.kt`

**Interfaces:**
- Produces:

```kotlin
data class PublishConfig(
    val skHex: String, val circleId: String, val seedHex: String,
    val precision: Int, val festivalUntil: Long,
    val relayUrls: List<String>, val zones: List<NoReportZone>, val offGridUntil: Long,
)
fun parsePublishConfig(json: String): PublishConfig?   // null on any malformed input
fun effectivePrecision(cfg: PublishConfig, nowSec: Long): Int  // festival boost to 9, clamp 3..9
```

- Consumes the exact JSON the JS mirror sends (Task 12's `NativePublishConfig`):

```json
{ "v": 1, "skHex": "…", "circleId": "…", "seedHex": "…", "precision": 6,
  "festivalUntil": 0, "relayUrls": ["wss://…"], "offGridUntil": 0,
  "noReportZones": [
    { "policy": "withhold", "area": { "kind": "circle", "centre": { "lat": 51.5, "lon": -0.12 }, "radiusMetres": 200 } },
    { "policy": "coarse", "area": { "kind": "polygon", "vertices": [ { "lat": 51.49, "lon": -0.13 }, … ] } }
  ] }
```

- [ ] **Step 1: Failing test**

`PublishConfigTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PublishConfigTest {
    private val json = """
      {"v":1,"skHex":"aa","circleId":"c1","seedHex":"bb","precision":6,
       "festivalUntil":0,"relayUrls":["wss://r1","wss://r2"],"offGridUntil":0,
       "noReportZones":[
         {"policy":"withhold","area":{"kind":"circle","centre":{"lat":51.5,"lon":-0.12},"radiusMetres":200}},
         {"area":{"kind":"polygon","vertices":[{"lat":1,"lon":1},{"lat":1,"lon":2},{"lat":2,"lon":2}]}}
       ]}
    """.trimIndent()

    @Test
    fun `parses the mirror shape`() {
        val c = parsePublishConfig(json)!!
        assertEquals("c1", c.circleId)
        assertEquals(listOf("wss://r1", "wss://r2"), c.relayUrls)
        assertEquals(2, c.zones.size)
        assertEquals("withhold", c.zones[0].policy)
        assertEquals("withhold", c.zones[1].policy) // unset policy defaults to withhold (noreport.ts)
        assertTrue(c.zones[1].area is Geofence.Polygon)
    }

    @Test fun `garbage returns null`() = assertNull(parsePublishConfig("{not json"))
    @Test fun `wrong version returns null`() = assertNull(parsePublishConfig("""{"v":2}"""))

    @Test
    fun `effective precision boosts to 9 during festival and clamps`() {
        val c = parsePublishConfig(json)!!
        assertEquals(6, effectivePrecision(c, 1000))
        assertEquals(9, effectivePrecision(c.copy(festivalUntil = 2000), 1000))
        assertEquals(6, effectivePrecision(c.copy(festivalUntil = 500), 1000)) // expired
        assertEquals(3, effectivePrecision(c.copy(precision = 1), 1000))       // clamp floor
        assertEquals(9, effectivePrecision(c.copy(precision = 99), 1000))      // clamp ceiling
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:native` — expected: compile error.

- [ ] **Step 3: Implement PublishConfig.kt**

```kotlin
package cc.trotters.flock.publish

import org.json.JSONObject

// The minimal mirrored config the JS side writes (native/publishMirror.ts).
// Anything malformed parses to null — the publisher then stays idle, which is
// the fail-safe direction (never publish on a half-understood config).

data class PublishConfig(
    val skHex: String,
    val circleId: String,
    val seedHex: String,
    val precision: Int,
    val festivalUntil: Long,
    val relayUrls: List<String>,
    val zones: List<NoReportZone>,
    val offGridUntil: Long,
)

private const val PRECISION_MIN = 3
private const val PRECISION_MAX = 9
private const val FESTIVAL_PRECISION = PRECISION_MAX

fun parsePublishConfig(json: String): PublishConfig? = try {
    val o = JSONObject(json)
    if (o.getInt("v") != 1) null else PublishConfig(
        skHex = o.getString("skHex"),
        circleId = o.getString("circleId"),
        seedHex = o.getString("seedHex"),
        precision = o.getInt("precision"),
        festivalUntil = o.optLong("festivalUntil", 0),
        relayUrls = o.getJSONArray("relayUrls").let { a -> (0 until a.length()).map { a.getString(it) } },
        zones = o.optJSONArray("noReportZones")?.let { a ->
            (0 until a.length()).map { i ->
                val z = a.getJSONObject(i)
                val area = z.getJSONObject("area")
                val fence = when (area.getString("kind")) {
                    "circle" -> Geofence.Circle(
                        LatLng(area.getJSONObject("centre").getDouble("lat"), area.getJSONObject("centre").getDouble("lon")),
                        area.getDouble("radiusMetres"),
                    )
                    "polygon" -> Geofence.Polygon(area.getJSONArray("vertices").let { vs ->
                        (0 until vs.length()).map { j ->
                            LatLng(vs.getJSONObject(j).getDouble("lat"), vs.getJSONObject(j).getDouble("lon"))
                        }
                    })
                    else -> throw IllegalArgumentException("unknown fence kind")
                }
                NoReportZone(fence, z.optString("policy", "withhold").ifEmpty { "withhold" })
            }
        } ?: emptyList(),
        offGridUntil = o.optLong("offGridUntil", 0),
    )
} catch (_: Exception) { null }

/** sharePrecisionOf twin: slider base clamped 3..9, festival boost (never lower). */
fun effectivePrecision(cfg: PublishConfig, nowSec: Long): Int {
    val base = cfg.precision.coerceIn(PRECISION_MIN, PRECISION_MAX)
    return if (cfg.festivalUntil > nowSec) maxOf(base, FESTIVAL_PRECISION) else base
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:native` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/android-src/kotlin native/crypto-tests/src
git commit -m "feat: Kotlin publish config parsing with fail-safe defaults"
```

---

### Task 10: Kotlin relay publisher (OkHttp WebSocket)

**Files:**
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/RelayPublisher.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/RelayPublisherTest.kt`

**Interfaces:**
- Produces: `interface RelayPublisher { fun publish(relayUrls: List<String>, eventJson: String): Int }` (returns the count of relays that answered `["OK", id, true]`) and `class OkHttpRelayPublisher(private val timeoutMs: Long = 10_000) : RelayPublisher`.
- The seam the inbound doc's Option A later swaps for a pooled client.

- [ ] **Step 1: Failing test with MockWebServer**

`RelayPublisherTest.kt`:

```kotlin
package cc.trotters.flock.publish

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.WebSocket
import org.json.JSONArray
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class RelayPublisherTest {
    private fun relayThatAccepts(): MockWebServer {
        val server = MockWebServer()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : okhttp3.WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = JSONArray(text)
                if (msg.getString(0) == "EVENT") {
                    val id = msg.getJSONObject(1).getString("id")
                    webSocket.send("""["OK","$id",true,""]""")
                }
            }
        }))
        return server
    }

    @Test
    fun `counts relays that OK the event`() {
        val server = relayThatAccepts()
        server.start()
        val url = "ws://${server.hostName}:${server.port}/"
        val n = OkHttpRelayPublisher(timeoutMs = 5_000)
            .publish(listOf(url), """{"id":"abc123","kind":1059,"content":"x","tags":[],"pubkey":"p","sig":"s","created_at":1}""")
        assertEquals(1, n)
        server.shutdown()
    }

    @Test
    fun `unreachable relay counts zero without throwing`() {
        val n = OkHttpRelayPublisher(timeoutMs = 1_000)
            .publish(listOf("ws://127.0.0.1:1/"), """{"id":"abc123"}""")
        assertEquals(0, n)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:native` — expected: compile error.

- [ ] **Step 3: Implement RelayPublisher.kt**

```kotlin
package cc.trotters.flock.publish

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** One-shot relay publish — services.ts fanOut twin: success = ≥1 relay OK. */
interface RelayPublisher {
    /** @return how many relays answered `["OK", id, true]` before the timeout. */
    fun publish(relayUrls: List<String>, eventJson: String): Int
}

class OkHttpRelayPublisher(private val timeoutMs: Long = 10_000) : RelayPublisher {
    private val client = OkHttpClient.Builder()
        .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .build()

    override fun publish(relayUrls: List<String>, eventJson: String): Int {
        val eventId = try { JSONObject(eventJson).getString("id") } catch (_: Exception) { return 0 }
        val accepted = AtomicInteger(0)
        val done = CountDownLatch(relayUrls.size)
        val sockets = relayUrls.map { url ->
            client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""["EVENT",$eventJson]""")
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val msg = JSONArray(text)
                        if (msg.getString(0) == "OK" && msg.getString(1) == eventId) {
                            if (msg.getBoolean(2)) accepted.incrementAndGet()
                            webSocket.close(1000, null)
                            done.countDown()
                        }
                    } catch (_: Exception) { /* ignore non-protocol chatter */ }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    done.countDown()
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { /* counted on OK */ }
            })
        }
        done.await(timeoutMs, TimeUnit.MILLISECONDS)
        sockets.forEach { it.cancel() }
        return accepted.get()
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:native` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/android-src/kotlin native/crypto-tests/src
git commit -m "feat: Kotlin one-shot relay publisher over OkHttp WebSockets"
```

---

### Task 11: Kotlin publisher orchestration

**Files:**
- Create: `native/android-src/kotlin/cc/trotters/flock/publish/Publisher.kt`
- Create: `native/crypto-tests/src/test/kotlin/cc/trotters/flock/publish/PublisherTest.kt`

**Interfaces:**
- Produces:

```kotlin
interface ConfigStore {
    fun getConfigJson(): String?
    fun getCadence(circleId: String): BeaconCadence
    fun setCadence(circleId: String, cadence: BeaconCadence)
    fun appendJournal(entryJson: String)
}
class FlockPublisher(
    private val store: ConfigStore,
    private val relays: RelayPublisher,
    private val isAppForegrounded: () -> Boolean,
    private val nowSec: () -> Long = { System.currentTimeMillis() / 1000 },
    private val rand: () -> Double = { java.security.SecureRandom().nextDouble() },
) { fun onFix(lat: Double, lon: Double, accuracyMetres: Double, fixTimeMs: Long) }
```

- Journal entry shapes (consumed by Task 12's plugin and Task 13's JS drain):
  - fix log: `{"t":"fix","at":<fix unix sec>,"rx":<received unix sec>}`
  - publish: `{"t":"pub","c":"<circleId>","g":"<geohash>","p":<precision>,"at":<sent unix sec>,"rl":<relaysAccepted>}`
- Consumes: everything from Tasks 4–10. Cadence constants: `COARSE_MIN_INTERVAL = 45L`, `COARSE_HEARTBEAT = 300L`, `CADENCE_JITTER_FRACTION = 0.2`.

- [ ] **Step 1: Failing tests (fakes, no Android)**

`PublisherTest.kt`:

```kotlin
package cc.trotters.flock.publish

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeStore(var config: String?) : ConfigStore {
    val cadences = HashMap<String, BeaconCadence>()
    val journal = ArrayList<String>()
    override fun getConfigJson() = config
    override fun getCadence(circleId: String) = cadences[circleId] ?: BeaconCadence(null, 0)
    override fun setCadence(circleId: String, cadence: BeaconCadence) { cadences[circleId] = cadence }
    override fun appendJournal(entryJson: String) { journal.add(entryJson) }
}

private class FakeRelays(var accept: Int) : RelayPublisher {
    val published = ArrayList<String>()
    override fun publish(relayUrls: List<String>, eventJson: String): Int {
        published.add(eventJson); return accept
    }
}

class PublisherTest {
    private val v = loadVectors()
    private fun config(zones: String = "[]", offGridUntil: Long = 0) = """
      {"v":1,"skHex":"${v.getString("identitySkHex")}","circleId":"${v.getString("circleId")}",
       "seedHex":"${v.getString("seedHex")}","precision":6,"festivalUntil":0,
       "relayUrls":["wss://r"],"offGridUntil":$offGridUntil,"noReportZones":$zones}
    """.trimIndent()

    private fun publisher(store: FakeStore, relays: FakeRelays, foreground: Boolean = false, now: Long = 1_751_700_000) =
        FlockPublisher(store, relays, { foreground }, { now }, { 0.5 })

    @Test
    fun `publishes a beacon and records cadence + journal`() {
        val store = FakeStore(config()); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5007, -0.1246, 10.0, 1_751_699_000_000)
        assertEquals(1, relays.published.size)
        val cad = store.getCadence(v.getString("circleId"))
        assertEquals("gcpuvp", cad.lastGeohash)
        assertTrue(store.journal.any { it.contains("\"t\":\"pub\"") && it.contains("gcpuvp") })
        assertTrue(store.journal.any { it.contains("\"t\":\"fix\"") })
    }

    @Test
    fun `foreground drops silently (JS owns it)`() {
        val store = FakeStore(config()); val relays = FakeRelays(1)
        publisher(store, relays, foreground = true).onFix(51.5, -0.12, 10.0, 0)
        assertEquals(0, relays.published.size)
        assertTrue(store.journal.isEmpty())
    }

    @Test
    fun `absent or malformed config idles`() {
        for (cfg in listOf(null, "{broken")) {
            val store = FakeStore(cfg); val relays = FakeRelays(1)
            publisher(store, relays).onFix(51.5, -0.12, 10.0, 0)
            assertEquals(0, relays.published.size)
        }
    }

    @Test
    fun `off-grid suppresses`() {
        val store = FakeStore(config(offGridUntil = 9_999_999_999)); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5, -0.12, 10.0, 0)
        assertEquals(0, relays.published.size)
    }

    @Test
    fun `a withhold no-report zone suppresses (fail-safe with accuracy)`() {
        val zones = """[{"policy":"withhold","area":{"kind":"circle","centre":{"lat":51.5007,"lon":-0.1246},"radiusMetres":200}}]"""
        val store = FakeStore(config(zones)); val relays = FakeRelays(1)
        publisher(store, relays).onFix(51.5007, -0.1246, 50.0, 0)
        assertEquals(0, relays.published.size)
        assertEquals(null, store.getCadence(v.getString("circleId")).lastGeohash)
    }

    @Test
    fun `cadence suppresses an identical cell inside the heartbeat`() {
        val store = FakeStore(config()); val relays = FakeRelays(1)
        val p1 = publisher(store, relays, now = 1_751_700_000)
        p1.onFix(51.5007, -0.1246, 10.0, 0)
        val p2 = publisher(store, relays, now = 1_751_700_100) // 100 s later, same cell, < 300 s heartbeat
        p2.onFix(51.5007, -0.1246, 10.0, 0)
        assertEquals(1, relays.published.size)
    }

    @Test
    fun `failed publish leaves cadence untouched so the next fix retries`() {
        val store = FakeStore(config()); val relays = FakeRelays(0)
        publisher(store, relays).onFix(51.5007, -0.1246, 10.0, 0)
        assertEquals(null, store.getCadence(v.getString("circleId")).lastGeohash)
        assertTrue(store.journal.none { it.contains("\"t\":\"pub\"") })
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:native` — expected: compile error.

- [ ] **Step 3: Implement Publisher.kt**

```kotlin
package cc.trotters.flock.publish

// The native outbound pipeline — the app/src/app.ts autoEmit twin for the
// backgrounded case. It must never decide policy differently from JS: same
// no-report fail-safe, same cadence gate, same retry-on-next-fix semantics.

const val COARSE_MIN_INTERVAL = 45L
const val COARSE_HEARTBEAT = 300L
const val CADENCE_JITTER_FRACTION = 0.2

interface ConfigStore {
    fun getConfigJson(): String?
    fun getCadence(circleId: String): BeaconCadence
    fun setCadence(circleId: String, cadence: BeaconCadence)
    fun appendJournal(entryJson: String)
}

class FlockPublisher(
    private val store: ConfigStore,
    private val relays: RelayPublisher,
    private val isAppForegrounded: () -> Boolean,
    private val nowSec: () -> Long = { System.currentTimeMillis() / 1000 },
    private val rand: () -> Double = { java.security.SecureRandom().nextDouble() },
) {
    fun onFix(lat: Double, lon: Double, accuracyMetres: Double, fixTimeMs: Long) {
        if (isAppForegrounded()) return // JS owns the foreground — never double-publish
        val cfg = store.getConfigJson()?.let(::parsePublishConfig) ?: return
        val now = nowSec()
        store.appendJournal("""{"t":"fix","at":${fixTimeMs / 1000},"rx":$now}""")
        if (cfg.offGridUntil > now) return
        // No-report cap (decideEmission's last word): possibly inside a withhold
        // zone → nothing; a coarse cap can't lower an already-coarse beacon.
        val cap = noReportPolicyAt(LatLng(lat, lon), cfg.zones, accuracyMetres)
        if (cap == "withhold") return
        val precision = effectivePrecision(cfg, now)
        val geohash = encodeGeohash(lat, lon, precision)
        val prev = store.getCadence(cfg.circleId)
        val send = shouldEmitBeacon(
            geohash, prev, now,
            jitteredSeconds(COARSE_MIN_INTERVAL, CADENCE_JITTER_FRACTION, rand()),
            jitteredSeconds(COARSE_HEARTBEAT, CADENCE_JITTER_FRACTION, rand()),
        )
        if (!send) return
        val wrapJson = buildBeaconWrapJson(cfg.skHex, cfg.seedHex, cfg.circleId, geohash, precision, now, rand)
        val accepted = try { relays.publish(cfg.relayUrls, wrapJson) } catch (_: Exception) { 0 }
        if (accepted > 0) {
            // Same semantics as autoEmit: only record once a relay accepted, so a
            // transient failure retries on the next fix.
            store.setCadence(cfg.circleId, BeaconCadence(geohash, now))
            store.appendJournal("""{"t":"pub","c":"${cfg.circleId}","g":"$geohash","p":$precision,"at":$now,"rl":$accepted}""")
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:native` — expected: PASS (all Kotlin suites).

- [ ] **Step 5: Commit**

```bash
git add native/android-src/kotlin native/crypto-tests/src
git commit -m "feat: Kotlin publisher orchestration — gates, wrap, publish, journal"
```

---

### Task 12: Android glue — encrypted store, receiver, Capacitor plugin

**Files:**
- Create: `native/android-src/kotlin-android/cc/trotters/flock/EncryptedConfigStore.kt`
- Create: `native/android-src/kotlin-android/cc/trotters/flock/FlockFixReceiver.kt`
- Create: `native/android-src/kotlin-android/cc/trotters/flock/FlockPublishPlugin.kt`
- Modify: `native/android-src/MainActivity.java` (register the plugin)

**Interfaces:**
- Consumes: `ConfigStore`, `FlockPublisher`, `OkHttpRelayPublisher`, `BeaconCadence` (Task 11/10/5).
- Produces (JS-visible plugin `FlockPublish`): `setConfig({ json: string })`, `clearConfig()`, `getJournal() → { entries: string[] }` (JSON strings, oldest first), `ackJournal({ count: number })`.
- No host tests (Android Keystore isn't available off-device) — this layer is deliberately thin; it compiles in Task 13 and is exercised in the hardware round-trip.

- [ ] **Step 1: EncryptedConfigStore.kt**

```kotlin
// Keystore-backed mirror of the minimal publish config + the publish journal.
// The design doc's data-access decision: written by JS while unlocked, cleared
// on lock/hide/reset/stop-sharing; a native task can read it without the
// WebView. Journal capped so it can never grow unbounded.
package cc.trotters.flock

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import cc.trotters.flock.publish.BeaconCadence
import cc.trotters.flock.publish.ConfigStore
import org.json.JSONArray

class EncryptedConfigStore(context: Context) : ConfigStore {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "flock-publish",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override fun getConfigJson(): String? = prefs.getString("config", null)

    fun setConfigJson(json: String?) {
        prefs.edit().apply { if (json == null) remove("config") else putString("config", json) }.apply()
    }

    /** Full teardown: config, cadence state and journal all go together. */
    fun clearAll() { prefs.edit().clear().apply() }

    override fun getCadence(circleId: String): BeaconCadence {
        val g = prefs.getString("cadence.$circleId.g", null)
        val at = prefs.getLong("cadence.$circleId.at", 0)
        return BeaconCadence(g, at)
    }

    override fun setCadence(circleId: String, cadence: BeaconCadence) {
        prefs.edit()
            .putString("cadence.$circleId.g", cadence.lastGeohash)
            .putLong("cadence.$circleId.at", cadence.lastSentAt)
            .apply()
    }

    override fun appendJournal(entryJson: String) {
        val arr = JSONArray(prefs.getString("journal", "[]"))
        arr.put(entryJson)
        // Cap: keep the newest 300 entries.
        val start = maxOf(0, arr.length() - 300)
        val trimmed = JSONArray()
        for (i in start until arr.length()) trimmed.put(arr.get(i))
        prefs.edit().putString("journal", trimmed.toString()).apply()
    }

    fun getJournal(): List<String> {
        val arr = JSONArray(prefs.getString("journal", "[]"))
        return (0 until arr.length()).map { arr.getString(it) }
    }

    fun ackJournal(count: Int) {
        val arr = JSONArray(prefs.getString("journal", "[]"))
        val remaining = JSONArray()
        for (i in count until arr.length()) remaining.put(arr.get(i))
        prefs.edit().putString("journal", remaining.toString()).apply()
    }
}
```

- [ ] **Step 2: FlockFixReceiver.kt**

```kotlin
// Receives the per-fix broadcast injected into the background-geolocation
// plugin by native/patch-android.mjs, and runs the native publish pipeline.
// Explicit-component intents only (the patch uses setClassName), so nothing
// outside this app can spoof a fix.
package cc.trotters.flock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import cc.trotters.flock.publish.FlockPublisher
import cc.trotters.flock.publish.OkHttpRelayPublisher
import java.util.concurrent.Executors

class FlockFixReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION = "cc.trotters.flock.FIX"
        private val executor = Executors.newSingleThreadExecutor()
        @Volatile private var publisher: FlockPublisher? = null
        @Volatile private var store: EncryptedConfigStore? = null

        fun store(context: Context): EncryptedConfigStore =
            store ?: synchronized(this) {
                store ?: EncryptedConfigStore(context.applicationContext).also { store = it }
            }

        private fun publisher(context: Context): FlockPublisher =
            publisher ?: synchronized(this) {
                publisher ?: FlockPublisher(
                    store(context),
                    OkHttpRelayPublisher(),
                    { ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) },
                ).also { publisher = it }
            }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val lat = intent.getDoubleExtra("lat", Double.NaN)
        val lon = intent.getDoubleExtra("lon", Double.NaN)
        if (lat.isNaN() || lon.isNaN()) return
        val accuracy = intent.getDoubleExtra("accuracy", 0.0)
        val time = intent.getLongExtra("time", System.currentTimeMillis())
        // Foreground check must happen on the main thread (we're on it here);
        // the pipeline itself (crypto + network) runs off it.
        val fg = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        if (fg) return
        val p = publisher(context)
        val pending = goAsync()
        executor.execute {
            try { p.onFix(lat, lon, accuracy, time) } finally { pending.finish() }
        }
    }
}
```

- [ ] **Step 3: FlockPublishPlugin.kt**

```kotlin
// Capacitor bridge for the native publish config + journal
// (native/publishMirror.ts is the JS side).
package cc.trotters.flock

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "FlockPublish")
class FlockPublishPlugin : Plugin() {
    private val store by lazy { FlockFixReceiver.store(context) }

    @PluginMethod
    fun setConfig(call: PluginCall) {
        val json = call.getString("json")
        if (json == null) { call.reject("missing json"); return }
        store.setConfigJson(json)
        call.resolve()
    }

    @PluginMethod
    fun clearConfig(call: PluginCall) {
        store.clearAll()
        call.resolve()
    }

    @PluginMethod
    fun getJournal(call: PluginCall) {
        val out = JSObject()
        out.put("entries", JSArray(store.getJournal()))
        call.resolve(out)
    }

    @PluginMethod
    fun ackJournal(call: PluginCall) {
        store.ackJournal(call.getInt("count") ?: 0)
        call.resolve()
    }
}
```

- [ ] **Step 4: Register in MainActivity.java**

In `native/android-src/MainActivity.java` add one line before `super.onCreate` (and mention FlockPublish in the header comment):

```java
    registerPlugin(FlockPublishPlugin.class);
```

- [ ] **Step 5: Sanity check — the pure core must not have grown Android imports**

Run: `grep -rn "^import android" native/android-src/kotlin/ && echo "FAIL: android import in pure core" || echo OK`
Expected: `OK`. Then run `npm run test:native` — expected: still PASS (the glue dir is not in the JVM test source set).

- [ ] **Step 6: Commit**

```bash
git add native/android-src
git commit -m "feat: Android glue — encrypted config store, fix receiver, FlockPublish plugin"
```

---

### Task 13: Build integration — patch-android.mjs

**Files:**
- Modify: `native/patch-android.mjs`

**Interfaces:**
- Consumes: everything under `native/android-src/kotlin/` and `kotlin-android/` (copied into the generated project), the plugin patch anchor in `@capacitor-community/background-geolocation`.
- Produces: a generated `android/` project that compiles the Kotlin pipeline into the APK.

- [ ] **Step 1: Extend the Java-copy step to include Kotlin trees**

After the existing `for (const f of […])` copy loop in `native/patch-android.mjs`, add:

```js
// Kotlin sources: the pure publish core (shared with native/crypto-tests) and
// the Android glue. cpSync replaces per-file copies — the trees are nested.
import { cpSync } from 'node:fs'
cpSync(resolve(here, 'android-src/kotlin/cc'), resolve(here, '../android/app/src/main/java/cc'), { recursive: true })
cpSync(resolve(here, 'android-src/kotlin-android/cc'), resolve(here, '../android/app/src/main/java/cc'), { recursive: true })
console.error('copied Kotlin publish pipeline into android/')
```

(Move the `import { cpSync }` up into the existing `node:fs` import statement: `import { readFileSync, writeFileSync, copyFileSync, cpSync } from 'node:fs'`.)

- [ ] **Step 2: Patch the Gradle files (idempotent, assert-guarded)**

Add to `patch-android.mjs`:

```js
// ── Kotlin + publish-pipeline dependencies ──────────────────────────────────
const rootGradlePath = resolve(here, '../android/build.gradle')
let rootGradle = readFileSync(rootGradlePath, 'utf8')
const AGP_ANCHOR = "classpath 'com.android.tools.build:gradle"
if (!rootGradle.includes(AGP_ANCHOR)) {
  throw new Error('patch-android: AGP classpath anchor not found — Capacitor template changed, update the patch')
}
if (!rootGradle.includes('kotlin-gradle-plugin')) {
  rootGradle = rootGradle.replace(
    new RegExp(`(\\s*)(${AGP_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*)`),
    `$1$2$1classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.0'`,
  )
  writeFileSync(rootGradlePath, rootGradle)
  console.error('added Kotlin Gradle plugin to root build.gradle')
}

const appGradlePath = resolve(here, '../android/app/build.gradle')
let appGradle = readFileSync(appGradlePath, 'utf8')
const APPLY_ANCHOR = "apply plugin: 'com.android.application'"
if (!appGradle.includes(APPLY_ANCHOR)) {
  throw new Error('patch-android: application plugin anchor not found — update the patch')
}
if (!appGradle.includes('kotlin-android')) {
  appGradle = appGradle.replace(APPLY_ANCHOR, `${APPLY_ANCHOR}\napply plugin: 'kotlin-android'`)
}
const PUBLISH_DEPS = `    // Native background publish (docs/plans/2026-07-05-native-background-publish-design.md)
    implementation "org.rust-nostr:nostr-sdk:0.44.2"
    implementation "androidx.security:security-crypto:1.1.0-alpha06"
    implementation "androidx.lifecycle:lifecycle-process:2.8.7"
    implementation "com.squareup.okhttp3:okhttp:4.12.0"`
if (!appGradle.includes('org.rust-nostr:nostr-sdk')) {
  const DEPS_ANCHOR = 'dependencies {'
  if (!appGradle.includes(DEPS_ANCHOR)) throw new Error('patch-android: dependencies block not found — update the patch')
  appGradle = appGradle.replace(DEPS_ANCHOR, `${DEPS_ANCHOR}\n${PUBLISH_DEPS}`)
}
writeFileSync(appGradlePath, appGradle)
console.error('patched app/build.gradle (kotlin plugin + publish deps)')
```

- [ ] **Step 3: Patch the geolocation plugin to broadcast fixes (assert-guarded)**

Add to `patch-android.mjs`:

```js
// ── Fix broadcast out of @capacitor-community/background-geolocation ───────
// The plugin delivers each fix to JS via the Capacitor bridge, which a
// backgrounded WebView suspends (the confirmed root cause — see the design
// doc). This patch ALSO hands every fix to FlockFixReceiver as an
// explicit-component broadcast, so the native pipeline sees fixes the JS
// can't. Applied to node_modules (regenerated on every build); the anchor
// assert makes a plugin update fail the build loudly, never silently.
const bgPluginPath = resolve(here,
  '../node_modules/@capacitor-community/background-geolocation/android/src/main/java/com/equimaps/capacitor_background_geolocation/BackgroundGeolocation.java')
let bgPlugin = readFileSync(bgPluginPath, 'utf8')
const FIX_HOOK_MARK = 'cc.trotters.flock.FIX'
if (!bgPlugin.includes(FIX_HOOK_MARK)) {
  const RECEIVE_ANCHOR = 'public void onReceive(Context context, Intent intent) {\n            String id = intent.getStringExtra("id");'
  if (!bgPlugin.includes(RECEIVE_ANCHOR)) {
    throw new Error('patch-android: background-geolocation ServiceReceiver anchor not found — plugin updated, revalidate the fix hook')
  }
  bgPlugin = bgPlugin.replace(RECEIVE_ANCHOR,
    `public void onReceive(Context context, Intent intent) {
            // flock: hand every fix to the native publish pipeline as well —
            // injected by native/patch-android.mjs, see docs/plans/
            // 2026-07-05-native-background-publish-design.md.
            Location flockFix = intent.getParcelableExtra("location");
            if (flockFix != null) {
                Intent fwd = new Intent("${FIX_HOOK_MARK}");
                fwd.setClassName(context.getPackageName(), "cc.trotters.flock.FlockFixReceiver");
                fwd.putExtra("lat", flockFix.getLatitude());
                fwd.putExtra("lon", flockFix.getLongitude());
                fwd.putExtra("accuracy", (double) flockFix.getAccuracy());
                fwd.putExtra("time", flockFix.getTime());
                context.sendBroadcast(fwd);
            }
            String id = intent.getStringExtra("id");`)
  writeFileSync(bgPluginPath, bgPlugin)
  console.error('patched background-geolocation: fix broadcast → FlockFixReceiver')
} else {
  console.error('background-geolocation fix broadcast already patched')
}
```

- [ ] **Step 4: Register the receiver in the manifest (same idempotent style as the service)**

Add to the manifest-patching section of `patch-android.mjs` (before the `if (changed)` write):

```js
// FlockFixReceiver — explicit-component broadcasts only, never exported.
const FIX_RECEIVER = `        <receiver
            android:name=".FlockFixReceiver"
            android:exported="false" />`
if (!xml.includes('android:name=".FlockFixReceiver"')) {
  xml = xml.replace('</application>', `${FIX_RECEIVER}\n    </application>`)
  changed = true
  console.error('added FlockFixReceiver to manifest')
}
```

- [ ] **Step 5: Verify what's verifiable here; defer the APK build**

Run: `node --check native/patch-android.mjs` — expected: exit 0 (syntax).
Run the plugin patch in isolation against the installed node_modules:

```bash
node -e "
const { readFileSync } = require('node:fs');
const src = readFileSync('node_modules/@capacitor-community/background-geolocation/android/src/main/java/com/equimaps/capacitor_background_geolocation/BackgroundGeolocation.java','utf8');
const anchor = 'public void onReceive(Context context, Intent intent) {\n            String id = intent.getStringExtra(\"id\");';
if (!src.includes(anchor)) { console.error('ANCHOR MISSING'); process.exit(1); }
console.log('anchor present');
"
```

Expected: `anchor present`.
**Deferred to a machine with the Android SDK (Morgan's):** `npm run apk` — expected to generate, patch, and assemble a debug APK with the Kotlin pipeline compiled in. Record this as an unchecked box for the hardware session.

- [ ] **Step 6: Commit**

```bash
git add native/patch-android.mjs
git commit -m "feat: build integration for the native publish pipeline (kotlin, deps, fix broadcast)"
```

---

### Task 14: JS config mirror (`native/publishMirror.ts`)

**Files:**
- Create: `native/publishMirror.ts`
- Create: `native/publishMirror.test.ts`

**Interfaces:**
- Consumes: `Persisted`, `Circle`, `Identity` types from `app/src/store.ts`; the `FlockPublish` plugin (Task 12).
- Produces (Task 15 wires these into app.ts):

```ts
export interface NativePublishConfig { v: 1; skHex: string; circleId: string; seedHex: string;
  precision: number; festivalUntil: number; relayUrls: string[];
  noReportZones: NoReportZone[]; offGridUntil: number }
export function buildNativePublishConfig(persisted: Persisted, sharing: boolean, basePrecision: number): NativePublishConfig | null
export async function syncNativePublishConfig(cfg: NativePublishConfig | null): Promise<void> // diffed; null → clearConfig
export async function clearNativePublish(): Promise<void>       // unconditional clearConfig (hide/reset/lock)
export interface NativeJournalEntry { t: 'fix' | 'pub'; at: number; rx?: number; c?: string; g?: string; p?: number; rl?: number }
export async function readNativeJournal(): Promise<NativeJournalEntry[]>
export async function ackNativeJournal(count: number): Promise<void>
```

- [ ] **Step 1: Failing test for the pure builder**

`native/publishMirror.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildNativePublishConfig } from './publishMirror'
import type { Persisted } from '../app/src/store'

const base = (): Persisted => ({
  identity: { skHex: 'aa'.repeat(32), pk: 'bb'.repeat(32) },
  circles: [{ id: 'c1', seedHex: 'cc'.repeat(32), name: 'x', mode: 'nightout' as const, sharePrecision: 7 }],
  activeCircleId: 'c1',
  relayUrls: ['wss://r1'],
  noReportZones: [{ area: { kind: 'circle' as const, centre: { lat: 1, lon: 2 }, radiusMetres: 50 } }],
  petnames: {}, presence: {},
})

describe('buildNativePublishConfig', () => {
  it('mirrors the active circle with defaulted zone policy', () => {
    const cfg = buildNativePublishConfig(base(), true, 7)
    expect(cfg).toMatchObject({
      v: 1, skHex: 'aa'.repeat(32), circleId: 'c1', seedHex: 'cc'.repeat(32),
      precision: 7, relayUrls: ['wss://r1'], offGridUntil: 0, festivalUntil: 0,
    })
    expect(cfg?.noReportZones[0].policy ?? 'withhold').toBe('withhold')
  })

  it('is null when not sharing', () => {
    expect(buildNativePublishConfig(base(), false, 7)).toBeNull()
  })

  it('is null for a Signet identity (no local key to seal with)', () => {
    const p = base(); p.identity = { pk: 'bb'.repeat(32) }; p.authMethod = 'signet'
    expect(buildNativePublishConfig(p, true, 7)).toBeNull()
  })

  it('is null with no active circle', () => {
    const p = base(); p.activeCircleId = null
    expect(buildNativePublishConfig(p, true, 7)).toBeNull()
  })

  it('carries festival and off-grid deadlines', () => {
    const p = base()
    p.circles[0].festivalUntil = 123
    p.offGridUntil = 456
    const cfg = buildNativePublishConfig(p, true, 7)
    expect(cfg?.festivalUntil).toBe(123)
    expect(cfg?.offGridUntil).toBe(456)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run native/publishMirror.test.ts` — expected: FAIL (module missing).

- [ ] **Step 3: Implement publishMirror.ts**

```ts
// JS side of the native background publish pipeline: mirrors the MINIMUM
// config (identity sk, active circle seed + precision, relays, no-report
// zones, off-grid) into the Keystore-backed native store, and reads back the
// publish journal on resume. Design: docs/plans/
// 2026-07-05-native-background-publish-design.md. The mirror must be cleared
// on lock engage, decoy hide, reset and stop-sharing — app.ts owns calling us.

import { registerPlugin } from '@capacitor/core'
import type { Persisted } from '../app/src/store'
import type { NoReportZone } from '@forgesworn/flock'

interface FlockPublishPlugin {
  setConfig(options: { json: string }): Promise<void>
  clearConfig(): Promise<void>
  getJournal(): Promise<{ entries: string[] }>
  ackJournal(options: { count: number }): Promise<void>
}

const FlockPublish = registerPlugin<FlockPublishPlugin>('FlockPublish')

export interface NativePublishConfig {
  v: 1
  skHex: string
  circleId: string
  seedHex: string
  precision: number
  festivalUntil: number
  relayUrls: string[]
  noReportZones: NoReportZone[]
  offGridUntil: number
}

/** Pure: the config to mirror, or null when background publish must be off
 *  (not sharing, no local key — Signet, no circle). Null clears the mirror. */
export function buildNativePublishConfig(
  persisted: Persisted,
  sharing: boolean,
  basePrecision: number,
): NativePublishConfig | null {
  if (!sharing) return null
  const skHex = persisted.identity?.skHex
  if (!skHex || persisted.authMethod === 'signet') return null
  const circle = persisted.circles.find((c) => c.id === persisted.activeCircleId)
  if (!circle) return null
  return {
    v: 1,
    skHex,
    circleId: circle.id,
    seedHex: circle.seedHex,
    precision: basePrecision,
    festivalUntil: circle.festivalUntil ?? 0,
    relayUrls: persisted.relayUrls,
    noReportZones: persisted.noReportZones,
    offGridUntil: persisted.offGridUntil ?? 0,
  }
}

/** Sentinel meaning "last attempt failed — always retry on the next sync". */
const RETRY = Symbol('retry')
let lastSent: string | null | typeof RETRY = RETRY

/** Diffed sync — only crosses the bridge when the config actually changed. */
export async function syncNativePublishConfig(cfg: NativePublishConfig | null): Promise<void> {
  const json = cfg === null ? null : JSON.stringify(cfg)
  if (json === lastSent) return
  lastSent = json
  try {
    if (json === null) await FlockPublish.clearConfig()
    else await FlockPublish.setConfig({ json })
  } catch { lastSent = RETRY /* plugin missing (old shell/web) — retry next sync */ }
}

/** Unconditional teardown (hide / reset / lock) — never leaves seeds behind. */
export async function clearNativePublish(): Promise<void> {
  lastSent = null
  try { await FlockPublish.clearConfig() } catch { /* plugin unavailable */ }
}

export interface NativeJournalEntry {
  t: 'fix' | 'pub'
  at: number
  rx?: number
  c?: string
  g?: string
  p?: number
  rl?: number
}

export async function readNativeJournal(): Promise<NativeJournalEntry[]> {
  try {
    const { entries } = await FlockPublish.getJournal()
    return entries.flatMap((e) => {
      try { return [JSON.parse(e) as NativeJournalEntry] } catch { return [] }
    })
  } catch { return [] }
}

export async function ackNativeJournal(count: number): Promise<void> {
  try { await FlockPublish.ackJournal({ count }) } catch { /* plugin unavailable */ }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run native/publishMirror.test.ts` — expected: PASS.
Run: `npm run typecheck && npm test` — expected: green.

- [ ] **Step 5: Commit**

```bash
git add native/publishMirror.ts native/publishMirror.test.ts
git commit -m "feat: JS config mirror + journal bridge for native publish"
```

---

### Task 15: Wire app.ts — sync, teardown, resume reconciliation, degraded note

**Files:**
- Modify: `app/src/app.ts`

**Interfaces:**
- Consumes: `buildNativePublishConfig`, `syncNativePublishConfig`, `clearNativePublish`, `readNativeJournal`, `ackNativeJournal` (Task 14); existing `render()` (app.ts:946), `onForeground()` (app.ts:~800), `hideNow()` (~3861), `resetDevice()` (~4090), `saveBeacon(circleId, beacon)` (284), `beaconCadence` map, `sharing` flag, `baseSharePrecision(c)` (441), `isNativeShell()`.

- [ ] **Step 1: Add the sync hook at the end of `render()`**

In `app/src/app.ts`, at the end of the `render()` function body (after the existing DOM work), add:

```ts
  // Native shell: keep the background-publish mirror in step with state. Diffed
  // inside the module — this is a cheap no-op unless something changed.
  if (isNativeShell()) {
    void import('../../native/publishMirror').then((m) =>
      m.syncNativePublishConfig(m.buildNativePublishConfig(persisted, sharing, baseSharePrecision(activeCircle()))),
    ).catch(() => { /* plugin unavailable */ })
  }
```

- [ ] **Step 2: Teardown calls**

In `hideNow()` right after the `stopStayReachable()` line, add:

```ts
  try { await (await import('../../native/publishMirror')).clearNativePublish() } catch { /* not running */ }
```

In `resetDevice()` alongside the other native teardowns (after the `stopStayReachable()` line), add:

```ts
  void import('../../native/publishMirror').then((m) => m.clearNativePublish()).catch(() => { /* not running */ })
```

In `bootLocked()` (app.ts:~730 — the locked boot: grace attempt, else PIN screen), add the clear immediately before the `renderLockScreen()` fallthrough (NOT on the successful grace-unlock path, which is still an unlocked session):

```ts
  // Locked at rest with no live session ⇒ background publish must be off — the
  // design doc's degrade-to-foreground-only rule. Cleared before the PIN screen.
  void import('../../native/publishMirror').then((m) => m.clearNativePublish()).catch(() => { /* plugin unavailable */ })
  renderLockScreen()
```

This is the "locked at rest ⇒ background publish unavailable" behaviour from the design doc.

- [ ] **Step 3: Resume journal reconciliation**

Add near `onFix` (module scope):

```ts
/** Drain the native publish journal: adopt background beacons into my own pin
 *  history and cadence so reopening the app never double-sends or lies about
 *  "last shared". The fix-log entries are the split measurement (design doc
 *  verification §3) — surfaced via console for field debugging. */
async function drainNativeJournal(): Promise<void> {
  if (!isNativeShell()) return
  try {
    const m = await import('../../native/publishMirror')
    const entries = await m.readNativeJournal()
    if (!entries.length) return
    const id = persisted.identity
    for (const e of entries) {
      if (e.t !== 'pub' || !id || !e.c || !e.g || e.p === undefined) continue
      saveBeacon(e.c, { member: id.pk, geohash: e.g, precision: e.p, timestamp: e.at })
      const prev = beaconCadence.get(e.c)
      if (!prev || e.at > prev.lastSentAt) beaconCadence.set(e.c, { lastGeohash: e.g, lastSentAt: e.at })
    }
    await m.ackNativeJournal(entries.length)
    refresh()
  } catch { /* plugin unavailable */ }
}
```

Call it from `onForeground()` (the existing resume callback at ~app.ts:805): add `void drainNativeJournal()` as its first line, and add one call during mount after the initial load (next to where `onResume` is wired).

- [ ] **Step 4: The degraded note for Signet identities**

In the sharing status label (app.ts ~1028, the `state-share` branch), extend the `sub` text when the identity cannot background-publish:

```ts
    if (sharing && fix) {
      const bgNote = isNativeShell() && persisted.authMethod === 'signet'
        ? ' · pauses while flock is closed (Signet sign-in)'
        : ''
      return { cls: 'state-share', label: 'Sharing live', sub: `${precisionLabel(sharePrecisionOf(c))} · your circle can see you${bgNote}` }
    }
```

(Adapt to the exact existing expression — keep the current copy and append `bgNote`.)

- [ ] **Step 5: Gates**

Run: `npm run typecheck && npm test && npm run lint` — expected: all green.
Run: `npm run build:app` — expected: Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/src/app.ts
git commit -m "feat: wire native background publish — mirror sync, teardown, journal drain"
```

---

### Task 16: Docs, status flip, hardware runbook

**Files:**
- Modify: `docs/plans/2026-07-05-native-background-publish.md` (status)
- Create: `docs/runbooks/native-background-publish-test.md`
- Modify: `CLAUDE.md` (native section), `README.md` (if it lists module status)

**Interfaces:** none — documentation.

- [ ] **Step 1: Flip the plan doc status**

In `docs/plans/2026-07-05-native-background-publish.md` change the status line to:

```markdown
**Date:** 2026-07-05 · **Owner:** TBD · **Status:** built (outbound) — golden-vector
verified both directions; awaiting hardware round-trip
([runbook](../runbooks/native-background-publish-test.md)); design + decisions in
[`2026-07-05-native-background-publish-design.md`](2026-07-05-native-background-publish-design.md)
```

- [ ] **Step 2: Write the turnkey hardware runbook**

`docs/runbooks/native-background-publish-test.md`:

```markdown
# Native background publish — hardware verification runbook

The build machine needs the Android SDK + JDK 21 (`npm run apk`). Two phones
(A = sharer, B = observer), both on the same circle, real relay configured.

## Build & install

1. `npm install && npm run apk`
2. Install `android/app/build/outputs/apk/debug/app-debug.apk` on phone A
   (`adb install -r …` or sideload).

## Test 1 — background beacons keep flowing (the headline fix)

1. Phone A: sign in with a LOCAL identity (not Signet), join the circle,
   toggle sharing ON, grant "Allow all the time" location.
2. Lock phone A. Put it in a pocket.
3. Walk ~500 m (several geohash-6 cells) over ≥5 minutes.
4. Phone B (app open): PASS = A's pin moves along the route with multiple
   updates. FAIL = one jump when A's screen comes back on (the old symptom).

## Test 2 — no-report zone holds while locked (security-critical)

1. Phone A: draw a no-report zone (policy: don't report) around a spot ahead.
2. Lock phone A, walk into the zone, wait 2+ min, walk out.
3. Phone B: PASS = pins approach the zone, go silent inside it, resume after.
   Any pin inside the zone = FAIL — file it as a security bug, do not ship.

## Test 3 — foreground/background handover (no double-publish)

1. Phone A: share with the app OPEN for 2 min (JS pipeline), then lock 5 min
   (native), then reopen.
2. Phone B: PASS = continuous, unduplicated updates through both transitions.
3. Phone A after reopening: "last shared" pin history includes the
   background-published cells (journal reconciliation).

## Test 4 — teardowns leave nothing behind

1. Stop sharing while locked-adjacent: toggle sharing OFF → walk → phone B
   sees nothing new.
2. Hide flock (decoy) while sharing → walk → nothing new; unhide → sharing is
   off, no stale notification.
3. With the App lock on, force-stop flock, reopen to the PIN screen, do NOT
   unlock, lock the phone, walk → nothing new (mirror cleared at lock boot).

## Split measurement (if test 1 fails)

The journal (Settings → not exposed in UI; use `adb logcat | grep -i flock` or
a debug read of the FlockPublish plugin's `getJournal`) records `{"t":"fix"}`
entries at native fix arrival and `{"t":"pub"}` at publish. Fixes present but
no pubs → the pipeline is gating or failing (check config mirror, relay
reachability). No fixes at all → the watcher/service died (Phase-0 territory),
not the JS-delivery stall.
```

- [ ] **Step 3: Update CLAUDE.md's native section**

In the `### Native (`native/`)` section of `CLAUDE.md`, append:

```markdown
Background publish is native (Kotlin, `native/android-src/kotlin*`): while the
app is backgrounded the fix→policy→gift-wrap→relay pipeline runs without the
WebView (which Android suspends — see docs/plans/2026-07-05-native-background-publish-design.md).
Wire-format parity is enforced by golden vectors (`native/vectors/`,
`npm run gen:vectors`) and JVM tests (`npm run test:native`, JDK 21, no Android
SDK needed). The pure core under `native/android-src/kotlin/` must never import
`android.*`.
```

Also add to the Commands section:

```markdown
- `npm run test:native` — Kotlin JVM tests for the native publish pipeline (JDK 21)
- `npm run gen:vectors` — regenerate the native golden vectors (only on deliberate wire-format change)
```

- [ ] **Step 4: Final gates + self-review pass**

Run: `npm test && npm run typecheck && npm run lint && npm run test:native`
Expected: all green.
Re-read the design doc's Verification section and confirm each of its three items maps to something real: (1) vectors → Tasks 1/3–7, (2) reverse stage → Task 8, (3) hardware runbook → this task. Fix anything missing.

- [ ] **Step 5: Commit**

```bash
git add docs CLAUDE.md README.md
git commit -m "docs: native background publish built — status, runbook, dev notes"
```
