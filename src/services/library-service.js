import { Book } from "../models/Book.js";
import { CatalogBook } from "../models/CatalogBook.js";
import { CatalogCorrectionSuggestion } from "../models/CatalogCorrectionSuggestion.js";
import { CatalogBookSubmission } from "../models/CatalogBookSubmission.js";
import { AiUsage } from "../models/AiUsage.js";
import { ReadingDraft } from "../models/ReadingDraft.js";
import { ReadingSession } from "../models/ReadingSession.js";
import { generateNotesSummaryWithAi } from "./ai-summary-service.js";
import { upsertCatalogBookFromGoogleById } from "./google-books-service.js";
import { HttpError } from "../utils/http-error.js";
import {
  buildSearchTokenPrefixes,
  extractMeaningfulSearchWords,
  normalizeSearchText,
} from "../utils/search-normalization.js";

const CORRECTION_PROMOTION_THRESHOLD = 2;
const MANUAL_CATALOG_SOURCE = "manual_submission";
const MIN_SEARCH_WORD_LENGTH = 3;
const TITLE_SEGMENT_SEPARATORS_REGEX = /\s[-:|]\s/g;
const TITLE_NOISE_REGEX =
  /\b(e book|ebook|tome|vol|volume|book)\b|\b[0-9ivxlcdm]+\b/gu;

function getUserScope(auth) {
  return { userId: auth.userId };
}

async function findOwnedBookOrThrow(auth, bookId) {
  const book = await Book.findOne({ _id: bookId, ...getUserScope(auth) });

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  return book;
}

async function findOwnedSessionOrThrow(auth, sessionId) {
  const session = await ReadingSession.findOne({ _id: sessionId, ...getUserScope(auth) });

  if (!session) {
    throw new HttpError(404, "Reading session not found.");
  }

  return session;
}

const serializeEmbedded = (items = []) =>
  items.map((item) => ({
    id: item._id.toString(),
    content: item.content,
    ...(item.noteReference &&
    (item.noteReference.mode === "page" || item.noteReference.mode === "chapter") &&
    typeof item.noteReference.start === "number"
      ? {
          noteReference: {
            mode: item.noteReference.mode,
            start: item.noteReference.start,
            ...(typeof item.noteReference.end === "number"
              ? { end: item.noteReference.end }
              : {}),
          },
        }
      : {}),
    ...(Array.isArray(item.chapters) && item.chapters.length > 0
      ? { chapters: item.chapters }
      : {}),
    ...(typeof item.page === "number" ? { page: item.page } : {}),
    ...(typeof item.speaker === "string" && item.speaker.trim()
      ? { speaker: item.speaker.trim() }
      : {}),
  }));

export function serializeBook(book) {
  return {
    id: book._id.toString(),
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    seriesName: book.seriesName,
    seriesNumber: book.seriesNumber,
    totalPages: book.totalPages,
    status: book.status,
    currentPage: book.currentPage,
    thumbnail: book.thumbnail,
    googleBookId: book.googleBookId,
    catalogBookId: book.catalogBookId ? book.catalogBookId.toString() : null,
    startedAt: book.startedAt ? book.startedAt.toISOString() : null,
    lastReadAt: book.lastReadAt ? book.lastReadAt.toISOString() : null,
    finishedAt: book.finishedAt ? book.finishedAt.toISOString() : null,
    rating: book.rating,
    globalFeeling: book.globalFeeling,
    notesSummary: book.notesSummary,
    notesSummaryStatus: book.notesSummaryStatus,
    notesSummaryGeneratedAt: book.notesSummaryGeneratedAt
      ? book.notesSummaryGeneratedAt.toISOString()
      : null,
    isFeatured: book.isFeatured,
    createdAt: book.createdAt?.toISOString?.() ?? null,
    updatedAt: book.updatedAt?.toISOString?.() ?? null,
  };
}

export function serializeSession(session) {
  if (!session) {
    return null;
  }

  return {
    id: session._id.toString(),
    bookId: session.bookId.toString(),
    startPage: session.startPage,
    endPage: session.endPage,
    createdAt: session.createdAt.toISOString(),
    notes: serializeEmbedded(session.notes),
    quotes: serializeEmbedded(session.quotes),
    reminderDismissed: session.reminderDismissed,
  };
}

export function serializeDraft(draft) {
  if (!draft) {
    return null;
  }

  return {
    id: draft._id.toString(),
    bookId: draft.bookId.toString(),
    startPage: draft.startPage,
    currentPage: draft.currentPage,
    notes: serializeEmbedded(draft.notes),
    quotes: serializeEmbedded(draft.quotes),
    sessionMode: draft.sessionMode,
    createdAt: draft.createdAt?.toISOString?.() ?? null,
    updatedAt: draft.updatedAt?.toISOString?.() ?? null,
  };
}

async function clearFeaturedFlags(auth) {
  await Book.updateMany(
    { ...getUserScope(auth), isFeatured: true },
    { $set: { isFeatured: false } },
  );
}

export async function getLibrarySnapshot(auth) {
  const [books, sessions, activeDraft] = await Promise.all([
    Book.find(getUserScope(auth)).sort({ createdAt: 1, title: 1 }),
    ReadingSession.find(getUserScope(auth)).sort({ createdAt: -1 }),
    ReadingDraft.findOne(getUserScope(auth)).sort({ updatedAt: -1 }),
  ]);

  const serializedBooks = books.map(serializeBook);
  const serializedSessions = sessions.map(serializeSession);
  const serializedDraft = serializeDraft(activeDraft);
  const featuredBook = serializedBooks.find(
    (book) => book.isFeatured && book.status === "reading",
  );
  const fallbackFeaturedBook = [...serializedBooks]
    .filter((book) => book.status === "reading" && book.lastReadAt)
    .sort(
      (left, right) =>
        new Date(right.lastReadAt).getTime() - new Date(left.lastReadAt).getTime(),
    )[0] ?? null;
  const activeFeaturedBook = featuredBook ?? fallbackFeaturedBook ?? null;

  return {
    featuredBookId: activeFeaturedBook?.id ?? null,
    books: serializedBooks,
    sessions: serializedSessions,
    activeDraft: serializedDraft,
    featuredBook: activeFeaturedBook,
    currentBooks: serializedBooks
      .filter((book) => book.status === "reading" && book.id !== activeFeaturedBook?.id)
      .sort(
        (left, right) =>
          new Date(right.lastReadAt ?? 0).getTime() - new Date(left.lastReadAt ?? 0).getTime(),
      ),
    nextUpBooks: serializedBooks.filter((book) => book.status === "tbr"),
    finishedBooks: serializedBooks.filter((book) => book.status === "finished"),
  };
}

export async function listBooks(auth, status) {
  const filter = status ? { ...getUserScope(auth), status } : getUserScope(auth);
  const books = await Book.find(filter).sort({ createdAt: 1, title: 1 });
  return books.map(serializeBook);
}

export async function getBookById(auth, bookId) {
  return serializeBook(await findOwnedBookOrThrow(auth, bookId));
}

export async function createBook(auth, payload) {
  let catalogBookId = payload.catalogBookId ?? null;
  let createCorrectionBaseline = null;
  let catalogReview = null;

  if (catalogBookId) {
    const sourceCatalogBook = await CatalogBook.findById(catalogBookId);
    createCorrectionBaseline = sourceCatalogBook
      ? getCatalogSharedValues(sourceCatalogBook)
      : getSourceSelectionSharedValues(payload.sourceSelection);
  }

  if (!catalogBookId && payload.googleBookId) {
    try {
      const catalogBook = await upsertCatalogBookFromGoogleById(payload.googleBookId);
      catalogBookId = catalogBook?._id ?? null;
      createCorrectionBaseline = catalogBook
        ? getCatalogSharedValues(catalogBook)
        : getSourceSelectionSharedValues(payload.sourceSelection);
    } catch (_error) {
      const fallbackCatalogBook = await upsertCatalogBookFromSelectionPayload(
        payload.sourceSelection ?? payload,
        payload.googleBookId,
      );
      catalogBookId = fallbackCatalogBook?._id ?? null;
      createCorrectionBaseline = getSourceSelectionSharedValues(payload.sourceSelection);
    }
  }

  if (!catalogBookId && !payload.googleBookId) {
    const matchedCatalogBook = await findSimilarCatalogBookForPayload(payload);

    if (matchedCatalogBook) {
      catalogBookId = matchedCatalogBook._id;
      createCorrectionBaseline = getCatalogSharedValues(matchedCatalogBook);
      catalogReview = {
        status: "matched_existing",
        catalogBookId: matchedCatalogBook._id.toString(),
      };
    }
  }

  const createdBook = await Book.create({
    userId: auth.userId,
    title: payload.title,
    author: payload.author,
    publisher: payload.publisher ?? "",
    seriesName: payload.seriesName ?? "",
    seriesNumber:
      typeof payload.seriesNumber === "number" && payload.seriesNumber > 0
        ? payload.seriesNumber
        : null,
    totalPages: Math.max(1, payload.totalPages),
    status: "tbr",
    currentPage: 0,
    thumbnail: payload.thumbnail ?? "",
    googleBookId: payload.googleBookId ?? "",
    catalogBookId,
  });

  if (createCorrectionBaseline && createdBook.catalogBookId) {
    await recordCatalogCorrectionSuggestions(
      createdBook,
      createCorrectionBaseline,
      payload,
    );
  }

  if (!createdBook.catalogBookId && !payload.googleBookId) {
    const submission = await createCatalogBookSubmission(createdBook, payload);

    if (submission) {
      catalogReview = {
        status: "pending_submission",
        submissionId: submission._id.toString(),
      };
    }
  }

  return {
    ...serializeBook(createdBook),
    ...(catalogReview ? { catalogReview } : {}),
  };
}

async function upsertCatalogBookFromSelectionPayload(selection, googleBookId) {
  const title = String(selection?.title ?? "").trim();
  const author = String(selection?.author ?? "").trim();
  const publisher = String(selection?.publisher ?? "").trim();
  const thumbnail = String(selection?.thumbnail ?? "").trim();
  const pageCount =
    typeof selection?.totalPages === "number" && selection.totalPages > 0
      ? selection.totalPages
      : null;

  if (!googleBookId || !title || !author || !pageCount) {
    return null;
  }

  const titleCandidates = buildTitleCandidates(title);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedAuthor = normalizeSearchText(author);
  const normalizedPublisher = normalizeSearchText(publisher);
  const normalizedSearchBlob = Array.from(
    new Set(
      [
        normalizedTitle,
        normalizedAuthor,
        normalizedPublisher,
        ...titleCandidates,
      ].filter(Boolean),
    ),
  ).join(" ");
  const searchTokens = buildSearchTokenPrefixes([
    normalizedTitle,
    normalizedAuthor,
    normalizedPublisher,
    ...titleCandidates,
  ]);

  return CatalogBook.findOneAndUpdate(
    { source: "google_books", sourceId: googleBookId },
    {
      $set: {
        raw: {
          title,
          subtitle: "",
          authors: [author],
          publisher,
          pageCount,
          language: "",
          industryIdentifiers: [],
          thumbnail,
        },
        search: {
          aliases: [],
          titleCandidates,
          subtitleCandidates: [],
          normalizedTitle,
          normalizedSubtitle: "",
          normalizedAuthor,
          normalizedPublisher,
          normalizedSearchBlob,
          searchTokens,
        },
        quality: {
          hasCover: Boolean(thumbnail),
          hasIsbn: false,
          pageCount,
          language: "",
        },
        lastFetchedAt: new Date(),
      },
      $setOnInsert: {
        canonical: {
          title,
          subtitle: "",
          author,
          publisher,
          seriesName: "",
          seriesNumber: null,
        },
      },
    },
    { upsert: true, new: true },
  );
}

function getCatalogSharedValues(catalogBook) {
  return {
    title: String(catalogBook?.canonical?.title || catalogBook?.raw?.title || "").trim(),
    author: String(
      catalogBook?.canonical?.author || catalogBook?.raw?.authors?.[0] || "",
    ).trim(),
    publisher: String(
      catalogBook?.canonical?.publisher || catalogBook?.raw?.publisher || "",
    ).trim(),
    seriesName: String(catalogBook?.canonical?.seriesName || "").trim(),
    seriesNumber:
      typeof catalogBook?.canonical?.seriesNumber === "number" &&
      catalogBook.canonical.seriesNumber > 0
        ? catalogBook.canonical.seriesNumber
        : null,
  };
}

async function findSimilarCatalogBookForPayload(payload) {
  const title = String(payload?.title ?? "").trim();
  const author = String(payload?.author ?? "").trim();
  const publisher = String(payload?.publisher ?? "").trim();

  if (!title || !author) {
    return null;
  }

  const normalizedTitle = normalizeSearchText(title);
  const normalizedAuthor = normalizeSearchText(author);
  const normalizedPublisher = normalizeSearchText(publisher);
  const titleCandidates = buildTitleCandidates(title);
  const titleWords = extractMeaningfulSearchWords(title).filter(
    (word) => word.length >= MIN_SEARCH_WORD_LENGTH,
  );
  const authorWords = extractMeaningfulSearchWords(author).filter(
    (word) => word.length >= MIN_SEARCH_WORD_LENGTH,
  );
  const strictTokens = Array.from(
    new Set([...titleWords.slice(0, 3), ...authorWords.slice(0, 2)]),
  );

  if (strictTokens.length === 0) {
    return null;
  }

  const strictCandidates = await CatalogBook.find({
    "search.searchTokens": { $all: strictTokens },
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(25);

  const fallbackTokens = Array.from(
    new Set([...titleWords.slice(0, 2), ...authorWords.slice(0, 1)]),
  );
  const fallbackCandidates =
    strictCandidates.length > 0 || fallbackTokens.length === 0
      ? []
      : await CatalogBook.find({
          "search.searchTokens": { $all: fallbackTokens },
        })
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(25);

  const seenIds = new Set();
  const candidates = [...strictCandidates, ...fallbackCandidates].filter((candidate) => {
    const id = candidate?._id?.toString?.();

    if (!id || seenIds.has(id)) {
      return false;
    }

    seenIds.add(id);
    return true;
  });

  let bestCandidate = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreCatalogMatch(candidate, {
      normalizedTitle,
      normalizedAuthor,
      normalizedPublisher,
      titleCandidates,
      totalPages:
        typeof payload?.totalPages === "number" && payload.totalPages > 0
          ? payload.totalPages
          : null,
    });

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestScore >= 10 ? bestCandidate : null;
}

function scoreCatalogMatch(candidate, input) {
  const candidateTitle = normalizeSearchText(
    candidate?.canonical?.title || candidate?.raw?.title || "",
  );
  const candidateAuthor = normalizeSearchText(
    candidate?.canonical?.author || candidate?.raw?.authors?.[0] || "",
  );
  const candidatePublisher = normalizeSearchText(
    candidate?.canonical?.publisher || candidate?.raw?.publisher || "",
  );
  const candidateTitleCandidates = Array.isArray(candidate?.search?.titleCandidates)
    ? candidate.search.titleCandidates.map((value) => normalizeSearchText(value)).filter(Boolean)
    : [];
  const exactTitleMatch =
    candidateTitle === input.normalizedTitle ||
    candidateTitleCandidates.includes(input.normalizedTitle) ||
    input.titleCandidates.includes(candidateTitle) ||
    candidateTitleCandidates.some((value) => input.titleCandidates.includes(value));
  const titleOverlap = computeWordOverlap(candidateTitle, input.normalizedTitle);
  const authorOverlap = computeWordOverlap(candidateAuthor, input.normalizedAuthor);
  const publisherExact =
    input.normalizedPublisher.length > 0 && candidatePublisher === input.normalizedPublisher;
  const pageClose =
    typeof input.totalPages === "number" &&
    typeof candidate?.raw?.pageCount === "number" &&
    Math.abs(candidate.raw.pageCount - input.totalPages) <= 5;
  const strongEnough =
    (exactTitleMatch && authorOverlap >= 0.75) ||
    (titleOverlap >= 0.85 && authorOverlap >= 0.85);

  if (!strongEnough) {
    return 0;
  }

  let score = 0;

  if (exactTitleMatch) {
    score += 7;
  }

  if (candidateAuthor === input.normalizedAuthor) {
    score += 4;
  } else if (authorOverlap >= 0.85) {
    score += 3;
  } else if (authorOverlap >= 0.75) {
    score += 2;
  }

  if (titleOverlap >= 0.95) {
    score += 3;
  } else if (titleOverlap >= 0.85) {
    score += 2;
  }

  if (publisherExact) {
    score += 1;
  }

  if (pageClose) {
    score += 1;
  }

  return score;
}

function computeWordOverlap(left, right) {
  const leftWords = extractMeaningfulSearchWords(left);
  const rightWords = extractMeaningfulSearchWords(right);

  if (leftWords.length === 0 || rightWords.length === 0) {
    return 0;
  }

  const rightWordSet = new Set(rightWords);
  const matchingCount = leftWords.filter((word) => rightWordSet.has(word)).length;
  return matchingCount / Math.max(leftWords.length, rightWords.length);
}

async function createCatalogBookSubmission(book, payload) {
  const title = String(payload?.title ?? "").trim();
  const author = String(payload?.author ?? "").trim();

  if (!book?._id || !title || !author) {
    return null;
  }

  return CatalogBookSubmission.findOneAndUpdate(
    {
      normalizedTitle: normalizeSearchText(title),
      normalizedAuthor: normalizeSearchText(author),
      normalizedPublisher: normalizeSearchText(payload?.publisher ?? ""),
      proposedByBookId: book._id,
    },
    {
      $setOnInsert: {
        title,
        author,
        publisher: String(payload?.publisher ?? "").trim(),
        seriesName: String(payload?.seriesName ?? "").trim(),
        seriesNumber:
          typeof payload?.seriesNumber === "number" && payload.seriesNumber > 0
            ? payload.seriesNumber
            : null,
        totalPages: Math.max(1, payload?.totalPages || 1),
        thumbnail: String(payload?.thumbnail ?? "").trim(),
        status: "pending",
      },
    },
    {
      upsert: true,
      new: true,
    },
  );
}

function getSourceSelectionSharedValues(sourceSelection) {
  if (!sourceSelection) {
    return null;
  }

  const title = String(sourceSelection.title ?? "").trim();
  const author = String(sourceSelection.author ?? "").trim();
  const publisher = String(sourceSelection.publisher ?? "").trim();

  if (!title || !author) {
    return null;
  }

  return {
    title,
    author,
    publisher,
  };
}

export async function updateBookDetails(auth, bookId, payload) {
  const book = await findOwnedBookOrThrow(auth, bookId);

  const previousSharedValues = {
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    seriesName: book.seriesName,
    seriesNumber: book.seriesNumber,
  };

  book.title = payload.title;
  book.author = payload.author;
  book.publisher = payload.publisher ?? "";
  book.seriesName = payload.seriesName ?? "";
  book.seriesNumber =
    typeof payload.seriesNumber === "number" && payload.seriesNumber > 0
      ? payload.seriesNumber
      : null;
  book.totalPages = Math.max(1, payload.totalPages);
  book.thumbnail = payload.thumbnail ?? "";
  book.currentPage = Math.min(book.currentPage, book.totalPages);

  await book.save();

  if (book.catalogBookId) {
    await recordCatalogCorrectionSuggestions(book, previousSharedValues, payload);
  }

  return serializeBook(book);
}

async function recordCatalogCorrectionSuggestions(book, previousSharedValues, payload) {
  const catalogBook = await CatalogBook.findById(book.catalogBookId);

  if (!catalogBook) {
    return;
  }

  const sharedFields = ["title", "author", "publisher", "seriesName"];

  for (const field of sharedFields) {
    const previousValue = String(previousSharedValues[field] ?? "").trim();
    const nextValue = String(payload[field] ?? "").trim();

    if (!nextValue || previousValue === nextValue) {
      continue;
    }

    const normalizedProposedValue = normalizeSearchText(nextValue);

    if (!normalizedProposedValue) {
      continue;
    }

    await CatalogCorrectionSuggestion.findOneAndUpdate(
      {
        catalogBookId: catalogBook._id,
        field,
        normalizedProposedValue,
        proposedByBookId: book._id,
      },
      {
        $setOnInsert: {
          sourceId: catalogBook.sourceId,
          proposedValue: nextValue,
          status: "pending",
        },
      },
      {
        upsert: true,
        new: true,
      },
    );

    await maybePromoteCatalogCorrection(catalogBook._id, field, normalizedProposedValue);
  }
}

async function maybePromoteCatalogCorrection(catalogBookId, field, normalizedProposedValue) {
  const matchingSuggestions = await CatalogCorrectionSuggestion.find({
    catalogBookId,
    field,
    normalizedProposedValue,
    status: { $in: ["pending", "accepted"] },
  }).sort({ createdAt: 1 });

  if (matchingSuggestions.length < CORRECTION_PROMOTION_THRESHOLD) {
    return;
  }

  const acceptedSuggestion =
    matchingSuggestions.find((suggestion) => suggestion.status === "accepted") ??
    matchingSuggestions[0];

  if (!acceptedSuggestion?.proposedValue?.trim()) {
    return;
  }

  const catalogBook = await CatalogBook.findById(catalogBookId);

  if (!catalogBook) {
    return;
  }

  applyCanonicalCorrection(catalogBook, field, acceptedSuggestion.proposedValue.trim());
  await catalogBook.save();

  await CatalogCorrectionSuggestion.updateMany(
    {
      catalogBookId,
      field,
      normalizedProposedValue,
    },
    {
      $set: {
        status: "accepted",
      },
    },
  );
}

function applyCanonicalCorrection(catalogBook, field, value) {
  catalogBook.canonical[field] = value;

  if (field === "title") {
    const titleCandidates = buildTitleCandidates(value);
    catalogBook.search.titleCandidates = titleCandidates;
    catalogBook.search.normalizedTitle = normalizeSearchText(value);
  }

  if (field === "author") {
    catalogBook.search.normalizedAuthor = normalizeSearchText(value);
  }

  if (field === "publisher") {
    catalogBook.search.normalizedPublisher = normalizeSearchText(value);
  }

  const normalizedValues = [
    catalogBook.search.normalizedTitle,
    catalogBook.search.normalizedSubtitle,
    catalogBook.search.normalizedAuthor,
    catalogBook.search.normalizedPublisher,
    ...(Array.isArray(catalogBook.search.titleCandidates)
      ? catalogBook.search.titleCandidates
      : []),
    ...(Array.isArray(catalogBook.search.subtitleCandidates)
      ? catalogBook.search.subtitleCandidates
      : []),
    ...(Array.isArray(catalogBook.search.aliases) ? catalogBook.search.aliases : []),
  ]
    .map((entry) => normalizeSearchText(entry))
    .filter(Boolean);

  catalogBook.search.normalizedSearchBlob = Array.from(new Set(normalizedValues)).join(" ");
  catalogBook.search.searchTokens = buildSearchTokenPrefixes(normalizedValues);
}

function buildTitleCandidates(title) {
  const normalizedTitle = normalizeSearchText(title);
  const segments = String(title ?? "")
    .split(TITLE_SEGMENT_SEPARATORS_REGEX)
    .map((segment) => normalizeSearchText(segment))
    .filter(Boolean);
  const cleanedFullTitle = cleanTitleCandidate(normalizedTitle);
  const cleanedSegments = segments.map(cleanTitleCandidate).filter(Boolean);

  return Array.from(
    new Set(
      [
        normalizedTitle,
        cleanedFullTitle,
        ...segments,
        ...cleanedSegments,
      ].filter(Boolean),
    ),
  );
}

function cleanTitleCandidate(candidate) {
  return String(candidate ?? "")
    .replace(TITLE_NOISE_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function aggregateCatalogCorrectionSuggestions(match) {
  const groupedSuggestions = await CatalogCorrectionSuggestion.aggregate([
    {
      $match: match,
    },
    {
      $group: {
        _id: {
          catalogBookId: "$catalogBookId",
          sourceId: "$sourceId",
          field: "$field",
          normalizedProposedValue: "$normalizedProposedValue",
          status: "$status",
        },
        proposedValue: { $first: "$proposedValue" },
        count: { $sum: 1 },
        latestUpdatedAt: { $max: "$updatedAt" },
        firstCreatedAt: { $min: "$createdAt" },
      },
    },
    {
      $sort: {
        latestUpdatedAt: -1,
      },
    },
  ]);

  const catalogBookIds = Array.from(
    new Set(
      groupedSuggestions.map((entry) => entry._id.catalogBookId?.toString()).filter(Boolean),
    ),
  );
  const catalogBooks = await CatalogBook.find({
    _id: { $in: catalogBookIds },
  });
  const catalogBookMap = new Map(
    catalogBooks.map((catalogBook) => [catalogBook._id.toString(), catalogBook]),
  );

  return groupedSuggestions.map((entry) => {
    const catalogBookId = entry._id.catalogBookId.toString();
    const catalogBook = catalogBookMap.get(catalogBookId) ?? null;
    const field = entry._id.field;
    const canonicalValue =
      catalogBook?.canonical && typeof catalogBook.canonical[field] === "string"
        ? catalogBook.canonical[field]
        : "";

    return {
      catalogBookId,
      sourceId: entry._id.sourceId,
      field,
      proposedValue: entry.proposedValue,
      normalizedProposedValue: entry._id.normalizedProposedValue,
      status: entry._id.status,
      count: entry.count,
      canonicalValue,
      rawTitle: catalogBook?.raw?.title ?? "",
      rawSubtitle: catalogBook?.raw?.subtitle ?? "",
      rawAuthors: Array.isArray(catalogBook?.raw?.authors) ? catalogBook.raw.authors : [],
      firstCreatedAt: entry.firstCreatedAt?.toISOString?.() ?? null,
      latestUpdatedAt: entry.latestUpdatedAt?.toISOString?.() ?? null,
    };
  });
}

async function aggregateCatalogBookSubmissions(match) {
  const groupedSubmissions = await CatalogBookSubmission.aggregate([
    {
      $match: match,
    },
    {
      $group: {
        _id: {
          normalizedTitle: "$normalizedTitle",
          normalizedAuthor: "$normalizedAuthor",
          normalizedPublisher: "$normalizedPublisher",
          status: "$status",
        },
        title: { $first: "$title" },
        author: { $first: "$author" },
        publisher: { $first: "$publisher" },
        seriesName: { $first: "$seriesName" },
        seriesNumber: { $first: "$seriesNumber" },
        totalPages: { $max: "$totalPages" },
        thumbnail: { $first: "$thumbnail" },
        createdCatalogBookId: { $first: "$createdCatalogBookId" },
        count: { $sum: 1 },
        latestUpdatedAt: { $max: "$updatedAt" },
        firstCreatedAt: { $min: "$createdAt" },
      },
    },
    {
      $sort: {
        latestUpdatedAt: -1,
      },
    },
  ]);

  return groupedSubmissions.map((entry) => ({
    normalizedTitle: entry._id.normalizedTitle,
    normalizedAuthor: entry._id.normalizedAuthor,
    normalizedPublisher: entry._id.normalizedPublisher,
    status: entry._id.status,
    title: entry.title,
    author: entry.author,
    publisher: entry.publisher,
    seriesName: entry.seriesName,
    seriesNumber: entry.seriesNumber ?? null,
    totalPages: entry.totalPages,
    thumbnail: entry.thumbnail,
    createdCatalogBookId: entry.createdCatalogBookId?.toString?.() ?? null,
    count: entry.count,
    firstCreatedAt: entry.firstCreatedAt?.toISOString?.() ?? null,
    latestUpdatedAt: entry.latestUpdatedAt?.toISOString?.() ?? null,
  }));
}

export async function deleteBookById(auth, bookId) {
  const book = await findOwnedBookOrThrow(auth, bookId);

  await Promise.all([
    Book.deleteOne({ _id: book._id, ...getUserScope(auth) }),
    ReadingSession.deleteMany({ ...getUserScope(auth), bookId: book._id }),
    ReadingDraft.deleteMany({ ...getUserScope(auth), bookId: book._id }),
    AiUsage.deleteMany({ ...getUserScope(auth), bookId: book._id }),
  ]);

  return { ok: true };
}

export async function setFeaturedBook(auth, bookId) {
  const book = await findOwnedBookOrThrow(auth, bookId);

  if (book.status !== "reading") {
    throw new HttpError(400, "Only reading books can be featured.");
  }

  await clearFeaturedFlags(auth);
  book.isFeatured = true;
  await book.save();

  return serializeBook(book);
}

export async function updateBookReview(auth, bookId, payload) {
  const book = await findOwnedBookOrThrow(auth, bookId);

  if (typeof payload.rating === "number") {
    book.rating = payload.rating;
  }

  if (typeof payload.globalFeeling === "string") {
    book.globalFeeling = payload.globalFeeling;
  }

  if (typeof payload.notesSummary === "string") {
    book.notesSummary = payload.notesSummary.trim();
    book.notesSummaryStatus = book.notesSummary ? "saved" : "dismissed";
    book.notesSummaryGeneratedAt = book.notesSummary ? new Date() : null;
  }

  await book.save();
  return serializeBook(book);
}

export async function generateBookNotesSummary(auth, bookId) {
  const [book, sessions] = await Promise.all([
    findOwnedBookOrThrow(auth, bookId),
    ReadingSession.find({ ...getUserScope(auth), bookId }).sort({ createdAt: 1 }),
  ]);

  const serializedSessions = sessions.map(serializeSession);
  const notes = serializedSessions.flatMap((session) => session.notes);
  const result = await generateNotesSummaryWithAi({ auth, book, notes });

  return {
    book: serializeBook(book),
    notesSummary: result.notesSummary,
    usage: result.usage,
  };
}

export async function getAiCostSummary(auth) {
  const usageEntries = await AiUsage.find(getUserScope(auth)).sort({ createdAt: -1 }).limit(100);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const currentMonthEntries = usageEntries.filter(
    (entry) => entry.createdAt && entry.createdAt >= monthStart,
  );

  return {
    total: summarizeUsageEntries(usageEntries),
    currentMonth: summarizeUsageEntries(currentMonthEntries),
    recent: usageEntries.slice(0, 25).map((entry) => ({
      id: entry._id.toString(),
      bookId: entry.bookId.toString(),
      feature: entry.feature,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      estimatedCostUsd: entry.estimatedCostUsd,
      inputCharacters: entry.inputCharacters,
      noteCount: entry.noteCount,
      createdAt: entry.createdAt?.toISOString?.() ?? null,
    })),
  };
}

function summarizeUsageEntries(entries) {
  return entries.reduce(
    (summary, entry) => ({
      requestCount: summary.requestCount + 1,
      inputTokens: summary.inputTokens + entry.inputTokens,
      outputTokens: summary.outputTokens + entry.outputTokens,
      totalTokens: summary.totalTokens + entry.totalTokens,
      estimatedCostUsd: summary.estimatedCostUsd + entry.estimatedCostUsd,
    }),
    {
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    },
  );
}

export async function getBookRecap(auth, bookId) {
  const [book, sessions] = await Promise.all([
    Book.findOne({ _id: bookId, ...getUserScope(auth) }),
    ReadingSession.find({ ...getUserScope(auth), bookId }).sort({ createdAt: 1 }),
  ]);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  const serializedSessions = sessions.map(serializeSession);
  const notes = serializedSessions.flatMap((session) => session.notes);
  const quotes = serializedSessions.flatMap((session) => session.quotes);
  const startedAt = book.startedAt ?? sessions[0]?.createdAt ?? null;
  const finishedAt = book.finishedAt ?? book.lastReadAt ?? sessions.at(-1)?.createdAt ?? null;
  const durationInDays =
    startedAt && finishedAt
      ? Math.max(
          1,
          Math.ceil(
            (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        )
      : 0;

  return {
    book: serializeBook(book),
    sessions: serializedSessions,
    notes,
    quotes,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
    durationInDays,
  };
}

export async function getLatestSessionForBook(auth, bookId) {
  const session = await ReadingSession.findOne({ ...getUserScope(auth), bookId }).sort({
    createdAt: -1,
  });
  return serializeSession(session);
}

export async function listCatalogCorrectionSuggestions(status) {
  return aggregateCatalogCorrectionSuggestions({
    ...(status ? { status } : {}),
  });
}

export async function listCatalogBookSubmissions(status) {
  return aggregateCatalogBookSubmissions({
    ...(status ? { status } : {}),
  });
}

export async function getCatalogCorrectionSuggestionsForBook(catalogBookId, status) {
  const catalogBook = await CatalogBook.findById(catalogBookId);

  if (!catalogBook) {
    throw new HttpError(404, "Catalog book not found.");
  }

  return aggregateCatalogCorrectionSuggestions({
    catalogBookId: catalogBook._id,
    ...(status ? { status } : {}),
  });
}

export async function moderateCatalogCorrectionSuggestion({
  catalogBookId,
  field,
  normalizedProposedValue,
  action,
}) {
  const catalogBook = await CatalogBook.findById(catalogBookId);

  if (!catalogBook) {
    throw new HttpError(404, "Catalog book not found.");
  }

  const matchingSuggestions = await CatalogCorrectionSuggestion.find({
    catalogBookId: catalogBook._id,
    field,
    normalizedProposedValue,
  }).sort({ createdAt: 1 });

  if (matchingSuggestions.length === 0) {
    throw new HttpError(404, "Catalog correction suggestion not found.");
  }

  if (action === "reject") {
    await CatalogCorrectionSuggestion.updateMany(
      {
        catalogBookId: catalogBook._id,
        field,
        normalizedProposedValue,
      },
      {
        $set: {
          status: "rejected",
        },
      },
    );
  } else {
    const acceptedSuggestion = matchingSuggestions[0];

    if (!acceptedSuggestion?.proposedValue?.trim()) {
      throw new HttpError(400, "Catalog correction suggestion has no proposed value.");
    }

    applyCanonicalCorrection(catalogBook, field, acceptedSuggestion.proposedValue.trim());
    await catalogBook.save();

    await CatalogCorrectionSuggestion.updateMany(
      {
        catalogBookId: catalogBook._id,
        field,
        normalizedProposedValue,
      },
      {
        $set: {
          status: "accepted",
        },
      },
    );
  }

  const [updatedAggregate] = await aggregateCatalogCorrectionSuggestions({
    catalogBookId: catalogBook._id,
    field,
    normalizedProposedValue,
  });

  return updatedAggregate ?? null;
}

export async function moderateCatalogBookSubmission({
  normalizedTitle,
  normalizedAuthor,
  normalizedPublisher,
  action,
}) {
  const matchingSubmissions = await CatalogBookSubmission.find({
    normalizedTitle,
    normalizedAuthor,
    normalizedPublisher,
  }).sort({ createdAt: 1 });

  if (matchingSubmissions.length === 0) {
    throw new HttpError(404, "Catalog book submission not found.");
  }

  if (action === "reject") {
    await CatalogBookSubmission.updateMany(
      {
        normalizedTitle,
        normalizedAuthor,
        normalizedPublisher,
      },
      {
        $set: {
          status: "rejected",
        },
      },
    );
  } else {
    const acceptedSubmission = matchingSubmissions[0];
    let catalogBook = await findSimilarCatalogBookForPayload(acceptedSubmission);

    if (!catalogBook) {
      catalogBook = await createCatalogBookFromManualSubmission(acceptedSubmission);
    }

    if (!catalogBook?._id) {
      throw new HttpError(400, "Unable to create catalog book from submission.");
    }

    const proposedBookIds = matchingSubmissions
      .map((submission) => submission.proposedByBookId)
      .filter(Boolean);

    await Book.updateMany(
      {
        _id: { $in: proposedBookIds },
        catalogBookId: null,
      },
      {
        $set: {
          catalogBookId: catalogBook._id,
        },
      },
    );

    await CatalogBookSubmission.updateMany(
      {
        normalizedTitle,
        normalizedAuthor,
        normalizedPublisher,
      },
      {
        $set: {
          status: "accepted",
          createdCatalogBookId: catalogBook._id,
        },
      },
    );
  }

  const [updatedAggregate] = await aggregateCatalogBookSubmissions({
    normalizedTitle,
    normalizedAuthor,
    normalizedPublisher,
  });

  return updatedAggregate ?? null;
}

async function createCatalogBookFromManualSubmission(submission) {
  const title = String(submission?.title ?? "").trim();
  const author = String(submission?.author ?? "").trim();
  const publisher = String(submission?.publisher ?? "").trim();
  const seriesName = String(submission?.seriesName ?? "").trim();
  const seriesNumber =
    typeof submission?.seriesNumber === "number" && submission.seriesNumber > 0
      ? submission.seriesNumber
      : null;
  const thumbnail = String(submission?.thumbnail ?? "").trim();
  const pageCount =
    typeof submission?.totalPages === "number" && submission.totalPages > 0
      ? submission.totalPages
      : null;

  if (!submission?._id || !title || !author || !pageCount) {
    return null;
  }

  const titleCandidates = buildTitleCandidates(title);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedAuthor = normalizeSearchText(author);
  const normalizedPublisher = normalizeSearchText(publisher);
  const normalizedSearchBlob = Array.from(
    new Set(
      [normalizedTitle, normalizedAuthor, normalizedPublisher, ...titleCandidates].filter(Boolean),
    ),
  ).join(" ");
  const searchTokens = buildSearchTokenPrefixes([
    normalizedTitle,
    normalizedAuthor,
    normalizedPublisher,
    ...titleCandidates,
  ]);

  return CatalogBook.findOneAndUpdate(
    { source: MANUAL_CATALOG_SOURCE, sourceId: submission._id.toString() },
    {
      $set: {
        raw: {
          title,
          subtitle: "",
          authors: [author],
          publisher,
          pageCount,
          language: "",
          industryIdentifiers: [],
          thumbnail,
        },
        canonical: {
          title,
          subtitle: "",
          author,
          publisher,
          seriesName,
          seriesNumber,
        },
        search: {
          aliases: [],
          titleCandidates,
          subtitleCandidates: [],
          normalizedTitle,
          normalizedSubtitle: "",
          normalizedAuthor,
          normalizedPublisher,
          normalizedSearchBlob,
          searchTokens,
        },
        quality: {
          hasCover: Boolean(thumbnail),
          hasIsbn: false,
          pageCount,
          language: "",
        },
        lastFetchedAt: null,
      },
    },
    { upsert: true, new: true },
  );
}

export async function getActiveDraft(auth) {
  const draft = await ReadingDraft.findOne(getUserScope(auth)).sort({ updatedAt: -1 });
  return serializeDraft(draft);
}

export async function startDraftForBook(auth, bookId) {
  const book = await findOwnedBookOrThrow(auth, bookId);

  await ReadingDraft.deleteMany(getUserScope(auth));

  const hasSavedSessions = await ReadingSession.exists({ ...getUserScope(auth), bookId });
  const startPage = Math.max(1, book.currentPage || 1);
  const draft = await ReadingDraft.create({
    userId: auth.userId,
    bookId: book._id,
    startPage,
    currentPage: startPage,
    notes: [],
    quotes: [],
    sessionMode: hasSavedSessions ? "continue" : "start",
  });

  if (book.status === "reading") {
    await clearFeaturedFlags(auth);
    book.isFeatured = true;
    await book.save();
  }

  return serializeDraft(draft);
}

async function requireDraft(auth) {
  const draft = await ReadingDraft.findOne(getUserScope(auth)).sort({ updatedAt: -1 });

  if (!draft) {
    throw new HttpError(404, "No active draft found.");
  }

  return draft;
}

export async function updateDraftPage(auth, currentPage) {
  const draft = await requireDraft(auth);
  const book = await findOwnedBookOrThrow(auth, draft.bookId);

  draft.currentPage = Math.min(Math.max(1, currentPage), book.totalPages);
  await draft.save();

  return serializeDraft(draft);
}

export async function addNoteToDraft(auth, content, noteReference, chapters = []) {
  const draft = await requireDraft(auth);
  draft.notes.push({ content, noteReference, chapters });
  await draft.save();
  return serializeDraft(draft);
}

export async function updateDraftNote(auth, noteId, content, noteReference, chapters = []) {
  const draft = await requireDraft(auth);
  const note = draft.notes.id(noteId);

  if (!note) {
    throw new HttpError(404, "Note not found.");
  }

  note.content = content;
  note.noteReference = noteReference;
  note.chapters = chapters;
  await draft.save();
  return serializeDraft(draft);
}

export async function addQuoteToDraft(auth, content, page, speaker = "") {
  const draft = await requireDraft(auth);
  draft.quotes.push({ content, page, speaker });
  await draft.save();
  return serializeDraft(draft);
}

export async function discardDraft(auth) {
  const draft = await requireDraft(auth);
  await ReadingDraft.deleteOne({ _id: draft._id, ...getUserScope(auth) });
  return { success: true };
}

async function persistActiveDraft(auth, options = {}) {
  const draft = await requireDraft(auth);
  const book = await findOwnedBookOrThrow(auth, draft.bookId);

  const now = new Date();
  const shouldFinishBook = options.finishBook === true || draft.currentPage >= book.totalPages;
  const session = await ReadingSession.create({
    userId: auth.userId,
    bookId: draft.bookId,
    startPage: draft.startPage,
    endPage: draft.currentPage,
    notes: draft.notes.map((note) => ({
      content: note.content,
      ...(note.noteReference
        ? {
            noteReference: {
              mode: note.noteReference.mode,
              start: note.noteReference.start,
              ...(typeof note.noteReference.end === "number"
                ? { end: note.noteReference.end }
                : {}),
            },
          }
        : {}),
      chapters: note.chapters ?? [],
    })),
    quotes: draft.quotes.map((quote) => ({
      content: quote.content,
      page: quote.page,
      speaker: quote.speaker ?? "",
    })),
    reminderDismissed: false,
    createdAt: now,
  });

  await clearFeaturedFlags(auth);

  book.status = shouldFinishBook ? "finished" : "reading";
  book.currentPage = draft.currentPage;
  book.startedAt = book.startedAt ?? now;
  book.lastReadAt = now;
  book.finishedAt = shouldFinishBook ? now : book.finishedAt;
  book.isFeatured = !shouldFinishBook;

  await book.save();
  await ReadingDraft.deleteOne({ _id: draft._id, ...getUserScope(auth) });

  return {
    book: serializeBook(book),
    session: serializeSession(session),
  };
}

export async function saveDraft(auth) {
  return persistActiveDraft(auth);
}

export async function finishDraft(auth) {
  return persistActiveDraft(auth, { finishBook: true });
}

export async function dismissReminder(auth, sessionId, reminderDismissed) {
  const session = await findOwnedSessionOrThrow(auth, sessionId);

  session.reminderDismissed = reminderDismissed;
  await session.save();

  return serializeSession(session);
}

export async function addNoteToSavedSession(
  auth,
  sessionId,
  content,
  noteReference,
  chapters = [],
) {
  const session = await findOwnedSessionOrThrow(auth, sessionId);

  session.notes.push({ content, noteReference, chapters });
  session.reminderDismissed = false;
  await session.save();

  return serializeSession(session);
}

export async function seedLibrary(auth) {
  return {
    seeded: false,
  };
}
