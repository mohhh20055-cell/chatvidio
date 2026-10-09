-- ============================================================
-- 📊 تحديث قاعدة البيانات: تقييم الباقات والمبيعات والباقات المجانية
-- ============================================================

-- 1. إضافة أعمدة المبيعات والتقييم للباقات
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS sales_count INT DEFAULT 0;
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS average_rating NUMERIC(3,2) DEFAULT 0.0;
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS ratings_count INT DEFAULT 0;
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT FALSE;

-- 2. إضافة أعمدة المبيعات والتقييم للدورات
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS sales_count INT DEFAULT 0;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS average_rating NUMERIC(3,2) DEFAULT 0.0;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS ratings_count INT DEFAULT 0;

-- 3. جدول تقييمات الباقات (Package Ratings)
CREATE TABLE IF NOT EXISTS public.package_ratings (
    id BIGSERIAL PRIMARY KEY,
    package_id BIGINT REFERENCES public.packages(id) ON DELETE CASCADE,
    student_id BIGINT REFERENCES public.students(id) ON DELETE CASCADE,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(package_id, student_id)
);

-- 4. جدول تقييمات الدورات (Course Ratings)
CREATE TABLE IF NOT EXISTS public.course_ratings (
    id BIGSERIAL PRIMARY KEY,
    course_id BIGINT REFERENCES public.courses(id) ON DELETE CASCADE,
    student_id BIGINT REFERENCES public.students(id) ON DELETE CASCADE,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(course_id, student_id)
);

-- 4.5. جدول مشتريات الدورات (Course Purchases)
CREATE TABLE IF NOT EXISTS public.course_purchases (
    id BIGSERIAL PRIMARY KEY,
    course_id BIGINT REFERENCES public.courses(id) ON DELETE CASCADE,
    student_id BIGINT REFERENCES public.students(id) ON DELETE CASCADE,
    teacher_id BIGINT REFERENCES public.teachers(id) ON DELETE CASCADE,
    price NUMERIC(10,2) NOT NULL DEFAULT 0.0,
    platform_commission NUMERIC(10,2) NOT NULL DEFAULT 0.0,
    teacher_earned NUMERIC(10,2) NOT NULL DEFAULT 0.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(course_id, student_id)
);

-- 5. فهارس لسرعة الاستعلام
CREATE INDEX IF NOT EXISTS idx_package_ratings_package_id ON public.package_ratings(package_id);
CREATE INDEX IF NOT EXISTS idx_package_ratings_student_id ON public.package_ratings(student_id);
CREATE INDEX IF NOT EXISTS idx_course_ratings_course_id ON public.course_ratings(course_id);
CREATE INDEX IF NOT EXISTS idx_course_ratings_student_id ON public.course_ratings(student_id);
CREATE INDEX IF NOT EXISTS idx_course_purchases_student_id ON public.course_purchases(student_id);
CREATE INDEX IF NOT EXISTS idx_course_purchases_course_id ON public.course_purchases(course_id);
CREATE INDEX IF NOT EXISTS idx_course_purchases_teacher_id ON public.course_purchases(teacher_id);
