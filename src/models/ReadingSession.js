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

const readingSessionSchema = new mongoose.Schema(
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
    startPage: {
      type: Number,
      required: true,
      min: 1,
    },
    endPage: {
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
    reminderDismissed: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    updatedAt: false,
    versionKey: false,
  },
);

readingSessionSchema.index({ userId: 1, bookId: 1, createdAt: -1 });

export const ReadingSession = mongoose.model("ReadingSession", readingSessionSchema);
