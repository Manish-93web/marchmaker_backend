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

export class NoopModeration implements ImageModeration {
  async check(): Promise<ImageCheckResult> {
    return { faceDetected: null, nsfw: null, provider: 'none' };
  }
}
