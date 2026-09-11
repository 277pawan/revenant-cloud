export type AppError = Error & {
  statusCode: number;
  code: string;
  name: "AppError";
};

/** Function-based app error (no class). Throw with: throw createAppError(404, "...", "NOT_FOUND") */
export function createAppError(
  statusCode: number,
  message: string,
  code: string
): AppError {
  const err = new Error(message) as AppError;
  err.name = "AppError";
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export function isAppError(err: unknown): err is AppError {
  return (
    err instanceof Error &&
    err.name === "AppError" &&
    typeof (err as AppError).statusCode === "number" &&
    typeof (err as AppError).code === "string"
  );
}
