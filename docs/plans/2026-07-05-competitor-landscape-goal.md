# Competitor landscape goal

## Goal

Produce a source-backed competitor landscape for Flock and decide the winner for
one narrow use case:

> Private security and location coordination for a small circle of friends or
> family who trust each other, do not want a company holding their movement
> history, and may use a VPN or Tor to reduce IP-address exposure to relays and
> hosts.

The comparison must judge competitors against this threat model, not against
general consumer convenience alone. A product can have more mainstream polish
and still lose if it requires a central account, stores plaintext location
history, exposes the social graph, or makes withholding/sharing status obvious.

## Target users

- A family coordinating school pickups, elderly-relative safety, or emergency
  check-ins without creating a permanent location dossier.
- A friend group travelling, attending a festival, or going out for the night
  who only need temporary coordination.
- A privacy-conscious circle that wants location sharing to be deliberate,
  encrypted, minimised, and disposable.
- A higher-risk user who needs the app itself to avoid becoming evidence if a
  phone is searched or a provider is compelled.

## Threat model for the comparison

Assume:

- The circle members are known to each other and intentionally invited.
- Devices may use a VPN or Tor before connecting, but this only shifts or
  reduces IP exposure; it does not make network metadata disappear.
- Relays, app servers, map servers, cloud hosts, and infrastructure providers
  may log metadata.
- A competitor's operator may be compelled, breached, or commercially motivated
  to analyse retained data.
- The phone OS and the user's unlocked device remain powerful trust boundaries.

Do not assume:

- "No-log" marketing is a security property unless the design makes logs
  materially useless.
- VPN use hides timing, bandwidth, destination service, or all correlation risk.
- End-to-end encryption of messages automatically protects location metadata,
  group membership, IP metadata, push metadata, map-tile lookups, or stored
  history.

## Competitors to assess

The first pass should cover:

| Category | Products to compare | Why they matter |
|---|---|---|
| Mainstream family safety | Life360, Apple Find My, Google Maps location sharing / Family Link | High convenience, strong adoption, but usually centralised identity and retained provider metadata |
| Mainstream messengers with live location | WhatsApp, Signal, Telegram | Familiar sharing flows; useful baseline for E2EE claims versus metadata and retention limits |
| Social location products | Snapchat Snap Map and similar | Popular with friend groups; useful contrast for privacy, default visibility, and social graph exposure |
| Temporary sharing tools | Glympse and equivalent link-based live sharing | Close to the temporary-circle use case, but often account/link/provider centred |
| Self-hosted or open tools | OwnTracks, Home Assistant presence/location, Matrix/Element location sharing, XMPP clients where relevant | Useful for sovereignty and inspectability, but usually weaker on consumer UX or coercion-resistance |
| Local/off-grid messengers | Briar, Berty, Bluetooth/mesh tools where relevant | Useful contrast for relay-free operation, but usually not full family-location products |
| Flock | Current app plus tested library capabilities | The privacy/security benchmark for this exact friend/family circle use case |

This list should be expanded only when a product clearly competes for the same
"trusted small circle, privacy-first location safety" job.

## Feature comparison frame

Score each product on the features that matter to this use case:

| Area | What to check |
|---|---|
| Circle setup | Small private groups, QR/code invites, temporary circles, member removal, reseed/revocation |
| Location control | Off by default, coarse sharing, exact one-shot sharing, live sharing, expiry, user-visible precision |
| Safety actions | Check-in, SOS/duress, "come to me", "where are you?", lost-phone flow, dead-man's-switch, geofences |
| Privacy architecture | End-to-end encryption, server-side plaintext exposure, real identifiers in routing metadata, social-graph leakage |
| Metadata minimisation | IP exposure, timing/volume leakage, rotating identifiers, cover traffic, retention windows, relay/database persistence |
| Coercion resistance | App lock, decoy view, silent duress, indistinguishable withholding, no obvious "sharing disabled" tell |
| Network options | Self-hosting, own relay/server, Tor/onion support, VPN compatibility, off-relay BLE/mesh path |
| Data retention | Plaintext history, ciphertext history, deletion controls, default expiry, auditability of "no log" claims |
| Reliability | Background location, push/notifications, low-battery behaviour, offline maps, cross-platform support |
| Usability | Consumer setup, contact discovery, recovery, device migration, non-technical operation |

## Scoring rubric

Use a 0-3 score for each area:

| Score | Meaning |
|---|---|
| 0 | Missing, hostile to the threat model, or unverified marketing claim only |
| 1 | Partially present, but materially leaks data or depends on provider trust |
| 2 | Good enough for ordinary users, with honest limits |
| 3 | Strong fit for the Flock threat model and backed by architecture, source, or reproducible behaviour |

Weighting:

| Area | Weight |
|---|---:|
| Privacy architecture | 3 |
| Metadata minimisation | 3 |
| Data retention | 3 |
| Coercion resistance | 2 |
| Location control | 2 |
| Network options | 2 |
| Reliability | 2 |
| Circle setup | 1 |
| Safety actions | 1 |
| Usability | 1 |

The winner is the product with the best weighted score for the defined threat
model, not the product with the biggest mainstream feature list.

## Flock's starting thesis

Flock should be the likely winner for a privacy-first friend/family circle if the
comparison values architecture over brand trust:

- No Flock account, phone number, email, or central identity is required for the
  core circle model.
- Location, alerts, petnames, geofences, and safety state are encrypted before
  they leave the device.
- Relays are treated as hostile pipes, not trusted custodians.
- Real pubkeys, rosters, signal types, and plaintext locations are kept out of
  relay-visible routing metadata.
- Circles can be temporary, reseeded, removed, and burned down.
- App lock, decoy view, and silent/coerced flows are part of the product model,
  not afterthoughts.
- VPN or Tor can reduce the most damaging residual network leak: source IP to
  relay/host.

Flock does not automatically win every category. Mainstream products are likely
to win on onboarding, contact discovery, operating-system integration,
cross-platform polish, push reliability, and ordinary-user familiarity. Flock's
claim should be narrower and stronger: for a circle that prioritises privacy,
minimum disclosure, no company-held movement history, and honest VPN/Tor
metadata limits, Flock is built for that job in a way mainstream products are
not.

## Required evidence

For each competitor, collect:

- Official privacy policy and security documentation.
- Whether location content is end-to-end encrypted.
- What metadata the provider can see: accounts, contacts, group graph, IPs,
  timing, push tokens, map requests, device identifiers.
- Retention defaults for location history, messages, logs, and shared links.
- Whether live location is temporary by default or can become standing tracking.
- Whether the provider can access plaintext location under normal operation.
- Whether self-hosting, custom relay/server use, Tor, or onion endpoints are
  supported.
- Background-location reliability claims and platform limitations.
- Any documented law-enforcement, abuse, breach, or data-broker risk.

Do not declare a final winner until this evidence is cited in the comparison
table.

## Deliverable

Create a markdown report under `docs/research/` with:

1. A one-page executive summary naming the winner for the target threat model.
2. A weighted comparison table.
3. A feature-by-feature table comparing Flock against each competitor.
4. A privacy/security findings section with citations.
5. A "where Flock loses" section that is blunt about reliability and UX gaps.
6. A "what to build next" section that turns competitor gaps into product work.
7. Short, honest product wording Flock can use publicly without overclaiming.

The report should keep the final privacy claim tight:

> Flock minimises what relays and hosts can learn and remember. It does not hide
> that you connected. Use Tor or a VPN when IP metadata matters.

