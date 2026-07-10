# Incident, report, and rights-request runbook

Last reviewed: 2026-07-10  
Status: **one-person POC procedure drafted; inboxes not assigned or tested**

This runbook is not operational until each named role and contact route is
configured, tested, and covered during the periods the service promises.

Flock has no company or corporate team. The individual maintainer may hold all
operational roles below. Separate job titles are a checklist of responsibilities,
not a requirement to invent staff. The minimum viable operation is one named
owner, a truthful response commitment, a secure case log, and a documented
backup/escalation route for periods when that person is unavailable.

## Required ownership

| Role | Responsibility | Assigned person/contact |
| --- | --- | --- |
| Incident lead | Coordinates security, safety, and data-breach response | Unassigned |
| Privacy lead/DPO contact | Rights requests, DPIA, regulator contact, breach decision | Unassigned |
| Online safety lead | Illegal-content and child-safety reports, Ofcom records | Unassigned |
| Technical lead | Containment, evidence, fixes, infrastructure restrictions | Unassigned |
| Legal adviser | Privilege, authority requests, notification, urgent injunctions | Not retained |
| Inbox owner | Tests and monitors `legal@`, `privacy@`, and `abuse@` | Unassigned |

## Intake rules

- Immediate danger: direct the reporter to emergency services or police first.
- Never request a private key, circle seed, backup code, PIN, password, or exact
  current location.
- Collect the minimum facts needed: service/component, approximate time, nature
  of concern, safe public identifiers, affected people, and contact preference.
- Do not promise decryption, deletion from recipients/independent relays, a
  particular outcome, or confidentiality that law cannot support.
- Separate allegation from verified fact in every case note.
- Restrict case access to people with a need to know.

## Triage

| Priority | Examples | Initial action |
| --- | --- | --- |
| P0 critical | Credible immediate threat to life/child, active exploitation, signing-key compromise, large ongoing sensitive-data exposure | Escalate immediately; preserve minimum evidence; contain; contact counsel/authority as appropriate |
| P1 high | Stalking/coercive-control report, child location use, exploitable security defect, likely reportable personal-data breach | Same working day escalation and legal/privacy assessment |
| P2 standard | Rights request, non-immediate misuse, accountless enforcement request, privacy complaint | Acknowledge and enter statutory/declared response clock |
| P3 information | General question or unsupported low-risk report | Route, respond, and close with reason |

Do not publish service levels until staffing can actually meet them.

## Security and personal-data incident process

1. **Identify and timestamp.** Record when the operator first became aware, who
   reported it, affected systems/data/people, and confidence level.
2. **Contain safely.** Stop affected deploys, revoke exposed credentials, isolate
   a proxy/relay, or restrict operator-controlled access without destroying
   evidence or broadening collection.
3. **Preserve minimally.** Hash and access-control relevant artefacts; record
   provenance and each access. Do not start broad logging "just in case".
4. **Assess.** Determine confidentiality, integrity, availability, scale,
   identifiability, vulnerable people, location sensitivity, and likely harm.
5. **Breach decision.** Privacy lead/counsel records whether it is a personal-data
   breach, relevant controller/processor, authority, notification threshold, and
   time remaining. UK/EU controller notifications may have a 72-hour clock from
   awareness; processors notify controllers without undue delay.
6. **Notify where required.** Give regulators and affected people accurate,
   staged information; do not delay an initial required notice for perfect facts.
7. **Recover and verify.** Patch, rotate, deploy, test, monitor proportionately,
   and remove temporary access/logging.
8. **Review.** Record cause, impact, decisions, lessons, DPIA/ROPA/risk-assessment
   changes, and owners/dates for follow-up.

## Misuse and safeguarding report process

1. Check immediate danger and child involvement.
2. Determine whether operator-controlled infrastructure or a self-hosted service
   is involved; explain jurisdiction and technical limits.
3. Preserve only information relevant to a credible concern.
4. Consider proportionate relay/proxy/download restrictions, security fixes,
   victim-safety information, or referral to competent authorities.
5. Give the reporter a case reference and a safe contact method where possible.
6. Record outcome and reasons, including no-action decisions.
7. Offer review/complaint route and feed anonymised themes into risk assessments.

Do not contact an alleged abuser in a way that could expose the reporter or
increase danger without a safety plan and appropriate advice.

## Data-subject rights process

1. Date-stamp receipt and identify applicable UK/EU law and deadline (normally
   one month, subject to lawful extension/variation).
2. Clarify the request and identify the controller/component without collecting
   more identity data than proportionate.
3. Explain early where Flock has no account and cannot identify or decrypt data
   held only on devices or independent relays.
4. Search only systems reasonably likely to contain responsive operator-held
   data: support/report cases, security records, short-lived service state, and
   provider records within the operator's control.
5. Apply exemptions narrowly with reasons and counsel where needed.
6. Respond securely, intelligibly, and with complaint/authority information.
7. Record request, searches, decision, disclosures, deletion/restriction, and
   closure without retaining unnecessary identity documents.

## Authority and regulator requests

- Verify sender, authority, legal basis, scope, jurisdiction, and deadline.
- Preserve the request and decision; involve counsel.
- Disclose only data actually held and lawfully required.
- Do not claim encrypted content can be produced when it cannot.
- Distinguish retrospective records from a prospective logging or software-change
  demand and escalate the latter for separate technical, legal, and human-rights
  analysis.
- Never silently weaken all users' security to answer an individual request.
- Apply lawful transparency/notification unless prohibited.

## Case retention

Adopt a schedule before operation. Retention must be purpose-specific rather
than "keep everything": short for unsupported queries, long enough for active
incidents/appeals and limitation periods where justified, and reviewed holds for
litigation or authority requests. Record deletion and remove temporary copies.

## Operational test before launch

- Send and receive test mail through all three public aliases.
- Verify SPF, DKIM, DMARC, forwarding, backups, MFA, and restricted access.
- Run one tabletop each for child tracking, coercive partner, relay compromise,
  location leak, signing-key compromise, rights request, and regulator request.
- Confirm the 72-hour breach clock can be escalated during weekends/holidays.
- Test infrastructure restriction and reversal without relying on readable
  encrypted content.
- Review all public promises against actual staffing and provider capability.
