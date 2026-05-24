export function notFoundHandler(_request, response) {
  response.status(404).json({
    error: "Not found",
  });
}

export function errorHandler(error, _request, response, _next) {
  const statusCode = error.statusCode ?? 500;
  const message = error.message ?? "Internal server error";

  if (statusCode >= 500) {
    console.error(error);
  }

  response.status(statusCode).json({
    error: message,
    details: error.details ?? undefined,
  });
}
