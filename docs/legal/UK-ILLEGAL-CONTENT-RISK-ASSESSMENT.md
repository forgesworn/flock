# UK illegal-content risk assessment

Assessment date: 2026-07-11
Status: **provisional - not an approved Ofcom assessment**  
Accountable person: **individual maintainer - legal identity to be completed**

This record assumes the hosted user-to-user location and fixed-signal service is
in scope under the Online Safety Act until UK counsel records a supported scope
decision. Removing free-form chat materially reduces the service's capacity to
create or transmit illegal content, but it does not by itself establish a scope
exit: users still share location, fixed requests/status actions, chosen names,
and invitations with other users. If the service is already in scope and
operating, obtain immediate advice on deadlines; this draft does not cure a
missed duty.

Flock is a one-person, free, non-commercial POC intended for a very small set of
invited adult testers. There is no corporate moderation team. Reach and
commercial incentives are therefore low; any applicable operation must use
simple, proportionate controls owned by the maintainer. One coercive or
child-location incident can nevertheless have severe impact.

## Service and evidence considered

- Encrypted fixed group actions (`Check in`, `On my way`) and fixed private
  actions (`Come to me`, `Where are you?`, `Call me`, `On my way`)
- Location beacons, alerts, invites, lost-phone reports with fixed context, and
  remote find requests
- No free-form chat, URLs, media, attachments, forwarding, or custom lost notes
- Open website and directly distributed Android app
- Invitation-secret circles with no central account directory
- Operator-controlled proxies and any operator-provided relay
- End-to-end encryption that prevents routine operator access to content
- No recommendation feed, public search, advertising, or engagement ranking
- Current threat model, Terms, Privacy Policy, report route, and product defaults

## Relevant illegal-use pathways

| Risk | How Flock could be used | Likelihood / impact | Existing controls | Remaining work |
| --- | --- | --- | --- | --- |
| Stalking and harassment | Coerced installation, repeated fixed location demands, unwanted signals, leaked invite | Medium / High | Adult/consent terms, sharing off, visible state, bounded action set, block by leaving/removing, report route | Coercion UX test, action-rate limits, operational report handling, safer rapid-exit review |
| Controlling or coercive behaviour and domestic abuse | Partner controls device/circle, monitors movement, punishes privacy choice | Medium / High | Own-device expectation, session-private default, app lock/decoy options, remote find off | Specialist review; test compromised PIN/device and separated-partner scenarios |
| Threats, violence, abduction, or trafficking | Location or a small fixed action set is used to find or coordinate around a target | Low-Medium / High | No user-authored content, E2EE recipient limits, coarse default, no-report zones, explicit ban, report/escalation route | Authority escalation criteria and operator restriction capability |
| Child sexual exploitation or abuse | Adult creates a circle with a child and requests or observes location; no user-authored sexual content can be sent through Flock | Low / Severe | 18+ gate, explicit child ban, private defaults, fixed actions, report route | Treat children as likely to access; complete children's risk assessment/duties |
| Fraud and impersonation | Malicious invite, false identity/name, deceptive safety request | Medium / Medium-High | Pseudonymous keys, invite secrets, roster notices, spoken verification tools | Clearer verification prompts and compromised-invite response |
| Terrorism or other priority illegal content | Location and a small fixed action set assist coordination; Flock cannot carry substantive user-authored propaganda or instructions | Low / Severe | Bounded vocabulary, small invitation groups, report route, lawful-request process | Formal threat escalation, competent-authority process, current Ofcom code mapping |
| Malicious code or service attacks | Invites, bounded names, or protocol payloads exploit parsing; relay/proxy abuse | Low-Medium / High | Strict action validation, arbitrary-text rejection, cryptographic verification, rate limiting, security contact | Periodic security review, vulnerability intake/SLA, abuse telemetry decision |

## Design and operation factors

### Risk-reducing

- No public content feed, discovery, virality, or recommendation algorithm
- No user-authored chat, URL sharing, media, attachments, forwarding, or custom
  lost-phone notes; unknown action codes and arbitrary legacy strings are rejected
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
- Encryption prevents routine inspection of location and signal traffic and can
  limit report evidence, although the human-readable action vocabulary is fixed
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
location or signal traffic. Flock has no general user-content moderation surface:
current clients accept only provider-defined actions and discard arbitrary legacy
text. A reporter may provide material voluntarily, but the reporting process must
not request secrets or unnecessary exact location.

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

Residual risk is **low for illegal-content publication/transmission through the
fixed action surface, medium overall, and high for the smaller set of
location-enabled stalking, coercive-control, and child-safety incidents**.
Removing free-form content reduces prevalence and attack surface; small encrypted
groups and bounded actions do not reduce the severity of one physical-location
disclosure.

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
