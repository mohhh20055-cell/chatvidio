-- ============================================================
-- 🗑️ حذف الأعمدة والجداول غير المستخدمة
-- ============================================================
-- ⚠️ تأكد من أخذ نسخة احتياطية قبل التنفيذ!
-- ============================================================

-- ============================================================
-- 📊 تحليل الكود - الجداول والأعمدة المستخدمة:
-- ============================================================

-- 🔴 جداول للحذف بالكامل (غير مستخدمة في الكود):
--    - login_logs
--    - active_stream
--    - waiting_room
--    - referral_pending_rewards

-- 🔴 أعمدة للحذف (غير مستخدمة):
--    - students: balance (نستخدم wallet_balance)
--    - banned_users: ip_address_encrypted, ip_address_masked
--    - referral_rewards: referral_id

-- ✅ الأعمدة المحفوظة (مستخدمة في الكود):
-- teachers: diploma_image, id_image, experience, facebook_url, instagram_url,
--           linkedin_url, website_url, twitter_url, youtube_url, whatsapp_url,
--           profile_url, profile_image, balance, referral_balance, etc.
-- students: profile_image, wallet_balance, referral_balance, gift_box_chances,
--           referral_code, education_level, etc.
-- offers: booked_count, stream_platform, stream_started_at, etc.
-- ============================================================


-- ============================================================
-- 1️⃣ جدول login_logs - غير مستخدم
-- ============================================================
DROP TABLE IF EXISTS login_logs;


-- ============================================================
-- 2️⃣ جدول active_stream - غير مستخدم (نستخدم offers)
-- ============================================================
DROP TABLE IF EXISTS active_stream;


-- ============================================================
-- 3️⃣ جدول waiting_room - غير مستخدم
-- ============================================================
DROP TABLE IF EXISTS waiting_room;


-- ============================================================
-- 4️⃣ جدول referral_pending_rewards - غير مستخدم
-- ============================================================
DROP TABLE IF EXISTS referral_pending_rewards;


-- ============================================================
-- 5️⃣ أعمدة غير مستخدمة في جدول students
-- ============================================================
ALTER TABLE students DROP COLUMN IF EXISTS balance;


-- ============================================================
-- 6️⃣ أعمدة غير مستخدمة في جدول banned_users
-- ============================================================
ALTER TABLE banned_users DROP COLUMN IF EXISTS ip_address_encrypted;
ALTER TABLE banned_users DROP COLUMN IF EXISTS ip_address_masked;


-- ============================================================
-- 7️⃣ عمود غير مستخدم في جدول referral_rewards
-- ============================================================
ALTER TABLE referral_rewards DROP COLUMN IF EXISTS referral_id;


-- ============================================================
-- ✅ رسالة انتهاء
-- ============================================================
-- تم حذف الجداول والأعمدة غير المستخدمة بنجاح!
