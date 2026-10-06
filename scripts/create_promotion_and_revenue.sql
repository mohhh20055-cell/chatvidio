-- ZoomDz: promotion applications and package revenue settings
-- Run after reviewing in Supabase SQL editor.
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS platform_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (platform_commission_percent BETWEEN 0 AND 100);
ALTER TABLE public.package_subscriptions ADD COLUMN IF NOT EXISTS gross_price NUMERIC(12,2);
ALTER TABLE public.package_subscriptions ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.package_subscriptions ADD COLUMN IF NOT EXISTS teacher_net_amount NUMERIC(12,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.promotion_applications (
  id BIGSERIAL PRIMARY KEY,
  applicant_id BIGINT REFERENCES public.students(id) ON DELETE SET NULL,
  applicant_name TEXT NOT NULL,
  email TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','facebook','instagram','tiktok')),
  channel_url TEXT NOT NULL,
  video_url TEXT NOT NULL,
  subscriber_count INTEGER NOT NULL DEFAULT 0 CHECK (subscriber_count >= 0),
  expected_views INTEGER NOT NULL DEFAULT 0 CHECK (expected_views >= 0),
  video_duration_minutes NUMERIC(6,2) NOT NULL CHECK (video_duration_minutes >= 5),
  ccp_account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid')),
  admin_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.promotion_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "promotion_public_none" ON public.promotion_applications;
CREATE POLICY "promotion_public_none" ON public.promotion_applications FOR SELECT USING (false);
CREATE INDEX IF NOT EXISTS idx_promotion_applications_status ON public.promotion_applications(status);

INSERT INTO public.platform_settings(key,value)
VALUES ('revenue_settings', '{"package_platform_commission":10,"package_fixed_discount":0,"promotion_per_1000_views":500,"promotion_min_video_minutes":5}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = public.platform_settings.value || EXCLUDED.value, updated_at = NOW();

-- الحساب: platform_fee = max(0, gross_price - fixed_discount) * commission / 100
-- teacher_net_amount = gross_price - fixed_discount - platform_fee
