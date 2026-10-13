import { PartnerPreferences, IPartnerPreferences } from "../models/PartnerPreferences.js";

export class PreferenceService {
  static async getPreferences(userId: string): Promise<IPartnerPreferences | null> {
    return PartnerPreferences.findOne({ userId });
  }

  static async updatePreferences(userId: string, updateData: Partial<IPartnerPreferences>): Promise<IPartnerPreferences> {
    const preferences = await PartnerPreferences.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true, upsert: true }
    );
    return preferences;
  }
}
