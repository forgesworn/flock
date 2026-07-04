# Hosted relay rooms: privacy and trust boundary

Flock relay rooms are for temporary circles: create a relay, use it for the
night, then burn it. The honest promise is:

> Flock minimises what the relay can learn, and what it can remember. It does
> not make the network provider blind.

This distinction matters for Bitcoin, Monero, liberty, and cypherpunk users.
They will correctly reject any claim that a hosted relay cannot see connection
metadata.

## What Flock protects

With the current gift-wrap design, the relay is treated as an untrusted pipe.
The relay should not learn:

- plaintext messages, locations, geofences, pings, or alerts
- real member pubkeys for circle traffic
- the circle roster
- the signal type: SOS, buzz, check-in, location, and cover traffic are opaque
  NIP-59 `kind:1059` wraps
- a persistent relay database, if the room uses RAM-only state and is destroyed
  at expiry
- account identity, if room creation does not require accounts

This is why "Flock does not need to know" is a fair claim.

## What a hosted relay can still observe

A hosted relay or infrastructure provider can still observe network metadata:

- client IPs, unless the user connects through Tor or a VPN
- timing, duration, bandwidth, and connection counts
- the destination app, domain, and room path
- source region and network changes
- ciphertext volume and burst patterns
- operational logs or metrics produced by the hosting platform

If the platform terminates TLS before forwarding to the room, the provider can
also see the WebSocket stream as it passes through its proxy. The Nostr payloads
remain application-encrypted, but the provider can inspect the ciphertext and
protocol envelope. If TLS is terminated inside the room instead, the provider
still sees metadata because it runs the network and compute substrate.

So the safe wording is:

> Flock reduces relay trust. It does not hide that you connected.

## Fly Machines beta

Fly is a good beta host for ephemeral rooms because Machines are cheap, fast,
and run as Firecracker microVMs. A room can be one small Machine with no volume,
short TTL, and no app-level logs.

Fly is not the final sovereign privacy story. Fly operates the edge proxy,
network, host infrastructure, logging, and billing relationship. Even with
self-terminated TLS, Fly can still see connection metadata and platform-level
usage.

Use Fly language like this:

- "Ephemeral microVM relay rooms"
- "No Flock account required"
- "No persistent relay database"
- "Burn after use"
- "Use Tor or a VPN if hiding your IP from the relay matters"

Do not say:

- "no trace"
- "the relay cannot see your IP"
- "the provider cannot monitor metadata"
- "anonymous by default"
- "surveillance-proof"

## User guidance

Users should choose the right room for their threat model:

| Mode | Best for | Honest limit |
|---|---|---|
| Hosted Flock Room | easiest temporary room | provider sees metadata |
| Hosted Room over VPN | hides home/mobile IP from the relay | VPN becomes the network observer |
| Hosted Room over Tor | stronger IP unlinkability | mobile reliability may be worse |
| Sovereign Room | user controls the relay host | user must secure the box and network path |
| Off-relay BLE/mesh | physically nearby groups | limited range and platform support |

For high-risk users, the recommendation should be explicit:

> If your IP address is sensitive, use Tor or a VPN before joining a hosted room.

## Operator requirements

A hosted room operator should run with these defaults:

- no user accounts for room creation
- no persisted creator identity
- no app-level access logs
- no Flock app logs containing IP plus room ID
- disable proxy/access logs where the chosen host lets us control them
- admin tokens stored only as hashes while the room is alive
- room state held in memory only
- relay database on tmpfs or no database at all
- no persistent volumes for room Machines
- short default TTL and hard maximum TTL
- burn endpoint for immediate teardown
- aggregate health metrics only, not per-room or per-IP dashboards
- payments, if any, kept optional or carefully separated from room identity

This lets us say: "Your relay does not need to remember." It does not let us say:
"nobody can see the network metadata."

## Product wording

Strong, honest lines:

- "Protect The Flock"
- "Flock does not need to know. Your relay does not need to remember."
- "Ephemeral rooms. Encrypted signals. Burn after use."
- "Bring your own relay, or use ours for the night."
- "Use Tor or a VPN when IP metadata matters."

Short version:

> Flock is privacy by minimisation, not privacy by pretending infrastructure
> cannot observe packets.

## References

- Fly architecture: https://fly.io/docs/reference/architecture/
- Fly TLS termination: https://fly.io/docs/security/tls-termination/
- Fly security practices: https://fly.io/docs/security/security-at-fly-io/
