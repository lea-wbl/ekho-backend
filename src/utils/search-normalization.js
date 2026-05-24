const COMBINING_MARKS_REGEX = /\p{M}+/gu;
const PUNCTUATION_REGEX = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE_REGEX = /\s+/g;

export function normalizeSearchText(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(COMBINING_MARKS_REGEX, "")
    .toLowerCase()
    .replace(PUNCTUATION_REGEX, " ")
    .replace(WHITESPACE_REGEX, " ")
    .trim();
}

export function uniqueNormalizedWords(input) {
  return Array.from(new Set(normalizedWordSequence(input)));
}

export function normalizedWordSequence(input) {
  return normalizeSearchText(input)
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean);
}

export function buildFallbackQueries(input) {
  const raw = String(input ?? "").trim();
  const normalized = normalizeSearchText(input);
  const tokens = uniqueNormalizedWords(input);
  const variants = new Set();

  if (raw.length > 0) {
    variants.add(raw);
  }

  if (normalized.length > 0) {
    variants.add(normalized);
  }

  if (tokens.length > 1) {
    variants.add(tokens.join(" "));
    variants.add(tokens.slice(0, 3).join(" "));
    variants.add(tokens.slice(0, 2).join(" "));
    variants.add(tokens.slice(0, tokens.length - 1).join(" "));
  }

  if (tokens.length > 0) {
    variants.add(tokens[0]);
  }

  return Array.from(variants).filter((variant) => variant.length > 0);
}
