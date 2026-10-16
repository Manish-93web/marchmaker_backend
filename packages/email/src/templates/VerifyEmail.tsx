import { Button, Heading, Text } from '@react-email/components';
import { Layout, brand } from '../Layout';

export interface VerifyEmailProps {
  firstName: string;
  verifyUrl: string;
}

export function VerifyEmail({ firstName, verifyUrl }: VerifyEmailProps) {
  return (
    <Layout preview="Confirm your email to continue">
      <Heading as="h1" style={{ fontSize: 22, color: brand.ink, margin: '0 0 12px' }}>
        Welcome, {firstName}
      </Heading>
      <Text style={{ color: brand.ink, fontSize: 16, lineHeight: '24px' }}>
        Please confirm your email address to continue building your profile. This link works for 24 hours.
      </Text>
      <Button
        href={verifyUrl}
        style={{
          backgroundColor: brand.accent,
          color: brand.ink,
          padding: '12px 24px',
          borderRadius: 999,
          fontWeight: 600,
        }}
      >
        Confirm my email
      </Button>
      <Text style={{ color: brand.muted, fontSize: 13 }}>
        If you did not create an account, you can safely ignore this message.
      </Text>
    </Layout>
  );
}
