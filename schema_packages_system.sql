-- ============================================================
-- 📦 نظام الباقات التعليمية - Educational Packages System Schema
-- منصة ZoomDz التعليمية
-- ============================================================

-- 1️⃣ جدول الباقات الرئيسي (Packages)
CREATE TABLE IF NOT EXISTS public.packages (
    id BIGSERIAL PRIMARY KEY,
    teacher_id BIGINT REFERENCES public.teachers(id) ON DELETE CASCADE,
    teacher_name VARCHAR(255),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    education_level VARCHAR(100) NOT NULL, -- رابعة متوسط BEM / بكالوريا علوم / بكالوريا آداب ... إلخ
    term_price NUMERIC(12, 2) DEFAULT 0,  -- سعر الاشتراك الفصلي (دج)
    annual_price NUMERIC(12, 2) DEFAULT 0, -- سعر الاشتراك السنوي (دج)
    has_term BOOLEAN DEFAULT TRUE,        -- تفعيل الاشتراك الفصلي
    has_annual BOOLEAN DEFAULT TRUE,      -- تفعيل الاشتراك السنوي
    thumbnail_url TEXT,
    subjects_data JSONB DEFAULT '[]'::jsonb, -- هيكل المواد والمحاور والدروس كاملة بصيغة JSON فائقة السرعة
    total_subjects INT DEFAULT 0,
    total_lessons INT DEFAULT 0,
    status VARCHAR(50) DEFAULT 'active', -- active, draft, archived
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2️⃣ جدول المواد المدرجة في الباقة (Package Subjects)
CREATE TABLE IF NOT EXISTS public.package_subjects (
    id BIGSERIAL PRIMARY KEY,
    package_id BIGINT REFERENCES public.packages(id) ON DELETE CASCADE,
    subject_name VARCHAR(200) NOT NULL, -- مادة الفيزياء، الرياضيات، العلوم...
    teacher_name VARCHAR(200),          -- الأستاذ المحاضر للمادة
    order_index INT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3️⃣ جدول المحاور التعليمية داخل المادة (Package Modules)
CREATE TABLE IF NOT EXISTS public.package_modules (
    id BIGSERIAL PRIMARY KEY,
    package_subject_id BIGINT REFERENCES public.package_subjects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL, -- المحور الأول: الميكانيك / المادة وتحولاتها
    description TEXT,
    order_index INT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4️⃣ جدول الدروس والمرفقات (Package Lessons - حتى 50 درساً للمادة)
CREATE TABLE IF NOT EXISTS public.package_lessons (
    id BIGSERIAL PRIMARY KEY,
    package_module_id BIGINT REFERENCES public.package_modules(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,       -- اسم الدرس (مثال: الدرس 01: قوانين نيوتن)
    video_url TEXT,                     -- رابط فيديو الشرح المشفر من Bunny.net
    summary_pdf_url TEXT,               -- ملخص الدرس والمصطلحات (ملف PDF)
    exercise_pdf_url TEXT,              -- السلسلة التطبيقية (ملف تمارين PDF)
    solution_video_url TEXT,            -- فيديو حل التمرين
    duration_minutes INT DEFAULT 0,
    order_index INT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5️⃣ جدول الدورات المكثفة للمادة (Package Intensive Courses)
CREATE TABLE IF NOT EXISTS public.package_intensive_courses (
    id BIGSERIAL PRIMARY KEY,
    package_subject_id BIGINT REFERENCES public.package_subjects(id) ON DELETE CASCADE,
    course_type VARCHAR(50) NOT NULL, -- 'term_review' (مراجعة الفصل) أو 'final_review' (المراجعة النهائية والبكالوريا)
    title VARCHAR(255) NOT NULL,
    videos_json JSONB DEFAULT '[]'::jsonb,        -- قائمة فيديوهات المراجعة الشاملة وحلول البكالوريا
    pdf_materials_json JSONB DEFAULT '[]'::jsonb, -- قائمة ملفات المواضيع المقترحة والملخصات الشاملة PDF
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6️⃣ جدول اشتراكات الطلاب في الباقات (Package Subscriptions)
CREATE TABLE IF NOT EXISTS public.package_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    package_id BIGINT REFERENCES public.packages(id) ON DELETE CASCADE,
    student_id BIGINT REFERENCES public.students(id) ON DELETE CASCADE,
    teacher_id BIGINT REFERENCES public.teachers(id) ON DELETE SET NULL,
    subscription_type VARCHAR(50) NOT NULL, -- 'term' (فصلي) أو 'annual' (سنوي)
    price_paid NUMERIC(12, 2) NOT NULL,     -- المبلغ المخصوم من الرصيد (دج)
    start_date TIMESTAMPTZ DEFAULT NOW(),
    end_date TIMESTAMPTZ NOT NULL,          -- تاريخ انتهاء الاشتراك
    status VARCHAR(50) DEFAULT 'active',    -- 'active', 'expired', 'cancelled'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ⚡ الفهارس لتسريع الاستعلامات (Indexes)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_packages_teacher_id ON public.packages(teacher_id);
CREATE INDEX IF NOT EXISTS idx_packages_education_level ON public.packages(education_level);
CREATE INDEX IF NOT EXISTS idx_packages_status ON public.packages(status);
CREATE INDEX IF NOT EXISTS idx_package_subjects_package_id ON public.package_subjects(package_id);
CREATE INDEX IF NOT EXISTS idx_package_modules_subject_id ON public.package_modules(package_subject_id);
CREATE INDEX IF NOT EXISTS idx_package_lessons_module_id ON public.package_lessons(package_module_id);
CREATE INDEX IF NOT EXISTS idx_package_subscriptions_student_id ON public.package_subscriptions(student_id);
CREATE INDEX IF NOT EXISTS idx_package_subscriptions_package_id ON public.package_subscriptions(package_id);
CREATE INDEX IF NOT EXISTS idx_package_subscriptions_status ON public.package_subscriptions(status);

-- ============================================================
-- 🛡️ سياسات الأمان والحماية (Row Level Security - RLS)
-- ============================================================
ALTER TABLE public.packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_intensive_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_subscriptions ENABLE ROW LEVEL SECURITY;

-- سياسات القراءة العامة للباقات النشطة
CREATE POLICY "Public Packages Read Access" ON public.packages FOR SELECT USING (true);
CREATE POLICY "Public Package Subjects Read Access" ON public.package_subjects FOR SELECT USING (true);
CREATE POLICY "Public Package Modules Read Access" ON public.package_modules FOR SELECT USING (true);
CREATE POLICY "Public Package Lessons Read Access" ON public.package_lessons FOR SELECT USING (true);
CREATE POLICY "Public Intensive Courses Read Access" ON public.package_intensive_courses FOR SELECT USING (true);
CREATE POLICY "Subscriptions Read Access" ON public.package_subscriptions FOR SELECT USING (true);

-- سياسات الإدراج والتعديل والحذف للخدمات الموثوقة (Service Role & Authenticated)
CREATE POLICY "Full Access to Service Role for Packages" ON public.packages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Full Access to Service Role for Subscriptions" ON public.package_subscriptions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Full Access to Service Role for Subjects" ON public.package_subjects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Full Access to Service Role for Modules" ON public.package_modules FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Full Access to Service Role for Lessons" ON public.package_lessons FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Full Access to Service Role for Intensive" ON public.package_intensive_courses FOR ALL USING (true) WITH CHECK (true);
