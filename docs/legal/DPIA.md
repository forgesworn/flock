# Data protection impact assessment

Service: hosted Flock preview  
Assessment date: 2026-07-11
Status: **working one-person POC record - not approved for broader use**  
Owner: **individual maintainer - legal identity to be completed**

This DPIA is an engineering record, not legal advice. It must be reviewed and
signed by the final controller and counsel before broader operation. There is
no company or separate privacy team: the individual maintainer can own the
controller, product, security, and consultation actions, but must record each
decision rather than treating missing staff as completed review.

## 1. Why a DPIA is required

Flock enables repeated device geolocation and communication within groups. It
can run in the background on Android, reveal patterns of movement, be used in a
safety context, and be misused for stalking or coercive control. Children and
other vulnerable people may use or be subjected to the service despite the
adult-only restriction. The combination creates a likely high risk to rights
and freedoms even though application content is end-to-end encrypted.

## 2. Decision and scope

This assessment covers:

- hosted PWA and Android shell;
- operator-controlled website, APK delivery, map/geocoding proxies, and offline
  extract service;
- any operator-provided Nostr relay;
- local app processing selected by the product design; and
- legal, privacy, security, and abuse contacts.

It does not approve an independent relay or self-hosted deployment. Those
operators must assess their own processing.

## 3. Roles requiring confirmation

The final operator is expected to be controller for website delivery, proxy
design, support/report handling, security decisions, and its relationship with
operator-selected infrastructure. Whether it is controller, joint controller,
or processor for particular encrypted relay events depends on the real purposes,
means, contracts, and ability to influence processing; encryption alone does not
decide the role.

Circle members decide why and with whom they share readable location and fixed
coordination signals and may be separate controllers or household users. Hosts, relay
operators, email providers, and upstream map services require a documented role
and contract analysis.

No approval is possible until the operator's legal identity, establishment,
address, providers, and contracts are recorded.

## 4. Purposes and lawful-basis hypothesis

| Purpose | Data involved | Proposed basis | Required follow-up |
| --- | --- | --- | --- |
| Deliver website, APK, proxy responses, and encrypted relay traffic | IP, request/connection metadata, requested resource, ciphertext | Legitimate interests in providing the requested service | Complete LIA and provider role/contract review |
| Protect shared infrastructure | Short-lived salted IP hash, timestamps, security events | Legitimate interests in abuse prevention and security | Confirm minimisation, retention, and access |
| Deliver a user's selected location/fixed action to intended recipients | Device location or provider-defined action encrypted for recipients; delivery metadata | Role-dependent; user-requested service and legitimate interests are provisional | Counsel must map operator and participant roles; do not describe Terms acceptance as GDPR consent |
| Handle rights, abuse, safety, and legal requests | Reporter/contact details, allegations, evidence | Legitimate interests, legal obligation, and legal claims as applicable | Operational retention schedule and restricted case log |
| Record adult-use acknowledgement | Policy version, two confirmations, timestamp on device only | Necessary local product control; no operator receipt | Confirm ePrivacy/PECR strictly-necessary position by target country |

Special-category data is not intentionally requested. Location is not
automatically special-category data, but movement and use context may reveal health,
religion, politics, sex life, or other sensitive facts. Treat the system as able
to carry sensitive data and do not infer or profile it.

## 5. Data flow and lifecycle

1. The app creates or references a pseudonymous key on the device.
2. Circle secrets, readable fixed signals, location, and local history remain on the
   device except when a user deliberately sends encrypted data.
3. Location sharing starts off on each launch. A user turns it on and selects a
   detail level; neighbourhood is the initial default.
4. Nostr gift wraps carry encrypted payloads through selected relays. Relays can
   observe connection and envelope metadata but should not read the payload.
5. Intended recipients decrypt content on their devices and can retain or
   redistribute it.
6. Map/geocoding requests use same-origin proxies; proxy-visible requests may
   themselves reveal an area or search interest.
7. Local recent presence is pruned after six hours on load; signal logs are capped
   at 200 actions per thread. Encrypted relay events request expiry after about 16 days, but
   an independent or hostile relay may ignore expiry.
8. Reports and rights requests enter operator email and case handling rather
   than the encrypted app channel.

The detailed inventory is in `ROPA.md` and the public description is in
`app/public/privacy.html`.

## 6. Necessity and proportionality

### Measures implemented

- No Flock account, required phone number, or required email
- End-to-end encrypted application payloads
- No free-form chat, URLs, media, attachments, forwarding, or custom lost-phone
  notes; current clients accept only fixed action codes and exact compatibility labels
- Pseudonymous keys and rotating identifiers
- Location sharing off every launch
- Neighbourhood rather than exact location as the initial detail
- A deliberately started Android sharing session continues through lock and
  Doze via a visible location foreground service until the user stops it or a
  documented safety/permission teardown occurs
- Explicit step-up for exact and temporary high-detail features
- Remote exact lost-phone response off by default per circle, with a cancel
  window when a request arrives
- Visible in-app sharing state and native foreground notification while Android
  background location is active
- No advertising, analytics pixels, behavioural profiling, or non-essential
  cookies on the canonical site
- App-level access logs disabled on the canonical host
- Short-lived in-memory abuse limiter for offline map extracts
- App lock and encrypted backup options
- Adults-only contract, local acknowledgement, and public reporting route

### Measures still required

- Final controller identity, establishment, contacts, and provider contracts
- Legitimate-interests assessments for each purpose
- Verified host, relay, proxy, and email-provider telemetry and retention
- International-transfer assessment and safeguards where required
- Rights, incident, breach, report, and regulator-request case operations
- Effective Online Safety Act scope and risk assessments
- Child-access decision backed by evidence or effective access controls
- Security review of native background retention and relay expiry behaviour
- User testing of coercion, consent, and sharing indicators

## 7. Risk assessment

Scale: likelihood and severity are Low, Medium, or High. Residual ratings assume
the implemented measures above, not the outstanding measures.

| Risk | Inherent | Current controls | Residual | Further action |
| --- | --- | --- | --- | --- |
| Covert or coerced tracking by a partner, parent, or circle member | High/High | Adult rule, own-device model, sharing off, visible state, leave/remove, report route | Medium/High | Coercion UX testing, rapid safety exit review, operational reporting, counsel |
| Child location processed despite 18+ rule | High/High | Entry acknowledgement, prohibitions, private defaults | High/High | Treat as likely child access; complete children's duties or implement effective restriction |
| Exact location disclosed more broadly than intended | Medium/High | Neighbourhood default, explicit slider, encrypted recipients, no-report zones | Medium/High | Just-in-time exact-location warning and recipient confirmation review |
| Lost-phone exact request abused | Medium/High | Per-circle opt-in off, lost flag, targeted request, cancel window, rate limit | Low/High | Adversarial multi-member and compromised-device testing |
| Recipient copies, screenshots, or correlates location | High/High | Recipient warnings, circle controls, coarse settings | Medium/High | Stronger recipient/removal education; cannot technically prevent screenshots |
| Relay/network metadata identifies associations or routines | High/High | Encrypted wraps, timing blur, cover traffic, relay choice, VPN/Tor options | Medium/High | Provider audit, fail-closed routing review, retention assurance |
| Endpoint loss or compromise exposes keys/history | Medium/High | Optional App lock, encrypted backup, reset/remove, Android controls | Medium/High | Consider secure-by-default lock without creating recovery harm; native storage audit |
| Stale, wrong, or missing location causes unsafe reliance | Medium/High | Timestamps, status, no-emergency warning, accuracy notice | Medium/High | Failure-mode tests and prominent stale-state handling |
| Invite secret leaks and unauthorised member joins | Medium/High | Secret invites, encrypted remote invite, roster notice, remove/reseed | Medium/High | Invite expiry/one-time semantics review and clearer compromise action |
| Proxy search or tile requests reveal sensitive place | Medium/Medium | Same-origin proxy, no app access log, upstream header stripping | Low/Medium | Verify provider logs/cache keys and document retention contractually |
| Rights request cannot be linked to pseudonymous data | Medium/Medium | Honest notice; device-side controls | Low/Medium | Case script explaining limits without over-identifying requester |
| Malicious or compelled build changes data behaviour | Low/High | Open source, build attestation/verification work | Medium/High | Reproducible release governance, signing-key controls, transparency response plan |

## 8. Rights and freedoms considered

- Privacy, autonomy, association, movement, expression, and family life
- Physical safety and protection from stalking, coercion, and abuse
- A child's best interests and ability to understand and control monitoring
- Non-discrimination where location patterns reveal protected traits
- Access, objection, erasure, restriction, and complaint rights
- Consumer expectations about accuracy, availability, and safety claims

The service may provide safety and autonomy benefits to consenting adults, but
those benefits do not justify automatic or child-directed tracking.

## 9. Consultation

Completed: internal engineering/data-flow review and regulator-guidance review.

Required before approval:

- final controller and operational owner;
- UK and relevant EU counsel;
- domestic-abuse/coercive-control specialist;
- data-protection and child-safety specialist if child access remains likely;
- representative adult users, including people at elevated stalking risk; and
- key infrastructure providers where logs, deletion, and roles are unclear.

Do not consult children by exposing them to a live high-risk preview. Any future
child research needs an ethically designed, specialist-led protocol.

## 10. Outcome

**Not approved.** Current privacy defaults materially reduce risk, but residual
risk from foreseeable child access, coercive tracking, undefined operator roles,
and incomplete operations remains high. If those risks cannot be reduced, the
controller must consult the ICO before starting the high-risk processing where
Article 36 requires it.

## 11. Sign-off

- Controller/DPO or privacy lead: **not assigned / not signed**
- Security lead: **not assigned / not signed**
- Product owner: **not signed**
- Counsel: **not reviewed**
- Next review: **before public deployment or material change**

## Primary sources

- ICO, DPIAs: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/
- ICO, children's data and DPIAs: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/2-data-protection-impact-assessments/
- UK GDPR Article 25, data protection by design and default: https://www.legislation.gov.uk/eur/2016/679/article/25
- ICO, geolocation: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/10-geolocation/
