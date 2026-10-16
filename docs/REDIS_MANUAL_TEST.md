# Redis provider — manual test script

Testing is yours. Run these top to bottom; each step says what a **PASS** looks like.
Nothing here needs AWS, and nothing needs a paid plan.

---

## 0. Prerequisites

```bash
# a Redis to test against (any of these works)
docker run -d --name redis-test -p 6379:6379 redis:7-alpine

# or a local install
redis-server --port 6379 --daemonize yes
```

**PASS:** `docker ps` shows `redis-test`, or `redis-cli ping` prints `PONG`.

---

## 1. CLI build + free-path proof (no account, no Docker required)

```bash
cd revenant-cli
go build ./...
go vet ./...

# prove a restore with the CLI alone
go run . redis-prove --url redis://localhost:6379
```

**PASS:**

- `restored                PASS`
- `restored keys` is a number close to `source keys`
- `restore time` is a small number of seconds
- `No data was uploaded.` is printed

**Also check it cleans up after itself:**

```bash
ls /tmp | grep revenant-redis    # expect nothing left behind
pgrep -a redis-server            # expect only YOUR redis, not a stray sandbox
```

### JSON output

```bash
go run . redis-prove --url redis://localhost:6379 --json
```

**PASS:** valid JSON with `restored: true`, `digest_match`, `rdb_bytes`, `rpo_observed_seconds`.

### Wrong password must be reported as auth, not "unreachable"

```bash
go run . redis-prove --url redis://:wrongpassword@localhost:6379
```

**PASS:** an error about credentials. **FAIL if** it says "could not reach" — that means auth and network failures are conflated.

### Unreachable host

```bash
go run . redis-prove --url redis://localhost:6399
```

**PASS:** "could not reach … use the Revenant agent".

### Password must never appear in output

```bash
go run . redis-prove --url redis://:supersecret@localhost:6379 --json | grep -c supersecret
```

**PASS:** prints `0`. The redacted URL is what gets logged.

---

## 2. Migrations

```bash
cd revenant-cloud
npm run db:migrate
```

**PASS:** no errors.

Verify the tables and the TTL constraint exist:

```bash
psql "$DATABASE_URL" -c "\dt redis_*"
# expect: redis_resources, redis_credentials, redis_snapshots, redis_proofs
```

### TTL invariant (important)

```bash
psql "$DATABASE_URL" -c \
  "INSERT INTO redis_resources (organization_id, name, host, snapshot_enabled, snapshot_retention_hours)
   SELECT id, 'ttl-violation-test', 'localhost', 'true', NULL FROM organizations LIMIT 1;"
```

**PASS:** it is **rejected** with a CHECK constraint violation. That is the guard that stops
"enabled with no expiry" from ever existing.

Clean up (it should have failed, but just in case):

```bash
psql "$DATABASE_URL" -c "DELETE FROM redis_resources WHERE name = 'ttl-violation-test';"
```

---

## 3. API — typecheck and boot

```bash
npm run typecheck
npm run dev
```

**PASS:** clean typecheck, API starts, and the log contains:

```
[redis-sweeper:embedded] TTL sweep every 300s
```

---

## 4. API — test an unsaved URL

Get a token from your normal login, then:

```bash
curl -s -X POST localhost:8080/api/v1/redis/test \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"redis://localhost:6379"}' | jq
```

**PASS:**

- `test.ok` is `true`
- `test.redactedUrl` contains no password
- `test.fingerprint.version` is populated
- `test.fingerprint.requirepass` is `"SET"` or `"NOT SET"` — **never an actual password**
- `test.fingerprint.sampledKeys` is `0` (the API must not read real key names)

### Unreachable URL is a 200, not a 500

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/v1/redis/test \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"redis://10.255.255.1:6379"}'
```

**PASS:** `200`, with `ok: false` and `unreachable: true` in the body.

### Bad URL rejected

```bash
curl -s -X POST localhost:8080/api/v1/redis/test \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"postgres://localhost:5432/x"}'
```

**PASS:** `400` with `VALIDATION_ERROR`.

---

## 5. API — register a Redis resource (storage OFF, the free path)

```bash
curl -s -X POST localhost:8080/api/v1/redis \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"cache-prod","url":"redis://:supersecret@localhost:6379"}' | jq
```

**PASS:**

- `201`
- `snapshotEnabled` is `false`
- `snapshotRetentionHours` is `null`
- **nowhere in the response** does `supersecret` appear

### Confirm the URL is encrypted at rest, not plaintext

```bash
psql "$DATABASE_URL" -c \
  "SELECT ciphertext FROM redis_credentials LIMIT 1;" | grep -c supersecret
```

**PASS:** `0`. The URL must be AES-256-GCM ciphertext.

### Plan limits

Create a second Redis resource on Starter (limit is 1):

```bash
curl -s -X POST localhost:8080/api/v1/redis \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"cache-prod-2","url":"redis://localhost:6379"}' | jq
```

**PASS:** `403` with `PLAN_LIMIT`, and the message mentions Pro.

---

## 6. API — opt in to snapshot storage, and verify the TTL clamps

```bash
# ask for 8760 hours (one year) on Starter, whose ceiling is 24
curl -s -X POST localhost:8080/api/v1/redis \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"cache-ttl-test","url":"redis://localhost:6379",
       "snapshotEnabled":true,"snapshotRetentionHours":8760}' | jq '.resource.snapshotRetentionHours'
```

**PASS:** prints `24`. **This is the single most important limit test** — the request asked
for 8760 and the plan granted 24. If it returns 8760, the clamp is broken.

Then turn storage on for `cache-prod` and start a proof:

```bash
curl -s -X PATCH localhost:8080/api/v1/redis/$REDIS_ID \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"snapshotEnabled":true}' | jq '.resource.snapshotRetentionHours'
```

**PASS:** `24`.

---

## 7. Proof quota (Starter = 4/month)

Run four times:

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST localhost:8080/api/v1/redis/$REDIS_ID/proofs \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' \
    | jq -c '{proof: .proof.proofId, snapshot: .proof.snapshotId, expires: .proof.expiresAt, err: .error}'
done
```

**PASS:**

- runs 1–4 succeed and each returns a `snapshotId` + an `expiresAt` ≈ 24 h out
- run 5 returns `403 PLAN_LIMIT` mentioning the monthly limit

---

## 8. TTL sweeper — the part that must actually delete bytes

Set a tiny TTL directly and let the sweeper do its job. Shorten to 1 hour via SQL so you
do not have to wait a day:

```bash
psql "$DATABASE_URL" -c \
  "UPDATE redis_snapshots SET expires_at = now() - interval '1 minute' WHERE organization_id = (SELECT id FROM organizations LIMIT 1);"
```

Give the sweeper a nudge (or wait 5 min) and check the log:

```bash
grep redis-sweeper <api log>
```

**PASS:** a line like `expired N/N snapshots, X bytes reclaimed`.

Verify the rows and, critically, that **no files are left on disk**:

```bash
psql "$DATABASE_URL" -c "SELECT status, deleted_at, storage_key FROM redis_snapshots ORDER BY created_at DESC LIMIT 5;"
find ./data/redis-artifacts -type f | head

# PASS: status = 'expired', deleted_at is set, storage_key is NULL
# PASS: find returns nothing — the BYTES are gone, not just the row
```

> If `find` still lists files, the sweeper marked rows without deleting artifacts. That is
> the exact bug this test exists to catch.

---

## 9. Agent Docker sandbox

```bash
cd revenant-agent
npm run typecheck

# with the API running and a proof started via step 7
npm start
```

**PASS:** the log shows the sandbox starting and the proof completing with `restored: true`.

Check the sandbox does not leak:

```bash
docker ps -a --filter "name=revenant-redis-proof"   # expect no containers
ls /tmp | grep revenant-redis                        # expect nothing
```

### The source cache must not be stalled

While a proof runs, watch the customer's Redis:

```bash
redis-cli --latency -i 5
```

**PASS:** latency stays flat. The agent reads source numbers only from `INFO keyspace` and
never runs SCAN or Lua against the live cache.

---

## 10. Multi-tenancy (do not skip this)

Create the same resource name under two different orgs:

```bash
# org A creates "shared-name"
# org B creates "shared-name"
```

**PASS:** both succeed (the unique index is scoped per organization).

Then, as org B, try to fetch org A's Redis by id:

```bash
curl -s localhost:8080/api/v1/redis/$ORG_A_ID -H "Authorization: Bearer $ORG_B_TOKEN" | jq
```

**PASS:** `404 NOT_FOUND` — never org A's data.

---

## 11. Deleting a resource must not orphan bytes

This is the leak the code guards against explicitly:

```bash
# create a resource with storage ON and run a proof so an artifact exists
find ./data/redis-artifacts -type f    # expect at least one file

curl -s -X DELETE localhost:8080/api/v1/redis/$REDIS_ID -H "Authorization: Bearer $TOKEN"

find ./data/redis-artifacts -type f    # PASS: expect NO files
```

**FAIL if** files remain. The rows cascade away on delete, so if bytes were not purged
first, nothing would ever clean them up.

---

## 12. Dashboard UI (`revenant-cloud-web`)

```bash
cd revenant-cloud-web
npm run typecheck && npm run build     # both must pass
npm run dev                           # http://localhost:5173
```

Log in, then open **Infrastructure → Redis**.

### 12.1 The free-plan gate

```sql
-- force the org onto the CLI-only Developer-equivalent state
UPDATE organizations SET plan = 'developer' WHERE name = 'Your_Org';
```

Reload. **PASS:** the page shows *"Redis proofs run from the CLI on the free
plan"* with the `revenant redis-prove --url …` command, and **no** "Add Redis"
button. Reset the plan afterwards.

### 12.2 Add a Redis — the whole flow in one screen

1. Click **Add Redis**.
2. Type name `cache-prod`.
3. Paste `redis://:supersecret@localhost:6379`.
4. Click **Test connection**.

**PASS:** green *"Connected — Revenant can reach this Redis"* with version,
key count, `Eviction policy`, and `requirepass: not set`. `redactedUrl` must
show `redis://:***@localhost:6379` — **the password must never appear**.

Add a few keys first so there is something to prove:

```bash
redis-cli set product:101 '{"name":"Laptop","price":800}'
redis-cli set product:102 '{"name":"Phone","price":400}'
redis-cli set session:abc '{"userId":42}'
redis-cli expire session:abc 3600
redis-cli dbsize      # expect 3
```

Re-test and confirm **Keys = 3** and `Keys with expiry = 1`.

### 12.3 Unreachable Redis must be amber, not red

Paste `redis://10.255.255.1:6379` and test.

**PASS:** amber *"Not reachable from Revenant"* with the CLI/agent advice.
**FAIL if** it shows a raw socket error — the message should be actionable.

### 12.4 The TTL clamp, visible in the UI

Tick **Keep a compressed snapshot in Revenant storage**, set retention to
**7 days**.

**PASS:** an amber inline warning appears — *"Your Starter plan caps this at 24
hours. We will store it for 24 hours instead — Pro allows 7 days."* Save, and
confirm the list row shows **24 hours**, not 7 days.

> This is the UI half of the clamp. The API half is test #7. Both must agree.

### 12.5 Proof quota surfaced

Starter allows 4/month, and the card should read **"4 proofs/month"** above the
list.

### 12.6 Run a proof end to end

Leave snapshot storage **on** for `cache-prod`, then click **Run restore proof**.

**PASS:** toast *"Restore proof queued"* with an expiry timestamp ~24 h out,
and the proof moves to `running`.

Start the agent so it can claim it:

```bash
cd revenant-agent
REVENANT_RUNNER_TOKEN=$RUNNER_TOKEN npm start
```

**PASS in the agent log:**

```
[...-redis] polling Redis restore proofs every 5000ms
[...-redis] claimed proof <id> for cache-prod (redis://:***@localhost:6379)
[...-redis] proof <id> → restored=true keys=3/3 rdb=...B
[...-redis] completed proof <id>
```

Back in the UI, switch to the **Proofs** tab.

**PASS:** the newest row reads **Restored**, `3 / 3` keys, a non-empty RTO and
RPO. Switch to **Snapshots**.

**PASS:** one row, status **Stored**, size > 0, and a live
`expires in 23h 59m` countdown. The fingerprint card now shows Keys = 3 and a
keyspace digest.

### 12.7 TTL expiry in the UI

Let the countdown lapse (or shorten it in SQL, then wait one sweep):

**PASS:** the row greys out, status becomes **Expired**, and the countdown
column goes to `—`. Click **refresh** — it should *not* disappear, because
seeing "expired" is how a customer learns the TTL is real.

### 12.8 Delete a snapshot from the UI

Click the bin icon on a **Stored** row.

**PASS:** toast *"Snapshot deleted"*, row flips to **Deleted**, and the file is
gone from `./data/redis-artifacts`.

### 12.9 Editing must not wipe credentials

Open **Edit** on a Redis. **PASS:** the URL field shows
*"Connection string unchanged"* with a **Replace it** link — never the URL
itself. Save without retyping it and confirm the resource still verifies.

> A blank URL must not overwrite the stored credential. If verification breaks
> after a no-op edit, that is the bug this test is for.

### 12.10 Roles

Log in as an **executor** and a **viewer**.

**PASS:** executor sees "Run restore proof" but not "Add Redis"; viewer sees the
list read-only with the *"your role does not include read access"* style
affordances and no action buttons.

---

## Quick regression list

| # | Test | Expected |
|---|---|---|
| 1 | `redis-prove` on a live Redis | `restored PASS` |
| 2 | Wrong password | auth error, not "unreachable" |
| 3 | Password in output | never appears |
| 4 | TTL CHECK constraint | rejects NULL retention |
| 5 | `/redis/test` fingerprint | `sampledKeys == 0` |
| 6 | Create 2nd Redis on Starter | `403 PLAN_LIMIT` |
| 7 | Request 8760 h TTL on Starter | stored as `24` |
| 8 | 5th proof in a month | `403 PLAN_LIMIT` |
| 9 | Sweeper past TTL | rows expired **and files deleted** |
| 10 | Cross-org read by id | `404` |
| 11 | Delete resource with artifacts | no orphan files |
| 12 | UI: test panel | green, password redacted |
| 13 | UI: TTL clamp warning | shows Starter 24 h, not 7 d |
| 14 | UI: run proof | agent claims → `Restored`, 3/3 keys |
| 15 | UI: no-op edit | credentials survive |
| 16 | UI: roles | executor/viewer see fewer actions |

## Known gaps (not yet built)

- **`redis-s3` artifact backend** is stubbed; only `local` is implemented. Swap
  in Cloudflare R2 or B2 behind `ArtifactStore` when you have traffic.
- **Proofs are not in the `jobs` table**, so they don't yet emit the signed
  JSON/PDF evidence passport that PostgreSQL drills produce. Wiring `redis_proofs`
  into the evidence pipeline is the natural next step.
- **Redis has no schedule.** Proofs are manual only; a weekly Redis drill would
  need `schedules` to gain a Redis target.
- **`redis_value_digest` samples the sandbox, not the source.** Comparing
  digests source-vs-restored would need SCAN/Lua against the customer's live
  cache, which we deliberately avoid — see the safety note in
  `redis-sandbox.ts`.
- **Drift detection** has fingerprint data but no comparison job yet.