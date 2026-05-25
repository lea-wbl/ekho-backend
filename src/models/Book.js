import mongoose from "mongoose";

const bookSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      trim: true,
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
    totalPages: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ["tbr", "reading", "finished"],
      default: "tbr",
    },
    currentPage: {
      type: Number,
      default: 0,
      min: 0,
    },
    thumbnail: {
      type: String,
      trim: true,
      default: "",
    },
    googleBookId: {
      type: String,
      trim: true,
      default: "",
    },
    catalogBookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CatalogBook",
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    lastReadAt: {
      type: Date,
      default: null,
    },
    finishedAt: {
      type: Date,
      default: null,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    globalFeeling: {
      type: String,
      trim: true,
      default: "",
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

bookSchema.index({ userId: 1, createdAt: 1 });
bookSchema.index({ userId: 1, status: 1, lastReadAt: -1 });

export const Book = mongoose.model("Book", bookSchema);
