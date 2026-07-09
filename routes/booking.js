// ============================================================
// مسارات الحجز - Booking Routes (مصلح بالكامل)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');

const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');

// ============================================================
// ✅ إنشاء حجز جديد (مصلح بالكامل)
// ============================================================
router.post('/create', authenticate, authorize(['student']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    const { offer_id, student_id } = req.body;

    try {
        // ✅ التحقق من صحة المدخلات
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log('❌ أخطاء في التحقق:', errors.array());
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        console.log('📝 محاولة حجز العرض:', offer_id, 'للطالب:', student_id);

        // ✅ التحقق من أن الطالب هو نفسه المسجل
        if (req.user.userId !== student_id) {
            console.log('❌ محاولة حجز من قبل شخص آخر:', req.user.userId, '!=', student_id);
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعملية الحجز' });
        }

        // ✅ التحقق من وجود الطالب
        const student = await getOne('students', 'id', student_id);
        if (!student) {
            console.log('❌ الطالب غير موجود:', student_id);
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        console.log('👨‍🎓 الطالب:', student.full_name);

        // ✅ التحقق من تأكيد البريد الإلكتروني (اختياري)
        // if (!student.email_verified) {
        //     return res.status(403).json({ 
        //         success: false, 
        //         error: 'يجب تأكيد البريد الإلكتروني أولاً قبل حجز الحصص',
        //         email_not_verified: true
        //     });
        // }

        // ✅ التحقق من وجود العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            console.log('❌ العرض غير موجود:', offer_id);
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        console.log('📚 العرض:', offer.subject_name);

        // ✅ التحقق من أن العرض ليس منتهياً
        const now = new Date();
        const offerDate = new Date(offer.offer_date);
        if (offerDate < now && offer.status !== 'live') {
            return res.status(400).json({ success: false, error: 'هذا العرض قد انتهى' });
        }

        // ✅ التحقق من عدم وجود حجز مكرر
        const { data: existing, error: existingError } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (existingError) {
            console.log('⚠️ خطأ في التحقق من الحجز المكرر:', existingError.message);
        }

        if (existing) {
            return res.status(400).json({ 
                success: false, 
                error: 'لقد قمت بالفعل بحجز هذه الحصة',
                existing_session: existing
            });
        }

        // ✅ تحديد إذا كانت الحصة مجانية
        let isFree = offer.is_free === true || offer.price === 0;
        let session = null;

        // ✅ التحقق من الرصيد للعروض المدفوعة
        if (!isFree) {
            const currentBalance = student.wallet_balance || 0;
            if (currentBalance < offer.price) {
                return res.status(400).json({
                    success: false,
                    error: `رصيدك غير كافٍ. رصيدك الحالي: ${currentBalance} دج. سعر الحصة: ${offer.price} دج`,
                    insufficient_balance: true,
                    needed: offer.price - currentBalance
                });
            }
        }

        // ✅ إنشاء الجلسة (بدون teacher_id)
        const sessionData = {
            offer_id: offer_id,
            student_id: student_id,
            payment_status: 'paid',
            payment_amount: isFree ? 0 : offer.price,
            teacher_earned: 0,
            paid_from_wallet: !isFree,
            created_at: new Date().toISOString()
        };

        console.log('💾 إدخال الجلسة:', sessionData);

        const { data: newSession, error: sessionError } = await supabase
            .from('sessions')
            .insert(sessionData)
            .select()
            .single();

        if (sessionError) {
            console.error('❌ خطأ في إنشاء الجلسة:', sessionError);
            return res.status(500).json({ 
                success: false, 
                error: 'حدث خطأ في قاعدة البيانات: ' + sessionError.message 
            });
        }

        session = newSession;
        console.log('✅ تم إنشاء الجلسة:', session.id);

        // ✅ خصم المبلغ للعروض المدفوعة
        if (!isFree) {
            const newBalance = (student.wallet_balance || 0) - offer.price;
            await update('students', student_id, { 
                wallet_balance: newBalance,
                updated_at: new Date().toISOString()
            });

            // ✅ تسجيل المعاملة
            await insert('wallet_transactions', {
                student_id: student_id,
                amount: offer.price,
                type: 'withdraw',
                status: 'completed',
                description: `حجز حصة: ${offer.subject_name}`,
                created_at: new Date().toISOString()
            });
        }

        // ✅ إضافة الطالب إلى غرفة الانتظار
        try {
            await supabase
                .from('waiting_room')
                .insert({
                    offer_id: offer_id,
                    student_id: student_id,
                    joined_at: new Date().toISOString()
                });
        } catch (waitingError) {
            console.error('⚠️ خطأ في إضافة الطالب لغرفة الانتظار:', waitingError.message);
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
            console.error('⚠️ خطأ في حفظ كلمة مرور الطالب:', passwordError.message);
        }

        // ✅ حساب عدد الطلاب المسجلين
        const { count: bookedCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (countError) {
            console.error('⚠️ خطأ في حساب عدد الطلاب:', countError.message);
        }

        const totalBooked = bookedCount || 1;

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

        // ✅ إرسال إشعار للمدرس
        try {
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
            }
        } catch (notifError) {
            console.error('⚠️ خطأ في إرسال إشعار المدرس:', notifError.message);
        }

        // ✅ إرجاع النتيجة
        return res.json({
            success: true,
            session_id: session.id,
            is_free: isFree,
            message: isFree ? 'تم الحجز بنجاح (حصة مجانية)' : `تم حجز الحصة بنجاح. تم خصم ${offer.price} دج من رصيدك.`,
            total_booked: totalBooked,
            room_password: studentPassword,
            offer: {
                id: offer.id,
                subject_name: offer.subject_name,
                teacher_id: offer.teacher_id,
                price: offer.price,
                is_free: offer.is_free
            }
        });

    } catch (error) {
        console.error('❌ خطأ في معالجة الحجز:', error.message);
        console.error('📚 Stack:', error.stack);
        return res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم أثناء معالجة الحجز: ' + error.message 
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

        // ✅ جلب جميع العروض الخاصة بالمدرس أولاً
        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('id')
            .eq('teacher_id', teacher_id);

        if (offersError) throw offersError;

        if (!offers || offers.length === 0) {
            return res.json({ success: true, bookings: [] });
        }

        const offerIds = offers.map(o => o.id);

        // ✅ جلب الجلسات المرتبطة بهذه العروض
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
            .in('offer_id', offerIds)
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
