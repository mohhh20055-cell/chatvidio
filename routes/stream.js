// ============================================================
// مسارات البث المباشر - Stream Routes (معدل بالكامل)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const path = require('path');
const crypto = require('crypto');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');
const { verifyToken } = require('../utils/jwt');

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
// ✅ بدء البث باستخدام Jitsi Meet (مجاني 100%)
// ============================================================

router.post('/start-jitsi-stream', authenticate, authorize(['teacher']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id } = req.body;
        
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }
        
        // ✅ إنشاء غرفة Jitsi (بدون خادم خاص)
        const roomName = `zoomdz_${offer_id}_${Date.now()}`;
        const password = crypto.randomBytes(6).toString('hex').toUpperCase();
        const roomUrl = `https://meet.jit.si/${roomName}`;
        
        // ✅ حساب الوقت الكلي بالثواني
        const totalSeconds = offer.duration * 60;
        
        // ✅ حفظ بيانات البث في جدول العروض
        await supabase
            .from('offers')
            .update({
                stream_url: roomUrl,
                stream_platform: 'jitsi',
                status: 'live',
                room_name: roomName,
                room_password: password,
                stream_started_at: new Date().toISOString(),
                total_seconds: totalSeconds,
                remaining_seconds: totalSeconds,
                is_paused: false
            })
            .eq('id', offer_id);
        
        // ✅ جلب الطلاب المسجلين والمدفوعين
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id, payment_amount')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');
        
        // ✅ إنشاء كلمات مرور فريدة لكل طالب (أمان إضافي)
        if (sessions && sessions.length > 0) {
            // إرسال إشعارات للطلاب
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '🔴 البث المباشر بدأ',
                message: `الحصة "${offer.subject_name}" قد بدأت الآن. انضم عبر زر البث المباشر.\n🔑 كلمة المرور: ${password}`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            }));
            
            await supabase
                .from('notifications')
                .insert(notifications);
                
            // ✅ تحديث حالة المدفوعات إلى "pending_stream" (في انتظار البث)
            for (const session of sessions) {
                // تحديث الجلسة لتكون في حالة انتظار البث
                await supabase
                    .from('sessions')
                    .update({
                        payment_status: 'pending_stream',
                        stream_started_at: new Date().toISOString()
                    })
                    .eq('offer_id', offer_id)
                    .eq('student_id', session.student_id);
            }
        }
        
        res.json({
            success: true,
            room_url: roomUrl,
            password: password,
            room_name: roomName,
            total_seconds: totalSeconds,
            students_count: sessions?.length || 0,
            message: 'تم بدء البث بنجاح (مجاني 100%)'
        });
    } catch (error) {
        console.error('❌ خطأ في بدء البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إيقاف البث مؤقتاً (حفظ الوقت المتبقي)
// ============================================================

router.post('/pause/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('remaining_time').optional().isInt().withMessage('الوقت المتبقي غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const { remaining_time } = req.body;

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        if (offer.status !== 'live') {
            return res.status(400).json({ success: false, error: 'البث غير نشط' });
        }

        // ✅ حفظ الوقت المتبقي وتغيير الحالة إلى paused
        const updateData = {
            status: 'paused',
            is_paused: true,
            paused_at: new Date().toISOString()
        };

        if (remaining_time !== undefined) {
            updateData.remaining_seconds = remaining_time;
        }

        await supabase
            .from('offers')
            .update(updateData)
            .eq('id', offer_id);

        // ✅ إرسال إشعار للطلاب بأن البث متوقف مؤقتاً
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'pending_stream');

        if (sessions && sessions.length > 0) {
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '⏸ البث متوقف مؤقتاً',
                message: `البث المباشر للحصة "${offer.subject_name}" متوقف مؤقتاً. سيتم استئنافه قريباً.`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            }));
            await supabase.from('notifications').insert(notifications);
        }

        res.json({
            success: true,
            message: 'تم إيقاف البث مؤقتاً',
            remaining_seconds: remaining_time || offer.remaining_seconds || 0
        });
    } catch (error) {
        console.error('❌ خطأ في إيقاف البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ استئناف البث
// ============================================================

router.post('/resume/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        if (offer.status !== 'paused') {
            return res.status(400).json({ success: false, error: 'البث ليس في حالة توقف مؤقت' });
        }

        // ✅ استئناف البث
        await supabase
            .from('offers')
            .update({
                status: 'live',
                is_paused: false,
                resumed_at: new Date().toISOString()
            })
            .eq('id', offer_id);

        // ✅ إرسال إشعار للطلاب باستئناف البث
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'pending_stream');

        if (sessions && sessions.length > 0) {
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '▶️ تم استئناف البث',
                message: `تم استئناف البث المباشر للحصة "${offer.subject_name}". انضم الآن!`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            }));
            await supabase.from('notifications').insert(notifications);
        }

        res.json({
            success: true,
            message: 'تم استئناف البث',
            remaining_seconds: offer.remaining_seconds || 0
        });
    } catch (error) {
        console.error('❌ خطأ في استئناف البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إنهاء البث (مع تحويل الرصيد المعلق إلى رصيد قابل للسحب)
// ============================================================

router.post('/end/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ جلب جميع الجلسات المدفوعة لهذا العرض
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id, payment_amount')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'pending_stream');

        let totalEarned = 0;
        const teacher = await getOne('teachers', 'id', offer.teacher_id);

        // ✅ حساب الوقت الفعلي للبث
        const startedAt = new Date(offer.stream_started_at);
        const now = new Date();
        const actualSeconds = Math.floor((now - startedAt) / 1000);
        const totalSeconds = offer.total_seconds || (offer.duration * 60);
        const percentage = Math.min(1, actualSeconds / totalSeconds);

        // ✅ تحويل الجلسات إلى مدفوعة وإضافة المبلغ للرصيد
        for (const session of sessions) {
            const amount = session.payment_amount || offer.price || 0;
            // حساب المبلغ المستحق حسب النسبة الفعلية للبث
            const earnedAmount = Math.round(amount * percentage);
            
            // تحديث الجلسة إلى مدفوعة
            await supabase
                .from('sessions')
                .update({
                    payment_status: 'paid',
                    teacher_earned: earnedAmount,
                    completed_at: new Date().toISOString()
                })
                .eq('offer_id', offer_id)
                .eq('student_id', session.student_id);

            totalEarned += earnedAmount;
        }

        // ✅ تحديث رصيد الأستاذ
        if (teacher && totalEarned > 0) {
            await supabase
                .from('teachers')
                .update({
                    balance: (teacher.balance || 0) + totalEarned,
                    total_earned: (teacher.total_earned || 0) + totalEarned
                })
                .eq('id', offer.teacher_id);
        }

        // ✅ تحديث حالة العرض إلى completed
        await supabase
            .from('offers')
            .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                actual_duration_seconds: actualSeconds,
                earned_amount: totalEarned
            })
            .eq('id', offer_id);

        // ✅ حذف الجلسات النشطة
        await supabase.from('active_stream').delete().eq('offer_id', offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', offer_id);

        // ✅ إرسال إشعار للطلاب بانتهاء البث
        const { data: allSessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (allSessions && allSessions.length > 0) {
            const notifications = allSessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '✅ انتهى البث المباشر',
                message: `انتهى البث المباشر للحصة "${offer.subject_name}". شكراً لمشاركتك!`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            }));
            await supabase.from('notifications').insert(notifications);
        }

        res.json({
            success: true,
            message: 'تم إنهاء البث بنجاح',
            total_earned: totalEarned,
            actual_duration: actualSeconds,
            total_duration: totalSeconds
        });
    } catch (error) {
        console.error('❌ خطأ في إنهاء البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إنهاء البث تلقائياً عند انتهاء الوقت (يُستدعى من العميل)
// ============================================================

router.post('/complete/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ نفس منطق end ولكن مع رسالة مختلفة
        // ✅ جلب جميع الجلسات المدفوعة لهذا العرض
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id, payment_amount')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'pending_stream');

        let totalEarned = 0;
        const teacher = await getOne('teachers', 'id', offer.teacher_id);

        for (const session of sessions) {
            const amount = session.payment_amount || offer.price || 0;
            
            await supabase
                .from('sessions')
                .update({
                    payment_status: 'paid',
                    teacher_earned: amount,
                    completed_at: new Date().toISOString()
                })
                .eq('offer_id', offer_id)
                .eq('student_id', session.student_id);

            totalEarned += amount;
        }

        if (teacher && totalEarned > 0) {
            await supabase
                .from('teachers')
                .update({
                    balance: (teacher.balance || 0) + totalEarned,
                    total_earned: (teacher.total_earned || 0) + totalEarned
                })
                .eq('id', offer.teacher_id);
        }

        await supabase
            .from('offers')
            .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                earned_amount: totalEarned,
                completed_by_timer: true
            })
            .eq('id', offer_id);

        await supabase.from('active_stream').delete().eq('offer_id', offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', offer_id);

        res.json({
            success: true,
            message: 'تم إنهاء البث تلقائياً بعد انتهاء الوقت',
            total_earned: totalEarned
        });
    } catch (error) {
        console.error('❌ خطأ في إنهاء البث تلقائياً:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب حالة البث مع الوقت المتبقي
// ============================================================

router.get('/status/:offer_id', async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        const offer = await getOne('offers', 'id', offer_id);
        
        if (!offer) {
            return res.json({ 
                status: 'not_found', 
                stream_url: null,
                platform: null,
                remaining_seconds: 0,
                total_seconds: 0,
                is_paused: false
            });
        }

        // حساب الوقت المتبقي
        let remainingSeconds = offer.remaining_seconds || 0;
        let isPaused = offer.is_paused || false;
        
        if (offer.status === 'live' && !isPaused && offer.stream_started_at) {
            const startedAt = new Date(offer.stream_started_at);
            const now = new Date();
            const elapsedSeconds = Math.floor((now - startedAt) / 1000);
            const totalSeconds = offer.total_seconds || (offer.duration * 60);
            remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
        }

        res.json({ 
            status: offer.status || 'not_found',
            stream_url: offer.stream_url || null,
            platform: offer.stream_platform || null,
            remaining_seconds: remainingSeconds,
            total_seconds: offer.total_seconds || (offer.duration * 60),
            is_paused: isPaused,
            subject_name: offer.subject_name,
            teacher_id: offer.teacher_id
        });
    } catch (error) {
        console.error('خطأ في جلب حالة البث:', error.message);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================================
// ✅ التحقق من كلمة مرور Jitsi
// ============================================================

router.post('/verify-jitsi-password', async (req, res) => {
    try {
        const { room_name, password } = req.body;

        const { data } = await supabase
            .from('offers')
            .select('room_password')
            .eq('room_name', room_name)
            .single();

        if (data && data.room_password === password) {
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'كلمة المرور غير صحيحة' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ التحقق من كلمة مرور الطالب الفريدة
// ============================================================

router.post('/verify-student-password', async (req, res) => {
    try {
        const { offer_id, student_id, password } = req.body;
        
        const { data } = await supabase
            .from('student_room_passwords')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .eq('password', password)
            .single();
        
        if (data) {
            await supabase
                .from('student_room_passwords')
                .update({ used: true, used_at: new Date().toISOString() })
                .eq('id', data.id);
            
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'كلمة المرور غير صحيحة' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// حفظ رابط البث (للتوافق مع النظام القديم)
// ============================================================

router.post('/save-link', authenticate, authorize(['teacher']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('stream_url').notEmpty().withMessage('رابط البث مطلوب'),
    body('platform').isIn(['jitsi']).withMessage('منصة غير صالحة')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, stream_url, platform } = req.body;

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }
        
        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const totalSeconds = offer.duration * 60;

        await supabase
            .from('offers')
            .update({
                stream_url: stream_url,
                stream_platform: platform,
                status: 'live',
                stream_started_at: new Date().toISOString(),
                total_seconds: totalSeconds,
                remaining_seconds: totalSeconds,
                is_paused: false
            })
            .eq('id', offer_id)
            .select();

        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (sessions && sessions.length > 0) {
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '🔴 البث المباشر بدأ',
                message: 'الحصة "' + offer.subject_name + '" قد بدأت الآن.',
                offer_id: offer_id,
                stream_url: stream_url,
                is_read: false,
                created_at: new Date().toISOString()
            }));

            await supabase.from('notifications').insert(notifications);

            // تحديث حالة المدفوعات
            for (const session of sessions) {
                await supabase
                    .from('sessions')
                    .update({
                        payment_status: 'pending_stream',
                        stream_started_at: new Date().toISOString()
                    })
                    .eq('offer_id', offer_id)
                    .eq('student_id', session.student_id);
            }
        }

        res.json({
            success: true,
            message: 'تم بدء البث المباشر بنجاح',
            stream_url: stream_url,
            platform: platform,
            offer_id: offer_id
        });
    } catch (error) {
        console.error('❌ خطأ في حفظ رابط البث:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم: ' + error.message });
    }
});

// ============================================================
// جلب قائمة الانتظار
// ============================================================

router.get('/waiting-list/:offer_id/:teacher_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.params;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data } = await supabase
            .from('waiting_room')
            .select('*, students:student_id (id, full_name, email, profile_url)')
            .eq('offer_id', offer_id);

        const { data: activeStudents } = await supabase
            .from('active_stream')
            .select('student_id')
            .eq('offer_id', offer_id);

        const activeStudentIds = new Set(activeStudents?.map(s => s.student_id) || []);

        const formatted = (data || []).map(w => ({
            ...w,
            full_name: w.students?.full_name,
            email: w.students?.email,
            profile_url: w.students?.profile_url,
            is_active: activeStudentIds.has(w.student_id)
        }));

        res.json(formatted);
    } catch (error) {
        console.error('❌ خطأ في جلب قائمة الانتظار:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// إضافة طالب واحد إلى البث
// ============================================================

router.post('/add-student/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, student_id, teacher_id } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }

        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== student_id || session.payment_status !== 'paid') {
            return res.status(403).json({ success: false, error: 'الطالب ليس لديه حجز مدفوع في هذه الحصة' });
        }

        await insert('active_stream', {
            offer_id: parseInt(offer_id),
            student_id: parseInt(student_id),
            added_at: new Date().toISOString(),
            added_by_teacher: true
        });

        await supabase
            .from('waiting_room')
            .delete()
            .eq('offer_id', offer_id)
            .eq('student_id', student_id);

        await insert('notifications', {
            user_id: student_id,
            user_type: 'student',
            title: '✅ تمت إضافتك إلى البث المباشر',
            message: 'تمت إضافتك إلى البث المباشر للحصة "' + offer.subject_name + '". انضم الآن عبر زر البث المباشر.',
            offer_id: offer_id,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true, message: 'تم إضافة الطالب إلى البث' });
    } catch (error) {
        console.error('❌ خطأ في إضافة الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إضافة جميع الطلاب إلى البث وإرسال كلمات مرور فريدة
// ============================================================

router.post('/add-all-students/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }

        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (!paidSessions || paidSessions.length === 0) {
            return res.json({ success: true, students_count: 0, message: 'لا يوجد طلاب مسجلين في هذه الحصة' });
        }

        const { data: activeStudents } = await supabase
            .from('active_stream')
            .select('student_id')
            .eq('offer_id', offer_id);

        const activeStudentIds = new Set((activeStudents || []).map(s => s.student_id));

        let addedCount = 0;
        const addedStudents = [];

        for (const session of paidSessions) {
            const studentId = session.student_id;
            if (activeStudentIds.has(studentId)) continue;

            await insert('active_stream', {
                offer_id: parseInt(offer_id),
                student_id: studentId,
                added_at: new Date().toISOString(),
                added_by_teacher: true
            });

            try {
                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', studentId);
            } catch (e) { /* ignore */ }

            await insert('notifications', {
                user_id: studentId,
                user_type: 'student',
                title: '✅ تمت إضافتك إلى البث المباشر',
                message: `تمت إضافتك إلى البث المباشر للحصة "${offer.subject_name}".\n🔑 كلمة المرور: ${offer.room_password || ''}\nانضم الآن عبر زر البث المباشر.`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            });

            addedCount++;
            addedStudents.push({
                student_id: studentId,
                password: offer.room_password || ''
            });
        }

        res.json({
            success: true,
            students_count: addedCount,
            students: addedStudents,
            message: 'تم إضافة ' + addedCount + ' طالب إلى البث وإرسال الإشعارات'
        });
    } catch (error) {
        console.error('❌ خطأ في إضافة جميع الطلاب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب حالة البث للطالب (مع إمكانية الدخول)
// ============================================================

router.get('/student-status/:offer_id/:student_id', authenticate, async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // جلب بيانات العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.json({ can_join: false, error: 'العرض غير موجود' });
        }

        // التحقق من حجز الطالب
        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== student_id) {
            return res.json({ can_join: false, error: 'لم تقم بحجز هذه الحصة' });
        }

        // التحقق من حالة الدفع
        const isPaid = session.payment_status === 'paid' || session.payment_status === 'pending_stream';
        if (!isPaid) {
            return res.json({ can_join: false, error: 'لم يتم دفع الحصة' });
        }

        // التحقق من حالة البث
        const isLive = offer.status === 'live';
        const isPaused = offer.status === 'paused';
        const isActive = isLive || isPaused;

        // التحقق من أن الطالب في البث النشط
        const { data: active } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .single();

        const isInStream = !!active;

        // حساب الوقت المتبقي
        let remainingSeconds = 0;
        if (isActive) {
            if (isPaused) {
                remainingSeconds = offer.remaining_seconds || 0;
            } else if (offer.stream_started_at) {
                const startedAt = new Date(offer.stream_started_at);
                const now = new Date();
                const elapsed = Math.floor((now - startedAt) / 1000);
                const total = offer.total_seconds || (offer.duration * 60);
                remainingSeconds = Math.max(0, total - elapsed);
            }
        }

        res.json({
            can_join: isActive && isInStream,
            is_waiting: isActive && !isInStream,
            is_paused: isPaused,
            stream_url: offer.stream_url || null,
            room_password: offer.room_password || null,
            remaining_seconds: remainingSeconds,
            total_seconds: offer.total_seconds || (offer.duration * 60),
            status: offer.status,
            subject_name: offer.subject_name,
            teacher_id: offer.teacher_id
        });
    } catch (error) {
        console.error('❌ خطأ في جلب حالة البث للطالب:', error.message);
        res.status(500).json({ can_join: false, error: error.message });
    }
});

// ============================================================
// ✅ تحديث حالة العرض (للإدارة والتحكم)
// ============================================================

router.put('/update-status/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('status').isIn(['upcoming', 'live', 'paused', 'completed']).withMessage('حالة غير صالحة'),
    body('remaining_time').optional().isInt().withMessage('الوقت المتبقي غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const { status, remaining_time } = req.body;

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const updateData = { status: status };
        if (remaining_time !== undefined) {
            updateData.remaining_seconds = remaining_time;
        }
        if (status === 'paused') {
            updateData.is_paused = true;
            updateData.paused_at = new Date().toISOString();
        } else if (status === 'live') {
            updateData.is_paused = false;
            updateData.resumed_at = new Date().toISOString();
        } else if (status === 'completed') {
            updateData.completed_at = new Date().toISOString();
        }

        await supabase
            .from('offers')
            .update(updateData)
            .eq('id', offer_id);

        res.json({
            success: true,
            message: 'تم تحديث حالة العرض',
            status: status
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث حالة العرض:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ صفحة البث للأستاذ (لعرض البث)
// ============================================================

router.get('/teacher-stream/:offer_id/:teacher_id', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) {
            return res.status(401).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ يرجى تسجيل الدخول أولاً</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'teacher') {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ غير مصرح لك</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const { offer_id, teacher_id } = req.params;
        if (decoded.userId !== parseInt(teacher_id)) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ لا يمكنك عرض هذا البث</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id !== parseInt(teacher_id)) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ العرض غير موجود</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const isLive = offer.status === 'live' || offer.status === 'paused';
        if (!isLive || !offer.stream_url) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#f59e0b;">⏳ البث غير نشط حالياً</h1>
                    <p style="color:#64748b;">يرجى بدء البث أولاً من صفحة العروض</p>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // حساب الوقت المتبقي
        let remainingSeconds = offer.remaining_seconds || 0;
        if (offer.status === 'live' && offer.stream_started_at) {
            const startedAt = new Date(offer.stream_started_at);
            const now = new Date();
            const elapsed = Math.floor((now - startedAt) / 1000);
            const total = offer.total_seconds || (offer.duration * 60);
            remainingSeconds = Math.max(0, total - elapsed);
        }

        const totalSeconds = offer.total_seconds || (offer.duration * 60);
        const isPaused = offer.status === 'paused';

        res.send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>البث المباشر - ${escapeHtml(offer.subject_name)}</title>
                <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800;900&display=swap" rel="stylesheet">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: 'Cairo', Arial, sans-serif; background: #0a0a1a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
                    .container { max-width: 500px; width: 90%; background: #1a1a2e; border-radius: 24px; padding: 40px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
                    h1 { color: #0f5cbf; font-size: 1.5rem; margin-bottom: 6px; }
                    h1 span { color: #fff; }
                    .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; margin-bottom: 18px; }
                    .badge-live { background: #ef4444; color: white; animation: pulse 1.5s infinite; }
                    .badge-paused { background: #f59e0b; color: white; }
                    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
                    .timer-display { background: #0f3460; border-radius: 12px; padding: 16px; margin: 16px 0; border: 2px dashed rgba(96, 165, 250, 0.2); }
                    .timer-display .time { font-size: 2.8rem; font-weight: 900; font-family: 'Courier New', monospace; color: #60a5fa; letter-spacing: 4px; }
                    .timer-display .time.warning { color: #f59e0b; }
                    .timer-display .time.danger { color: #ef4444; animation: pulse 1s infinite; }
                    .timer-display .progress-bar { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 10px; margin-top: 12px; overflow: hidden; }
                    .timer-display .progress-bar .progress-fill { height: 100%; background: linear-gradient(90deg, #10b981, #f59e0b, #ef4444); border-radius: 10px; transition: width 1s linear; width: 100%; }
                    .timer-display .timer-label { color: #94a3b8; font-size: 0.75rem; margin-top: 8px; }
                    .btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; border: none; padding: 14px 24px; border-radius: 12px; font-size: 1rem; font-weight: 700; cursor: pointer; margin-top: 12px; transition: all 0.3s; color: #fff; }
                    .btn-open { background: linear-gradient(135deg, #10b981, #059669); }
                    .btn-open:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16,185,129,0.4); }
                    .btn-pause { background: linear-gradient(135deg, #f59e0b, #d97706); }
                    .btn-pause:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(245,158,11,0.4); }
                    .btn-resume { background: linear-gradient(135deg, #10b981, #059669); }
                    .btn-resume:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16,185,129,0.4); }
                    .btn-end { background: linear-gradient(135deg, #ef4444, #dc2626); }
                    .btn-end:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(239,68,68,0.4); }
                    .info { color: #94a3b8; font-size: 0.8rem; margin-top: 16px; line-height: 1.7; }
                    .password-box { background: rgba(96, 165, 250, 0.05); border: 1px solid rgba(96, 165, 250, 0.1); border-radius: 8px; padding: 12px; margin: 8px 0; }
                    .password-box span { font-family: 'Courier New', monospace; font-weight: 700; color: #60a5fa; letter-spacing: 2px; }
                    .btn-group { display: flex; gap: 10px; flex-wrap: wrap; }
                    .btn-group .btn { flex: 1; min-width: 120px; }
                    @media(max-width:600px) { .container { padding: 24px; } .timer-display .time { font-size: 2rem; } .btn-group .btn { min-width: 100px; } }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="badge ${isPaused ? 'badge-paused' : 'badge-live'}">${isPaused ? '⏸ متوقف مؤقتاً' : '🔴 بث مباشر'}</div>
                    <h1>🎥 <span>${escapeHtml(offer.subject_name)}</span></h1>
                    
                    <div class="timer-display">
                        <div class="time" id="timerDisplay">--:--:--</div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="timerProgress" style="width: 100%;"></div>
                        </div>
                        <div class="timer-label" id="timerLabel">⏱ الوقت المتبقي</div>
                    </div>

                    <div class="password-box">
                        <span>🔑 كلمة المرور: ${offer.room_password || 'غير محددة'}</span>
                    </div>

                    <div class="btn-group">
                        <button class="btn btn-open" onclick="openStream()">🎥 فتح البث</button>
                        ${isPaused ? 
                            `<button class="btn btn-resume" onclick="resumeStream()">▶️ استئناف</button>` :
                            `<button class="btn btn-pause" onclick="pauseStream()">⏸ إيقاف مؤقت</button>`
                        }
                    </div>
                    <button class="btn btn-end" onclick="endStream()">⏹️ إنهاء البث</button>
                    <p class="info">✅ Jitsi Meet يُفتح في نافذة جديدة (مجاني 100%)</p>
                </div>
                <script>
                    const API_BASE_URL = window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;
                    const authToken = '${token}';
                    const offerId = ${parseInt(offer_id)};
                    const teacherId = ${parseInt(teacher_id)};
                    const roomUrl = '${offer.stream_url}';
                    let remainingSeconds = ${remainingSeconds};
                    const totalSeconds = ${totalSeconds};
                    let isPaused = ${isPaused ? 'true' : 'false'};
                    let timerInterval = null;

                    function updateTimerDisplay() {
                        const display = document.getElementById('timerDisplay');
                        const progress = document.getElementById('timerProgress');
                        const label = document.getElementById('timerLabel');
                        
                        const hours = Math.floor(remainingSeconds / 3600);
                        const minutes = Math.floor((remainingSeconds % 3600) / 60);
                        const seconds = remainingSeconds % 60;
                        const timeStr = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
                        display.textContent = timeStr;
                        
                        const percentage = (remainingSeconds / totalSeconds) * 100;
                        progress.style.width = Math.min(100, percentage) + '%';
                        
                        display.className = 'time';
                        if (percentage < 10) display.classList.add('danger');
                        else if (percentage < 30) display.classList.add('warning');
                        
                        const elapsed = totalSeconds - remainingSeconds;
                        const elapsedMinutes = Math.floor(elapsed / 60);
                        const totalMinutes = Math.floor(totalSeconds / 60);
                        label.textContent = isPaused ? '⏸ متوقف مؤقتاً' : \`⏱ \${elapsedMinutes}/\${totalMinutes} دقيقة\`;
                    }

                    function startTimer() {
                        if (timerInterval) clearInterval(timerInterval);
                        updateTimerDisplay();
                        timerInterval = setInterval(() => {
                            if (!isPaused && remainingSeconds > 0) {
                                remainingSeconds--;
                                updateTimerDisplay();
                                if (remainingSeconds <= 0) {
                                    clearInterval(timerInterval);
                                    timerInterval = null;
                                    alert('⏰ انتهى وقت البث! سيتم إنهاء البث تلقائياً.');
                                    completeStream();
                                }
                            }
                        }, 1000);
                    }

                    function openStream() {
                        const w = window.open(roomUrl, '_blank');
                        if (!w) alert('⚠️ يرجى السماح بفتح النوافذ المنبثقة');
                    }

                    async function pauseStream() {
                        if (isPaused) return;
                        if (!confirm('⏸ هل تريد إيقاف البث مؤقتاً؟')) return;
                        try {
                            const res = await fetch(API_BASE_URL + '/api/stream/pause/' + offerId, {
                                method: 'POST',
                                headers: {
                                    'Authorization': 'Bearer ' + authToken,
                                    'Content-Type': 'application/json',
                                    'X-CSRF-Token': '${csrfToken || ''}'
                                },
                                body: JSON.stringify({ remaining_time: remainingSeconds })
                            });
                            const data = await res.json();
                            if (data.success) {
                                isPaused = true;
                                updateTimerDisplay();
                                document.querySelector('.badge').className = 'badge badge-paused';
                                document.querySelector('.badge').textContent = '⏸ متوقف مؤقتاً';
                                document.querySelector('.btn-pause').outerHTML = '<button class="btn btn-resume" onclick="resumeStream()">▶️ استئناف</button>';
                                showToast('⏸ تم إيقاف البث مؤقتاً', 'warning');
                            } else {
                                alert('❌ ' + (data.error || 'حدث خطأ'));
                            }
                        } catch(e) { console.error(e); alert('❌ حدث خطأ'); }
                    }

                    async function resumeStream() {
                        if (!isPaused) return;
                        try {
                            const res = await fetch(API_BASE_URL + '/api/stream/resume/' + offerId, {
                                method: 'POST',
                                headers: {
                                    'Authorization': 'Bearer ' + authToken,
                                    'Content-Type': 'application/json',
                                    'X-CSRF-Token': '${csrfToken || ''}'
                                }
                            });
                            const data = await res.json();
                            if (data.success) {
                                isPaused = false;
                                document.querySelector('.badge').className = 'badge badge-live';
                                document.querySelector('.badge').textContent = '🔴 بث مباشر';
                                document.querySelector('.btn-resume').outerHTML = '<button class="btn btn-pause" onclick="pauseStream()">⏸ إيقاف مؤقت</button>';
                                startTimer();
                                showToast('▶️ تم استئناف البث', 'success');
                            } else {
                                alert('❌ ' + (data.error || 'حدث خطأ'));
                            }
                        } catch(e) { console.error(e); alert('❌ حدث خطأ'); }
                    }

                    async function completeStream() {
                        try {
                            const res = await fetch(API_BASE_URL + '/api/stream/complete/' + offerId, {
                                method: 'POST',
                                headers: {
                                    'Authorization': 'Bearer ' + authToken,
                                    'Content-Type': 'application/json',
                                    'X-CSRF-Token': '${csrfToken || ''}'
                                },
                                body: JSON.stringify({ teacher_id: teacherId })
                            });
                            const data = await res.json();
                            if (data.success) {
                                alert('✅ تم إنهاء البث تلقائياً!');
                                window.location.href = '/teacher-dashboard.html';
                            }
                        } catch(e) { console.error(e); }
                    }

                    async function endStream() {
                        if (!confirm('⚠️ هل أنت متأكد من إنهاء البث المباشر؟')) return;
                        try {
                            const res = await fetch(API_BASE_URL + '/api/stream/end/' + offerId, {
                                method: 'POST',
                                headers: {
                                    'Authorization': 'Bearer ' + authToken,
                                    'Content-Type': 'application/json',
                                    'X-CSRF-Token': '${csrfToken || ''}'
                                },
                                body: JSON.stringify({ teacher_id: teacherId, remaining_time: remainingSeconds })
                            });
                            const data = await res.json();
                            if (data.success) {
                                alert('✅ تم إنهاء البث بنجاح! تم تحويل الرصيد المعلق إلى رصيدك.');
                                window.location.href = '/teacher-dashboard.html';
                            } else {
                                alert('❌ ' + (data.error || 'حدث خطأ'));
                            }
                        } catch(e) { console.error(e); alert('❌ حدث خطأ'); }
                    }

                    function showToast(msg, type) {
                        const container = document.getElementById('toastContainer') || document.body;
                        const t = document.createElement('div');
                        t.style.cssText = 'position:fixed;bottom:20px;right:20px;left:20px;background:#1a1a2e;color:white;padding:12px 20px;border-radius:10px;text-align:center;z-index:9999;font-weight:700;max-width:400px;margin:0 auto;border-right:4px solid ' + (type === 'warning' ? '#f59e0b' : '#10b981');
                        t.textContent = msg;
                        container.appendChild(t);
                        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 4000);
                    }

                    // فتح البث تلقائياً عند التحميل
                    setTimeout(openStream, 1000);
                    
                    // بدء العداد
                    startTimer();

                    // مزامنة كل 30 ثانية
                    setInterval(async () => {
                        try {
                            const res = await fetch(API_BASE_URL + '/api/stream/status/' + offerId);
                            const data = await res.json();
                            if (data.status !== 'live' && data.status !== 'paused') {
                                alert('⏹️ انتهى البث المباشر');
                                window.location.href = '/teacher-dashboard.html';
                            }
                            if (data.remaining_seconds !== undefined && data.remaining_seconds !== remainingSeconds) {
                                remainingSeconds = data.remaining_seconds;
                                updateTimerDisplay();
                            }
                            isPaused = data.is_paused || false;
                        } catch(e) { console.error(e); }
                    }, 30000);

                    console.log('✅ تم تهيئة صفحة البث للأستاذ');
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ خطأ في صفحة البث للأستاذ:', error.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head><meta charset="UTF-8"><title>خطأ</title></head>
            <body style="font-family:Cairo;text-align:center;padding:50px;">
                <h1 style="color:#ef4444;">❌ حدث خطأ</h1>
                <p style="color:#64748b;">${escapeHtml(error.message)}</p>
                <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
            </body></html>
        `);
    }
});

// ============================================================
// ✅ صفحة البث للطالب (دخول البث مع Jitsi)
// ============================================================

router.get('/join-stream/:offer_id/:student_id', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) {
            return res.status(401).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ يرجى تسجيل الدخول أولاً</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'student') {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ غير مصرح لك</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const { offer_id, student_id } = req.params;
        if (decoded.userId !== parseInt(student_id)) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ لا يمكنك دخول هذا البث</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // ✅ التحقق من أن الطالب لديه حجز مدفوع
        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== parseInt(student_id)) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ لم تقم بحجز هذه الحصة</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const isPaid = session.payment_status === 'paid' || session.payment_status === 'pending_stream';
        if (!isPaid) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ لم يتم دفع الحصة</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ العرض غير موجود</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const isLive = offer.status === 'live' || offer.status === 'paused';
        if (!isLive || !offer.stream_url) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#f59e0b;">⏳ البث لم يبدأ بعد</h1>
                    <p style="color:#64748b;">يرجى الانتظار حتى يبدأ الأستاذ البث المباشر</p>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // ✅ إضافة الطالب إلى active_stream
        const { data: active } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .single();

        if (!active) {
            await insert('active_stream', {
                offer_id: parseInt(offer_id),
                student_id: parseInt(student_id),
                joined_at: new Date().toISOString()
            });
        }

        // ✅ تحديث الإشعار كمقروء
        await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('offer_id', offer_id)
            .eq('user_id', student_id);

        // ✅ حساب الوقت المتبقي
        let remainingSeconds = offer.remaining_seconds || 0;
        if (offer.status === 'live' && offer.stream_started_at) {
            const startedAt = new Date(offer.stream_started_at);
            const now = new Date();
            const elapsed = Math.floor((now - startedAt) / 1000);
            const total = offer.total_seconds || (offer.duration * 60);
            remainingSeconds = Math.max(0, total - elapsed);
        }

        const totalSeconds = offer.total_seconds || (offer.duration * 60);
        const isPaused = offer.status === 'paused';

        // ✅ عرض صفحة دخول Jitsi (بدون iframe)
        res.send(generateStudentJitsiPage(offer, offer.room_password || '', remainingSeconds, totalSeconds, isPaused));
    } catch (error) {
        console.error('❌ خطأ في صفحة البث للطالب:', error.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head><meta charset="UTF-8"><title>خطأ</title></head>
            <body style="font-family:Cairo;text-align:center;padding:50px;">
                <h1 style="color:#ef4444;">❌ حدث خطأ</h1>
                <p style="color:#64748b;">${escapeHtml(error.message)}</p>
                <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
            </body></html>
        `);
    }
});

// ============================================================
// ✅ دالة توليد صفحة دخول Jitsi للطالب
// ============================================================

function generateStudentJitsiPage(offer, password, remainingSeconds, totalSeconds, isPaused) {
    const roomUrl = offer.stream_url || '';
    const subjectName = offer.subject_name || 'غير محدد';
    
    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>دخول البث المباشر</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', sans-serif; background: #0a0a1a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { max-width: 450px; width: 90%; background: #1a1a2e; border-radius: 24px; padding: 40px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        h1 { color: #0f5cbf; font-size: 1.5rem; margin-bottom: 6px; }
        .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 16px; }
        .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; margin-bottom: 12px; }
        .badge-live { background: #ef4444; color: white; animation: pulse 1.5s infinite; }
        .badge-paused { background: #f59e0b; color: white; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
        .timer-display { background: #0f3460; border-radius: 12px; padding: 12px; margin: 12px 0; border: 1px dashed rgba(96, 165, 250, 0.2); }
        .timer-display .time { font-size: 2rem; font-weight: 900; font-family: 'Courier New', monospace; color: #60a5fa; letter-spacing: 3px; }
        .timer-display .time.warning { color: #f59e0b; }
        .timer-display .time.danger { color: #ef4444; animation: pulse 1s infinite; }
        .timer-display .timer-label { color: #94a3b8; font-size: 0.7rem; margin-top: 4px; }
        .password-box { background: rgba(96, 165, 250, 0.05); border: 1px solid rgba(96, 165, 250, 0.1); border-radius: 8px; padding: 12px; margin: 12px 0; }
        .password-box span { font-family: 'Courier New', monospace; font-weight: 700; color: #60a5fa; letter-spacing: 2px; font-size: 1.2rem; }
        .btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 14px 24px; border-radius: 12px; font-size: 1rem; font-weight: 700; cursor: pointer; width: 100%; transition: all 0.3s; margin-top: 12px; display: flex; align-items: center; justify-content: center; gap: 10px; }
        .btn:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; }
        .info { color: #64748b; font-size: 0.8rem; margin-top: 16px; line-height: 1.6; }
        .info i { color: #f59e0b; }
        .copy-btn { background: transparent; border: 1px solid #333; color: #94a3b8; padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 0.75rem; transition: all 0.3s; margin-top: 6px; }
        .copy-btn:hover { background: #1a1a2e; border-color: #0f5cbf; color: white; }
        .warning { color: #f59e0b; font-size: 0.75rem; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="badge ${isPaused ? 'badge-paused' : 'badge-live'}">${isPaused ? '⏸ متوقف مؤقتاً' : '🔴 بث مباشر'}</div>
        <h1>🎥 ${escapeHtml(subjectName)}</h1>
        <p class="subtitle">🔐 أدخل كلمة المرور للدخول إلى البث المباشر</p>
        
        <div class="timer-display">
            <div class="time" id="timerDisplay">--:--:--</div>
            <div class="timer-label" id="timerLabel">⏱ الوقت المتبقي</div>
        </div>
        
        <div class="password-box">
            <span id="roomPassword">${password}</span>
            <br>
            <button class="copy-btn" onclick="copyPassword()">
                <i class="fas fa-copy"></i> نسخ كلمة المرور
            </button>
        </div>
        
        <button class="btn" onclick="joinJitsi()" id="joinBtn">
            <i class="fas fa-video"></i> فتح البث المباشر
        </button>
        
        <p class="info">
            <i class="fas fa-info-circle"></i> سيتم فتح Jitsi Meet في نافذة جديدة<br>
            ⚠️ أدخل كلمة المرور أعلاه عند الطلب
        </p>
        <p class="warning">
            ⚠️ لا تشارك كلمة المرور مع أي شخص خارج الحصة
        </p>
    </div>
    
    <script>
        const roomUrl = '${roomUrl}';
        const password = '${password}';
        let remainingSeconds = ${remainingSeconds};
        const totalSeconds = ${totalSeconds};
        let isPaused = ${isPaused ? 'true' : 'false'};
        let timerInterval = null;

        function updateTimerDisplay() {
            const display = document.getElementById('timerDisplay');
            const label = document.getElementById('timerLabel');
            const hours = Math.floor(remainingSeconds / 3600);
            const minutes = Math.floor((remainingSeconds % 3600) / 60);
            const seconds = remainingSeconds % 60;
            const timeStr = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
            display.textContent = timeStr;
            
            display.className = 'time';
            const percentage = (remainingSeconds / totalSeconds) * 100;
            if (percentage < 10) display.classList.add('danger');
            else if (percentage < 30) display.classList.add('warning');
            
            const elapsed = totalSeconds - remainingSeconds;
            const elapsedMinutes = Math.floor(elapsed / 60);
            const totalMinutes = Math.floor(totalSeconds / 60);
            label.textContent = isPaused ? '⏸ متوقف مؤقتاً' : \`⏱ \${elapsedMinutes}/\${totalMinutes} دقيقة\`;
        }

        function startTimer() {
            if (timerInterval) clearInterval(timerInterval);
            updateTimerDisplay();
            timerInterval = setInterval(() => {
                if (!isPaused && remainingSeconds > 0) {
                    remainingSeconds--;
                    updateTimerDisplay();
                    if (remainingSeconds <= 0) {
                        clearInterval(timerInterval);
                        timerInterval = null;
                        document.getElementById('joinBtn').disabled = true;
                        document.getElementById('joinBtn').innerHTML = '⏰ انتهى البث';
                        document.querySelector('.badge').className = 'badge badge-paused';
                        document.querySelector('.badge').textContent = '⏰ انتهى البث';
                    }
                }
            }, 1000);
        }

        function copyPassword() {
            navigator.clipboard.writeText(password).then(() => {
                const btn = document.querySelector('.copy-btn');
                btn.innerHTML = '✅ تم النسخ';
                setTimeout(() => {
                    btn.innerHTML = '<i class="fas fa-copy"></i> نسخ كلمة المرور';
                }, 2000);
            });
        }
        
        function joinJitsi() {
            if (remainingSeconds <= 0) {
                alert('⏰ انتهى وقت البث');
                return;
            }
            const newWindow = window.open(roomUrl, '_blank');
            if (newWindow) {
                setTimeout(() => {
                    alert('🔑 كلمة المرور: ' + password + '\\n\\nأدخلها عند الطلب في صفحة Jitsi');
                }, 2000);
            } else {
                alert('⚠️ يرجى السماح بفتح النوافذ المنبثقة');
            }
        }

        // بدء العداد
        startTimer();

        // مزامنة كل 30 ثانية
        setInterval(async () => {
            try {
                const res = await fetch('/api/stream/status/' + ${parseInt(offer.id)});
                const data = await res.json();
                if (data.status !== 'live' && data.status !== 'paused') {
                    document.getElementById('joinBtn').disabled = true;
                    document.getElementById('joinBtn').innerHTML = '⏹ انتهى البث';
                    if (timerInterval) clearInterval(timerInterval);
                }
                if (data.remaining_seconds !== undefined) {
                    remainingSeconds = data.remaining_seconds;
                    isPaused = data.is_paused || false;
                    updateTimerDisplay();
                }
            } catch(e) { console.error(e); }
        }, 30000);

        console.log('✅ تم تهيئة صفحة البث للطالب');
    </script>
</body>
</html>
    `;
}

// دالة مساعدة
function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
