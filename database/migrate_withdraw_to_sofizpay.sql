-- ============================================================
-- ترحيل السحب من CCP إلى SofizPay Public Key
-- ============================================================

-- إضافة عمود مفتاح SofizPay العام للأساتذة
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS sofizpay_public_key TEXT;

-- إضافة عمود لحفظ نتيجة المعاملة
ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS sofizpay_transaction_id TEXT;
ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS sofizpay_status TEXT;

-- تحديث البيانات القديمة
UPDATE withdraw_requests 
SET description = REPLACE(description, 'CCP', 'SofizPay')
WHERE description LIKE '%CCP%';
