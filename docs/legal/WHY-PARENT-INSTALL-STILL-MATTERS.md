# Why a parent's installation can still be Flock's issue

Last reviewed: 2026-07-10

This is an internal risk analysis, not legal advice. It records why the hosted
preview does not rely on parental responsibility as its child-safety defence.

## Short answer

A parent is responsible for choosing to install or use the app and can breach
Flock's Terms. That does not automatically remove the operator's separate
responsibility for designing, supplying, and operating the service used to
process the child's data.

The child is the person whose location and communications are processed. A
parent cannot contract away the child's statutory rights or turn an adults-only
service into an authorised child service merely by accepting terms for them.

## Separate responsibilities

| Actor | Possible role and responsibility | What it does not solve |
| --- | --- | --- |
| Parent or guardian | Chooses the installation, circle, recipients, permissions, and purpose. May be responsible under contract, privacy, family, criminal, safeguarding, or civil law for misuse. Purely personal or household processing may fall outside UK GDPR. | The household position does not authorise stalking, coercion, abuse, or unsafe sharing, and does not give the service provider the same exemption. |
| Child | Is the data subject when their location, device identifiers, messages, or activity are processed. Has interests and rights distinct from the adult's convenience. | A parent saying "I consent" is not a universal lawful basis or waiver of the child's rights. |
| Hosted Flock operator | Chooses product defaults, notices, hosted code, proxies, default relay relationships, retention, security, and reporting controls. May be a controller for some technical processing and must assess its actual role for each data flow. | End-to-end encryption and no account database reduce data and risk; they do not erase responsibility for the processing the operator does control. |
| Relay, host, and other providers | May be processors, independent controllers, or in some cases joint controllers depending on their real decisions and contracts. | Calling a provider "infrastructure" does not decide its legal role. |
| Circle recipients | Can read and retain information intentionally shared with them and may have their own responsibilities. | Recipient responsibility does not make unsafe defaults or operator-controlled processing irrelevant. |

## The household exemption is not a provider exemption

The ICO describes purely personal or household processing with no professional
or commercial connection as outside UK GDPR. The EU GDPR is even more explicit
in Recital 18: the household exclusion does not apply to controllers or
processors that provide the means for that household processing.

The result is not that Flock automatically controls every location disclosure.
Roles depend on the facts. The result is that "the parent did it at home" is not
a complete provider defence and must not be the only risk control.

## Why foreseeability matters

An isolated user defeating clear controls is stronger evidence of unauthorised
misuse than a use the operator expects, encourages, or quietly designs for. Once
the operator knows parents are likely to hand Flock to children, it is difficult
to describe that as wholly unexpected misuse while retaining child-attractive
copy, automatic location sharing, or weak access restrictions.

The current decision is therefore:

1. The hosted preview is contractually restricted to adults sharing with other
   consenting adults.
2. The first-use gate records an adult self-declaration locally. This is useful
   contractual evidence but is not highly effective age assurance.
3. Location sharing starts off on every launch at neighbourhood detail.
4. Remote exact-location permission starts off and requires a device-local
   opt-in for each circle.
5. Child use and suspected coercive tracking can be reported through the public
   misuse route.
6. If evidence shows children are likely to access the service, the operator
   must not rely on the 18+ wording. It must either introduce proportionate,
   effective access controls or apply the relevant child-safety standards.

## What the Terms achieve

The Terms create a clear contractual boundary, support enforcement against
operator-controlled infrastructure, and make an adult accountable for knowingly
breaking the rule. They also help demonstrate the intended audience.

The Terms cannot:

- exclude mandatory data-protection, consumer, online-safety, or safeguarding
  duties;
- bind a child merely because an adult clicked for them;
- make a foreseeable design risk disappear;
- prove that children do not in fact access the service; or
- replace a DPIA, children's access assessment, or illegal-content risk
  assessment where one is required.

## Response to a child-use report

1. Address immediate danger first and direct the reporter to emergency services
   or police where appropriate.
2. Collect the minimum information needed; never ask for a private key, circle
   seed, backup, PIN, or exact current location.
3. Determine whether operator-controlled infrastructure is involved and preserve
   only relevant records.
4. Restrict infrastructure where lawful, technically possible, and necessary to
   reduce a credible risk.
5. Record the report as evidence for the next Children's Code and Online Safety
   Act access assessment, even where the individual incident cannot be verified.
6. Escalate credible safeguarding, crime, or personal-data-breach issues under
   the incident runbook and seek counsel where needed.

## Primary sources

- ICO, data protection exemptions (domestic purposes):
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/exemptions/a-guide-to-the-data-protection-exemptions/
- EU GDPR Recital 18 and Article 2(2)(c):
  https://eur-lex.europa.eu/eli/reg/2016/679/oj
- ICO, services covered by the Children's Code:
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/services-covered-by-this-code/
- ICO, geolocation tracking and parental monitoring:
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/how-to-use-our-guidance-for-standard-one-best-interests-of-the-child/best-interests-framework/geolocation-tracking/
- Ofcom, children's access assessments:
  https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/childrens-access-assessment-duties-under-the-online-safety-act
