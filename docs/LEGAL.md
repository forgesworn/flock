# flock legal and safety notices

Last updated: 2026-07-11

This is a practical legal-risk checklist for flock, not legal advice. Before a
public launch, paid offering, app-store submission, or high-risk deployment, have
counsel turn this into jurisdiction-specific terms, a privacy policy, and any
required consumer, child-safety, export, and data-protection disclosures.

## Current public posture

Flock is currently a personal, free, non-commercial proof of concept published
by one individual for invited adults; there is no company operating it. The
hosted preview is explicitly **18+**. It must not be used to install, configure,
or operate flock on a child's device or to obtain or share a child's location,
even by a parent or guardian. This is an interim risk boundary, not a claim that
age wording alone discharges UK child-safety duties.

The operative public pages are:

- `app/public/terms.html` — hosted-service terms and acceptable-use rules
- `app/public/privacy.html` — UK-oriented privacy information mapped to real data flows
- `app/public/legal.html` — short, prominent safety and age notices
- `app/public/report.html` — illegal-use, safeguarding, privacy, and review route

The product now enforces the boundary before normal startup: both adult-use
confirmations are required and recorded locally against a versioned notice.
Location sharing starts off on every launch, new circles start at neighbourhood
detail, and remote exact lost-phone permission starts off per circle. Once an
adult deliberately starts Android sharing, the foreground service/native
publisher remains a hard requirement so it continues while locked and in Doze.
These are privacy defaults, not a claim of highly effective age assurance.

The coordination surface is now deliberately bounded: circle actions are
`Check in` and `On my way`; private actions are `Come to me`, `Where are you?`,
`Call me`, and `On my way`. There is no free-form chat, URL or media attachment,
forwarding, or custom lost-phone note. This materially reduces illegal-content
and parsing pathways. It does not eliminate location-enabled stalking/coercion
risk or, without a supported scope decision, establish an Online Safety Act or
Digital Services Act exemption.

The one-person POC facts and reassessment triggers are in
`docs/legal/POC-POSTURE.md`. Remaining work that policy text cannot solve is
tracked in `docs/legal/UK-LEGAL-READINESS.md`. Supporting records are in
`docs/legal/DPIA.md`, `docs/legal/ROPA.md`,
`docs/legal/UK-CHILDRENS-ACCESS-ASSESSMENT.md`,
`docs/legal/UK-ILLEGAL-CONTENT-RISK-ASSESSMENT.md`, and
`docs/legal/EU-SCOPE.md`. In particular, the operator's legal identity,
monitored contact channels, applicable address requirements, scope decisions,
and accountable approvals remain open. The pages must not be described as
counsel-approved or a guarantee of compliance.

## Notice design

Flock's public notices are written for Flock's own product and deployment. They
do not copy another service's wording, assume another service's legal status, or
borrow another project's licence, trademark, export, or privacy claims.

Primary references checked:

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
without their informed, freely given participation. Adults should control their
own device and be able to stop sharing or leave. The current hosted preview must
not be installed or operated on behalf of a minor, including by a parent or
guardian.

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

flock includes cryptographic software. Do not publish an ECCN or export
classification for flock unless an export reviewer confirms it. Users,
distributors, and operators are responsible for complying with applicable export,
import, sanctions, and local encryption laws. Do not distribute or use flock where
doing so would be unlawful.

### Trademark and affiliation

flock, ForgeSworn, and related project names should be presented as our marks.
Do not imply sponsorship, endorsement, or affiliation by a third party. If a
third-party mark is genuinely needed, use it only to identify that product or
protocol.

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
product. UK ICO guidance treats tracking children's location as high-risk. The
Children's Code applies to services likely to be accessed by children, not only
services that say they target children. If consent is the chosen lawful basis for
an information society service offered directly to a UK child, a child under 13
cannot provide that consent themselves; this is not a general permission for a
parent to impose location tracking.

Current rule:

- the hosted preview is 18+ only
- do not market the APK/PWA as a product for children or families with children
- do not install or configure it on a child's device, create an identity for a
  child, invite a child, or use it to process a child's location
- keep all test groups adult-only
- do not imply that parental responsibility by itself resolves the child's own
  privacy, best-interests, transparency, or data-rights position

A later child-facing release requires the separate gate in
`docs/legal/UK-LEGAL-READINESS.md`, including a DPIA, best-interests assessment,
age-appropriate design, age and parental-responsibility handling, child-readable
privacy information, and materially different location defaults.

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

- Keep `/legal.html`, `/terms.html`, `/privacy.html`, and `/report.html`
  available on the PWA and APK download host.
- Link Terms, Privacy, and safety notices from the app settings/You screen,
  onboarding, install page, README, and any app-store or APK download page.
- [x] Require the versioned adult-use and consenting-adults acknowledgement
  before normal startup. It is contract evidence, not age assurance.
- Fill in the operator's legal identity; confirm any applicable address
  requirement; configure and test the legal, privacy, and abuse email aliases.
  Do not deploy placeholders.
- Decide whether flock is a pure self-hosted software project, a hosted service,
  or both. The terms need to match that real deployment.
- Have UK counsel review the Terms and Privacy Policy before a real launch; the
  repo drafts are an engineering and factual baseline, not signed-off advice.
- Complete the ICO fee assessment, ROPA/LIA/DPIA work, and Online Safety Act
  scope, illegal-content, and children's-access assessments.
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
