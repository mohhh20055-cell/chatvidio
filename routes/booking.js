// ============================================================
// مسارات الحجز - Booking Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');

// ✅ تعريف authorize محلياً
function authorize(roles = []) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'غير مصرح به' });
        }
        if (roles.length > 0 && !roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'صلاحيات غير كافية' });
        }
        next();
    };
}

// ============================================================
// إنشاء حجز جديد
// ============================================================
router.post('/create', authenticate, authorize(['student']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    const { offer_id, student_id } = req.body;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعملية الحجز' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        if (!student.email_verified) {
            return res.status(403).json({ 
                success: false, 
                error: 'يجب تأكيد البريد الإلكتروني أولاً قبل حجز الحصص',
                email_not_verified: true
            });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) return res.status(404).json({ success: false, error: 'العرض غير موجود' });

        const { data: existing } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (existing) return res.status(400).json({ success: false, error: 'مسجل بالفعل' });

        let isFree = offer.is_free === true || offer.price === 0;
        let session = null;

        if (isFree) {
            session = await insert('sessions', {
                offer_id,
                student_id,
                payment_status: 'paid',
                payment_amount: 0,
                teacher_earned: 0,
                paid_from_wallet: false
            });
            await insert('waiting_room', { offer_id, student_id });
        } else {
            const currentBalance = student.wallet_balance || 0;

            if (currentBalance < offer.price) {
                return res.status(400).json({
                    success: false,
                    error: `رصيدك غير كافٍ. رصيدك الحالي: ${currentBalance} دج. سعر الحصة: ${offer.price} دج`,
                    insufficient_balance: true,
                    needed: offer.price - currentBalance
                });
            }

            const newBalance = currentBalance - offer.price;
            await update('students', student_id, { wallet_balance: newBalance });

            await insert('wallet_transactions', {
                student_id: student_id,
                amount: offer.price,
                type: 'withdraw',
                status: 'completed',
                description: `حجز حصة: ${offer.subject_name}`,
                created_at: new Date().toISOString()
            });

            session = await insert('sessions', {
                offer_id,
                student_id,
                payment_status: 'paid',
                payment_amount: offer.price,
                teacher_earned: 0,
                paid_from_wallet: true
            });

            await insert('waiting_room', { offer_id, student_id });

            const teacher = await getOne('teachers', 'id', offer.teacher_id);
            const commission = offer.price * 0.1;
            const teacherEarned = offer.price - commission;
            await update('teachers', offer.teacher_id, {
                balance: (teacher.balance || 0) + teacherEarned,
                total_earned: (teacher.total_earned || 0) + teacherEarned
            });
            await update('sessions', session.id, { teacher_earned: teacherEarned });
        }

        await insert('notifications', {
            user_id: student_id,
            user_type: 'student',
            title: isFree ? '✅ تم حجز الحصة المجانية' : '✅ تم حجز الحصة بنجاح',
            message: isFree 
                ? `لقد قمت بحجز الحصة "${offer.subject_name}" بنجاح (حصة مجانية). سيتم إعلامك عند بدء البث.`
                : `لقد قمت بحجز الحصة "${offer.subject_name}" بنجاح. تم خصم ${offer.price} دج من رصيدك. سيتم إعلامك عند بدء البث.`,
            offer_id: offer_id,
            is_read: false,
            created_at: new Date().toISOString()
        });

        const { count: bookedCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        const teacher = await getOne('teachers', 'id', offer.teacher_id);
        if (teacher) {
            await insert('notifications', {
                user_id: offer.teacher_id,
                user_type: 'teacher',
                title: `📊 طالب جديد حجز حصتك "${offer.subject_name}"`,
                message: `قام الطالب ${student.full_name} بحجز حصتك "${offer.subject_name}". إجمالي الطلاب المسجلين الآن: ${bookedCount || 1} طالب.`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            });

            if (bookedCount && bookedCount > 1) {
                await insert('notifications', {
                    user_id: offer.teacher_id,
                    user_type: 'teacher',
                    title: `📈 ${bookedCount} طالب مسجل في حصتك "${offer.subject_name}"`,
                    message: `لديك ${bookedCount} طالب مسجل في حصة "${offer.subject_name}". استعد لبدء البث!`,
                    offer_id: offer_id,
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            }
        }

        return res.json({
            success: true,
            session_id: session.id,
            is_free: isFree,
            message: isFree ? 'تم الحجز بنجاح (حصة مجانية)' : `تم حجز الحصة بنجاح. تم خصم ${offer.price} دج من رصيدك.`,
            total_booked: bookedCount || 1
        });
    } catch (error) {
        console.error('خطأ في معالجة الحجز:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
