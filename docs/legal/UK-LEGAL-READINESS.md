# UK legal readiness: operator checklist

Last updated: 2026-07-10

This is an engineering and operations checklist, not legal advice. The public
Terms and Privacy Policy accurately describe the checked-in product as of this
date, but documents cannot make an unsafe data flow lawful or replace a UK
solicitor's review.

## Current decision

Flock is currently a personal, free, non-commercial proof of concept published
by one individual for invited adult testers. There is no company operating it.
The hosted preview is **18+ only** and is not offered for child tracking,
parent-over-child monitoring, schools, carers, workplaces, medical monitoring,
or emergency response. The facts, proportionality, and reassessment triggers
for that position are recorded in `docs/legal/POC-POSTURE.md`.

Do not weaken that line to “13+”, “with parental permission”, or
“parent/guardian-supervised”. Signal's 13+ term is not a safe analogue for a
product whose core feature is persistent geolocation. The ICO treats child
geolocation as particularly sensitive and expects child-facing location sharing
to be off by default, obvious while active, and normally reset to off after each
session.

## Blockers before treating the open POC as legally complete

- [x] Record the operator type: one individual acting personally, not a company.
- [ ] Replace “the individual maintainer publishing as TheCryptoDonkey” with the
  operator's full legal name.
- [ ] Confirm with counsel whether any applicable regime requires a geographic,
  correspondence, or service address on these facts. Do not publish a home
  address merely by assumption; use a legitimate alternative if one is required.
- [ ] Configure and test `legal@forgesworn.dev`, `privacy@forgesworn.dev`, and
  `abuse@forgesworn.dev`. Assign an owner and response routine for each inbox.
- [ ] Have UK counsel review `app/public/terms.html`,
  `app/public/privacy.html`, `app/public/legal.html`, and
  `app/public/report.html` against the actual operator, funding model, host,
  relay topology, and intended countries.
- [x] Add a first-use acknowledgement of the current Terms/adult-use boundary.
  The version, confirmations, and timestamp are stored locally and fail closed
  if storage is unavailable. This is contract evidence, not age assurance or
  GDPR consent.
- [ ] Decide how future material updates are presented, versioned, and
  re-acknowledged.

Do not present the draft pages as counsel-approved or a guarantee of compliance
while the applicable identity, contact, or address items above are unresolved.

## UK GDPR and Data Protection Act 2018

- [x] Draft the controller/processor map and processing inventory in
  `docs/legal/ROPA.md`.
- [ ] Validate the map against the final operator, live providers, contracts,
  and actual decision-making roles.
- [ ] Confirm and document the Article 6 basis for every processing purpose.
  The draft policy uses legitimate interests for service delivery/security and
  legal obligation or legal-claims interests where relevant; complete an LIA
  rather than relying on the label alone.
- [x] Create a draft record of processing activities in `docs/legal/ROPA.md`.
  The small-organisation exemption is not assumed because processing is regular
  and location creates risk.
- [x] Draft a DPIA covering live/background geolocation, recipient visibility,
  loss/theft, coercive control, children, inaccurate safety signals, and network
  metadata in `docs/legal/DPIA.md`.
- [ ] Assign the DPIA owner, complete consultation and LIAs, reduce high residual
  risks, and obtain controller/counsel approval before broader use.
- [ ] Run the ICO data-protection-fee self-assessment and record the result.
  Non-profit status may affect the fee but does not remove UK GDPR duties.
- [ ] Put written terms/data-processing arrangements in place with processors
  and document whether each relay/provider is a processor, joint controller, or
  independent controller.
- [ ] Document UK international-transfer positions for Germany/EEA hosting and
  any non-UK relay, support, monitoring, VPN, or other provider. Do not call
  user selection a transfer safeguard.
- [ ] Implement rights-request identity checks, response logging, erasure
  guidance, objection handling, complaint escalation, and the explanation for
  data the operator cannot identify or decrypt.
- [ ] Create an incident and personal-data-breach procedure, including the
  72-hour ICO decision path and a contact tree.
- [ ] Recheck actual host/provider telemetry. “Caddy access logs off” does not
  prove the infrastructure provider has no metadata or security logs.

## Online Safety Act

Flock includes group and private messaging and operates or selects relay
infrastructure. Do not assume encryption, invitation-only circles, no accounts,
or a free preview takes the service outside the Act.

Ofcom expressly describes small, part-time, and voluntary services as capable
of falling within the regime, while applying a risk-based and proportionate
approach. For this one-person POC, required controls can be simple and assigned
to the maintainer; small scale affects proportionality, not the scope test or
the impact of a serious location misuse incident.

- [ ] Run Ofcom's regulation checker with counsel and record the scope decision.
- [x] Draft a conservative illegal-content risk assessment in
  `docs/legal/UK-ILLEGAL-CONTENT-RISK-ASSESSMENT.md`.
- [ ] Have the accountable person and counsel complete/approve the required
  Ofcom assessment and confirm any already-running-service deadlines.
- [x] Draft and retain a children's access assessment in
  `docs/legal/UK-CHILDRENS-ACCESS-ASSESSMENT.md`. It provisionally concludes
  children are likely to access because there is no highly effective age
  assurance and parent-to-child use is foreseeable.
- [ ] Complete the consequent children's risk assessment and applicable safety
  duties, or implement highly effective age assurance plus access controls.
- [x] Publish an accessible misuse/safeguarding route and review path at
  `app/public/report.html`.
- [ ] Configure the inboxes and implement the case/complaints operation. An email
  route alone may not satisfy every final-service duty.
- [ ] Map proportionate controls for priority offences relevant to private
  location/messaging: stalking, harassment, coercive control, threats, child
  sexual exploitation, trafficking, fraud, and terrorism.
- [ ] Explain the applicable protections and enforcement approach in the Terms
  without claiming the operator can proactively read encrypted content.
- [ ] Assign responsibility, review dates, record keeping, and a process for
  regulator information requests.

## EU and EEA

- [x] Record the open EU territorial, representative, DSA, EECC/ePrivacy,
  consumer, and accessibility questions in `docs/legal/EU-SCOPE.md`.
- [ ] Record the operator's establishment and intended countries; assess EU GDPR
  Article 3 for establishment, offering, and monitoring.
- [ ] If Article 3(2) applies without an EU establishment, appoint and publish an
  Article 27 representative unless counsel confirms the exception with evidence.
- [ ] Add the competent EU controller/representative and supervisory-authority
  details to the Privacy Policy before an EU-targeted offering.
- [ ] Record the confirmed non-economic facts: no company, charge, advertising,
  customer, tied donation, paid development, or business promotion. These facts
  point away from regimes limited to economic services normally provided for
  remuneration, but indirect remuneration and later commercial activity must
  trigger reassessment.
- [ ] Classify each hosted component under the DSA and EECC; implement the duties
  that follow rather than treating private encryption as a blanket exemption.
- [ ] Document EEA processor terms and Chapter V transfers, including remote
  access and user-selected infrastructure where the operator determines it.
- [ ] Map local storage and permissions under ePrivacy rules in each intended
  country. Do not add non-essential storage or analytics without a valid design.

## Separate gate for any future child-facing release

Do not market to parents or permit child use until all items are complete:

- [ ] UK counsel confirms the controller, lawful bases, Children's Code scope,
  Online Safety Act duties, safeguarding duties, and contract position.
- [ ] Complete and approve a child-specific DPIA and documented best-interests
  assessment before processing starts. Consult the ICO first if high residual
  risk cannot be reduced.
- [ ] Define supported age bands and implement proportionate age assurance. If
  relying on consent for a direct online service to a child under 13, make
  reasonable efforts to verify parental responsibility. Do not collect more
  identity data than that purpose needs.
- [ ] Provide concise child-readable privacy information at onboarding and at
  the moment location is used, plus an adult-facing layer.
- [x] Make geolocation and visibility to other people off by default.
- [x] Return visibility to off on each launch; automatic start-on-launch/create/
  join has been removed.
- [ ] Make the active-sharing indicator persistent and unmistakable, including
  while the app is backgrounded or the screen is locked.
- [x] Change lost-phone exact-location permission to a deliberate device-local
  per-circle opt-in; new and legacy missing values fail closed.
- [ ] Give a competent child meaningful control to stop sharing, leave, object,
  and exercise their own data rights. A parent's preference does not own the
  child's rights.
- [ ] Restrict who can invite, locate, or re-identify a child; address separated
  families, unsafe guardians, compromised invitation secrets, and coercive
  adults in the threat model.
- [ ] Test deletion, member removal, stale positions, screenshots/recipient
  retention, lost devices, account/key recovery, and safeguarding reports.
- [ ] Remove nudges towards precise or persistent sharing and test wording with
  children and safeguarding specialists.

## Facts the policies rely on

- No flock account, required phone number, or required email.
- End-to-end encrypted Nostr gift wraps for messages and location payloads.
- Location sharing starts off each launch; a new circle starts at neighbourhood
  detail and remote exact lost-phone response starts off.
- Once deliberately started in the Android app, sharing is designed to continue
  while locked/in Doze through a visible foreground service and native publisher.
- Readable state and chat history held on devices; main state is plaintext at
  rest unless App lock is enabled.
- Presence cache pruned after six hours on load; chat capped at 200 per thread.
- Canonical Caddy access logs disabled.
- Map/geocoding proxies strip client-identifying upstream headers.
- Offline extract IP rate-limit key is a per-process salted hash held about ten
  minutes; temporary extracts are deleted after each request.
- Relay event expiry is requested at about 16 days but cannot be guaranteed
  against a hostile or non-compliant relay.
- Hosting and network providers can still observe operational metadata.

Re-audit these facts before every material policy update or deployment.

## Primary sources checked

- Signal legal structure (pattern only): https://signal.org/legal/
- ICO, information a privacy notice must provide:
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-privacy-information-should-we-provide/
- ICO, children and the UK GDPR:
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/children-and-the-uk-gdpr/
- ICO Children's Code, geolocation:
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/10-geolocation/
- ICO, children's data and DPIAs:
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/2-data-protection-impact-assessments/
- Ofcom, illegal-content duties:
  https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/illegal-content-duties-under-the-online-safety-act
- Ofcom, children's access assessments:
  https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/childrens-access-assessment-duties-under-the-online-safety-act
- EU GDPR:
  https://eur-lex.europa.eu/eli/reg/2016/679/oj
- EU Digital Services Act:
  https://eur-lex.europa.eu/eli/reg/2022/2065/oj
- CMA, unfair contract terms:
  https://www.gov.uk/government/publications/unfair-contract-terms-cma37
- ICO, data-protection fee:
  https://ico.org.uk/for-organisations/data-protection-fee/
