import mongoose from "mongoose";

const catalogCorrectionSuggestionSchema = new mongoose.Schema(
  {
    catalogBookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CatalogBook",
      required: true,
      index: true,
    },
    sourceId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    field: {
      type: String,
      enum: ["title", "author", "publisher", "seriesName"],
      required: true,
      index: true,
    },
    proposedValue: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedProposedValue: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    proposedByBookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Book",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

catalogCorrectionSuggestionSchema.index(
  {
    catalogBookId: 1,
    field: 1,
    normalizedProposedValue: 1,
    proposedByBookId: 1,
  },
  { unique: true },
);

export const CatalogCorrectionSuggestion = mongoose.model(
  "CatalogCorrectionSuggestion",
  catalogCorrectionSuggestionSchema,
);
