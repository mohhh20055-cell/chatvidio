-- ============================================================
--  مؤشر الكتابة "يكتب الآن" في الرسائل المباشرة
--  نفّذ هذا الملف في Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS message_typing (
    id              BIGSERIAL PRIMARY KEY,
    conversation_key TEXT   NOT NULL,
    user_id         INTEGER NOT NULL,
    user_type       TEXT   NOT NULL CHECK (user_type IN ('student', 'teacher')),
    is_typing       BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- مفتاح واحد لكل (محادثة + مستخدم)، حتى يعملUpsert مباشرة
CREATE UNIQUE INDEX IF NOT EXISTS message_typing_unique
    ON message_typing (conversation_key, user_id, user_type);

CREATE INDEX IF NOT EXISTS message_typing_key_idx
    ON message_typing (conversation_key);

-- تنظيف السجلات القديمة تلقائياً
CREATE OR REPLACE FUNCTION cleanup_message_typing()
RETURNS VOID AS $$
BEGIN
    DELETE FROM message_typing
    WHERE updated_at < NOW() - INTERVAL '1 day';
END;
$$ LANGUAGE plpgsql;

-- تشغيله كل ساعة إن كان pg_cron مفعّلاً في مشروعك (اختياري)
-- SELECT cron.schedule('cleanup-message-typing', '0 * * * *', 'SELECT cleanup_message_typing();');