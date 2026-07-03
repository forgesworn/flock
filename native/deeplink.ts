// Deep-link bridge (Capacitor shell).
//
// A verified App Link (https://flock.forgesworn.dev/#join=… — the intent
// filter lives in native/patch-android.mjs, the site's assetlinks.json in
// app/public/.well-known) arrives as an Android INTENT, not a WebView
// navigation: the WebView stays on its own origin and never sees the URL.
// Re-inject just the fragment; the app's existing hashchange consumer does
// the rest — join/invite handling and scrubbing the secret straight away.

import { App } from '@capacitor/app'

// Only the two fragments the app knows how to consume — anything else in a
// link (paths, other fragments) is ignored rather than injected.
const FRAGMENT = /#(?:join|invite)=.+$/

function apply(url: string | undefined): void {
  const m = url?.match(FRAGMENT)
  if (m) location.hash = m[0]
}

/** Listen for links opening the running app, and consume the link that
 *  cold-started it (fired before the WebView could listen). Re-applying the
 *  same fragment twice is harmless — joining an already-joined circle just
 *  switches to it. */
export async function watchDeepLinks(): Promise<void> {
  await App.addListener('appUrlOpen', (e) => apply(e.url))
  apply((await App.getLaunchUrl())?.url)
}
