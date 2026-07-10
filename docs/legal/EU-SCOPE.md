# EU and EEA legal scope record

Last reviewed: 2026-07-10  
Status: **open - operator establishment and target markets unknown**

This record identifies decisions required before claiming EU compliance. It is
not legal advice and does not conclude that every framework below applies.

## 1. EU GDPR territorial scope

Record the final facts and apply EU GDPR Article 3:

| Question | If yes | Current fact |
| --- | --- | --- |
| Is the controller or relevant establishment in the EU/EEA? | EU GDPR applies to processing in the context of that establishment, regardless of where processing occurs. | Unknown |
| Does a non-EU controller offer services to people in the EU/EEA? | Article 3(2)(a) may apply. Mere website accessibility is not by itself enough; language, markets, users, distribution, and other targeting evidence matter. | Hosted site is accessible; targeting decision undocumented |
| Does a non-EU controller monitor behaviour taking place in the EU/EEA? | Article 3(2)(b) may apply. Assess operator purposes and means; do not assume encrypted location removes the question. | Role and purpose analysis incomplete |

If Article 3(2) applies and the controller lacks an EU establishment, Article 27
may require a written EU representative unless the narrow occasional/low-risk
exception genuinely applies. Regular location-related service processing should
not be labelled low risk without counsel. The representative's identity and
contact must then appear in the privacy notice.

**Launch blocker:** record the operator's establishment and intended countries,
then obtain and publish a representative if required.

## 2. EU GDPR operational requirements

The UK artefacts are a starting point, not a complete EU implementation:

- confirm controller/processor/joint-controller roles for every data flow;
- document Article 6 bases and Article 9 handling if sensitive inferences or
  special-category content are intentionally processed;
- complete the DPIA and Article 36 prior-consultation decision;
- maintain the Article 30 record;
- implement data-subject requests and local supervisory-authority complaints;
- put Article 28 terms in place with processors;
- document Chapter V transfers outside the EEA, including remote access;
- use data protection by design/default under Article 25; and
- implement breach assessment and the relevant 72-hour authority-notification
  path under Articles 33 and 34.

The public policy must identify the competent EU controller/representative and
relevant authority once the facts are known. A UK-only ICO link is insufficient
for an EU-targeted service.

## 3. Children and national consent ages

Flock is contractually 18+ and does not rely on a child's consent. If that ever
changes, Article 8's default age of 16 for consent-based information-society
services can be lowered by Member State law to no lower than 13. That rule only
addresses consent as a lawful basis; it does not settle best interests, fairness,
transparency, necessity, parental authority, or other national law.

The current adult self-declaration is not high-assurance age verification. If
children are likely to access the service, apply child-protective defaults and
complete the relevant EU and national child-safety analysis rather than relying
only on terms.

## 4. Digital Services Act

The DSA regulates intermediary services that are information-society services,
which uses an economic-service concept normally provided for remuneration. The
confirmed facts - one individual, no company, no charge, no advertising, and no
commercial customer - point away from that threshold for the present personal
POC. Indirect remuneration, business promotion, tied donations, paid
development, or organisational involvement could change the answer. Record the
facts and obtain advice rather than treating either "free" or "POC" as a
standalone exemption.

Flock transmits and may store user-provided encrypted communications. The final
operator must obtain a written classification of each hosted component under
the Digital Services Act: mere conduit, caching, hosting, online platform, or
outside a category. Private or invitation-only communication and the definition
of dissemination to the public can affect whether a component is an "online
platform"; do not assume the answer from the presence of messaging alone.

If any intermediary-service duties apply, map at least:

- single points of contact and, for a non-EU provider offering services in the
  EU, any required legal representative;
- clear terms and restriction information;
- orders and notices handling;
- transparency reporting and statement-of-reasons obligations where applicable;
- notice/action and internal complaint handling if the component is a hosting
  service or online platform; and
- protection of minors obligations if it is an online platform accessible to
  minors.

The public misuse email is a safety channel. It is not asserted to satisfy every
formal DSA notice-and-action requirement.

## 5. Electronic communications and device storage

Assess the European Electronic Communications Code classification of hosted
real-time/group messaging, including whether it is a number-independent
interpersonal communications service and whether the service is "normally
provided for remuneration" directly or through another economic model. The
present personal, non-commercial facts point away from the economic-service
threshold, but a free interface can still be remunerated indirectly. Preserve
the facts and reassess if funding, commercial promotion, paid work, or an
organisation becomes involved.

For ePrivacy rules, map each cookie, local-storage key, service worker cache,
notification token, and device permission. The adult acknowledgement is designed
as strictly necessary local storage for the requested gated service, but each
target country's implementation must be checked. Do not add analytics or other
non-essential storage without a lawful consent design.

## 6. Consumer and accessibility law

If the maintainer acts as a trader or offers Flock to EU consumers as part of an
economic activity, review at least:

- Consumer Rights Directive information requirements and withdrawal/digital
  content rules, including the effect of a genuinely free service;
- Unfair Contract Terms Directive and national consumer law;
- applicable product-safety/cybersecurity rules for the distribution model;
- European Accessibility Act scope and national implementation; and
- governing-law terms that preserve mandatory local consumer protections.

The current Terms preserve mandatory local rights but cannot replace the
country and business-model analysis.

## 7. Decision register

| Decision | Owner | Due | Status |
| --- | --- | --- | --- |
| Operator identity and establishment | Unassigned | Before deployment | Open |
| Intended EU/EEA countries and targeting evidence | Unassigned | Before deployment | Open |
| Article 27 representative | Counsel | After Article 3 decision | Open |
| Supervisory authority and notice contacts | Privacy lead | Before EU offering | Open |
| DSA component classification | EU counsel | Before EU offering | Open |
| EECC/ePrivacy country analysis | EU counsel | Before EU offering | Open |
| EU processors and Chapter V transfers | Privacy lead | Before EU offering | Open |
| EU consumer/accessibility review | EU counsel | Before EU offering | Open |

## Primary sources

- EU GDPR: https://eur-lex.europa.eu/eli/reg/2016/679/oj
- Digital Services Act: https://eur-lex.europa.eu/eli/reg/2022/2065/oj
- European Electronic Communications Code: https://eur-lex.europa.eu/eli/dir/2018/1972/oj
- ePrivacy Directive: https://eur-lex.europa.eu/eli/dir/2002/58/oj
