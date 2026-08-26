const logger = require('../utils/logger');
// ============================================================
// مسارات البث المباشر - Stream Routes (مع نظام التحقق المستقل)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const path = require('path');
const crypto = require('crypto');

const { supabase } = require('../config/database');
const { authenticate, authorize, checkBanned, checkActiveStream, isOwner, validateOfferOwnership, validateStudentAccess, checkStreamActive, checkNoActiveStream } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');
const { verifyToken } = require('../utils/jwt');

// ✅ استيراد نظام التحقق المستقل من وقت البث
const { 
    recordStreamStart, 
    recordStreamEnd, 
    processStreamPayments, 
    getStreamVerification,
    verifyStreamCompletion,
    forceEndStream,
    archiveStreamLog
} = require('../utils/streamVerification');

// دالة مساعدة لحماية HTML
function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// ✅ بدء البث باستخدام Jitsi Meet (مع نظام التحقق المستقل)
// ============================================================
// ✅ بدء البث باستخدام Zoom Video SDK (مع نظام التحقق المستقل)
// ============================================================

const handleStreamStart = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.body.offer_id, 10);
        
        // ✅ التحقق من أن الدرس مملوك للأستاذ
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }
        
        if (req.user.userId === -1 || req.user.userId === '-1' || req.user.is_guest || offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك ببدء هذا البث' });
        }

        if (offer.status === 'completed' || offer.status === 'cancelled') {
            return res.status(400).json({ success: false, error: 'لا يمكن إعادة تشغيل حصة منتهية أو ملغاة' });
        }

        // ✅ تم إلغاء قيود الوقت للأستاذ لفتح البث متى شاء دون أي شروط زمنية


        // ✅ إنشاء غرفة Agora.io
        let roomName = offer.room_name;
        let password = offer.room_password;

        if (!roomName) {
            const randomSuffix = crypto.randomBytes(8).toString('hex');
            roomName = `zoomdz_session_${offer_id}_${randomSuffix}`;
            password = crypto.randomBytes(4).toString('hex').toUpperCase();
        }
        
        const roomUrl = `/api/teacher-agora/${offer_id}`;
        
        // ✅ حفظ بيانات البث في جدول الدروس
        await supabase
            .from('offers')
            .update({
                stream_url: roomUrl,
                stream_platform: 'agora',
                status: 'live',
                room_name: roomName,
                room_password: password
            })
            .eq('id', offer_id);
        
        // ✅ تسجيل بداية البث من الخادم (نظام التحقق المستقل)
        await recordStreamStart(offer_id, req.user.userId);
        console.log(`✅ تم تسجيل بداية البث من الخادم: ${new Date().toISOString()}`);
        
        // ✅ جلب الطلاب المسجلين والمدفوعين
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id, payment_amount')
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);
        
        // ✅ تحديث حالة المدفوعات إلى "pending_stream"
        if (sessions && sessions.length > 0) {
            for (const session of sessions) {
                await supabase
                    .from('sessions')
                    .update({
                        payment_status: 'pending_stream'
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
            duration: offer.duration,
            students_count: sessions?.length || 0,
            message: 'تم بدء البث المباشر بنجاح - نظام التحقق المستقل مفعّل'
        });
    } catch (error) {
        logger.error('❌ خطأ في بدء البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
};

router.post('/start-jitsi-stream', authenticate, authorize(['teacher']), checkNoActiveStream, [
    body('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], handleStreamStart);

router.post('/start-zoom-stream', authenticate, authorize(['teacher']), checkNoActiveStream, [
    body('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], handleStreamStart);



// ============================================================
// ✅ إنهاء البث (مع نظام التحقق المستقل ومعالجة المدفوعات)
// ============================================================

router.post('/end/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const early_end = req.body.early_end === true || req.query.early_end === 'true' || req.body.cancel_before_start === true;

        // ✅ حفظ الوقت المتبقي في موقت الأستاذ إن تم تمريره في الطلب لضمان أعلى دقة في حساب نسبة الإكتمال
        if (req.body.remaining_seconds !== undefined && !isNaN(Number(req.body.remaining_seconds))) {
            try {
                await saveOfferRemainingTime(offer_id, Number(req.body.remaining_seconds), false);
            } catch (e) {}
        }

        // ✅ التحقق من وجود الدرس وحالته الحالية
        const currentOffer = await getOne('offers', 'id', offer_id);
        if (!currentOffer) {
            return res.json({ success: true, message: 'الدرس محذوف بالفعل', deleted: true });
        }

        // ✅ تسجيل نهاية البث من الخادم ومعالجة المدفوعات بأمان
        let verification = null;
        let completion = { completion_percentage: 100 };
        try {
            await recordStreamEnd(offer_id, req.user.userId);
            verification = await getStreamVerification(offer_id);
            completion = await verifyStreamCompletion(offer_id);
        } catch (verifErr) {
            logger.error('⚠️ خطأ في تسجيل وقت نهاية البث:', verifErr.message);
        }

        try {
            if (early_end) {
                console.log(`⚠️ إنهاء مبكر - البدء في معالجة الاستردادات`);
                await processStreamPayments(offer_id, true);
                
                try {
                    await supabase.from('notifications').insert({
                        user_id: req.user.userId,
                        user_type: 'teacher',
                        title: '🔴 تم إنهاء البث وحذف الدرس',
                        message: `لقد تم إنهاء البث الخاص بـ "${currentOffer.subject_name}" وحذف الدرس واسترداد الرصيد للطلاب.`,
                        is_read: false,
                        created_at: new Date().toISOString()
                    });
                } catch (notifError) {
                    logger.error('⚠️ خطأ في إرسال إشعار الإنهاء للأستاذ:', notifError.message);
                }
            } else {
                console.log(`✅ إنهاء البث - معالجة توزيع الرصيد للأستاذ/الاسترداد حسب وقت البث`);
                await processStreamPayments(offer_id, false);
            }
        } catch (payErr) {
            logger.error('⚠️ خطأ في معالجة مدفوعات البث:', payErr.message);
        }

        // ✅ أرشفة وحفظ سجل البث كاملاً بجميع إحصائياته وتفاصيل الطلاب لاستخدامه كدليل إثبات للمدير
        try {
            await archiveStreamLog(offer_id, early_end ? 'early_end' : 'ended', req.user ? req.user.userId : null);
        } catch (archErr) {
            logger.error('⚠️ خطأ في أرشفة البث قبل الحذف:', archErr.message);
        }

        // ✅ تصفير offer_id في الجداول التي تحتفظ بالسجلات لتجنب قيود المفتاح الأجنبي (Foreign Key Constraints)
        const tablesToNullify = ['sessions', 'bookings', 'wallet_transactions', 'notifications', 'reports'];
        for (const tbl of tablesToNullify) {
            try {
                await supabase.from(tbl).update({ offer_id: null }).eq('offer_id', offer_id);
            } catch (e) {
                logger.error(`⚠️ خطأ عند تصفير offer_id في ${tbl}:`, e.message);
            }
        }

        // ✅ حذف البيانات المؤقتة الخاصة بالبث
        const tablesToDelete = [
            'active_stream', 
            'waiting_room', 
            'student_room_passwords', 
            'stream_verification', 
            'stream_chat_messages', 
            'stream_mutes'
        ];
        
        for (const tbl of tablesToDelete) {
            try {
                await supabase.from(tbl).delete().eq('offer_id', offer_id);
            } catch (e) {
                logger.error(`⚠️ خطأ عند حذف بيانات ${tbl}:`, e.message);
            }
        }

        // ✅ حذف الدرس نهائياً من جدول offers
        const { error: deleteError } = await supabase
            .from('offers')
            .delete()
            .eq('id', offer_id);

        if (deleteError) {
            logger.error('❌ خطأ في حذف الدرس بعد إنهاء البث:', deleteError.message);
            return res.status(500).json({ success: false, error: deleteError.message });
        }

        console.log(`✅ تم إنهاء البث وحذف الدرس ${offer_id} بنجاح من قاعدة البيانات`);
        return res.json({
            success: true,
            message: 'تم إنهاء البث وتوزيع مستحقات/استرداد الأموال وحذف الدرس بنجاح',
            deleted: true
        });
    } catch (error) {
        logger.error('❌ خطأ في إنهاء البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب حالة البث (عام - لا يحتاج مصادقة)
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
                duration: 0
            });
        }

        res.json({ 
            status: offer.status || 'not_found',
            stream_url: offer.stream_url || null,
            platform: offer.stream_platform || null,
            duration: offer.duration || 0,
            subject_name: offer.subject_name,
            teacher_id: offer.teacher_id,
            booked_count: offer.booked_count || 0,
            room_password: offer.room_password || null
        });
    } catch (error) {
        logger.error('خطأ في جلب حالة البث:', error.message);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================================
// ✅ جلب حالة البث للطالب (مع التحقق من صلاحية الطالب)
// ============================================================

router.get('/student-status/:offer_id/:student_id', authenticate, validateStudentAccess, async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // جلب بيانات الدرس
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.json({ can_join: false, error: 'الدرس غير موجود' });
        }

        // التحقق من حالة الدفع (req.session متاح من validateStudentAccess)
        const isPaid = req.session.payment_status === 'paid' || req.session.payment_status === 'pending_stream';
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

        // Get count of real-time active students (pinged in last 10s, excluding teacher)
        let activeCount = 0;
        try {
            const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
            const { count } = await supabase
                .from('active_stream')
                .select('*', { count: 'exact', head: true })
                .eq('offer_id', offer_id)
                .not('student_id', 'is', null)
                .gte('last_ping', tenSecondsAgo);
            activeCount = count || 0;
        } catch (e) {}

        res.json({
            can_join: isActive && isInStream,
            is_waiting: isActive && !isInStream,
            is_paused: isPaused,
            stream_url: offer.stream_url || null,
            room_password: offer.room_password || null,
            duration: offer.duration || 0,
            status: offer.status,
            subject_name: offer.subject_name,
            teacher_id: offer.teacher_id,
            active_students_count: activeCount
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب حالة البث للطالب:', error.message);
        res.status(500).json({ can_join: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب عدد الطلاب في قائمة الانتظار
// ============================================================

router.get('/waiting-count/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('waiting_room')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', req.params.offer_id);
        
        if (error) throw error;
        res.json({ success: true, count: count || 0 });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إضافة جميع الطلاب إلى البث (مع التحقق من ملكية الدرس)
// ============================================================

router.post('/add-all-students/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح'),
    body('teacher_id').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const offer = req.offer;
        const baseUrl = req.protocol + '://' + req.get('host');

        // ✅ تحديث حالة البث وتواجد الأستاذ فوراً لمنع أي إشارة توقف خاطئة للطالب
        teacherPingStore.set(offer_id, Date.now());
        try {
            await supabase
                .from('offers')
                .update({ status: 'live', is_paused: false })
                .eq('id', offer_id);
        } catch (e) {}


        // Dynamically fix any generic 'طالب' names in chat messages
        const unassignedStudentIds = msgs
            .filter(m => m.sender_role === 'student' && (!m.sender_name || m.sender_name === 'طالب') && m.sender_id)
            .map(m => m.sender_id);

        if (unassignedStudentIds.length > 0) {
            const uniqueIds = Array.from(new Set(unassignedStudentIds));
            try {
                const { data: stdList } = await supabase
                    .from('students')
                    .select('id, full_name, name, username')
                    .in('id', uniqueIds);

                if (stdList && stdList.length > 0) {
                    const stdMap = new Map();
                    stdList.forEach(s => stdMap.set(s.id, s.full_name || s.name || s.username));
                    msgs = msgs.map(m => {
                        if (m.sender_role === 'student' && (!m.sender_name || m.sender_name === 'طالب') && stdMap.has(m.sender_id)) {
                            return { ...m, sender_name: stdMap.get(m.sender_id) };
                        }
                        return m;
                    });
                }
            } catch (e) {}
        }

        res.json({
            success: true,
            messages: msgs,
            is_muted: isMuted,
            muted_students: mutedStudentsList,
            active_count: activeCount,
            remaining_seconds: offerRemainingSeconds,
            total_seconds: offerTotalSeconds,
            stream_status: offerStatus,
            is_paused: isPaused,
            is_teacher_online: isTeacherOnline
        });
    } catch (error) {
        logger.error('خطأ في جلب الرسائل:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}

async function handleStudentLeave(req, res) {
    try {
        const offerId = parseInt(req.params.offer_id);
        const userId = req.user?.userId;
        const role = req.user?.userType || req.user?.role || 'student';

        if (role === 'student' && userId && offerId) {
            await supabase
                .from('active_stream')
                .delete()
                .eq('offer_id', offerId)
                .eq('student_id', userId);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}

router.post('/leave/:offer_id', authenticate, handleStudentLeave);
router.post('/chat/send', authenticate, handleSendChatMessage);
router.post('/send', authenticate, handleSendChatMessage);

router.get('/chat/messages/:offer_id', authenticate, handleGetChatMessages);
router.get('/messages/:offer_id', authenticate, handleGetChatMessages);

router.post('/chat/mute', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const { offer_id, student_id, mute } = req.body;
        const offerId = parseInt(offer_id);
        const studentId = parseInt(student_id);

        if (!offerId || !studentId) {
            return res.status(400).json({ success: false, error: 'بيانات غير صالحة' });
        }

        const { data: offer } = await supabase
            .from('offers')
            .select('teacher_id')
            .eq('id', offerId)
            .single();

        if (offer && offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بالتحكم في كتم هذا البث' });
        }

        if (!mutedStudentsStore.has(offerId)) {
            mutedStudentsStore.set(offerId, new Set());
        }
        const mutedSet = mutedStudentsStore.get(offerId);

        if (mute) {
            mutedSet.add(studentId);
        } else {
            mutedSet.delete(studentId);
        }

        try {
            if (mute) {
                await supabase.from('stream_mutes').insert({ offer_id: offerId, student_id: studentId, created_at: new Date().toISOString() });
            } else {
                await supabase.from('stream_mutes').delete().eq('offer_id', offerId).eq('student_id', studentId);
            }
        } catch (e) {}

        const mutedList = Array.from(mutedSet);
        res.json({
            success: true,
            message: mute ? 'تم كتم الطالب في هذه الحصة' : 'تم إلغاء كتم الطالب',
            is_muted: !!mute,
            student_id: studentId,
            muted_students: mutedList
        });
    } catch (error) {
        logger.error('خطأ في تغيير حالة الكتم:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/chat/muted-students/:offer_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const offerId = parseInt(req.params.offer_id);
        const mutedSet = mutedStudentsStore.get(offerId) || new Set();
        res.json({
            success: true,
            muted_students: Array.from(mutedSet)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ نظام حفظ وإيقاف واستئناف الموقت التلقائي واليدوي للبث
// ============================================================

async function saveOfferRemainingTime(offerId, remainingSeconds, isPaused = false) {
    const sec = Math.max(0, parseInt(remainingSeconds, 10) || 0);
    const updateObj = {
        status: isPaused ? 'paused' : 'live'
    };
    if (isPaused) {
        teacherPingStore.delete(offerId);
    } else {
        teacherPingStore.set(offerId, Date.now());
    }

    // محاولة التحديث باستخدام remaining_seconds
    try {
        await supabase
            .from('offers')
            .update({ ...updateObj, remaining_seconds: sec })
            .eq('id', offerId);
    } catch(e) {}

    // محاولة التحديث باستخدام remaining_time
    try {
        await supabase
            .from('offers')
            .update({ ...updateObj, remaining_time: sec })
            .eq('id', offerId);
    } catch(e) {}

    return true;
}

// ✅ مسار مزامنة وحفظ الوقت المتبقي للبث
router.post('/sync-timer/:offer_id', async (req, res) => {
    try {
        let token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token || req.body?.token;
        if (!token) return res.status(401).json({ success: false, error: 'غير مصرح' });
        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'teacher') return res.status(403).json({ success: false, error: 'غير مصرح' });

        const offerId = parseInt(req.params.offer_id);
        const { remaining_seconds, is_paused } = req.body || {};

        if (remaining_seconds !== undefined && !isNaN(Number(remaining_seconds))) {
            await saveOfferRemainingTime(offerId, Number(remaining_seconds), is_paused === true);
        }

        res.json({ success: true, remaining_seconds: Number(remaining_seconds) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ مسار إيقاف / استئناف الموقت
router.post('/pause-timer/:offer_id', async (req, res) => {
    try {
        let token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token || req.body?.token;
        if (!token) return res.status(401).json({ success: false, error: 'غير مصرح' });
        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'teacher') return res.status(403).json({ success: false, error: 'غير مصرح' });

        const offerId = parseInt(req.params.offer_id);
        const { remaining_seconds, is_paused } = req.body || {};

        const sec = remaining_seconds !== undefined ? Number(remaining_seconds) : null;
        if (sec !== null && !isNaN(sec)) {
            await saveOfferRemainingTime(offerId, sec, is_paused !== false);
        }

        res.json({ success: true, is_paused: is_paused !== false, remaining_seconds: sec });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ مسار إبلاغ مغادرة الأستاذ للبث فوراً
router.all('/teacher-leave/:offer_id', async (req, res) => {
    try {
        const offerId = parseInt(req.params.offer_id);
        teacherPingStore.delete(offerId);
        try {
            await supabase.from('offers').update({ status: 'paused' }).eq('id', offerId);
        } catch(e) {}
        res.json({ success: true, is_paused: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ مسار جلب الوقت المتبقي وحالة البث
router.get('/timer/:offer_id', async (req, res) => {
    try {
        const offerId = parseInt(req.params.offer_id);
        const { data: offer, error } = await supabase
            .from('offers')
            .select('id, status, duration_minutes, duration, remaining_seconds, remaining_time, stream_started_at')
            .eq('id', offerId)
            .single();

        if (error || !offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        let remainingSec = null;
        if (offer.remaining_seconds != null && !isNaN(Number(offer.remaining_seconds))) {
            remainingSec = Number(offer.remaining_seconds);
        } else if (offer.remaining_time != null && !isNaN(Number(offer.remaining_time))) {
            remainingSec = Number(offer.remaining_time);
        } else {
            remainingSec = (offer.duration_minutes || offer.duration || 60) * 60;
        }

        res.json({
            success: true,
            status: offer.status,
            is_paused: offer.status === 'paused',
            remaining_seconds: remainingSec
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
