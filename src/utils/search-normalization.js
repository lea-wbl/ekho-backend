const COMBINING_MARKS_REGEX = /\p{M}+/gu;
const PUNCTUATION_REGEX = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE_REGEX = /\s+/g;
const SEARCH_NOISE_REGEX =
  /\b(e book|ebook|tome|vol|volume|book)\b|\b[0-9ivxlcdm]+\b/u;
const FRENCH_STOP_WORDS = new Set([
  "a",
  "au",
  "aux",
  "ce",
  "ces",
  "d",
  "de",
  "des",
  "du",
  "en",
  "et",
  "l",
  "la",
  "le",
  "les",
  "mais",
  "ou",
  "par",
  "pour",
  "sur",
  "un",
  "une",
]);

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

export function isNoiseWord(word) {
  return SEARCH_NOISE_REGEX.test(String(word ?? "").trim());
}

export function extractMeaningfulSearchWords(input) {
  return normalizedWordSequence(input).filter(
    (word) => word.length > 0 && !FRENCH_STOP_WORDS.has(word) && !isNoiseWord(word),
  );
}

export function buildSearchTokenPrefixes(inputs, options = {}) {
  const values = Array.isArray(inputs) ? inputs : [inputs];
  const minLength = Number.isInteger(options.minLength) ? options.minLength : 3;
  const maxPrefixLength = Number.isInteger(options.maxPrefixLength)
    ? options.maxPrefixLength
    : 12;
  const tokens = new Set();

  for (const value of values) {
    for (const word of extractMeaningfulSearchWords(value)) {
      if (word.length < minLength) {
        continue;
      }

      const maxLength = Math.min(word.length, maxPrefixLength);

      for (let length = minLength; length <= maxLength; length += 1) {
        tokens.add(word.slice(0, length));
      }

      tokens.add(word);
    }
  }

  return Array.from(tokens);
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
