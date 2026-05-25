import mongoose from "mongoose";
import { connectToDatabase } from "../config/db.js";
import { CatalogBook } from "../models/CatalogBook.js";
import { buildSearchTokenPrefixes, normalizeSearchText } from "../utils/search-normalization.js";

function collectSearchValues(catalogBook) {
  return [
    catalogBook?.search?.normalizedTitle,
    catalogBook?.search?.normalizedSubtitle,
    catalogBook?.search?.normalizedAuthor,
    catalogBook?.search?.normalizedPublisher,
    ...(Array.isArray(catalogBook?.search?.titleCandidates)
      ? catalogBook.search.titleCandidates
      : []),
    ...(Array.isArray(catalogBook?.search?.subtitleCandidates)
      ? catalogBook.search.subtitleCandidates
      : []),
    ...(Array.isArray(catalogBook?.search?.aliases) ? catalogBook.search.aliases : []),
  ]
    .map((value) => normalizeSearchText(value))
    .filter(Boolean);
}

async function main() {
  await connectToDatabase();

  const catalogBooks = await CatalogBook.find(
    {},
    {
      search: 1,
    },
  );

  let updated = 0;

  for (const catalogBook of catalogBooks) {
    const normalizedValues = collectSearchValues(catalogBook);
    const normalizedSearchBlob = Array.from(new Set(normalizedValues)).join(" ");
    const searchTokens = buildSearchTokenPrefixes(normalizedValues);
    const currentTokens = Array.isArray(catalogBook?.search?.searchTokens)
      ? catalogBook.search.searchTokens
      : [];
    const hasChanged =
      catalogBook?.search?.normalizedSearchBlob !== normalizedSearchBlob ||
      currentTokens.join(" ") !== searchTokens.join(" ");

    if (!hasChanged) {
      continue;
    }

    catalogBook.search.normalizedSearchBlob = normalizedSearchBlob;
    catalogBook.search.searchTokens = searchTokens;
    await catalogBook.save();
    updated += 1;
  }

  console.log(JSON.stringify({ scanned: catalogBooks.length, updated }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
