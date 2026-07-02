# Examples

Runnable, type-checked consumer examples for `@forgesworn/flock`.

```sh
npm run build                 # imports self-reference the package → dist/
node examples/quickstart.ts   # Node ≥ 24 runs .ts directly (type stripping)
```

- [`quickstart.ts`](quickstart.ts) — the full pipeline: geofence → disclosure
  policy → unsigned signal, plus SOS/help, a night-out group with derived
  presence, and a dead-man's-switch check-in.

The library never signs or publishes: every builder returns an **unsigned**
event; sign with `nostr-tools` (`finalizeEvent`) and publish yourself — the
PWA (`app/src/services.ts`) shows a real transport wiring.
