import { HttpError } from "../utils/http-error.js";

export function requireString(value, fieldName, options = {}) {
  const trimmed = typeof value === "string" ? value.trim() : "";

  if (!trimmed) {
    throw new HttpError(400, `${fieldName} is required.`);
  }

  if (options.minLength && trimmed.length < options.minLength) {
    throw new HttpError(400, `${fieldName} must be at least ${options.minLength} characters.`);
  }

  return trimmed;
}

export function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function optionalStringArray(value, fieldName) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be an array of strings.`);
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

export function optionalNoteReference(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be an object.`);
  }

  const mode = value.mode === "page" || value.mode === "chapter" ? value.mode : null;

  if (!mode) {
    throw new HttpError(400, `${fieldName}.mode must be "page" or "chapter".`);
  }

  const start = requirePositiveInteger(value.start, `${fieldName}.start`);
  const rawEnd = value.end;

  if (rawEnd === undefined || rawEnd === null || rawEnd === "") {
    return {
      mode,
      start,
    };
  }

  const end = requirePositiveInteger(rawEnd, `${fieldName}.end`);

  if (end < start) {
    throw new HttpError(400, `${fieldName}.end must be greater than or equal to ${fieldName}.start.`);
  }

  return {
    mode,
    start,
    ...(end > start ? { end } : {}),
  };
}

export function requirePositiveInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `${fieldName} must be a positive integer.`);
  }

  return parsed;
}

export function requireRating(value) {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new HttpError(400, "rating must be an integer between 1 and 5.");
  }

  return parsed;
}
