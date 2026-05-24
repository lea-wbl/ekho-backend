import {
  addNoteToDraft,
  addNoteToSavedSession,
  addQuoteToDraft,
  createBook,
  deleteBookById,
  discardDraft,
  dismissReminder,
  finishDraft,
  getActiveDraft,
  getBookById,
  getCatalogCorrectionSuggestionsForBook,
  getBookRecap,
  getLatestSessionForBook,
  getLibrarySnapshot,
  listCatalogCorrectionSuggestions,
  listBooks,
  moderateCatalogCorrectionSuggestion,
  saveDraft,
  seedLibrary,
  setFeaturedBook,
  startDraftForBook,
  updateBookDetails,
  updateBookReview,
  updateDraftNote,
  updateDraftPage,
} from "../services/library-service.js";
import { searchGoogleBooks } from "../services/google-books-service.js";
import { HttpError } from "../utils/http-error.js";
import {
  optionalNoteReference,
  optionalString,
  optionalStringArray,
  requirePositiveInteger,
  requireRating,
  requireString,
} from "../validators/request.js";
import { ensureObjectId } from "../utils/object-id.js";

export async function healthCheck(_request, response) {
  response.json({
    ok: true,
    service: "ekho-backend",
  });
}

export async function getLibrary(_request, response) {
  response.json(await getLibrarySnapshot());
}

export async function getBooks(request, response) {
  const status = optionalString(request.query.status);
  response.json(await listBooks(status || undefined));
}

export async function getCatalogCorrections(request, response) {
  const status = optionalString(request.query.status);

  if (status && !["pending", "accepted", "rejected"].includes(status)) {
    throw new HttpError(400, "status must be pending, accepted, or rejected.");
  }

  response.json(await listCatalogCorrectionSuggestions(status || undefined));
}

export async function getCatalogBookCorrections(request, response) {
  ensureObjectId(request.params.catalogBookId, "catalogBookId");
  const status = optionalString(request.query.status);

  if (status && !["pending", "accepted", "rejected"].includes(status)) {
    throw new HttpError(400, "status must be pending, accepted, or rejected.");
  }

  response.json(
    await getCatalogCorrectionSuggestionsForBook(
      request.params.catalogBookId,
      status || undefined,
    ),
  );
}

export async function patchCatalogCorrection(request, response) {
  ensureObjectId(request.body.catalogBookId, "catalogBookId");
  const field = requireString(request.body.field, "field");
  const normalizedProposedValue = requireString(
    request.body.normalizedProposedValue,
    "normalizedProposedValue",
  );
  const action = requireString(request.body.action, "action");

  if (!["title", "author", "publisher"].includes(field)) {
    throw new HttpError(400, "field must be title, author, or publisher.");
  }

  if (!["accept", "reject"].includes(action)) {
    throw new HttpError(400, "action must be accept or reject.");
  }

  response.json(
    await moderateCatalogCorrectionSuggestion({
      catalogBookId: request.body.catalogBookId,
      field,
      normalizedProposedValue,
      action,
    }),
  );
}

export async function getBook(request, response) {
  response.json(await getBookById(request.params.bookId));
}

export async function createTbrBook(request, response) {
  const title = requireString(request.body.title, "title");
  const author = requireString(request.body.author, "author");
  const totalPages = requirePositiveInteger(request.body.totalPages, "totalPages");
  const catalogBookId = optionalString(request.body.catalogBookId);
  const sourceTitle = optionalString(request.body.sourceTitle);
  const sourceAuthor = optionalString(request.body.sourceAuthor);
  const sourcePublisher = optionalString(request.body.sourcePublisher);
  const sourceThumbnail = optionalString(request.body.sourceThumbnail);
  const hasSourceSelection =
    sourceTitle.length > 0 && sourceAuthor.length > 0 && request.body.sourceTotalPages !== undefined;

  let sourceSelection = null;

  if (catalogBookId) {
    ensureObjectId(catalogBookId, "catalogBookId");
  }

  if (hasSourceSelection) {
    sourceSelection = {
      title: sourceTitle,
      author: sourceAuthor,
      publisher: sourcePublisher,
      totalPages: requirePositiveInteger(request.body.sourceTotalPages, "sourceTotalPages"),
      thumbnail: sourceThumbnail,
    };
  }

  response.status(201).json(
    await createBook({
      title,
      author,
      totalPages,
      publisher: optionalString(request.body.publisher),
      thumbnail: optionalString(request.body.thumbnail),
      googleBookId: optionalString(request.body.googleBookId),
      catalogBookId: catalogBookId || null,
      sourceSelection,
    }),
  );
}

export async function searchBooks(request, response) {
  const query = requireString(request.body.query, "query", { minLength: 3 });
  response.json(await searchGoogleBooks(query));
}

export async function patchBookDetails(request, response) {
  const title = requireString(request.body.title, "title");
  const author = requireString(request.body.author, "author");
  const totalPages = requirePositiveInteger(request.body.totalPages, "totalPages");

  response.json(
    await updateBookDetails(request.params.bookId, {
      title,
      author,
      totalPages,
      publisher: optionalString(request.body.publisher),
      thumbnail: optionalString(request.body.thumbnail),
    }),
  );
}

export async function deleteBook(request, response) {
  response.json(await deleteBookById(request.params.bookId));
}

export async function featureBook(request, response) {
  response.json(await setFeaturedBook(request.params.bookId));
}

export async function saveReview(request, response) {
  const payload = {};

  if (request.body.rating !== undefined && request.body.rating !== null && request.body.rating !== "") {
    payload.rating = requireRating(request.body.rating);
  }

  if (request.body.globalFeeling !== undefined) {
    payload.globalFeeling = optionalString(request.body.globalFeeling);
  }

  response.json(await updateBookReview(request.params.bookId, payload));
}

export async function getRecap(request, response) {
  response.json(await getBookRecap(request.params.bookId));
}

export async function getLatestSession(request, response) {
  response.json(await getLatestSessionForBook(request.params.bookId));
}

export async function getDraft(_request, response) {
  response.json(await getActiveDraft());
}

export async function startDraft(request, response) {
  const bookId = requireString(request.body.bookId, "bookId");
  response.status(201).json(await startDraftForBook(bookId));
}

export async function patchDraftPage(request, response) {
  const currentPage = requirePositiveInteger(request.body.currentPage, "currentPage");
  response.json(await updateDraftPage(currentPage));
}

export async function createDraftNote(request, response) {
  const content = requireString(request.body.content, "content");
  const noteReference = optionalNoteReference(request.body.noteReference, "noteReference");
  const chapters = optionalStringArray(request.body.chapters, "chapters");
  response.status(201).json(await addNoteToDraft(content, noteReference, chapters));
}

export async function patchDraftNote(request, response) {
  const content = requireString(request.body.content, "content");
  const noteReference = optionalNoteReference(request.body.noteReference, "noteReference");
  const chapters = optionalStringArray(request.body.chapters, "chapters");
  response.json(await updateDraftNote(request.params.noteId, content, noteReference, chapters));
}

export async function createDraftQuote(request, response) {
  const content = requireString(request.body.content, "content");
  const page = requirePositiveInteger(request.body.page, "page");
  const speaker = optionalString(request.body.speaker);
  response.status(201).json(await addQuoteToDraft(content, page, speaker));
}

export async function deleteDraft(_request, response) {
  response.json(await discardDraft());
}

export async function persistDraft(_request, response) {
  response.json(await saveDraft());
}

export async function persistAndFinishDraft(_request, response) {
  response.json(await finishDraft());
}

export async function patchReminder(request, response) {
  response.json(
    await dismissReminder(
      request.params.sessionId,
      request.body.reminderDismissed === undefined ? true : Boolean(request.body.reminderDismissed),
    ),
  );
}

export async function createSessionNote(request, response) {
  const content = requireString(request.body.content, "content");
  const noteReference = optionalNoteReference(request.body.noteReference, "noteReference");
  const chapters = optionalStringArray(request.body.chapters, "chapters");
  response
    .status(201)
    .json(await addNoteToSavedSession(request.params.sessionId, content, noteReference, chapters));
}

export async function seed(_request, response) {
  response.status(201).json(await seedLibrary());
}
