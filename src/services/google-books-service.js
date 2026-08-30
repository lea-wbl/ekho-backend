import { env } from "../config/env.js";
import { CatalogBook } from "../models/CatalogBook.js";
import { HttpError } from "../utils/http-error.js";
import {
  buildSearchTokenPrefixes,
  extractMeaningfulSearchWords,
  normalizeSearchText,
} from "../utils/search-normalization.js";

const MIN_SEARCH_LENGTH = 3;
const MIN_PAGE_COUNT = 200;
const MAX_RESULTS = 20;
const SEARCH_RESULT_LIMIT = 20;
const MIN_RESULTS_BEFORE_FALLBACK = 8;
const MIN_RESULTS_BEFORE_FULLTEXT_FALLBACK = 3;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_FUZZY_CATALOG_CANDIDATES = 150;
const MAX_QUERY_PREFIX_LENGTH = 5;
const TITLE_SEGMENT_SEPARATORS_REGEX = /\s[-:|]\s/g;
const TITLE_NOISE_REGEX =
  /\b(e book|ebook|tome|vol|volume|book)\b|\b[0-9ivxlcdm]+\b/gu;
const searchCache = new Map();

export async function searchGoogleBooks(query) {
  const normalizedQuery = normalizeSearchText(query);
  const cachedResults = getCachedSearchResults(normalizedQuery);

  if (cachedResults) {
    return cachedResults;
  }

  const catalogResults = await findCatalogSearchResults(query);
  const googleResults =
    catalogResults.length >= MIN_RESULTS_BEFORE_FALLBACK
      ? []
      : await findGoogleSearchResults(query);

  const searchResults = [...catalogResults, ...googleResults]
    .filter((result) => result !== null)
    .filter((result) => matchesRequiredQueryWords(result, query))
    .reduce(deduplicateSearchResults, new Map());

  const serializedResults = collapseSearchResults(searchResults)
    .sort((left, right) => compareSearchResults(left, right, query))
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((result) => ({
      catalogBookId: result.catalogBookId,
      googleBookId: result.googleBookId,
      title: result.title,
      subtitle: result.subtitle,
      author: result.author,
      publisher: result.publisher,
      totalPages: result.totalPages,
      thumbnail: result.thumbnail,
    }));

  setCachedSearchResults(normalizedQuery, serializedResults);
  return serializedResults;
}

export async function searchBookByIsbn(rawIsbn) {
  const isbnVariants = buildIsbnVariants(rawIsbn);

  if (isbnVariants.length === 0) {
    throw new HttpError(400, "isbn is invalid.");
  }

  const catalogBook = await CatalogBook.findOne({
    "raw.industryIdentifiers.identifier": { $in: isbnVariants },
  }).sort({ updatedAt: -1, createdAt: -1 });

  const catalogResult = mapCatalogBookToExactLookupResult(catalogBook);

  if (catalogResult) {
    return catalogResult;
  }

  if (!env.googleBooksApiKey) {
    throw new HttpError(400, "GOOGLE_BOOKS_API_KEY is not configured.");
  }

  const response = await fetchGoogleBooksVolumes({
    query: `isbn:${isbnVariants[0]}`,
    mode: "fulltext",
  });
  const exactResult = (response.items ?? [])
    .map(mapGoogleItemToExactLookupResult)
    .find(Boolean);

  if (!exactResult) {
    throw new HttpError(404, "No book found for that barcode.");
  }

  return exactResult;
}

export async function upsertCatalogBookFromGoogleById(googleBookId) {
  if (!env.googleBooksApiKey) {
    throw new HttpError(400, "GOOGLE_BOOKS_API_KEY is not configured.");
  }

  const response = await fetch(
    `https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(googleBookId)}?key=${encodeURIComponent(env.googleBooksApiKey)}`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new HttpError(response.status, `Google Books request failed with status ${response.status}.`);
  }

  const item = await response.json();
  return upsertCatalogBookFromGoogle(item);
}

async function fetchGoogleBooksVolumes(request) {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", buildGoogleBooksQuery(request));
  url.searchParams.set("maxResults", String(MAX_RESULTS));
  url.searchParams.set("key", env.googleBooksApiKey);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new HttpError(response.status, `Google Books request failed with status ${response.status}.`);
  }

  return await response.json();
}

async function findCatalogSearchResults(query) {
  const strictCandidates = await findCatalogCandidates(query);
  const strictResults = strictCandidates
    .map(mapCatalogBookToSearchResult)
    .filter((result) => result !== null);

  if (strictResults.length >= MIN_RESULTS_BEFORE_FALLBACK) {
    return strictResults;
  }

  const strictCandidateIds = new Set(
    strictCandidates.map((candidate) => candidate?._id?.toString?.()).filter(Boolean),
  );
  const fuzzyCandidates = await findFuzzyCatalogCandidates(query, strictCandidateIds);
  const fuzzyResults = fuzzyCandidates
    .map(mapCatalogBookToSearchResult)
    .filter((result) => result !== null)
    .map((result) => ({
      ...result,
      typoMatchScore: computeTypoMatchScore(result, query),
    }))
    .filter((result) => result.typoMatchScore > 0);

  return [...strictResults, ...fuzzyResults];
}

async function findGoogleSearchResults(query) {
  if (!env.googleBooksApiKey) {
    throw new HttpError(400, "GOOGLE_BOOKS_API_KEY is not configured.");
  }

  const requestVariants = buildGoogleBooksRequestVariants(query);
  const items = await fetchSearchItemsWithFallback(requestVariants, query);

  return items
    .map(mapGoogleItemToSearchResult)
    .filter((result) => result !== null);
}

function buildGoogleBooksRequestVariants(query) {
  const rawQuery = String(query ?? "").trim();
  const requests = new Map();

  if (rawQuery.length >= MIN_SEARCH_LENGTH) {
    const primaryRequest = { query: rawQuery, mode: "intitle" };
    requests.set(`${primaryRequest.mode}:${primaryRequest.query}`, primaryRequest);
  }

  if (rawQuery.length >= MIN_SEARCH_LENGTH) {
    const request = { query: rawQuery, mode: "fulltext" };
    requests.set(`${request.mode}:${request.query}`, request);
  }

  return Array.from(requests.values());
}

async function findCatalogCandidates(query) {
  const queryTokens = extractMeaningfulSearchWords(query).filter(
    (word) => word.length >= MIN_SEARCH_LENGTH,
  );

  if (queryTokens.length === 0) {
    return [];
  }

  return CatalogBook.find({
    "search.searchTokens": { $all: queryTokens },
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(50);
}

async function findFuzzyCatalogCandidates(query, excludedIds = new Set()) {
  const queryPrefixes = buildSearchTokenPrefixes(query, {
    minLength: MIN_SEARCH_LENGTH,
    maxPrefixLength: MAX_QUERY_PREFIX_LENGTH,
  });
  const excludedObjectIds = Array.from(excludedIds).filter(Boolean);

  if (queryPrefixes.length === 0) {
    return [];
  }

  return CatalogBook.find({
    ...(excludedObjectIds.length > 0 ? { _id: { $nin: excludedObjectIds } } : {}),
    "search.searchTokens": { $in: queryPrefixes },
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(MAX_FUZZY_CATALOG_CANDIDATES);
}

async function fetchSearchItemsWithFallback(requestVariants, query) {
  const dedupedItems = [];
  const seenIds = new Set();

  for (let index = 0; index < requestVariants.length; index += 1) {
    const request = requestVariants[index];

    try {
      const response = await fetchGoogleBooksVolumes(request);

      for (const item of response.items ?? []) {
        if (!item?.id || seenIds.has(item.id)) {
          continue;
        }

        seenIds.add(item.id);
        dedupedItems.push(item);
      }
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 429) {
        throw error;
      }

      if (dedupedItems.length > 0) {
        break;
      }

      throw new HttpError(
        429,
        "Google Books is temporarily rate-limiting searches. Try again in a few minutes.",
      );
    }

    const rankedResultCount = countRankedSearchResults(dedupedItems, query);

    if (index === 0 && rankedResultCount >= MIN_RESULTS_BEFORE_FALLBACK) {
      break;
    }

    if (index === 0 && rankedResultCount >= MIN_RESULTS_BEFORE_FULLTEXT_FALLBACK) {
      break;
    }
  }

  return dedupedItems;
}

function countRankedSearchResults(items, query) {
  return items
    .map(mapGoogleItemToSearchResult)
    .filter((result) => result !== null)
    .filter((result) => matchesRequiredQueryWords(result, query))
    .reduce(deduplicateSearchResults, new Map()).size;
}

function getCachedSearchResults(normalizedQuery) {
  if (!normalizedQuery) {
    return null;
  }

  const cachedEntry = searchCache.get(normalizedQuery);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    searchCache.delete(normalizedQuery);
    return null;
  }

  return cachedEntry.results;
}

function setCachedSearchResults(normalizedQuery, results) {
  if (!normalizedQuery) {
    return;
  }

  searchCache.set(normalizedQuery, {
    results,
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
  });
}

function buildGoogleBooksQuery(request) {
  if (request.mode === "fulltext") {
    return request.query;
  }

  return `intitle:${request.query}`;
}

async function upsertCatalogBookFromGoogle(item) {
  const volumeInfo = item?.volumeInfo ?? {};
  const rawTitle = typeof volumeInfo.title === "string" ? volumeInfo.title.trim() : "";

  if (!item?.id || !rawTitle) {
    return null;
  }

  const rawSubtitle =
    typeof volumeInfo.subtitle === "string" ? volumeInfo.subtitle.trim() : "";
  const rawAuthors = Array.isArray(volumeInfo.authors)
    ? volumeInfo.authors.map((author) => String(author).trim()).filter(Boolean)
    : [];
  const rawPublisher =
    typeof volumeInfo.publisher === "string" ? volumeInfo.publisher.trim() : "";
  const rawPageCount =
    typeof volumeInfo.pageCount === "number" && volumeInfo.pageCount > 0
      ? volumeInfo.pageCount
      : null;
  const rawLanguage =
    typeof volumeInfo.language === "string" ? volumeInfo.language.trim().toLowerCase() : "";
  const rawIdentifiers = Array.isArray(volumeInfo.industryIdentifiers)
    ? volumeInfo.industryIdentifiers
        .map((identifier) => ({
          type: typeof identifier?.type === "string" ? identifier.type.trim() : "",
          identifier:
            typeof identifier?.identifier === "string"
              ? identifier.identifier.trim()
              : "",
        }))
        .filter((identifier) => identifier.identifier)
    : [];
  const rawThumbnail = pickThumbnail(volumeInfo.imageLinks);

  const titleCandidates = buildTitleCandidates(rawTitle);
  const subtitleCandidates = rawSubtitle ? buildTitleCandidates(rawSubtitle) : [];
  const aliases = Array.from(new Set([...subtitleCandidates]));
  const normalizedTitle = normalizeSearchText(rawTitle);
  const normalizedSubtitle = normalizeSearchText(rawSubtitle);
  const normalizedAuthor = normalizeSearchText(rawAuthors[0] ?? "");
  const normalizedPublisher = normalizeSearchText(rawPublisher);
  const normalizedSearchBlob = Array.from(
    new Set([
      normalizedTitle,
      normalizedSubtitle,
      normalizedAuthor,
      normalizedPublisher,
      ...titleCandidates,
      ...subtitleCandidates,
      ...aliases,
    ].filter(Boolean)),
  ).join(" ");
  const searchTokens = buildSearchTokenPrefixes([
    normalizedTitle,
    normalizedSubtitle,
    normalizedAuthor,
    normalizedPublisher,
    ...titleCandidates,
    ...subtitleCandidates,
    ...aliases,
  ]);
  const hasIsbn = Boolean(extractIsbn(rawIdentifiers));
  const hasCover = Boolean(rawThumbnail);

  return CatalogBook.findOneAndUpdate(
    { source: "google_books", sourceId: item.id },
    {
      $set: {
        raw: {
          title: rawTitle,
          subtitle: rawSubtitle,
          authors: rawAuthors,
          publisher: rawPublisher,
          pageCount: rawPageCount,
          language: rawLanguage,
          industryIdentifiers: rawIdentifiers,
          thumbnail: rawThumbnail,
        },
        search: {
          aliases,
          titleCandidates,
          subtitleCandidates,
          normalizedTitle,
          normalizedSubtitle,
          normalizedAuthor,
          normalizedPublisher,
          normalizedSearchBlob,
          searchTokens,
        },
        quality: {
          hasCover,
          hasIsbn,
          pageCount: rawPageCount,
          language: rawLanguage,
        },
        lastFetchedAt: new Date(),
      },
      $setOnInsert: {
        canonical: {
          title: rawTitle,
          subtitle: rawSubtitle,
          author: rawAuthors[0] ?? "",
          publisher: rawPublisher,
          seriesName: "",
        },
      },
    },
    { upsert: true, new: true },
  );
}

function mapCatalogBookToSearchResult(catalogBook) {
  const title = String(
    catalogBook?.canonical?.title ||
      catalogBook?.raw?.title ||
      "",
  ).trim();
  const subtitle = String(
    catalogBook?.canonical?.subtitle ||
      catalogBook?.raw?.subtitle ||
      "",
  ).trim();
  const author = String(
    catalogBook?.canonical?.author ||
      catalogBook?.raw?.authors?.[0] ||
      "",
  ).trim();
  const publisher = String(
    catalogBook?.canonical?.publisher ||
      catalogBook?.raw?.publisher ||
      "",
  ).trim();
  const totalPages =
    typeof catalogBook?.raw?.pageCount === "number" ? catalogBook.raw.pageCount : null;
  const language =
    normalizeSupportedLanguage(catalogBook?.quality?.language) ??
    normalizeSupportedLanguage(catalogBook?.raw?.language) ??
    "unknown";
  const thumbnail = String(catalogBook?.raw?.thumbnail ?? "").trim();

  if (
    !catalogBook?._id ||
    !title ||
    !author ||
    !totalPages ||
    totalPages < MIN_PAGE_COUNT ||
    (!publisher && catalogBook?.source !== "manual_submission") ||
    (!thumbnail && catalogBook?.source !== "manual_submission")
  ) {
    return null;
  }

  return {
    catalogBookId: catalogBook._id.toString(),
    googleBookId:
      catalogBook?.source === "google_books" ? String(catalogBook.sourceId ?? "").trim() : "",
    title,
    subtitle,
    author,
    publisher,
    totalPages,
    firstPublishYear: null,
    language,
    thumbnail,
    aliases: Array.isArray(catalogBook?.search?.aliases) ? catalogBook.search.aliases : [],
    sourceType: "catalog",
  };
}

function mapCatalogBookToExactLookupResult(catalogBook) {
  if (!catalogBook?._id) {
    return null;
  }

  const title = String(
    catalogBook?.canonical?.title || catalogBook?.raw?.title || "",
  ).trim();
  const subtitle = String(
    catalogBook?.canonical?.subtitle || catalogBook?.raw?.subtitle || "",
  ).trim();
  const author = String(
    catalogBook?.canonical?.author || catalogBook?.raw?.authors?.[0] || "",
  ).trim();

  if (!title || !author) {
    return null;
  }

  return {
    catalogBookId: catalogBook._id.toString(),
    googleBookId:
      catalogBook?.source === "google_books" ? String(catalogBook.sourceId ?? "").trim() : "",
    title,
    subtitle,
    author,
    publisher: String(
      catalogBook?.canonical?.publisher || catalogBook?.raw?.publisher || "",
    ).trim(),
    totalPages:
      typeof catalogBook?.raw?.pageCount === "number" && catalogBook.raw.pageCount > 0
        ? catalogBook.raw.pageCount
        : null,
    thumbnail: String(catalogBook?.raw?.thumbnail ?? "").trim(),
  };
}

function mapGoogleItemToSearchResult(item) {
  const volumeInfo = item?.volumeInfo ?? {};
  const title = typeof volumeInfo.title === "string" ? volumeInfo.title.trim() : "";
  const subtitle =
    typeof volumeInfo.subtitle === "string" ? volumeInfo.subtitle.trim() : "";
  const author = Array.isArray(volumeInfo.authors)
    ? volumeInfo.authors.find(Boolean)?.trim?.() ?? ""
    : "";
  const publisher =
    typeof volumeInfo.publisher === "string" ? volumeInfo.publisher.trim() : "";
  const totalPages =
    typeof volumeInfo.pageCount === "number" ? volumeInfo.pageCount : null;
  const language = normalizeSupportedLanguage(volumeInfo.language);
  const identifiers = Array.isArray(volumeInfo.industryIdentifiers)
    ? volumeInfo.industryIdentifiers
        .map((identifier) => ({
          type: typeof identifier?.type === "string" ? identifier.type.trim() : "",
          identifier:
            typeof identifier?.identifier === "string"
              ? identifier.identifier.trim()
              : "",
        }))
        .filter((identifier) => identifier.identifier)
    : [];
  const thumbnail = pickThumbnail(volumeInfo.imageLinks);

  if (
    !item?.id ||
    !title ||
    !author ||
    !publisher ||
    !totalPages ||
    totalPages < MIN_PAGE_COUNT ||
    !thumbnail ||
    !language ||
    !extractIsbn(identifiers)
  ) {
    return null;
  }

  return {
    catalogBookId: null,
    googleBookId: item.id,
    title,
    subtitle,
    author,
    publisher,
    totalPages,
    firstPublishYear: null,
    language,
    thumbnail,
    aliases: Array.from(new Set(subtitle ? buildTitleCandidates(subtitle) : [])),
    sourceType: "google",
  };
}

function mapGoogleItemToExactLookupResult(item) {
  const volumeInfo = item?.volumeInfo ?? {};
  const title = typeof volumeInfo.title === "string" ? volumeInfo.title.trim() : "";
  const subtitle =
    typeof volumeInfo.subtitle === "string" ? volumeInfo.subtitle.trim() : "";
  const author = Array.isArray(volumeInfo.authors)
    ? volumeInfo.authors.find(Boolean)?.trim?.() ?? ""
    : "";

  if (!item?.id || !title || !author) {
    return null;
  }

  return {
    catalogBookId: null,
    googleBookId: item.id,
    title,
    subtitle,
    author,
    publisher:
      typeof volumeInfo.publisher === "string" ? volumeInfo.publisher.trim() : "",
    totalPages:
      typeof volumeInfo.pageCount === "number" && volumeInfo.pageCount > 0
        ? volumeInfo.pageCount
        : null,
    thumbnail: pickThumbnail(volumeInfo.imageLinks),
  };
}

function normalizeSupportedLanguage(language) {
  const normalized = String(language ?? "").trim().toLowerCase();

  if (normalized === "fr") {
    return "fr";
  }

  if (normalized === "en") {
    return "en";
  }

  return null;
}

function getLanguageRank(language) {
  if (language === "fr") {
    return 0;
  }

  if (language === "en") {
    return 1;
  }

  return 2;
}

function compareSearchResults(left, right, query) {
  const leftLanguageRank = getLanguageRank(left.language);
  const rightLanguageRank = getLanguageRank(right.language);

  if (leftLanguageRank !== rightLanguageRank) {
    return leftLanguageRank - rightLanguageRank;
  }

  const leftScore = computeQueryMatchScore(left, query);
  const rightScore = computeQueryMatchScore(right, query);

  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  if (left.sourceType !== right.sourceType) {
    return left.sourceType === "catalog" ? -1 : 1;
  }

  return 0;
}

function computeQueryMatchScore(result, query) {
  const normalizedQuery = normalizeSearchText(query);
  const searchCandidates = buildSearchCandidates(result);
  const typoMatchScore =
    typeof result.typoMatchScore === "number" ? result.typoMatchScore : 0;

  if (searchCandidates.some((candidate) => candidate === normalizedQuery)) {
    return 500;
  }

  if (searchCandidates.some((candidate) => candidate.startsWith(normalizedQuery))) {
    return 400;
  }

  if (searchCandidates.some((candidate) => candidate.includes(normalizedQuery))) {
    return 300;
  }

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  let bestTokenScore = 0;

  for (const candidate of searchCandidates) {
    const candidateTokens = candidate.split(" ").filter(Boolean);
    const matchingTokens = queryTokens.filter((token) =>
      candidateTokens.some((candidateToken) => candidateToken.startsWith(token)),
    );
    const exactTokenMatches = matchingTokens.filter((token) =>
      candidateTokens.includes(token),
    ).length;
    bestTokenScore = Math.max(
      bestTokenScore,
      matchingTokens.length * 10 + exactTokenMatches * 5,
    );
  }

  return Math.max(bestTokenScore, typoMatchScore);
}

function matchesRequiredQueryWords(result, query) {
  if (
    typeof result.typoMatchScore === "number" &&
    result.typoMatchScore > 0
  ) {
    return true;
  }

  const requiredWords = extractMeaningfulSearchWords(query);
  const searchCandidates = buildSearchCandidates(result);
  const titleCandidateWords = new Set(
    searchCandidates.flatMap((candidate) => candidate.split(" ")).filter(Boolean),
  );

  if (requiredWords.length === 0) {
    return true;
  }

  if (requiredWords.length === 1) {
    return searchCandidates.some((candidate) => candidate.startsWith(requiredWords[0]));
  }

  const candidateWords = [
    ...titleCandidateWords,
    ...normalizeSearchText(result.author).split(" ").filter(Boolean),
  ];

  return requiredWords.every((word) =>
    candidateWords.some((candidateWord) => candidateWord.startsWith(word)),
  );
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

function buildSearchCandidates(result) {
  return Array.from(
    new Set([
      ...buildTitleCandidates(result.title),
      ...(result.subtitle ? buildTitleCandidates(result.subtitle) : []),
      ...(Array.isArray(result.aliases) ? result.aliases.map((alias) => normalizeSearchText(alias)) : []),
    ].filter(Boolean)),
  );
}

function buildCandidateWords(result) {
  return Array.from(
    new Set(
      [
        ...buildSearchCandidates(result).flatMap((candidate) => candidate.split(" ")),
        ...normalizeSearchText(result.author).split(" "),
        ...normalizeSearchText(result.publisher).split(" "),
      ]
        .map((word) => word.trim())
        .filter(Boolean),
    ),
  );
}

function computeTypoMatchScore(result, query) {
  const queryWords = extractMeaningfulSearchWords(query).filter(
    (word) => word.length >= MIN_SEARCH_LENGTH,
  );

  if (queryWords.length === 0) {
    return 0;
  }

  const candidateWords = buildCandidateWords(result);

  if (candidateWords.length === 0) {
    return 0;
  }

  let totalScore = 0;

  for (const queryWord of queryWords) {
    const bestScore = computeBestTypoWordScore(queryWord, candidateWords);

    if (bestScore === 0) {
      return 0;
    }

    totalScore += bestScore;
  }

  return totalScore;
}

function computeBestTypoWordScore(queryWord, candidateWords) {
  let bestScore = 0;

  for (const candidateWord of candidateWords) {
    if (candidateWord === queryWord) {
      return 90;
    }

    if (
      candidateWord.startsWith(queryWord) ||
      queryWord.startsWith(candidateWord)
    ) {
      bestScore = Math.max(bestScore, 75);
      continue;
    }

    const maxDistance = getAllowedTypoDistance(queryWord, candidateWord);

    if (maxDistance === 0) {
      continue;
    }

    const distance = boundedLevenshteinDistance(
      queryWord,
      candidateWord,
      maxDistance,
    );

    if (distance === null) {
      continue;
    }

    bestScore = Math.max(bestScore, 70 - distance * 15);
  }

  return bestScore;
}

function getAllowedTypoDistance(leftWord, rightWord) {
  const maxLength = Math.max(leftWord.length, rightWord.length);

  if (maxLength < 5) {
    return 0;
  }

  if (maxLength < 9) {
    return 1;
  }

  return 2;
}

function boundedLevenshteinDistance(left, right, maxDistance) {
  if (Math.abs(left.length - right.length) > maxDistance) {
    return null;
  }

  let previousPreviousRow = null;
  let previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const currentRow = [leftIndex];
    let rowMinimum = currentRow[0];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const nextValue = Math.min(
        previousRow[rightIndex] + 1,
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex - 1] + substitutionCost,
      );

      let boundedValue = nextValue;

      if (
        previousPreviousRow &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        boundedValue = Math.min(
          boundedValue,
          previousPreviousRow[rightIndex - 2] + 1,
        );
      }

      currentRow.push(boundedValue);
      rowMinimum = Math.min(rowMinimum, boundedValue);
    }

    if (rowMinimum > maxDistance) {
      return null;
    }

    previousPreviousRow = previousRow;
    previousRow = currentRow;
  }

  return previousRow[right.length] <= maxDistance ? previousRow[right.length] : null;
}

function cleanTitleCandidate(candidate) {
  return String(candidate ?? "")
    .replace(TITLE_NOISE_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deduplicateSearchResults(deduped, result) {
  const deduplicationKeys = buildDeduplicationKeys(result);
  const existing = deduplicationKeys
    .map((key) => deduped.get(key))
    .find(Boolean);

  if (!existing || compareDuplicateCandidates(result, existing) < 0) {
    if (existing) {
      removeResultFromDedupedMap(deduped, existing);
    }

    for (const key of deduplicationKeys) {
      deduped.set(key, result);
    }
  }

  return deduped;
}

function collapseSearchResults(deduped) {
  return Array.from(
    new Map(
      Array.from(deduped.values()).map((result) => [buildResultIdentityKey(result), result]),
    ).values(),
  );
}

function buildDeduplicationKeys(result) {
  const keys = [];
  const normalizedAuthor = normalizeSearchText(result.author);
  const normalizedPublisher = normalizeSearchText(result.publisher);

  if (result.googleBookId) {
    keys.push(`id::${String(result.googleBookId).trim()}`);
  }

  keys.push(
    [
      "meta",
      normalizeSearchText(result.title),
      normalizedAuthor,
      normalizedPublisher,
    ].join("::"),
  );

  const candidateKeys = buildSearchCandidates(result)
    .filter((candidate) => candidate.length >= 4)
    .map((candidate) => ["candidate", candidate, normalizedAuthor, normalizedPublisher].join("::"));

  keys.push(...candidateKeys);

  return Array.from(new Set(keys));
}

function buildResultIdentityKey(result) {
  if (result.catalogBookId) {
    return `catalog::${String(result.catalogBookId).trim()}`;
  }

  if (result.googleBookId) {
    return `google::${String(result.googleBookId).trim()}`;
  }

  return [
    "meta",
    normalizeSearchText(result.title),
    normalizeSearchText(result.author),
    normalizeSearchText(result.publisher),
  ].join("::");
}

function removeResultFromDedupedMap(deduped, result) {
  const identityKey = buildResultIdentityKey(result);

  for (const [key, currentResult] of deduped.entries()) {
    if (buildResultIdentityKey(currentResult) === identityKey) {
      deduped.delete(key);
    }
  }
}

function compareDuplicateCandidates(left, right) {
  const leftLanguageRank = getLanguageRank(left.language);
  const rightLanguageRank = getLanguageRank(right.language);

  if (leftLanguageRank !== rightLanguageRank) {
    return leftLanguageRank - rightLanguageRank;
  }

  if (left.sourceType !== right.sourceType) {
    return left.sourceType === "catalog" ? -1 : 1;
  }

  return left.googleBookId.localeCompare(right.googleBookId);
}

function pickThumbnail(imageLinks) {
  const url =
    imageLinks?.thumbnail ??
    imageLinks?.smallThumbnail ??
    imageLinks?.small ??
    imageLinks?.medium ??
    imageLinks?.large ??
    imageLinks?.extraLarge ??
    "";

  return typeof url === "string" ? url.replace("http://", "https://").trim() : "";
}

function extractIsbn(identifiers) {
  if (!Array.isArray(identifiers)) {
    return null;
  }

  const isbn13 = identifiers.find(
    (identifier) =>
      identifier.type?.trim().toUpperCase() === "ISBN_13" &&
      identifier.identifier?.trim(),
  );

  if (isbn13?.identifier?.trim()) {
    return isbn13.identifier.trim();
  }

  const isbn10 = identifiers.find(
    (identifier) =>
      identifier.type?.trim().toUpperCase() === "ISBN_10" &&
      identifier.identifier?.trim(),
  );

  return isbn10?.identifier?.trim() || null;
}

function buildIsbnVariants(rawIsbn) {
  const compact = String(rawIsbn ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9X]/g, "");

  if (compact.length < 10) {
    return [];
  }

  const hyphenated = String(rawIsbn ?? "").trim();

  return Array.from(new Set([compact, hyphenated].filter(Boolean)));
}
