# Record of processing activities

Last reviewed: 2026-07-10  
Status: **working one-person POC record - identity and provider details incomplete**

This working record covers the personal, free, non-commercial hosted preview.
There is no company or separate privacy team. The individual maintainer must
verify it against live infrastructure and maintain it under UK GDPR Article 30
and, as applicable, EU GDPR Article 30.

| Processing | People | Data | Purpose | Basis (provisional) | Recipients/providers | Location/transfers | Retention/deletion | Controls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Website and APK delivery | Visitors/downloaders | IP, timestamp, resource, user agent, TLS/network metadata | Deliver and secure service | Legitimate interests | Host/CDN/network provider | Host currently Germany; provider path to verify | App access log off; provider retention unknown | TLS, security headers, no analytics |
| Legal acknowledgement | App user | Policy version, adult flag, consenting-adults-only flag, timestamp | Enforce current entry boundary | Strictly necessary local control; confirm national ePrivacy rule | Device only | Device location | Until app/site storage cleared or uninstall | Not sent to operator; fail closed |
| Local identity and circles | App user/circle members | Keys, circle secret, member keys, names, settings | Provide encrypted circle functions | Role-dependent; device-side user request | Device, chosen signer | Device/signer location | Until circle/device reset, clear, or uninstall | Optional App lock, encrypted backup |
| Live location and messages | Users/circle members | Location, time, status, message, recipient/member identifiers | Deliver user-selected communication | Role-dependent; legitimate interests hypothesis | Intended recipients; selected relay | Recipients/relays anywhere | Device presence six hours on load; chat max 200/thread; relay expiry requested ~16 days | E2EE, off-by-default sharing, coarse default, pseudonymous keys |
| Relay routing | Connecting users | IP, timing, subscriptions, encrypted event envelope | Route encrypted communications | Legitimate interests | Relay host/network provider | Verify each operator | Event expiry requested ~16 days; connection logging must be verified | Payload encryption, relay choice, Tor/VPN option |
| Map tile proxy | Map users | IP at proxy, tile coordinates, request metadata | Deliver maps without direct upstream IP disclosure | Legitimate interests | Host/network; upstream OpenStreetMap service | Germany/upstream location to verify | No app access log; tile cache up to seven days | Header stripping, same-origin proxy |
| Geocoding/venue proxy | Search users | IP at proxy, search text/area, request metadata | Return user-requested place results | Legitimate interests | Host/network; upstream search service | Germany/upstream location to verify | No app access log; shared caching disabled | Header stripping, same-origin proxy |
| Offline extract | Download users | IP, chosen boundary, per-process salted IP hash, timestamps | Produce extract and rate-limit abuse | Legitimate interests | Host/network; map data services | Germany/upstream location to verify | Hash/times about ten minutes in memory; temp extract deleted after request | No boundary log, short-lived pseudonymisation |
| Optional public profile lookup | App user/public-key subject | Queried public key, requester connection metadata, public profile | Display optional Nostr profile | User choice; legitimate interests hypothesis | Selected public Nostr relays | Anywhere | Local cache until reset/clear; relay logs unknown | Off by default, clear explanation |
| Privacy, rights, legal, security, abuse reports | Requester, subject, alleged user, witnesses | Email/contact, allegation, evidence, identifiers, case actions | Respond, protect people/service, meet law, defend claims | Legitimate interests, legal obligation, legal claims | Email provider, advisers, authorities where lawful | Provider location unknown | Case-specific schedule required; delete when no longer necessary | Restricted access, minimisation, redaction, case log |
| Security incident handling | Users, reporters, attackers | Security events, affected identifiers, investigation evidence | Detect/respond, notify, defend | Legitimate interests and legal obligation | Host, advisers, authorities, affected people as required | Provider locations unknown | Incident schedule required | Need-to-know access, evidence integrity, breach clock |

## Missing Article 30 fields and decisions

- Controller's full legal name, address, establishment, and contact
- DPO or privacy lead and EU/UK representative details where required
- Named processors/subprocessors, contracts, role decisions, and locations
- International-transfer mechanism and supplementary measures per provider
- Exact provider security-log and backup retention
- Approved category-specific report/incident retention schedule
- Final lawful-basis and legitimate-interests assessment references
- Technical and organisational measures owner and audit evidence

The small-organisation exemption must not be assumed: the processing is not
merely occasional and location creates a risk to individuals.
