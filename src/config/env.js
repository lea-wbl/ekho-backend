import dotenv from "dotenv";

dotenv.config();

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
};
