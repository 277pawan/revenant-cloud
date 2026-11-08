# Redis restore proofs and snapshots

This is the single Redis product and operator guide. Redis proof history and snapshot history are separate: a proof records whether recovery worked; a snapshot is an optional, expiring RDB file that can be downloaded and restored.

## What Revenant does

1. Add a Redis resource with a `redis://` or `rediss://` URL. The URL is encrypted at rest; the dashboard never receives the password again. **Test URL** only checks connectivity and reads a redacted fingerprint. It does not save the resource or prove a backup.
2. Select **Run proof**. Revenant queues a proof and runs it in the cloud if the Redis is reachable there. A Revenant agent can run the same proof from a private network when the cloud cannot connect.
3. The runner captures Redis data and starts an isolated, temporary `redis-server` on loopback. It never writes to the source Redis. The sandbox loads the captured data, checks `PING`, key counts and a bounded content digest, records timings and removes its temporary files and process.
4. The proof result appears in **Proof history**. `Restored` means the recovery test passed; `Restore failed` means the test ran and the data did not pass; `Could not run` means the test itself could not complete. An unreachable cloud runner leaves the proof available for an agent instead of claiming the backup is bad.

### Capture method and what it proves

- **RDB capture:** when the Redis provider permits the replication stream, Revenant downloads an RDB from the server and loads that file in the sandbox. This tests that captured RDB itself can load.
- **Logical capture:** some managed Redis providers block RDB streaming. Revenant then transfers keys with `SCAN`, `DUMP`, `PTTL` and `RESTORE`, compares source and restored content digests, and writes an RDB from the restored sandbox. This proves the transferred data round-trips; the downloaded file is the rebuilt RDB, not the provider's original backup file.
- Logical capture is bounded (default ceiling: 50,000 keys and 256 MiB). If a ceiling is reached, the proof reports truncation; it must not be interpreted as a full-keyspace proof.

Raw key names and values are not shown in history. Fingerprints contain configuration metadata and digests, not Redis passwords or sampled values.

## Proofs versus stored snapshots

Proofs run whether snapshot storage is enabled or not. By default, the RDB is used for validation and discarded. To keep downloadable bytes, enable **Keep a compressed snapshot in Revenant storage** on the Redis resource before running the proof.

Each stored snapshot is compressed according to server configuration, and the encoding and checksum are recorded with its metadata. When requested, the API decompresses the bytes, verifies the stored checksum and confirms the Redis RDB signature before it sends a `.rdb` download. An `.rdb` is binary data: it is expected not to be readable in a text editor.

Every artifact has an expiry set at capture time. The plan caps the requested retention, the database rejects enabled storage without a positive TTL, and a background sweep deletes expired bytes and marks their history. Disabling storage deletes existing artifacts; deleting the Redis resource removes its credentials, proof history and snapshots. An expired or deleted snapshot cannot be downloaded.

## Download and restore a snapshot

1. Open **Redis → Snapshot history**, find a row with **Stored** status, and choose **Download RDB**. Failed captures, in-progress rows and expired snapshots have no downloadable artifact.
2. Keep the download as-is. Do not edit or open it as text. The dashboard opens **Restore this snapshot** with copyable commands for macOS/Linux. Run them in a terminal in the folder where the browser saved the file. Redis must be installed locally.
3. The commands copy it into a separate temporary data directory and start `redis-server` on port `6380` with persistence disabled. The server stays in the foreground. In a second terminal, validate and inspect it:

   ```bash
   redis-cli -p 6380 PING
   redis-cli -p 6380 DBSIZE
   ```

   Stop the temporary server with `Ctrl+C`. This local check does not alter production.
4. To recover a self-managed Redis, follow your incident procedure: stop the target Redis, take a copy of its current data directory, install the downloaded file there as the configured RDB filename (normally `dump.rdb`), and restart Redis. Do not replace files under a running server. For a managed Redis service, use its supported import/restore process; many providers do not permit uploading an arbitrary RDB.

The dashboard intentionally does not overwrite a production Redis. A restore changes data and can destroy newer writes; the safe local load is provided to inspect/recover under the operator's own controlled procedure.

## History, search and pagination

The Redis resource list, proof history and snapshot history are server-paginated and searchable. Resource pages show 20 entries; history pages show 10. **Previous/Next** navigate the full result set, and changing a search returns to page 1. When snapshot history is requested, snapshots more than 30 days old are purged (including stored artifact bytes) before the remaining history is returned. The dashboard only polls while a proof is pending/running and the tab is visible.

Proof detail includes outcome, executor, attempts, checks, key counts, restore time (RTO), observed recovery point (RPO) and error details. Snapshot history includes state, capture time, size, expiry and checksum, with download and delete actions where available.

## Self-hosted deployment requirements

- The API host needs `redis-server` and `redis-cli` binaries available to its Redis proof runner. The provided cloud image includes these; verify they are installed in custom deployments.
- Redis must be reachable from the API or from a running Revenant agent in the Redis network. A URL test from the API cannot validate a private endpoint reachable only by the agent.
- Configure persistent, shared artifact storage for production. The default `REDIS_ARTIFACT_BACKEND=local` stores files under `REDIS_ARTIFACT_DIR` (default `./data/redis-artifacts`); that is suitable for development, not ephemeral or multi-instance production hosts. For Cloudflare R2 set `REDIS_ARTIFACT_BACKEND=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`. `R2_ENDPOINT` is an optional override for S3-compatible storage.
- `REDIS_ARTIFACT_COMPRESSION` supports `gzip` (default), `zstd`, and `none`. The stored encoding is saved per snapshot, so a later config change does not prevent reading older artifacts.
- Run database migrations after updating the API. The Redis schema includes resources, encrypted credentials, proof records and TTL-bound snapshot metadata.

## API surfaces

All user routes are under `/api/v1` and organization-scoped:

| Route | Purpose |
|---|---|
| `POST /redis/test` | Test an unsaved URL; returns a redacted result |
| `GET /redis?page=…&pageSize=…&search=…` | Search and page Redis resources |
| `POST /redis`, `GET /redis/:id`, `PATCH /redis/:id`, `DELETE /redis/:id` | Manage resource and encrypted credentials |
| `POST /redis/:id/proofs` | Queue one restore proof |
| `GET /redis/:id/proofs/history` | Search and page proof history |
| `GET /redis/:id/snapshots/history` | Search and page snapshot history |
| `GET /redis/snapshots/:id/artifact` | Download a verified, unexpired stored RDB |
| `DELETE /redis/snapshots/:id` | Delete a stored artifact |

The cloud worker and agent use the internal runner routes to claim and complete queued proofs. Queue claims are safe across multiple workers; the user-facing history APIs do not expose credentials or artifact storage keys.
