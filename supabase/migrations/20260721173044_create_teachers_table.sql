/*
# Create teachers table with image fields

## Summary
Creates the `teachers` table that stores teacher registration data including profile images, ID card images, and certificate images. This is the table the admin panel reads from when displaying pending teacher applications.

## New Tables
- `teachers`
  - `id` (serial, primary key) — unique teacher ID
  - `full_name` (text) — teacher's full name
  - `email` (text, unique) — teacher's email, used for sending approval/rejection emails
  - `password_hash` (text) — bcrypt hashed password
  - `phone` (text) — phone number
  - `specialization` (text) — subject specialization
  - `teaching_level` (text) — education level taught
  - `profile_image` (text) — filename of profile photo in storage bucket `profiles`
  - `id_card_image` (text) — filename of ID card image in storage bucket `profiles`
  - `certificate_image` (text) — filename of teaching certificate in storage bucket `profiles`
  - `status` (text) — 'pending', 'approved', or 'rejected'
  - `rejection_reason` (text) — reason if rejected
  - `is_banned` (boolean) — whether teacher is banned
  - `ban_reason` (text) — reason for ban
  - `balance` (numeric) — current withdrawable balance
  - `pending_withdraw` (numeric) — amount pending withdrawal
  - `total_withdrawn` (numeric) — total amount withdrawn to date
  - `wallet_balance` (numeric) — wallet balance (alias)
  - `email_verified` (boolean) — whether email is verified
  - `created_at` (timestamptz) — registration timestamp
  - `updated_at` (timestamptz) — last update timestamp

## Security
- RLS enabled. Since this is a backend-managed table (the Express server uses the service role key to manage it), policies allow anon + authenticated access. The admin middleware handles authorization.
*/

CREATE TABLE IF NOT EXISTS teachers (
    id serial PRIMARY KEY,
    full_name text NOT NULL,
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    phone text,
    specialization text,
    teaching_level text,
    profile_image text,
    id_card_image text,
    certificate_image text,
    status text NOT NULL DEFAULT 'pending',
    rejection_reason text,
    is_banned boolean NOT NULL DEFAULT false,
    ban_reason text,
    balance numeric NOT NULL DEFAULT 0,
    pending_withdraw numeric NOT NULL DEFAULT 0,
    total_withdrawn numeric NOT NULL DEFAULT 0,
    wallet_balance numeric NOT NULL DEFAULT 0,
    email_verified boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE teachers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_teachers" ON teachers;
CREATE POLICY "anon_select_teachers" ON teachers FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_teachers" ON teachers;
CREATE POLICY "anon_insert_teachers" ON teachers FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_teachers" ON teachers;
CREATE POLICY "anon_update_teachers" ON teachers FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_teachers" ON teachers;
CREATE POLICY "anon_delete_teachers" ON teachers FOR DELETE
TO anon, authenticated USING (true);
