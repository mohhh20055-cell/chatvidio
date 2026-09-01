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
const { getOne, insert, update, autoBookFreeSession } = require('../utils/helpers');
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
                stream_active: true,
                is_paused: false,
                stream_started_at: new Date().toISOString(),
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
        
        // ✅ تحديث حالة المدفوعات إلى "pending_stream" وإرسال إشعار
        if (sessions && sessions.length > 0) {
            for (const session of sessions) {
                await supabase
                    .from('sessions')
                    .update({
                        payment_status: 'pending_stream'
                    })
                    .eq('offer_id', offer_id)
                    .eq('student_id', session.student_id);

                try {
                    await supabase
                        .from('notifications')
                        .insert({
                            user_id: session.student_id,
                            user_type: 'student',
                            title: '🔴 البث المباشر بدأ!',
                            message: `البث المباشر لحصة "${offer.subject_name || 'الدرس'}" قد بدأ الآن. يمكنك الانضمام فوراً!`,
                            is_read: false,
                            created_at: new Date().toISOString()
                        });
                } catch (notifErr) {
                    logger.error(`⚠️ تعذر إرسال إشعار للطالب ${session.student_id}:`, notifErr.message);
                }
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

router.post('/start-agora-stream', authenticate, authorize(['teacher']), checkNoActiveStream, [
    body('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], handleStreamStart);

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

        // ✅ حذف البيانات المؤقتة الخاصة بالبث فقط
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

        // ✅ تحديث حالة الدرس بدلاً من حذفه
        const isAllCompleted = (currentOffer.completed_sessions_count || 0) >= (currentOffer.total_sessions || 1);
        
        const { error: updateError } = await supabase
            .from('offers')
            .update({
                status: isAllCompleted ? 'completed' : 'upcoming',
                completed_at: isAllCompleted ? new Date().toISOString() : null,
                stream_active: false,
                stream_url: null,
                stream_started_at: null,
                room_name: null,
                room_password: null
            })
            .eq('id', offer_id);

        if (updateError) {
            logger.error('❌ خطأ في تحديث حالة الدرس بعد إنهاء البث:', updateError.message);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        console.log(`✅ تم إنهاء البث وتحديث الدرس ${offer_id} بنجاح`);
        return res.json({
            success: true,
            message: 'تم إنهاء البث بنجاح',
            deleted: false
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

        // ✅ جلب جميع الطلاب المسجلين والمدفوعين
        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);

        if (!paidSessions || paidSessions.length === 0) {
            return res.json({ success: true, students_count: 0, message: 'لا يوجد طلاب مسجلين في هذه الحصة' });
        }

        // ✅ جلب من هم بالفعل في البث
        const { data: activeStudents } = await supabase
            .from('active_stream')
            .select('student_id')
            .eq('offer_id', offer_id);

        const activeStudentIds = new Set((activeStudents || []).map(s => s.student_id));

        let addedCount = 0;

        for (const session of paidSessions) {
            const studentId = session.student_id;
            if (activeStudentIds.has(studentId)) continue;

            await insert('active_stream', {
                offer_id: parseInt(offer_id),
                student_id: studentId,
                added_at: new Date().toISOString(),
                added_by_teacher: true
            });

            // ✅ إزالة من قائمة الانتظار
            await supabase
                .from('waiting_room')
                .delete()
                .eq('offer_id', offer_id)
                .eq('student_id', studentId);

            // ✅ إشعار الطالب
            const joinUrl = `/api/join-agora/${offer_id}/${studentId}`;
            await insert('notifications', {
                user_id: studentId,
                user_type: 'student',
                title: '🔴 البث المباشر بدأ',
                message: `تمت إضافتك إلى البث المباشر للحصة "${offer.subject_name}". يمكنك الدخول الآن عبر لوحة التحكم أو الرابط التالي:\n🔗 ${baseUrl}${joinUrl}\n🔑 كلمة المرور: ${offer.room_password || ''}`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            });

            addedCount++;
        }

        res.json({
            success: true,
            students_count: addedCount,
            message: `تم إضافة ${addedCount} طالب إلى البث وإرسال الإشعارات`
        });
    } catch (error) {
        logger.error('❌ خطأ في إضافة جميع الطلاب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ صفحة البث للأستاذ (مع التحقق من البث النشط)
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

        const offer_id = parseInt(req.params.offer_id, 10);
        const teacher_id = parseInt(req.params.teacher_id, 10);
        if (decoded.userId !== teacher_id) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ لا يمكنك درس هذا البث</h1>
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
                    <h1 style="color:#ef4444;">❌ الدرس غير موجود</h1>
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
                    <p style="color:#64748b;">يرجى بدء البث أولاً من صفحة الدروس</p>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const totalMinutes = offer.duration || 0;
        const isPaused = offer.status === 'paused';

        // ✅ درس صفحة البث للأستاذ (لوحة تحكم متكاملة)
        res.send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>لوحة التحكم بالبث - ${escapeHtml(offer.subject_name)}</title>
                <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
                <style>
                    :root {
                        --primary: #0f5cbf;
                        --primary-dark: #0a4691;
                        --secondary: #10b981;
                        --danger: #ef4444;
                        --dark: #0a0a1a;
                        --card-bg: #1a1a2e;
                        --input-bg: #16213e;
                        --text-muted: #94a3b8;
                    }
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: 'Cairo', sans-serif; background: var(--dark); color: white; min-height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
                    
                    /* Header */
                    header { background: var(--card-bg); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05); z-index: 100; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
                    .header-info { display: flex; align-items: center; gap: 15px; }
                    .header-info h1 { font-size: 1.1rem; font-weight: 700; color: var(--primary); }
                    .badge { padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; display: flex; align-items: center; gap: 6px; }
                    .badge-live { background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); }
                    .badge-dot { width: 8px; height: 8px; background: var(--danger); border-radius: 50%; animation: blink 1.5s infinite; }
                    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
                    
                    /* Main Layout */
                    main { flex: 1; display: flex; overflow: hidden; }
                    
                    /* Stream Section */
                    .stream-container { flex: 1; position: relative; background: #000; display: flex; flex-direction: column; }
                    iframe { width: 100%; height: 100%; border: none; }
                    .no-stream { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px; }
                    .no-stream h2 { font-size: 1.5rem; margin-bottom: 10px; }
                    .no-stream p { color: var(--text-muted); margin-bottom: 20px; }

                    /* Sidebar */
                    .sidebar { width: 360px; background: var(--card-bg); display: flex; flex-direction: column; border-right: 1px solid rgba(255,255,255,0.05); }
                    
                    /* Chat Section */
                    .chat-section { flex: 1; display: flex; flex-direction: column; overflow: hidden; border-bottom: 1px solid rgba(255,255,255,0.05); }
                    .chat-header { padding: 12px 15px; background: rgba(255,255,255,0.02); display: flex; align-items: center; justify-content: space-between; font-weight: 700; font-size: 0.9rem; }
                    .chat-messages { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
                    .message { max-width: 85%; padding: 10px 12px; border-radius: 12px; font-size: 0.85rem; line-height: 1.5; position: relative; }
                    .message.teacher { align-self: flex-start; background: var(--primary); border-bottom-right-radius: 2px; }
                    .message.student { align-self: flex-end; background: var(--input-bg); border-bottom-left-radius: 2px; }
                    .message-meta { font-size: 0.7rem; opacity: 0.7; margin-bottom: 4px; font-weight: 700; display: flex; justify-content: space-between; }
                    .chat-input-area { padding: 12px; background: rgba(0,0,0,0.2); }
                    .chat-form { display: flex; gap: 8px; }
                    .chat-input { flex: 1; background: var(--input-bg); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px 14px; color: white; font-family: inherit; font-size: 0.85rem; outline: none; }
                    .chat-input:focus { border-color: var(--primary); }
                    .btn-send { background: var(--primary); color: white; border: none; width: 40px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
                    .btn-send:hover { background: var(--primary-dark); }
                    
                    /* Controls Section */
                    .controls-section { padding: 15px; display: flex; flex-direction: column; gap: 12px; }
                    .btn { padding: 12px; border-radius: 8px; font-weight: 700; font-size: 0.9rem; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.2s; font-family: inherit; }
                    .btn-primary { background: var(--primary); color: white; }
                    .btn-secondary { background: var(--secondary); color: white; }
                    .btn-danger { background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); }
                    .btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
                    .btn:active { transform: translateY(0); }
                    
                    /* Timer & Stats */
                    .timer-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 5px; }
                    .stat-card { background: var(--input-bg); padding: 10px; border-radius: 8px; text-align: center; }
                    .stat-value { font-size: 1rem; font-weight: 800; color: var(--primary); display: block; }
                    .stat-label { font-size: 0.65rem; color: var(--text-muted); font-weight: 700; }
                    
                    /* Badge Count */
                    .badge-count { position: absolute; top: -5px; right: -5px; background: var(--danger); color: white; font-size: 0.65rem; min-width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 10px rgba(239,68,68,0.5); }
                    
                    /* Responsive */
                    @media (max-width: 900px) {
                        main { flex-direction: column; overflow-y: hidden; }
                        .sidebar { width: 100%; flex: 1; min-height: 0; border-right: none; border-top: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; }
                        .stream-container { height: 240px; flex: none; position: sticky; top: 0; z-index: 10; }
                        header { padding: 8px 15px; flex-wrap: wrap; gap: 10px; }
                        header h1 { font-size: 0.9rem; flex: 1; min-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                        #timerDisplay { order: 3; width: 100%; text-align: center; font-size: 1rem; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 5px; }
                        .chat-messages { padding: 10px; flex: 1; overflow-y: auto; }
                        .controls-section { padding: 10px; }
                    }
                </style>
            </head>
            <body>
                <header>
                    <div class="header-info">
                        <div class="badge badge-live">
                            <div class="badge-dot"></div>
                            <span>مباشر</span>
                        </div>
                        <h1>${escapeHtml(offer.subject_name)}</h1>
                    </div>
                    <div id="timerDisplay" style="font-weight: 800; font-family: monospace; font-size: 1.1rem; color: #60a5fa;">00:00:00</div>
                    <button class="btn btn-danger" style="padding: 6px 12px; font-size: 0.75rem;" onclick="endStream()">⏹ إنهاء</button>
                </header>
                
                <main>
                    <div class="stream-container" id="streamArea">
                        <iframe id="streamIframe" src="${offer.stream_url}" allow="camera; microphone; display-capture; fullscreen; autoplay; receiver"></iframe>
                    </div>
                    
                    <div class="sidebar">
                        <div class="chat-section">
                            <div class="chat-header">
                                💬 الدردشة العامة
                                <span id="onlineStudentsCount" style="font-size: 0.7rem; color: var(--text-muted);">0 طلاب</span>
                            </div>
                            <div class="chat-messages" id="chatMessages">
                                <!-- Messages will appear here -->
                            </div>
                            <div class="chat-input-area">
                                <form class="chat-form" id="chatForm">
                                    <input type="text" id="chatInput" class="chat-input" placeholder="اكتب رسالة..." autocomplete="off">
                                    <button type="submit" class="btn-send">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                                    </button>
                                </form>
                            </div>
                        </div>
                        
                        <div class="controls-section">
                            <div class="timer-stats">
                                <div class="stat-card">
                                    <span class="stat-value" id="remainingTime">00:00</span>
                                    <span class="stat-label">المتبقي</span>
                                </div>
                                <div class="stat-card">
                                    <span class="stat-value" id="graceTimer">--</span>
                                    <span class="stat-label">فترة السماح</span>
                                </div>
                            </div>
                            
                            <div style="position: relative;">
                                <button id="btnAddStudents" class="btn btn-secondary w-full" onclick="addAllStudents()">
                                    👥 إضافة الطلاب الجدد
                                    <div id="pendingBadge" class="badge-count" style="display: none;">0</div>
                                </button>
                            </div>
                            
                            <p style="font-size: 0.65rem; color: var(--text-muted); text-align: center;">
                                💡 كلمة المرور للحصة: <strong>${offer.room_password || 'بدون'}</strong>
                            </p>
                        </div>
                    </div>
                </main>
                
                <script>
                    const authToken = ${JSON.stringify(token)};
                    const offerId = ${parseInt(offer_id)};
                    const isPaused = ${isPaused ? 'true' : 'false'};
                    
                    let lastMessageId = null;
                    let lastPendingCount = 0;

                    // ✅ إنهاء البث تلقائياً عند إغلاق النافذة (فقط إذا لم يتم الإغلاق يدوياً)
                    let manualClose = false;
                    window.onbeforeunload = function() {
                        if (!manualClose && !isPaused) {
                            navigator.sendBeacon('/api/stream/end/' + offerId + '?token=' + authToken + '&early_end=true');
                        }
                    };

                    async function endStream() {
                        if (!confirm('⏹ هل تريد إنهاء البث؟ سيتم تنزيل فيديو البث على جهازك وتوزيع المبالغ.')) return;
                        manualClose = true;
                        try {
                            const iframe = document.getElementById('streamIframe');
                            if (iframe && iframe.contentWindow) {
                                try {
                                    iframe.contentWindow.postMessage({ type: 'STOP_AND_DOWNLOAD_RECORDING' }, '*');
                                } catch(e){}
                            }
                        } catch(e){}
                        await new Promise(r => setTimeout(r, 1500));
                        try {
                            const res = await fetch('/api/stream/end/' + offerId, {
                                method: 'POST',
                                headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' }
                            });
                            const data = await res.json();
                            if (data.success) {
                                window.location.href = '/teacher-dashboard.html';
                            }
                        } catch (e) { alert('خطأ في الاتصال بالخادم'); manualClose = false; }
                    }

                    async function addAllStudents() {
                        try {
                            const btn = document.getElementById('btnAddStudents');
                            btn.disabled = true;
                            const res = await fetch('/api/add-all-students/' + offerId, {
                                method: 'POST',
                                headers: { 'Authorization': 'Bearer ' + authToken }
                            });
                            const data = await res.json();
                            if (data.success) {
                                document.getElementById('pendingBadge').style.display = 'none';
                                lastPendingCount = 0;
                            }
                        } finally { document.getElementById('btnAddStudents').disabled = false; }
                    }

                    // ✅ إدارة الدردشة
                    const chatForm = document.getElementById('chatForm');
                    const chatInput = document.getElementById('chatInput');
                    const chatMessages = document.getElementById('chatMessages');

                    chatForm.onsubmit = async (e) => {
                        e.preventDefault();
                        const msg = chatInput.value.trim();
                        if (!msg) return;
                        chatInput.value = '';
                        try {
                            await fetch('/api/chat/send', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
                                body: JSON.stringify({ offer_id: offerId, message: msg })
                            });
                            fetchMessages();
                        } catch (e) {}
                    };

                    async function fetchMessages() {
                        try {
                            const res = await fetch('/api/chat/messages/' + offerId, {
                                headers: { 'Authorization': 'Bearer ' + authToken }
                            });
                            const data = await res.json();
                            if (data.success && data.messages) {
                                updateChatUI(data.messages);
                            }
                        } catch (e) {}
                    }

                    function updateChatUI(messages) {
                        if (messages.length === 0) return;
                        const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop <= chatMessages.clientHeight + 50;
                        
                        // فقط أضف الرسائل الجديدة
                        const currentCount = chatMessages.children.length;
                        if (messages.length > currentCount) {
                            for (let i = currentCount; i < messages.length; i++) {
                                const m = messages[i];
                                const div = document.createElement('div');
                                div.className = 'message ' + (m.sender_role === 'teacher' ? 'teacher' : 'student');
                                div.innerHTML = \`
                                    <div class="message-meta">
                                        <span>\${m.sender_name}</span>
                                        <span>\${new Date(m.created_at).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}</span>
                                    </div>
                                    <div>\${escapeHtml(m.message)}</div>
                                \`;
                                chatMessages.appendChild(div);
                            }
                            if (wasAtBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
                        }
                    }

                    function escapeHtml(text) {
                        const div = document.createElement('div');
                        div.textContent = text;
                        return div.innerHTML;
                    }

                    // ✅ نظام النبضات (Heartbeat) - تحديث البيانات كل 10 ثواني
                    async function heartbeat() {
                        try {
                            const res = await fetch('/api/stream/heartbeat/' + offerId, {
                                method: 'POST',
                                headers: { 'Authorization': 'Bearer ' + authToken }
                            });
                            const data = await res.json();
                            if (data.action === 'force_end') {
                                alert(data.message);
                                window.location.href = '/teacher-dashboard.html';
                                return;
                            }
                            
                            // تحديث عداد الوقت
                            updateTimers(data);
                            
                            // تحديث عداد الطلاب الحاضرين في البث
                            if (data.active_students_count !== undefined) {
                                const onlineElem = document.getElementById('onlineStudentsCount');
                                if (onlineElem) onlineElem.textContent = data.active_students_count + ' طلاب';
                                const hdrElem = document.getElementById('onlineStudentsCountHeader');
                                if (hdrElem) hdrElem.textContent = data.active_students_count;
                            }

                            // تحديث شارة الطلاب الجدد
                            if (data.pending_students_count > 0) {
                                const badge = document.getElementById('pendingBadge');
                                badge.textContent = data.pending_students_count;
                                badge.style.display = 'flex';
                                if (data.pending_students_count > lastPendingCount) {
                                    // تأثير بصري عند وجود طالب جديد
                                    badge.style.transform = 'scale(1.5)';
                                    setTimeout(() => badge.style.transform = 'scale(1)', 300);
                                }
                                lastPendingCount = data.pending_students_count;
                            }
                        } catch (e) {}
                    }

                    function updateTimers(data) {
                        const remaining = data.remaining_seconds || 0;
                        const h = Math.floor(remaining / 3600);
                        const m = Math.floor((remaining % 3600) / 60);
                        const s = remaining % 60;
                        document.getElementById('remainingTime').textContent = \`\${m.toString().padStart(2, '0')}:\${s.toString().padStart(2, '0')}\`;
                        
                        if (data.overdue && data.grace_remaining_seconds !== null) {
                            const gm = Math.floor(data.grace_remaining_seconds / 60);
                            const gs = data.grace_remaining_seconds % 60;
                            document.getElementById('graceTimer').textContent = \`\${gm}:\${gs.toString().padStart(2, '0')}\`;
                            document.getElementById('graceTimer').style.color = '#ef4444';
                        }
                        
                        // وقت السيرفر
                        const serverDate = new Date(data.server_time);
                        document.getElementById('timerDisplay').textContent = serverDate.toLocaleTimeString('ar-EG', { hour12: false });
                    }

                    // تشغيل الدورات
                    setInterval(heartbeat, 10000);
                    setInterval(fetchMessages, 3000);
                    heartbeat();
                    fetchMessages();
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        logger.error('خطأ في صفحة البث:', error);
        res.status(500).send('حدث خطأ في تحميل صفحة البث');
    }
});

// ============================================================
// ✅ صفحة البث للطالب (مع التحقق من صلاحية الطالب)
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

        const offer_id = parseInt(req.params.offer_id, 10);
        const student_id = parseInt(req.params.student_id, 10);
        if (decoded.userId !== student_id) {
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

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ الدرس غير موجود</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // ✅ التحقق من صلاحية الطالب
        let { data: session } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', parseInt(student_id))
            .in('payment_status', ['paid', 'pending_stream'])
            .maybeSingle();

        if (!session && offer) {
            session = await autoBookFreeSession(offer, student_id);
        }

        if (!session) {
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

        const totalMinutes = offer.duration || 0;
        const isPaused = offer.status === 'paused';

        // ✅ درس صفحة البث للطالب (لوحة تحكم متكاملة)
        res.send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>دخول البث - ${escapeHtml(offer.subject_name)}</title>
                <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
                <style>
                    :root {
                        --primary: #0f5cbf;
                        --primary-dark: #0a4691;
                        --secondary: #10b981;
                        --danger: #ef4444;
                        --dark: #0a0a1a;
                        --card-bg: #1a1a2e;
                        --input-bg: #16213e;
                        --text-muted: #94a3b8;
                    }
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: 'Cairo', sans-serif; background: var(--dark); color: white; min-height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
                    
                    /* Header */
                    header { background: var(--card-bg); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05); z-index: 100; }
                    .header-info { display: flex; align-items: center; gap: 15px; }
                    .header-info h1 { font-size: 1.1rem; font-weight: 700; color: var(--primary); }
                    .badge { padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; display: flex; align-items: center; gap: 6px; }
                    .badge-live { background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); }
                    .badge-paused { background: rgba(245, 158, 11, 0.1); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.2); }
                    .badge-dot { width: 8px; height: 8px; background: var(--danger); border-radius: 50%; animation: blink 1.5s infinite; }
                    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
                    
                    /* Main Layout */
                    main { flex: 1; display: flex; overflow: hidden; }
                    
                    /* Stream Section */
                    .stream-container { flex: 1; position: relative; background: #000; display: flex; flex-direction: column; }
                    iframe { width: 100%; height: 100%; border: none; }
                    
                    /* Sidebar */
                    .sidebar { width: 360px; background: var(--card-bg); display: flex; flex-direction: column; border-right: 1px solid rgba(255,255,255,0.05); }
                    
                    /* Chat Section */
                    .chat-section { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
                    .chat-header { padding: 12px 15px; background: rgba(255,255,255,0.02); font-weight: 700; font-size: 0.9rem; }
                    .chat-messages { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
                    .message { max-width: 85%; padding: 10px 12px; border-radius: 12px; font-size: 0.85rem; line-height: 1.5; }
                    .message.teacher { align-self: flex-start; background: var(--primary); border-bottom-right-radius: 2px; }
                    .message.student { align-self: flex-end; background: var(--input-bg); border-bottom-left-radius: 2px; }
                    .message-meta { font-size: 0.7rem; opacity: 0.7; margin-bottom: 4px; font-weight: 700; display: flex; justify-content: space-between; }
                    .chat-input-area { padding: 12px; background: rgba(0,0,0,0.2); }
                    .chat-form { display: flex; gap: 8px; }
                    .chat-input { flex: 1; background: var(--input-bg); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px 14px; color: white; font-family: inherit; font-size: 0.85rem; outline: none; }
                    .chat-input:focus { border-color: var(--primary); }
                    .btn-send { background: var(--primary); color: white; border: none; width: 40px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
                    
                    /* Password Box */
                    .password-banner { background: rgba(16, 185, 129, 0.1); color: var(--secondary); padding: 8px; text-align: center; font-size: 0.8rem; font-weight: 700; }

                    /* Responsive */
                    @media (max-width: 900px) {
                        main { flex-direction: column; overflow-y: hidden; }
                        .sidebar { width: 100%; flex: 1; min-height: 0; border-right: none; border-top: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; }
                        .stream-container { height: 240px; flex: none; position: sticky; top: 0; z-index: 10; }
                        header { padding: 8px 15px; }
                        header h1 { font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
                        .chat-messages { flex: 1; overflow-y: auto; }
                    }
                </style>
            </head>
            <body>
                <header>
                    <div class="header-info">
                        <div class="badge ${isPaused ? 'badge-paused' : 'badge-live'}">
                            ${!isPaused ? '<div class="badge-dot"></div>' : ''}
                            <span>${isPaused ? 'متوقف مؤقتاً' : 'مباشر'}</span>
                        </div>
                        <h1>${escapeHtml(offer.subject_name)}</h1>
                    </div>
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <div id="liveViewersBadge" style="display: flex; align-items: center; gap: 6px; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #34d399; padding: 4px 10px; border-radius: 15px; font-size: 12px; font-weight: 700;">
                            <i class="fas fa-users"></i>
                            <span>المتواجدون:</span>
                            <span id="viewersCount" style="color: #6ee7b7; font-size: 13px; font-weight: 800;">0</span>
                        </div>
                        <div id="remainingTime" style="font-weight: 800; font-family: monospace; font-size: 1.1rem; color: #60a5fa;">00:00</div>
                    </div>
                </header>
                
                <div class="password-banner">
                    🔑 كلمة مرور البث: <strong style="letter-spacing: 1px;">${offer.room_password || 'بدون'}</strong>
                </div>

                <main>
                    <div class="stream-container" id="streamContainer" onclick="toggleFullscreen()" style="position: relative; cursor: pointer;" title="انقر لتكبير الشاشة / إلغاء ملء الشاشة">
                        <iframe id="streamIframe" src="${offer.stream_url}" allow="camera; microphone; display-capture; fullscreen; autoplay; receiver" style="width:100%; height:100%; border:none;"></iframe>
                        <div id="fullscreenBadge" style="position: absolute; top: 12px; right: 12px; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(4px); color: #fff; padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; display: flex; align-items: center; gap: 6px; pointer-events: none; z-index: 10; border: 1px solid rgba(255,255,255,0.15);">
                            <i class="fas fa-expand"></i> انقر لملء الشاشة
                        </div>
                        <div style="position: absolute; bottom: 12px; right: 12px; display: flex; gap: 8px; z-index: 10;">
                            <button type="button" id="audioBoostBtn" onclick="event.stopPropagation(); toggleAudioBoost();" title="تقوية الصوت" style="background: rgba(15,23,42,0.8); backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                                <i class="fas fa-volume-up"></i> تقوية الصوت
                            </button>
                            <button type="button" id="fullscreenBtn" onclick="event.stopPropagation(); toggleFullscreen();" title="ملء الشاشة" style="background: rgba(15,23,42,0.8); backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                                <i class="fas fa-expand"></i> ملء الشاشة
                            </button>
                        </div>
                    </div>
                    
                    <div class="sidebar">
                        <div class="chat-section">
                            <div class="chat-header">💬 الدردشة العامة</div>
                            <div class="chat-messages" id="chatMessages"></div>
                            <div class="chat-input-area" id="inputArea">
                                <form class="chat-form" id="chatForm">
                                    <input type="text" id="chatInput" class="chat-input" placeholder="اكتب رسالة..." autocomplete="off">
                                    <button type="submit" class="btn-send">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                                    </button>
                                </form>
                            </div>
                        </div>
                    </div>
                </main>
                
                <script>
                    const authToken = ${JSON.stringify(token)};
                    const offerId = ${parseInt(offer_id)};
                    const studentId = ${parseInt(student_id)};
                    
                    const chatMessages = document.getElementById('chatMessages');
                    const chatForm = document.getElementById('chatForm');
                    const chatInput = document.getElementById('chatInput');

                    async function fetchMessages() {
                        try {
                            const res = await fetch('/api/chat/messages/' + offerId, {
                                headers: { 'Authorization': 'Bearer ' + authToken }
                            });
                            const data = await res.json();
                            if (data.success && data.messages) {
                                updateChatUI(data.messages);
                                if (data.is_muted) {
                                    chatInput.placeholder = 'تم كتمك من قبل الأستاذ';
                                    chatInput.disabled = true;
                                } else {
                                    chatInput.placeholder = 'اكتب رسالة...';
                                    chatInput.disabled = false;
                                }
                                if (data.active_count !== undefined) {
                                    const viewersElem = document.getElementById('viewersCount');
                                    if (viewersElem) viewersElem.textContent = data.active_count;
                                }
                            }
                        } catch (e) {}
                    }

                    function updateChatUI(messages) {
                        if (messages.length === 0) return;
                        const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop <= chatMessages.clientHeight + 50;
                        const currentCount = chatMessages.children.length;
                        
                        if (messages.length > currentCount) {
                            for (let i = currentCount; i < messages.length; i++) {
                                const m = messages[i];
                                const div = document.createElement('div');
                                div.className = 'message ' + (m.sender_role === 'teacher' ? 'teacher' : 'student');
                                div.innerHTML = \`
                                    <div class="message-meta">
                                        <span>\${m.sender_name}</span>
                                        <span>\${new Date(m.created_at).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}</span>
                                    </div>
                                    <div>\${escapeHtml(m.message)}</div>
                                \`;
                                chatMessages.appendChild(div);
                            }
                            if (wasAtBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
                        }
                    }

                    function escapeHtml(text) {
                        const div = document.createElement('div');
                        div.textContent = text;
                        return div.innerHTML;
                    }

                    chatForm.onsubmit = async (e) => {
                        e.preventDefault();
                        const msg = chatInput.value.trim();
                        if (!msg) return;
                        chatInput.value = '';
                        try {
                            await fetch('/api/chat/send', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
                                body: JSON.stringify({ offer_id: offerId, message: msg })
                            });
                            fetchMessages();
                        } catch (e) {}
                    };

                    function notifyStudentLeave() {
                        try {
                            const url = '/api/stream/leave/' + offerId + '?token=' + encodeURIComponent(authToken);
                            if (navigator.sendBeacon) {
                                navigator.sendBeacon(url);
                            } else {
                                fetch(url, { method: 'POST', keepalive: true });
                            }
                        } catch(e){}
                    }
                    window.addEventListener('beforeunload', notifyStudentLeave);
                    window.addEventListener('pagehide', notifyStudentLeave);

                    async function checkStatus() {
                        try {
                            const res = await fetch('/api/student-status/' + offerId + '/' + studentId, {
                                headers: { 'Authorization': 'Bearer ' + authToken }
                            });
                            const data = await res.json();
                            if (data.status === 'completed' || data.status === 'cancelled') {
                                alert('انتهى البث المباشر');
                                window.location.href = '/student-dashboard.html';
                            }
                            if (data.duration) {
                                // حساب الوقت المتبقي تقريبياً (اختياري)
                            }
                        } catch (e) {}
                    }

                    // ===== 🖥️ ملء الشاشة (Fullscreen Toggle) =====
                    function toggleFullscreen() {
                        const target = document.getElementById('streamContainer') || document.querySelector('.stream-container');
                        if (!target) return;

                        const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
                        if (!isFS) {
                            if (target.requestFullscreen) {
                                target.requestFullscreen();
                            } else if (target.webkitRequestFullscreen) {
                                target.webkitRequestFullscreen();
                            } else if (target.mozRequestFullScreen) {
                                target.mozRequestFullScreen();
                            } else if (target.msRequestFullscreen) {
                                target.msRequestFullscreen();
                            }
                        } else {
                            if (document.exitFullscreen) {
                                document.exitFullscreen();
                            } else if (document.webkitExitFullscreen) {
                                document.webkitExitFullscreen();
                            } else if (document.mozCancelFullScreen) {
                                document.mozCancelFullScreen();
                            } else if (document.msExitFullscreen) {
                                document.msExitFullscreen();
                            }
                        }
                    }

                    function updateFullscreenUI() {
                        const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
                        const btn = document.getElementById('fullscreenBtn');
                        const badge = document.getElementById('fullscreenBadge');
                        
                        if (btn) {
                            btn.innerHTML = isFS ? '<i class="fas fa-compress"></i> إلغاء ملء الشاشة' : '<i class="fas fa-expand"></i> ملء الشاشة';
                        }
                        if (badge) {
                            badge.innerHTML = isFS ? '<i class="fas fa-compress"></i> إلغاء ملء الشاشة' : '<i class="fas fa-expand"></i> انقر لملء الشاشة';
                        }
                    }

                    document.addEventListener('fullscreenchange', updateFullscreenUI);
                    document.addEventListener('webkitfullscreenchange', updateFullscreenUI);
                    document.addEventListener('mozfullscreenchange', updateFullscreenUI);
                    document.addEventListener('MSFullscreenChange', updateFullscreenUI);

                    // ===== 🔊 تقوية الصوت (Audio Boost) =====
                    let audioBoostLevel = 1; // 1 = 100%, 2 = 200%, 3 = 300%
                    let audioCtx = null;
                    const mediaSourceMap = new WeakMap();

                    function toggleAudioBoost() {
                        if (audioBoostLevel === 1) audioBoostLevel = 2;
                        else if (audioBoostLevel === 2) audioBoostLevel = 3;
                        else audioBoostLevel = 1;

                        const btn = document.getElementById('audioBoostBtn');
                        if (btn) {
                            if (audioBoostLevel === 1) {
                                btn.style.background = 'rgba(15,23,42,0.8)';
                                btn.innerHTML = '<i class="fas fa-volume-up"></i> تقوية الصوت (100%)';
                            } else if (audioBoostLevel === 2) {
                                btn.style.background = '#059669';
                                btn.innerHTML = '<i class="fas fa-volume-up"></i> تقوية الصوت (200% ⚡)';
                            } else {
                                btn.style.background = '#d97706';
                                btn.innerHTML = '<i class="fas fa-bullhorn"></i> تقوية الصوت (300% 🚀)';
                            }
                        }

                        try {
                            if (!audioCtx) {
                                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                            }
                            if (audioCtx.state === 'suspended') {
                                audioCtx.resume();
                            }
                            const mediaElems = document.querySelectorAll('video, audio');
                            mediaElems.forEach(media => {
                                let entry = mediaSourceMap.get(media);
                                if (!entry) {
                                    try {
                                        const source = audioCtx.createMediaElementSource(media);
                                        const gainNode = audioCtx.createGain();
                                        source.connect(gainNode);
                                        gainNode.connect(audioCtx.destination);
                                        entry = { source, gainNode };
                                        mediaSourceMap.set(media, entry);
                                    } catch(err) {
                                        console.warn('Media element source attach error:', err);
                                    }
                                }
                                if (entry && entry.gainNode) {
                                    entry.gainNode.gain.value = audioBoostLevel;
                                }
                            });
                        } catch(e) {
                            console.warn('WebAudio Boost Error:', e);
                        }
                    }

                    setInterval(fetchMessages, 3000);
                    setInterval(checkStatus, 15000);
                    fetchMessages();
                    checkStatus();
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        logger.error('خطأ في صفحة دخول البث:', error);
        res.status(500).send('حدث خطأ في تحميل صفحة البث');
    }
});

// ============================================================
// ✅ جلب بيانات التحقق من وقت البث (للأستاذ)
// ============================================================
router.get('/verification/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);

        // التحقق من ملكية الدرس
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const verification = await getStreamVerification(offer_id);

        if (!verification) {
            return res.json({
                success: true,
                verification: null,
                message: 'لا توجد بيانات تحقق لهذا البث'
            });
        }

        res.json({
            success: true,
            verification: {
                server_start_time: verification.server_start_time,
                server_end_time: verification.server_end_time,
                total_duration_seconds: verification.total_duration_seconds,
                actual_live_seconds: verification.actual_live_seconds,
                expected_duration: verification.expected_duration,
                completion_percentage: Math.round(verification.completion_percentage),
                is_complete: verification.is_complete,
                status: verification.status
            }
        });
    } catch (error) {
        logger.error('خطأ في جلب بيانات التحقق:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب تقرير التحقق للطالب
// ============================================================
router.get('/student-verification/:offer_id/:student_id', authenticate, authorize(['student']), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح'),
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const student_id = parseInt(req.params.student_id);

        // التحقق من أن الطالب هو نفسه
        if (student_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        // التحقق من وجود حجز للطالب
        let { data: session } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .in('payment_status', ['paid', 'pending_stream'])
            .maybeSingle();

        if (!session && offer) {
            session = await autoBookFreeSession(offer, student_id);
        }

        if (!session) {
            return res.status(404).json({ success: false, error: 'لم تقم بحجز هذه الحصة' });
        }

        const verification = await getStreamVerification(offer_id);
        const completion = await verifyStreamCompletion(offer_id);

        res.json({
            success: true,
            offer: {
                id: offer.id,
                subject_name: offer.subject_name,
                duration: offer.duration,
                status: offer.status
            },
            payment: {
                original_amount: session.payment_amount,
                status: session.payment_status,
                teacher_earned: session.teacher_earned
            },
            verification: verification ? {
                completion_percentage: Math.round(completion.completion_percentage),
                actual_seconds: completion.actual_seconds,
                expected_seconds: completion.expected_seconds,
                is_complete: completion.complete
            } : null
        });
    } catch (error) {
        logger.error('خطأ في جلب تقرير التحقق:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع تقارير التحقق (للأدمن)
// ============================================================
router.get('/admin/all-verifications', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data: verifications, error } = await supabase
            .from('stream_verification')
            .select(`
                *,
                offers:offer_id (
                    id,
                    subject_name,
                    duration,
                    status,
                    price,
                    is_free,
                    teachers:teacher_id (
                        id,
                        full_name,
                        email
                    )
                )
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // حساب نسبة الاكتمال لكل بث
        const formatted = (verifications || []).map(v => {
            const offer = v.offers;
            const expectedSeconds = offer ? offer.duration * 60 : 0;
            
            let actualSeconds = v.actual_live_seconds;
            if ((actualSeconds === null || actualSeconds === undefined || actualSeconds === 0) && v.server_start_time) {
                const startTime = new Date(v.server_start_time);
                if (!isNaN(startTime.getTime())) {
                    const endTime = v.server_end_time ? new Date(v.server_end_time) : new Date();
                    const totalSeconds = Math.floor((endTime - startTime) / 1000);
                    const pausedSeconds = v.total_paused_seconds || 0;
                    actualSeconds = Math.max(0, totalSeconds - pausedSeconds);
                }
            }
            if (actualSeconds === null || actualSeconds === undefined || isNaN(actualSeconds)) {
                actualSeconds = 0;
            }

            let percentage = expectedSeconds > 0 
                ? Math.round((actualSeconds / expectedSeconds) * 100) 
                : 0;
            if (isNaN(percentage)) {
                percentage = 0;
            }
            percentage = Math.min(100, percentage);

            return {
                id: v.id,
                offer_id: v.offer_id,
                teacher_id: v.teacher_id,
                teacher_name: offer?.teachers?.full_name,
                subject_name: offer?.subject_name,
                duration_minutes: offer?.duration,
                expected_seconds: expectedSeconds,
                actual_seconds: actualSeconds,
                completion_percentage: percentage,
                is_complete: percentage >= 80,
                server_start_time: v.server_start_time,
                server_end_time: v.server_end_time,
                total_paused_seconds: v.total_paused_seconds,
                status: v.status,
                created_at: v.created_at
            };
        });

        res.json({
            success: true,
            verifications: formatted,
            total: formatted.length,
            completed_count: formatted.filter(v => v.is_complete).length,
            incomplete_count: formatted.filter(v => !v.is_complete).length
        });
    } catch (error) {
        logger.error('خطأ في جلب تقارير التحقق:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب تقرير تحقق معين للدرس (للأدمن)
// ============================================================
router.get('/admin/verification/:offer_id', authenticate, authorize(['admin']), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);

        const verification = await getStreamVerification(offer_id);
        const completion = await verifyStreamCompletion(offer_id);

        const { data: offer } = await supabase
            .from('offers')
            .select(`
                *,
                teachers:teacher_id (
                    id,
                    full_name,
                    email
                )
            `)
            .eq('id', offer_id)
            .single();

        const { data: sessions } = await supabase
            .from('sessions')
            .select(`
                *,
                students:student_id (
                    id,
                    full_name,
                    email
                )
            `)
            .eq('offer_id', offer_id);

        res.json({
            success: true,
            verification: verification ? {
                server_start_time: verification.server_start_time,
                server_end_time: verification.server_end_time,
                total_duration_seconds: verification.total_duration_seconds,
                actual_live_seconds: verification.actual_live_seconds,
                total_paused_seconds: verification.total_paused_seconds,
                status: verification.status
            } : null,
            completion: {
                expected_seconds: completion.expected_seconds,
                actual_seconds: completion.actual_seconds,
                shortfall_seconds: completion.shortfall_seconds,
                completion_percentage: Math.round(completion.completion_percentage),
                is_complete: completion.complete
            },
            offer: offer,
            sessions: sessions
        });
    } catch (error) {
        logger.error('خطأ في جلب تقرير التحقق:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ Heartbeat: الأستاذ يُرسل نبضة كل 20 ثانية ليثبت وجوده في صفحة البث
// ============================================================
router.post('/stream/heartbeat/:offer_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        const teacher_id = req.user.userId;

        const { data: offer, error: offerError } = await supabase
            .from('offers')
            .select('id, teacher_id, status, offer_date, duration, subject_name')
            .eq('id', offer_id)
            .single();

        if (offerError || !offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }
        if (offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }
        if (!['live', 'paused', 'teacher_ready'].includes(offer.status)) {
            return res.status(400).json({ success: false, error: 'البث غير نشط', status: offer.status });
        }

        const now = new Date();
        const offerStart = new Date(offer.offer_date);
        const offerEnd = new Date(offerStart.getTime() + offer.duration * 60 * 1000);
        const GRACE_MS = 10 * 60 * 1000;
        const graceEnd = new Date(offerEnd.getTime() + GRACE_MS);

        // تحديث آخر تواجد في active_stream إن وجد
        await supabase.from('active_stream')
            .update({ last_ping: now.toISOString(), updated_at: now.toISOString() })
            .eq('offer_id', offer_id)
            .eq('teacher_id', teacher_id);

        const overdue = now > offerEnd;
        let graceRemainingSeconds = null;
        let shouldForceEnd = false;

        if (overdue) {
            if (now >= graceEnd) {
                shouldForceEnd = true;
            } else {
                graceRemainingSeconds = Math.max(0, Math.ceil((graceEnd - now) / 1000));
            }
        }

        if (shouldForceEnd) {
            await forceEndStream(offer_id, 'grace_timeout');
            return res.json({
                success: true,
                action: 'force_end',
                message: 'انتهت فترة السماح (10 دقائق) - تم إغلاق البث وإعادة توزيع المدفوعات'
            });
        }

        // ✅ حساب الطلاب الجدد الذين حجزوا ولم يتم إضافتهم للبث بعد
        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);

        const { data: activeStudents } = await supabase
            .from('active_stream')
            .select('student_id')
            .eq('offer_id', offer_id);

        const activeStudentIds = new Set((activeStudents || []).map(s => s.student_id));
        const pendingStudentsCount = (paidSessions || []).filter(s => !activeStudentIds.has(s.student_id)).length;

        let remainingSeconds = Math.max(0, Math.floor((offerEnd - now) / 1000));

        return res.json({
            success: true,
            action: 'ok',
            remaining_seconds: remainingSeconds,
            overdue,
            grace_remaining_seconds: graceRemainingSeconds,
            pending_students_count: pendingStudentsCount,
            active_students_count: activeStudentIds.size,
            server_time: now.toISOString()
        });

    } catch (error) {
        logger.error('خطأ في heartbeat:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ تحقق من حالة الدرس (للأستاذ عند الرجوع للوحة التحكم)
// تُرجع حالة الدرس الحالية من الخادم - الأستاذ يتوقف عن الـ heartbeat
// ============================================================
router.get('/stream/status/:offer_id', authenticate, async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);

        const { data: offer, error } = await supabase
            .from('offers')
            .select('id, teacher_id, status, offer_date, duration, subject_name')
            .eq('id', offer_id)
            .single();

        if (error || !offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        const now = new Date();
        const offerStart = new Date(offer.offer_date);
        const offerEnd = new Date(offerStart.getTime() + offer.duration * 60 * 1000);
        const graceEnd = new Date(offerEnd.getTime() + 10 * 60 * 1000);
        const remainingSeconds = Math.max(0, Math.floor((offerEnd - now) / 1000));

        let graceRemainingSeconds = null;
        if (now > offerEnd && now <= graceEnd) {
            graceRemainingSeconds = Math.max(0, Math.floor((graceEnd - now) / 1000));
        }

        // ✅ حساب الطلاب الجدد الذين حجزوا ولم يتم إضافتهم للبث بعد
        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);

        const { data: activeStudents } = await supabase
            .from('active_stream')
            .select('student_id')
            .eq('offer_id', offer_id);

        const activeStudentIds = new Set((activeStudents || []).map(s => s.student_id));
        const pendingStudentsCount = (paidSessions || []).filter(s => !activeStudentIds.has(s.student_id)).length;

        res.json({
            success: true,
            offer_id,
            status: offer.status,
            remaining_seconds: remainingSeconds,
            overdue: now > offerEnd,
            grace_remaining_seconds: graceRemainingSeconds,
            force_ended: offer.status === 'completed' || offer.status === 'cancelled',
            pending_students_count: pendingStudentsCount,
            server_time: now.toISOString()
        });
    } catch (error) {
        logger.error('خطأ في جلب حالة البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ نظام المحادثة وكتم الطلاب في البث (Session Chat & Student Muting)
// ============================================================

const streamMessagesStore = new Map(); // offer_id -> Array of message objects
const mutedStudentsStore = new Map();  // offer_id -> Set of student_ids
const teacherPingStore = new Map();     // offer_id -> timestamp (ms)

async function handleSendChatMessage(req, res) {
    try {
        const { offer_id, message } = req.body;
        const offerId = parseInt(offer_id);
        const userId = req.user.userId;
        const role = req.user.userType || req.user.role || 'student';

        if (!offerId || !message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ success: false, error: 'بيانات غير صالحة' });
        }

        if (role === 'student') {
            const mutedSet = mutedStudentsStore.get(offerId);
            if (mutedSet && mutedSet.has(userId)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'تم كتمك من قبل الأستاذ في هذه الحصة، لا يمكنك إرسال رسائل' 
                });
            }
        }

        let senderName = req.body.sender_name || req.user.full_name || req.user.name;
        if (!senderName || senderName === 'طالب' || senderName.trim() === '') {
            if (role === 'teacher') {
                const { data: t } = await supabase.from('teachers').select('full_name, name').eq('id', userId).maybeSingle();
                if (t?.full_name) senderName = t.full_name;
                else if (t?.name) senderName = t.name;
            } else {
                const { data: s } = await supabase.from('students').select('full_name, name, username').eq('id', userId).maybeSingle();
                if (s?.full_name) senderName = s.full_name;
                else if (s?.name) senderName = s.name;
                else if (s?.username) senderName = s.username;
            }
        }
        if (!senderName || senderName === 'طالب') {
            senderName = (role === 'teacher' ? 'الأستاذ' : 'طالب');
        }

        const msgObj = {
            id: Date.now() + Math.random().toString(36).substr(2, 5),
            offer_id: offerId,
            sender_id: userId,
            sender_name: senderName,
            sender_role: role,
            message: message.trim(),
            created_at: new Date().toISOString()
        };

        if (!streamMessagesStore.has(offerId)) {
            streamMessagesStore.set(offerId, []);
        }
        const msgs = streamMessagesStore.get(offerId);
        msgs.push(msgObj);
        if (msgs.length > 200) msgs.shift();

        try {
            await supabase.from('stream_chat_messages').insert({
                offer_id: offerId,
                sender_id: userId,
                sender_name: senderName,
                sender_role: role,
                message: message.trim(),
                created_at: msgObj.created_at
            });
        } catch (e) {}

        res.json({ success: true, message: msgObj });
    } catch (error) {
        logger.error('خطأ في إرسال الرسالة:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}

async function handleGetChatMessages(req, res) {
    try {
        const offerId = parseInt(req.params.offer_id);
        const userId = req.user.userId;
        const role = req.user.userType || req.user.role || 'student';

        // ✅ تحديث آخر تواجد للمشارك الحالي أو الأستاذ
        const nowIso = new Date().toISOString();
        if (role === 'teacher') {
            teacherPingStore.set(offerId, Date.now());
        } else if (role === 'student' && userId) {
            try {
                const { data: existing } = await supabase
                    .from('active_stream')
                    .select('id')
                    .eq('offer_id', offerId)
                    .eq('student_id', userId)
                    .maybeSingle();

                if (existing) {
                    await supabase
                        .from('active_stream')
                        .update({ last_ping: nowIso, updated_at: nowIso })
                        .eq('id', existing.id);
                } else {
                    await insert('active_stream', {
                        offer_id: offerId,
                        student_id: userId,
                        joined_at: nowIso,
                        last_ping: nowIso,
                        updated_at: nowIso
                    });
                }
            } catch (e) {}
        }

        let msgs = streamMessagesStore.get(offerId) || [];

        if (msgs.length === 0) {
            try {
                const { data: dbMsgs } = await supabase
                    .from('stream_chat_messages')
                    .select('*')
                    .eq('offer_id', offerId)
                    .order('created_at', { ascending: true })
                    .limit(100);
                if (dbMsgs && dbMsgs.length > 0) {
                    msgs = dbMsgs;
                    streamMessagesStore.set(offerId, msgs);
                }
            } catch (e) {}
        }

        const mutedSet = mutedStudentsStore.get(offerId) || new Set();
        const isMuted = role === 'student' && mutedSet.has(userId);
        const mutedStudentsList = Array.from(mutedSet);

        // ✅ حساب الطلاب المتواجدين الحقيقيين في الوقت الفعلي (استثناء الأستاذ، وآخر ping خلال 10 ثوانٍ)
        let activeCount = 0;
        try {
            const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
            const { count } = await supabase
                .from('active_stream')
                .select('*', { count: 'exact', head: true })
                .eq('offer_id', offerId)
                .not('student_id', 'is', null)
                .gte('last_ping', tenSecondsAgo);
            activeCount = count || 0;
        } catch (e) {}

        // ✅ جلب بيانات الوقت المتبقي وحالة البث وإجمالي المدة
        let offerRemainingSeconds = null;
        let offerTotalSeconds = 3600;
        let offerStatus = null;
        let offerIsEnded = false;
        try {
            const { data: offerData, error: offerErr } = await supabase
                .from('offers')
                .select('id, status, remaining_seconds, total_seconds, duration')
                .eq('id', offerId)
                .single();
            if (offerData) {
                offerStatus = offerData.status;
                if (['completed', 'ended', 'deleted'].includes(offerStatus)) {
                    offerIsEnded = true;
                }
                if (offerData.remaining_seconds != null && !isNaN(Number(offerData.remaining_seconds))) {
                    offerRemainingSeconds = Number(offerData.remaining_seconds);
                }
                const durationMins = offerData.duration || 60;
                offerTotalSeconds = Number(offerData.total_seconds || (durationMins * 60)) || 3600;
            } else if (offerErr && offerErr.code === 'PGRST116') {
                // الدرس تم حذفه من قاعدة البيانات بعد إنهاء البث من الأستاذ
                offerIsEnded = true;
            }
        } catch(e) {}

        // إذا تم إنهاء البث فعلياً من قبل الأستاذ ينبغي إغلاق شاشة البث لدى الطالب
        if (offerIsEnded) {
            return res.json({
                success: true,
                stream_ended: true,
                messages: [],
                message: 'تم إنهاء البث المباشر من قبل الأستاذ'
            });
        }

        const lastTeacherPing = teacherPingStore.get(offerId);
        // مرونة عالية في التحقق من تواجد الأستاذ (تجنب اعتبار البث متوقفاً بسبب بطء الاتصال، المهلة 90 ثانية)
        const isPaused = (offerStatus === 'paused');
        const isTeacherOnline = (offerStatus === 'live') ? true : (lastTeacherPing ? ((Date.now() - lastTeacherPing) <= 90000) : true);

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
