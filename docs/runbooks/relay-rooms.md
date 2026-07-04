# Ephemeral microVM relay rooms

Flock relay rooms are short-lived Nostr relay endpoints for temporary circles:
create a room, use it for the night, then burn it. The honest promise is
**RAM-only relay state destroyed at expiry**, not "no trace". The host, network,
DNS, and payment layers can still leave metadata.

For product wording and the public trust-boundary statement, see
[`docs/relay-room-privacy.md`](../relay-room-privacy.md). In short: Flock
minimises what the relay can learn and remember; it does not hide that a user
connected. Users who need IP privacy should use Tor or a VPN.

## Architecture

- `server/rooms.mjs` is the no-account control plane and WebSocket router.
- `POST /rooms` creates a room and returns `{ relayUrl, adminToken, expiresAt }`.
- `DELETE /rooms/:id` burns it with `Authorization: Bearer <adminToken>`.
- `wss://rooms.example/r/<roomId>` proxies the Nostr WebSocket to the room backend.
- Production uses `FLOCK_ROOM_RUNNER=external`; the external runner starts one
  Firecracker microVM and prints `{"backendHost":"127.0.0.1","backendPort":...}`.

## Host requirements

- Dedicated KVM-capable host with `/dev/kvm`; do not run this on the shared web box.
- Swap disabled.
- Volatile journald.
- Caddy access logs off.
- Firecracker jailer enabled for each microVM.
- Per-room guest rootfs read-only; relay database on guest `tmpfs`.

Firecracker needs Linux KVM and `/dev/kvm`; the jailer adds chroot, cgroups,
namespaces, and seccomp around the VMM. Use a dedicated host so these are real
security boundaries rather than Docker-style packaging.

## Runner contract

The rooms service starts the configured command with the room spec on stdin:

```json
{
  "id": "room-id",
  "createdAt": 1783210000,
  "expiresAt": 1783231600,
  "limits": {
    "maxConnections": 32,
    "maxEvents": 10000,
    "maxEventBytes": 65536,
    "messagesPerSecond": 25
  }
}
```

The runner must print one JSON line:

```json
{"backendHost":"127.0.0.1","backendPort":12001}
```

When the room expires or is burned, the service sends `SIGTERM` to the runner.
The runner must tear down the microVM, tap device, tmpfs, and any temporary files
under `/run`.

## Caddy sketch

```caddy
rooms.forgesworn.dev {
    reverse_proxy 127.0.0.1:8792
    # no log directive
}
```

## Verification

1. `FLOCK_ROOM_RUNNER=mock node server/rooms.mjs` starts locally for API testing.
2. `npm test -- server/rooms.test.mjs` passes.
3. On the host: `ls /dev/kvm`, `swapon --show`, and `journalctl --disk-usage`.
4. Create a room, set Flock's circle relay to the returned `relayUrl`, publish a
   wrapped signal, then burn the room and confirm the WebSocket path no longer
   accepts connections.
