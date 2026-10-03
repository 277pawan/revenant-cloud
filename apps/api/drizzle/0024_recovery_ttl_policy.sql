ALTER TABLE databases
  ADD COLUMN recovery_drills_enabled varchar(10) NOT NULL DEFAULT 'false',
  ADD COLUMN recovery_max_lifetime_minutes integer,
  ADD COLUMN recovery_cleanup_customer_snapshots varchar(10) NOT NULL DEFAULT 'false';

UPDATE databases
SET recovery_drills_enabled = 'true'
WHERE recovery_mode = 'aws-rds';
