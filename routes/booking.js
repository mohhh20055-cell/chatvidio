const logger = require('../utils/logger');
// ============================================================
// مسارات الحجز - Booking Routes (مصلح بالكامل مع نظام الرصيد المعلق)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const { sendPushNotification } = require('../utils/notification');

const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');
const { getPublicImageUrl } = require('../utils/upload');
const { processStudentReferralRewardOnBooking } = require('../utils/referral');

// ============================================================
// ✅ إنشاء حجز جديد (مع نظام الرصيد المعلق)
// ============================================================
router.post('/create', authenticate, authorize(['student']), [
    body('offer_id').isInt().withMessage('معرف الدرس غير صالح'),
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

        console.log('📝 محاولة حجز الدرس:', offer_id, 'للطالب:', student_id);

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

        // ✅ التحقق من وجود الدرس
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            console.log('❌ الدرس غير موجود:', offer_id);
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        console.log('📚 الدرس:', offer.subject_name);

        let isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0;

        // ✅ التحقق من أن الدرس ليس منتهياً أو ملغى
        if (['completed', 'cancelled', 'expired'].includes(offer.status)) {
            return res.status(400).json({ success: false, error: 'هذا الدرس منتهي أو ملغى ولا يمكن حجزه' });
        }

        // للمسموح بالدخول للبث المجاني دائماً، أما المدفوع فلا يمكن حجزه بعد البدء
        if (!isFree && (['live', 'teacher_ready', 'paused'].includes(offer.status) || offer.stream_url || offer.stream_started_at)) {
            return res.status(400).json({ success: false, error: 'لقد بدأ هذا البث بالفعل، ولا يمكن حجز الحصة بعد بدء البث' });
        }

        const now = new Date();
        const offerDate = new Date(offer.offer_date);
        const durationMs = ((offer.duration || 60) * 60 * 1000);
        if (!isFree && (offerDate.getTime() + durationMs < now.getTime())) {
            return res.status(400).json({ success: false, error: 'هذا الدرس قد انتهى موعده' });
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
            if (existing.payment_status === 'cancelled') {
                // ✅ إذا كان الحجز ملغى، نسمح بإعادة الحجز
                await supabase
                    .from('sessions')
                    .delete()
                    .eq('id', existing.id);
            } else {
                return res.status(400).json({ 
                    success: false, 
                    error: 'لقد قمت بالفعل بحجز هذه الحصة',
                    existing_session: existing
                });
            }
        }

        // ✅ تحديد إذا كانت الحصة مجانية وحسابات خطة الاشتراك
        isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0;
        let session = null;
        
        const totalSessions = offer.total_sessions || 1;
        const sessionDuration = offer.session_duration || offer.duration || 60;
        const pricePerSession = isFree ? 0 : parseFloat(offer.price_per_session || offer.price || 0);
        const platformFeePerSession = isFree ? 0 : (offer.platform_fee_per_session || Math.round((sessionDuration / 60) * 50));
        const totalPlatformFee = isFree ? 0 : (offer.total_platform_fee || (platformFeePerSession * totalSessions));
        const totalTeacherPrice = isFree ? 0 : (offer.total_teacher_price || (pricePerSession * totalSessions));
        const totalCostForStudent = isFree ? 0 : (offer.total_student_price || (totalTeacherPrice + totalPlatformFee));
        
        let pendingBalance = totalCostForStudent;

        // ✅ التحقق من الرصيد (يتم خصم الرسوم فقط في الحصص المدفوعة، بينما الحصص المجانية مجانية تماماً)
        const currentBalance = student.wallet_balance || 0;
        if (!isFree && currentBalance < totalCostForStudent) {
            return res.status(400).json({
                success: false,
                error: `⚠️ رصيدك غير كافٍ. رصيدك الحالي: ${currentBalance} دج. الإجمالي المطلوب للاشتراك (${totalSessions} حصة شاملة ${totalPlatformFee} دج رسوم المنصة): ${totalCostForStudent} دج`,
                insufficient_balance: true,
                needed: totalCostForStudent - currentBalance
            });
        }

        // ✅ إنشاء الجلسة مع حالة "pending_stream" (في انتظار البث)
        const sessionData = {
            offer_id: offer_id,
            student_id: student_id,
            payment_status: 'pending_stream', // ✅ في انتظار البث
            payment_amount: pendingBalance,
            teacher_earned: totalTeacherPrice,
            paid_from_wallet: true,
            created_at: new Date().toISOString()
        };

        console.log('💾 إدخال الجلسة:', sessionData);

        const { data: newSession, error: sessionError } = await supabase
            .from('sessions')
            .insert(sessionData)
            .select()
            .single();

        if (sessionError) {
            logger.error('❌ خطأ في إنشاء الجلسة:', sessionError);
            return res.status(500).json({ 
                success: false, 
                error: 'حدث خطأ في قاعدة البيانات: ' + sessionError.message 
            });
        }

        session = newSession;
        console.log('✅ تم إنشاء الجلسة:', session.id);

        // 📝 تسجيل الاشتراك في جدول stream_subscriptions
        try {
            await supabase.from('stream_subscriptions').insert({
                offer_id: offer_id,
                student_id: student_id,
                teacher_id: offer.teacher_id,
                plan_type: offer.plan_type || (totalSessions > 1 ? '1_month' : '1_day'),
                total_sessions: totalSessions,
                completed_sessions: 0,
                price_per_session: pricePerSession,
                platform_fee_per_session: platformFeePerSession,
                total_amount_paid: totalCostForStudent,
                teacher_total_escrow: totalTeacherPrice,
                teacher_released_so_far: 0,
                status: 'active',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        } catch (subErr) {
            console.warn('⚠️ تعذر تسجيل stream_subscriptions:', subErr.message);
        }

        // ✅ خصم المبلغ من محفظة الطالب
        if (totalCostForStudent > 0) {
            const { data: updateRes, error: updateErr } = await supabase.from('students').update({
                wallet_balance: (student.wallet_balance || 0) - totalCostForStudent,
                updated_at: new Date().toISOString()
            }).eq('id', student_id).eq('wallet_balance', student.wallet_balance || 0).select();

            if (updateErr || !updateRes || updateRes.length === 0) {
                // تراجع عن المعاملات إذا فشل الخصم
                await supabase.from('sessions').delete().eq('id', session.id);
                return res.status(409).json({ success: false, error: 'تغير الرصيد أثناء المعالجة، يرجى المحاولة مرة أخرى' });
            }
        }

        // ✅ تسجيل المعاملة (خصم من المحفظة)
        await insert('wallet_transactions', {
            student_id: student_id,
            amount: totalCostForStudent,
            type: 'withdraw',
            status: isFree ? 'completed' : 'pending_stream', // ✅ معلق حتى اكتمال الحصص
            description: isFree ? `اشتراك مجاني "${offer.subject_name}"` : `اشتراك بخطة (${totalSessions} حصة) لمادة "${offer.subject_name}" - شامل رسوم المنصة ${totalPlatformFee} دج`,
            created_at: new Date().toISOString()
        });

        // ✅ تحديث الرصيد المعلق للأستاذ (في جدول teachers) - يحصل الأستاذ على إجمالي سعر الحصص كرصيد معلق
        if (totalTeacherPrice > 0) {
            const teacher = await getOne('teachers', 'id', offer.teacher_id);
            if (teacher) {
                await update('teachers', offer.teacher_id, {
                    pending_withdraw: (parseFloat(teacher.pending_withdraw) || 0) + totalTeacherPrice
                });
            }
        }
        
        // ✅ تحديث الجلسة بمبلغ ما يحصل عليه الأستاذ
        await supabase
            .from('sessions')
            .update({
                teacher_earned: totalTeacherPrice
            })
            .eq('id', session.id);

        // ✅ إضافة الطالب إلى غرفة الانتظار
        try {
            await supabase
                .from('waiting_room')
                .insert({
                    offer_id: offer_id,
                    student_id: student_id,
                    added_at: new Date().toISOString()
                });
        } catch (waitingError) {
            logger.error('⚠️ خطأ في إضافة الطالب لغرفة الانتظار:', waitingError.message);
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
            logger.error('⚠️ خطأ في حفظ كلمة مرور الطالب:', passwordError.message);
        }

        // ✅ حساب عدد الطلاب المسجلين
        const { count: bookedCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);

        if (countError) {
            logger.error('⚠️ خطأ في حساب عدد الطلاب:', countError.message);
        }

        const totalBooked = bookedCount || 1;

        // ✅ إرسال إشعار للمدرس وإشعار للطالب
        try {
            const teacher = await getOne('teachers', 'id', offer.teacher_id);
            if (teacher) {
                await insert('notifications', {
                    user_id: offer.teacher_id,
                    user_type: 'teacher',
                    title: `📊 طالب جديد حجز حصتك "${offer.subject_name}"`,
                    message: `قام الطالب ${student.full_name} بحجز حصتك "${offer.subject_name}". إجمالي الطلاب المسجلين الآن: ${totalBooked} طالب.\n💰 المبلغ المعلق: ${isFree ? 0 : offer.price} دج`,
                    offer_id: offer_id,
                    is_read: false,
                    created_at: new Date().toISOString()
                });
                await sendPushNotification(teacher, `📊 طالب جديد حجز حصتك "${offer.subject_name}"`, `قام الطالب ${student.full_name} بحجز حصتك.`);
            }
        } catch (notifError) {
            logger.error('⚠️ خطأ في إرسال إشعار المدرس:', notifError.message);
        }

        try {
            await insert('notifications', {
                user_id: student_id,
                user_type: 'student',
                title: 'تم حجز الدرس بنجاح',
                message: 'تم حجز هذا الدرس، سيتم إرسال إشعار لك عند بدء البث، انتظر هذا.',
                is_read: false,
                created_at: new Date().toISOString()
            });
            await sendPushNotification(student, 'تم حجز الدرس بنجاح', 'تم حجز هذا الدرس، سيتم إرسال إشعار لك عند بدء البث.');
        } catch (notifStudentErr) {
            logger.error('⚠️ خطأ في إرسال إشعار الطالب:', notifStudentErr.message);
        }

        // ✅ تحديث عدد الطلاب في الدرس
        await update('offers', offer_id, {
            booked_count: totalBooked,
            updated_at: new Date().toISOString()
        });

        // ✅ معالجة مكافأة الإحالة للطالب المحيل (فقط للدروس المدفوعة)
        // الشرط: يجب أن يكون الطالب المحال (المستخدم الحالي) قد سجل باستخدام كود إحالة
        // وعند حجزه لدرس مدفوع، يحصل المُحيل على فرصة صندوق هدايا
        if (!isFree) {
            try {
                const referralProcessed = await processStudentReferralRewardOnBooking(student_id, 'student');
                if (referralProcessed) {
                    console.log(`✅ تم منح فرصة صندوق هدايا للمستخدم الذي أحاله الطالب`);
                }
            } catch (referralError) {
                logger.error('⚠️ خطأ في معالجة مكافأة الإحالة:', referralError.message);
            }
        }

        // ✅ إرجاع النتيجة
        return res.json({
            success: true,
            session_id: session.id,
            is_free: isFree,
            pending_balance: isFree ? 0 : offer.price,
            platform_fee: isFree ? 0 : (offer.duration <= 120 ? 100 : (offer.duration <= 240 ? 200 : 600)),
            teacher_amount: isFree ? 0 : Math.max(0, offer.price - (offer.duration <= 120 ? 100 : (offer.duration <= 240 ? 200 : 600))),
            message: 'تم حجز هذا الدرس، سيتم إرسال إشعار لك عند بدء البث، انتظر هذا.',
            total_booked: totalBooked,
            room_password: studentPassword,
            offer: {
                id: offer.id,
                subject_name: offer.subject_name,
                teacher_id: offer.teacher_id,
                price: offer.price,
                is_free: offer.is_free,
                duration: offer.duration
            }
        });

    } catch (error) {
        logger.error('❌ خطأ في معالجة الحجز:', error.message);
        logger.error('📚 Stack:', error.stack);
        return res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم أثناء معالجة الحجز: ' + error.message 
        });
    }
});

// ============================================================
// ✅ تأكيد إتمام البث وتحويل الرصيد المعلق (يُستدعى من نظام البث)
// ============================================================
router.post('/confirm-stream-completion', authenticate, authorize(['teacher']), [
    body('offer_id').isInt().withMessage('معرف الدرس غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.body;

        // ✅ التحقق من الصلاحية
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ جلب الدرس
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        if (offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ جلب جميع الجلسات المعلقة لهذا الدرس
        const { data: sessions, error: sessionsError } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'pending_stream');

        if (sessionsError) {
            logger.error('❌ خطأ في جلب الجلسات المعلقة:', sessionsError);
            return res.status(500).json({ success: false, error: sessionsError.message });
        }

        let totalEarned = 0;
        let convertedCount = 0;

        // ✅ تحويل كل جلسة من pending_stream إلى paid
        for (const session of sessions) {
            const earnedAmount = session.payment_amount || 0;
            
            await supabase
                .from('sessions')
                .update({
                    payment_status: 'paid',
                    teacher_earned: earnedAmount
                })
                .eq('id', session.id);

            // ✅ تحديث معاملة المحفظة
            await supabase
                .from('wallet_transactions')
                .update({
                    status: 'completed',
                    description: `حصة "${offer.subject_name}" - تم إتمام البث`
                })
                .eq('student_id', session.student_id)
                .eq('amount', earnedAmount)
                .eq('type', 'withdraw')
                .eq('status', 'pending_stream');

            totalEarned += earnedAmount;
            convertedCount++;
        }

        // ✅ تحديث رصيد الأستاذ
        if (totalEarned > 0) {
            const teacher = await getOne('teachers', 'id', teacher_id);
            if (teacher) {
                await update('teachers', teacher_id, {
                    balance: (teacher.balance || 0) + totalEarned,
                    total_earned: (teacher.total_earned || 0) + totalEarned,
                    pending_withdraw: Math.max(0, (teacher.pending_withdraw || 0) - totalEarned)
                });
            }
        }

        // ✅ إرسال إشعارات للطلاب
        if (convertedCount > 0) {
            const { data: students } = await supabase
                .from('students')
                .select('id, full_name')
                .in('id', sessions.map(s => s.student_id));

            if (students && students.length > 0) {
                const notifications = students.map(s => ({
                    user_id: s.id,
                    user_type: 'student',
                    title: '✅ تم إتمام البث',
                    message: `تم إتمام البث المباشر للحصة "${offer.subject_name}". شكراً لمشاركتك!`,
                    offer_id: offer_id,
                    is_read: false,
                    created_at: new Date().toISOString()
                }));
                await supabase.from('notifications').insert(notifications);
            }
        }

        // ✅ تحديث حالة الدرس إلى completed
        await update('offers', offer_id, {
            status: 'completed',
            updated_at: new Date().toISOString()
        });

        // ✅ تنظيف الجداول المؤقتة
        await supabase.from('active_stream').delete().eq('offer_id', offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', offer_id);

        return res.json({
            success: true,
            message: 'تم تأكيد إتمام البث وتحويل الرصيد المعلق',
            converted_sessions: convertedCount,
            total_earned: totalEarned
        });

    } catch (error) {
        logger.error('❌ خطأ في تأكيد إتمام البث:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});


// ============================================================
// ✅ تأكيد إتمام حصة واحدة (للاشتراكات متعددة الحصص)
// ============================================================
router.post('/confirm-session-completion', authenticate, authorize(['teacher']), [
    body('subscription_id').isInt().withMessage('معرف الاشتراك غير صالح'),
    body('session_number').isInt().withMessage('رقم الحصة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { subscription_id, session_number } = req.body;

        // ✅ جلب الاشتراك
        const { data: sub, error: subError } = await supabase
            .from('stream_subscriptions')
            .select('*, offers:offer_id(teacher_id)')
            .eq('id', subscription_id)
            .single();
        
        if (subError || !sub) return res.status(404).json({ success: false, error: 'الاشتراك غير موجود' });

        // ✅ التحقق من الصلاحية
        if (req.user.userId !== sub.offers.teacher_id) return res.status(403).json({ success: false, error: 'غير مصرح لك' });

        if (sub.completed_sessions >= sub.total_sessions) {
            return res.status(400).json({ success: false, error: 'تم إكمال جميع الحصص بالفعل' });
        }

        // ✅ استخدام السعر المخزن في قاعدة البيانات مباشرة (أكثر دقة)
        const amountPerSession = parseFloat(sub.price_per_session) || 0;
        const teacherSharePerSession = parseFloat(sub.teacher_total_escrow) / parseFloat(sub.total_sessions);

        // ✅ تحديث الاشتراك
        await supabase
            .from('stream_subscriptions')
            .update({
                completed_sessions: sub.completed_sessions + 1,
                teacher_released_so_far: parseFloat(sub.teacher_released_so_far || 0) + teacherSharePerSession
            })
            .eq('id', subscription_id);

        // ✅ تحويل الرصيد للأستاذ
        const teacher = await getOne('teachers', 'id', sub.offers.teacher_id);
        if (teacher) {
            const currentPending = parseFloat(teacher.pending_withdraw || 0);
            const newPending = Math.max(0, currentPending - teacherSharePerSession);
            
            logger.info(`🔄 تحرير رصيد حصة: الاشتراك ${subscription_id}. الخصم من المعلق: ${teacherSharePerSession}. الرصيد المعلق الجديد: ${newPending}`);
            
            await update('teachers', sub.offers.teacher_id, {
                balance: (parseFloat(teacher.balance) || 0) + teacherSharePerSession,
                pending_withdraw: newPending
            });
        }

        // ✅ تسجيل المعاملة
        await insert('wallet_transactions', {
            teacher_id: sub.teacher_id,
            amount: amountPerSession,
            type: 'income',
            status: 'completed',
            description: `تحرير رصيد حصة رقم ${session_number} من اشتراك رقم ${subscription_id}`,
            created_at: new Date().toISOString()
        });

        return res.json({ success: true, message: 'تم تحرير رصيد الحصة بنجاح' });
    } catch (error) {
        logger.error('❌ خطأ في تحرير رصيد الحصة:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ استرداد مبلغ حصة غير مكتملة (للاشتراكات متعددة الحصص)
// ============================================================
router.post('/confirm-session-incomplete', authenticate, authorize(['teacher', 'admin']), [
    body('subscription_id').isInt().withMessage('معرف الاشتراك غير صالح'),
    body('session_number').isInt().withMessage('رقم الحصة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { subscription_id, session_number } = req.body;

        // ✅ جلب الاشتراك
        const { data: sub, error: subError } = await supabase
            .from('stream_subscriptions')
            .select('*, offers:offer_id(teacher_id)')
            .eq('id', subscription_id)
            .single();
        
        if (subError || !sub) return res.status(404).json({ success: false, error: 'الاشتراك غير موجود' });

        // ✅ التحقق من الصلاحية
        if (req.user.role !== 'admin' && req.user.userId !== sub.offers.teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ حساب المبلغ بدقة (حصة من إجمالي مبلغ الأستاذ المعلق)
        const teacherSharePerSession = parseFloat(sub.teacher_total_escrow) / parseFloat(sub.total_sessions);

        // ✅ إعادة المبلغ للطالب (إجمالي مبلغ الاشتراك / عدد الحصص)
        const amountPerSessionForStudent = parseFloat(sub.total_amount_paid) / parseFloat(sub.total_sessions);

        const student = await getOne('students', 'id', sub.student_id);
        if (student) {
            await update('students', sub.student_id, {
                wallet_balance: (parseFloat(student.wallet_balance) || 0) + amountPerSessionForStudent
            });
        }

        // ✅ خصم المبلغ من الرصيد المعلق للأستاذ
        const teacher = await getOne('teachers', 'id', sub.offers.teacher_id);
        if (teacher) {
            const currentPending = parseFloat(teacher.pending_withdraw || 0);
            const newPending = Math.max(0, currentPending - teacherSharePerSession);
            
            logger.info(`🔄 استرداد حصة: الاشتراك ${subscription_id}. الخصم من المعلق: ${teacherSharePerSession}. الرصيد المعلق الجديد: ${newPending}`);
            
            await update('teachers', sub.offers.teacher_id, {
                pending_withdraw: newPending
            });
        } else {
            logger.error(`❌ لم يتم العثور على الأستاذ لتحديث الرصيد المعلق: ${sub.offers.teacher_id}`);
        }

        // ✅ تسجيل المعاملة
        await insert('wallet_transactions', {
            student_id: sub.student_id,
            amount: amountPerSessionForStudent,
            type: 'refund',
            status: 'completed',
            description: `استرداد مبلغ حصة رقم ${session_number} غير مكتملة من اشتراك رقم ${subscription_id}`,
            created_at: new Date().toISOString()
        });

        return res.json({ success: true, message: 'تم استرداد مبلغ الحصة بنجاح للطالب' });
    } catch (error) {
        logger.error('❌ خطأ في استرداد رصيد الحصة:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب حجوزات الطالب (مع حالة الرصيد المعلق ومعلومات الاشتراك)
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
                    room_password,
                    booked_count
                ),
                teachers:offers!inner (
                    teacher_id (
                        id,
                        full_name,
                        profile_image,
                        profile_url,
                        specialization
                    )
                ),
                stream_subscriptions:offer_id!inner (
                    id,
                    total_sessions,
                    completed_sessions
                )
            `)
            .eq('student_id', student_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // ✅ تنسيق البيانات مع إضافة معلومات الرصيد المعلق والاشتراك
        const formattedBookings = (bookings || []).map(booking => ({
            ...booking,
            is_pending_stream: booking.payment_status === 'pending_stream',
            pending_balance: booking.payment_amount || 0,
            teacher_name: booking.teachers?.[0]?.teacher_id?.full_name || 'غير معروف',
            teacher_profile: booking.teachers?.[0]?.teacher_id?.profile_url || getPublicImageUrl('profiles', 'teachers', booking.teachers?.[0]?.teacher_id?.profile_image),
            teacher_specialization: booking.teachers?.[0]?.teacher_id?.specialization || '',
            session_progress: booking.stream_subscriptions ? {
                total: booking.stream_subscriptions[0].total_sessions,
                completed: booking.stream_subscriptions[0].completed_sessions,
                current: booking.stream_subscriptions[0].completed_sessions + 1,
                next: booking.stream_subscriptions[0].completed_sessions + 2
            } : null
        }));

        return res.json({
            success: true,
            bookings: formattedBookings
        });
    } catch (error) {
        logger.error('خطأ في جلب حجوزات الطالب:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب حجوزات المدرس (مع الرصيد المعلق)
// ============================================================
router.get('/teacher/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ جلب جميع الدروس الخاصة بالمدرس أولاً
        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('id, subject_name, price, is_free, status, booked_count')
            .eq('teacher_id', teacher_id);

        if (offersError) throw offersError;

        if (!offers || offers.length === 0) {
            return res.json({ success: true, bookings: [], pending_total: 0 });
        }

        const offerIds = offers.map(o => o.id);

        // ✅ جلب الجلسات المرتبطة بهذه الدروس
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
                    profile_image,
                    profile_url
                ),
                stream_subscriptions:offer_id!inner (
                    id,
                    total_sessions,
                    completed_sessions
                )
            `)
            .in('offer_id', offerIds)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // ✅ حساب إجمالي الرصيد المعلق
        let pendingTotal = 0;
        const formattedBookings = (bookings || []).map(booking => {
            const isPending = booking.payment_status === 'pending_stream';
            if (isPending) {
                pendingTotal += (booking.payment_amount || 0);
            }
            if (booking.students) {
                booking.students.profile_image = booking.students.profile_url || getPublicImageUrl('profiles', 'students', booking.students.profile_image);
            }
            return {
                ...booking,
                is_pending_stream: isPending,
                pending_balance: booking.payment_amount || 0,
                session_progress: booking.stream_subscriptions ? {
                    total: booking.stream_subscriptions[0].total_sessions,
                    completed: booking.stream_subscriptions[0].completed_sessions,
                    current: booking.stream_subscriptions[0].completed_sessions + 1,
                    next: booking.stream_subscriptions[0].completed_sessions + 2
                } : null
            };
        });

        return res.json({
            success: true,
            bookings: formattedBookings,
            pending_total: pendingTotal,
            offers: offers
        });
    } catch (error) {
        logger.error('خطأ في جلب حجوزات المدرس:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إلغاء حجز (طالب أو أستاذ مع استرداد الرصيد المعلق)
// ============================================================
router.post('/cancel', authenticate, [
    body('session_id').isInt().withMessage('معرف الجلسة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { session_id, student_id } = req.body;

        // ✅ جلب الجلسة
        const session = await getOne('sessions', 'id', session_id);
        if (!session) {
            return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        }

        const targetStudentId = student_id || session.student_id;

        // ✅ جلب الدرس
        const offer = await getOne('offers', 'id', session.offer_id);

        // ✅ التحقق من الصلاحية: (الطالب صاحب الحجز أو الأدمن أو الأستاذ صاحب العرض)
        const isStudentOwner = (req.user.userId === session.student_id);
        const isAdmin = (req.user.role === 'admin');
        const isTeacherOwner = (req.user.role === 'teacher' && offer && offer.teacher_id === req.user.userId);

        if (!isStudentOwner && !isAdmin && !isTeacherOwner) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإلغاء هذا الحجز' });
        }

        // ✅ التحقق من أن الحجز ليس منتهياً أو قيد البث
        if (offer && (offer.status === 'live' || offer.status === 'teacher_ready')) {
            return res.status(400).json({ 
                success: false, 
                error: 'لا يمكن إلغاء الحجز بعد بدء البث' 
            });
        }

        // ✅ استرداد الرصيد المعلق إذا كان موجوداً
        let refundAmount = 0;
        const isOfferFree = offer ? ((offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0) : false;

        if ((session.payment_status === 'pending_stream' || session.payment_status === 'paid') && !isOfferFree) {
            refundAmount = session.payment_amount || 0;
            
            if (refundAmount > 0) {
                // ✅ إعادة المبلغ للطالب
                const student = await getOne('students', 'id', targetStudentId);
                if (student) {
                    await update('students', targetStudentId, {
                        wallet_balance: (student.wallet_balance || 0) + refundAmount
                    });
                }

                // ✅ إزالة الرصيد المعلق من الأستاذ
                const teacher = await getOne('teachers', 'id', offer?.teacher_id);
                if (teacher && offer) {
                    await update('teachers', offer.teacher_id, {
                        pending_withdraw: Math.max(0, (teacher.pending_withdraw || 0) - refundAmount)
                    });
                }

                // ✅ تسجيل معاملة الاسترداد
                await insert('wallet_transactions', {
                    student_id: targetStudentId,
                    amount: refundAmount,
                    type: 'refund',
                    status: 'completed',
                    description: isTeacherOwner ? `استرداد مبلغ الحجز من قبل الأستاذ لدرس "${offer?.subject_name || 'غير معروف'}"` : `استرداد مبلغ حجز "${offer?.subject_name || 'غير معروف'}"`,
                    created_at: new Date().toISOString()
                });
            }
        }

        // ✅ إلغاء الحجز
        await update('sessions', session_id, {
            payment_status: 'cancelled',
            cancelled_at: new Date().toISOString()
        });

        // ✅ إزالة من الاشتراكات وغرفة الانتظار
        await supabase
            .from('stream_subscriptions')
            .delete()
            .eq('offer_id', session.offer_id)
            .eq('student_id', targetStudentId);

        await supabase
            .from('waiting_room')
            .delete()
            .eq('offer_id', session.offer_id)
            .eq('student_id', targetStudentId);

        // ✅ إرسال إشعار للطالب إذا تم الإلغاء من الأستاذ
        if (isTeacherOwner || isAdmin) {
            try {
                await supabase.from('notifications').insert({
                    user_id: targetStudentId,
                    title: 'إلغاء حجز واسترداد مبلغ',
                    message: `تم إلغاء حجزك في درس "${offer?.subject_name || 'غير معروف'}" من قبل الأستاذ وإعادة مبلغ ${refundAmount} دج إلى محفظتك.`,
                    type: 'refund',
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            } catch (notifErr) {
                console.warn('⚠️ تعذر إرسال إشعار الإلغاء للطالب:', notifErr.message);
            }
        }

        // ✅ تحديث عدد الطلاب في الدرس
        if (offer) {
            const { count: bookedCount } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .eq('offer_id', offer.id)
                .in('payment_status', ['paid', 'pending_stream']);

            await update('offers', offer.id, {
                booked_count: bookedCount || 0,
                current_students: bookedCount || 0
            });
        }

        return res.json({
            success: true,
            message: isTeacherOwner ? 'تم إلغاء حجز الطالب واسترداد المبلغ لحسابه بنجاح' : 'تم إلغاء الحجز واسترداد الرصيد بنجاح',
            refund_amount: refundAmount
        });
    } catch (error) {
        logger.error('خطأ في إلغاء الحجز:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إلغاء حجز طالب من قبل الأستاذ صاحب الدرس مع استرداد أمواله
// ============================================================
router.post('/teacher-cancel', authenticate, authorize(['teacher', 'admin']), [
    body('session_id').isInt().withMessage('معرف الجلسة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { session_id } = req.body;

        // ✅ جلب الجلسة
        const session = await getOne('sessions', 'id', session_id);
        if (!session) {
            return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        }

        if (session.payment_status === 'cancelled') {
            return res.status(400).json({ success: false, error: 'الحجز ملغى بالفعل' });
        }

        // ✅ جلب الدرس والتحقق من ملكية الأستاذ
        const offer = await getOne('offers', 'id', session.offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس الخاص بهذا الحجز غير موجود' });
        }

        if (req.user.role === 'teacher' && offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإلغاء حجز في درس أستاذ آخر' });
        }

        const student_id = session.student_id;

        // ✅ استرداد الرصيد المعلق للطالب
        let refundAmount = 0;
        const isOfferFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0;

        if ((session.payment_status === 'pending_stream' || session.payment_status === 'paid') && !isOfferFree) {
            refundAmount = session.payment_amount || 0;
            
            if (refundAmount > 0) {
                // ✅ إعادة المبلغ لمحفظة الطالب
                const student = await getOne('students', 'id', student_id);
                if (student) {
                    await update('students', student_id, {
                        wallet_balance: (student.wallet_balance || 0) + refundAmount
                    });
                }

                // ✅ خصم المبلغ من الرصيد المعلق للأستاذ
                const teacher = await getOne('teachers', 'id', offer.teacher_id);
                if (teacher) {
                    await update('teachers', offer.teacher_id, {
                        pending_withdraw: Math.max(0, (teacher.pending_withdraw || 0) - refundAmount)
                    });
                }

                // ✅ تسجيل معاملة استرداد
                await insert('wallet_transactions', {
                    student_id: student_id,
                    amount: refundAmount,
                    type: 'refund',
                    status: 'completed',
                    description: `استرداد مبلغ الحجز من قبل الأستاذ لدرس "${offer.subject_name}"`,
                    created_at: new Date().toISOString()
                });
            }
        }

        // ✅ تحديث حالة الجلسة إلى "ملغى"
        await update('sessions', session_id, {
            payment_status: 'cancelled',
            cancelled_at: new Date().toISOString()
        });

        // ✅ إزالة من الاشتراك وغرفة الانتظار
        await supabase
            .from('stream_subscriptions')
            .delete()
            .eq('offer_id', session.offer_id)
            .eq('student_id', student_id);

        await supabase
            .from('waiting_room')
            .delete()
            .eq('offer_id', session.offer_id)
            .eq('student_id', student_id);

        // ✅ إرسال إشعار للطالب
        try {
            await supabase.from('notifications').insert({
                user_id: student_id,
                title: 'إلغاء حجز واسترداد مبلغ',
                message: `قام الأستاذ بإلغاء حجزك لدرس "${offer.subject_name}" وتمت إعادة مبلغ ${refundAmount} دج إلى محفظتك.`,
                type: 'refund',
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifErr) {
            console.warn('⚠️ تعذر إرسال إشعار الإلغاء للطالب:', notifErr.message);
        }

        // ✅ تحديث عدد الطلاب المعروض بالدرس
        const { count: bookedCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer.id)
            .in('payment_status', ['paid', 'pending_stream']);

        await update('offers', offer.id, {
            booked_count: bookedCount || 0,
            current_students: bookedCount || 0
        });

        return res.json({
            success: true,
            message: 'تم إلغاء حجز الطالب وإعادة المبلغ لحسابه بنجاح',
            refund_amount: refundAmount
        });
    } catch (error) {
        logger.error('خطأ في إلغاء حجز الطالب من قبل الأستاذ:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب إحصائيات الحجوزات للمدرس
// ============================================================
router.get('/stats/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ جلب جميع الدروس
        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('id')
            .eq('teacher_id', teacher_id);

        if (offersError) throw offersError;

        if (!offers || offers.length === 0) {
            return res.json({
                success: true,
                total_bookings: 0,
                pending_bookings: 0,
                completed_bookings: 0,
                pending_amount: 0,
                completed_amount: 0
            });
        }

        const offerIds = offers.map(o => o.id);

        // ✅ جلب إحصائيات الجلسات
        const { data: stats, error: statsError } = await supabase
            .from('sessions')
            .select('payment_status, payment_amount, teacher_earned')
            .in('offer_id', offerIds);

        if (statsError) throw statsError;

        let totalBookings = 0;
        let pendingBookings = 0;
        let completedBookings = 0;
        let pendingAmount = 0;
        let completedAmount = 0;

        for (const stat of (stats || [])) {
            totalBookings++;
            if (stat.payment_status === 'pending_stream') {
                pendingBookings++;
                pendingAmount += (stat.payment_amount || 0);
            } else if (stat.payment_status === 'paid') {
                completedBookings++;
                completedAmount += (stat.teacher_earned || stat.payment_amount || 0);
            }
        }

        return res.json({
            success: true,
            total_bookings: totalBookings,
            pending_bookings: pendingBookings,
            completed_bookings: completedBookings,
            pending_amount: pendingAmount,
            completed_amount: completedAmount
        });
    } catch (error) {
        logger.error('خطأ في جلب إحصائيات الحجوزات:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
