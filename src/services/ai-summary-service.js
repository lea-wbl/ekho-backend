import OpenAI from "openai";
import { env } from "../config/env.js";
import { AiUsage } from "../models/AiUsage.js";
import { HttpError } from "../utils/http-error.js";

const FEATURE_NOTES_SUMMARY = "notes_summary";
const MAX_NOTES_PER_SUMMARY = 200;
const MAX_NOTE_CHARACTERS = 40_000;
const MAX_OUTPUT_TOKENS = 1_800;

const MODEL_PRICING_PER_MILLION = {
  "gpt-5-nano": {
    input: 0.05,
    output: 0.4,
  },
  "gpt-5-mini": {
    input: 0.25,
    output: 2,
  },
};

let openAiClient = null;

function getOpenAiClient() {
  if (!env.openAiApiKey) {
    throw new HttpError(503, "OpenAI is not configured. Set OPENAI_API_KEY on the backend.");
  }

  if (!openAiClient) {
    openAiClient = new OpenAI({
      apiKey: env.openAiApiKey,
    });
  }

  return openAiClient;
}

export async function assertNotesSummaryQuota(auth) {
  if (!Number.isFinite(env.aiNotesSummaryMonthlyLimit) || env.aiNotesSummaryMonthlyLimit <= 0) {
    return;
  }

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const usageCount = await AiUsage.countDocuments({
    userId: auth.userId,
    feature: FEATURE_NOTES_SUMMARY,
    createdAt: { $gte: monthStart },
  });

  if (usageCount >= env.aiNotesSummaryMonthlyLimit) {
    throw new HttpError(
      429,
      `Monthly AI summary limit reached (${env.aiNotesSummaryMonthlyLimit}).`,
    );
  }
}

export async function generateNotesSummaryWithAi({ auth, book, notes }) {
  const preparedNotes = prepareNotesForSummary(notes);

  if (preparedNotes.length === 0) {
    throw new HttpError(400, "No notes found for this book.");
  }

  await assertNotesSummaryQuota(auth);

  const model = env.openAiNotesSummaryModel;
  const prompt = buildPrompt({ book, notes: preparedNotes });
  const response = await getOpenAiClient().responses.create({
    model,
    input: prompt,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: "low" },
    store: false,
  });

  const notesSummary = extractResponseText(response).trim();

  if (!notesSummary) {
    const incompleteReason = response.incomplete_details?.reason;

    if (response.status === "incomplete" && incompleteReason === "max_output_tokens") {
      throw new HttpError(
        502,
        "OpenAI ran out of output tokens before returning a summary. Try again with a shorter set of notes.",
      );
    }

    throw new HttpError(502, "OpenAI returned an empty summary. Try again in a moment.");
  }

  const usage = normalizeUsage(response.usage);
  const estimatedCostUsd = estimateCostUsd(model, usage);

  await AiUsage.create({
    userId: auth.userId,
    bookId: book._id,
    feature: FEATURE_NOTES_SUMMARY,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd,
    inputCharacters: prompt.length,
    noteCount: preparedNotes.length,
  });

  return {
    notesSummary,
    usage: {
      ...usage,
      estimatedCostUsd,
      model,
      noteCount: preparedNotes.length,
      inputCharacters: prompt.length,
    },
  };
}

function prepareNotesForSummary(notes) {
  const preparedNotes = [];
  let characterCount = 0;

  for (const note of notes) {
    if (preparedNotes.length >= MAX_NOTES_PER_SUMMARY) {
      break;
    }

    const content = String(note.content ?? "").trim();

    if (!content) {
      continue;
    }

    const reference = formatNoteReference(note.noteReference, note.chapters);
    const line = `${reference ? `${reference}: ` : ""}${content}`;
    const remainingCharacters = MAX_NOTE_CHARACTERS - characterCount;

    if (remainingCharacters <= 0) {
      break;
    }

    const trimmedLine =
      line.length > remainingCharacters ? line.slice(0, remainingCharacters).trim() : line;

    preparedNotes.push(trimmedLine);
    characterCount += trimmedLine.length;
  }

  return preparedNotes;
}

function buildPrompt({ book, notes }) {
  const seriesLine = book.seriesName
    ? `Series: ${book.seriesName}${book.seriesNumber ? ` #${book.seriesNumber}` : ""}`
    : "Series: Not specified";

  return [
    "You summarize personal reading notes for a reader who just finished a book.",
    "",
    "Use only the notes provided. Do not invent plot details, characters, or events.",
    "Preserve the reader's personal reactions when present.",
    "Write in a clear, warm, second-person style.",
    "Return plain text with these sections: Main recap, Key details to remember, Open threads, Personal impressions.",
    "",
    `Book: ${book.title}`,
    `Author: ${book.author}`,
    seriesLine,
    "",
    "Notes in reading order:",
    notes.map((note, index) => `${index + 1}. ${note}`).join("\n"),
  ].join("\n");
}

function formatNoteReference(noteReference, chapters) {
  if (noteReference?.mode && typeof noteReference.start === "number") {
    const label = noteReference.mode === "chapter" ? "Chapter" : "Page";
    const end =
      typeof noteReference.end === "number" && noteReference.end > noteReference.start
        ? `-${noteReference.end}`
        : "";

    return `${label} ${noteReference.start}${end}`;
  }

  const chapterList = Array.isArray(chapters)
    ? chapters.map((chapter) => String(chapter).trim()).filter(Boolean)
    : [];

  return chapterList.length > 0 ? `Chapter ${chapterList.join(", ")}` : "";
}

function normalizeUsage(usage) {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
  };
}

function extractResponseText(response) {
  const outputText = typeof response.output_text === "string" ? response.output_text : "";

  if (outputText.trim()) {
    return outputText;
  }

  if (!Array.isArray(response.output)) {
    return "";
  }

  return response.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((content) => {
      if (typeof content?.text === "string") {
        return content.text;
      }

      return "";
    })
    .join("");
}

function estimateCostUsd(model, usage) {
  const pricing = MODEL_PRICING_PER_MILLION[model];

  if (!pricing) {
    return 0;
  }

  return (
    (usage.inputTokens / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output
  );
}
