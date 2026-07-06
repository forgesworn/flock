# Competitor landscape — private circle location safety (2026-07-06)

Completes `docs/plans/2026-07-05-competitor-landscape-goal.md`: a source-backed
comparison of Flock against mainstream and privacy-adjacent location-sharing
products, judged for **one narrow use case** —

> Private security and location coordination for a small circle of friends or
> family who trust each other, do not want a company holding their movement
> history, and may use a VPN or Tor to reduce IP-address exposure to relays and
> hosts.

Scoring follows the goal doc's rubric (0–3 per area, weighted; privacy
architecture, metadata minimisation and data retention triple-weighted; maximum
weighted score 60). The comparison judges products against the threat model,
not general consumer convenience.

**Evidence grades.** Research ran 2026-07-06 as two adversarially verified
sweeps (claims checked verbatim against primary sources by three independent
verifiers; ≥2/3 refutations kill a claim).

- **[A]** — survived 3-vote adversarial verification.
- **[B]** — quoted verbatim from a fetched primary source, but the
  verification pass was cut short (run limits); treat as documentation-grade.
- **[†]** — ordinary product knowledge used only in convenience-area scores
  (reliability, setup, usability), never in the triple-weighted privacy areas.

Flock's own column reflects the **current app plus tested library
capabilities** as of 2026-07-06 (README, `docs/PRIVACY.md`,
`docs/ROADMAP.md`) — shipped architecture scores; parked or unproven work is
footnoted, not credited.

## 1. Executive summary

**Flock wins the defined threat model — 49/60 weighted, against 36 for the
runner-up — and the margin comes exactly where the rubric says it should: the
triple-weighted privacy areas, where the verified evidence is starkest.**

The verified landscape splits into three tiers:

1. **Provider-readable trackers.** Life360 stores and can disclose plaintext
   location, **currently licenses precise geolocation to business partners
   for their own monetisation** ("TEXAS NOTICE: We may sell your sensitive
   personal data"), retains a derived "dwell" behavioural profile up to 18
   months, and hands IP logs to law enforcement at the subpoena tier —
   nullifying a user's VPN/Tor effort [A]. Snap Map retains location as long
   as the content it rides on and makes no E2EE claim for location [A].
   Telegram's group live location cannot be E2EE at all (Secret Chats are
   one-to-one only) [A]. Google's own support page says Timeline-associated
   data can improve "Google services, including ads products" [A]. Google
   Family Link — the child-supervision tool the goal doc named — runs a
   child's real-time location through Google Maps location sharing on a
   Google-managed account, makes no E2EE claim for it, and an under-13 child
   cannot switch it off [A].
2. **E2EE content, but account-bound and metadata-rich.** WhatsApp live
   location is genuinely end-to-end encrypted — the February 2026 whitepaper
   documents a custom fast ratchet for it [A] — but it is primary-device
   only, and Meta still holds the phone-number identity, contact graph, IPs
   and push tokens. Apple's Find My keeps private keys off Apple's servers
   [A], but its finder-anonymity claim is disputed by independent research
   (PETS 2021) [A], and identity lives with the Apple account.
3. **Sovereignty without secrecy, or privacy without the job.** OwnTracks
   and Home Assistant let you own the server — but the server sees plaintext
   location (OwnTracks' Recorder stores plaintext *even when* its optional
   payload encryption is on [A]). Matrix/Element E2EE-encrypts coordinates
   in encrypted rooms, yet announces every live share through an
   **unencrypted state event**, so the homeserver sees *that* you are
   sharing, for how long, and your room graph [B]. Signal is the
   philosophical benchmark — court-proven to produce nothing but two
   timestamps under subpoena [A] — **but it does not do the job**: no live
   location, no circle map, no safety layer. Briar and Berty have no
   location feature at all [B].

**No assessed product combines Flock's four properties: E2EE location
content, no central account, self-hostable/custom relays, and a design that
makes withholding indistinguishable from sharing.** Flock's coercion layer
(app lock, decoy view, silent duress, no sharing-status "tell") has no
counterpart anywhere in the field — the closest analogue failure is Matrix's
visible `m.beacon_info` beacon announcement.

**The honest caveats that keep Flock at 49 rather than higher:** background
reliability is measured green and shipped on the GrapheneOS gate device
(screen locked and Dozing, native beacons flowing) but not yet broadly proven
— the sustained-walk and stationary deep-Doze passes, breadth across stock
Androids, and any iOS shell all remain, and mature mainstream products still
beat it on breadth today; the Tor toggle ships but the `.onion` endpoint does
not exist yet, so the IP residual is real; and the app's safety set beyond live
sharing + buzz is parked (library-tested, not wired in). Flock's claim is
architectural, not yet track-record: Signal has court receipts and Briar a
Cure53 audit; Flock has neither.

**Winner for the target threat model: Flock** — provided the buyer accepts
deliberate setup and foreground-grade reliability today. For anyone who
will not, the honest recommendation from the evidence is WhatsApp live
location (best E2EE-content mainstream option) with eyes open about Meta's
metadata, or Glympse for one-off temporary shares a provider may watch.

## 2. Weighted comparison table

Weights: privacy architecture ×3, metadata minimisation ×3, data retention
×3, coercion resistance ×2, location control ×2, network options ×2,
reliability ×2, circle setup ×1, safety actions ×1, usability ×1. Max 60.

| Product | PA ×3 | MM ×3 | DR ×3 | CR ×2 | LC ×2 | NO ×2 | Rel ×2 | CS ×1 | SA ×1 | U ×1 | **Weighted** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| **Flock** | 3 | 2 | 3 | 3 | 3 | 2 | 2 | 2 | 2¹ | 1 | **49** |
| Signal | 3 | 2 | 3 | 1 | 1 | 1 | 1 | 2 | 0 | 2 | **36** |
| WhatsApp live location | 2 | 1 | 2 | 0 | 2 | 0 | 2 | 2 | 1 | 3 | **29** |
| Apple Find My | 2 | 1 | 1 | 0 | 1 | 0 | 3 | 2 | 2 | 3 | **27** |
| Matrix/Element location | 2 | 1 | 1 | 0 | 2 | 3 | 1 | 2 | 0 | 1 | **27** |
| Home Assistant presence | 1 | 2 | 2 | 0 | 1 | 3 | 1 | 1 | 1 | 0 | **27** |
| OwnTracks | 1 | 2 | 2 | 0 | 1 | 3 | 1 | 1 | 0 | 0 | **26** |
| Glympse | 1 | 1 | 2 | 0 | 2 | 0 | 2 | 1 | 0 | 2 | **23** |
| Google Maps sharing² | 1 | 0 | 1 | 0 | 2 | 0 | 3 | 2 | 1 | 3 | **22** |
| Telegram live location | 0 | 0 | 1 | 0 | 2 | 1 | 3 | 2 | 0 | 3 | **20** |
| Google Family Link⁴ | 1 | 0 | 1 | 0 | 1 | 0 | 3 | 2 | 1 | 3 | **20** |
| Life360 | 0 | 0 | 0 | 0 | 1 | 0 | 3 | 2 | 3 | 3 | **16** |
| Snapchat Snap Map | 0 | 0 | 0 | 0 | 2 | 0 | 2 | 2 | 0 | 3 | **13** |
| Briar / Berty | — | — | — | — | — | — | — | — | — | — | not scored³ |

¹ Flock safety actions: buzz quick actions and check-in surface in the MVP
app; SOS/duress, geofences, dead-man's-switch, meeting points etc. are
library-tested but parked post-MVP — 2, not 3, on the "current app plus
tested library" basis.
² Scope: Google Maps location sharing (and Timeline evidence), scored
separately from **Google Family Link's child-supervision location**, which
now has its own row (n⁴) after a 2026-07-06 follow-up pass.
³ Briar has no location feature (its location permission exists solely for
Bluetooth discovery [B]); Berty likewise has none and warns it "should not
yet be used to exchange sensitive data" [B]. Both are off-grid transport
contrasts, not competitors for this job.
⁴ Google Family Link (assessed 2026-07-06; the account-bound, under-13-only
and parent-controlled-toggle facts survived 3-vote adversarial verification
[A], primary Google support pages): parent-over-child supervision on a
Google-managed child account. Location control scores 1, not 2 — it is
asymmetric: an under-13 child cannot disable sharing (the parent holds the
"See your child's location" toggle), and only over-13s "can stop location
sharing at any time". Coercion resistance is 0 (a surveillance tool by
design). Its E2EE, retention and metadata scores mirror the Google row's
server-processed, account-bound model. It competes for the family-safety
job the goal doc named, but its architecture is provider-readable — not the
mutual-trust model this threat model rewards.

Score meanings: 0 missing/hostile/marketing-only · 1 partial but leaks or
provider-dependent · 2 good with honest limits · 3 strong fit backed by
architecture/source/reproducible behaviour.

## 3. Feature-by-feature: Flock against each competitor

| Area | Flock (shipped) | Life360 | Find My | Google | WhatsApp | Signal | Telegram | Snap Map | Glympse | OwnTracks / HA | Matrix/Element |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Circle setup | QR/remote invite, no account, reseed + remove, multi-circle | Accounts + circles [†] | Apple IDs, Apple-only [†] | Google accounts [†] | Phone-number groups [†] | Phone-number groups [†] | Phone-number groups [†] | Friend graph [†] | Ad-hoc links, 4-h default [B] | Manual broker/server config [†] | Homeserver accounts + rooms [†] |
| Location off by default | Yes — sharing starts off, per person | No — standing tracking is the model [†] | Standing once enabled [†] | Timed or until-off [†] | Off; per-chat opt-in [†] | Off (no live mode exists) [B] | Off; per-chat opt-in [†] | Off until Snap Map opt-in; Ghost Mode [†] | Off; per-share timer [A] | On while app runs [†] | Off; per-room share [B] |
| Precision control | **Geohash slider 3–9 per person; map previews what others see** | None | None | None | None | None (pin is exact) | None | City→precise modes [†] | None | None | None |
| Temporary by default | Circle lifetimes; every wrap expires ≤16 days | No | No | Partly (1-h option) [†] | Yes (15 min–8 h) [†] | n/a | Yes (15 min–8 h) [†] | No (content-lifetime) [A] | **Yes — 12-h cap, 48-h history purge** [A] | No (Recorder keeps history) [A] | Share has duration; events persist in room [B] |
| E2EE location content | Yes — NIP-59 gift wrap, NIP-44, on-device policy | **No** [A] | Yes (offline finding; vendor claim) [A] | No (server-processed; Timeline now on-device) [A] | **Yes** (incl. custom ratchet) [A] | Yes for what exists (static pin in E2EE message) | **No in groups** [A] | No claim for location [A] | No claim [A] | No — server plaintext by design [A] | Coordinates yes in E2EE rooms; **share-announcement state event unencrypted** [B] |
| Provider reads plaintext location | Never — no provider; relays see kind-1059 wraps from ephemeral keys | Yes; warrant tier produces it [A] | No (vendor claim, PETS-disputed anonymity) [A] | Yes for sharing [A] | No (content) [A] | No content at all (court-proven near-nothing) [A] | Yes [A] | Yes [A] | Yes during share [A] | Your own server: yes, plaintext [A] | Homeserver: no coordinates in E2EE rooms; yes membership, timing, share-status [B] |
| Retention | ≤16-day uniform wire expiry; no server accounts; self-purge | Raw ~30 d; **dwell profile 18 months**; policy open-ended [A] | Minimal (vendor claim) [A] | Timeline on-device since 2024 [A]; account data retained | Metadata retained; content transient [A] | **Two timestamps, court-proven** [A] | Cloud chats stored [A] | Content-lifetime [A] | ≤48 h personal, then aggregate [A] | You choose; plaintext history default [A] | Homeserver keeps (encrypted) events indefinitely [B] |
| IP / account exposure | No accounts; IP visible to relay/host — Tor toggle shipped, onion endpoint pending | **IP logs at subpoena tier** [A] | Apple ID | Google account | Phone + Meta metadata [A] | Phone; nothing else queryable [A] | Phone + cloud | Snap account + device metadata [A] | Account/link based [B] | Your own infra (IP is yours) | Homeserver account; federation metadata [B] |
| Coercion resistance | **App lock, decoy view, silent duress, withholding = sharing on the wire** | None; pause is visible [†] | None [†] | None [†] | None [†] | Screen lock, disappearing msgs [†] | None [†] | Ghost Mode is a visible setting [†] | None [†] | None [†] | None; `m.beacon_info` is a visible tell [B] |
| Self-host / own relay / Tor | Static PWA + relay + tiles all self-hostable; multi-relay; Tor toggle (endpoint pending) | No | No | No | No | No (proxies only) [†] | No (MTProto proxies) [†] | No | No | **Yes — entirely** | **Yes — homeserver + own tileserver** [B] |
| Background reliability | PWA foreground-only; native Android background publish **measured GREEN + shipped** on the GrapheneOS gate (locked/Dozing beacons at +7 s, ~50 s cadence); sustained-walk + stationary-Doze passes, breadth + iOS pending | Mature [†] | OS-integrated, best-in-class [†] | Mature [†] | Good; live location primary-device only [A] | n/a (no live mode) | Mature [†] | App-open centric [†] | Good during share [†] | Documented platform pain (FGS notification, Doze batching, ~500 m iOS significant-change) [B] | Beta-grade [†] |
| Safety actions | Buzz set + check-in in app; SOS/duress, geofences, DMS, meeting points library-tested (parked) | Longest list: SOS, crash, places [†] | Notify-on-arrive, device SOS [†] | Family Link alerts [†] | None | None | None | None | None | DIY via automations [†] | None |

*Google Family Link is scored separately (§2 n⁴, §4): it shares the Google
column's server-processed, account-bound properties and adds an asymmetric
child-supervision model — an under-13 child cannot independently switch
sharing off, so its coercion-resistance and location-control scores are
lower than the Google Maps row's.*

## 4. Privacy & security findings, with citations

Every claim below survived 3-vote adversarial verification against the primary
source on 2026-07-06 unless marked **[B]** (documentation-grade: quoted
verbatim from a fetched primary source; the verification pass was cut short).
Two candidate claims were killed in verification and are excluded; a third
(Google holds a readable standing movement record) was **refuted 0–3** and is
recorded below so it is never asserted.

### Life360

- **Not end-to-end encrypted; provider-readable by design.** The privacy
  policy (last modified 2026-06-24) mentions encryption only for Pet GPS and
  Jiobit hardware at rest/in transit; "end-to-end" appears nowhere. The Law
  Enforcement Guidelines state that with a search warrant Life360 will produce
  raw location data, dwell data, driving event data and content data — which
  requires server-side plaintext. The policy also reserves disclosure "in our
  sole discretion".
  ([Privacy policy](https://legal.corp.life360.com/hc/en-us/articles/16038777217175-Life360-Privacy-Policy),
  [LE guidelines](https://legal.corp.life360.com/hc/en-us/articles/16369337969431-Life360-Law-Enforcement-Guidelines))
- **Currently licenses precise geolocation for partner monetisation.** The
  live policy states Life360 licenses "precise geolocation data (which is
  'sensitive' personal data under certain State Privacy Laws) to select
  business partners for their own advertising and monetization purposes", and
  carries the statutory line "TEXAS NOTICE: We may sell your sensitive
  personal data." Opt-out (app settings), not opt-in. The 2022 "we'll stop
  selling data" pledge covered data brokers only — this partner licensing
  continues in the current policy.
- **Historical data-broker sales.** Through 2021 Life360 sold precise
  location from ~33M users to roughly a dozen partners (X-Mode/Outlogic,
  Cuebiq, SafeGraph, Allstate's Arity), feeds including advertising ID and
  raw lat/long; former employees said it did not fuzz, hash, aggregate or
  reduce precision. Never disputed by the company; sales narrowed (not
  ended — Arity, Placer aggregates) in January 2022.
  ([The Markup, 2021-12-06](https://themarkup.org/privacy/2021/12/06/the-popular-family-safety-app-life360-is-selling-precise-location-data-on-its-tens-of-millions-of-user),
  [follow-up 2022-01-27](https://themarkup.org/privacy/2022/01/27/life360-says-it-will-stop-selling-precise-location-data))
- **Retention: a stored behavioural profile.** Raw location ~30 days, but
  derived "dwell" data — places a member stayed 15–20+ minutes, with
  durations — is retained **up to 18 months** and is producible to law
  enforcement. The privacy policy itself sets no fixed limit ("as long as
  you use our Products… legitimate business interests…").
- **VPN/Tor is undermined by the account layer.** IP logs and
  identity-linked subscriber data (name, address, phone, email, payment
  method) are disclosable at the **subpoena** tier — the lowest legal bar,
  no judge-issued warrant needed.

### Apple Find My

- **Strong E2EE claims for offline finding — vendor-stated.** Apple's
  Platform Security guide: the private key pair "and the secret are never
  sent to Apple and are synced only among the user's other devices in an
  end-to-end encrypted manner using iCloud Keychain"; Apple "can't read the
  location encrypted by the finder", and claims it doesn't log
  finder-identifying information or retain data allowing finder–owner
  correlation.
  ([Find My security](https://support.apple.com/guide/security/find-my-security-sec6cbc80fd0/web))
- **The anonymity claim is disputed by independent research.** Heinrich et
  al. (PETS 2021, "Who Can Find My Devices?") confirmed the confidentiality
  design but demonstrated a finder–owner correlation attack and a macOS
  cache exposing 7 days of location history (CVE-2020-9986); fixes were
  partial. ([arXiv:2103.02282](https://arxiv.org/abs/2103.02282))
- **Scope caveat:** these properties cover offline device finding. The
  people-sharing feature set is account-bound (Apple ID), Apple-ecosystem
  only, and Apple remains the identity and metadata custodian.

### WhatsApp live location

- **Genuinely E2EE content — the strongest mainstream claim.** The
  Encryption Overview (v9, 2026-02-25), p.22: "Live location messages and
  updates are encrypted in much the same way as group messages", with a
  documented custom fast-ratcheting extension (the linear-time Signal
  ratchet is too slow for high-volume lossy updates). P.35 defines E2EE as
  content "no third parties, not even WhatsApp or our parent company Meta,
  can access".
  ([whitepaper](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf))
- **Limits.** Live location is **primary-device only** (companion devices
  can neither send nor receive it). E2EE covers content only: the
  phone-number account, contact graph, group membership, IPs, timing and
  push tokens remain Meta-visible; cloud backups are not E2EE unless the
  user enables it.

### Signal

- **The court-proven minimal-metadata benchmark.** Across published
  subpoena responses (Eastern District of Virginia 2016, Central District
  of California 2021, District of Columbia), the only data Signal could
  produce was "the date and time a user registered with Signal and the last
  date of a user's connectivity to the Signal service". In the DC case, of
  37 accounts subpoenaed: 7 didn't exist, 24 had nothing responsive, 6
  yielded the two timestamps.
  ([signal.org/bigbrother](https://signal.org/bigbrother/),
  [CD Cal 2021](https://signal.org/bigbrother/central-california-grand-jury/),
  [ED Va 2016](https://signal.org/bigbrother/eastern-virginia-grand-jury/),
  [DC](https://signal.org/bigbrother/district-of-columbia/))
- **No server-side social graph.** Signal states it stores nothing about a
  user's contacts (not even hashes), groups or communication partners.
- **Precision matters:** the claim "Signal end-to-end encrypts metadata by
  default" was **refuted 0–3** — content is E2EE by default; metadata is
  *not stored*, which is a different (and here, stronger) property. Quote
  accordingly.
- **But it does not do this job.** Signal offers no live-location sharing —
  at most a static map pin sent as an ordinary E2EE message. Its own
  send-a-message support page documents photo/video/file attachments only,
  and its developers historically declined geolocation features ("Signal is
  a privacy app. We are not planning to geolocate every message.", 2015)
  [B]. No circle map, no precision control, no safety layer. Signal is the
  standard Flock should be measured against on metadata — not a competitor
  for the use case.

### Telegram live location

- **Not E2EE in any group setting.** Telegram's own docs: E2EE exists only
  in one-on-one, device-specific Secret Chats; cloud chats (the only place
  group live location can run) are client–server encrypted and stored in
  Telegram's cloud. The mitigation is operational (split-jurisdiction key
  storage), not cryptographic.
  ([core.telegram.org/api/end-to-end](https://core.telegram.org/api/end-to-end),
  [FAQ](https://telegram.org/faq))

### Google (Maps location sharing / Timeline)

- **Provider-side processing, in Google's own words.** The Timeline privacy
  support page states location data associated with Timeline can be used to
  "Improve and develop Google services, including ads products"; the page
  never mentions encryption.
  ([support.google.com](https://support.google.com/maps/answer/10077010?hl=en))
- **Honest scope limit:** since late 2024 Timeline visit history is stored
  on-device with optional encrypted backups Google says it cannot read. The
  stronger claim that Google holds a readable standing movement record was
  **refuted 0–3** in verification and must not be made. Live location
  sharing itself, however, is processed through Google's servers against a
  Google account.
### Google Family Link (child-supervision location)

Assessed 2026-07-06 in a targeted follow-up (the original run's agent
failed). Its load-bearing facts then passed the same 3-vote adversarial
verification the report's [A] claims carry — three independent verifiers,
all confirming — so they are graded **[A]**. One compound claim (that
Google's servers read the shared location) was refuted 3/3 as a *standalone*
Family Link claim, because no Family Link page states it directly; it is
instead **derived** below from two independently-[A] facts. Family Link is a
parent-over-child supervision tool, not a mutual-trust circle product —
included because the goal doc named it.

- **Account-bound, no E2EE claim [A].** "Google Maps is available for
  children with Google Accounts managed with Family Link", and a parent "can
  find your child's Android and compatible Fitbit device location in Family
  Link once device location sharing is turned on" — both survived 3-vote
  verification. No Family Link or Maps support page makes an end-to-end
  encryption claim for the child's location (verifiers confirmed no E2EE
  language on any checked page). **Provider-readable, by derivation:** the
  child's location *is* Google Maps location sharing (above), and the Google
  row establishes at [A] that Google processes Maps location sharing
  server-side and reads it — so Google can read the child's location. That
  conclusion is sound but derived, not separately quotable on a Family Link
  page, which is why it is stated as a derivation rather than a cited [A]
  fact.
  ([find & manage location](https://support.google.com/families/answer/7103413?hl=en),
  [Maps & child account](https://support.google.com/families/answer/7307202?hl=en))
- **Asymmetric by design — the inverse of coercion resistance [A].**
  "Children under 13 (or the applicable age in your country) whose accounts
  are managed with Family Link can only share their real-time location with
  their parents" (confirmed 3/3), and the parent holds the "See your child's
  location" on/off switch; only "children over 13 … who had supervision added
  to their previously existing Google Account can stop location sharing at any
  time" (confirmed 3/3). For a mutual-trust circle this inverts invariant 1:
  sharing status is a parent-held surveillance signal, not a user-held
  secret. Hence coercion resistance 0 and location control 1.
- **Retention and metadata track the Google account.** Location History for a
  supervised child is a Google account setting; the parent-visible view is
  live sharing, but identity, IP and account-data exposure follow Google's
  standard model — scored as the Google row (MM 0, DR 1).
- **Where it lands:** weighted **20**, tied with Telegram — real-time
  location and mature background reliability, but provider-readable,
  account-bound and asymmetric. It does not change the ranking above Flock,
  Signal or WhatsApp.

### Snapchat Snap Map

- **Server-readable, content-lifetime retention.** Snap's policy (effective
  2025-04-07): location attached to a Snap saved to Memories or posted to
  Snap Map/Spotlight is retained "as long as we store the Snap". No
  "end-to-end"/"encrypt" language for location anywhere in the policy;
  Snap's E2EE claims cover snaps/calls only. The Law Enforcement Guide
  confirms location is disclosable under legal process.
  ([privacy policy](https://values.snap.com/privacy/privacy-policy))
- **Heavy device metadata:** advertising identifiers, installed apps,
  motion sensors, microphone/headphone-connection state, wireless/mobile
  connection details — all provider-visible regardless of content
  protections.

### Glympse

- **Temporary by design — the honest mainstream comparison for night-out
  sharing.** Shares expire by user-set timer capped at 12 hours ("designed
  for temporary, real-time location sharing, not continuous tracking");
  personal location data is kept no longer than 48 hours, then
  disassociated for aggregate use.
  ([privacy policy](https://corp.glympse.com/privacy/),
  [FAQ](https://app.glympse.com/faq/how-long-is-my-glympse-visible-after-it-has-expired-in-the-app/))
- **But provider-readable throughout:** no E2EE claim exists; Glympse
  servers see plaintext location during every share, and "disassociated"
  aggregate data is retained, not destroyed. Shares can be renewed
  repeatedly to the cap.

### OwnTracks (and Home Assistant presence)

- **Sovereignty, not secrecy.** OwnTracks' payload encryption is optional
  symmetric libsodium secret-box, off by default; without it "only
  transport-level TLS protects location data" and the broker sees plaintext.
  Even TLS is conditional: "If your broker supports it, and if you configure
  OwnTracks to do so". Decisively: **"the Recorder will decrypt the payload
  and will store the result in plain text in its storage"** — the
  self-hosted history is plaintext at rest *even with* payload encryption
  enabled. ([encrypt](https://owntracks.org/booklet/features/encrypt/),
  [security](https://owntracks.org/booklet/features/security/))
- **Background reliability is documented pain [B]:** Android needs a
  foreground-service notification and Doze batches traffic; the docs point
  users at battery-optimisation exemptions; iOS significant-change mode is
  coarse (~500 m). Home Assistant's companion app follows the same
  pattern — location lands as plaintext entity data on your own server,
  transport-protected only [B].
- The trust shift is real but total: no third-party provider exists, and in
  exchange **your own server becomes the plaintext custodian** — a seizable,
  subpoenable box with a location history on it.

### Matrix / Element location sharing

- **Coordinates encrypted, existence of sharing not [B].** Element's launch
  post: "If you share your location in an end-to-end encrypted room, the
  location data will also be end-to-end encrypted"
  ([blog](https://element.io/blog/element-launches-e2ee-location-sharing/)).
  But live sharing (MSC3489) announces start/stop via an `m.beacon_info`
  **state event**, and "in Matrix, all room state is unencrypted and
  accessible to everyone in the room, and occasionally people outside it"
  (MSC3414, still an open draft as of 2026-07). The homeserver therefore
  sees *that* you are live-sharing, the stated duration, plus room
  membership and structure — the exact "tell" Flock's invariant 1 exists to
  eliminate.
  ([MSC3489](https://github.com/matrix-org/matrix-spec-proposals/pull/3489),
  [MSC3414](https://github.com/matrix-org/matrix-spec-proposals/pull/3414))
- **Persistence and spec maturity [B].** MSC3489 beacons persist in room
  history; the ephemeral variant (MSC3672, needing encrypted EDUs via
  MSC3673) was opened January 2022 and remains unmerged — live location
  ships on an unstable-prefixed, unfinalised spec.
  ([MSC3672](https://github.com/matrix-org/matrix-spec-proposals/pull/3672))
- **The tileserver hop [B].** Element documents that rendering a share
  sends coordinates to the tileserver (MapTiler by default) — deliberately
  third-party so Element/Matrix can't correlate. Flock's answer to the same
  problem is architecturally stronger: same-origin proxies plus offline map
  areas that generate zero tile traffic.

### Briar and Berty (off-grid contrasts, not competitors)

- **Briar has no location feature at all [B]:** "Briar doesn't store,
  share, or upload your location" — the Android location permission exists
  solely for Bluetooth discovery. No central server, Tor sync online,
  Bluetooth/Wi-Fi/USB offline, contact list on-device; Cure53-audited
  (2017). ([how it works](https://briarproject.org/how-it-works/))
- **Berty is account-free E2EE mesh messaging, explicitly not
  production-ready [B]:** "Berty is still under active development and
  should not yet be used to exchange sensitive data"; the Wesh protocol is
  "partially implemented"; delivery is eventual, "if a viable route
  exists". No location feature. ([github.com/berty/berty](https://github.com/berty/berty))
- Their relevance is the roadmap, not the rubric: they prove the off-relay
  transport pattern Flock is building (BLE-nearby, LoRa backlog).

### Platform constraints that bound every competitor [B]

- Android 8.0+ gives backgrounded apps location "only a few times each
  hour", regardless of target SDK; the sanctioned escapes are a
  foreground service with an ongoing notification, or the geofencing API
  (~every couple of minutes responsiveness). Android 11+ additionally
  requires `ACCESS_BACKGROUND_LOCATION` for background-started foreground
  services.
  ([background location limits](https://developer.android.com/about/versions/oreo/background-location-limits))
- These are the same constraints Flock's native shell designs around — and
  the reason "reliable background sharing" claims from *any* vendor deserve
  scepticism proportional to the caution Flock applied before it measured its
  own gate green on GrapheneOS.

## 5. Where Flock loses

Blunt, from the repo's own documentation and the evidence above:

- **Background reliability is proven on the gate device, not yet broadly.**
  The PWA cannot share in the background at all (platform constraint — README
  "make-or-break"); the native Android path closes that gap and is **measured
  green and shipped** — on a GrapheneOS Pixel 10 Pro, screen locked and
  Dozing, the relay decrypted native beacons at +7 s and every ~50 s (release
  0294b8c, 2026-07-05). What remains is validation, not a build: the sustained
  outdoor-walk pass, the stationary deep-Doze pass, breadth across stock
  Androids, and there is still no iOS native shell. On maturity and breadth
  Life360, Find My, Google, WhatsApp and Telegram still beat Flock today.
- **Tor is a toggle without an endpoint yet.** The opt-in `.onion` toggle
  ships (Orbot detection, fail-loud) but `ONION_RELAYS` is empty until the
  onion service exists, and Tor users currently degrade to foreground-only.
  The IP residual is real until then — `docs/PRIVACY.md` says so itself.
- **No track record.** Signal's minimal-metadata story is court-proven;
  Briar has a Cure53 audit. Flock's equivalent claims are architectural and
  self-audited. Until an independent audit (or a first legal test) exists,
  a cautious buyer is right to weight Signal's receipts above Flock's
  design documents.
- **Onboarding and discovery.** No accounts also means no contact
  discovery, no OS integration, no provider-mediated recovery. Setup is
  QR-in-advance and deliberate — slower than every mainstream product, and
  the target user has to know Flock exists.
- **The safety set is parked.** SOS/duress, geofences, check-in
  dead-man's-switch, meeting points, off-grid and spoken verification are
  library-tested but not in the MVP app UI. On shipped app surface alone,
  Life360's safety list is longer and Find My's OS integration is deeper.
- **Push.** No FCM by design; UnifiedPush or a persistent relay socket. On
  battery-managed stock Androids this is a real deliverability gap versus
  Google-integrated products.
- **Forensics.** A forensic image still finds an opaque sealed blob and the
  saved offline-map area; an examiner can demand the phrase. The decoy
  defends the application layer, not the platform layer.

## 6. What to build next

Competitor gaps and failures, converted into product work (tracked items
referenced where they exist):

1. **Ship the `.onion` relay endpoint.** The single highest-leverage fix:
   it closes the IP residual that lets Life360-style subpoena-tier IP logs
   even matter, and it is what separates Flock's metadata story from
   Signal's on the network layer. (ROADMAP: mesh-bridge Task B; the toggle
   and Orbot detection already ship.)
2. **Finish background-reliability validation.** The make-or-break gate is
   already closed — native background publish is measured green and shipped on
   the GrapheneOS Pixel (locked/Dozing beacons). What's left is the sustained
   outdoor-walk pass, the stationary deep-Doze pass, breadth across stock
   Androids, and an iOS shell. The Android platform limits are documented and
   designed around (foreground service; geofencing API at ~couple-of-minutes
   latency). Until those land, the honest pitch is "proven on the gate device,
   foreground-grade elsewhere".
3. **Un-park check-in / dead-man's-switch first.** It is the highest-value
   parked safety feature (Life360 scores 3 on safety actions largely on
   features of this class), it is already library-tested, and it is pure UI
   wiring. Then geofence breach alerts (the library's `noreport` cap keeps
   them threat-model-clean).
4. **Silence-vs-activity cover traffic.** PRIVACY.md's own open item — and
   Matrix's visible `m.beacon_info` tell is citable proof competitors get
   exactly this wrong. Finishing it makes invariant 1 airtight through
   fully-withheld periods.
5. **Commission an independent audit / publish the spec for review.**
   Signal's court receipts and Briar's Cure53 report are the credibility
   bar. FLOCK.md plus the golden vectors are an auditable surface already;
   the gap is the external review itself.
6. **iOS path after Android proves out.** WhatsApp's live location is
   primary-device-only and nothing in the privacy-first segment does
   cross-platform live sharing well; a working iOS shell would be
   category-defining, but not before the Android reliability evidence
   exists.
7. **Keep the tile/host story loud.** Element chose a third-party
   tileserver and documented the leak; Flock's same-origin proxy + offline
   areas is the stronger answer and should be stated as a differentiator in
   comparisons, not buried in PRIVACY.md.

## 7. Public wording

The canonical claim stays tight (from `docs/PRIVACY.md`):

> Flock minimises what relays and hosts can learn and remember. It does not
> hide that you connected. Use Tor or a VPN when IP metadata matters.

Honest per-competitor lines the evidence supports (each is citable to §4):

- *vs Life360:* "Life360 can read your location, keeps a stored profile of
  where you dwell for up to 18 months, and its current policy licenses
  precise location to business partners. Flock's relays can't read yours —
  there is nothing to license, retain, or subpoena."
- *vs Google Family Link:* "Family Link is built for a parent to watch a
  child — the location runs through Google on a managed account, with no
  end-to-end encryption, and a young child can't turn it off. Flock is for a
  circle of equals: everyone chooses what they share, and no company in the
  middle can read it."
- *vs Find My / WhatsApp:* "Encrypted content is not the same as no
  dossier: your identity, your circle and your connection records still
  live with Apple or Meta. Flock has no account to hold them under."
- *vs Telegram:* "Group live location on Telegram is stored on Telegram's
  servers, readable by Telegram. On Flock it is encrypted before it leaves
  the phone."
- *vs Glympse:* "Temporary by design is right — but Glympse's servers watch
  every share while it runs. Flock's never can."
- *vs Signal:* "Signal proved in court how little a server can be forced to
  hand over. Flock applies that same standard to live location — the thing
  Signal doesn't do."
- *vs OwnTracks / Home Assistant:* "Self-hosting moves the dossier onto
  your own server; it doesn't remove it. Flock's relays hold ciphertext
  that expires in days, whoever runs them."
- *vs Matrix/Element:* "On Matrix, starting a live share is announced in
  unencrypted room state — the server sees that you're sharing. On Flock,
  sharing, withholding and silence are indistinguishable on the wire."

What may **not** be claimed, per the refuted/unverified record: that Google
holds a readable standing movement history (refuted 0–3); that Signal
"encrypts metadata" (refuted — it *doesn't store* it, which is the correct
and stronger phrasing); and any background-reliability superiority for Flock
until the hardware evidence exists. (Family Link, previously unassessed, was
assessed on 2026-07-06: its account-bound, under-13-only and parent-controlled
facts survived 3-vote verification [A]; that Google can *read* the shared
location is a sound derivation from the Google row's [A] finding, not a
directly-quoted Family Link claim — cite it that way.)

## Appendix A: Flock evidence base (repo, 2026-07-06)

Shipped (live PWA at flock.forgesworn.dev; native Android APK):

- **Native background publish (Android APK) — the make-or-break gate, closed.**
  While the app is backgrounded the fix→policy→gift-wrap→relay pipeline runs
  natively in Kotlin (Android suspends the WebView), with wire-format parity to
  the JS path held by golden vectors. Measured green and shipped on a
  GrapheneOS Pixel 10 Pro (2026-07-05, release 0294b8c): screen locked and
  Dozing, relay-decrypted native beacons at +7 s and every ~50 s. Sustained
  outdoor-walk and stationary deep-Doze passes still pending.
- **No account, no phone number, no email.** Identity is a local Nostr key;
  circles are set up by QR/remote invite.
- **Gift-wrap everything (NIP-59).** A logging relay sees only `kind:1059`
  from random ephemeral keys — no real pubkeys, no roster, no signal types,
  no plaintext location, and withholding is wire-identical to sharing.
- **Rotating group inbox + epochs + per-circle personas (nsec-tree).** No
  long-term correlation handle; circles are mutually unlinkable.
- **Retention bounded backwards.** Every wrap carries a uniform 16-day
  NIP-40 expiry; `created_at` is randomised up to 2 days into the past.
- **Timing hygiene.** ±20% cadence jitter plus wire-identical stationary
  cover traffic (2026-07-04). Silence-vs-activity cover is not yet built.
- **Precision is user-held.** A per-person geohash slider (region → exact
  spot); the map previews exactly what the circle sees.
- **Coercion resistance.** App lock (PIN-wrapped AES-256-GCM at rest,
  PBKDF2-600k); decoy view sealing all state into a no-magic-bytes blob
  behind a genuine fresh-install experience with constant-work unlock
  failures; silent duress long-press; decoy-over-wipe by design.
- **Self-hostable.** Static PWA; relay and tile URLs are build-time
  configuration; the canonical host keeps access logs off and proxies all
  map traffic; offline map areas produce zero tile traffic.
- **Library capability set (tested, post-MVP for the app):**
  disclosure-on-event policy, geofence breach, SOS/duress with key domain
  separation, no-report zones, dead-man's-switch check-ins, breadcrumb
  trail, rendezvous and fair meeting points, off-grid pre-announce, spoken
  verification with a silent duress word.

Explicit non-goals (ROADMAP): crash/driving detection, crowdsourced
area-safety maps, professional monitoring dispatch — their absence is
positioning, not a gap.

## Appendix B: method

Two runs of the deep-research harness (fan-out search → source fetch →
claim extraction → 3-vote adversarial verification → synthesis),
2026-07-06. Run 1 (mainstream incumbents): 23 sources fetched, 111 claims
extracted, 25 verified → 23 confirmed, 2 refuted. Run 2 (self-hosted /
decentralised segment): 25 sources, 119 claims, 25 selected → 15 confirmed,
1 refuted, 9 left unverified when the run hit session limits (their
subject-matter — OwnTracks/HA background behaviour, Android Doze detail —
is carried above at grade [B] with verbatim quotes). The original coverage
gap — Google Family Link (search agent failed) — was closed by a targeted
follow-up on 2026-07-06: five candidate claims, three independent adversarial
verifiers each. Four (account-bound, parent-visible, under-13-only,
parent-controlled toggle) were confirmed 3/3 → grade [A]; one compound claim
(Google's servers read the shared location) was refuted 3/3 as a standalone
Family Link claim and is instead carried as a derivation from the Google
row's [A] finding. All verification votes and per-claim quotes are preserved
in the session's workflow journals.
