// Golden vectors for the native (Kotlin) radar guidance core. The radar rules
// are pure and deterministic, so every case is directly comparable: the same
// inputs must produce the same guidance state, cue and numbers on both sides —
// the locked-phone beeper must never be more confident than the tested JS
// tracker. Regenerate with `npm run gen:vectors` on a deliberate rule change.
// Cases sit AWAY from tier boundaries so float rounding can't flip a state.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initialBearingDeg,
  angularErrorDeg,
  classifyFreshness,
  radarGuidance,
  cueFor,
  targetMoved,
  courseFromFixes,
  type RadarInput,
} from '../../src/radar'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'radar-vectors.json')

const BEARING_CASES = [
  { a: { lat: 0, lon: 0 }, b: { lat: 1, lon: 0 } },
  { a: { lat: 0, lon: 0 }, b: { lat: 0, lon: 1 } },
  { a: { lat: 0, lon: 0 }, b: { lat: -1, lon: 0 } },
  { a: { lat: 0, lon: 0 }, b: { lat: 0, lon: -1 } },
  { a: { lat: 0, lon: 0 }, b: { lat: 1, lon: 1 } },
  { a: { lat: 51.5, lon: -0.12 }, b: { lat: 51.51, lon: -0.13 } },
  { a: { lat: 51.5, lon: -0.12 }, b: { lat: 48.8566, lon: 2.3522 } },
]

const ANGULAR_CASES = [
  { bearing: 30, heading: 0 }, { bearing: 330, heading: 0 },
  { bearing: 10, heading: 350 }, { bearing: 350, heading: 10 },
  { bearing: 180, heading: 0 }, { bearing: 0, heading: 180 },
  { bearing: 90, heading: 90 },
]

const FRESHNESS_CASES = [0, 60, 61, 300, 600, 601, 5000]

const target = (lat: number, u = 2.4, age = 5): NonNullable<RadarInput['target']> =>
  ({ position: { lat, lon: 0 }, uncertaintyMetres: u, ageSeconds: age })

// One case per guidance state and cue tier (see src/radar.test.ts for the
// behavioural intent of each).
const GUIDANCE_CASES: RadarInput[] = [
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: null },
  { me: null, headingDeg: 0, target: target(0.01) },
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 2.4, 700) }, // stale
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.05, 610) }, // coarse far
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.001, 610) }, // coarse inside
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 610) }, // coarse mid
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00005) }, // arrived
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00015, 19) }, // arrived by uncertainty
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.0002, 19) }, // point, bearing not usable
  { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.01) }, // no-heading far
  { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.0005) }, // no-heading close
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.0005) }, // aligned close → triple
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01) }, // aligned far → double
  { me: { lat: 0, lon: 0 }, headingDeg: 45, target: target(0.01) }, // near
  { me: { lat: 0, lon: 0 }, headingDeg: 150, target: target(0.01) }, // off
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 2.4, 300) }, // aging
]

const MOVED_CASES = [
  { prev: null, next: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 2.4 } },
  { prev: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 2.4 }, next: { position: { lat: 0.0001, lon: 0 }, uncertaintyMetres: 2.4 } },
  { prev: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 2.4 }, next: { position: { lat: 0.0005, lon: 0 }, uncertaintyMetres: 2.4 } },
  { prev: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 610 }, next: { position: { lat: 0.003, lon: 0 }, uncertaintyMetres: 610 } },
  { prev: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 610 }, next: { position: { lat: 0.011, lon: 0 }, uncertaintyMetres: 610 } },
]

const COURSE_CASES = [
  { prev: { position: { lat: 0, lon: 0 }, atSec: 0 }, next: { position: { lat: 0.0002, lon: 0 }, atSec: 10 } },
  { prev: { position: { lat: 0, lon: 0 }, atSec: 0 }, next: { position: { lat: 0.00002, lon: 0 }, atSec: 10 } },
  { prev: { position: { lat: 0, lon: 0 }, atSec: 10 }, next: { position: { lat: 0.001, lon: 0 }, atSec: 10 } },
]

function build(): Record<string, unknown> {
  return {
    bearing: BEARING_CASES.map((c) => ({ ...c, expected: initialBearingDeg(c.a, c.b) })),
    angularError: ANGULAR_CASES.map((c) => ({ ...c, expected: angularErrorDeg(c.bearing, c.heading) })),
    freshness: FRESHNESS_CASES.map((age) => ({ age, expected: classifyFreshness(age) })),
    guidance: GUIDANCE_CASES.map((input) => {
      const g = radarGuidance(input)
      return { input, guidance: g, cue: cueFor(g) }
    }),
    moved: MOVED_CASES.map((c) => ({ ...c, expected: targetMoved(c.prev, c.next) })),
    course: COURSE_CASES.map((c) => ({ ...c, expected: courseFromFixes(c.prev, c.next) })),
  }
}

describe('native radar golden vectors', () => {
  it('generates or verifies radar-vectors.json', () => {
    const fresh = build()
    if (process.env.FLOCK_GEN_VECTORS === '1' || !existsSync(OUT)) {
      writeFileSync(OUT, JSON.stringify(fresh, null, 2) + '\n')
    }
    // The committed vectors must still match the live JS implementation —
    // a rule change without a deliberate regeneration fails here first.
    const committed = JSON.parse(readFileSync(OUT, 'utf8'))
    expect(committed).toEqual(JSON.parse(JSON.stringify(fresh)))
  })
})
