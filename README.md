# EKHO Backend

Standalone Node + MongoDB API for the EKHO app.

## Stack

- Node 20+
- Express 5
- MongoDB + Mongoose

## Setup

1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI`.
3. Optionally set `GOOGLE_BOOKS_API_KEY` to proxy Google Books search through the backend.
4. Set Clerk environment variables:
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
   - Optional: `CLERK_JWT_KEY` for networkless JWT verification
   - Optional: `CLERK_AUTHORIZED_PARTIES` as a comma-separated allowlist
5. Install dependencies with `npm install`.
6. Start the server with `npm run dev`.

## Auth

- `GET /api/health` is public.
- All other `/api` routes require a valid Clerk session token in the `Authorization: Bearer ...` header.
- The backend verifies Clerk tokens with `@clerk/backend`.
- `AUTH_MODE=development` is the current local default and uses `DEV_AUTH_USER_ID`.

## Data ownership

- `Book`, `ReadingSession`, and `ReadingDraft` are now user-scoped.
- Existing MongoDB records created before this change do not have `userId` and will not be returned until migrated.

## API Summary

- `GET /api/health`
- `GET /api/library`
- `GET /api/books?status=tbr|reading|finished`
- `GET /api/books/:bookId`
- `POST /api/books/search` with `{ "query": "..." }`
- `POST /api/books` to add a TBR book
- `PATCH /api/books/:bookId`
- `DELETE /api/books/:bookId`
- `PATCH /api/books/:bookId/featured`
- `PATCH /api/books/:bookId/review`
- `GET /api/books/:bookId/recap`
- `GET /api/books/:bookId/latest-session`
- `GET /api/drafts/active`
- `POST /api/drafts/start`
- `PATCH /api/drafts/active/page`
- `POST /api/drafts/active/notes`
- `POST /api/drafts/active/quotes`
- `DELETE /api/drafts/active`
- `POST /api/drafts/active/save`
- `POST /api/drafts/active/finish`
- `PATCH /api/sessions/:sessionId/reminder`
- `POST /api/sessions/:sessionId/notes`

## Frontend Mapping

The backend mirrors the current app state model:

- books
- sessions
- active draft session
- featured reading book
- finished-book review fields
- recap aggregates

The intended frontend swap is replacing `constants/mockReadingState.ts` mutations with these HTTP endpoints.

## Capture Metadata

The capture endpoints support extra optional metadata used by the session UI:

- `POST /api/drafts/active/notes` accepts `{ content, noteReference?: { mode: "page" | "chapter", start: number, end?: number }, chapters?: string[] }`
- `POST /api/drafts/active/quotes` accepts `{ content, page, speaker?: string }`
- `POST /api/sessions/:sessionId/notes` accepts `{ content, noteReference?: { mode: "page" | "chapter", start: number, end?: number }, chapters?: string[] }`

Those fields are also returned in draft/session payloads when present:

- note objects may include `noteReference: { mode: "page" | "chapter", start: number, end?: number }`
- note objects may include `chapters: string[]`
- quote objects may include `speaker: string`
