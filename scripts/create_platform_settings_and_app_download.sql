-- ============================================================
-- SQL Script: إنشاء وتجهيز جدول إعدادات المنصة ورابط تحميل التطبيق
-- لتشغيله في Supabase SQL Editor أو أي قاعدة بيانات PostgreSQL سحابية
-- ============================================================

-- 1. إنشاء جدول الإعدادات العامة (platform_settings)
-- يخزن كل الإعدادات السحابية: رابط التطبيق، شريط الأخبار، صور الواجهة، العمولات، إلخ.
CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- تفعيل Row Level Security (RLS)
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

-- السماح للجميع بقراءة الإعدادات العامة (مثل رابط تحميل التطبيق وشريط الأخبار)
DROP POLICY IF EXISTS "Public read platform_settings" ON platform_settings;
CREATE POLICY "Public read platform_settings" 
ON platform_settings 
FOR SELECT 
USING (true);

-- السماح بعمليات الإدخال والتعديل (Upsert / Update)
DROP POLICY IF EXISTS "Service role & admin full access platform_settings" ON platform_settings;
CREATE POLICY "Service role & admin full access platform_settings" 
ON platform_settings 
FOR ALL 
USING (true)
WITH CHECK (true);

-- 2. إدخال إعدادات رابط تحميل التطبيق الافتراضية
INSERT INTO platform_settings (key, value, updated_at)
VALUES (
    'app_download',
    '{
        "apk_url": "",
        "version": "1.0.0",
        "version_code": 1,
        "update_notes": "تحسينات عامة على الأداء واستقرار البث المباشر",
        "is_active": true
    }'::jsonb,
    now()
)
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value,
    updated_at = now();

-- ============================================================
-- خيار إضافي: إذا أردت جدولا مستقلا مخصصا لتحميلات التطبيق (app_downloads)
-- ============================================================
CREATE TABLE IF NOT EXISTS app_downloads (
    id SERIAL PRIMARY KEY,
    version TEXT NOT NULL DEFAULT '1.0.0',
    version_code INT DEFAULT 1,
    apk_url TEXT NOT NULL,
    file_name TEXT DEFAULT 'zoomdz.apk',
    update_notes TEXT DEFAULT 'تحديث جديد للمنصة',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

ALTER TABLE app_downloads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read app_downloads" ON app_downloads;
CREATE POLICY "Public read app_downloads" ON app_downloads FOR SELECT USING (true);

DROP POLICY IF EXISTS "Full access app_downloads" ON app_downloads;
CREATE POLICY "Full access app_downloads" ON app_downloads FOR ALL USING (true) WITH CHECK (true);
