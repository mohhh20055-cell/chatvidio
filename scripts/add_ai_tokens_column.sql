-- ============================================================
-- SQL Script: إضافة عمود نقاط المحادثة للمعلم الذكي إلى جدول الطلاب
-- لتشغيله في Supabase SQL Editor أو أي قاعدة بيانات PostgreSQL سحابية
-- ============================================================

-- 1. إضافة عمود ai_tokens لتخزين عدد النقاط المتاحة لكل طالب (الافتراضي 5 نقاط كهدية ترحيبية)
ALTER TABLE students ADD COLUMN IF NOT EXISTS ai_tokens INT DEFAULT 5;

-- 2. تحديث الحسابات الحالية لضمان حصولها على 5 نقاط كبداية مجانية لتجربة الميزة
UPDATE students SET ai_tokens = 5 WHERE ai_tokens IS NULL;

-- 3. توضيح هيكل المعاملات المستخدم لتوثيق عمليات الشراء (موجود بالفعل، للتأكيد فقط)
-- جدول wallet_transactions يحتوي على:
-- id (SERIAL PRIMARY KEY)
-- student_id (INT)
-- amount (INT)
-- type (TEXT) -- 'deposit', 'withdraw'
-- status (TEXT) -- 'pending', 'completed', 'failed'
-- description (TEXT)
