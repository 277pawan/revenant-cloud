ALTER TABLE databases
  ADD COLUMN IF NOT EXISTS recovery_cleanup_customer_snapshots varchar(10) NOT NULL DEFAULT 'false';
