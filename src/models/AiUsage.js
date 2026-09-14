import mongoose from "mongoose";

const aiUsageSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    bookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Book",
      required: true,
      index: true,
    },
    feature: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    model: {
      type: String,
      required: true,
      trim: true,
    },
    inputTokens: {
      type: Number,
      min: 0,
      default: 0,
    },
    outputTokens: {
      type: Number,
      min: 0,
      default: 0,
    },
    totalTokens: {
      type: Number,
      min: 0,
      default: 0,
    },
    estimatedCostUsd: {
      type: Number,
      min: 0,
      default: 0,
    },
    inputCharacters: {
      type: Number,
      min: 0,
      default: 0,
    },
    noteCount: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

aiUsageSchema.index({ userId: 1, feature: 1, createdAt: -1 });

export const AiUsage = mongoose.model("AiUsage", aiUsageSchema);
