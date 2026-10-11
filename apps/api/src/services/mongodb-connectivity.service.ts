import { MongoClient } from "mongodb";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { databaseCredentials, databases } from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import { createAppError } from "../lib/errors.js";

export type MongoConnectivityStatus = {
  state: "available" | "unavailable" | "not_configured" | "unknown";
  checkedAt: string;
  message: string | null;
};

type MongoProbe = (uri: string, databaseName: string) => Promise<void>;

const MONGO_CHECK_TIMEOUT_MS = 8_000;

function status(
  state: MongoConnectivityStatus["state"],
  message: string | null
): MongoConnectivityStatus {
  return { state, checkedAt: new Date().toISOString(), message };
}

export async function probeMongoDatabase(
  uri: string,
  databaseName: string
): Promise<void> {
  const client = new MongoClient(uri, {
    connectTimeoutMS: MONGO_CHECK_TIMEOUT_MS,
    serverSelectionTimeoutMS: MONGO_CHECK_TIMEOUT_MS,
    socketTimeoutMS: MONGO_CHECK_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.db(databaseName).command({ ping: 1 });
  } finally {
    await client.close();
  }
}

export async function checkMongoConnectivity(
  db: Database,
  masterKey: string,
  organizationId: string,
  databaseId: string,
  probe: MongoProbe = probeMongoDatabase
): Promise<MongoConnectivityStatus> {
  const [database] = await db
    .select()
    .from(databases)
    .where(
      and(
        eq(databases.id, databaseId),
        eq(databases.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!database) {
    throw createAppError(404, "Database not found", "NOT_FOUND");
  }
  if (database.engine !== "mongodb") {
    return status("not_configured", "This connection check is only for MongoDB.");
  }
  if (!database.databaseName?.trim()) {
    return status("not_configured", "Set the MongoDB database name in connection settings.");
  }

  const [credential] = await db
    .select()
    .from(databaseCredentials)
    .where(
      and(
        eq(databaseCredentials.databaseId, databaseId),
        eq(databaseCredentials.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!credential) {
    return status("not_configured", "Add a MongoDB connection URI in database settings.");
  }

  let uri: string;
  try {
    uri = decryptSecret(credential, masterKey);
  } catch {
    return status(
      "unknown",
      "The saved MongoDB URI could not be decrypted. Re-enter it in database settings."
    );
  }

  try {
    await probe(uri, database.databaseName);
    return status(
      "available",
      "Cloud API connected to MongoDB and the read-only ping succeeded."
    );
  } catch (error) {
    const kind =
      error instanceof Error && error.name
        ? ` (${error.name})`
        : "";
    return status(
      "unavailable",
      `Cloud could not connect to MongoDB${kind}. Check the URI, database name, Atlas Network Access allowlist for the Cloud API, and database user's read permissions.`
    );
  }
}