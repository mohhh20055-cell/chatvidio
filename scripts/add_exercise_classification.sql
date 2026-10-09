-- ============================================================
-- SQL Script: إضافة عمود تصنيف المنشورات (تمرين / درس / ملخص) إلى جدول التمارين
-- قم بنسخ هذا الكود ولصقه في SQL Editor داخل لوحة تحكم Supabase والضغط على Run
-- ============================================================

-- 1. إضافة عمود classification لتحديد صنف المنشور (تمرين، درس، ملخص)
ALTER TABLE exercise_posts ADD COLUMN IF NOT EXISTS classification TEXT DEFAULT 'تمرين';

-- 2. تحديث المنشورات الحالية لتأخذ التصنيف الافتراضي 'تمرين'
UPDATE exercise_posts SET classification = 'تمرين' WHERE classification IS NULL;
