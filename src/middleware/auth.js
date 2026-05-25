import { createClerkClient } from "@clerk/backend";
import { env } from "../config/env.js";
import { HttpError } from "../utils/http-error.js";

const clerkClient =
  env.clerkSecretKey && env.clerkPublishableKey
    ? createClerkClient({
        secretKey: env.clerkSecretKey,
        publishableKey: env.clerkPublishableKey,
      })
    : null;

export async function requireAuth(request, _response, next) {
  if (env.authMode === "development") {
    request.auth = {
      userId: env.devAuthUserId,
    };
    next();
    return;
  }

  if (!clerkClient) {
    throw new HttpError(
      503,
      "Clerk is not configured. Set CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY on the backend.",
    );
  }

  const requestState = await clerkClient.authenticateRequest(request, {
    ...(env.clerkAuthorizedParties.length > 0
      ? { authorizedParties: env.clerkAuthorizedParties }
      : {}),
    ...(env.clerkJwtKey ? { jwtKey: env.clerkJwtKey } : {}),
  });

  if (!requestState.isAuthenticated) {
    throw new HttpError(401, requestState.message || "Unauthorized.");
  }

  const auth = requestState.toAuth();

  if (!auth.userId) {
    throw new HttpError(401, "Authenticated request is missing a user ID.");
  }

  request.auth = {
    userId: auth.userId,
    sessionId: auth.sessionId ?? null,
    orgId: auth.orgId ?? null,
  };

  next();
}
