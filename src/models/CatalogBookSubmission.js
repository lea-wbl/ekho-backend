import mongoose from "mongoose";

const catalogBookSubmissionSchema = new mongoose.Schema(
  {
    proposedByBookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Book",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    author: {
      type: String,
      required: true,
      trim: true,
    },
    publisher: {
      type: String,
      trim: true,
      default: "",
    },
    seriesName: {
      type: String,
      trim: true,
      default: "",
    },
    seriesNumber: {
      type: Number,
      min: 1,
      default: null,
    },
    totalPages: {
      type: Number,
      required: true,
      min: 1,
    },
    thumbnail: {
      type: String,
      trim: true,
      default: "",
    },
    normalizedTitle: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    normalizedAuthor: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    normalizedPublisher: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    createdCatalogBookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CatalogBook",
      default: null,
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

catalogBookSubmissionSchema.index(
  {
    normalizedTitle: 1,
    normalizedAuthor: 1,
    normalizedPublisher: 1,
    proposedByBookId: 1,
  },
  { unique: true },
);

export const CatalogBookSubmission = mongoose.model(
  "CatalogBookSubmission",
  catalogBookSubmissionSchema,
);
