import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../db/index.js";
import { encryptSecret } from "../lib/crypto.js";
import {
  checkMongoConnectivity,
  type MongoConnectivityStatus,
} from "./mongodb-connectivity.service.js";

const masterKey = Buffer.alloc(32, 9).toString("base64");
const uri = "******cluster0.example.mongodb.net/app?retryWrites=true";

function fakeDb(options: {
  engine?: string;
  databaseName?: string | null;
  credential?: { ciphertext: string; iv: string; authTag: string } | null;
  organizationMatches?: boolean;
} = {}): Database {
  const database = {
    id: "db-id",
    organizationId: "org-id",
    engine: options.engine ?? "mongodb",
    databaseName: options.databaseName ?? "app",
  };
  const credential = options.credential === undefined
    ? { organizationId: "org-id", databaseId: "db-id", ...encryptSecret(uri, masterKey) }
    : options.credential;
  let queryCount = 0;
  return {
    select() {
      const currentQuery = queryCount++;
      return {
        from() {
          return {
            where() {
              return {
                limit: async () => {
                  if (currentQuery === 0) {
                    return options.organizationMatches === false ? [] : [database];
                  }
                  return credential ? [credential] : [];
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

test("MongoDB connectivity runs a ping with the encrypted saved URI and database name", async () => {
  let received: { uri: string; databaseName: string } | undefined;
  const response = await checkMongoConnectivity(
    fakeDb(),
    masterKey,
    "org-id",
    "db-id",
    async (connectionUri, databaseName) => {
      received = { uri: connectionUri, databaseName };
    }
  );

  assert.deepEqual(received, { uri, databaseName: "app" });
  assert.equal(response.state, "available");
  assert.doesNotMatch(JSON.stringify(response), /cluster0|retryWrites/);
});

test("MongoDB connectivity reports a generic unavailable result without leaking URI", async () => {
  const response = await checkMongoConnectivity(
    fakeDb(),
    masterKey,
    "org-id",
    "db-id",
    async () => {
      throw new Error(`could not connect to ${uri}`);
    }
  );

  assert.equal(response.state, "unavailable");
  assert.match(response.message ?? "", /Atlas Network Access allowlist/);
  assert.doesNotMatch(JSON.stringify(response), /cluster0|retryWrites/);
});

test("MongoDB connectivity reports missing configuration explicitly", async () => {
  const missingCredential = await checkMongoConnectivity(
    fakeDb({ credential: null }),
    masterKey,
    "org-id",
    "db-id"
  );
  const missingName = await checkMongoConnectivity(
    fakeDb({ databaseName: " " }),
    masterKey,
    "org-id",
    "db-id"
  );

  assert.equal(missingCredential.state, "not_configured");
  assert.equal(missingName.state, "not_configured");
});

test("MongoDB status does not attempt a probe for a non-MongoDB engine", async () => {
  let probed = false;
  const response: MongoConnectivityStatus = await checkMongoConnectivity(
    fakeDb({ engine: "postgres" }),
    masterKey,
    "org-id",
    "db-id",
    async () => {
      probed = true;
    }
  );

  assert.equal(response.state, "not_configured");
  assert.equal(probed, false);
});