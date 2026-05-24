import cors from "cors";
import express from "express";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { libraryRouter } from "./routes/library-routes.js";

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

  app.use("/api", libraryRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
