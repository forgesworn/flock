// Pure metrics for the Phase 0 background-location spike — no I/O, no Capacitor,
// no library deps. Turns a recorded session into the numbers the spike doc asks
// for: fix cadence (test #1), breach-detection latency (test #2), and gaps that
// hint at Doze death (test #3). Kept pure so the maths is trustworthy and could
// be exercised without a device.

export interface SpikeFix {
  /** epoch ms when the fix was recorded on-device */
  t: number
  lat: number
  lon: number
  /** reported accuracy in metres */
  acc: number
  /** outside the configured safe zone at this fix? */
  out: boolean
}

export interface SpikeBreach {
  /** epoch ms of the last fix that was still inside (null if first fix was already outside) */
  lastInsideT: number | null
  /** epoch ms of the first fix observed outside */
  firstOutsideT: number
}

export interface SpikeSession {
  startedAt: number
  zone: { lat: number; lon: number; radiusMetres: number } | null
  fixes: SpikeFix[]
  breaches: SpikeBreach[]
  device: string
}

// Pass thresholds straight from docs/plans/2026-06-30-phase0-graphene-spike.md.
const CADENCE_MAX_S = 60 // #1: a fix at least every ≤60 s while moving
const BREACH_MAX_S = 90 // #2: breach detected within ≤90 s of leaving
const GAP_ALERT_S = 300 // record any gap > 5 min (feeds the #3 Doze judgement)
const MOVE_THRESHOLD_M = 25 // distanceFilter — "moving" = we actually travelled this far

function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_008.8
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

export interface SpikeMetrics {
  fixes: number
  spanSec: number
  intervalMedianS: number
  intervalP90S: number
  intervalMaxS: number
  /** cadence while actually moving — the figure test #1 is graded on */
  movingIntervalP90S: number
  movingSamples: number
  gapsOver5min: { fromT: number; toT: number; gapSec: number }[]
  breaches: { detectionSec: number | null; firstOutsideT: number }[]
  pass: { cadence: boolean | null; breach: boolean | null }
}

export function computeMetrics(s: SpikeSession): SpikeMetrics {
  const f = [...s.fixes].sort((a, b) => a.t - b.t)
  const intervals: number[] = []
  const movingIntervals: number[] = []
  const gaps: { fromT: number; toT: number; gapSec: number }[] = []

  for (let i = 1; i < f.length; i++) {
    const dt = (f[i].t - f[i - 1].t) / 1000
    intervals.push(dt)
    const moved = haversine(f[i - 1].lat, f[i - 1].lon, f[i].lat, f[i].lon)
    if (moved >= MOVE_THRESHOLD_M) movingIntervals.push(dt)
    if (dt > GAP_ALERT_S) gaps.push({ fromT: f[i - 1].t, toT: f[i].t, gapSec: Math.round(dt) })
  }

  const sortedI = [...intervals].sort((a, b) => a - b)
  const sortedM = [...movingIntervals].sort((a, b) => a - b)
  const breaches = s.breaches.map((b) => ({
    firstOutsideT: b.firstOutsideT,
    detectionSec: b.lastInsideT == null ? null : Math.round((b.firstOutsideT - b.lastInsideT) / 1000),
  }))

  const movingP90 = quantile(sortedM, 0.9)
  const worstBreach = breaches.reduce<number | null>(
    (m, b) => (b.detectionSec == null ? m : m == null ? b.detectionSec : Math.max(m, b.detectionSec)),
    null,
  )

  return {
    fixes: f.length,
    spanSec: f.length > 1 ? Math.round((f[f.length - 1].t - f[0].t) / 1000) : 0,
    intervalMedianS: Math.round(quantile(sortedI, 0.5)) || 0,
    intervalP90S: Math.round(quantile(sortedI, 0.9)) || 0,
    intervalMaxS: Math.round(sortedI[sortedI.length - 1] ?? 0),
    movingIntervalP90S: sortedM.length ? Math.round(movingP90) : 0,
    movingSamples: movingIntervals.length,
    gapsOver5min: gaps,
    breaches,
    pass: {
      // null = not enough evidence yet (didn't move / no breach recorded) — judge by hand.
      cadence: sortedM.length ? movingP90 <= CADENCE_MAX_S : null,
      breach: worstBreach == null ? null : worstBreach <= BREACH_MAX_S,
    },
  }
}
