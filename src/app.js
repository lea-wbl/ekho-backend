import cors from "cors";
import express from "express";
import morgan from "morgan";
import { env } from "./config/env.js";
import { healthCheck } from "./controllers/library-controller.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { libraryRouter } from "./routes/library-routes.js";
import { asyncHandler } from "./utils/async-handler.js";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.corsOrigins.length === 0 || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error("Origin not allowed by CORS."));
      },
    }),
  );
  app.use(express.json());
  app.use(morgan("dev"));

  app.get("/api/health", asyncHandler(healthCheck));
  app.use("/api", requireAuth, libraryRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
