-- ============================================================
-- ترحيل بيانات الدفع من Chargily إلى SofizPay
-- ============================================================

-- تغيير اسم العمود في جدول wallet_transactions
ALTER TABLE wallet_transactions 
    RENAME COLUMN IF EXISTS chargily_checkout_id TO sofizpay_transaction_id;

ALTER TABLE wallet_transactions 
    ADD COLUMN IF NOT EXISTS cib_transaction_id TEXT;

-- ============================================================
-- تحديث البيانات إذا كان هناك إشارات قديمة
-- ============================================================
UPDATE wallet_transactions 
SET description = REPLACE(description, 'Chargily', 'SofizPay')
WHERE description LIKE '%Chargily%';
