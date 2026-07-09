# flock legal and safety notices

Last updated: 2026-07-09

This is a practical legal-risk checklist for flock, not legal advice. Before a
public launch, paid offering, app-store submission, or high-risk deployment, have
counsel turn this into jurisdiction-specific terms, a privacy policy, and any
required consumer, child-safety, export, and data-protection disclosures.

## What Signal's public posture tells us

Signal's public source and legal pages are useful as a pattern, not text to copy.
The relevant buckets are:

- repo-level licence, copyright, warranty, and liability notices
- a cryptography/export-control notice
- user terms that say the service is provided as-is, may be unavailable, and is
  not an emergency-services provider
- privacy wording that distinguishes encrypted content from technical metadata
  needed to operate the service
- trademark guidance that separates use of open-source code from use of the
  Signal brand

Current flock position:

- flock is MIT licensed and currently does not import Signal client, server, or
  libsignal source code.
- If Signal source is copied or modified later, treat that as an AGPLv3 event:
  publish the corresponding source, preserve notices, provide attribution, and
  do not use Signal trademarks, logos, domains, or product names in a way that
  implies endorsement.
- References to Signal in docs or UI must be nominative only. Use plain
  comparisons such as "like a messenger app" where the brand is not needed.

Primary references checked:

- https://github.com/signalapp/Signal-Android/wiki
- https://signal.org/legal/
- https://signal.org/brand/
- https://signal.org/brand/trademarks/
- https://www.gnu.org/licenses/agpl-3.0.html
- UK/EU follow-up references checked:
  - https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/
  - https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-be-informed/
  - https://ico.org.uk/for-the-public/online/cookies/
  - https://www.gov.uk/guidance/child-online-safety-data-protection-and-privacy
  - https://www.gov.uk/government/publications/online-safety-act-explainer/online-safety-act-explainer
  - https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/guide-for-services
  - https://digital-strategy.ec.europa.eu/en/policies/digital-services-act
  - https://www.gov.uk/government/publications/unfair-contract-terms-cma37/unfair-contracts-what-do-businesses-need-to-know-short-guide

## User-facing notices that must exist

These belong in a public page, install flow, app settings, and any app-store
metadata.

### No emergency services

flock is not an emergency service, dispatch service, rescue service, medical
monitoring service, or law-enforcement channel. It does not contact police,
ambulance, fire, hospitals, or public-safety organisations. If someone is in
immediate danger, use a telephone or another emergency channel such as 112, 999,
911, or the local emergency number.

### Accuracy and availability

Location can be approximate, stale, unavailable, delayed, or wrong. Delivery can
fail because of battery settings, permissions, GPS availability, operating-system
background limits, mobile-network failure, Tor/VPN failure, relay outage, device
loss, or bugs. Notifications can arrive late or not at all. Users need a backup
safety plan.

### Consent and misuse

flock must not be used to track, harass, stalk, coerce, or monitor someone
without their consent or a lawful guardian basis. Adults should join voluntarily
and be able to leave. A parent or guardian deploying flock for a minor should
check local law and explain what is being shared in age-appropriate language.

### Privacy limits

flock minimises what the service can learn, but it is not anonymity magic.
Application payloads are encrypted, but network operators can still see metadata
such as IP address, timing, bandwidth, destination domain, and connection count
unless the user routes through Tor or a VPN. A self-hosted or hosted relay, tile
proxy, operating system, signer, browser, app store, and device backup provider
may each have their own visibility and policies.

The canonical technical explanation is `docs/PRIVACY.md`. The safe product line
from the relay-room work remains:

> flock minimises what the relay can learn and remember. It does not hide that
> you connected.

### Legal process and compelled builds

flock should not promise that legal process is impossible. The correct claim is
minimisation: there is no flock account and no plaintext location history on the
service side, so retrospective demands should have little useful data. Prospective
logging orders and compelled software changes are a different threat. The APK
verification and transparency work exists to make targeted backdoored builds
detectable, not impossible.

### Third-party services

Users and operators may interact with third-party services, including Nostr
relays, OpenStreetMap tile/geocoding/Overpass infrastructure, hosting providers,
Tor/Orbot, VPNs, Android, browser vendors, remote signers, and notification
systems. Their terms and privacy policies may apply.

### Open-source licence and no warranty

flock's source licence is MIT. The licence already includes an as-is warranty
disclaimer and limitation of liability for the software. The product notice should
repeat the practical meaning in user language: flock is provided as-is, without a
guarantee that it will be secure, available, accurate, uninterrupted, or fit for a
particular safety situation, to the maximum extent permitted by law.

UK/EU consumer-law caveat: do not imply that the MIT warranty disclaimer removes
non-excludable rights. In particular, avoid broad "we accept no liability for
anything" wording. Keep "to the maximum extent permitted by law" and do not try
to exclude liability for death or personal injury caused by negligence.

### Cryptography and export/import law

flock includes cryptographic software. Do not copy Signal's ECCN or export
classification onto flock unless an export reviewer confirms it. Users,
distributors, and operators are responsible for complying with applicable export,
import, sanctions, and local encryption laws. Do not distribute or use flock where
doing so would be unlawful.

### Trademark and affiliation

flock, ForgeSworn, and related project names should be presented as our marks.
Signal is a trademark of Signal Technology Foundation. flock is not affiliated
with, sponsored by, or endorsed by Signal. If a third-party mark is referenced,
use it only to identify that third-party product or protocol.

## UK/EU POC guardrails

For a proof of concept run from the UK/EU, the safer posture is to keep flock
clearly small, non-commercial, and adult/known-group oriented until counsel
reviews a real launch.

### Data protection / privacy notice

If we operate `flock.forgesworn.dev`, an APK download, tile/geocoding proxies,
or a default relay, we may handle personal data even when we do not have
accounts. IP addresses, timestamps, user-agent strings, tile/geocoding requests,
relay connection metadata, support emails, and APK download events can all be
personal data. The POC posture should be:

- no analytics, advertising pixels, fingerprinting, or non-essential cookies
- no app-level access logs; proxy/access logs off where we control them
- no account database and no server-side plaintext location history
- only strictly necessary local storage/service-worker storage in the browser
- a plain privacy notice that maps each processing activity to purpose and
  lawful basis before public launch
- if logs are enabled for debugging, keep them short-lived, documented, and
  scrubbed of room IDs plus IPs wherever possible

### Children and families

The highest UK/EU risk is marketing this as a child-tracking or family-monitoring
product while it is still a POC. UK ICO guidance treats children's location data
as high-risk, and UK children under 13 cannot consent to online-service data
processing themselves. Under EU GDPR Article 8, the digital-consent age is 16
unless a member state lowers it, never below 13.

Until there is a proper child-safety/privacy review:

- do not market the APK/PWA as a product for children
- do not tell parents to deploy it to minors as a standing tracker
- keep test groups adult or parent/guardian-supervised
- keep location sharing visibly under the device holder's control
- for any child-facing build, make geolocation off by default unless a documented
  best-interests reason justifies otherwise, show an obvious active-sharing
  indicator, and use child-readable wording

### Online safety / user-to-user scope

The UK Online Safety Act and EU Digital Services Act matter if flock becomes a
public user-to-user service, hosted relay-room platform, public directory, or
moderated community. For the POC:

- avoid public rooms, public feeds, public profiles, or searchable user content
- keep circles invite-only and encrypted
- avoid hosting a public relay-room marketplace until the online-safety/DSA
  duties are mapped
- if a public service launches later, add abuse reporting, contact, takedown, and
  risk-assessment processes appropriate to the actual service

### Commercial trigger points

Get a real UK/EU legal review before any of these:

- paid subscriptions, donations tied to service access, or business customers
- app-store listing or broad public APK promotion
- marketing to families, schools, carers, venues, festivals, or employers
- default hosted relay rooms for strangers
- collection of analytics, crash reports, support tickets, or payment data
- claims that flock is suitable for domestic-abuse, child-safety, medical,
  workplace, elder-care, or emergency-response use

## Public launch checklist

- Add and keep `/legal.html` available on the PWA and APK download host.
- Link the legal page from the app settings/You screen, install page, README, and
  any app-store or APK download page.
- Add a first-run acknowledgement if counsel recommends explicit acceptance
  before safety-critical use.
- Fill in the operating entity, contact address, privacy contact, governing law,
  dispute venue, age/minor policy, and consumer-rights carve-outs.
- Decide whether flock is a pure self-hosted software project, a hosted service,
  or both. The terms need to match that real deployment.
- Add a UK/EU privacy notice before a real launch, even if the answer is "we
  collect almost nothing".
- Generate and ship third-party notices for production bundles and APKs.
- Run an export-control review before broad international distribution.
- Keep privacy claims aligned with `docs/PRIVACY.md`; never say "anonymous by
  default", "surveillance-proof", "no trace", or "the relay cannot see your IP".
- Publish a law-enforcement/transparency page before marketing subpoena
  resistance as a user benefit.
- Keep APK reproducibility and transparency-log checks green before telling
  at-risk users to prefer APK over the web app.

## Dependency licence snapshot

Checked from `package-lock.json` on 2026-07-09:

- 647 installed packages
- Direct dependencies are MIT, BSD-3-Clause, Apache-2.0, OFL-1.1, or Unlicense.
- Lockfile licence families: MIT 441, ISC 86, Apache-2.0 38, BSD-2-Clause 21,
  BSD-3-Clause 15, BlueOak-1.0.0 13, MPL-2.0 12, plus smaller permissive sets.
- The only flagged copyleft-style family in the lockfile is MPL-2.0 through
  Lightning CSS tooling. MPL-2.0 is file-level copyleft and not the same risk as
  importing AGPL/GPL application code, but production notices should still
  include it.

This snapshot is operational evidence, not a substitute for generated
third-party notices.
