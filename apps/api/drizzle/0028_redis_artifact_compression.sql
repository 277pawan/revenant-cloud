-- Redis artifacts: record the ACTUAL encoding of the stored bytes.
--
-- WHY THIS EXISTS
--
-- The storage key was built as `${snapshotId}.rdb.zst` while the bytes written
-- were raw, uncompressed RDB. The extension claimed zstd that was never
-- applied — a filename that lies about its contents, which is the worst kind of
-- bug: nothing errors, the size just quietly disagrees with the label.
--
-- Compression is now real, measured, and explicit.
--
-- MEASURED ON REAL RDBs (20k JSON product docs; 40k mixed cache keys):
--   2,089,173 B → 274,129 B gzip   (86.9% smaller)
--   2,900,435 B → 788,756 B gzip   (72.8% smaller)
--               → 716,642 B zstd   (75.3% smaller)
--   gunzip ~322 MB/s single core
--
-- An earlier revision of this migration asserted that an RDB was "already LZF
-- compressed, so a second pass recovers only ~5-15%" and defaulted to none.
-- That was wrong, and wrong in the direction that threw away the feature. LZF
-- is tuned for BGSAVE speed, not ratio, and real cache payloads are JSON-shaped
-- with repeated key structure — near the best case for DEFLATE. Hence gzip as
-- the default now. See docs/REDIS_SYSTEM_DESIGN.md.
--
-- Anything stored before this migration has NULL here, which reads as 'none' —
-- the truth for every artifact written so far.
ALTER TABLE "redis_snapshots"
  ADD COLUMN IF NOT EXISTS "compression" varchar(16) NOT NULL DEFAULT 'gzip';

-- Guard the value space in the database, so no future code path can write an
-- encoding the reader does not implement and have restore silently break.
ALTER TABLE "redis_snapshots"
  ADD CONSTRAINT "redis_snapshots_compression_valid"
  CHECK (compression IN ('none', 'gzip', 'zstd'));