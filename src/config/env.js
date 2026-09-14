import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const parseOrigins = (value) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number.parseInt(process.env.PORT ?? "4000", 10),
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/ekho",
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN ?? "http://localhost:8081"),
  googleBooksApiKey: process.env.GOOGLE_BOOKS_API_KEY ?? "",
  authMode: process.env.AUTH_MODE ?? "development",
  devAuthUserId: process.env.DEV_AUTH_USER_ID ?? "dev-user",
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY ?? "",
  clerkJwtKey: process.env.CLERK_JWT_KEY ?? "",
  clerkAuthorizedParties: parseOrigins(process.env.CLERK_AUTHORIZED_PARTIES ?? ""),
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  openAiNotesSummaryModel: process.env.OPENAI_NOTES_SUMMARY_MODEL ?? "gpt-5-nano",
  aiNotesSummaryMonthlyLimit: Number.parseInt(
    process.env.AI_NOTES_SUMMARY_MONTHLY_LIMIT ?? "20",
    10,
  ),
};
