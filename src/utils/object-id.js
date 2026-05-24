import mongoose from "mongoose";
import { HttpError } from "./http-error.js";

export function ensureObjectId(value, label = "id") {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new HttpError(400, `Invalid ${label}.`);
  }
}
