import mongoose from "mongoose";

const noteSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
      trim: true,
    },
    noteReference: {
      mode: {
        type: String,
        enum: ["page", "chapter"],
      },
      start: {
        type: Number,
        min: 1,
      },
      end: {
        type: Number,
        min: 1,
      },
    },
    chapters: {
      type: [String],
      default: [],
      set: (values = []) =>
        values
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean),
    },
  },
  {
    _id: true,
    versionKey: false,
  },
);

const quoteSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
      trim: true,
    },
    page: {
      type: Number,
      required: true,
      min: 1,
    },
    speaker: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    _id: true,
    versionKey: false,
  },
);

const readingDraftSchema = new mongoose.Schema(
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
    },
    startPage: {
      type: Number,
      required: true,
      min: 1,
    },
    currentPage: {
      type: Number,
      required: true,
      min: 1,
    },
    notes: {
      type: [noteSchema],
      default: [],
    },
    quotes: {
      type: [quoteSchema],
      default: [],
    },
    sessionMode: {
      type: String,
      enum: ["start", "continue"],
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

readingDraftSchema.index({ userId: 1, bookId: 1 }, { unique: true });
readingDraftSchema.index({ userId: 1, updatedAt: -1 });

export const ReadingDraft = mongoose.model("ReadingDraft", readingDraftSchema);
