import { Types } from "mongoose";
import { MemberProfile, IMemberProfile, IPhoto } from "../models/MemberProfile.js";
import { Notification } from "../models/Notification.js";

export class ProfileService {
  static async getProfileByUserId(userId: string): Promise<IMemberProfile | null> {
    return MemberProfile.findOne({ userId });
  }

  static async saveDraft(userId: string, step: number, draftPayload: Record<string, any>): Promise<IMemberProfile> {
    let profile = await MemberProfile.findOne({ userId });
    if (!profile) {
      throw new Error("Profile not found");
    }

    // Merge incoming draft into draftData and top-level fields where applicable
    profile.draftData = {
      ...(profile.draftData || {}),
      ...draftPayload,
    };

    // If payload contains direct profile fields, update them
    const directFields = [
      "fullName", "gender", "dateOfBirth", "heightCm", "maritalStatus",
      "motherTongue", "religion", "caste", "manglikStatus", "educationLevel",
      "highestDegree", "collegeName", "employedIn", "occupationTitle",
      "annualIncomeINR", "city", "state", "country", "diet", "smoking",
      "drinking", "bio", "familyType", "familyValues", "fathersOccupation",
      "mothersOccupation", "siblingsCount", "astrologyDetails"
    ];

    directFields.forEach((field) => {
      if (draftPayload[field] !== undefined) {
        (profile as any)[field] = draftPayload[field];
      }
    });

    if (step > profile.stepCompleted) {
      profile.stepCompleted = step;
    }

    // Compute completion percentage
    profile.completionPercentage = this.calculateCompleteness(profile);

    await profile.save();
    return profile;
  }

  static async submitProfile(userId: string): Promise<IMemberProfile> {
    const profile = await MemberProfile.findOne({ userId });
    if (!profile) {
      throw new Error("Profile not found");
    }

    if (profile.isProfileSubmitted) {
      return profile;
    }

    if (!profile.fullName || !profile.gender || !profile.dateOfBirth || !profile.city) {
      throw new Error("Please complete the required basic details before submitting your profile.");
    }

    profile.isProfileSubmitted = true;
    profile.submittedAt = new Date();
    profile.completionPercentage = Math.max(profile.completionPercentage, 85);
    await profile.save();

    await Notification.create({
      userId,
      title: "Profile Submitted Successfully",
      message: "Your profile details have been saved. Next, verify your identity with government ID & selfie to enter the matching queue.",
      category: "SYSTEM",
      deepLink: "/dashboard/verification",
    });

    return profile;
  }

  static async addPhoto(userId: string, photoData: { url: string; isPrivate?: boolean; isPrimary?: boolean }): Promise<IMemberProfile> {
    const profile = await MemberProfile.findOne({ userId });
    if (!profile) {
      throw new Error("Profile not found");
    }

    const isFirstPhoto = profile.photos.length === 0;
    const newPhoto: IPhoto = {
      url: photoData.url,
      isPrimary: photoData.isPrimary ?? isFirstPhoto,
      isPrivate: photoData.isPrivate ?? false,
      isApproved: true,
    };

    if (newPhoto.isPrimary) {
      profile.photos.forEach((p) => (p.isPrimary = false));
    }

    profile.photos.push(newPhoto);
    profile.completionPercentage = this.calculateCompleteness(profile);
    await profile.save();
    return profile;
  }

  static async deletePhoto(userId: string, photoId: string): Promise<IMemberProfile> {
    const profile = await MemberProfile.findOne({ userId });
    if (!profile) {
      throw new Error("Profile not found");
    }

    profile.photos = profile.photos.filter((p) => p._id?.toString() !== photoId);
    if (profile.photos.length > 0 && !profile.photos.some((p) => p.isPrimary)) {
      profile.photos[0].isPrimary = true;
    }

    profile.completionPercentage = this.calculateCompleteness(profile);
    await profile.save();
    return profile;
  }

  static calculateCompleteness(profile: IMemberProfile): number {
    let score = 20; // Base registration score
    if (profile.dateOfBirth && profile.heightCm && profile.maritalStatus) score += 15;
    if (profile.educationLevel && profile.occupationTitle && profile.annualIncomeINR) score += 20;
    if (profile.religion && profile.motherTongue && profile.city) score += 15;
    if (profile.bio && profile.bio.length > 50) score += 10;
    if (profile.photos && profile.photos.length > 0) score += 10;
    if (profile.familyType && profile.familyValues) score += 10;
    return Math.min(score, 100);
  }
}
