import { Body, Container, Head, Hr, Html, Preview, Section, Text } from '@react-email/components';
import type { ReactNode } from 'react';

export const brand = {
  primary: '#4A1D3F',
  accent: '#F2A33A',
  bg: '#FBF7F2',
  ink: '#1E1A1D',
  muted: '#6B6168',
};

export interface LayoutProps {
  preview: string;
  children: ReactNode;
  /** Non-transactional mail must include an unsubscribe link. */
  unsubscribeUrl?: string;
}

export function Layout({ preview, children, unsubscribeUrl }: LayoutProps) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: brand.bg, fontFamily: 'Helvetica, Arial, sans-serif', margin: 0 }}>
        <Container style={{ maxWidth: 560, margin: '0 auto', padding: '32px 20px' }}>
          <Text style={{ fontSize: 22, fontWeight: 700, color: brand.primary, margin: '0 0 24px' }}>Marchmaker</Text>
          <Section
            style={{ backgroundColor: '#ffffff', borderRadius: 12, padding: 24, border: '1px solid #EDE4DC' }}
          >
            {children}
          </Section>
          <Hr style={{ borderColor: '#EDE4DC', margin: '24px 0' }} />
          <Text style={{ fontSize: 12, color: brand.muted }}>
            Every introduction on Marchmaker is reviewed by a real person.
            {unsubscribeUrl ? ` To stop these emails, unsubscribe: ${unsubscribeUrl}` : ''}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
