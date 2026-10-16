# Cloudflare R2 setup

Ten minutes. The code is already in place — you only supply credentials.

---

## 1. Create the bucket

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Left sidebar → **R2** (first-time users get a "Purchase R2" / free-tier prompt — accept it, no card charged for the 10 GB free tier)
3. **Create bucket**
   - Bucket name: `revenant-redis-artifacts`
   - Location: **Automatic** (recommended)
   - Storage class: **Standard**

> Bucket names are globally unique across all of R2. If `revenant-redis-artifacts`
> is taken, append something — `revenant-redis-art-<yourinitials>` is fine.

---

## 2. Create the API token

1. Still in R2 → **Manage R2 API Tokens** (top right)
2. **Create Account API token**
3. Permissions:
   - **Object Read & Write** — for your bucket only (this is the setting that matters; do not grant Account-level)
4. TTL: leave as **not expiring** (you can rotate later)
5. Click **Create**
6. You now see three values — **copy them somewhere safe, the secret is shown only once**

| Value | Looks like | Goes into |
|---|---|---|
| Account ID | 32-char hex | `R2_ACCOUNT_ID` |
| Access Key ID | ~64 chars | `R2_ACCESS_KEY_ID` |
| Secret Access Key | long random string | `R2_SECRET_ACCESS_KEY` |

The Account ID is also on the R2 overview page, top-right.

---

## 3. Add the lifecycle rule — do not skip this

This is what makes TTL work **even if Revenant is completely down**. The app
sweeper deletes on its own schedule, but on Cloud Run the service can be down
exactly when a snapshot expires.

1. R2 → **revenant-redis-artifacts** → **Settings** → **Object lifecycle**
2. **Add rule**

| Field | Value |
|---|---|
| Rule name | `expire-redis-artifacts` |
| When | *Object expires* → **Then** *Delete object* |
| Match | Prefix: `redis/` |
| Age | **1 day** |

> Use **1 day** here. Pro's 7-day artifacts are still deleted by the app well
> before this rule fires — the rule is a backstop that catches anything the app
> missed, so err on the side of *shorter*. Setting it to 7 days would leave
> Starter customers' artifacts sitting for a week after expiry.

You can add a second, looser rule later if you want belt-and-braces.

---

## 4. Wire it up

**Local dev** — append to `revenant-cloud/.env`:

```bash
REDIS_ARTIFACT_BACKEND=r2
R2_ACCOUNT_ID=<your 32-char hex>
R2_ACCESS_KEY_ID=<your key id>
R2_SECRET_ACCESS_KEY=<your secret>
R2_BUCKET=revenant-redis-artifacts
```

**Production (Cloud Run)** — set the same five values as environment variables.
`REDIS_ARTIFACT_COMPRESSION` stays `gzip` (the default); nothing to set.

Restart the API and run one Redis proof. Confirm the file lands in the bucket
rather than on disk.

---

## 5. Verify

```bash
# a stored artifact should appear under the redis/ prefix
cd revenant-cloud/apps/api
npx tsx -e "
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
const c = new S3Client({
  region: 'auto',
  endpoint: \`https://\${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com\`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});
const r = await c.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: 'redis/' }));
for (const o of r.Contents ?? []) console.log(o.Key, o.Size, 'bytes');
"
```

**PASS:** one `.rdb.gz` object. **If you see `.rdb` with no `.gz`**, compression
did not apply — check `REDIS_ARTIFACT_COMPRESSION=gzip` is set.

---

## Cost reality

| | Free tier | Then |
|---|---|---|
| Storage | 10 GB | ~$0.015/GB-month |
| **Egress** | **unlimited, $0** | **$0** |

Egress being free is the entire reason for R2 over S3. A restore-heavy product
on S3 pays per GB downloaded, so your cheapest customers would be your most
expensive ones.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ARTIFACT_CONFIG_INCOMPLETE` | One of the four R2 vars missing or empty |
| `SignatureDoesNotMatch` | Wrong secret, or whitespace copied into `.env` |
| `403` on every call | Token lacks Object Read & Write, or is scoped to a different bucket |
| Artifacts never appear | `REDIS_ARTIFACT_BACKEND` still `local` — the factory caches, so restart the API after changing it |
| `NoSuchKey` on restore | Expected if the lifecycle rule already deleted it — that is the TTL working |

---

## Backing out

Set `REDIS_ARTIFACT_BACKEND=local` and restart. Rows keep pointing at R2 keys, so
old snapshots become unreadable — harmless, since they expire anyway. Use the
dashboard or `deleteRedisSnapshot` to clean up early.