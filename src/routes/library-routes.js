import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import {
  createDraftNote,
  createDraftQuote,
  createNotesSummary,
  createSessionNote,
  createTbrBook,
  deleteBook,
  deleteDraft,
  featureBook,
  getCatalogBookCorrections,
  getAiCosts,
  getCatalogCorrections,
  getCatalogSubmissions,
  getBook,
  getBooks,
  getDraft,
  getLatestSession,
  getLibrary,
  getRecap,
  patchCatalogCorrection,
  patchCatalogSubmission,
  patchDraftPage,
  patchDraftNote,
  patchReminder,
  persistAndFinishDraft,
  persistDraft,
  patchBookDetails,
  saveReview,
  searchBookByBarcode,
  searchBooks,
  seed,
  startDraft,
} from "../controllers/library-controller.js";

export const libraryRouter = Router();

libraryRouter.post("/seed", asyncHandler(seed));
libraryRouter.get("/library", asyncHandler(getLibrary));
libraryRouter.get("/books", asyncHandler(getBooks));
libraryRouter.get("/catalog/corrections", asyncHandler(getCatalogCorrections));
libraryRouter.get("/catalog/submissions", asyncHandler(getCatalogSubmissions));
libraryRouter.get("/development/ai-costs", asyncHandler(getAiCosts));
libraryRouter.get("/catalog/:catalogBookId/corrections", asyncHandler(getCatalogBookCorrections));
libraryRouter.patch("/catalog/corrections", asyncHandler(patchCatalogCorrection));
libraryRouter.patch("/catalog/submissions", asyncHandler(patchCatalogSubmission));
libraryRouter.get("/books/:bookId", asyncHandler(getBook));
libraryRouter.post("/books", asyncHandler(createTbrBook));
libraryRouter.post("/books/search", asyncHandler(searchBooks));
libraryRouter.post("/books/search/isbn", asyncHandler(searchBookByBarcode));
libraryRouter.patch("/books/:bookId", asyncHandler(patchBookDetails));
libraryRouter.delete("/books/:bookId", asyncHandler(deleteBook));
libraryRouter.patch("/books/:bookId/featured", asyncHandler(featureBook));
libraryRouter.patch("/books/:bookId/review", asyncHandler(saveReview));
libraryRouter.post("/books/:bookId/notes-summary", asyncHandler(createNotesSummary));
libraryRouter.get("/books/:bookId/recap", asyncHandler(getRecap));
libraryRouter.get("/books/:bookId/latest-session", asyncHandler(getLatestSession));
libraryRouter.get("/drafts/active", asyncHandler(getDraft));
libraryRouter.post("/drafts/start", asyncHandler(startDraft));
libraryRouter.patch("/drafts/active/page", asyncHandler(patchDraftPage));
libraryRouter.post("/drafts/active/notes", asyncHandler(createDraftNote));
libraryRouter.patch("/drafts/active/notes/:noteId", asyncHandler(patchDraftNote));
libraryRouter.post("/drafts/active/quotes", asyncHandler(createDraftQuote));
libraryRouter.delete("/drafts/active", asyncHandler(deleteDraft));
libraryRouter.post("/drafts/active/save", asyncHandler(persistDraft));
libraryRouter.post("/drafts/active/finish", asyncHandler(persistAndFinishDraft));
libraryRouter.patch("/sessions/:sessionId/reminder", asyncHandler(patchReminder));
libraryRouter.post("/sessions/:sessionId/notes", asyncHandler(createSessionNote));
