# flock × the ForgeSworn freedom-tech toolset

flock is a flagship *consumer* of the ForgeSworn toolset. The goal is to use each
tool **correctly** — which both makes flock stronger and exercises each tool so it
can be expanded out individually. This is the map.

Legend: ✅ using correctly · 🔧 hand-rolled today, should adopt the tool · 🔜 not
yet, strong fit · 🤔 candidate / explore · 🔒 private repo (confirm scope).

## Identity & keys

| flock need | Tool | Status / action |
|---|---|---|
| Sign events without holding the nsec | **signet-login** (+ **signet-lite** = `lite.mysignet.app`, **signet-app** = `mysignet.app`) | ✅ Shipped — `SignetSigner` (`signEvent` + `nip44`) behind the pluggable `Signer` interface (`app/src/signer.ts`). |
| The actual remote signer | **heartwood** (NIP-46, built on nsec-tree; unlimited unlinkable personas from one mnemonic; runs on cheap ARM) | 🤔 Signet connects flock to a heartwood-class signer. flock just speaks NIP-46. |
| Derive per-circle keys deterministically | **nsec-tree** (`derivePersona`, `deriveFromPersona`, epoch index) | ✅ Shipped — `app/src/keys.ts` derives `circleRoot → circleId → epoch` via `canary-kit/sync.deriveGroupIdentity`; reseed = epoch+1. |
| Protect a *local* key at rest (fallback path) | **keystore-kit** (PIN / WebAuthn-PRF / grace, burn, zero-dep) | 🔧 Fixes the `localStorage` nsec caveat for the LocalSigner — key behind WebAuthn/PIN with burn-on-duress. |

## Access control & membership

| flock need | Tool | Status / action |
|---|---|---|
| Add/remove members, rotate keys, revoke access | **dominion** — "epoch-based encrypted access control for Nostr — tiered audiences, key rotation, revocable access on standard relays" | 🔧 **Big one.** flock *hand-rolled* reseed + remove via NIP-59 gift wrap. dominion is the purpose-built tool — epochs, tiers (e.g. guardians vs children), revocation. Adopt it for the circle membership layer. |
| Parent/guardian governance (grants, limits) | **charter** — "Parent-led, libre game account management… grants on your own keys… Built on Signet" | 🤔 Sibling family freedom-tech tool. Guardians issuing grants/limits aligns flock's family mode with charter's model. |
| Kin/family circles | **kindred** 🔒 | 🔒 Confirm scope — may overlap flock's "circle". |

## Recovery (don't lose the circle)

| flock need | Tool | Status / action |
|---|---|---|
| Survive a lost device / recover a seed | **@forgesworn/shamir-words** — Shamir over GF(256) + BIP-39 word shares | 🔜 Split the circle seed / master into word-shares among guardians (social recovery). |
| Coercion-resistant recovery | **cairn-kit** — "coercion-resistant key recovery protocol (design draft)" | 🤔 Pairs with shamir-words for the duress-aware angle. |
| Cross-device state without a server | **stash** — "per-persona encrypted save vault — NIP-44 encrypt-to-self on Blossom" | 🔜 Back up circle/geofence state encrypted-to-self; sign in on a new device and get it back. |

## Coercion & verification (the canary family)

| flock need | Tool | Status / action |
|---|---|---|
| Silent duress alarm + location | **canary-kit** duress (`buildDuressAlert`) | ✅ Using. |
| "Is this *really* my parent picking me up?" | **canary-kit** spoken verification (`deriveVerificationWord`, `verifyWord`, `deriveDirectionalPair`, session) + **spoken-token** | ✅ Shipped — wired to the UI: verification words + silent duress word (`src/spokenverify.ts`, `app/src/app.ts`). |
| Encrypted location beacons / envelopes | **canary-kit** beacons + `canary-kit/sync` envelope | ✅ Using (beacons, duress, check-in envelope). |

## Transport (freedom from the internet)

| flock need | Tool | Status / action |
|---|---|---|
| Decentralised relay transport | **Nostr** (via `nostr-tools`) | ✅ Using (kinds 20078/30078/1059). |
| Offline / no-relay / LAN delivery | **mesh-kit** (transport-agnostic `MeshTransport`, Noise_XX) + **mesh-webrtc-lan** | 🔜 A pluggable transport seam so alerts work with no internet (dead zones, festivals, disasters). flock's transport should be Nostr **or** mesh. |
| Zero-dep geohash | **geohash-kit** | ✅ Using. |

## Meeting & location

| flock need | Tool | Status / action |
|---|---|---|
| "Where do we meet to pick you up / regroup?" | **rendezvous-kit** — "fair meeting points for N participants — isochrone intersection, venue search, fairness scoring" | ✅ Shipped (Phase F) — set-rendezvous + fair meeting point with venues + fairness scoring (`src/rendezvous.ts`, `src/meeting.ts`). |

## Trust

| flock need | Tool | Status / action |
|---|---|---|
| Vouch for / attest a circle member | **nostr-attestations** (NIP-VA kind 31000) · **nostr-veil** (LSAG WoT, NIP-85) · **bray** (trust-aware) | 🤔 Trust/vouching layer — who's allowed in, proximity/verification signals. |

## Tooling & meta

| Need | Tool | Status / action |
|---|---|---|
| Releases | **anvil** — supply-chain-hardened release automation (canary-kit uses it) | 🔜 Adopt flock's `auto-release`/`release` workflows. |
| Workshop dependency map | **lodestone** | 🤔 flock shows up here once it depends on the above. |

## Proposed expansion order (flock-driven)

Each step exercises one tool and replaces a hand-rolled or weaker part of flock:

1. **`Signer` abstraction → signet-login** — key out of the app. ✅ *done*
2. **nsec-tree key derivation** — replace the flat circle seed with `persona → circle → epoch`. Foundational; unlocks proper reseed. ✅ *done*
3. **dominion** — adopt epoch-based access control for membership/rotation/tiers (retire the hand-rolled reseed-via-gift-wrap).
4. **keystore-kit** — secure the local fallback key at rest.
5. **shamir-words (+ cairn-kit)** — circle/identity recovery.
6. **canary-kit spoken verification** — pick-up identity confirmation. ✅ *done*
7. **mesh-kit** — offline/LAN transport seam.
8. **rendezvous-kit** — fair meeting/pick-up points. ✅ *done*
9. **stash** — cross-device encrypted-to-self state.
10. **anvil** — release CI.

> Each is independently shippable. The plan is to drive them out one at a time —
> flock's real need shapes how each tool grows.
