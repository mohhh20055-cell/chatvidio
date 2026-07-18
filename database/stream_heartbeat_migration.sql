-- Migration: نظام heartbeat ومراقبة الأستاذ في صفحة البث
-- طبّق هذا الملف يدوياً في Supabase SQL Editor

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS teacher_last_heartbeat TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_period_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS force_ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

ALTER TABLE stream_verification
  ADD COLUMN IF NOT EXISTS end_reason TEXT DEFAULT 'manual';
-- القيم الممكنة: 'manual', 'expired_offer', 'grace_timeout', 'force_end', 'teacher_left'
