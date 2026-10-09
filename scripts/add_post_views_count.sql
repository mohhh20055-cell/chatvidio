-- ============================================================
-- ZoomDz Platform - SQL Migration: Post Unique Views Tracking
-- إضافة عمود مشاهدات المنشورات وحساب المشاهدة الفريدة لكل 24 ساعة
-- ============================================================

-- 1. إضافة عمود views_count إلى جدول المنشورات posts في حال عدم وجوده
ALTER TABLE posts ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0;

-- 2. إضافة فهرس (Index) لسرعة استعلام الأكثر مشاهدة
CREATE INDEX IF NOT EXISTS idx_posts_views_count ON posts(views_count DESC);

-- 3. (اختياري) جدول تتبع المشاهدات الفريدة على مستوى قاعدة البيانات (إذا أردت الاحتفاظ بها في Postgres):
CREATE TABLE IF NOT EXISTS post_views_log (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    viewer_identifier VARCHAR(255) NOT NULL, -- معرف المستخدم أو عنوان الـ IP
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- فهرس لتسريع التحقق من المشاهدة الأخيرة خلال 24 ساعة
CREATE INDEX IF NOT EXISTS idx_post_views_log_dedupe ON post_views_log(post_id, viewer_identifier, created_at DESC);
