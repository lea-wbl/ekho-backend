import mongoose from "mongoose";

const identifierSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      trim: true,
      default: "",
    },
    identifier: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false },
);

const catalogBookSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ["google_books", "manual_submission"],
      default: "google_books",
      required: true,
    },
    sourceId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    raw: {
      title: {
        type: String,
        trim: true,
        default: "",
      },
      subtitle: {
        type: String,
        trim: true,
        default: "",
      },
      authors: {
        type: [String],
        default: [],
      },
      publisher: {
        type: String,
        trim: true,
        default: "",
      },
      pageCount: {
        type: Number,
        default: null,
      },
      language: {
        type: String,
        trim: true,
        default: "",
      },
      industryIdentifiers: {
        type: [identifierSchema],
        default: [],
      },
      thumbnail: {
        type: String,
        trim: true,
        default: "",
      },
    },
    canonical: {
      title: {
        type: String,
        trim: true,
        default: "",
      },
      subtitle: {
        type: String,
        trim: true,
        default: "",
      },
      author: {
        type: String,
        trim: true,
        default: "",
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
    },
    search: {
      aliases: {
        type: [String],
        default: [],
      },
      titleCandidates: {
        type: [String],
        default: [],
      },
      subtitleCandidates: {
        type: [String],
        default: [],
      },
      normalizedTitle: {
        type: String,
        trim: true,
        default: "",
      },
      normalizedSubtitle: {
        type: String,
        trim: true,
        default: "",
      },
      normalizedAuthor: {
        type: String,
        trim: true,
        default: "",
      },
      normalizedPublisher: {
        type: String,
        trim: true,
        default: "",
      },
      normalizedSearchBlob: {
        type: String,
        trim: true,
        default: "",
      },
      searchTokens: {
        type: [String],
        default: [],
      },
    },
    quality: {
      hasCover: {
        type: Boolean,
        default: false,
      },
      hasIsbn: {
        type: Boolean,
        default: false,
      },
      pageCount: {
        type: Number,
        default: null,
      },
      language: {
        type: String,
        trim: true,
        default: "",
      },
    },
    lastFetchedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

catalogBookSchema.index({ source: 1, sourceId: 1 }, { unique: true });
catalogBookSchema.index({ "search.searchTokens": 1 });

export const CatalogBook = mongoose.model("CatalogBook", catalogBookSchema);
