import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

/**
 * Encrypt a customer DB password with MASTER_KEY (AES-256-GCM).
 * Returns base64 ciphertext + iv + authTag for database_credentials.
 */
export function encryptSecret(plain: string, masterKeyBase64: string): EncryptedSecret {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("MASTER_KEY must decode to exactly 32 bytes (use: openssl rand -base64 32)");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypt — for runner / internal use only. Never expose via public API.
 */
export function decryptSecret(
  encrypted: EncryptedSecret,
  masterKeyBase64: string
): string {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("MASTER_KEY must decode to exactly 32 bytes");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(encrypted.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
