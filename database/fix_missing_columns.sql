-- ============================================================
-- كود إضافة الأعمدة المفقودة لجميع الجداول
-- ============================================================

-- ============================================================
-- جدول الطلاب (students)
-- ============================================================
ALTER TABLE students ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
-- جدول الأساتذة (teachers)
-- ============================================================
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
-- جدول العروض (offers)
-- ============================================================
ALTER TABLE offers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;

-- ============================================================
-- جدول الجلسات (sessions)
-- ============================================================
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS platform_fee DECIMAL(10, 2) DEFAULT 0;

-- ============================================================
-- جدول المحفظة (wallet_transactions)
-- ============================================================
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
-- جدول طلبات السحب (withdraw_requests)
-- ============================================================
ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
-- جدول الإشعارات (notifications)
-- ============================================================
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
-- جدول طلبات الحجز (booking_requests)
-- ============================================================
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
-- جدول طلبات الدعم (support_requests)
-- ============================================================
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
-- دالة لتحديث timestamp تلقائياً
-- ============================================================
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- إنشاء Triggers للأعمدة المفقودة
-- ============================================================

-- Students
DROP TRIGGER IF EXISTS trigger_students_updated_at ON students;
CREATE TRIGGER trigger_students_updated_at
    BEFORE UPDATE ON students
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Teachers
DROP TRIGGER IF EXISTS trigger_teachers_updated_at ON teachers;
CREATE TRIGGER trigger_teachers_updated_at
    BEFORE UPDATE ON teachers
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Offers
DROP TRIGGER IF EXISTS trigger_offers_updated_at ON offers;
CREATE TRIGGER trigger_offers_updated_at
    BEFORE UPDATE ON offers
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Sessions
DROP TRIGGER IF EXISTS trigger_sessions_updated_at ON sessions;
CREATE TRIGGER trigger_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Withdraw Requests
DROP TRIGGER IF EXISTS trigger_withdraw_requests_updated_at ON withdraw_requests;
CREATE TRIGGER trigger_withdraw_requests_updated_at
    BEFORE UPDATE ON withdraw_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Notifications
DROP TRIGGER IF EXISTS trigger_notifications_updated_at ON notifications;
CREATE TRIGGER trigger_notifications_updated_at
    BEFORE UPDATE ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Support Requests
DROP TRIGGER IF EXISTS trigger_support_requests_updated_at ON support_requests;
CREATE TRIGGER trigger_support_requests_updated_at
    BEFORE UPDATE ON support_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Booking Requests
DROP TRIGGER IF EXISTS trigger_booking_requests_updated_at ON booking_requests;
CREATE TRIGGER trigger_booking_requests_updated_at
    BEFORE UPDATE ON booking_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- ============================================================
-- كود Supabase Dashboard
-- ============================================================
-- انسخ الكود أعلاه ونفذه في Supabase Dashboard > SQL Editor
