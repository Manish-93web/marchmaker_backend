import mongoose, { Schema, Document, Types } from "mongoose";

export interface IPartnerPreferences extends Document {
  userId: Types.ObjectId;
  ageMin: number;
  ageMax: number;
  heightCmMin: number;
  heightCmMax: number;
  maritalStatuses: string[];
  religions: string[];
  motherTongues: string[];
  educationLevels: string[];
  occupations: string[];
  minAnnualIncomeINR?: number;
  locations: string[];
  dietaryPreferences: string[];
  willingToRelocate: "YES" | "NO" | "OPEN_TO_DISCUSS";
  marriageTimelineMonths: number;
  // Hard filters vs Soft ranking filters
  hardConstraints: {
    age: boolean;
    height: boolean;
    maritalStatus: boolean;
    religion: boolean;
    motherTongue: boolean;
    location: boolean;
    diet: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

const PartnerPreferencesSchema = new Schema<IPartnerPreferences>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    ageMin: { type: Number, default: 21 },
    ageMax: { type: Number, default: 35 },
    heightCmMin: { type: Number, default: 150 },
    heightCmMax: { type: Number, default: 195 },
    maritalStatuses: { type: [String], default: ["NEVER_MARRIED"] },
    religions: { type: [String], default: [] },
    motherTongues: { type: [String], default: [] },
    educationLevels: { type: [String], default: [] },
    occupations: { type: [String], default: [] },
    minAnnualIncomeINR: { type: Number, default: 0 },
    locations: { type: [String], default: [] },
    dietaryPreferences: { type: [String], default: [] },
    willingToRelocate: {
      type: String,
      enum: ["YES", "NO", "OPEN_TO_DISCUSS"],
      default: "OPEN_TO_DISCUSS",
    },
    marriageTimelineMonths: { type: Number, default: 12 },
    hardConstraints: {
      age: { type: Boolean, default: true },
      height: { type: Boolean, default: false },
      maritalStatus: { type: Boolean, default: true },
      religion: { type: Boolean, default: true },
      motherTongue: { type: Boolean, default: false },
      location: { type: Boolean, default: false },
      diet: { type: Boolean, default: false },
    },
  },
  {
    timestamps: true,
  }
);

export const PartnerPreferences = mongoose.model<IPartnerPreferences>(
  "PartnerPreferences",
  PartnerPreferencesSchema
);
