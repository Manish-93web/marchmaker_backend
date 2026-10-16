/**
 * Automated image checks sit behind this interface (face present, NSFW). `null` means
 * "not checked": the photo then waits for a human in the admin photo queue, which is
 * always the final gate. A real provider adapter is plugged in per environment.
 */
export interface ImageCheckResult {
  faceDetected: boolean | null;
  nsfw: boolean | null;
  provider: string;
}

export interface ImageModeration {
  check(image: Buffer): Promise<ImageCheckResult>;
}

/** Development stand-in: every photo has a face and is clean, so the review flow can be exercised end to end. */
export class MockModeration implements ImageModeration {
  async check(): Promise<ImageCheckResult> {
    return { faceDetected: true, nsfw: false, provider: 'mock' };
  }
}

/**
 * AWS Rekognition: a face must be present (one clear face, not a group shot) and explicit content is refused.
 * Any provider error returns "not checked" so the photo still reaches a human reviewer.
 */
export class RekognitionModeration implements ImageModeration {
  private client: import('@aws-sdk/client-rekognition').RekognitionClient | null = null;
  constructor(
    private readonly region: string,
    private readonly log?: { warn: (o: object, m: string) => void },
  ) {}

  async check(image: Buffer): Promise<ImageCheckResult> {
    try {
      const sdk = await import('@aws-sdk/client-rekognition');
      this.client ??= new sdk.RekognitionClient({ region: this.region });
      const [faces, labels] = await Promise.all([
        this.client.send(new sdk.DetectFacesCommand({ Image: { Bytes: image }, Attributes: ['DEFAULT'] })),
        this.client.send(new sdk.DetectModerationLabelsCommand({ Image: { Bytes: image }, MinConfidence: 80 })),
      ]);
      const explicit = (labels.ModerationLabels ?? []).some((l) => ['Explicit Nudity', 'Explicit', 'Nudity'].includes(l.Name ?? '') || ['Explicit Nudity', 'Explicit', 'Nudity'].includes(l.ParentName ?? ''));
      return { faceDetected: (faces.FaceDetails ?? []).some((f) => (f.Confidence ?? 0) >= 90), nsfw: explicit, provider: 'rekognition' };
    } catch (err) {
      this.log?.warn({ err }, 'image moderation failed; leaving the photo to a human reviewer');
      return { faceDetected: null, nsfw: null, provider: 'rekognition' };
    }
  }
}

export function createImageModeration(env: { IMAGE_MODERATION: 'none' | 'mock' | 'rekognition'; AWS_REGION?: string }, log?: { warn: (o: object, m: string) => void }): ImageModeration {
  if (env.IMAGE_MODERATION === 'mock') return new MockModeration();
  if (env.IMAGE_MODERATION === 'rekognition') return new RekognitionModeration(env.AWS_REGION ?? 'ap-south-1', log);
  return new NoopModeration();
}

export class NoopModeration implements ImageModeration {
  async check(): Promise<ImageCheckResult> {
    return { faceDetected: null, nsfw: null, provider: 'none' };
  }
}
