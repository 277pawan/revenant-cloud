export type AwsIamCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export function normalizeAwsIamCredentials(
  credentials: Partial<AwsIamCredentials>
): AwsIamCredentials {
  const accessKeyId = credentials.accessKeyId?.trim() ?? "";
  const secretAccessKey = credentials.secretAccessKey?.trim() ?? "";
  const sessionToken = credentials.sessionToken?.trim() ?? "";

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS access key ID and secret access key are required");
  }
  if (accessKeyId.startsWith("ASIA") && !sessionToken) {
    throw new Error(
      "Temporary AWS credentials require a session token. Re-enter the access key, secret key, and session token."
    );
  }

  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

export function isAwsCredentialError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const awsError = error as { name?: string; message?: string; Code?: string };
  const name = awsError.name ?? awsError.Code ?? "";
  return (
    [
      "ExpiredToken",
      "ExpiredTokenException",
      "InvalidClientTokenId",
      "UnrecognizedClientException",
    ].includes(name) ||
    /security token included in the request is invalid/i.test(awsError.message ?? "")
  );
}
