-- ============================================================
-- جدول التحقق المستقل من وقت البث - Stream Verification
-- ============================================================

-- إنشاء جدول التحقق من البث
CREATE TABLE IF NOT EXISTS stream_verification (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL,
    server_start_time TIMESTAMP WITH TIME ZONE,
    server_end_time TIMESTAMP WITH TIME ZONE,
    last_pause_time TIMESTAMP WITH TIME ZONE,
    total_paused_seconds INTEGER DEFAULT 0,
    total_duration_seconds INTEGER DEFAULT 0,
    actual_live_seconds INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- إنشاء فهرس للبحث السريع
CREATE INDEX IF NOT EXISTS idx_stream_verification_offer_id ON stream_verification(offer_id);
CREATE INDEX IF NOT EXISTS idx_stream_verification_teacher_id ON stream_verification(teacher_id);
CREATE INDEX IF NOT EXISTS idx_stream_verification_status ON stream_verification(status);

-- إضافة تعليق للجدول
COMMENT ON TABLE stream_verification IS 'جدول التحقق المستقل من وقت البث - يمنع التلاعب بأوقات البث';
COMMENT ON COLUMN stream_verification.server_start_time IS 'وقت البدء من الخادم (غير قابل للتلاعب من الأستاذ)';
COMMENT ON COLUMN stream_verification.server_end_time IS 'وقت الانتهاء من الخادم (غير قابل للتلاعب من الأستاذ)';
COMMENT ON COLUMN stream_verification.actual_live_seconds IS 'الوقت الفعلي للبث (بعد خصم وقت الإيقاف)';
COMMENT ON COLUMN stream_verification.status IS 'حالة التحقق: pending, started, completed, disputed';

-- ============================================================
-- تحديث جدول الجلسات لإضافة حقل للمبلغ المسترد
-- ============================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS partial_payment_note TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(10, 2) DEFAULT 0;

COMMENT ON COLUMN sessions.partial_payment_note IS 'ملاحظة عن الدفع الجزئي';
COMMENT ON COLUMN sessions.refund_amount IS 'المبلغ المسترد للطالب';

-- ============================================================
-- دالة لحساب وقت الإيقاف المتراكم
-- ============================================================

CREATE OR REPLACE FUNCTION calculate_total_paused_seconds(
    p_offer_id INTEGER
) RETURNS INTEGER AS $$
DECLARE
    v_total_paused INTEGER := 0;
    v_last_pause TIMESTAMP WITH TIME ZONE;
    v_verification RECORD;
BEGIN
    SELECT server_start_time, last_pause_time, total_paused_seconds
    INTO v_verification
    FROM stream_verification
    WHERE offer_id = p_offer_id;
    
    IF v_verification IS NOT NULL THEN
        -- إذا كان هناك إيقاف نشط (لا يوجد وقت انتهاء)
        IF v_verification.last_pause_time IS NOT NULL AND v_verification.server_end_time IS NULL THEN
            -- احسب الوقت من آخر إيقاف حتى الآن
            v_total_paused := v_verification.total_paused_seconds + 
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - v_verification.last_pause_time))::INTEGER;
        ELSE
            v_total_paused := v_verification.total_paused_seconds;
        END IF;
    END IF;
    
    RETURN v_total_paused;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- تحديث مشغل لتحديث وقت التحديث التلقائي
-- ============================================================

CREATE OR REPLACE FUNCTION update_stream_verification_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_stream_verification ON stream_verification;
CREATE TRIGGER trigger_update_stream_verification
    BEFORE UPDATE ON stream_verification
    FOR EACH ROW
    EXECUTE FUNCTION update_stream_verification_timestamp();
