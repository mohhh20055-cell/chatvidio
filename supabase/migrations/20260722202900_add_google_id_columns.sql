-- ============================================================
-- Add google_id columns for Google OAuth
-- ============================================================

ALTER TABLE students ADD COLUMN IF NOT EXISTS google_id text UNIQUE;

ALTER TABLE teachers ADD COLUMN IF NOT EXISTS google_id text UNIQUE;
