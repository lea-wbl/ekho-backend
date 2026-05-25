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
  authMode: process.env.AUTH_MODE ?? "development",
  devAuthUserId: process.env.DEV_AUTH_USER_ID ?? "dev-user",
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY ?? "",
  clerkJwtKey: process.env.CLERK_JWT_KEY ?? "",
  clerkAuthorizedParties: parseOrigins(process.env.CLERK_AUTHORIZED_PARTIES ?? ""),
};
