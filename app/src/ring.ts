/**
 * "Make it ring" — a lost phone plays an incoming targeted buzz as a loud alarm.
 *
 * The back-of-a-taxi case is a *minutes* problem: a phone the circle has flagged
 * lost should be findable by SOUND, not just as a pin on a map. This composes
 * two signals that already exist — a plain targeted `buzz` plus the `lost` flag —
 * with NO protocol change. The escalation is a receiver-side rendering decision,
 * exactly like whether an incoming buzz should vibrate: when a member buzzes a
 * phone their circle has flagged lost, that phone rings on the native alarm
 * channel (loud even on silent / Do Not Disturb) so whoever is near it hears it.
 *
 * Pure so it is unit-tested; app.ts wires it into the incoming-buzz handler and
 * the native shell (native/notify.ts) turns a `ring` into the alarm notification.
 *
 * Safe by construction: ringing is output only — it never discloses location or
 * changes what the device shares (the same ethos as the lost flag itself). A
 * decoy has no circle and no subscription, so it can never ring (no tell), and
 * only a circle member can send a decryptable targeted buzz to a phone they have
 * flagged lost.
 */

/** Should an incoming buzz be escalated to a loud "ring" on THIS device? */
export function shouldRing(params: { targetedAtMe: boolean; iAmFlaggedLost: boolean }): boolean {
  return params.targetedAtMe && params.iAmFlaggedLost
}

/**
 * A long, insistent vibration for a ring — deliberately far longer than a normal
 * buzz (~[200,100,200]) so the phone shakes hard enough to hear against a
 * surface even when its speaker is muted. Pattern is [vibrate, pause, …] ms.
 */
export const RING_VIBRATION: number[] = [600, 200, 600, 200, 600, 200, 600]

/** The buzz reason a "Make it ring" tap sends — recognisable on every screen. */
export const RING_REASON = '🔔 Ringing to find this phone'
