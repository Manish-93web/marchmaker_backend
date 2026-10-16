import { Button, Heading, Text } from '@react-email/components';
import { Layout, brand } from '../Layout';

export interface NoticeProps {
  preview: string;
  heading: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  footnote?: string;
  unsubscribeUrl?: string;
}

/** Generic transactional layout; named templates in Phase 11 compose this. */
export function Notice({ preview, heading, paragraphs, cta, footnote, unsubscribeUrl }: NoticeProps) {
  return (
    <Layout preview={preview} unsubscribeUrl={unsubscribeUrl}>
      <Heading as="h1" style={{ fontSize: 22, color: brand.ink, margin: '0 0 12px' }}>
        {heading}
      </Heading>
      {paragraphs.map((p, i) => (
        <Text key={i} style={{ color: brand.ink, fontSize: 16, lineHeight: '24px' }}>
          {p}
        </Text>
      ))}
      {cta && (
        <Button
          href={cta.url}
          style={{
            backgroundColor: brand.accent,
            color: brand.ink,
            padding: '12px 24px',
            borderRadius: 999,
            fontWeight: 600,
          }}
        >
          {cta.label}
        </Button>
      )}
      {footnote && <Text style={{ color: brand.muted, fontSize: 13 }}>{footnote}</Text>}
    </Layout>
  );
}
