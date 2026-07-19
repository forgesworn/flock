# One-person POC legal posture

Last reviewed: 2026-07-11

## Confirmed facts

- Flock is a personal proof of concept built and uploaded by one individual.
- There is no company operating it.
- The hosted preview and APK are free and non-commercial.
- The intended users are invited adults testing with other consenting adults.
- The website and APK are nevertheless technically reachable without a private
  access code.
- Flock has no user account database and the operator does not receive readable
  fixed-signal or location content in the ordinary design.
- Flock has no free-form chat, link/media attachment, forwarding, or custom
  lost-note surface; communication is limited to provider-defined actions.

If funding, advertising, paid work, customer use, public promotion, or another
organisation becomes involved, this record must be reassessed.

## What POC status changes

| Area | POC effect |
| --- | --- |
| Scale and proportionality | Very small reach, invited testers, no public discovery inside Flock, and no monetisation reduce the measures reasonably expected. Records and response processes can be simple and maintained by the individual. |
| UK consumer/trader rules | If the maintainer is genuinely acting outside a trade, business, craft, or profession, trader-to-consumer regimes may not apply in the usual way. Do not rely on this if Flock promotes an economic activity. |
| EU DSA/e-commerce/EECC | These regimes generally depend on an information-society/economic service normally provided for remuneration, which can include indirect remuneration. A genuinely non-economic personal experiment points away from scope, but the facts must be recorded. |
| ICO data-protection fee | Personal/household or not-for-profit fee exemptions may be relevant. The maintainer must use the ICO self-assessment. A fee exemption does not automatically remove substantive duties. |
| Online-safety proportionality | Ofcom says small, part-time, and voluntary services receive a risk-based, proportionate approach and usually an opportunity to remedy concerns. This reduces burden and enforcement risk; it is not a scope exemption. |

## What it does not change

### An individual can be a controller

UK GDPR defines a controller as a natural or legal person that determines the
purposes and means of processing. Incorporation and profit are not required.
The operator is not necessarily controller for every recipient-side action, but
must assess the processing they determine: hosted delivery, proxy and relay
choices, security, support/report handling, and service metadata.

### An open deployment is not obviously household activity

The household exclusion is for processing in a purely personal or household
activity. Publishing a reusable hosted service and APK for other people's groups
is materially different. Do not rely on the exemption for the hosted operator
role without specific advice.

### The Online Safety Act is not company-only

Ofcom says the regime can cover the smallest community services, including
part-time and voluntary operations. Scope still depends on the statutory service
definitions and exemptions. If in scope, the baseline is proportionate:
understand the risks, keep clear terms, provide reporting/complaints, act on
credible illegal use where technically possible, retain a record, and identify
one responsible person. The same individual can own all of those tasks.

### Severe location harm does not require scale

A single coerced or child-tracking installation can cause serious physical or
privacy harm. Small reach lowers likelihood and aggregate exposure, not the
impact of one disclosure. Private defaults and clear consent remain justified.

## Current good-faith controls

- Explicit experimental, non-commercial, adults-only presentation
- Versioned adult/consenting-adults acknowledgement before normal app startup
- Sharing off until a deliberate tap; neighbourhood default detail
- Visible Android foreground notification during locked/background sharing
- Remote exact lost-phone response off until a per-circle opt-in
- No accounts, ads, behavioural analytics, or server plaintext location history
- Clear no-emergency and accuracy warnings
- Misuse, safeguarding, privacy, and legal contact routes
- Draft data-flow, DPIA, child-access, and illegal-use records

## Strongest next risk reduction

If the intent is a closed experiment, make the deployment match that intent. A
public project/features/download site can remain at `/`, while the PWA and APK
require a signed, expiring preview invitation before normal startup. The token
should travel in a URL fragment so it is not sent in ordinary HTTP logs. A
guessable URL, shared password in client code, or search-engine `noindex` alone
is not access control.

The invitation gate is not highly effective age assurance, and a recipient can
forward an invite. It still provides materially better evidence and practical
restriction than an open client labelled "POC".

## Minimum actions for the current open POC

1. Put the individual operator's legal name in the privacy notice, or obtain
   specific advice that the current identifier/contact is sufficient.
2. Test the three published email aliases and assign the maintainer as owner.
3. Complete the ICO fee self-assessment and save the result.
4. Run Ofcom's scope checker and save the answers; if in scope, adapt the simple
   risk record to the required form.
5. Keep a minimal dated log of safety/privacy reports and material changes.
6. Do not market the POC for children, schools, safeguarding, employment,
   medical monitoring, or emergency reliance.

## Primary sources

- UK controller definition (natural or legal person):
  https://www.legislation.gov.uk/ukpga/2018/12/notes/division/3/index.htm
- ICO, who UK GDPR applies to:
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/who-does-the-uk-gdpr-apply-to/
- ICO, fee exemptions and continuing duties:
  https://ico.org.uk/for-organisations/data-protection-fee/data-protection-fee/exemptions
- Ofcom, helping small services:
  https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/helping-small-services-navigate-the-online-safety-act
- EU information-society service definition:
  https://eur-lex.europa.eu/eli/dir/2015/1535/oj
