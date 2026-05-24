import { Book } from "../models/Book.js";
import { CatalogBook } from "../models/CatalogBook.js";
import { CatalogCorrectionSuggestion } from "../models/CatalogCorrectionSuggestion.js";
import { ReadingDraft } from "../models/ReadingDraft.js";
import { ReadingSession } from "../models/ReadingSession.js";
import { upsertCatalogBookFromGoogleById } from "./google-books-service.js";
import { HttpError } from "../utils/http-error.js";
import { normalizeSearchText } from "../utils/search-normalization.js";

const CORRECTION_PROMOTION_THRESHOLD = 2;
const TITLE_SEGMENT_SEPARATORS_REGEX = /\s[-:|]\s/g;
const TITLE_NOISE_REGEX =
  /\b(e book|ebook|tome|vol|volume|book)\b|\b[0-9ivxlcdm]+\b/gu;

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

async function clearFeaturedFlags() {
  await Book.updateMany({ isFeatured: true }, { $set: { isFeatured: false } });
}

export async function getLibrarySnapshot() {
  const [books, sessions, activeDraft] = await Promise.all([
    Book.find().sort({ createdAt: 1, title: 1 }),
    ReadingSession.find().sort({ createdAt: -1 }),
    ReadingDraft.findOne().sort({ updatedAt: -1 }),
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

export async function listBooks(status) {
  const filter = status ? { status } : {};
  const books = await Book.find(filter).sort({ createdAt: 1, title: 1 });
  return books.map(serializeBook);
}

export async function getBookById(bookId) {
  const book = await Book.findById(bookId);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  return serializeBook(book);
}

export async function createBook(payload) {
  let catalogBookId = payload.catalogBookId ?? null;
  let sourceCatalogBook = null;
  let createCorrectionBaseline = null;

  if (catalogBookId) {
    sourceCatalogBook = await CatalogBook.findById(catalogBookId);
    createCorrectionBaseline = sourceCatalogBook
      ? getCatalogSharedValues(sourceCatalogBook)
      : getSourceSelectionSharedValues(payload.sourceSelection);
  }

  if (!catalogBookId && payload.googleBookId) {
    try {
      const catalogBook = await upsertCatalogBookFromGoogleById(payload.googleBookId);
      catalogBookId = catalogBook?._id ?? null;
      sourceCatalogBook = catalogBook;
      createCorrectionBaseline = catalogBook
        ? getCatalogSharedValues(catalogBook)
        : getSourceSelectionSharedValues(payload.sourceSelection);
    } catch (_error) {
      const fallbackCatalogBook = await upsertCatalogBookFromSelectionPayload(
        payload.sourceSelection ?? payload,
        payload.googleBookId,
      );
      catalogBookId = fallbackCatalogBook?._id ?? null;
      sourceCatalogBook = fallbackCatalogBook;
      createCorrectionBaseline = getSourceSelectionSharedValues(payload.sourceSelection);
    }
  }

  const createdBook = await Book.create({
    title: payload.title,
    author: payload.author,
    publisher: payload.publisher ?? "",
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

  return serializeBook(createdBook);
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
  };
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

export async function updateBookDetails(bookId, payload) {
  const book = await Book.findById(bookId);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  const previousSharedValues = {
    title: book.title,
    author: book.author,
    publisher: book.publisher,
  };

  book.title = payload.title;
  book.author = payload.author;
  book.publisher = payload.publisher ?? "";
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

  const sharedFields = ["title", "author", "publisher"];

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

export async function deleteBookById(bookId) {
  const book = await Book.findById(bookId);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  await Promise.all([
    Book.deleteOne({ _id: book._id }),
    ReadingSession.deleteMany({ bookId: book._id }),
    ReadingDraft.deleteMany({ bookId: book._id }),
  ]);

  return { ok: true };
}

export async function setFeaturedBook(bookId) {
  const book = await Book.findById(bookId);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  if (book.status !== "reading") {
    throw new HttpError(400, "Only reading books can be featured.");
  }

  await clearFeaturedFlags();
  book.isFeatured = true;
  await book.save();

  return serializeBook(book);
}

export async function updateBookReview(bookId, payload) {
  const book = await Book.findById(bookId);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  if (typeof payload.rating === "number") {
    book.rating = payload.rating;
  }

  if (typeof payload.globalFeeling === "string") {
    book.globalFeeling = payload.globalFeeling;
  }

  await book.save();
  return serializeBook(book);
}

export async function getBookRecap(bookId) {
  const [book, sessions] = await Promise.all([
    Book.findById(bookId),
    ReadingSession.find({ bookId }).sort({ createdAt: 1 }),
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

export async function getLatestSessionForBook(bookId) {
  const session = await ReadingSession.findOne({ bookId }).sort({ createdAt: -1 });
  return serializeSession(session);
}

export async function listCatalogCorrectionSuggestions(status) {
  return aggregateCatalogCorrectionSuggestions({
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

export async function getActiveDraft() {
  const draft = await ReadingDraft.findOne().sort({ updatedAt: -1 });
  return serializeDraft(draft);
}

export async function startDraftForBook(bookId) {
  const book = await Book.findById(bookId);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  await ReadingDraft.deleteMany({});

  const hasSavedSessions = await ReadingSession.exists({ bookId });
  const startPage = Math.max(1, book.currentPage || 1);
  const draft = await ReadingDraft.create({
    bookId: book._id,
    startPage,
    currentPage: startPage,
    notes: [],
    quotes: [],
    sessionMode: hasSavedSessions ? "continue" : "start",
  });

  if (book.status === "reading") {
    await clearFeaturedFlags();
    book.isFeatured = true;
    await book.save();
  }

  return serializeDraft(draft);
}

async function requireDraft() {
  const draft = await ReadingDraft.findOne().sort({ updatedAt: -1 });

  if (!draft) {
    throw new HttpError(404, "No active draft found.");
  }

  return draft;
}

export async function updateDraftPage(currentPage) {
  const draft = await requireDraft();
  const book = await Book.findById(draft.bookId);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  draft.currentPage = Math.min(Math.max(1, currentPage), book.totalPages);
  await draft.save();

  return serializeDraft(draft);
}

export async function addNoteToDraft(content, noteReference, chapters = []) {
  const draft = await requireDraft();
  draft.notes.push({ content, noteReference, chapters });
  await draft.save();
  return serializeDraft(draft);
}

export async function updateDraftNote(noteId, content, noteReference, chapters = []) {
  const draft = await requireDraft();
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

export async function addQuoteToDraft(content, page, speaker = "") {
  const draft = await requireDraft();
  draft.quotes.push({ content, page, speaker });
  await draft.save();
  return serializeDraft(draft);
}

export async function discardDraft() {
  const draft = await requireDraft();
  await ReadingDraft.deleteOne({ _id: draft._id });
  return { success: true };
}

async function persistActiveDraft(options = {}) {
  const draft = await requireDraft();
  const book = await Book.findById(draft.bookId);

  if (!book) {
    throw new HttpError(404, "Book not found.");
  }

  const now = new Date();
  const shouldFinishBook = options.finishBook === true || draft.currentPage >= book.totalPages;
  const session = await ReadingSession.create({
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

  await clearFeaturedFlags();

  book.status = shouldFinishBook ? "finished" : "reading";
  book.currentPage = draft.currentPage;
  book.startedAt = book.startedAt ?? now;
  book.lastReadAt = now;
  book.finishedAt = shouldFinishBook ? now : book.finishedAt;
  book.isFeatured = !shouldFinishBook;

  await book.save();
  await ReadingDraft.deleteOne({ _id: draft._id });

  return {
    book: serializeBook(book),
    session: serializeSession(session),
  };
}

export async function saveDraft() {
  return persistActiveDraft();
}

export async function finishDraft() {
  return persistActiveDraft({ finishBook: true });
}

export async function dismissReminder(sessionId, reminderDismissed) {
  const session = await ReadingSession.findById(sessionId);

  if (!session) {
    throw new HttpError(404, "Reading session not found.");
  }

  session.reminderDismissed = reminderDismissed;
  await session.save();

  return serializeSession(session);
}

export async function addNoteToSavedSession(sessionId, content, noteReference, chapters = []) {
  const session = await ReadingSession.findById(sessionId);

  if (!session) {
    throw new HttpError(404, "Reading session not found.");
  }

  session.notes.push({ content, noteReference, chapters });
  session.reminderDismissed = false;
  await session.save();

  return serializeSession(session);
}

export async function seedLibrary() {
  const existingBooks = await Book.countDocuments();

  if (existingBooks > 0) {
    return {
      seeded: false,
    };
  }

  await Book.insertMany([
    {
      title: "Blood Over Bright Haven",
      author: "M. L. Wang",
      totalPages: 612,
      status: "tbr",
      currentPage: 0,
    },
    {
      title: "Anathema",
      author: "Keri Lake",
      totalPages: 588,
      status: "tbr",
      currentPage: 0,
    },
    {
      title: "Dire Bound",
      author: "Sable Sorensen",
      totalPages: 435,
      status: "tbr",
      currentPage: 0,
    },
  ]);

  return {
    seeded: true,
  };
}
