// Public compatibility vectors for the native (Kotlin) radar guidance core. The radar rules
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
  resolveHeading,
  selectMode,
  panFor,
  turnSign,
  classifyTrend,
  vectorDirectionPhrase,
  clockHour,
  clockFacePhrase,
  speakableDistanceMetres,
  voiceLine,
  crossedMilestone,
  type RadarInput,
  type HeadingInput,
  type ModeInput,
  type CueContext,
} from '@forgesworn/flock'

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
// behavioural intent of each). Cases 0..16 are the v1 set; 17..19 exercise the
// v2 my-accuracy honesty gate + arrival rework (append-only so the Kotlin
// parity test's positional reads stay valid).
const GUIDANCE_CASES: RadarInput[] = [
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: null },
  { me: null, headingDeg: 0, target: target(0.01) },
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 2.4, 700) }, // stale
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.05, 610) }, // coarse far
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.001, 610) }, // coarse inside
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 610) }, // coarse mid
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.000015) }, // arrived (~1.7 m endgame)
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00005) }, // point deep in the old dead zone (~5.5 m)
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00015, 19) }, // arrived by uncertainty
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.0002, 19) }, // point, bearing not usable
  { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.01) }, // no-heading far
  { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.0005) }, // no-heading close
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.0005) }, // aligned close → triple
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01) }, // aligned far → double
  { me: { lat: 0, lon: 0 }, headingDeg: 45, target: target(0.01) }, // near
  { me: { lat: 0, lon: 0 }, headingDeg: 150, target: target(0.01) }, // off
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 2.4, 300) }, // aging
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.0001), myAccuracyMetres: 15 }, // arrived by MY accuracy (~11 m, radius 12)
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00008), myAccuracyMetres: 9 }, // point, MY bad fix voids the bearing (~8.8 m)
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01), myAccuracyMetres: 5 }, // point aligned — accuracy present but not limiting
]

// v2 heading engine — compass-vs-course arbitration by speed.
const HEADING_CASES: HeadingInput[] = [
  { compassDeg: 90, compassUsable: true, courseDeg: 200, speedMps: 8 },     // fast → course
  { compassDeg: 90, compassUsable: true, courseDeg: null, speedMps: 8 },    // fast, no course → none
  { compassDeg: 90, compassUsable: true, courseDeg: 200, speedMps: 0.2 },   // slow → compass
  { compassDeg: 90, compassUsable: false, courseDeg: 200, speedMps: 0.2 },  // slow, compass unusable → course
  { compassDeg: null, compassUsable: false, courseDeg: null, speedMps: 0.2 }, // slow, nothing → none
  { compassDeg: 100, compassUsable: true, courseDeg: 110, speedMps: 2 },    // mid, compass agrees → compass
  { compassDeg: 100, compassUsable: true, courseDeg: 200, speedMps: 2 },    // mid, compass disagrees → course + unreliable
  { compassDeg: null, compassUsable: true, courseDeg: 200, speedMps: 2 },   // mid, no compass → course
  { compassDeg: 45, compassUsable: true, courseDeg: null, speedMps: null },  // no speed (→0) → compass
]

// v2 mode machine — VECTOR / SEEK / HOMING with hysteresis.
const MODE_CASES: ModeInput[] = [
  { prevMode: 'seek', distanceMetres: 500, speedMps: 1, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },   // seek
  { prevMode: 'seek', distanceMetres: 20, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },    // enter homing
  { prevMode: 'homing', distanceMetres: 35, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },  // homing holds (hysteresis)
  { prevMode: 'homing', distanceMetres: 45, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },  // homing exits
  { prevMode: 'seek', distanceMetres: 20, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 80 },     // coarse never homing
  { prevMode: 'seek', distanceMetres: 5000, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },  // enter vector by distance
  { prevMode: 'seek', distanceMetres: 800, speedMps: 6, fastForSec: 6, slowForSec: 0, uncertaintyMetres: 2.4 },   // enter vector by sustained speed
  { prevMode: 'vector', distanceMetres: 800, speedMps: 3, fastForSec: 0, slowForSec: 3, uncertaintyMetres: 2.4 }, // vector holds (not yet slow-sustained)
  { prevMode: 'vector', distanceMetres: 800, speedMps: 0, fastForSec: 0, slowForSec: 12, uncertaintyMetres: 2.4 }, // vector exits
  { prevMode: 'vector', distanceMetres: 3000, speedMps: 0, fastForSec: 0, slowForSec: 12, uncertaintyMetres: 2.4 }, // vector holds (still far)
  { prevMode: 'vector', distanceMetres: 15, speedMps: 0, fastForSec: 0, slowForSec: 12, uncertaintyMetres: 2.4 }, // endgame beats vehicle → homing
]

const PAN_CASES = [-180, -90, -45, 0, 30, 90, 135, null]
const SIGN_CASES = [null, 0, 5, 8, 9, -9, 45, -90, 180]
const TREND_CASES = [null, -0.8, -0.5, -0.1, 0.1, 0.5, 0.8]
const DIRECTION_PHRASE_CASES = [null, 0, 10, 45, -45, 90, -90, 135, -135, 175]
const MILESTONE_CASES = [
  { prev: null, next: 900 },
  { prev: 1200, next: 900 },
  { prev: 1200, next: 400 },
  { prev: 600, next: 550 },
  { prev: 300, next: 240 },
  { prev: 120, next: 90 },
  { prev: 90, next: 80 },
]

// v2 mode-specific cues — VECTOR sparse prompt, HOMING continuous geiger cadence
// with the honesty-gated pan/sign and warmer/colder trend.
const CUE_MODE_CASES: { input: RadarInput; ctx: CueContext }[] = [
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 30, target: target(0.05) }, ctx: { mode: 'vector' } }, // vector far, sign left
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 20, target: target(0.00027) }, ctx: { mode: 'homing', closingRateMps: -0.8 } }, // homing far ~30 m, honest, closing
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.000045) }, ctx: { mode: 'homing', closingRateMps: 0.5 } }, // homing near ~5 m, receding
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00008), myAccuracyMetres: 5 }, ctx: { mode: 'homing', closingRateMps: -0.6 } }, // homing arrow DROPPED (bearing fiction)
  { input: { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.00027) }, ctx: { mode: 'homing', closingRateMps: -0.8 } }, // homing, no heading → warmer/colder only
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

// v2.1 clock-face + speakable ranges + periodic line (field test 2026-07-21).
const CLOCK_CASES = [null, 0, 14, 16, 44, 46, 90, 180, -180, -90, -16, -44, 359]
const SPEAKABLE_CASES = [1, 12, 13, 60, 90, 340, 370, 1240, 1260, 2600, 7400, 50_000]
const VOICE_LINE_CASES: { kind: 'periodic' | 'milestone' | 'bearing-change'; input: RadarInput; distanceMetres: number }[] = [
  { kind: 'periodic', input: { me: { lat: 0, lon: 0 }, headingDeg: 30, target: target(0.01) }, distanceMetres: 1000 },
  { kind: 'periodic', input: { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.01) }, distanceMetres: 500 },
  { kind: 'periodic', input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 610) }, distanceMetres: 1000 }, // coarse → range only
  { kind: 'milestone', input: { me: { lat: 0, lon: 0 }, headingDeg: 150, target: target(0.01) }, distanceMetres: 500 },
  { kind: 'bearing-change', input: { me: { lat: 0, lon: 0 }, headingDeg: 45, target: target(0.01) }, distanceMetres: 0 },
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
    heading: HEADING_CASES.map((input) => ({ input, expected: resolveHeading(input) })),
    mode: MODE_CASES.map((input) => ({ input, expected: selectMode(input) })),
    pan: PAN_CASES.map((rel) => ({ rel, expected: panFor(rel) })),
    sign: SIGN_CASES.map((rel) => ({ rel, expected: turnSign(rel) })),
    trend: TREND_CASES.map((rate) => ({ rate, expected: classifyTrend(rate) })),
    directionPhrase: DIRECTION_PHRASE_CASES.map((rel) => ({ rel, expected: vectorDirectionPhrase(rel) })),
    milestone: MILESTONE_CASES.map((c) => ({ ...c, expected: crossedMilestone(c.prev, c.next) })),
    cueModes: CUE_MODE_CASES.map(({ input, ctx }) => {
      const g = radarGuidance(input)
      return { input, ctx, guidance: g, cue: cueFor(g, ctx) }
    }),
    moved: MOVED_CASES.map((c) => ({ ...c, expected: targetMoved(c.prev, c.next) })),
    course: COURSE_CASES.map((c) => ({ ...c, expected: courseFromFixes(c.prev, c.next) })),
    clockFace: CLOCK_CASES.map((rel) => ({ rel, hour: clockHour(rel), phrase: clockFacePhrase(rel) })),
    speakable: SPEAKABLE_CASES.map((m) => ({ m, expected: speakableDistanceMetres(m) })),
    voiceLines: VOICE_LINE_CASES.map((c) => ({
      ...c,
      expected: voiceLine({ kind: c.kind, distanceMetres: c.distanceMetres } as Parameters<typeof voiceLine>[0],
        radarGuidance(c.input), (m) => `${Math.round(m)} m`),
    })),
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
