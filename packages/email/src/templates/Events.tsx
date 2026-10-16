import { Button, Heading, Hr, Section, Text } from '@react-email/components';
import { Layout, brand } from '../Layout';

export interface EventEmailProps {
  title: string;
  body: string;
  url: string;
  unsubscribeUrl?: string;
  /** Extra line of detail, for example the number of unread messages. */
  detail?: string;
}

const h1 = { fontSize: 22, color: brand.ink, margin: '0 0 12px' } as const;
const p = { color: brand.ink, fontSize: 16, lineHeight: '24px' } as const;
const small = { color: brand.muted, fontSize: 13, lineHeight: '20px' } as const;

function Cta({ href, label }: { href: string; label: string }) {
  return (
    <Button href={href} style={{ backgroundColor: brand.accent, color: brand.ink, padding: '12px 24px', borderRadius: 999, fontWeight: 600 }}>
      {label}
    </Button>
  );
}

/** A new or waiting introduction: reassures that nothing is rushed and that a person chose it. */
export function IntroductionEmail({ title, body, url, unsubscribeUrl }: EventEmailProps) {
  return (
    <Layout preview={body} unsubscribeUrl={unsubscribeUrl}>
      <Heading as="h1" style={h1}>{title}</Heading>
      <Section style={{ backgroundColor: '#FBF1F8', borderRadius: 8, padding: '12px 16px', margin: '0 0 16px' }}>
        <Text style={{ ...p, margin: 0, color: brand.primary }}>Chosen for you by a member of our team</Text>
      </Section>
      <Text style={p}>{body}</Text>
      <Cta href={url} label="Read the introduction" />
      <Text style={small}>There is no countdown pressure: you can take your time, and saying no is always fine.</Text>
    </Layout>
  );
}

/** Payments, refunds, subscriptions and invoices. Always sent: it is a record. */
export function PaymentEmail({ title, body, url, detail }: EventEmailProps) {
  return (
    <Layout preview={body}>
      <Heading as="h1" style={h1}>{title}</Heading>
      <Text style={p}>{body}</Text>
      {detail && (
        <Section style={{ border: '1px solid #EDE4DC', borderRadius: 8, padding: '8px 16px', margin: '0 0 16px' }}>
          <Text style={{ ...p, margin: 0 }}>{detail}</Text>
        </Section>
      )}
      <Cta href={url} label="View billing" />
      <Hr style={{ borderColor: '#EDE4DC', margin: '20px 0' }} />
      <Text style={small}>Invoices are available under Billing at any time. Questions about a charge? Reply to this email.</Text>
    </Layout>
  );
}

/** Verification and profile review results. */
export function VerificationEmail({ title, body, url }: EventEmailProps) {
  return (
    <Layout preview={body}>
      <Heading as="h1" style={h1}>{title}</Heading>
      <Text style={p}>{body}</Text>
      <Cta href={url} label="Continue" />
      <Text style={small}>Your ID images are only seen by our verification team and are deleted after review.</Text>
    </Layout>
  );
}

/** A reply from support or a safety update. Calm and short; nothing about the other person. */
export function SupportEmail({ title, body, url }: EventEmailProps) {
  return (
    <Layout preview={body}>
      <Heading as="h1" style={h1}>{title}</Heading>
      <Text style={p}>{body}</Text>
      <Cta href={url} label="Open the conversation" />
      <Text style={small}>If you ever feel unsafe, call 112 (emergency) or 1091 (women helpline) first.</Text>
    </Layout>
  );
}

/** Once a day at most, only when messages have waited unread. Never contains message text. */
export function DigestEmail({ title, body, url, unsubscribeUrl, detail }: EventEmailProps) {
  return (
    <Layout preview={body} unsubscribeUrl={unsubscribeUrl}>
      <Heading as="h1" style={h1}>{title}</Heading>
      <Text style={{ ...p, fontSize: 32, fontWeight: 700, margin: '0 0 4px', color: brand.primary }}>{detail ?? ''}</Text>
      <Text style={p}>{body}</Text>
      <Cta href={url} label="Read your messages" />
      <Text style={small}>We send at most one reminder a day. You can change this in your notification settings.</Text>
    </Layout>
  );
}
