# UK children's access assessment

Assessment date: 2026-07-11
Owner: **unassigned - launch blocker**  
Review due: before public deployment, then at least annually and after any
material product, audience, evidence, or access-control change

This is a provisional internal assessment for the hosted Flock preview. It is
not an Ofcom submission and must be validated against the final operator and
service scope by UK counsel.

Flock is a free, non-commercial POC run by one individual for invited adult
testers. Its likely reach is very small, but the website and APK are technically
open and the entry check is only a self-declaration. Small scale is relevant to
proportionate measures and aggregate likelihood; it does not prevent access or
remove the impact of one child-location disclosure.

## Service assessed

- Hosted PWA at `flock.forgesworn.dev`
- Downloadable Android shell for the same hosted service
- Operator-controlled web proxies and any operator-provided relay
- User-to-user fixed group/private coordination actions plus encrypted location
  sharing; no free-form chat, links, media, attachments, or forwarding

Independent self-hosted deployments are separate services operated by their
deployers. The source-code repository by itself is not treated as the hosted
service.

## Scope assumption

For safety, this record assumes the hosted location and fixed-signal service is an in-scope
user-to-user service under Part 3 of the Online Safety Act until counsel records
a supported contrary conclusion. Invitation-only circles, end-to-end encryption,
no accounts, and a free preview do not by themselves resolve scope.

## Stage 1: can children normally access?

**Answer: yes.**

The entry gate requires users to confirm they are 18 or older and will use Flock
only with consenting adults. That is a contractual restriction and local
self-declaration. It is not highly effective age assurance and does not prevent
a child or an adult acting for a child from continuing.

Ofcom states that general contractual restrictions on child use are not capable
of being highly effective age assurance. Without highly effective age assurance
and access controls, the assessment must proceed to stage 2.

## Stage 2: is the child user condition met?

### Evidence considered

| Factor | Evidence | Direction |
| --- | --- | --- |
| Core functionality | Live and background location sharing, fixed private/group actions, lost-phone finding, and safety-oriented alerts can appeal to families and teenagers. Removing free-form chat reduces content risk, not likely access. | Towards likely access |
| Operator knowledge | The product discussion expressly anticipates parents installing the app and giving it to children. | Strongly towards likely access |
| Access friction | No account, payment, identity check, or high-assurance age check is required. | Towards likely access |
| Marketing boundary | Current public copy says adults 18+ and prohibits child tracking; package and download copy are adult-only. | Away from likely access, but not conclusive |
| Product defaults | Sharing is off each launch, neighbourhood is the default detail, and remote exact find is off. | Reduces harm if access occurs; does not prevent access |
| Distribution | Direct APK and open website can be used without an app-store family-age gate. | Towards likely access |
| Actual usage data | No analytics or account ages are collected. No reliable denominator or child-use rate exists. | Unknown; cannot support a low-risk conclusion |
| Reports | Public reporting route added; monitored inbox and evidence log not yet operational. | Unknown until operated |

### Provisional conclusion

**For current risk control, treat the service as likely to be accessed by
children until evidence or effective access controls support another result.**

There is currently no defensible evidence that child access is improbable, and
the anticipated parent-to-child use plus the nature of location sharing weighs
against a "not likely" conclusion. The adults-only terms remain valuable for
intent, contract, enforcement, and risk reduction, but do not change this
Online Safety Act assessment.

## Consequence of the conclusion

Before an in-scope public service proceeds beyond this restricted POC, the
operator must complete and keep a children's risk assessment, implement the
proportionate safety duties that apply to the service, publish required
summaries or terms information, maintain reporting and complaints processes,
assign the individual maintainer as responsible person, and retain the records
Ofcom requires.

The alternative is to implement highly effective age assurance plus access
controls sufficient to prevent children normally accessing the service. That
would add identity and privacy costs and requires a separate necessity,
proportionality, security, and data-protection analysis. A checkbox is not that
alternative.

## Interim measures already implemented

- Adults-only contract and prominent first-use self-declaration
- Explicit ban on installing, configuring, or operating Flock for a child
- Location sharing off on every launch
- Neighbourhood detail rather than exact spot as the new-circle default
- Remote exact lost-phone response off by default per circle
- Persistent in-app state showing whether sharing is active
- Public misuse and safeguarding report page
- No advertising, behavioural profiling, or engagement-based age inference

These reduce foreseeable harm. They do not amount to a completed children's
safety case or highly effective age assurance.

## Evidence and review log

The owner must maintain, without collecting unnecessary child data:

- child-use and child-safety report counts and themes;
- support reports indicating parent-to-child installation;
- product, distribution, and marketing changes;
- age-gate bypass evidence;
- relevant regulator or court developments; and
- the reasons for any changed conclusion.

An urgent reassessment is required after credible evidence of child use, a
child-related incident, child-directed promotion, integration with schools or
family services, a change to age assurance, or a material location feature.

## Approval

- Product owner: **not signed**
- Online Safety Act accountable person: **not assigned**
- UK legal review: **not completed**
- Decision to operate while likely accessed by children: **not approved**

## Primary sources

- Ofcom, children's access assessment duties:
  https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/childrens-access-assessment-duties-under-the-online-safety-act
- Ofcom, children's access assessment tool:
  https://www.ofcom.org.uk/os-toolkit/child-access-assessment/childrens-access-assessment-tool
- ICO, services covered by the Children's Code:
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/services-covered-by-this-code/
- ICO, age assurance for the Children's Code:
  https://ico.org.uk/about-the-ico/what-we-do/information-commissioners-opinions/age-assurance-for-the-childrens-code/1-age-assurance/
