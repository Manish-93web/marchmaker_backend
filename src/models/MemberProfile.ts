import mongoose, { Schema, Document, Types } from "mongoose";

export interface IPhoto {
  _id?: Types.ObjectId;
  url: string;
  isPrimary: boolean;
  isPrivate: boolean;
  isApproved: boolean;
}

export interface IMemberProfile extends Document {
  userId: Types.ObjectId;
  fullName: string;
  gender: "MALE" | "FEMALE" | "OTHER";
  dateOfBirth?: Date;
  heightCm?: number;
  maritalStatus?: "NEVER_MARRIED" | "DIVORCED" | "WIDOWED" | "AWAITING_DIVORCE";
  motherTongue?: string;
  religion?: string;
  caste?: string;
  manglikStatus?: "NO" | "YES" | "DON_T_KNOW";
  educationLevel?: string;
  highestDegree?: string;
  collegeName?: string;
  employedIn?: string;
  occupationTitle?: string;
  annualIncomeINR?: number;
  city?: string;
  state?: string;
  country?: string;
  diet?: "VEGETARIAN" | "EGGETARIAN" | "NON_VEGETARIAN" | "VEGAN";
  smoking?: "NEVER" | "OCCASIONALLY" | "REGULARLY";
  drinking?: "NEVER" | "OCCASIONALLY" | "REGULARLY";
  bio?: string;
  familyType?: "JOINT" | "NUCLEAR";
  familyValues?: "TRADITIONAL" | "MODERATE" | "LIBERAL";
  fathersOccupation?: string;
  mothersOccupation?: string;
  siblingsCount?: number;
  photos: IPhoto[];
  astrologyDetails?: {
    birthTime?: string;
    birthPlace?: string;
    nakshatra?: string;
    rasi?: string;
    isOptedIn?: boolean;
  };
  stepCompleted: number;
  completionPercentage: number;
  isProfileSubmitted: boolean;
  submittedAt?: Date;
  draftData?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const PhotoSchema = new Schema<IPhoto>({
  url: { type: String, required: true },
  isPrimary: { type: Boolean, default: false },
  isPrivate: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: true },
});

const MemberProfileSchema = new Schema<IMemberProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    fullName: { type: String, required: true, trim: true },
    gender: { type: String, enum: ["MALE", "FEMALE", "OTHER"], required: true, index: true },
    dateOfBirth: { type: Date, index: true },
    heightCm: { type: Number, index: true },
    maritalStatus: {
      type: String,
      enum: ["NEVER_MARRIED", "DIVORCED", "WIDOWED", "AWAITING_DIVORCE"],
      index: true,
    },
    motherTongue: { type: String, index: true },
    religion: { type: String, index: true },
    caste: { type: String },
    manglikStatus: { type: String, enum: ["NO", "YES", "DON_T_KNOW"], default: "DON_T_KNOW" },
    educationLevel: { type: String },
    highestDegree: { type: String },
    collegeName: { type: String },
    employedIn: { type: String },
    occupationTitle: { type: String },
    annualIncomeINR: { type: Number, index: true },
    city: { type: String, index: true },
    state: { type: String, index: true },
    country: { type: String, default: "India", index: true },
    diet: { type: String, enum: ["VEGETARIAN", "EGGETARIAN", "NON_VEGETARIAN", "VEGAN"] },
    smoking: { type: String, enum: ["NEVER", "OCCASIONALLY", "REGULARLY"] },
    drinking: { type: String, enum: ["NEVER", "OCCASIONALLY", "REGULARLY"] },
    bio: { type: String, maxlength: 2000 },
    familyType: { type: String, enum: ["JOINT", "NUCLEAR"] },
    familyValues: { type: String, enum: ["TRADITIONAL", "MODERATE", "LIBERAL"] },
    fathersOccupation: { type: String },
    mothersOccupation: { type: String },
    siblingsCount: { type: Number, default: 0 },
    photos: [PhotoSchema],
    astrologyDetails: {
      birthTime: { type: String },
      birthPlace: { type: String },
      nakshatra: { type: String },
      rasi: { type: String },
      isOptedIn: { type: Boolean, default: false },
    },
    stepCompleted: { type: Number, default: 1 },
    completionPercentage: { type: Number, default: 20, index: true },
    isProfileSubmitted: { type: Boolean, default: false, index: true },
    submittedAt: { type: Date },
    draftData: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for matching and admin queries
MemberProfileSchema.index({ gender: 1, isProfileSubmitted: 1, religion: 1 });
MemberProfileSchema.index({ city: 1, state: 1 });
MemberProfileSchema.index({ annualIncomeINR: -1 });

export const MemberProfile = mongoose.model<IMemberProfile>("MemberProfile", MemberProfileSchema);
