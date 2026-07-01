// The live rendezvous countdown label. Pure so it never reads the clock — the
// caller passes the remaining seconds on each tick, which keeps it trivially
// testable and lets the ticker update just this string without a full re-render.
// H:MM:SS from an hour up, M:SS below, clamped at zero (a passed deadline reads
// "0:00", never negative).
export function formatCountdown(remainingSeconds: number): string {
  const total = Math.max(0, Math.floor(remainingSeconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number): string => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}
