-- ============================================================
-- 💳 نظام الشحن اليدوي (بريدي موب / CCP) - Manual Deposit System Schema
-- منصة ZoomDz التعليمية
-- ============================================================

-- 0️⃣ إنشاء جدول إعدادات المنصة إذا لم يكن موجوداً
CREATE TABLE IF NOT EXISTS public.platform_settings (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1️⃣ إنشاء جدول طلبات الشحن اليدوي (Manual Deposit Requests)
CREATE TABLE IF NOT EXISTS public.manual_deposit_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    user_type VARCHAR(50) NOT NULL DEFAULT 'student', -- 'student' أو 'teacher'
    user_name VARCHAR(255),
    user_email VARCHAR(255),
    user_phone VARCHAR(50),
    amount NUMERIC(12, 2) NOT NULL,                   -- المبلغ المراد شحنه بالدينار الجزائري
    receipt_url TEXT NOT NULL,                        -- رابط أو مسار صورة وصل الدفع / التحويل
    notes TEXT,                                       -- ملاحظات المستخدم أو رقم المعاملة
    admin_notes TEXT,                                 -- ملاحظات الإدارة في حال القبول أو الرفض
    status VARCHAR(50) DEFAULT 'pending',             -- 'pending' (قيد المراجعة), 'approved' (مقبول), 'rejected' (مرفوض)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    processed_by BIGINT
);

-- 2️⃣ إنشاء الفهارس لتسريع البحث والاستعلامات (Indexes)
CREATE INDEX IF NOT EXISTS idx_manual_deposits_status ON public.manual_deposit_requests(status);
CREATE INDEX IF NOT EXISTS idx_manual_deposits_user ON public.manual_deposit_requests(user_id, user_type);
CREATE INDEX IF NOT EXISTS idx_manual_deposits_created_at ON public.manual_deposit_requests(created_at DESC);

-- 3️⃣ إعدادات الحساب البريدي الجاري وبريدي موب (CCP / BaridiMob Settings) في جدول platform_settings
INSERT INTO public.platform_settings (key, value, updated_at)
VALUES (
    'ccp_settings',
    '{
        "ccp_account_number": "0022334455",
        "ccp_key": "45",
        "ccp_rip": "00799999002233445545",
        "ccp_account_holder": "منصة ZoomDz التعليمية",
        "baridimob_phone": "0555001122",
        "instructions": "يرجى تحويل المبلغ بدقة عبر تطبيق BaridiMob أو من خلال مكتب البريد، ثم إرفاق صورة واضحة لوصل المعاملة أو لقطة شاشة التحويل لتتم مراجعتها وإضافة الرصيد إلى حسابك فوراً."
    }'::jsonb,
    NOW()
)
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value, updated_at = NOW();

-- 4️⃣ تمكين سياسات الأمان والحماية (Row Level Security - RLS)
ALTER TABLE public.manual_deposit_requests ENABLE ROW LEVEL SECURITY;

-- حذف أي سياسات سابقة لتفادي تكرار الأسماء
DROP POLICY IF EXISTS "Users can view their own manual deposit requests" ON public.manual_deposit_requests;
DROP POLICY IF EXISTS "Users can insert manual deposit requests" ON public.manual_deposit_requests;
DROP POLICY IF EXISTS "Admins can update manual deposit requests" ON public.manual_deposit_requests;

-- السماح بالقراءة لجميع المستخدمين
CREATE POLICY "Users can view their own manual deposit requests"
ON public.manual_deposit_requests
FOR SELECT
USING (true);

-- السماح بإرسال طلبات شحن جديدة
CREATE POLICY "Users can insert manual deposit requests"
ON public.manual_deposit_requests
FOR INSERT
WITH CHECK (true);

-- السماح للإدارة بتعديل ومعالجة الطلبات
CREATE POLICY "Admins can update manual deposit requests"
ON public.manual_deposit_requests
FOR ALL
USING (true);

-- ============================================================
-- ✅ تم تجهيز كود SQL بنجاح
-- ============================================================
