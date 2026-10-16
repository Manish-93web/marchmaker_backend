import type { Env } from '../config/env';

/** Server-side speech-to-text fallback for browsers without the Web Speech API (feature flagged). */
export interface TranscriptionProvider {
  transcribe(audio: Buffer, contentType: string, language: 'en' | 'hi'): Promise<string>;
}

export class OpenAiWhisper implements TranscriptionProvider {
  constructor(private readonly apiKey: string) {}
  async transcribe(audio: Buffer, contentType: string, language: 'en' | 'hi'): Promise<string> {
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('language', language);
    form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), 'speech.webm');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`transcription provider returned ${res.status}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  }
}

export function createTranscriber(env: Env): TranscriptionProvider | null {
  if (env.TRANSCRIPTION_PROVIDER === 'openai' && env.OPENAI_API_KEY) return new OpenAiWhisper(env.OPENAI_API_KEY);
  return null;
}
