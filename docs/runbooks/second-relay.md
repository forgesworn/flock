# Runbook — stand up relay #2 (no-log, NIP-40-honouring)

**Companion to** `docs/plans/2026-07-01-second-no-log-relay.md` (the design triage:
why a second relay now, why the paywall and TEE tiers are parked). This is the
executable half: bare host → serving member traffic. **Blocked only on a host.**

## What changed since the plan

The plan preferred strfry for its future write-policy plugin. Since then, **Slice 6
made NIP-40 a hard requirement**: every gift wrap now carries an `expiration`, and
the retention bound (FLOCK.md §6.6) plus fence-set replay assume the relay honours
it. trotters runs **nostr-rs-relay 0.9**, whose behaviour we verified end-to-end
(rejects expired at publish, suppresses on read). **Recommendation: nostr-rs-relay
for parity.** strfry remains the choice *if* its expiration handling passes the
probe below — re-evaluate when the paywall tier actually matters.

Note the distinction the config must respect: **no-log ≠ no-store**. Stored wraps
are the service (fence-set replay for late subscribers; backlog for offline
members) and they self-expire in ≤16 days. "No-log" means no *access* records: no
IPs, no query logs, no connection journals on disk.

## Prerequisites (Darren)

- [ ] A VPS in a **different failure domain** from both relay.trotters.cc *and* the
      flock host (Hetzner Helsinki) — different provider or at least
      region. 2 GB RAM is ample; disk grows only with ≤16 days of wraps.
- [ ] A DNS name (suggest `relay2.trotters.cc` or a ForgeSworn domain), **DNS-only /
      grey-cloud** — a CDN in front of a privacy relay would see every member's IP
      and connection timing, recreating the exact problem the relay exists to avoid.
- [ ] Root SSH.

## Steps

### 1. Base hardening (no-log posture at the OS layer)

```sh
ufw default deny incoming && ufw allow 22/tcp && ufw allow 443/tcp && ufw enable
swapoff -a && sed -i '/ swap /d' /etc/fstab        # nothing pages event memory to disk
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=64M\n' > /etc/systemd/journald.conf.d/no-disk.conf
systemctl restart systemd-journald                  # journal lives in RAM only
```

### 2. nostr-rs-relay

Build or pull (`ghcr.io/scsibug/nostr-rs-relay`); pin the same 0.9.x line as
trotters. `config.toml` essentials:

```toml
[info]
name = "<name>"
description = "No-log relay for flock/ForgeSworn traffic. No IP or query logging; events expire per NIP-40."
# contact / pubkey as appropriate

[database]
data_directory = "/var/lib/nostr-rs-relay"   # event store on disk is FINE (no-log ≠ no-store)

[network]
address = "127.0.0.1"                        # Caddy terminates TLS in front
port = 8080

[limits]
messages_per_sec = 25
max_event_bytes = 65536                      # a gift wrap is ~2–4 KB; generous headroom
# leave verified_users / auth OFF — an allowlist would be an identity log
```

Run as a systemd unit with `StandardOutput=journal` (volatile per step 1). Do not
enable any per-connection tracing.

### 3. Caddy (TLS, access logs OFF)

```caddy
relay2.example.com {
    reverse_proxy 127.0.0.1:8080
    # NO `log` directive — mirrors deploy/Caddyfile on the flock host.
}
```

### 4. Tor v3 onion (the highest-leverage add-on — do it while you're here)

```sh
apt install tor
cat >> /etc/tor/torrc <<'EOF'
HiddenServiceDir /var/lib/tor/relay/
HiddenServicePort 443 127.0.0.1:8080
EOF
systemctl restart tor && cat /var/lib/tor/relay/hostname   # → the .onion address
```

The onion serves ws:// (Tor provides the transport privacy TLS would); test with a
Tor-enabled client. Offer it in settings as opt-in first; `PRIVATE_RELAYS` default
inclusion is a later call.

### 5. Verify — every box, from a machine that is not the relay

- [ ] NIP-11: `curl -s -H "Accept: application/nostr+json" https://relay2.… ` →
      `supported_nips` includes **1, 12, 16, 20, 33, 40** (what flock exercises).
- [ ] **NIP-40 behavioural probe** (claimed ≠ honoured):
      `node scripts/nip40-probe.mjs wss://relay2.…` → exit 0.
- [ ] Round-trip: `FLOCK_RELAY=wss://relay2.… npm run smoke` (publishes + reads back
      a wrapped signal via the live relay).
- [ ] No-log spot-check on the host: no files under Caddy's log dir; `journalctl
      --disk-usage` ≈ 0; `swapon --show` empty; relay data dir contains only the DB.
- [ ] Warrant canary published at a predictable URL (trust *signal*, labelled as such).

### 6. Wire into flock (one line + one decision)

1. Add `wss://relay2.…` to `PRIVATE_RELAYS` in `app/src/relays.ts`. Fan-out,
   fail-loud and dedup are already live — no other app change.
2. **Decision:** existing users keep their persisted `relayUrls`, so the new
   default reaches fresh installs only. Ship the one-time migration (append the
   new relay to any list that equals the old default) so everyone lands on ≥2 —
   recommended; a user who deliberately customised keeps their custom list.
3. Deploy, then run the **redundancy acceptance e2e** we could never write with
   one relay: two devices on the two-relay set, kill relay #1 (or firewall it),
   an SOS still arrives via #2. Add it as `e2e/relay-redundancy.spec.ts` gated on
   a `FLOCK_E2E_RELAY2` env so it only runs where a second relay exists.

## Cost of not doing this

Every SOS in the world currently depends on one box (`relay.trotters.cc`). The
fan-out machinery shipped in `73ee7d7` is armed and waiting; this runbook is the
whole remaining distance.
