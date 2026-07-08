// ============================================================
// مسارات الحجز - Booking Routes (معدل بالكامل)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');

const { supabase } = require('../config/database');
// ✅ استيراد authorize من middleware مباشرة (بدون تعريف محلي)
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');

// ============================================================
// إنشاء حجز جديد (معدل)
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

        // ✅ التحقق من أن الطالب هو نفسه المسجل
        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعملية الحجز' });
        }

        // ✅ التحقق من وجود الطالب
        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        // ✅ التحقق من تأكيد البريد الإلكتروني
        if (!student.email_verified) {
            return res.status(403).json({ 
                success: false, 
                error: 'يجب تأكيد البريد الإلكتروني أولاً قبل حجز الحصص',
                email_not_verified: true
            });
        }

        // ✅ التحقق من وجود العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        // ✅ التحقق من أن العرض ليس منتهياً
        const now = new Date();
        const offerDate = new Date(offer.offer_date);
        if (offerDate < now && offer.status !== 'live') {
            return res.status(400).json({ success: false, error: 'هذا العرض قد انتهى' });
        }

        // ✅ التحقق من عدم وجود حجز مكرر
        const { data: existing } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (existing) {
            return res.status(400).json({ success: false, error: 'لقد قمت بالفعل بحجز هذه الحصة' });
        }

        // ✅ تحديد إذا كانت الحصة مجانية
        let isFree = offer.is_free === true || offer.price === 0;
        let session = null;

        if (isFree) {
            // ✅ حجز حصة مجانية
            session = await insert('sessions', {
                offer_id,
                student_id,
                payment_status: 'paid',
                payment_amount: 0,
                teacher_earned: 0,
                paid_from_wallet: false,
                created_at: new Date().toISOString()
            });
            
            // ✅ إضافة الطالب إلى غرفة الانتظار
            await insert('waiting_room', { 
                offer_id, 
                student_id,
                joined_at: new Date().toISOString()
            });
        } else {
            // ✅ التحقق من الرصيد
            const currentBalance = student.wallet_balance || 0;

            if (currentBalance < offer.price) {
                return res.status(400).json({
                    success: false,
                    error: `رصيدك غير كافٍ. رصيدك الحالي: ${currentBalance} دج. سعر الحصة: ${offer.price} دج`,
                    insufficient_balance: true,
                    needed: offer.price - currentBalance
                });
            }

            // ✅ خصم المبلغ من رصيد الطالب
            const newBalance = currentBalance - offer.price;
            await update('students', student_id, { wallet_balance: newBalance });

            // ✅ تسجيل المعاملة
            await insert('wallet_transactions', {
                student_id: student_id,
                amount: offer.price,
                type: 'withdraw',
                status: 'completed',
                description: `حجز حصة: ${offer.subject_name}`,
                created_at: new Date().toISOString()
            });

            // ✅ إنشاء الجلسة
            session = await insert('sessions', {
                offer_id,
                student_id,
                payment_status: 'paid',
                payment_amount: offer.price,
                teacher_earned: 0,
                paid_from_wallet: true,
                created_at: new Date().toISOString()
            });

            // ✅ إضافة الطالب إلى غرفة الانتظار
            await insert('waiting_room', { 
                offer_id, 
                student_id,
                joined_at: new Date().toISOString()
            });

            // ✅ إضافة أرباح المدرس (90% بعد خصم العمولة 10%)
            const teacher = await getOne('teachers', 'id', offer.teacher_id);
            if (teacher) {
                const commission = offer.price * 0.1;
                const teacherEarned = offer.price - commission;
                
                await update('teachers', offer.teacher_id, {
                    balance: (teacher.balance || 0) + teacherEarned,
                    total_earned: (teacher.total_earned || 0) + teacherEarned
                });
                
                await update('sessions', session.id, { teacher_earned: teacherEarned });
            }
        }

        // ✅ إنشاء كلمة مرور فريدة للطالب (لـ Jitsi)
        const studentPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
        
        // ✅ حفظ كلمة المرور الفريدة للطالب
        try {
            await supabase
                .from('student_room_passwords')
                .insert({
                    offer_id: offer_id,
                    student_id: student_id,
                    password: studentPassword,
                    used: false,
                    created_at: new Date().toISOString()
                });
        } catch (passwordError) {
            console.error('خطأ في حفظ كلمة مرور الطالب:', passwordError.message);
            // لا نوقف العملية إذا فشل حفظ كلمة المرور
        }

        // ✅ إرسال إشعار للطالب
        await insert('notifications', {
            user_id: student_id,
            user_type: 'student',
            title: isFree ? '✅ تم حجز الحصة المجانية' : '✅ تم حجز الحصة بنجاح',
            message: isFree 
                ? `لقد قمت بحجز الحصة "${offer.subject_name}" بنجاح (حصة مجانية). سيتم إشعارك عند بدء البث.`
                : `لقد قمت بحجز الحصة "${offer.subject_name}" بنجاح. تم خصم ${offer.price} دج من رصيدك. سيتم إشعارك عند بدء البث.`,
            offer_id: offer_id,
            is_read: false,
            created_at: new Date().toISOString()
        });

        // ✅ حساب عدد الطلاب المسجلين
        const { count: bookedCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (countError) {
            console.error('خطأ في حساب عدد الطلاب:', countError.message);
        }

        const totalBooked = bookedCount || 1;

        // ✅ إرسال إشعار للمدرس
        const teacher = await getOne('teachers', 'id', offer.teacher_id);
        if (teacher) {
            await insert('notifications', {
                user_id: offer.teacher_id,
                user_type: 'teacher',
                title: `📊 طالب جديد حجز حصتك "${offer.subject_name}"`,
                message: `قام الطالب ${student.full_name} بحجز حصتك "${offer.subject_name}". إجمالي الطلاب المسجلين الآن: ${totalBooked} طالب.`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            });

            // ✅ إذا كان هناك أكثر من طالب، إشعار إضافي للمدرس
            if (totalBooked > 1) {
                await insert('notifications', {
                    user_id: offer.teacher_id,
                    user_type: 'teacher',
                    title: `📈 ${totalBooked} طالب مسجل في حصتك "${offer.subject_name}"`,
                    message: `لديك ${totalBooked} طالب مسجل في حصة "${offer.subject_name}". استعد لبدء البث!`,
                    offer_id: offer_id,
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            }
        }

        // ✅ إرجاع النتيجة
        return res.json({
            success: true,
            session_id: session.id,
            is_free: isFree,
            message: isFree ? 'تم الحجز بنجاح (حصة مجانية)' : `تم حجز الحصة بنجاح. تم خصم ${offer.price} دج من رصيدك.`,
            total_booked: totalBooked,
            room_password: studentPassword // ✅ إرسال كلمة المرور للطالب
        });
    } catch (error) {
        console.error('خطأ في معالجة الحجز:', error.message);
        console.error('Stack:', error.stack);
        return res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم أثناء معالجة الحجز' 
        });
    }
});

// ============================================================
// ✅ جلب حجوزات الطالب
// ============================================================
router.get('/student/:student_id', authenticate, authorize(['student']), async (req, res) => {
    try {
        const student_id = parseInt(req.params.student_id);
        
        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data: bookings, error } = await supabase
            .from('sessions')
            .select(`
                *,
                offers:offer_id (
                    id,
                    subject_name,
                    teacher_id,
                    price,
                    is_free,
                    offer_date,
                    duration,
                    status,
                    stream_url,
                    stream_platform,
                    room_password
                ),
                teachers:teacher_id (
                    id,
                    full_name,
                    profile_url
                )
            `)
            .eq('student_id', student_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        return res.json({
            success: true,
            bookings: bookings || []
        });
    } catch (error) {
        console.error('خطأ في جلب حجوزات الطالب:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب حجوزات المدرس
// ============================================================
router.get('/teacher/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data: bookings, error } = await supabase
            .from('sessions')
            .select(`
                *,
                offers:offer_id (
                    id,
                    subject_name,
                    price,
                    is_free,
                    offer_date,
                    duration,
                    status
                ),
                students:student_id (
                    id,
                    full_name,
                    email,
                    phone,
                    profile_url
                )
            `)
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        return res.json({
            success: true,
            bookings: bookings || []
        });
    } catch (error) {
        console.error('خطأ في جلب حجوزات المدرس:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إلغاء حجز
// ============================================================
router.post('/cancel', authenticate, [
    body('session_id').isInt().withMessage('معرف الجلسة غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { session_id, student_id } = req.body;

        // التحقق من الصلاحية
        if (req.user.userId !== student_id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // جلب الجلسة
        const session = await getOne('sessions', 'id', session_id);
        if (!session) {
            return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        }

        if (session.student_id !== student_id) {
            return res.status(403).json({ success: false, error: 'هذه الجلسة ليست لك' });
        }

        // التحقق من أن الحجز ليس منتهياً أو قيد البث
        const offer = await getOne('offers', 'id', session.offer_id);
        if (offer && (offer.status === 'live' || offer.status === 'teacher_ready')) {
            return res.status(400).json({ 
                success: false, 
                error: 'لا يمكن إلغاء الحجز بعد بدء البث' 
            });
        }

        // ✅ إلغاء الحجز
        await update('sessions', session_id, {
            payment_status: 'cancelled',
            cancelled_at: new Date().toISOString()
        });

        // ✅ إعادة المبلغ للطالب إذا كان مدفوعاً
        if (session.payment_status === 'paid' && session.payment_amount > 0) {
            const student = await getOne('students', 'id', student_id);
            if (student) {
                await update('students', student_id, {
                    wallet_balance: (student.wallet_balance || 0) + session.payment_amount
                });

                await insert('wallet_transactions', {
                    student_id: student_id,
                    amount: session.payment_amount,
                    type: 'refund',
                    status: 'completed',
                    description: `استرداد مبلغ حجز "${offer?.subject_name || 'غير معروف'}"`,
                    created_at: new Date().toISOString()
                });
            }
        }

        // ✅ إزالة من غرفة الانتظار
        await supabase
            .from('waiting_room')
            .delete()
            .eq('offer_id', session.offer_id)
            .eq('student_id', student_id);

        return res.json({
            success: true,
            message: 'تم إلغاء الحجز بنجاح'
        });
    } catch (error) {
        console.error('خطأ في إلغاء الحجز:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
