// ============================================================
// مسارات الإدارة - Admin Routes (معدل بالكامل مع دعم نظام البث والرصيد المعلق)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

// استيراد الدوال
const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { encrypt, maskIP } = require('../utils/encryption');
const { processReferralReward } = require('../utils/referral');
const { sendTeacherApprovalEmail, sendTeacherRejectionEmail } = require('../utils/email');

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

// الثوابت
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@platform.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin123', 12);

// ============================================================
// ✅ جلب جميع الطلاب (مع المستوى التعليمي)
// ============================================================
router.get('/students', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب جميع الطلاب...');
        
        const { data, error } = await supabase
            .from('students')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الطلاب:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} طالب`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب الطلاب:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الأساتذة المعلقين (مع المستوى التعليمي)
// ============================================================
router.get('/pending-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الأساتذة المعلقين...');
        
        const { data, error } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الأساتذة المعلقين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} أستاذ معلق`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب الأساتذة المعلقين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الأساتذة المقبولين (مع المستوى التعليمي)
// ============================================================
router.get('/approved-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الأساتذة المقبولين...');
        
        const { data, error } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الأساتذة المقبولين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} أستاذ مقبول`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب الأساتذة المقبولين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الأساتذة (جميع الحالات) مع إحصائيات البث
// ============================================================
router.get('/all-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب جميع الأساتذة...');
        
        const { data: teachers, error } = await supabase
            .from('teachers')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الأساتذة:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        // ✅ جلب إحصائيات البث لكل أستاذ
        const teacherIds = teachers.map(t => t.id);
        let streamStats = {};
        
        if (teacherIds.length > 0) {
            const { data: offers, error: offersError } = await supabase
                .from('offers')
                .select('teacher_id, status, booked_count, duration')
                .in('teacher_id', teacherIds)
                .in('status', ['live', 'teacher_ready', 'paused']);

            if (!offersError && offers) {
                for (const offer of offers) {
                    if (!streamStats[offer.teacher_id]) {
                        streamStats[offer.teacher_id] = {
                            active_streams: 0,
                            total_students: 0,
                            total_pending: 0
                        };
                    }
                    streamStats[offer.teacher_id].active_streams++;
                    streamStats[offer.teacher_id].total_students += (offer.booked_count || 0);
                }
            }

            // ✅ جلب الرصيد المعلق لكل أستاذ
            const { data: sessions, error: sessionsError } = await supabase
                .from('sessions')
                .select('teacher_id, payment_amount, offers!inner(teacher_id)')
                .eq('payment_status', 'pending_stream');

            if (!sessionsError && sessions) {
                for (const session of sessions) {
                    const tid = session.offers?.teacher_id || session.teacher_id;
                    if (tid && streamStats[tid]) {
                        streamStats[tid].total_pending += (session.payment_amount || 0);
                    }
                }
            }
        }

        // ✅ تنسيق البيانات
        const formatted = teachers.map(teacher => {
            const stats = streamStats[teacher.id] || {
                active_streams: 0,
                total_students: 0,
                total_pending: 0
            };
            
            return {
                ...teacher,
                active_streams: stats.active_streams,
                total_students: stats.total_students,
                total_pending_balance: stats.total_pending
            };
        });

        console.log(`✅ تم جلب ${formatted.length} أستاذ مع إحصائياتهم`);
        res.json(formatted);
    } catch (error) {
        console.error('❌ خطأ في جلب الأساتذة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ قبول الأستاذ (مع إرسال بريد قبول)
// ============================================================
router.post('/approve-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = parseInt(req.params.id);
        console.log(`📥 قبول الأستاذ ID: ${teacherId}`);

        // ✅ جلب بيانات الأستاذ
        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (teacher.status === 'approved') {
            return res.status(400).json({ success: false, error: 'هذا الأستاذ مقبول بالفعل' });
        }

        console.log(`👤 الأستاذ: ${teacher.full_name}, المستوى: ${teacher.teaching_level || 'غير محدد'}`);

        // ✅ تحديث حالة الأستاذ إلى approved
        const { error: updateError } = await supabase
            .from('teachers')
            .update({ 
                status: 'approved',
                teaching_level: teacher.teaching_level || null,
                updated_at: new Date().toISOString()
            })
            .eq('id', teacherId);

        if (updateError) {
            console.error('❌ خطأ في تحديث حالة الأستاذ:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        // ✅ إرسال بريد قبول للأستاذ
        let emailSent = false;
        try {
            emailSent = await sendTeacherApprovalEmail(teacher.email, teacher.full_name);
            console.log(`📧 بريد القبول: ${emailSent ? 'تم الإرسال ✅' : 'فشل الإرسال ❌'}`);
        } catch (emailError) {
            console.error('❌ خطأ في إرسال بريد القبول:', emailError.message);
        }

        // ✅ معالجة مكافأة الإحالة
        try {
            const { data: referral } = await supabase
                .from('referrals')
                .select('*')
                .eq('referred_user_id', teacherId)
                .eq('referred_user_role', 'teacher')
                .eq('status', 'pending_verification')
                .single();

            if (referral) {
                await processReferralReward(teacherId, 'teacher');
                console.log(`✅ تم منح مكافأة الإحالة للأستاذ المحيل فور قبول الأستاذ ${teacherId}`);
            }
        } catch (referralError) {
            console.warn('⚠️ خطأ في معالجة مكافأة الإحالة:', referralError.message);
        }

        // ✅ إرسال إشعار للمدير
        await insert('notifications', {
            user_id: 1,
            user_type: 'admin',
            title: '✅ تم قبول أستاذ جديد',
            message: `تم قبول الأستاذ ${teacher.full_name}. البريد الإلكتروني: ${teacher.email}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        console.log(`✅ تم قبول الأستاذ ${teacherId} بنجاح`);
        res.json({ 
            success: true, 
            message: '✅ تم قبول الأستاذ بنجاح! تم إرسال بريد إعلامي إليه.',
            email_sent: emailSent,
            teaching_level: teacher.teaching_level || null
        });
    } catch (error) {
        console.error('❌ خطأ في قبول الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ رفض الأستاذ (مع إرسال بريد رفض)
// ============================================================
router.post('/reject-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('reason').optional().isString().withMessage('سبب الرفض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = parseInt(req.params.id);
        const { reason } = req.body;

        console.log(`📥 رفض الأستاذ ID: ${teacherId}, السبب: ${reason || 'غير محدد'}`);

        // ✅ جلب بيانات الأستاذ
        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (teacher.status === 'rejected') {
            return res.status(400).json({ success: false, error: 'هذا الأستاذ مرفوض بالفعل' });
        }

        // ✅ تحديث حالة الأستاذ إلى rejected
        const { error: updateError } = await supabase
            .from('teachers')
            .update({
                status: 'rejected',
                rejection_reason: reason || 'لم يتم تحديد سبب',
                updated_at: new Date().toISOString()
            })
            .eq('id', teacherId);

        if (updateError) {
            console.error('❌ خطأ في رفض الأستاذ:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        // ✅ إرسال بريد رفض للأستاذ
        let emailSent = false;
        try {
            emailSent = await sendTeacherRejectionEmail(teacher.email, teacher.full_name, reason);
            console.log(`📧 بريد الرفض: ${emailSent ? 'تم الإرسال ✅' : 'فشل الإرسال ❌'}`);
        } catch (emailError) {
            console.error('❌ خطأ في إرسال بريد الرفض:', emailError.message);
        }

        // ✅ إرسال إشعار للمدير
        await insert('notifications', {
            user_id: 1,
            user_type: 'admin',
            title: '❌ تم رفض طلب أستاذ',
            message: `تم رفض طلب الأستاذ ${teacher.full_name}. السبب: ${reason || 'لم يتم تحديد سبب'}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        console.log(`✅ تم رفض الأستاذ ${teacherId}`);
        res.json({ 
            success: true,
            message: '❌ تم رفض الأستاذ! تم إرسال بريد إعلامي إليه.',
            email_sent: emailSent
        });
    } catch (error) {
        console.error('❌ خطأ في رفض الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب إحصائيات المنصة (مع دعم البث والرصيد المعلق)
// ============================================================
router.get('/stats', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب إحصائيات المنصة...');

        // ✅ عدد الطلاب
        const { count: studentsCount, error: studentsError } = await supabase
            .from('students')
            .select('*', { count: 'exact', head: true });

        if (studentsError) {
            console.error('❌ خطأ في جلب عدد الطلاب:', studentsError);
        }

        // ✅ عدد الأساتذة
        const { count: teachersCount, error: teachersError } = await supabase
            .from('teachers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'approved');

        if (teachersError) {
            console.error('❌ خطأ في جلب عدد الأساتذة:', teachersError);
        }

        // ✅ عدد الأساتذة المعلقين
        const { count: pendingTeachers, error: pendingError } = await supabase
            .from('teachers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        if (pendingError) {
            console.error('❌ خطأ في جلب عدد الأساتذة المعلقين:', pendingError);
        }

        // ✅ عدد البث المباشر
        const { count: liveStreams, error: liveError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .in('status', ['live', 'teacher_ready']);

        if (liveError) {
            console.error('❌ خطأ في جلب عدد البث المباشر:', liveError);
        }

        // ✅ عدد البث المتوقف مؤقتاً
        const { count: pausedStreams, error: pausedError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'paused');

        if (pausedError) {
            console.error('❌ خطأ في جلب عدد البث المتوقف:', pausedError);
        }

        // ✅ إجمالي الرصيد المعلق
        const { data: pendingData, error: pendingBalanceError } = await supabase
            .from('sessions')
            .select('payment_amount')
            .eq('payment_status', 'pending_stream');

        let totalPendingBalance = 0;
        if (!pendingBalanceError && pendingData) {
            totalPendingBalance = pendingData.reduce((sum, s) => sum + (s.payment_amount || 0), 0);
        }

        // ✅ إجمالي الأرباح المدفوعة
        const { data: paidData, error: paidError } = await supabase
            .from('sessions')
            .select('teacher_earned')
            .eq('payment_status', 'paid');

        let totalPaid = 0;
        if (!paidError && paidData) {
            totalPaid = paidData.reduce((sum, s) => sum + (s.teacher_earned || 0), 0);
        }

        // ✅ عدد الطلاب في البث
        const { count: activeStudents, error: activeError } = await supabase
            .from('active_stream')
            .select('*', { count: 'exact', head: true });

        if (activeError) {
            console.error('❌ خطأ في جلب عدد الطلاب النشطين:', activeError);
        }

        // ✅ عدد العروض الكلي
        const { count: totalOffers, error: offersError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true });

        if (offersError) {
            console.error('❌ خطأ في جلب عدد العروض:', offersError);
        }

        // ✅ عدد الحجوزات الكلي
        const { count: totalSessions, error: sessionsError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true });

        if (sessionsError) {
            console.error('❌ خطأ في جلب عدد الحجوزات:', sessionsError);
        }

        res.json({
            success: true,
            stats: {
                students: studentsCount || 0,
                teachers: teachersCount || 0,
                pending_teachers: pendingTeachers || 0,
                live_streams: liveStreams || 0,
                paused_streams: pausedStreams || 0,
                total_streams: (liveStreams || 0) + (pausedStreams || 0),
                active_students_in_stream: activeStudents || 0,
                total_pending_balance: totalPendingBalance,
                total_paid_earnings: totalPaid,
                total_offers: totalOffers || 0,
                total_sessions: totalSessions || 0
            }
        });
    } catch (error) {
        console.error('❌ خطأ في جلب إحصائيات المنصة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع العروض (للمدير)
// ============================================================
router.get('/all-offers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب جميع العروض...');
        
        const { data: offers, error } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (full_name, email, specialization)')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب العروض:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        // ✅ جلب عدد الطلاب لكل عرض
        for (const offer of offers || []) {
            const { count, error: countError } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .eq('offer_id', offer.id)
                .in('payment_status', ['paid', 'pending_stream']);

            if (!countError) {
                offer.students_count = count || 0;
            }
        }

        console.log(`✅ تم جلب ${offers?.length || 0} عرض`);
        res.json(offers || []);
    } catch (error) {
        console.error('❌ خطأ في جلب العروض:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إلغاء عرض (من قبل المدير)
// ============================================================
router.post('/cancel-offer/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف العرض غير صالح'),
    body('reason').optional().isString().withMessage('سبب الإلغاء غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offerId = parseInt(req.params.id);
        const { reason } = req.body;

        console.log(`📥 إلغاء العرض ID: ${offerId}, السبب: ${reason || 'غير محدد'}`);

        const offer = await getOne('offers', 'id', offerId);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        // ✅ تحديث حالة العرض إلى cancelled
        await supabase
            .from('offers')
            .update({
                status: 'cancelled',
                cancelled_by_admin: true,
                cancellation_reason: reason || 'تم إلغاء العرض من قبل الإدارة',
                updated_at: new Date().toISOString()
            })
            .eq('id', offerId);

        // ✅ استرداد الرصيد المعلق للطلاب
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id, payment_amount')
            .eq('offer_id', offerId)
            .eq('payment_status', 'pending_stream');

        if (sessions && sessions.length > 0) {
            for (const session of sessions) {
                if (session.payment_amount > 0) {
                    // ✅ إعادة المبلغ للطالب
                    const student = await getOne('students', 'id', session.student_id);
                    if (student) {
                        await update('students', session.student_id, {
                            wallet_balance: (student.wallet_balance || 0) + session.payment_amount
                        });
                    }

                    // ✅ تحديث الجلسة إلى cancelled
                    await update('sessions', session.id, {
                        payment_status: 'cancelled',
                        pending_balance: 0,
                        cancelled_by_admin: true
                    });
                }
            }
        }

        // ✅ تنظيف الجداول المؤقتة
        await supabase.from('active_stream').delete().eq('offer_id', offerId);
        await supabase.from('waiting_room').delete().eq('offer_id', offerId);

        // ✅ إرسال إشعارات للطلاب
        const { data: allSessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offerId)
            .in('payment_status', ['paid', 'pending_stream']);

        if (allSessions && allSessions.length > 0) {
            const notifications = allSessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '❌ تم إلغاء الحصة',
                message: `تم إلغاء الحصة "${offer.subject_name}" من قبل الإدارة. السبب: ${reason || 'لم يتم تحديد سبب'}`,
                offer_id: offerId,
                is_read: false,
                created_at: new Date().toISOString()
            }));
            await supabase.from('notifications').insert(notifications);
        }

        // ✅ إرسال إشعار للأستاذ
        await insert('notifications', {
            user_id: offer.teacher_id,
            user_type: 'teacher',
            title: '❌ تم إلغاء عرضك',
            message: `تم إلغاء عرض "${offer.subject_name}" من قبل الإدارة. السبب: ${reason || 'لم يتم تحديد سبب'}`,
            offer_id: offerId,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: '✅ تم إلغاء العرض واسترداد المبالغ للطلاب'
        });
    } catch (error) {
        console.error('❌ خطأ في إلغاء العرض:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب سجل العمليات (للمدير)
// ============================================================
router.get('/logs', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب سجل العمليات...');
        
        const { data: loginLogs, error } = await supabase
            .from('login_logs')
            .select('*, users:user_id (full_name, email)')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) {
            console.error('❌ خطأ في جلب السجل:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        const formatted = (loginLogs || []).map(log => ({
            ...log,
            user_name: log.users?.full_name || 'غير معروف',
            user_email: log.users?.email || 'غير معروف'
        }));

        res.json(formatted);
    } catch (error) {
        console.error('❌ خطأ في جلب السجل:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ حذف الأستاذ
// ============================================================
router.delete('/delete-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = parseInt(req.params.id);
        console.log(`📥 حذف الأستاذ ID: ${teacherId}`);

        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (teacher?.profile_image) {
            try {
                await supabase.storage.from('profiles').remove([`teachers/${teacher.profile_image}`]);
            } catch (storageError) {
                console.warn('⚠️ خطأ في حذف الصورة:', storageError.message);
            }
        }

        const tables = ['sessions', 'waiting_room', 'active_stream', 'offers', 'withdraw_requests'];
        for (const table of tables) {
            try {
                await supabase.from(table).delete().eq('teacher_id', teacherId);
            } catch (e) {
                console.warn(`⚠️ خطأ في حذف بيانات ${table}:`, e.message);
            }
        }

        await supabase.from('notifications').delete().eq('user_id', teacherId).eq('user_type', 'teacher');

        const { error } = await supabase.from('teachers').delete().eq('id', teacherId);

        if (error) {
            console.error('❌ خطأ في حذف الأستاذ:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف الأستاذ ${teacherId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في حذف الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حذف المستخدم (طالب أو أستاذ)
// ============================================================
router.post('/delete-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role, ban } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        console.log(`📥 حذف المستخدم ID: ${user_id}, الدور: ${role}, حظر: ${ban}`);

        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        let userIp = null;
        try {
            const { data: loginLog } = await supabase
                .from('login_logs')
                .select('ip_address')
                .eq('user_id', user_id)
                .eq('user_role', role)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            
            userIp = loginLog?.ip_address || null;
        } catch (logError) {
            console.warn('⚠️ لا يوجد سجل دخول لهذا المستخدم:', logError.message);
        }
        
        const { error } = await supabase
            .from(tableName)
            .delete()
            .eq('id', user_id);

        if (error) {
            console.error('❌ خطأ في حذف المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        if (ban && userIp) {
            const { data: existingBan } = await supabase
                .from('banned_users')
                .select('*')
                .eq('ip_address', userIp)
                .single();
            
            if (!existingBan) {
                await insert('banned_users', {
                    user_id: user_id,
                    user_role: role,
                    full_name: user.full_name,
                    email: user.email,
                    ip_address: userIp,
                    ban_reason: 'تم حظر المستخدم تلقائياً عند حذف الحساب',
                    banned_at: new Date().toISOString(),
                    banned_by: 'admin'
                });
                console.log(`🔒 تم حظر IP المستخدم ${user_id}`);
            }
        }
        
        console.log(`✅ تم حذف المستخدم ${user_id}`);
        res.json({ 
            success: true, 
            message: 'تم حذف المستخدم بنجاح',
            banned: ban && userIp ? true : false
        });
    } catch (error) {
        console.error('❌ خطأ في حذف المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حظر المستخدم
// ============================================================
router.post('/ban-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role, reason } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        console.log(`📥 حظر المستخدم ID: ${user_id}, الدور: ${role}`);

        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        let userIp = null;
        try {
            const { data: loginLog } = await supabase
                .from('login_logs')
                .select('ip_address')
                .eq('user_id', user_id)
                .eq('user_role', role)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            
            userIp = loginLog?.ip_address || null;
        } catch (logError) {
            console.warn('⚠️ لا يوجد سجل دخول لهذا المستخدم:', logError.message);
        }
        
        if (!userIp) {
            console.log(`⚠️ لا يمكن تحديد IP للمستخدم ${user_id}, سيتم استخدام معرف المستخدم للحظر`);
            userIp = `user_${user_id}_${role}_${Date.now()}`;
        }
        
        const { data: existingBan } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address', userIp)
            .single();
        
        if (existingBan) {
            await supabase
                .from('banned_users')
                .update({
                    ban_reason: reason || 'تم تحديث سبب الحظر',
                    banned_at: new Date().toISOString(),
                    banned_by: 'admin'
                })
                .eq('id', existingBan.id);
            
            await supabase
                .from(tableName)
                .update({ is_banned: true, ban_reason: reason || 'لم يتم تحديد سبب' })
                .eq('id', user_id);
            
            console.log(`🔒 تم تحديث حظر المستخدم ${user_id}`);
            return res.json({ success: true, message: 'تم تحديث حظر المستخدم بنجاح' });
        }
        
        await insert('banned_users', {
            user_id: user_id,
            user_role: role,
            full_name: user.full_name,
            email: user.email,
            ip_address: userIp,
            ban_reason: reason || 'لم يتم تحديد سبب',
            banned_at: new Date().toISOString(),
            banned_by: 'admin'
        });
        
        const { error } = await supabase            .from(tableName)
            .update({ is_banned: true, ban_reason: reason || 'لم يتم تحديد سبب' })
            .eq('id', user_id);

        if (error) {
            console.error('❌ خطأ في حظر المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        console.log(`🔒 تم حظر المستخدم ${user_id}`);
        res.json({ success: true, message: 'تم حظر المستخدم بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في حظر المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إلغاء حظر المستخدم
// ============================================================
router.post('/unban-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        console.log(`📥 إلغاء حظر المستخدم ID: ${user_id}, الدور: ${role}`);
        
        const { data: banRecord } = await supabase
            .from('banned_users')
            .select('*')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .single();
        
        if (!banRecord) {
            return res.status(404).json({ success: false, error: 'المستخدم غير محظور' });
        }
        
        await supabase
            .from('banned_users')
            .delete()
            .eq('id', banRecord.id);
        
        const { error } = await supabase
            .from(tableName)
            .update({ is_banned: false, ban_reason: null })
            .eq('id', user_id);

        if (error) {
            console.error('❌ خطأ في إلغاء حظر المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        console.log(`✅ تم إلغاء حظر المستخدم ${user_id}`);
        res.json({ success: true, message: 'تم إلغاء حظر المستخدم بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في إلغاء الحظر:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب المستخدمين المحظورين
// ============================================================
router.get('/banned-users', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب المستخدمين المحظورين...');
        
        const { data, error } = await supabase
            .from('banned_users')
            .select('*')
            .order('banned_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب المحظورين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} مستخدم محظور`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب المحظورين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ طلبات السحب
// ============================================================
router.get('/withdraw-requests', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب طلبات السحب...');
        
        const { data, error } = await supabase
            .from('withdraw_requests')
            .select('*, teachers:teacher_id (full_name, email, phone)')
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) {
            console.error('❌ خطأ في جلب طلبات السحب:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} طلب سحب`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب طلبات السحب:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ قبول طلب سحب
// ============================================================
router.post('/withdraw-requests/:id/approve', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الطلب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { id } = req.params;
        console.log(`📥 قبول طلب سحب ID: ${id}`);

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) {
            return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
        }

        const { error: updateError } = await supabase
            .from('withdraw_requests')
            .update({
                status: 'completed',
                processed_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) {
            console.error('❌ خطأ في تحديث طلب السحب:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        const teacher = await getOne('teachers', 'id', request.teacher_id);
        if (teacher) {
            await supabase
                .from('teachers')
                .update({
                    total_withdrawn: (teacher.total_withdrawn || 0) + request.amount,
                    pending_withdraw: (teacher.pending_withdraw || 0) - request.amount
                })
                .eq('id', request.teacher_id);
        }

        await insert('notifications', {
            user_id: request.teacher_id,
            user_type: 'teacher',
            title: '💰 تمت معالجة طلب السحب',
            message: `تم تحويل مبلغ ${request.amount} دج إلى حسابك ${request.ccp_account}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        console.log(`✅ تم قبول طلب السحب ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في قبول طلب سحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ رفض طلب سحب
// ============================================================
router.post('/withdraw-requests/:id/reject', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الطلب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { id } = req.params;
        const { reason } = req.body;
        
        console.log(`📥 رفض طلب سحب ID: ${id}, السبب: ${reason || 'غير محدد'}`);

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) {
            return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
        }

        const { error: updateError } = await supabase
            .from('withdraw_requests')
            .update({
                status: 'rejected',
                rejection_reason: reason || 'لم يتم تحديد سبب',
                processed_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) {
            console.error('❌ خطأ في تحديث طلب السحب:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        const teacher = await getOne('teachers', 'id', request.teacher_id);
        if (teacher) {
            await supabase
                .from('teachers')
                .update({
                    balance: (teacher.balance || 0) + request.amount,
                    pending_withdraw: (teacher.pending_withdraw || 0) - request.amount
                })
                .eq('id', request.teacher_id);
        }

        await insert('notifications', {
            user_id: request.teacher_id,
            user_type: 'teacher',
            title: '❌ تم رفض طلب السحب',
            message: `تم رفض طلب سحب مبلغ ${request.amount} دج. السبب: ${reason || 'لم يتم تحديد سبب'}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        console.log(`✅ تم رفض طلب السحب ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في رفض طلب سحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إرسال إشعار لجميع الطلاب
// ============================================================
router.post('/send-notification-to-all-students', [
    authenticate,
    authorize(['admin']),
    body('title').notEmpty().withMessage('العنوان مطلوب').isLength({ max: 100 }),
    body('message').notEmpty().withMessage('المحتوى مطلوب').isLength({ max: 500 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { title, message } = req.body;
        console.log(`📥 إرسال إشعار لجميع الطلاب: ${title}`);

        const { data: students, error: studentsError } = await supabase
            .from('students')
            .select('id')
            .eq('email_verified', true);

        if (studentsError) {
            console.error('❌ خطأ في جلب الطلاب:', studentsError);
            return res.status(500).json({ success: false, error: studentsError.message });
        }

        if (!students || students.length === 0) {
            return res.status(404).json({ success: false, error: 'لا يوجد طلاب مسجلين' });
        }

        const notifications = students.map(s => ({
            user_id: s.id,
            user_type: 'student',
            title: title.trim(),
            message: message.trim(),
            is_read: false,
            created_at: new Date().toISOString()
        }));

        const { error } = await supabase
            .from('notifications')
            .insert(notifications);

        if (error) {
            console.error('❌ خطأ في إرسال الإشعارات:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        await supabase
            .from('admin_notifications')
            .insert({
                title: title.trim(),
                message: message.trim(),
                sent_to_all: true,
                students_count: students.length,
                created_at: new Date().toISOString()
            });

        console.log(`✅ تم إرسال الإشعار إلى ${students.length} طالب`);
        res.json({
            success: true,
            students_count: students.length,
            message: `تم إرسال الإشعار إلى ${students.length} طالب`
        });
    } catch (error) {
        console.error('❌ خطأ في إرسال الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إرسال إشعار لمستخدم محدد (طالب أو أستاذ)
// ============================================================
router.post('/send-notification-to-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('user_type').isIn(['student', 'teacher']).withMessage('نوع المستخدم غير صالح'),
    body('title').notEmpty().withMessage('العنوان مطلوب').isLength({ max: 100 }),
    body('message').notEmpty().withMessage('المحتوى مطلوب').isLength({ max: 500 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, user_type, title, message } = req.body;
        const tableName = user_type === 'student' ? 'students' : 'teachers';
        
        console.log(`📥 إرسال إشعار لمستخدم ${user_id} (${user_type}): ${title}`);

        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }

        await insert('notifications', {
            user_id: user_id,
            user_type: user_type,
            title: title.trim(),
            message: message.trim(),
            is_read: false,
            created_at: new Date().toISOString()
        });

        await supabase
            .from('admin_notifications')
            .insert({
                title: title.trim(),
                message: message.trim(),
                sent_to_all: false,
                user_id: user_id,
                user_type: user_type,
                students_count: 1,
                created_at: new Date().toISOString()
            });

        console.log(`✅ تم إرسال الإشعار إلى المستخدم ${user_id} (${user_type})`);
        res.json({
            success: true,
            message: `تم إرسال الإشعار إلى ${user.full_name} بنجاح`
        });
    } catch (error) {
        console.error('❌ خطأ في إرسال الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب الإشعارات المرسلة
// ============================================================
router.get('/sent-notifications', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الإشعارات المرسلة...');
        
        const { data, error } = await supabase
            .from('admin_notifications')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الإشعارات المرسلة:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} إشعار مرسل`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب الإشعارات المرسلة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ حذف إشعار
// ============================================================
router.delete('/delete-notification/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الإشعار غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const id = parseInt(req.params.id);
        console.log(`📥 حذف إشعار ID: ${id}`);

        const { error } = await supabase
            .from('admin_notifications')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('❌ خطأ في حذف الإشعار:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف الإشعار ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في حذف الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ مراقبة الأداء (معدلة مع دعم البث)
// ============================================================
router.get('/performance', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب معلومات الأداء...');
        
        const { data: connections, error: connError } = await supabase
            .from('active_stream')
            .select('count', { count: 'exact' });

        if (connError) {
            console.error('❌ خطأ في جلب البث المباشر:', connError);
        }

        const { data: sessions, error: sessError } = await supabase
            .from('sessions')
            .select('count', { count: 'exact' });

        if (sessError) {
            console.error('❌ خطأ في جلب الجلسات:', sessError);
        }

        // ✅ جلب عدد العروض المباشرة
        const { count: liveOffers, error: liveError } = await supabase
            .from('offers')
            .select('count', { count: 'exact' })
            .in('status', ['live', 'teacher_ready']);

        if (liveError) {
            console.error('❌ خطأ في جلب العروض المباشرة:', liveError);
        }

        // ✅ جلب عدد العروض المتوقفة مؤقتاً
        const { count: pausedOffers, error: pausedError } = await supabase
            .from('offers')
            .select('count', { count: 'exact' })
            .eq('status', 'paused');

        if (pausedError) {
            console.error('❌ خطأ في جلب العروض المتوقفة:', pausedError);
        }

        const memoryUsage = process.memoryUsage();
        const uptime = process.uptime();

        res.json({
            status: 'healthy',
            uptime: Math.floor(uptime),
            memory: {
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memoryUsage.rss / 1024 / 1024)
            },
            active_streams: connections?.count || 0,
            live_offers: liveOffers || 0,
            paused_offers: pausedOffers || 0,
            total_sessions: sessions?.count || 0
        });
    } catch (error) {
        console.error('❌ خطأ في مراقبة الأداء:', error.message);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================================
// ✅ رسائل الدعم - باستخدام جدول messages
// ============================================================
router.get('/support-messages', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب رسائل الدعم...');
        
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب رسائل الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        const formattedMessages = (data || []).map(msg => ({
            id: msg.id,
            name: msg.sender_type === 'teacher' ? 'أستاذ' : 'مستخدم',
            email: 'غير محدد',
            phone: null,
            subject: 'رسالة دعم',
            message: msg.message,
            status: msg.is_read ? 'read' : 'unread',
            created_at: msg.created_at,
            sender_id: msg.sender_id,
            sender_type: msg.sender_type,
            receiver_id: msg.receiver_id,
            receiver_type: msg.receiver_type
        }));

        console.log(`✅ تم جلب ${formattedMessages.length} رسالة دعم`);
        res.json(formattedMessages);
    } catch (error) {
        console.error('❌ خطأ في جلب رسائل الدعم:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ تحديث رسالة دعم كمقروءة
// ============================================================
router.put('/support-messages/:id/read', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const id = parseInt(req.params.id);
        console.log(`📥 تحديث رسالة دعم ID: ${id} كمقروءة`);

        const { error } = await supabase
            .from('messages')
            .update({ is_read: true })
            .eq('id', id);

        if (error) {
            console.error('❌ خطأ في تحديث رسالة الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم تحديث رسالة الدعم ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في تحديث رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حذف رسالة دعم
// ============================================================
router.delete('/support-messages/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const id = parseInt(req.params.id);
        console.log(`📥 حذف رسالة دعم ID: ${id}`);

        const { error } = await supabase
            .from('messages')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('❌ خطأ في حذف رسالة الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف رسالة الدعم ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في حذف رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
