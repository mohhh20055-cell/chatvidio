-- ============================================================
-- 🎥 نظام اشتراكات البث المباشر المتقدم (يوم / شهر / 3 أشهر / 6 أشهر)
-- منصة ZoomDz التعليمية
-- ============================================================
-- 
-- هذا الملف يحتوي على جميع الجداول والأعمدة اللازمة لتشغيل نظام الاشتراكات
-- المجدولة للبث مع نظام تحرير الأرباح المعلقة لكل حصة مكتملة ورسوم المنصة التلقائية.
-- ============================================================

-- 1️⃣ تحديث جدول العروض والدروس (offers) لدعم خطط البث المباشر
DO $$ 
BEGIN
    -- نوع الخطة (single, 1_day, 1_month, 3_months, 6_months)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='plan_type') THEN
        ALTER TABLE public.offers ADD COLUMN plan_type VARCHAR(50) DEFAULT '1_day';
    END IF;

    -- عدد الحصص الإجمالي ضمن الخطة
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='total_sessions') THEN
        ALTER TABLE public.offers ADD COLUMN total_sessions INT DEFAULT 1;
    END IF;

    -- مدة الحصة الواحدة بالدقائق (مثلاً: 60، 90، 120 دقيقة)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='session_duration') THEN
        ALTER TABLE public.offers ADD COLUMN session_duration INT DEFAULT 60;
    END IF;

    -- سعر الحصة الواحدة الصافي للأستاذ (دج)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='price_per_session') THEN
        ALTER TABLE public.offers ADD COLUMN price_per_session NUMERIC(12, 2) DEFAULT 0;
    END IF;

    -- رسوم بث المنصة للحصة الواحدة (50 دج لكل ساعة تلقائياً)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='platform_fee_per_session') THEN
        ALTER TABLE public.offers ADD COLUMN platform_fee_per_session NUMERIC(12, 2) DEFAULT 50;
    END IF;

    -- إجمالي رسوم المنصة للخطة كاملة
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='total_platform_fee') THEN
        ALTER TABLE public.offers ADD COLUMN total_platform_fee NUMERIC(12, 2) DEFAULT 50;
    END IF;

    -- إجمالي ما سيحصل عليه الأستاذ (سعر الحصة × عدد الحصص)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='total_teacher_price') THEN
        ALTER TABLE public.offers ADD COLUMN total_teacher_price NUMERIC(12, 2) DEFAULT 0;
    END IF;

    -- المبلغ الإجمالي الذي سيدفعه الطالب (شامل رسوم المنصة)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='total_student_price') THEN
        ALTER TABLE public.offers ADD COLUMN total_student_price NUMERIC(12, 2) DEFAULT 0;
    END IF;

    -- عدد الحصص المكتملة حتى الآن
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='completed_sessions_count') THEN
        ALTER TABLE public.offers ADD COLUMN completed_sessions_count INT DEFAULT 0;
    END IF;

    -- جدول الحصص وتواريخها وتوقيتها بالتفصيل ككائن JSONB
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='sessions_schedule') THEN
        ALTER TABLE public.offers ADD COLUMN sessions_schedule JSONB DEFAULT '[]'::jsonb;
    END IF;

    -- إجمالي الرصيد المحرر للأستاذ من هذا العرض حتى الآن
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='total_released_amount') THEN
        ALTER TABLE public.offers ADD COLUMN total_released_amount NUMERIC(12, 2) DEFAULT 0;
    END IF;
END $$;


-- 2️⃣ جدول حصص البث الفردية المجدولة (stream_sessions)
-- لتتبع حالة وموعد كل حصة على حدة، ورابط البث، وحالة اكتمالها وتحرير أموالها
CREATE TABLE IF NOT EXISTS public.stream_sessions (
    id BIGSERIAL PRIMARY KEY,
    offer_id BIGINT REFERENCES public.offers(id) ON DELETE CASCADE,
    teacher_id BIGINT REFERENCES public.teachers(id) ON DELETE CASCADE,
    session_number INT NOT NULL DEFAULT 1,             -- رقم الحصة (1، 2، 3 ...)
    title VARCHAR(255),                               -- عنوان أو موضوع الحصة
    session_date TIMESTAMPTZ NOT NULL,                -- تاريخ ووقت بدء الحصة بالضبط
    duration_minutes INT DEFAULT 60,                  -- مدة الحصة بالدقائق
    price_per_session NUMERIC(12, 2) DEFAULT 0,       -- سعر الحصة
    platform_fee NUMERIC(12, 2) DEFAULT 50,           -- رسوم المنصة للحصة
    status VARCHAR(50) DEFAULT 'upcoming',            -- upcoming (قادمة), live (مباشرة الآن), completed (مكتملة), cancelled (ملغاة)
    stream_url TEXT,                                  -- رابط غرفة البث للحصة
    stream_started_at TIMESTAMPTZ,                   -- تاريخ ووقت بدء البث الفعلي
    completed_at TIMESTAMPTZ,                        -- تاريخ ووقت اكتمال الحصة
    actual_duration_seconds INT DEFAULT 0,            -- المدة الفعلية للبث بالثواني
    teacher_released_amount NUMERIC(12, 2) DEFAULT 0, -- المبلغ المحرر للأستاذ بعد اكتمال هذه الحصة
    is_escrow_released BOOLEAN DEFAULT FALSE,         -- هل تم تحرير الرصيد المعلق لهذه الحصة للأستاذ
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- 3️⃣ جدول اشتراكات الطلاب في خطط البث (stream_subscriptions)
-- لتسجيل اشتراك كل طالب في الخطة كاملة والمبلغ المخصوم والرصيد المعلق للأستاذ
CREATE TABLE IF NOT EXISTS public.stream_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    offer_id BIGINT REFERENCES public.offers(id) ON DELETE CASCADE,
    student_id BIGINT REFERENCES public.students(id) ON DELETE CASCADE,
    teacher_id BIGINT REFERENCES public.teachers(id) ON DELETE CASCADE,
    plan_type VARCHAR(50) NOT NULL DEFAULT '1_day',   -- 1_day, 1_month, 3_months, 6_months
    total_sessions INT NOT NULL DEFAULT 1,            -- عدد الحصص الكلي في الخطة
    completed_sessions INT DEFAULT 0,                 -- عدد الحصص التي حضرها أو اكتملت
    price_per_session NUMERIC(12, 2) NOT NULL,        -- سعر الحصة الواحدة
    platform_fee_per_session NUMERIC(12, 2) NOT NULL, -- رسوم المنصة للحصة
    total_amount_paid NUMERIC(12, 2) NOT NULL,        -- المبلغ الإجمالي المخصوم من محفظة الطالب
    teacher_total_escrow NUMERIC(12, 2) NOT NULL,     -- المبلغ الإجمالي المودع في الرصيد المعلق للأستاذ
    teacher_released_so_far NUMERIC(12, 2) DEFAULT 0, -- المبلغ الذي تم تحريره للأستاذ حتى الآن
    status VARCHAR(50) DEFAULT 'active',              -- active (نشط), completed (مكتمل), cancelled (ملغى), refunded (مسترد)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- 4️⃣ جدول سجل تحرير الأموال من الرصيد المعلق (stream_escrow_releases)
-- يحتفظ بتوثيق كامل لكل عملية تحرير رصيد تمت للأستاذ عند اكتمال أي حصة
CREATE TABLE IF NOT EXISTS public.stream_escrow_releases (
    id BIGSERIAL PRIMARY KEY,
    offer_id BIGINT REFERENCES public.offers(id) ON DELETE SET NULL,
    session_id BIGINT REFERENCES public.stream_sessions(id) ON DELETE SET NULL,
    teacher_id BIGINT REFERENCES public.teachers(id) ON DELETE CASCADE,
    session_number INT NOT NULL,                      -- رقم الحصة التي اكتملت
    amount_released NUMERIC(12, 2) NOT NULL,          -- المبلغ المحرر للأستاذ (سعر الحصة × عدد الطلاب المشتركين)
    students_count INT NOT NULL DEFAULT 0,            -- عدد الطلاب المشتركين المستفيدين من الحصة
    released_at TIMESTAMPTZ DEFAULT NOW(),
    note TEXT                                         -- ملاحظة وتفاصيل التحويل
);


-- 5️⃣ فهارس الأداء (Indexes) لتسريع عمليات البحث والاستعلام
CREATE INDEX IF NOT EXISTS idx_offers_plan_type ON public.offers(plan_type);
CREATE INDEX IF NOT EXISTS idx_offers_teacher_id ON public.offers(teacher_id);
CREATE INDEX IF NOT EXISTS idx_stream_sessions_offer_id ON public.stream_sessions(offer_id);
CREATE INDEX IF NOT EXISTS idx_stream_sessions_teacher_id ON public.stream_sessions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_stream_sessions_status ON public.stream_sessions(status);
CREATE INDEX IF NOT EXISTS idx_stream_sessions_date ON public.stream_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_stream_subscriptions_student_id ON public.stream_subscriptions(student_id);
CREATE INDEX IF NOT EXISTS idx_stream_subscriptions_offer_id ON public.stream_subscriptions(offer_id);
CREATE INDEX IF NOT EXISTS idx_stream_subscriptions_status ON public.stream_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_stream_escrow_releases_teacher ON public.stream_escrow_releases(teacher_id);
CREATE INDEX IF NOT EXISTS idx_stream_escrow_releases_offer ON public.stream_escrow_releases(offer_id);


-- 6️⃣ إضافة تعليقات الشرح في قاعدة البيانات
COMMENT ON COLUMN public.offers.plan_type IS 'نوع خطة البث: 1_day (يوم), 1_month (شهر), 3_months (3 أشهر), 6_months (6 أشهر)';
COMMENT ON COLUMN public.offers.total_sessions IS 'إجمالي عدد الحصص المحدد ضمن الخطة';
COMMENT ON COLUMN public.offers.price_per_session IS 'سعر الحصة الواحدة الصافي للأستاذ بالدينار الجزائري';
COMMENT ON COLUMN public.offers.platform_fee_per_session IS 'رسوم المنصة للحصة الواحدة (50 دج للساعة)';
COMMENT ON COLUMN public.offers.total_student_price IS 'المبلغ الإجمالي للاشتراك الذي سيدفعه الطالب شاملاً رسوم المنصة';
COMMENT ON TABLE public.stream_sessions IS 'جدول تتبع كل حصة على حدة وتاريخها ورابطها وتحرير رصيدها';
COMMENT ON TABLE public.stream_subscriptions IS 'جدول اشتراكات الطلاب في خطط البث المباشر ورصيد الأستاذ المعلق';
COMMENT ON TABLE public.stream_escrow_releases IS 'سجل عمليات تحرير مستحقات الحصص المكتملة للأستاذ';
