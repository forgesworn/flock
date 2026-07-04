/**
 * Remote exact ping ("find my phone") — the consent gate on THIS device.
 *
 * A member can ask a lost phone for a one-shot exact fix. A remotely-triggered
 * disclosure is only legitimate when the owner pre-authorised it *and* the phone
 * is genuinely flagged lost — pre-authorisation is what keeps the disclosure
 * originating from the device's own settings (FLOCK §6.4, and the roadmap's
 * permanent non-goal of remote "start sharing"). This module is the pure gate;
 * the wire signal is `src/findping.ts` in the library, and the app wires the
 * cancel window + one-shot answer around it.
 *
 * See `docs/plans/2026-07-04-remote-exact-ping.md`.
 */

/** Seconds the cancel banner counts down before a qualifying ping is answered —
 *  long enough for an owner holding the phone to veto, short enough to be useful
 *  for a genuinely lost one (nobody there to cancel). */
export const FIND_PING_CANCEL_SECONDS = 10

/** Minimum seconds between answers to one circle — anti-spam / battery. Still
 *  ample for watching a lost phone's pin move minute by minute. */
export const FIND_PING_MIN_GAP_SECONDS = 60

/**
 * Should THIS phone answer a "find my phone" request? Every gate must hold:
 * the owner pre-authorised this circle, the phone is currently flagged lost, and
 * the ping is aimed at me. Any missing gate → stay silent (no tell). The
 * rate-limit is checked separately (`withinPingRateLimit`) as it is clock-based.
 */
export function shouldAnswerFindPing(params: {
  preAuthorised: boolean
  iAmFlaggedLost: boolean
  targetedAtMe: boolean
}): boolean {
  return params.preAuthorised && params.iAmFlaggedLost && params.targetedAtMe
}

/** True if enough time has passed since the last answer to this circle. */
export function withinPingRateLimit(lastAnsweredAt: number | undefined, now: number, gapSeconds: number): boolean {
  if (lastAnsweredAt === undefined) return true
  return now - lastAnsweredAt >= gapSeconds
}
