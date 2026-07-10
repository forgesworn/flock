# UK illegal-content risk assessment

Assessment date: 2026-07-10  
Status: **provisional - not an approved Ofcom assessment**  
Accountable person: **individual maintainer - legal identity to be completed**

This record assumes the hosted group/direct messaging service is an in-scope
user-to-user service under the Online Safety Act until UK counsel records a
supported scope decision. If the service is already in scope and operating,
obtain immediate advice on deadlines; this draft does not cure a missed duty.

Flock is a one-person, free, non-commercial POC intended for a very small set of
invited adult testers. There is no corporate moderation team. Reach and
commercial incentives are therefore low; any applicable operation must use
simple, proportionate controls owned by the maintainer. One coercive or
child-location incident can nevertheless have severe impact.

## Service and evidence considered

- Encrypted group messages, direct messages, location beacons, alerts, invites,
  lost-phone reports, and remote find requests
- Open website and directly distributed Android app
- Invitation-secret circles with no central account directory
- Operator-controlled proxies and any operator-provided relay
- End-to-end encryption that prevents routine operator access to content
- No recommendation feed, public search, advertising, or engagement ranking
- Current threat model, Terms, Privacy Policy, report route, and product defaults

## Relevant illegal-use pathways

| Risk | How Flock could be used | Likelihood / impact | Existing controls | Remaining work |
| --- | --- | --- | --- | --- |
| Stalking and harassment | Coerced installation, repeated location demands, unwanted messages, leaked invite | Medium / High | Adult/consent terms, sharing off, visible state, block by leaving/removing, report route | Coercion UX test, operational report handling, safer rapid-exit review |
| Controlling or coercive behaviour and domestic abuse | Partner controls device/circle, monitors movement, punishes privacy choice | Medium / High | Own-device expectation, session-private default, app lock/decoy options, remote find off | Specialist review; test compromised PIN/device and separated-partner scenarios |
| Threats, violence, abduction, or trafficking | Location used to find a target; messages coordinate harm | Low-Medium / High | E2EE recipient limits, coarse default, no-report zones, explicit ban, report/escalation route | Authority escalation criteria and operator restriction capability |
| Child sexual exploitation or abuse | Adult creates a circle with a child, requests location/messages, sends illegal content | Low-Medium / Severe | 18+ gate, explicit child ban, private defaults, report route | Treat children as likely to access; complete children's risk assessment/duties |
| Fraud and impersonation | Malicious invite, false identity/name, deceptive safety request | Medium / Medium-High | Pseudonymous keys, invite secrets, roster notices, spoken verification tools | Clearer verification prompts and compromised-invite response |
| Terrorism or other priority illegal content | Encrypted group/direct communications coordinate an offence | Low / Severe | Small invitation groups, report route, lawful-request process | Formal threat escalation, competent-authority process, current Ofcom code mapping |
| Malicious code or service attacks | Messages/invites exploit parsing; relay/proxy abuse | Medium / High | Input validation, cryptographic verification, rate limiting, security contact | Periodic security review, vulnerability intake/SLA, abuse telemetry decision |

## Design and operation factors

### Risk-reducing

- No public content feed, discovery, virality, or recommendation algorithm
- No monetisation based on attention or growth
- Invitation-secret groups and pseudonymous keys
- Payloads encrypted to intended recipients
- Location private on launch and neighbourhood-level by default
- No central readable location/message history
- Public rules against child tracking, stalking, coercion, and unlawful use

### Risk-increasing

- Location can create immediate physical harm even in a small private group
- Android background mode can continue a deliberately started sharing session
- An unsafe adult with device control can defeat in-app autonomy controls
- Invitation secrets can be forwarded or exposed
- Pseudonymity and no accounts reduce operator-level enforcement options
- Encryption prevents proactive content inspection and can limit report evidence
- Direct APK/web distribution makes contractual age restriction easy to bypass
- Operator currently lacks assigned people, tested inboxes, case operations, and
  a supported legal scope decision

## Safety measures and encryption boundary

Flock will not claim that client-side scanning or weakening end-to-end
encryption is necessary or proportionate. Risk reduction should focus on product
defaults, user agency, rate limits, invitation/member security, metadata-minimal
reporting, victim support, infrastructure restrictions, security fixes, and
lawful response using data the operator actually holds.

The operator must be honest that it normally cannot read or search encrypted
content. A reporter may provide material voluntarily, but the reporting process
must not request secrets or unnecessary exact location.

## Reporting, complaints, and enforcement

Implemented surface: `app/public/report.html` and the adult-use/acceptable-use
Terms. Operational prerequisites remain:

1. Configure and monitor the abuse, privacy, and legal inboxes.
2. Assign the maintainer as owner and document realistic unavailability and
   emergency-escalation handling; do not promise continuous staffing.
3. Log reports, outcomes, restrictions, complaints, and appeals with minimum
   necessary personal data.
4. Publish the information and response routes the applicable Ofcom codes and
   Act require.
5. Maintain a lawful-request and regulator-information process.
6. Define technically feasible restrictions for operator-controlled relay,
   proxy, download, or host access, with review and appeal.
7. Feed report themes into this assessment and the children's assessment.

## Provisional residual risk and decision

Residual illegal-content risk is **medium overall and high for the smaller set
of location-enabled stalking, coercive-control, and child-safety incidents**.
Small encrypted groups reduce prevalence and reach but not the severity of a
single physical-location disclosure.

**Not approved for a claim of Online Safety Act compliance.** Before broader
operation, counsel must confirm scope and the accountable operator must complete
Ofcom's required assessment format, risk-profile evidence, safety measures,
records, terms information, reporting/complaints duties, and review cadence.

## Review triggers

- material feature or default change;
- credible illegal-use or safeguarding report;
- evidence of child users;
- new relay, host, distribution, or moderation arrangement;
- expansion in user numbers, countries, or marketing;
- relevant Ofcom risk profile/code/guidance change; or
- at the statutory interval even if nothing changes.

## Primary sources

- Ofcom, illegal-content duties:
  https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/illegal-content-duties-under-the-online-safety-act
- Ofcom, risk assessment guidance and register:
  https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/risk-assessment
- Online Safety Act 2023:
  https://www.legislation.gov.uk/ukpga/2023/50/contents
