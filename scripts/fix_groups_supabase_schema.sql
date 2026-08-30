-- ============================================================
-- سكريبت تحديث قاعدة بيانات Supabase للمجموعات (ZoomDz Groups)
-- قم بنسخ هذا الكود ولصقه في SQL Editor داخل لوحة تحكم Supabase والضغط على Run
-- ============================================================

-- 1. إزالة قيد المفتاح الأجنبي (Foreign Key) لـ student_id في جدول group_members
-- هذا القيد كان يمنع إدراج معرف الأستاذ كعضو في المجموعة لأنه يشترط وجوده في جدول students فقط
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'group_members_student_id_fkey' 
        AND table_name = 'group_members'
    ) THEN
        ALTER TABLE group_members DROP CONSTRAINT group_members_student_id_fkey;
    END IF;
END $$;

-- 2. إضافة عمود user_type لتحديد نوع العضو (student / teacher)
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS user_type TEXT DEFAULT 'student';

-- 3. إضافة عمود reactions وأعمدة المرفقات (ملفات PDF) في جدول group_messages
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}'::jsonb;
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS file_size BIGINT;
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS file_type TEXT;

-- 4. إنشاء الفهارس (Indexes) لتسريع استعلامات المجموعات والرسائل والأعضاء
CREATE INDEX IF NOT EXISTS idx_group_members_group_student ON group_members(group_id, student_id);
CREATE INDEX IF NOT EXISTS idx_group_members_student ON group_members(student_id);
CREATE INDEX IF NOT EXISTS idx_group_messages_group_created ON group_messages(group_id, created_at);
