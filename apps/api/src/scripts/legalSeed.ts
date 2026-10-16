import type { LegalType } from '@marchmaker/shared';

export interface LegalSeed {
  type: LegalType;
  version: string;
  title: string;
  markdown: string;
}

const NOTE =
  '> **Draft for legal review.** This text is a working draft and must be reviewed by qualified counsel before launch.\n\n';

export const LEGAL_SEEDS: LegalSeed[] = [
  {
    type: 'terms',
    version: '0.1',
    title: 'Terms of Service',
    markdown:
      NOTE +
      `# Terms of Service

## Who can use Marchmaker
Marchmaker is for people in India who are looking for a partner with the intention of marriage. You must be at least 18 (women) or 21 (men), legally free to marry, and use your real identity.

## What we do
We help you build a profile, verify who you are, and receive a small number of introductions. **Every introduction is reviewed by a person on our team** before you see it. We do not guarantee any outcome.

## Your commitments
- Give accurate information and keep it up to date.
- Treat every member with respect. Harassment, scams and requests for money are not allowed.
- Do not share another member's information outside Marchmaker.

## Introductions and credits
A credit is used only when an introduction is accepted by both people. If the other person declines or does not reply in time, your credit is returned.

## Payments
Prices are shown including GST. Subscriptions renew until cancelled. See the Refund and Cancellation Policy.

## Suspension
We may restrict or end accounts that break these terms or put members at risk.

## Contact
Questions: support@marchmaker.example. Grievances: see the Grievance Officer page.`,
  },
  {
    type: 'privacy',
    version: '0.1',
    title: 'Privacy Policy',
    markdown:
      NOTE +
      `# Privacy Policy

We process personal data in line with India's Digital Personal Data Protection Act, 2023.

## What we collect
Account details, profile answers, photos, identity verification documents, assessment answers, messages, and payment records.

## Why we use it
- To run your account and create introductions you asked for.
- To verify identity and keep members safe.
- To take payments and issue GST invoices.
- To send service messages. Marketing messages need your separate consent.

## Who sees what
- Other members see only what an introduction needs. Photos stay blurred until both of you accept.
- Identity documents are seen only by our verification team and are deleted 30 days after a decision.

## Your rights
You can access, correct, export and delete your data from Settings. You can withdraw any consent at any time. Account deletion has a 14 day grace period, after which data is permanently erased, except records we must keep by law.

## Retention
See the retention schedule in your Settings. Payment and tax records are kept as required by law.

## Grievances
Write to our Grievance Officer (see the Grievance Officer page).`,
  },
  {
    type: 'refund',
    version: '0.1',
    title: 'Refund and Cancellation Policy',
    markdown:
      NOTE +
      `# Refund and Cancellation Policy

## Cancel anytime
You can cancel a subscription from Billing. You keep access until the end of the paid period and it will not renew.

## Introduction credits
Credits are used only on mutual acceptance. Credits from introductions that were declined or expired are returned automatically.

## Refunds
- Unused introduction packs: refundable within 7 days of purchase.
- Subscriptions: refundable within 7 days of the first payment if no introduction was unlocked.
- Duplicate or failed-but-debited payments are refunded in full.

Refunds go to the original payment method, usually within 5 to 7 working days.`,
  },
  {
    type: 'community_guidelines',
    version: '0.1',
    title: 'Community Guidelines',
    markdown:
      NOTE +
      `# Community Guidelines

1. **Be real.** One person, one profile, your own photos.
2. **Be kind.** Decline gracefully. Do not pressure anyone.
3. **Be safe.** Never send money. Do not share contact details until you both choose to.
4. **Respect privacy.** Never screenshot or share another member's photos or messages.
5. **Report concerns.** Use the report button. Safety reports are reviewed first.

In an emergency call 112.`,
  },
  {
    type: 'cookies',
    version: '0.1',
    title: 'Cookie Policy',
    markdown:
      NOTE +
      `# Cookie Policy

## Essential cookies
Keep you signed in and protect your account. They cannot be switched off.

## Analytics cookies
Help us see where people get stuck. Used only if you agree, and they never include the content of your profile or messages.

You can change your choice at any time from Settings.`,
  },
  {
    type: 'grievance',
    version: '0.1',
    title: 'Grievance Officer',
    markdown:
      NOTE +
      `# Grievance Officer

In line with the Information Technology Rules, 2021 and the DPDP Act, 2023:

- **Name:** [to be filled before launch]
- **Email:** grievance@marchmaker.example
- **Address:** [to be filled before launch]

We acknowledge complaints within 24 hours and aim to resolve them within 15 days.`,
  },
];
