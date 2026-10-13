import crypto from "crypto";
import { config } from "../config/index.js";

export class StorageService {
  /**
   * Generate a pre-signed PUT upload URL for direct-to-cloud upload.
   * Keeps raw document bytes and high-res media off application memory.
   */
  static generatePresignedUploadUrl(data: {
    userId: string;
    category: "KYC_DOCUMENT" | "SELFIE" | "PROFILE_PHOTO";
    fileName: string;
    contentType: string;
  }): {
    uploadUrl: string;
    fileKey: string;
    publicOrSignedViewUrl: string;
    expiresInSeconds: number;
  } {
    const ext = data.fileName.split(".").pop() || "jpg";
    const randomHex = crypto.randomBytes(8).toString("hex");
    const fileKey = `${data.category.toLowerCase()}/${data.userId}/${Date.now()}-${randomHex}.${ext}`;

    // Compute HMAC signature for presigned request simulation/cloud authorization
    const signature = crypto
      .createHmac("sha256", config.jwtSecret)
      .update(`${fileKey}|${data.contentType}`)
      .digest("hex");

    // In production with AWS S3 / Cloudflare R2, generate S3.getSignedUrlPromise('putObject', ...)
    const uploadUrl = `https://storage.marchmaker.in/upload/${fileKey}?sig=${signature}&expires=900`;
    const viewUrl = `https://storage.marchmaker.in/media/${fileKey}?sig=${signature}`;

    return {
      uploadUrl,
      fileKey,
      publicOrSignedViewUrl: viewUrl,
      expiresInSeconds: 900, // 15 minutes
    };
  }

  /**
   * Generate short-lived signed URL (15 minutes) for viewing sensitive KYC document proofs.
   */
  static generateSignedDownloadUrl(fileKey: string, allowedUserId: string): {
    signedUrl: string;
    expiresAt: Date;
  } {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    const token = crypto
      .createHmac("sha256", config.jwtSecret)
      .update(`${fileKey}|${allowedUserId}|${expiresAt.getTime()}`)
      .digest("hex");

    return {
      signedUrl: `https://storage.marchmaker.in/secure/${fileKey}?token=${token}&expires=${expiresAt.getTime()}`,
      expiresAt,
    };
  }
}
