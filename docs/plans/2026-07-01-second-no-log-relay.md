# A second no-log relay — redundancy now, "provable" later

**Date:** 2026-07-01 · **Owner:** TBD · **Status:** design; v0 ready to build (infra), v1 parked with rationale

## Why this exists

Multi-relay fan-out shipped (`73ee7d7`): a signal now publishes to every relay in
`PRIVATE_RELAYS` and succeeds if any accepts, and inbound reads across the whole
set. But `PRIVATE_RELAYS` still holds **one** relay (`relay.trotters.cc`), so the
machinery has nothing to fan out *to* — **redundancy is opt-in** until the set
grows. For a safety tool, "your SOS didn't send because our one relay blinked" is
the failure we can't have, so a **second no-log relay** is the concrete next step.

The user's steer is firm and correct (see memory `flock-relay-strategy`): **do not
trust public relays — they may log.** So the second relay must be **ours and
no-log**, never a public relay added to the fan-out (a public relay sees traffic
timing + IP even though content is an opaque `kind:1059`).

The bigger idea on the table: a **paywalled relay that does no logging and can
*prove* it.** This doc triages that honestly — what's worth doing now vs. what is
gold-plating — then specs the part that is.

## What's actually worth doing (the honest triage)

The idea is really **three separable layers**. They do not have to ship together,
and lumping them delays the one that matters.

| Layer | Verdict | Why |
|---|---|---|
| **1. A second no-log relay** | **Do now** | Closes the single-point-of-failure for *everyone*, activates the fan-out we just built. Cheap, no research, mostly infra. |
| **2. A paywall** | **Later — and reframe it** | Its real justification is **anti-spam + sustainability without KYC**, *not* provability. And it only matters once the relay is **public / shared** across apps. For flock's own redundancy relay, an inbox allowlist is simpler abuse control. |
| **3. "Provable" no-log (TEE/attestation)** | **Not now** | A perpetual engineering commitment for a **second-order** gain (the IP + timing metadata a relay inherently touches) that **Tor already covers most of**. Risks *diluting* flock's core message ("don't trust the relay"). Opportunity cost vs. the real launch gate (native background geofencing). Capture as a future flagship. |

The uncomfortable truth about layer 3: **flock is already safe against a logging
relay by architecture** — gift-wrap-everything makes content opaque, geofencing is
on-device, location is withheld by default. The *marginal* thing a provable-no-log
relay protects is the metadata the relay unavoidably sees (which inbox received a
burst, from which IP, when). That is real, and for a coercion-resistant tool it is
on-brand to defend — but a `.onion` endpoint plus flock's existing opacity gets
most of it for ~5% of the cost of a TEE. Provable attestation is worth revisiting
**only** when there is a public, paid relay whose users demand it — not before.

## v0 — the second relay (build now)

Concrete, no new research required.

**Independent failure domain (the point).** Relay #2 must be on **different infra
from `relay.trotters.cc`** — different provider/region ideally, its own box. Two
relays in the same DC is not redundancy; a host or network outage would take both.

**Software.** `strfry` (C++, battle-tested, write-policy plugins) or
`nostr-rs-relay`. strfry preferred for the plugin hook we'll want later (paywall).

**No-log hardening checklist** (every layer, because a leak anywhere defeats it):
- Relay: disable query/connection logging in the strfry config; no event archival
  beyond what serving requires.
- Reverse proxy (Caddy/nginx): **access logs off** (mirrors the flock host's
  `deploy/Caddyfile` posture — access logs already disabled there).
- System: no `journald` capture of the relay's stdout to disk (or `Storage=none`
  for the unit); **no swap** (so nothing pages event memory to disk); tmpfs for any
  runtime state.
- Firewall: only 443 (+ Tor) inbound.

**`.onion` endpoint.** Publish a v3 onion address for the relay so clients can
reach it **without exposing an IP** — this is the highest-leverage privacy move and
it is cheap (a Tor daemon + `HiddenServicePort`). Add the onion to `PRIVATE_RELAYS`
alongside the clearnet URL, or offer it as an opt-in in settings.

**Advertise intent.** NIP-11 relay-info doc stating no-logging + contact; a
**warrant canary** on a predictable URL. These are trust *signals*, not proofs —
labelled as such.

**Wire it in.** Add the relay to `PRIVATE_RELAYS` in `app/src/relays.ts` (one line);
fan-out + dedup already handle the rest, no app changes. Bump the deploy. Existing
users pick it up on next load (their persisted `relayUrls` migrated from a single
value; note: a user who *customised* their relay list keeps their choice — the new
default only reaches fresh installs and default users, so consider a one-time
"relays updated" migration if we want everyone on ≥2).

**Acceptance.** From two devices over the two-relay set: kill relay #1 mid-session
→ an SOS still reaches the other person via relay #2 (this is the redundancy the
e2e can't currently prove with one relay — worth a dedicated spec once #2 exists).

## Future — the paid tier (Cashu), when the relay goes public

If/when relay #2 (or #3) is opened beyond flock to the wider toolkit, a paywall
becomes worth it — **for anti-spam and sustainability, not privacy theatre**:
- **Cashu ecash** (Chaumian bearer tokens) so payment is **unlinkable** — the relay
  redeems a token without learning who paid. Anything that links `payment ↔ pubkey`
  (a bare Lightning invoice) would be a log by another name and is disqualified.
  LN-over-Tor is an acceptable *simpler* interim if Cashu integration is heavy.
- Advertise the fee via NIP-11 (`limitation.payment_required`, `fees`).
- Subscription keyed to the **rotating inbox pubkey** (already ephemeral) fits
  flock's model; enforced in a strfry write-policy plugin.
- **Reuse check:** `pallasite`/credits (whence `relays.ts` was adopted) may already
  give us a payment/credits primitive — prefer building on it over a fresh integration.

## Future — "provable" no-log (TEE), if/when justified

The only mechanism that turns "we don't log" into something a sceptic can verify:
- Run the relay in a **Confidential VM / TEE** (AWS Nitro Enclaves, AMD SEV-SNP,
  Intel TDX). The hardware signs a **measurement of the exact image** running.
- **Reproducible build** of the open-source relay so anyone rebuilds it and gets the
  same measurement.
- A **client verifier** that checks the attestation to the CPU-vendor root and
  compares the measurement before trusting/paying.
- RAM-only, no persistence — auditable in the (attested, reproducible) source.
- Terminate the WS/TLS **inside** the enclave; pair with `.onion` for IP.

**Why it's parked:** large + *perpetual* (side-channel CVEs, image re-measurement,
vendor-root trust), for a gain Tor mostly already delivers, and it can mislead users
into *trusting* a relay when flock's whole thesis is that you should not have to.
Precedent exists (Signal's SGX contact discovery) so it's viable — revisit when
there's a public paid tier and real demand.

## Honest caveats / non-goals

- **Not a new thing to trust.** Every tier here is **defence in depth** on top of
  "the relay is untrusted," never a replacement for it. Messaging must never imply
  "trust this relay."
- A relay inherently sees IP + timing + destination-inbox while serving. `.onion`
  removes the IP; attestation proves non-persistence; **nothing** removes the fact
  that *some* infrastructure momentarily handles the connection. Flock's opacity is
  still the primary defence.
- Redundancy is only real across **independent failure domains** — enforce that or
  the whole exercise is cosmetic.

## Open questions

- Where does relay #2 live (provider/region distinct from trotters.cc)?
- Is this flock infra or a **standalone ForgeSworn repo** (ecosystem relay all apps
  share)? Leaning standalone once it's more than a bare redundancy box.
- Do we push a one-time migration so *existing* users move onto ≥2 relays, or only
  new/default installs?
